/* AEYE plugin: rss -- fetch RSS/Atom feeds and print them cleanly in chat.
 *
 *   rss                     -> the DEFAULT_FEEDS below
 *   rss <url>               -> one feed
 *   rss <url1> <url2> ...   -> several feeds
 *
 * Pure Node stdlib (https) -- no dependencies. Handles RSS 2.0 (<item>) and
 * Atom (<entry>), CDATA and the common HTML entities. One bad feed never kills
 * the rest. Edit DEFAULT_FEEDS / MAX_ITEMS to taste.
 */
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

// edit these: the feeds `rss` (with no URL) pulls
const DEFAULT_FEEDS = [
  'https://hnrss.org/frontpage',
  'https://www.reddit.com/r/worldnews/.rss',
];
const MAX_ITEMS = 8;        // per feed
const TIMEOUT_MS = 8000;

// ---- fetch (follows up to 3 redirects; http or https) ----------------------
function fetch(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad URL')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      headers: { 'User-Agent': 'AEYE-rss/1.0', 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume();
        return resolve(fetch(new URL(loc, u).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// ---- tiny XML helpers ------------------------------------------------------
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
function decode(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&\w+;/g, (m) => ENTITIES[m] || m)
    .replace(/<[^>]+>/g, '')          // strip any stray tags
    .replace(/\s+/g, ' ')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}
function atomLink(block) {
  // Atom: <link href="..." rel="alternate"/> (prefer alternate/no-rel)
  const links = [...block.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/gi)];
  if (!links.length) return '';
  const alt = links.find((l) => /rel="alternate"/i.test(l[0]) || !/rel=/i.test(l[0]));
  return (alt || links[0])[1];
}

// ---- parse one feed's XML into {title, items:[{title,link,date}]} -----------
function parseFeed(xml) {
  const feedTitle = decode(tag(xml, 'title')) || 'feed';
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const isAtom = /^<entry/i.test(b);
    const title = decode(tag(b, 'title')) || '(untitled)';
    let link = isAtom ? atomLink(b) : decode(tag(b, 'link'));
    if (!link) link = decode(tag(b, 'guid'));
    const date = decode(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date'));
    items.push({ title, link, date });
    if (items.length >= MAX_ITEMS) break;
  }
  return { title: feedTitle, items };
}

function fmtDate(d) {
  const t = Date.parse(d);
  if (isNaN(t)) return d || '';
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

// ---- output formatting -----------------------------------------------------
// The chat bubble renders this text as monospace with `white-space: pre-wrap`,
// so long URLs wrap. That rules out a fully-closed right border (it would
// misalign the moment a line wraps), so each item is a card with a closed top
// and bottom rule and a left rail on the content -- clean separation that
// survives wrapping. WIDTH is the frame-rule length in chars (kept well under
// a typical bubble so the rule lines themselves never wrap).
const WIDTH = 60;
const TOP = '┌' + '─'.repeat(WIDTH) + '┐';
const BOT = '└' + '─'.repeat(WIDTH) + '┘';

function printItem(n, title, link, date) {
  console.log(TOP);
  console.log(`│ ${n} · ${title}`);
  if (link) console.log(`│    ${link}`);
  if (date) console.log(`│    ${date}`);
  console.log(BOT);
}

// ---- main ------------------------------------------------------------------
async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  const urls = query ? query.split(/\s+/) : DEFAULT_FEEDS;
  for (const url of urls) {
    try {
      const xml = await fetch(url);
      const feed = parseFeed(xml);
      console.log('━━ ' + feed.title + ' ━━');
      console.log('');
      if (!feed.items.length) { console.log('  (no items found)'); }
      feed.items.forEach((it, i) => {
        printItem(i + 1, it.title, it.link, fmtDate(it.date));
      });
      console.log('');          // spacing between feeds
    } catch (e) {
      console.log('━━ ' + url + ' ━━');
      console.log('');
      console.log('  [failed] ' + e.message);
      console.log('');
    }
  }
}
main().catch((e) => { console.error('rss error:', e.message); process.exit(1); });
