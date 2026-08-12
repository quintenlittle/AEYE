/* ================================================================
   AEYE -- right-side embedded browser sidebar.

   A collapsible panel that opens links (RSS/news, 4chan threads, YouTube,
   any http/https anchor) IN-APP instead of the system browser. The render
   surface is an <iframe>; frame-friendly sites load directly, YouTube
   watch/short links are rewritten to the embeddable /embed/ player, and the
   header carries a ↗ button that hands the current page to the system
   browser via /api/open for the sites that refuse to be framed.

   Because a cross-origin iframe's own history/URL is unreadable from here,
   navigation (back/forward) is driven by OUR OWN stack of the URLs we loaded.

   Non-YouTube pages load through the server proxy `/api/browse` (server.py):
   it strips X-Frame-Options so any site embeds, drops ad/tracker tags, and
   injects an OLED theme -- so the sidebar is universal + ad-blocked + themed
   without any WebView2 host code (which would risk the whole app if it broke).
   A future increment could add CoreWebView2 WebResourceRequested for
   network-level ad-blocking + full-fidelity (cookies/SPA) embedding.

   Public API: window.SIDEBAR = { open(url), toggle(), expand(), collapse() }.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const OPEN_KEY = 'aeye-sidebar-open';
  const URL_KEY  = 'aeye-sidebar-url';

  // our own navigation stack (the iframe's cross-origin history is opaque)
  let hist = [];
  let hidx = -1;

  const isHttp = (u) => /^https?:\/\//i.test(u || '');

  // YouTube watch / short links -> the embeddable player (the only YT page that
  // isn't X-Frame-Options blocked). Everything else passes through untouched.
  function normalize(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (host === 'youtube.com' || host === 'm.youtube.com') {
        const v = u.searchParams.get('v');
        if (v) return 'https://www.youtube.com/embed/' + encodeURIComponent(v);
      }
      if (host === 'youtu.be') {
        const id = u.pathname.slice(1).split('/')[0];
        if (id) return 'https://www.youtube.com/embed/' + encodeURIComponent(id);
      }
    } catch { /* not a parseable URL -> leave it */ }
    return url;
  }

  // What actually goes into the iframe's src. YouTube embeds load DIRECTLY
  // (they aren't X-Frame-Options blocked and the proxy can't run their SPA);
  // everything else goes through /api/browse -- the server strips X-Frame-Options
  // so any site embeds, drops ad/tracker tags, and injects the OLED theme.
  function frameSrc(url) {
    const n = normalize(url);
    if (/^https?:\/\/(www\.)?youtube\.com\/embed\//i.test(n)) return n;
    return '/api/browse?url=' + encodeURIComponent(n);
  }

  const frame = () => $('sb-frame');
  const setUrlBar = (url) => { const b = $('sb-url'); if (b) b.value = url; };

  function updateNav() {
    const b = $('sb-back'), f = $('sb-fwd');
    if (b) b.disabled = hidx <= 0;
    if (f) f.disabled = hidx >= hist.length - 1;
  }

  // load a URL into the iframe. push=false when moving through our own history.
  function load(url, push) {
    if (!isHttp(url)) return;
    frame().src = frameSrc(url);
    setUrlBar(url);
    localStorage.setItem(URL_KEY, url);
    if (push !== false) {
      hist = hist.slice(0, hidx + 1);
      hist.push(url);
      hidx = hist.length - 1;
    }
    updateNav();
  }

  function expand() {
    const s = $('sidebar'); if (!s) return;
    s.classList.remove('collapsed');
    s.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sb-open');
    localStorage.setItem(OPEN_KEY, '1');
  }
  function collapse() {
    const s = $('sidebar'); if (!s) return;
    s.classList.add('collapsed');
    s.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sb-open');
    localStorage.setItem(OPEN_KEY, '0');
  }
  const toggle = () => ($('sidebar') && $('sidebar').classList.contains('collapsed') ? expand() : collapse());

  function openExternal(url) {
    if (!isHttp(url)) return;
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).catch(() => { /* noop */ });
  }

  // the one public entry point: open a URL in the sidebar (expanding it). Any
  // failure falls back to the system browser so a link never just dies.
  function openInSidebar(url) {
    if (!isHttp(url)) return false;
    try { load(url, true); expand(); return true; }
    catch { openExternal(url); return false; }
  }

  function back()   { if (hidx > 0) { hidx--; load(hist[hidx], false); } }
  function fwd()    { if (hidx < hist.length - 1) { hidx++; load(hist[hidx], false); } }
  function reload() { if (hidx >= 0) { const u = hist[hidx]; frame().src = 'about:blank'; setTimeout(() => load(u, false), 20); } }
  const current = () => (hidx >= 0 ? hist[hidx] : localStorage.getItem(URL_KEY) || '');

  function wire() {
    const s = $('sidebar');
    if (!s) return;
    $('sb-back')  .addEventListener('click', back);
    $('sb-fwd')   .addEventListener('click', fwd);
    $('sb-reload').addEventListener('click', reload);
    $('sb-ext')   .addEventListener('click', () => openExternal(current()));
    $('sb-close') .addEventListener('click', collapse);
    // editable address bar: type a URL and press Enter to navigate
    const urlIn = $('sb-url');
    if (urlIn) urlIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      let v = urlIn.value.trim();
      if (!v) return;
      if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
      openInSidebar(v);
      urlIn.blur();
    });
    const tab = $('sidebar-tab');
    if (tab) tab.addEventListener('click', () => expand());

    // Always start hidden with a blank page. We deliberately do NOT restore the
    // last-open state or reopen the last thread on launch -- the browser opens
    // blank (the iframe defaults to about:blank) and only navigates once you
    // click a link or type a URL.
    collapse();
    updateNav();

    // Global link interception: a plain left-click on any external http(s) <a>
    // opens in the sidebar instead of the system browser. Capture phase +
    // stopImmediatePropagation so it pre-empts the app's own openExternal
    // handlers (board titles, RSS links, sources, model pages). Modifier-clicks
    // and links inside the sidebar chrome are left alone.
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!isHttp(href)) return;
      if (a.dataset.external === '1') return;   // explicit opt-out -> normal handling
      if (a.closest('#sidebar')) return;        // the sidebar's own chrome
      e.preventDefault();
      e.stopImmediatePropagation();
      openInSidebar(href);
    }, true);
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.SIDEBAR = { open: openInSidebar, toggle, expand, collapse };
})();
