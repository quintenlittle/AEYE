/* ================================================================
   AEYE -- Universal Debug: ONE application-wide diagnostic log.

   window.DEBUG.log(category, event, data) is the single emitter; every
   subsystem routes diagnostic events through it. OBSERVATION ONLY -- it never
   changes routing, prompts, permissions, dry_run, workspace, tools or models.

   Privacy: OFF -> nothing captured, persisted history wiped. ON -> operational
   metadata only (never full file/chat/transfer contents); secrets/tokens are
   redacted; per-entry size is capped. Persisted (bounded) under localStorage so
   startup state can be compared with the previous shutdown, and the enabled
   state itself survives restarts (Phase 1B). Loads FIRST so it can capture boot.
   ================================================================ */
(() => {
  'use strict';
  const KEY_ON = 'aeye-debug';        // enabled flag (persists across restarts)
  const KEY_LOG = 'aeye-debug-log';   // bounded persisted ring buffer
  const MAX = 2500;                   // in-memory entries
  const KEEP = 1200;                  // persisted tail (bounded -> no unbounded growth)
  const MAXLEN = 2000;                // per-entry data char cap
  const SESSION = Math.random().toString(36).slice(2, 8);
  let entries = [];
  const listeners = [];

  const enabled = () => localStorage.getItem(KEY_ON) === '1';
  const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

  function sanitize(data) {
    if (data === undefined || data === null) return '';
    let s;
    try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
    // redact obvious secrets/tokens/passwords
    s = s.replace(/((?:"?(?:token|password|passwd|secret|api[_-]?key|authorization|bearer|hf_token)"?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}"']+)/gi, '$1"***"');
    if (s.length > MAXLEN) s = s.slice(0, MAXLEN) + '…[truncated]';
    return s;
  }
  const notify = (e) => listeners.forEach((fn) => { try { fn(e); } catch { /* noop */ } });

  function persist() {
    if (!enabled()) return;
    try { localStorage.setItem(KEY_LOG, JSON.stringify(entries.slice(-KEEP))); }
    catch { /* quota -> silently drop persistence */ }
  }
  function loadPersisted() {
    try { entries = JSON.parse(localStorage.getItem(KEY_LOG) || '[]') || []; }
    catch { entries = []; }
  }

  function log(category, event, data) {
    if (!enabled()) return;
    const e = { t: stamp(), c: String(category || '').toLowerCase(),
      e: String(event || ''), d: sanitize(data) };
    entries.push(e);
    if (entries.length > MAX) entries.shift();
    persist();
    notify(e);
  }

  const render = (e) => '[' + e.t + '] [' + e.c.toUpperCase() + '] ' + e.e + (e.d ? '  ' + e.d : '');
  function text(cats) {
    const es = (!cats || !cats.length) ? entries : entries.filter((e) => cats.includes(e.c));
    return es.map(render).join('\n');
  }
  function clear() {
    entries = [];
    try { localStorage.removeItem(KEY_LOG); } catch { /* noop */ }
    notify(null);
  }
  const categories = () => [...new Set(entries.map((e) => e.c))].sort();

  function setEnabled(on) {
    localStorage.setItem(KEY_ON, on ? '1' : '0');
    if (on) {
      loadPersisted();
      log('runtime', '===== DEBUG SESSION START =====',
        { session: SESSION, version: window.__AEYE_VER || '?', time: stamp() });
    } else {
      // OFF -> stop + wipe persistent diagnostic history (privacy)
      try { localStorage.removeItem(KEY_LOG); } catch { /* noop */ }
      entries = [];
    }
    // sync the backend agent-tool debug flag + the P2P debug flag (observation)
    try { if (window.TOOLS && TOOLS.setConfig) TOOLS.setConfig({ debug: on }); } catch { /* noop */ }
    try {
      fetch('/api/p2p/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }) });
    } catch { /* noop */ }
    notify(null);
  }
  const onChange = (fn) => { listeners.push(fn); };

  // Phase 1B: if Debug was ON at last shutdown, come up ON and capture startup.
  if (enabled()) {
    loadPersisted();
    log('runtime', '===== APP START =====', { session: SESSION, time: stamp() });
    // ensure the backend flags match the persisted ON state at boot
    setTimeout(() => { try {
      if (window.TOOLS && TOOLS.setConfig) TOOLS.setConfig({ debug: true });
      fetch('/api/p2p/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
    } catch { /* noop */ } }, 300);
  }

  window.DEBUG = { enabled, log, text, clear, setEnabled, onChange, categories };
})();
