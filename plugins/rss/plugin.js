/* AEYE plugin: rss -- fetch RSS/Atom feeds and print them cleanly in chat.
 *
 *   rss                     -> the DEFAULT_FEEDS below
 *   rss <url>               -> one feed
 *   rss <url1> <url2> ...   -> several feeds
 *
 * Pure Node stdlib (https) -- no dependencies.
 */
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// RSS FEEDS
const DEFAULT_FEEDS = [
  
  // local
  'https://fetchrss.com/feed/1wtu6DEetCiz1wtu5I4wvA3X.atom',

  // core
  'https://feeds.bbci.co.uk/news/rss.xml',
  'https://feeds.feedburner.com/TechCrunch/',

  //github_plinius: 
  'https://github.blog/feed/',
  'https://github.com/trending.atom',
  'https://github.com/explore.atom',
  'https://github.com/elder-plinius.atom',

  // AI
  'https://openai.com/blog/rss.xml',
  'https://huggingface.co/blog/feed.xml',
  'https://deepmind.google/blog/rss.xml',

  // research
  'https://arxiv.org/rss/cs.AI',
  'https://hnrss.org/newest?q=AI',

  // hacker/dev
  'https://news.ycombinator.com/rss',
  'https://hnrss.org/frontpage',

  // cybersecurity
  'https://feeds.feedburner.com/TheHackersNews',
  'https://krebsonsecurity.com/feed/',

  // torrent/news
  'https://torrentfreak.com/feed/',

  // github (fixed)
  'https://github.blog/feed/',
  'https://github.com/OWNER/REPO/commits.atom', // <-- replace with real repo if needed
];

const MAX_ITEMS = 8;
const TIMEOUT_MS = 8000;

// ---- paywall allowlist ---------------------------------------------------
// Only links whose domain is on this list get wrapped through archive.is for
// 1-click archiving; every other link stays a direct link. Manage it at will:
//   rss paywall list                  -> show the current domains
//   rss paywall add <domain> [...]    -> add one or more
//   rss paywall remove <domain> [...] -> remove one or more
//   rss paywall reset                 -> restore the defaults below
// The list persists in paywalls.json next to this plugin (edit it directly too).
const DEFAULT_PAYWALLS = [
  'nytimes.com', 'wsj.com', 'economist.com', 'bloomberg.com', 'ft.com',
  'washingtonpost.com', 'newyorker.com', 'theatlantic.com', 'wired.com',
  'businessinsider.com', 'forbes.com', 'technologyreview.com',
  'theinformation.com', 'seekingalpha.com', 'barrons.com', 'foreignpolicy.com',
  'thetimes.co.uk', 'telegraph.co.uk', 'latimes.com', 'medium.com',
  'reuters.com', 'hbr.org', 'nature.com', 'science.org',
];
const CONFIG_PATH = path.join(__dirname, 'paywalls.json');
let PAYWALLS = [];

// bare registrable host: "https://www.NyTimes.com/x" -> "nytimes.com"
function normDomain(d) {
  return String(d).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
function savePaywalls(list) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify({ domains: list }, null, 2)); }
  catch { /* read-only dir -> keep in-memory only */ }
}
function loadPaywalls() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (Array.isArray(j.domains)) return j.domains.map(normDomain).filter(Boolean);
  } catch { /* missing/corrupt -> seed defaults */ }
  savePaywalls(DEFAULT_PAYWALLS);          // first run: write the editable file
  return DEFAULT_PAYWALLS.slice();
}
function hostOf(link) {
  try { return new URL(link).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}
function isPaywalled(link) {
  const h = hostOf(link);
  return !!h && PAYWALLS.some((d) => h === d || h.endsWith('.' + d));
}

// ---- fetch ---------------------------------------------------------------
function fetch(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad URL')); }

    const mod = u.protocol === 'http:' ? http : https;

    const req = mod.get(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0', // helps avoid 403/406
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const loc = res.headers.location;

      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume();
        return resolve(fetch(new URL(loc, u).toString(), redirects - 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null); // silently skip bad feeds
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null)); // silent fail
  });
}

// ---- helpers -------------------------------------------------------------
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' '
};

function cleanText(s) {
  if (!s) return '';
  return s
    .replace(/\<\!\[CDATA\[([\s\S]*?)\]\]\>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&\w+;/g, (m) => ENTITIES[m] || m)
    .replace(/<[^>]+>/g, '')
    .replace(/[^\x00-\x7F]/g, '') // REMOVE EMOJIS
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/gi)];
  if (!links.length) return '';
  return links[0][1];
}

