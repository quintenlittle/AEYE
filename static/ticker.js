/* ================================================================
   AEYE -- top price tickers (OPT-IN, gated behind web access).

   Two scrolling lanes along the top of the header: commodities on the
   LEFT, crypto on the RIGHT. Quotes come from Yahoo Finance via the
   server's /api/ticker, fetched ONLY while the web-access toggle is on --
   so this inherits web.js's opt-in gate and is the ONLY other feature that
   ever leaves the machine. While web is off (the default) OR a fetch fails,
   each lane reads a red "ticker offline" and no request is made.

   Which symbols show is configurable in manage > settings (defaults: WTI
   oil + bitcoin only); the set is saved in localStorage['aeye-tickers'].
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Yahoo Finance symbols. `on` = enabled on a fresh profile.
  const CATALOG = {
    commodity: [
      { sym: 'CL=F',  label: 'WTI OIL', on: true },
      { sym: 'BZ=F',  label: 'BRENT' },
      { sym: 'GC=F',  label: 'GOLD' },
      { sym: 'SI=F',  label: 'SILVER' },
      { sym: 'NG=F',  label: 'NAT GAS' },
      { sym: 'HG=F',  label: 'COPPER' },
      { sym: '^GSPC', label: 'S&P 500' },
    ],
    crypto: [
      { sym: 'BTC-USD',  label: 'BITCOIN', on: true },
      { sym: 'ETH-USD',  label: 'ETHEREUM' },
      { sym: 'SOL-USD',  label: 'SOLANA' },
      { sym: 'XRP-USD',  label: 'XRP' },
      { sym: 'DOGE-USD', label: 'DOGECOIN' },
      { sym: 'BNB-USD',  label: 'BNB' },
      { sym: 'ADA-USD',  label: 'CARDANO' },
    ],
  };
  const KEY = 'aeye-tickers';
  const CUSTOM_KEY = 'aeye-tickers-custom';
  const POLL_MS = 60000;                 // prices refresh once a minute -- light

  // user-added Yahoo symbols, per side: { commodity:[{sym,label}], crypto:[...] }
  function loadCustom() {
    try {
      const c = JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null');
      if (c && Array.isArray(c.commodity) && Array.isArray(c.crypto)) return c;
    } catch { /* corrupt -> none */ }
    return { commodity: [], crypto: [] };
  }
  let custom = loadCustom();
  const saveCustom = () => localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));

  // built-in catalog + the user's custom symbols for a side
  const listFor = (group) => [...CATALOG[group], ...custom[group]];
  const allList = () => [...listFor('commodity'), ...listFor('crypto')];
  const isCustom = (group, sym) => custom[group].some((c) => c.sym === sym);

  // enabled = { sym: true }. No saved value -> the catalog's `on` defaults.
  function loadEnabled() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && typeof saved === 'object') return saved;
    } catch { /* corrupt -> defaults */ }
    const d = {};
    allList().forEach((t) => { if (t.on) d[t.sym] = true; });
    return d;
  }
  const saveEnabled = () => localStorage.setItem(KEY, JSON.stringify(enabled));

  let enabled = loadEnabled();

  // web access is the gate -- read WEB if it's up, else the raw flag
  const webOn = () =>
    window.WEB ? WEB.enabled() : localStorage.getItem('aeye-web') === '1';

  const labelOf = (sym) => (allList().find((t) => t.sym === sym) || {}).label || sym;
  const enabledSyms = (group) =>
    listFor(group).filter((t) => enabled[t.sym]).map((t) => t.sym);

  // a readable label from a Yahoo symbol: BTC-USD->BTC, CL=F->CL, ^GSPC->GSPC
  const labelFromSym = (sym) =>
    sym.replace(/-USD$/i, '').replace(/=[A-Z]$/i, '').replace(/^\^/, '') || sym;

  // ---- rendering -------------------------------------------------------------

  function fmtPrice(v) {
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(4);
  }

  function itemHTML(q) {
    const up = q.change >= 0;
    const pct = (up ? '+' : '') + (q.pct || 0).toFixed(2) + '%';
    const price = (q.currency === 'USD' ? '$' : '') + fmtPrice(q.price);
    return '<span class="tick">'
      + '<span class="tk-label">' + labelOf(q.symbol) + '</span>'
      + '<span class="tk-price">' + price + '</span>'
      + '<span class="tk-chg ' + (up ? 'up' : 'down') + '">'
        + (up ? '▲' : '▼') + ' ' + pct + '</span>'
      + '</span>';
  }

  const trackOf = (lane) => lane.querySelector('.tick-track');

  function renderOffline(lane) {
    const t = trackOf(lane);
    t.style.animation = 'none';
    t.style.transform = 'none';
    t.innerHTML = '<span class="tick tick-off">⚠ ticker offline</span>';
  }

  function renderLane(lane, quotes) {
    const track = trackOf(lane);
    track.style.animation = 'none';
    track.style.transform = 'none';
    if (!quotes.length) { track.innerHTML = ''; return; }
    const base = quotes.map(itemHTML).join('');
    // one sequence first, so we can measure it and repeat the items until a
    // single sequence fills the lane -- a sparse strip (one symbol) then still
    // scrolls seamlessly instead of showing a gap between the two copies.
    // Measured SYNCHRONOUSLY (reading scrollWidth forces the reflow): rAF is
    // paused while the tab reports hidden, so a deferred layout pass can stall.
    track.innerHTML = '<span class="tick-seq">' + base + '</span>';
    const laneW = lane.clientWidth || 320;
    const seq = track.querySelector('.tick-seq');
    let reps = 1;
    while (seq.scrollWidth < laneW && reps < 24) {
      reps += 1;
      seq.innerHTML = base.repeat(reps);
    }
    const seqHTML = seq.innerHTML;
    track.innerHTML = '<span class="tick-seq">' + seqHTML + '</span>'
      + '<span class="tick-seq">' + seqHTML + '</span>';
    const w = track.querySelector('.tick-seq').scrollWidth || 320;
    const dur = Math.max(12, w / 45);            // ~constant 45 px/s pace
    void track.offsetWidth;                      // reflow so the restart takes
    // set longhands, not the shorthand -- a var() in the `animation` shorthand
    // won't parse via CSSOM (leaves animation:none)
    track.style.animationName = 'tick-scroll';
    track.style.animationDuration = dur + 's';
    track.style.animationTimingFunction = 'linear';
    track.style.animationIterationCount = 'infinite';
    // commodities (left) drift right->left; crypto (right) left->right, so the
    // two strips move in opposite directions (reverse just runs the same
    // keyframe backwards). Set explicitly -- the `animation:'none'` reset above
    // clears direction inline, so a CSS rule wouldn't stick.
    track.style.animationDirection = (lane.id === 'ticker-right') ? 'reverse' : 'normal';
  }

  // ---- polling ---------------------------------------------------------------

  async function fetchQuotes(syms) {
    const r = await fetch('/api/ticker?symbols=' + encodeURIComponent(syms.join(',')));
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'ticker failed');
    return d.quotes || [];
  }

  let inflight = false;
  async function poll() {
    const left = $('ticker-left'), right = $('ticker-right');
    if (!left || !right) return;
    const cSyms = enabledSyms('commodity'), kSyms = enabledSyms('crypto');

    const bar = $('ticker-bar');
    if (!webOn()) {                         // default state: one centered badge
      if (bar) bar.classList.add('off');
      renderOffline(left);
      trackOf(right).innerHTML = '';
      return;
    }
    if (bar) bar.classList.remove('off');
    if (!cSyms.length && !kSyms.length) {   // nothing enabled -> blank strips
      trackOf(left).innerHTML = '';
      trackOf(right).innerHTML = '';
      return;
    }
    if (inflight) return;
    inflight = true;
    let quotes;
    try { quotes = await fetchQuotes([...cSyms, ...kSyms]); }
    catch { renderOffline(left); renderOffline(right); inflight = false; return; }
    finally { inflight = false; }

    const by = {};
    quotes.forEach((q) => { by[q.symbol] = q; });
    const pick = (syms) => syms.map((s) => by[s]).filter(Boolean);
    const lq = pick(cSyms), rq = pick(kSyms);
    // a lane whose enabled symbols ALL failed reads offline; a blank (none
    // enabled) lane already returned above.
    (cSyms.length && !lq.length) ? renderOffline(left) : renderLane(left, lq);
    (kSyms.length && !rq.length) ? renderOffline(right) : renderLane(right, rq);
  }

  let timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  }

  // ---- settings symbol picker ------------------------------------------------

  function buildCfg(group, host) {
    if (!host) return;
    host.innerHTML = '';
    listFor(group).forEach((t) => {
      const lab = document.createElement('label');
      lab.className = 'chk';
      lab.title = t.sym;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!enabled[t.sym];
      cb.addEventListener('change', () => {
        if (cb.checked) enabled[t.sym] = true; else delete enabled[t.sym];
        saveEnabled();
        poll();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + t.label));
      if (isCustom(group, t.sym)) {           // custom symbols get a remove ×
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ticker-rm';
        x.textContent = '×';
        x.title = 'remove ' + t.sym;
        x.addEventListener('click', (e) => {
          e.preventDefault();
          custom[group] = custom[group].filter((c) => c.sym !== t.sym);
          delete enabled[t.sym];
          saveCustom();
          saveEnabled();
          buildCfg(group, host);
          poll();
        });
        lab.appendChild(x);
      }
      host.appendChild(lab);
    });
  }

  function rebuildCfg() {
    buildCfg('commodity', $('ticker-cfg-commodity'));
    buildCfg('crypto', $('ticker-cfg-crypto'));
  }

  async function addCustom() {
    const side = $('ticker-add-side').value === 'crypto' ? 'crypto' : 'commodity';
    const st = $('ticker-add-status');
    const setStatus = (t, err) => {
      st.textContent = t; st.className = 'mini-status' + (err ? ' err' : '');
    };
    const sym = $('ticker-add-code').value.trim().toUpperCase();
    if (!sym) { setStatus('enter a Yahoo symbol', true); return; }
    if (!/^[A-Z0-9.\-^=]{1,15}$/.test(sym)) { setStatus('invalid symbol', true); return; }
    if (allList().some((t) => t.sym === sym)) {
      setStatus(sym + ' is already listed', true); return;
    }
    // validate against Yahoo when web is on, so a typo is caught immediately
    if (webOn()) {
      setStatus('checking ' + sym + '…');
      try {
        const d = await (await fetch('/api/ticker?symbols=' + encodeURIComponent(sym))).json();
        if (!d.ok || !(d.quotes || []).length) {
          setStatus('no data for ' + sym + ' — check the code', true); return;
        }
      } catch { /* network hiccup -> add it anyway */ }
    }
    custom[side].push({ sym, label: labelFromSym(sym) });
    enabled[sym] = true;
    saveCustom();
    saveEnabled();
    rebuildCfg();
    $('ticker-add-code').value = '';
    setStatus('added ' + sym + ' to ' + (side === 'crypto' ? 'crypto' : 'commodities'));
    poll();
  }

  function wire() {
    rebuildCfg();
    const addBtn = $('ticker-add-btn');
    if (addBtn) addBtn.addEventListener('click', addCustom);
    const addCode = $('ticker-add-code');
    if (addCode) addCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCustom(); }
    });
    // flip on/off the moment the shared web-access checkbox changes
    const web = $('web-enable');
    if (web) web.addEventListener('change', () => poll());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    // relayout the marquee when the window width changes (lane fill depends on it)
    let rz;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(poll, 250); });
    poll();
    schedule();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.TICKER = { refresh: poll };
})();
