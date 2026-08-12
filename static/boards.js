/* ================================================================
   AEYE -- 4chan board tickers (OPT-IN, gated behind web access).

   Scrolling lanes UNDER the price tickers, one per board. Each lane
   shows recent thread TITLES only (no URLs, no metadata); clicking a
   title opens the original thread in the system browser via /api/open.

   4chan's read-only API (a.4cdn.org) only allows CORS from
   boards.4chan.org, so the app (a localhost origin) cannot fetch it
   directly, and AEYE's server is frozen (no proxy route can be added).
   The titles therefore come through a user-supplied CORS relay
   (an RSS-Bridge instance, a CORS proxy, or a self-hosted bridge),
   configured in manage > settings. NO relay is set by default, so --
   exactly like the price tickers -- nothing leaves the machine until
   you deliberately turn it on. While web is off, no relay is set, or a
   feed fails, the affected lane stays silent or reads a small notice;
   no request is ever made.

   The relay is a URL template with {board} and/or {url} placeholders,
   so the feed source can be switched without touching this code:
     RSS-Bridge : https://host/?action=display&bridge=FourChan&b={board}&format=Atom
     CORS proxy : https://host/?url={url}   ({url} = the a.4cdn catalog URL)

   State lives in localStorage:
     aeye-boards        [{id,dir,on}]  which boards + scroll direction
     aeye-board-relay   ""             the relay URL template (empty = off)
     aeye-board-max     20             max titles per lane
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const BOARDS_KEY = 'aeye-boards';
  const RELAY_KEY  = 'aeye-board-relay';
  const MAX_KEY    = 'aeye-board-max';
  const POLL_MS    = 120000;                 // threads move slowly -- poll gently
  const MAX_TITLE  = 110;                     // clamp long OP subjects

  // fresh-profile default boards. dir 'rl' = right->left, 'lr' = left->right.
  // They only ever run once the user opts in (web access + rss_enabled + a
  // relay mode) -- see the gating in poll(); everything is OFF by default.
  const DEFAULT_BOARDS = [
    { id: 'pol', dir: 'rl', on: true },
    { id: 'g',   dir: 'lr', on: true },
    { id: 'v',   dir: 'rl', on: true },
    { id: 'x',   dir: 'lr', on: true },
  ];

  const validId = (s) => /^[a-z0-9]{1,10}$/.test(s);

  function loadBoards() {
    try {
      const b = JSON.parse(localStorage.getItem(BOARDS_KEY) || 'null');
      if (Array.isArray(b) && b.every((x) => x && validId(x.id)))
        return b.map((x) => ({ id: x.id, dir: x.dir === 'lr' ? 'lr' : 'rl', on: !!x.on }));
    } catch { /* corrupt -> defaults */ }
    return DEFAULT_BOARDS.map((x) => ({ ...x }));
  }
  let boards = loadBoards();
  const saveBoards = () => localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));

  const getRelay = () => (localStorage.getItem(RELAY_KEY) || '').trim();
  const setRelay = (v) => localStorage.setItem(RELAY_KEY, (v || '').trim());

  // the local relay AEYE ships (aeye-4chan-relay.py) -> one-click default
  const LOCAL_RELAY = 'http://127.0.0.1:8788/{board}';

  // relay mode: 'off' (default) | 'local' (bundled 127.0.0.1:8788 relay) |
  // 'custom' (the user's own relay URL). rss_enabled is the master switch for
  // the whole board-ticker system. BOTH default OFF -> nothing runs, no request
  // is made, until the user deliberately opts in.
  const MODE_KEY = 'aeye-relay-mode';
  const RSS_KEY  = 'aeye-rss-enabled';
  const getMode = () => {
    const m = localStorage.getItem(MODE_KEY);
    return (m === 'local' || m === 'custom') ? m : 'off';
  };
  const setMode = (m) => localStorage.setItem(MODE_KEY, m === 'local' || m === 'custom' ? m : 'off');
  const rssEnabled = () => localStorage.getItem(RSS_KEY) === '1';
  const setRss = (on) => localStorage.setItem(RSS_KEY, on ? '1' : '0');
  // the relay URL actually in effect for the current mode ('' when off/unset)
  const effectiveRelay = () => {
    const m = getMode();
    if (m === 'local') return LOCAL_RELAY;
    if (m === 'custom') return getRelay();
    return '';
  };

  function getMax() {
    const n = parseInt(localStorage.getItem(MAX_KEY) || '20', 10);
    return Number.isFinite(n) ? Math.min(50, Math.max(5, n)) : 20;
  }
  const setMax = (n) => localStorage.setItem(MAX_KEY, String(n));

  const enabledBoards = () => boards.filter((b) => b.on);

  // web access is the gate -- read WEB if it's up, else the raw flag (mirrors
  // ticker.js so both strips share the one opt-in)
  const webOn = () =>
    window.WEB ? WEB.enabled() : localStorage.getItem('aeye-web') === '1';

  // ---- text cleanup (feed content is untrusted -> string ops only) ----------

  function decodeEntities(s) {
    return String(s)
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');                 // last, so we don't double-decode
  }
  const stripTags = (s) =>
    String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
  function clean(s) {
    const t = decodeEntities(stripTags(s || '')).replace(/\s+/g, ' ').trim();
    return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1).trimEnd() + '…' : t;
  }
  const isHttp = (u) => /^https?:\/\//i.test(u || '');

  // ---- fetch + parse ---------------------------------------------------------

  // build the relay request URL for a board from the template
  function relayUrl(id) {
    const relay = effectiveRelay();
    const target = 'https://a.4cdn.org/' + id + '/catalog.json';
    if (/\{board\}|\{url\}/.test(relay)) {
      return relay
        .replace(/\{board\}/g, encodeURIComponent(id))
        .replace(/\{url\}/g, encodeURIComponent(target));
    }
    return relay + encodeURIComponent(target);   // no placeholder -> append target
  }

  // 4chan catalog.json -> [{title,url}]
  function parseCatalog(data, id) {
    if (!Array.isArray(data)) return null;      // not a catalog -> let feed parse try
    const out = [];
    data.forEach((page) => {
      (page.threads || []).forEach((t) => {
        if (t.no == null) return;
        const title = clean(t.sub) || clean(t.com);
        if (!title) return;
        out.push({ title, url: 'https://boards.4chan.org/' + id + '/thread/' + t.no });
      });
    });
    return out;
  }

  // RSS / Atom (e.g. RSS-Bridge FourChan) -> [{title,url}]
  function parseFeed(text, id) {
    let doc;
    try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
    catch { return []; }
    if (doc.querySelector('parsererror')) return [];
    const nodes = doc.querySelectorAll('item, entry');
    const out = [];
    nodes.forEach((n) => {
      const title = clean((n.querySelector('title') || {}).textContent || '');
      if (!title) return;
      let url = '';
      const link = n.querySelector('link');
      if (link) url = link.getAttribute('href') || link.textContent || '';
      url = (url || '').trim();
      if (isHttp(url)) out.push({ title, url });
    });
    return out;
  }

  async function fetchBoard(id) {
    const res = await fetch(relayUrl(id), { cache: 'no-store' });
    if (!res.ok) throw new Error('relay ' + res.status);
    const body = await res.text();
    // try 4chan JSON first; some proxies (allorigins /get) wrap it in {contents}
    let data = null;
    try { data = JSON.parse(body); } catch { /* not JSON -> feed */ }
    if (data && typeof data === 'object' && !Array.isArray(data) &&
        typeof data.contents === 'string') {
      try { data = JSON.parse(data.contents); }
      catch { return parseFeed(data.contents, id); }
    }
    if (data) {
      const c = parseCatalog(data, id);
      if (c) return c;
    }
    return parseFeed(body, id);                 // RSS/Atom relay
  }

  // probe whether the configured relay is actually listening: a resolved fetch
  // (any HTTP status) means something answered; a thrown error = not running /
  // unreachable. Used by the settings "test" button and the failure messaging.
  async function probeRelay() {
    const relay = getRelay();
    if (!relay) return { set: false };
    try { await fetch(relayUrl('g'), { cache: 'no-store' }); return { set: true, up: true }; }
    catch { return { set: true, up: false }; }
  }

  // ---- rendering -------------------------------------------------------------

  const barEl = () => $('board-bar');
  const laneFor = (id) => barEl().querySelector('.board-lane[data-board="' + id + '"]');

  // rebuild the lane elements to match the enabled-board list (order + set)
  function ensureLanes() {
    const bar = barEl();
    if (!bar) return;
    const want = enabledBoards().map((b) => b.id).join(',');
    if (bar.dataset.lanes === want && bar.querySelector('.board-lane')) return;
    bar.textContent = '';
    enabledBoards().forEach((b) => {
      const lane = document.createElement('div');
      lane.className = 'tick-lane board-lane';
      lane.dataset.board = b.id;
      const track = document.createElement('div');
      track.className = 'tick-track';
      lane.appendChild(track);
      bar.appendChild(lane);
    });
    bar.dataset.lanes = want;
  }

  function pill(item, id) {
    const span = document.createElement('span');
    span.className = 'tick tk-board';
    const a = document.createElement('a');
    a.className = 'tk-title';
    a.href = isHttp(item.url) ? item.url : '#';
    // no title attr -> no hover tooltip on ticker items (the strip stays clean)
    const bd = document.createElement('span');
    bd.className = 'tk-bd';
    bd.textContent = '/' + id + '/';
    a.appendChild(bd);
    a.appendChild(document.createTextNode(item.title));   // textContent = injection-safe
    span.appendChild(a);
    return span;
  }

  function trackOf(lane) { return lane.querySelector('.tick-track'); }

  function renderNotice(lane, text, warn) {
    const t = trackOf(lane);
    t.style.animation = 'none';
    t.style.transform = 'none';
    t.textContent = '';
    const s = document.createElement('span');
    s.className = 'tick tk-board-notice' + (warn ? ' warn' : '');
    s.textContent = text;
    t.appendChild(s);
  }

  function renderLane(lane, items, dir) {
    const track = trackOf(lane);
    track.style.animation = 'none';
    track.style.transform = 'none';
    track.textContent = '';
    if (!items.length) return;
    const id = lane.dataset.board;
    const seq = document.createElement('span');
    seq.className = 'tick-seq';
    items.forEach((it) => seq.appendChild(pill(it, id)));
    track.appendChild(seq);
    // repeat the items until one sequence fills the lane, so a short strip still
    // scrolls seamlessly (measured synchronously -- rAF is paused while hidden)
    const laneW = lane.clientWidth || 600;
    let reps = 1;
    while (seq.scrollWidth < laneW && reps < 12) {
      reps += 1;
      items.forEach((it) => seq.appendChild(pill(it, id)));
    }
    track.appendChild(seq.cloneNode(true));      // second copy -> seamless loop
    const w = seq.scrollWidth || 600;
    const dur = Math.max(20, w / 45);            // ~constant 45 px/s pace
    void track.offsetWidth;                      // reflow so the restart takes
    track.style.animationName = 'tick-scroll';
    track.style.animationDuration = dur + 's';
    track.style.animationTimingFunction = 'linear';
    track.style.animationIterationCount = 'infinite';
    // 'rl' (right->left) runs the keyframe forwards; 'lr' (left->right) reverses
    track.style.animationDirection = (dir === 'lr') ? 'reverse' : 'normal';
  }

  // ---- polling ---------------------------------------------------------------

  let inflight = false;
  async function poll() {
    const bar = barEl();
    if (!bar) return;
    // gate 1 -- web access (the shared opt-in). off (default) -> bar hidden.
    if (!webOn()) { bar.classList.add('off'); bar.dataset.lanes = ''; return; }
    bar.classList.remove('off');
    // gate 2 -- the board-ticker master switch. off (default) -> bar hidden.
    if (!rssEnabled()) { bar.textContent = ''; bar.dataset.lanes = ''; return; }
    const list = enabledBoards();
    if (!list.length) { bar.textContent = ''; bar.dataset.lanes = ''; return; }
    ensureLanes();
    // gate 3 -- relay mode. off (default), or custom with no URL -> a notice,
    // no request made.
    const relay = effectiveRelay();
    if (getMode() === 'off' || !relay) {
      list.forEach((b) => renderNotice(laneFor(b.id),
        '/' + b.id + '/  ·  pick a relay mode in manage ▸ settings to enable'));
      return;
    }
    if (inflight) return;
    inflight = true;
    const max = getMax();
    try {
      await Promise.all(list.map(async (b) => {
        const lane = laneFor(b.id);
        if (!lane) return;
        try {
          const items = (await fetchBoard(b.id)).slice(0, max);
          if (!items.length) renderNotice(lane, '⚠ /' + b.id + '/ — no titles', true);
          else renderLane(lane, items, b.dir);
        } catch {
          const msg = (getMode() === 'local')
            ? '⚠ /' + b.id + '/ — relay not running (see settings)'
            : '⚠ /' + b.id + '/ ticker offline';
          renderNotice(lane, msg, true);
        }
      }));
    } finally { inflight = false; }
  }

  let timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  }

  // ---- settings UI -----------------------------------------------------------

  const dirLabel = (d) => (d === 'lr' ? '← left' : 'right →');

  function buildList() {
    const host = $('boards-list');
    if (!host) return;
    host.textContent = '';
    boards.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'board-row';

      const lab = document.createElement('label');
      lab.className = 'chk';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = b.on;
      cb.addEventListener('change', () => { b.on = cb.checked; saveBoards(); poll(); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' /' + b.id + '/'));
      row.appendChild(lab);

      const dir = document.createElement('button');
      dir.type = 'button';
      dir.className = 'board-dir';
      dir.textContent = dirLabel(b.dir);
      dir.title = 'scroll direction — click to flip';
      dir.addEventListener('click', () => {
        b.dir = b.dir === 'lr' ? 'rl' : 'lr';
        dir.textContent = dirLabel(b.dir);
        saveBoards();
        // direction is a lane property applied on render -> repaint
        bar_repaint();
      });
      row.appendChild(dir);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ticker-rm';
      rm.textContent = '×';
      rm.title = 'remove /' + b.id + '/';
      rm.addEventListener('click', () => {
        boards = boards.filter((x) => x !== b);
        saveBoards();
        buildList();
        poll();
      });
      row.appendChild(rm);

      host.appendChild(row);
    });
  }

  // force a lane rebuild + re-render (used when direction flips)
  function bar_repaint() {
    const bar = barEl();
    if (bar) bar.dataset.lanes = '';   // invalidate so ensureLanes rebuilds
    poll();
  }

  function addBoard() {
    const st = $('board-add-status');
    const setStatus = (t, err) => {
      if (st) { st.textContent = t; st.className = 'mini-status' + (err ? ' err' : ''); }
    };
    const inp = $('board-add-id');
    let id = (inp ? inp.value : '').trim().toLowerCase().replace(/^\/|\/$/g, '');
    const dir = ($('board-add-dir') && $('board-add-dir').value === 'lr') ? 'lr' : 'rl';
    if (!id) { setStatus('enter a board code, e.g. pol', true); return; }
    if (!validId(id)) { setStatus('invalid board code', true); return; }
    if (boards.some((b) => b.id === id)) { setStatus('/' + id + '/ is already listed', true); return; }
    boards.push({ id, dir, on: true });
    saveBoards();
    buildList();
    if (inp) inp.value = '';
    setStatus('added /' + id + '/');
    poll();
  }

  // live relay reachability in the settings pane (ping + human-readable status)
  async function refreshRelayStatus() {
    const st = $('board-relay-status');
    if (!st) return;
    if (!rssEnabled()) { st.textContent = 'board tickers off — enable them above'; st.className = 'mini-status'; return; }
    const mode = getMode();
    if (mode === 'off') { st.textContent = 'relay mode: off — pick local or custom'; st.className = 'mini-status'; return; }
    if (mode === 'custom' && !getRelay()) { st.textContent = 'custom mode — enter a relay URL below'; st.className = 'mini-status err'; return; }
    st.textContent = 'checking relay…'; st.className = 'mini-status';
    const p = await probeRelay();
    if (p.up) { st.textContent = '● relay reachable'; st.className = 'mini-status ok'; }
    else {
      st.textContent = (mode === 'local')
        ? '● local relay not running — start aeye-4chan-relay.py, then re-test'
        : '● relay not reachable';
      st.className = 'mini-status err';
    }
  }

  // reflect rss_enabled + relay mode into the settings controls, and show the
  // custom-URL row only in custom mode
  function syncModeUI() {
    const rssCb = $('board-rss-enable');
    if (rssCb) rssCb.checked = rssEnabled();
    const modeSel = $('board-relay-mode');
    if (modeSel) modeSel.value = getMode();
    const customRow = $('board-relay-custom');
    if (customRow) customRow.style.display = (getMode() === 'custom') ? '' : 'none';
  }

  function wire() {
    // master switch for the whole board-ticker system
    const rssCb = $('board-rss-enable');
    if (rssCb) rssCb.addEventListener('change', () => {
      setRss(rssCb.checked); syncModeUI(); poll(); refreshRelayStatus();
    });
    // relay mode: off / local / custom
    const modeSel = $('board-relay-mode');
    if (modeSel) modeSel.addEventListener('change', () => {
      setMode(modeSel.value); syncModeUI(); poll(); refreshRelayStatus();
    });
    // custom relay URL (only used in custom mode)
    const relayInp = $('board-relay-url');
    if (relayInp) relayInp.value = getRelay();
    const relaySave = $('board-relay-save');
    if (relaySave) relaySave.addEventListener('click', () => {
      setRelay(relayInp ? relayInp.value : '');
      poll();
      refreshRelayStatus();
    });
    if (relayInp) relayInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (relaySave) relaySave.click(); }
    });
    // one-click: switch to the bundled local relay
    const relayLocal = $('board-relay-local');
    if (relayLocal) relayLocal.addEventListener('click', () => {
      setMode('local'); syncModeUI(); poll(); refreshRelayStatus();
    });
    // manual reachability check
    const relayTest = $('board-relay-test');
    if (relayTest) relayTest.addEventListener('click', refreshRelayStatus);
    // "open keys folder": copy the Explorer-friendly path (always works) and
    // also ask the server to open it (only works if /api/open accepts a path)
    const openKeys = $('open-appdata');
    if (openKeys) openKeys.addEventListener('click', () => {
      const path = '%APPDATA%\\AEYE';
      const st = $('appdata-status');
      const done = (msg, ok) => { if (st) { st.textContent = msg; st.className = 'mini-status' + (ok ? ' ok' : ''); } };
      fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: path }) }).catch(() => {});
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(path)
          .then(() => done('path copied — paste into Explorer’s address bar', true))
          .catch(() => done(path, false));
      } else { done(path, false); }
    });
    syncModeUI();
    refreshRelayStatus();                        // show status as soon as settings load

    // max items
    const maxInp = $('board-max');
    if (maxInp) {
      maxInp.value = getMax();
      maxInp.addEventListener('change', () => {
        const n = Math.min(50, Math.max(5, parseInt(maxInp.value || '20', 10) || 20));
        maxInp.value = n; setMax(n); poll();
      });
    }

    // board list + add
    buildList();
    const addBtn = $('board-add-btn');
    if (addBtn) addBtn.addEventListener('click', addBoard);
    const addId = $('board-add-id');
    if (addId) addId.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addBoard(); }
    });

    // one delegated click handler covers every title (including cloned copies):
    // open in the system browser instead of navigating the app's webview
    const bar = barEl();
    if (bar) bar.addEventListener('click', (e) => {
      const a = e.target.closest('a.tk-title');
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const url = a.getAttribute('href');
      if (!isHttp(url)) return;
      fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).catch(() => { /* noop */ });
    });

    // flip on/off the moment the shared web-access checkbox changes
    const web = $('web-enable');
    if (web) web.addEventListener('change', () => poll());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    let rz;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(poll, 250); });

    poll();
    schedule();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.BOARDS = { refresh: poll };
})();