// ---- parse ---------------------------------------------------------------
function parseFeed(xml) {
  if (!xml) return null;

  const feedTitle = cleanText(tag(xml, 'title')) || 'feed';
  const items = [];

  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  for (const b of blocks) {
    const isAtom = /^<entry/i.test(b);
    const title = cleanText(tag(b, 'title')) || '(untitled)';
    let link = isAtom ? atomLink(b) : cleanText(tag(b, 'link'));
    if (!link) link = cleanText(tag(b, 'guid'));

    const date = cleanText(
      tag(b, 'pubDate') ||
      tag(b, 'updated') ||
      tag(b, 'published')
    );

    items.push({ title, link, date });
    if (items.length >= MAX_ITEMS) break;
  }

  return { title: feedTitle, items };
}

function fmtDate(d) {
  const t = Date.parse(d);
  if (isNaN(t)) return '';
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

// ---- output formatting ---------------------------------------------------
// The chat bubble renders this text as monospace with `white-space: pre-wrap`,
// so long URLs wrap. That rules out a fully-closed right border (it would
// misalign the moment a line wraps), so each item is a card with a closed top
// and bottom rule and a left rail on the content -- clean separation that
// survives wrapping. WIDTH is the frame-rule length in chars (kept well under
// a typical bubble so the rule lines themselves never wrap).
const WIDTH = 60;
const TOP = '┌' + '─'.repeat(WIDTH) + '┐';
const BOT = '└' + '─'.repeat(WIDTH) + '┘';

// wrap ONLY paywalled links through archive.today (1-click archiving). The full
// https://archive.is/ prefix keeps the whole string one clickable URL (chat
// linkify matches an http(s):// run to the next space); other links stay direct.
function archiveLink(link) {
  return isPaywalled(link) ? 'https://archive.is/' + link : link;
}

function printItem(n, title, link, date) {
  console.log(TOP);
  console.log(`│ ${n} · ${title}`);
  if (link) console.log(`│    ${archiveLink(link)}`);
  if (date) console.log(`│    ${date}`);
  console.log(BOT);
}

// ---- paywall subcommands -------------------------------------------------
function managePaywalls(sub) {
  const cmd = (sub[0] || 'list').toLowerCase();
  const domains = sub.slice(1).map(normDomain).filter(Boolean);
  let list = loadPaywalls();
  if (cmd === 'list' || cmd === 'ls') {
    console.log('Paywalled domains — links from these are wrapped via archive.is:');
    if (list.length) list.forEach((d) => console.log('  • ' + d));
    else console.log('  (none)');
    console.log('');
    console.log('Manage: rss paywall add <domain>  |  rss paywall remove <domain>  |  rss paywall reset');
    return;
  }
  if (cmd === 'add') {
    if (!domains.length) { console.log('usage: rss paywall add <domain> [<domain> ...]'); return; }
    const added = [];
    for (const d of domains) if (!list.includes(d)) { list.push(d); added.push(d); }
    list.sort(); savePaywalls(list);
    console.log(added.length ? 'Added: ' + added.join(', ') : 'Already on the list.');
    console.log('Now tracking ' + list.length + ' paywalled domain(s).');
    return;
  }
  if (cmd === 'remove' || cmd === 'rm' || cmd === 'del') {
    if (!domains.length) { console.log('usage: rss paywall remove <domain> [<domain> ...]'); return; }
    const before = list.length;
    list = list.filter((d) => !domains.includes(d));
    savePaywalls(list);
    console.log(before - list.length ? 'Removed: ' + domains.join(', ') : 'Not found on the list.');
    console.log('Now tracking ' + list.length + ' paywalled domain(s).');
    return;
  }
  if (cmd === 'reset') {
    savePaywalls(DEFAULT_PAYWALLS.slice());
    console.log('Reset to the ' + DEFAULT_PAYWALLS.length + ' default paywalled domains.');
    return;
  }
  console.log('Unknown subcommand "' + cmd + '". Use: list | add | remove | reset');
}

// ---- main ---------------------------------------------------------------
async function main() {
  // reconstruct the query whether {query} arrives as one token or many, then
  // split -- mirrors how feed URLs were already handled
  const raw = process.argv.slice(2).join(' ').trim();
  const args = raw ? raw.split(/\s+/) : [];
  const cmd0 = (args[0] || '').toLowerCase();
  if (cmd0 === 'paywall' || cmd0 === 'paywalls') return managePaywalls(args.slice(1));

  PAYWALLS = loadPaywalls();
  const urls = args.length ? args : DEFAULT_FEEDS;

  for (const url of urls) {
    const xml = await fetch(url);
    if (!xml) continue;

    const feed = parseFeed(xml);
    if (!feed || !feed.items.length) continue;

    console.log('━━ ' + feed.title + ' ━━');
    console.log('');

    feed.items.forEach((it, i) => {
      printItem(i + 1, it.title, it.link, fmtDate(it.date));
    });

    console.log('');          // spacing between feeds
  }
}

main().catch(() => process.exit(1));