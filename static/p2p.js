/* ================================================================
   AEYE -- P2P (session handshake + real-time chat).

   Setup lives in the "p2p" window (host / connect / network tools +
   a slide-out NATO phonetic helper). On a successful connection the
   window closes and the chat is injected into the MAIN UI as a fixed,
   centred panel (unaffected by the sidebar browser). Debug Mode + the
   listener log live in Manage > Chat.

   ALL socket traffic goes through the single `P2P` transport object
   below -- the UI never talks to the socket directly -- so the
   transport can later be swapped for a TLS-wrapped one without
   touching this UI code. (No TLS yet.)
   ================================================================ */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const GUIDE_URL = 'https://portforward.com/how-to-port-forward/';

  // ---- transport abstraction (single send/receive path) --------------------
  async function jpost(path, body) {
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }
  const P2P = {
    status: () => fetch('/api/p2p/status').then((r) => r.json()),
    poll: (since) => fetch('/api/p2p/poll?since=' + since).then((r) => r.json()),
    send: (msg) => jpost('/api/p2p/send', { msg }),
    hostStart: () => jpost('/api/p2p/host/start', {}),
    hostStop: () => jpost('/api/p2p/host/stop', {}),
    connect: (ip, port, code) => jpost('/api/p2p/chat/connect', { ip, port, code }),
    disconnect: () => jpost('/api/p2p/chat/disconnect', {}),
    upnp: (enable) => jpost('/api/p2p/upnp', { enable }),
    setDebug: (enabled) => jpost('/api/p2p/debug', { enabled }),
    // file transfer -- raw-body upload; progress comes back via poll (kind:file)
    fileSend: (file, chunkSize, lanes) => fetch(
      '/api/p2p/file/send?name=' + encodeURIComponent(file.name) +
      '&chunk_size=' + chunkSize + '&lanes=' + lanes,
      { method: 'POST', body: file }).then((r) => r.json()),
    fileConfig: (location, custom_path) => jpost('/api/p2p/file/config', { location, custom_path }),
  };

  // ---- state ---------------------------------------------------------------
  let role = null;            // 'host' | 'client'
  let hostActive = false;     // a listener is up on this instance
  let connected = false;      // a peer conversation is live
  let chatCursor = 0;
  let pollTimer = null, statusTimer = null;

  const modalOpen = () => !$('p2p-modal').classList.contains('hidden');
  const engaged = () => modalOpen() || hostActive || connected;

  const setStatus = (id, msg, err) => {
    const e = $(id); if (e) { e.textContent = msg || ''; e.className = 'mini-status' + (err ? ' err' : ''); }
  };
  const fmtExpiry = (s) => {
    if (!s || s <= 0) return 'expired';
    const m = Math.floor(s / 60), x = s % 60;
    return m + 'm ' + String(x).padStart(2, '0') + 's';
  };

  // ---- host section (in the setup window) ----------------------------------
  function showHostInfo(d) {
    $('p2p-code').textContent = d.code || '—';
    $('p2p-ip').textContent = d.ip || '—';
    $('p2p-port').textContent = (d.port != null) ? d.port : '—';
    $('p2p-expiry').textContent = fmtExpiry(d.expires_in);
    $('p2p-conns').textContent = (d.connections != null) ? d.connections : 0;
    $('p2p-host-info').classList.remove('hidden');
    $('p2p-host-stop').classList.remove('hidden');
    $('p2p-host-start').textContent = 'Rehost Session';
  }
  function hideHostInfo() {
    $('p2p-host-info').classList.add('hidden');
    $('p2p-host-stop').classList.add('hidden');
    $('p2p-host-start').textContent = 'Host Session';
  }

  async function refreshStatus() {
    let d; try { d = await P2P.status(); } catch { return; }
    hostActive = !!d.hosting;
    if (d.hosting) {
      showHostInfo(d);
      setStatus('p2p-host-status', d.expires_in > 0 ? 'hosting' : 'code expired', d.expires_in <= 0);
      if (d.connections > 0 && !connected) { role = 'host'; onConnected(); }   // peer already in
    } else {
      hideHostInfo();
    }
  }

  async function startHost() {
    setStatus('p2p-host-status', 'starting…');
    const d = await P2P.hostStart();
    if (!d.ok) { setStatus('p2p-host-status', d.error || 'failed to start', true); return; }
    role = 'host'; hostActive = true;
    showHostInfo(d); setStatus('p2p-host-status', 'hosting');
    startPolling();
  }
  async function stopHost() {
    await P2P.hostStop();
    hostActive = false; if (role === 'host') role = null;
    hideHostInfo(); setStatus('p2p-host-status', 'stopped');
  }

  // ---- connect (client) ----------------------------------------------------
  async function connect() {
    const ip = $('p2p-c-ip').value.trim();
    const port = parseInt($('p2p-c-port').value, 10) || 8131;
    const code = $('p2p-c-code').value.trim().toUpperCase();
    if (!ip) { setStatus('p2p-connect-status', 'enter the host IP', true); return; }
    if (code.length < 14) { setStatus('p2p-connect-status', 'enter the full session code', true); return; }
    setStatus('p2p-connect-status', 'connecting…');
    const d = await P2P.connect(ip, port, code);
    if (d.ok) { role = 'client'; setStatus('p2p-connect-status', '✓ connected'); onConnected(); }
    else if (d.result === 'auth_fail') { setStatus('p2p-connect-status', '✗ rejected — bad or expired code', true); debugMsg('[AUTH FAIL] bad or expired code'); }
    else { setStatus('p2p-connect-status', '✗ ' + (d.error || 'could not connect'), true); debugMsg('[CONNECT FAILED] ' + (d.error || '')); }
  }

  // Session-code input: "AEYE-" locked, hyphens auto-inserted, alnum only, all caps.
  function formatCode() {
    const inp = $('p2p-c-code');
    let raw = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '');   // drop invalid chars
    if (raw.indexOf('AEYE') === 0) raw = raw.slice(4);             // strip the fixed prefix
    raw = raw.slice(0, 8);                                         // 8 payload chars max
    let out = 'AEYE-' + raw.slice(0, 4);
    if (raw.length >= 4) out += '-' + raw.slice(4);
    inp.value = out;
  }

  // ---- phonetic slide-out --------------------------------------------------
  function togglePhon() {
    const shell = document.querySelector('#p2p-modal .p2p-shell');
    if (shell) shell.classList.toggle('phon-open');
  }

  // ---- main-UI chat panel --------------------------------------------------
  function positionChat() {
    const el = $('p2p-chat'), hdr = document.querySelector('header');
    if (el && hdr) el.style.top = (hdr.offsetHeight + 8) + 'px';
  }
  function setChatStatus(text, cls) {
    const s = $('p2p-chat-status'); if (s) { s.textContent = text; s.className = 'p2p-status ' + (cls || 'ok'); }
  }
  function appendMsg(who, text) {
    const log = $('p2p-chat-log'), d = document.createElement('div');
    d.className = 'p2p-msg ' + (who === 'you' ? 'me' : (who === 'sys' ? 'dbg' : 'peer'));
    d.textContent = (who === 'you' ? 'you  ' : (who === 'sys' ? '' : 'peer  ')) + text;
    log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  // ---- debug log (Manage > Chat) ------------------------------------------
  // Reconstructed frontend-side from the role-agnostic poll events + local
  // actions, so it works whether THIS instance is the host OR only a connected
  // client (the old host-only listener.logs was why debug "only worked on host").
  let dbgBuf = [];
  const dbgOn = () => $('p2p-debug') && $('p2p-debug').checked;
  function renderDbg() {
    const el = $('p2p-log');
    if (el) { el.textContent = dbgBuf.join('\n'); el.scrollTop = el.scrollHeight; }
  }
  function clearDbg() { dbgBuf = []; renderDbg(); }
  function debugMsg(line) {
    if (!dbgOn()) return;
    dbgBuf.push(line);
    if (dbgBuf.length > 400) dbgBuf.shift();
    renderDbg();
  }

  // ---- new-message notification --------------------------------------------
  // "Message Received" is a SEPARATE, absolutely-centred text element (see the
  // .p2p-notify-text CSS) shown purely by the .notify class -- it never reuses
  // or overwrites the connection label. The breathing-glow animation is
  // unchanged; toggling .notify drives both the glow and the text together.
  let notified = false;
  function notify() {
    notified = true;
    $('p2p-chat').classList.add('notify');
  }
  function clearNotify() {
    if (!notified) return;
    notified = false;
    $('p2p-chat').classList.remove('notify');
  }

  function onConnected() {
    if (connected) return;
    connected = true;
    $('p2p-modal').classList.add('hidden');       // close the setup window
    $('p2p-chat-log').textContent = '';           // fresh session (no persistence)
    positionChat();
    const el = $('p2p-chat');
    el.classList.remove('hidden', 'collapsed', 'notify');
    notified = false;
    $('p2p-chat-collapse').textContent = '▲';
    setChatStatus('Encrypted connection', 'ok');
    $('p2p-chat-msg').disabled = false; $('p2p-chat-send').disabled = false;
    $('p2p-chat-msg').focus();
    pushFileConfig();               // tell the backend where to save incoming files
    startPolling();
  }
  function onDisconnected() {
    connected = false;
    clearNotify();
    clearXfers();                   // no transfer state persists past a session
    $('p2p-chat').classList.add('hidden');
    setChatStatus('Disconnected', 'off');
    role = null;
  }
  async function disconnect() {
    if (role === 'host' || hostActive) { await P2P.hostStop(); hostActive = false; }
    else { await P2P.disconnect(); }
    onDisconnected();
  }
  async function sendChat() {
    const inp = $('p2p-chat-msg'), text = inp.value;
    if (!text.trim()) return;
    inp.value = ''; appendMsg('you', text); debugMsg('[CHAT SENT] ' + text);
    const d = await P2P.send(text);
    if (!d.ok) { debugMsg('[SEND FAILED] ' + (d.error || '')); appendMsg('you', '(failed to send: ' + (d.error || 'unknown') + ')'); }
  }
  function toggleCollapse() {
    const c = $('p2p-chat').classList.toggle('collapsed');
    $('p2p-chat-collapse').textContent = c ? '▼' : '▲';
    if (!c) clearNotify();     // expanding clears the notification
  }

  // ---- event poll (connection detection + messages) ------------------------
  async function pollEvents() {
    let d; try { d = await P2P.poll(chatCursor); } catch { return; }
    chatCursor = d.cursor;
    (d.events || []).forEach((ev) => {
      if (ev.kind === 'chat') {
        appendMsg('peer', ev.msg);
        debugMsg('[CHAT RECEIVED] ' + ev.msg);
        if (document.activeElement !== $('p2p-chat-msg')) notify();   // ping unless actively typing
      } else if (ev.kind === 'connected') {
        // a live connection means TLS + auth already succeeded (both roles)
        debugMsg('[TLS HANDSHAKE SUCCESS] ' + (ev.peer || ''));
        debugMsg('[AUTH SUCCESS] ' + (ev.peer || ''));
        debugMsg('[CONNECTION ESTABLISHED] ' + (ev.peer || ''));
      } else if (ev.kind === 'disconnected') {
        debugMsg('[DISCONNECTED] ' + (ev.peer || ''));
      } else if (ev.kind === 'invalid') {
        debugMsg('[INVALID MESSAGE] ' + (ev.reason || ''));
      } else if (ev.kind === 'file') {
        handleFileEvent(ev);
        debugMsg('[FILE ' + (ev.ev || '').toUpperCase() + '] ' + (ev.dir || '')
          + ' ' + (ev.name || '') + (ev.done != null ? ' ' + ev.done + '/' + (ev.total_chunks || '?') : ''));
      }
    });
    // let the hub's own view of the socket drive connect/disconnect (robust to
    // missed events / reload)
    if (d.connected && !connected) onConnected();
    if (!d.connected && connected) onDisconnected();
    if (!engaged()) stopPolling();
  }

  function startPolling() {
    if (!pollTimer) pollTimer = setInterval(pollEvents, 800);
    if (!statusTimer) statusTimer = setInterval(refreshStatus, 2000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }

  // ==========================================================================
  // FILE TRANSFER (progress panels: chatbox + P2P window with tabs)
  // ==========================================================================
  const LANES = 4;
  const XCELLS = 200;                       // max cells in the Pieces grid
  const xfers = new Map();                  // id -> transfer state
  let xTab = 'details';
  let xFocus = null;                        // id shown in Pieces/Bandwidth

  const fmtBytes = (n) => {
    if (!n && n !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  };
  const fmtSpeed = (bps) => fmtBytes(bps) + '/s';
  const fmtEta = (s) => {
    if (!s || s <= 0 || !isFinite(s)) return '';
    s = Math.round(s);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60); return m + 'm ' + (s % 60) + 's';
  };

  // ---- settings (persisted locally) ----------------------------------------
  const LS_CHUNK = 'aeye_p2p_chunk', LS_LOC = 'aeye_p2p_loc';
  function chunkSize() { const v = parseInt(($('p2p-file-chunk') || {}).value, 10); return v || 65536; }
  function pushFileConfig() {
    const loc = ($('p2p-file-loc') || {}).value || 'desktop';
    P2P.fileConfig(loc, '').catch(() => {});
  }
  function loadFileSettings() {
    const c = localStorage.getItem(LS_CHUNK), l = localStorage.getItem(LS_LOC);
    if (c && $('p2p-file-chunk')) $('p2p-file-chunk').value = c;
    if (l && $('p2p-file-loc')) $('p2p-file-loc').value = l;
    pushFileConfig();
  }

  // ---- send ----------------------------------------------------------------
  async function sendFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!connected) { setStatus('p2p-file-status', 'connect to a peer first', true); return; }
    for (const f of files) {
      setStatus('p2p-file-status', 'sending ' + f.name + '…');
      try {
        const d = await P2P.fileSend(f, chunkSize(), LANES);
        if (!d.ok) { setStatus('p2p-file-status', '✗ ' + (d.error || 'send failed'), true); }
        else { setStatus('p2p-file-status', ''); }   // progress takes over via poll
      } catch (e) { setStatus('p2p-file-status', '✗ upload failed', true); }
    }
  }

  // ---- incoming events (from poll) -----------------------------------------
  function handleFileEvent(ev) {
    const id = ev.id; if (!id) return;
    let t = xfers.get(id);
    if (!t) {
      t = { id, dir: ev.dir, name: ev.name || 'file', size: ev.size || 0,
            total: ev.total_chunks || 0, done: 0, pct: 0, speed: 0, eta: 0,
            status: 'active', bw: [] };
      xfers.set(id, t);
      xFocus = id;
    }
    if (ev.name) t.name = ev.name;
    if (ev.size != null) t.size = ev.size;
    if (ev.total_chunks != null) t.total = ev.total_chunks;
    if (ev.done != null) t.done = ev.done;
    if (ev.pct != null) t.pct = ev.pct;
    if (ev.speed != null) { t.speed = ev.speed; t.bw.push(ev.speed); if (t.bw.length > 120) t.bw.shift(); }
    if (ev.eta != null) t.eta = ev.eta;

    if (ev.ev === 'start') {
      appendMsg('sys', (t.dir === 'up' ? '↑ sending ' : '↓ receiving ') + t.name);
      if (t.dir === 'down' && document.activeElement !== $('p2p-chat-msg')) notify();
      xFocus = id;
    } else if (ev.ev === 'complete') {
      t.status = 'done'; t.pct = 100; if (t.total) t.done = t.total;
      appendMsg('sys', (t.dir === 'up' ? '✓ sent ' : '✓ received ') + t.name
        + (t.dir === 'down' ? ' → saved' : ''));
    } else if (ev.ev === 'error') {
      t.status = 'error';
      appendMsg('sys', '✗ transfer failed: ' + t.name + (ev.error ? ' (' + ev.error + ')' : ''));
    }
    renderXfers();
  }

  // ---- rendering -----------------------------------------------------------
  function xferRow(t, rich) {
    const pct = Math.max(0, Math.min(100, t.pct || 0));
    const arrow = t.dir === 'up' ? '↑' : '↓';
    const stateCls = t.status === 'error' ? ' err' : (t.status === 'done' ? ' done' : '');
    const speed = (t.status === 'active') ? fmtSpeed(t.speed) : (t.status === 'done' ? 'done' : 'error');
    const eta = (t.status === 'active' && t.eta) ? ' · ' + fmtEta(t.eta) + ' left' : '';
    const meta = rich
      ? ('Speed: ' + speed + eta + ' · Chunks: ' + (t.done || 0) + ' / ' + (t.total || 0)
         + ' · ' + fmtBytes(t.size))
      : ('Speed: ' + speed + ' · Chunks: ' + (t.done || 0) + ' / ' + (t.total || 0));
    return '<div class="p2p-xfer-row' + stateCls + '">'
      + '<div class="p2p-xfer-name">' + arrow + ' ' + escapeHtml(t.name) + ' <span>' + pct.toFixed(0) + '%</span></div>'
      + '<div class="p2p-xfer-bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="p2p-xfer-meta">' + meta + '</div></div>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderXfers() {
    const list = Array.from(xfers.values());
    // chatbox compact panel
    const cbox = $('p2p-transfers');
    if (cbox) {
      if (!list.length) { cbox.classList.add('hidden'); cbox.innerHTML = ''; }
      else {
        cbox.classList.remove('hidden');
        cbox.innerHTML = list.map((t) => xferRow(t, false)).join('');
      }
    }
    // P2P window -- Details
    const det = $('p2p-xfer-details');
    if (det) det.innerHTML = list.length
      ? list.map((t) => xferRow(t, true)).join('')
      : '<div class="p2p-xfer-empty">No transfers yet.</div>';
    if (xTab === 'pieces') renderPieces();
    if (xTab === 'bandwidth') renderBandwidth();
  }

  function focusXfer() {
    let t = xFocus && xfers.get(xFocus);
    if (t) return t;
    // fall back to the most recent active, else any
    const list = Array.from(xfers.values());
    return list.filter((x) => x.status === 'active').pop() || list[list.length - 1] || null;
  }

  function renderPieces() {
    const box = $('p2p-xfer-pieces'); if (!box) return;
    const t = focusXfer();
    if (!t || !t.total) { box.innerHTML = '<div class="p2p-xfer-empty">No active transfer to visualize.</div>'; return; }
    const cells = Math.min(XCELLS, t.total);
    const filled = Math.round((t.pct / 100) * cells);
    let html = '<div class="p2p-xfer-head">' + escapeHtml(t.name) + ' — ' + (t.done || 0) + ' / ' + (t.total || 0) + ' chunks</div><div class="p2p-pieces">';
    for (let i = 0; i < cells; i++) html += '<span class="' + (i < filled ? 'on' : '') + '"></span>';
    html += '</div>';
    box.innerHTML = html;
  }

  function renderBandwidth() {
    const cv = $('p2p-xfer-bw'); if (!cv) return;
    const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const t = focusXfer();
    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue('--accent') || '#37d67a').trim() || '#37d67a';
    // grid baseline
    ctx.strokeStyle = 'rgba(128,128,128,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
    if (!t || !t.bw.length) return;
    const data = t.bw, max = Math.max.apply(null, data) || 1;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / Math.max(1, data.length - 1)) * W;
      const y = H - (v / max) * (H - 8) - 2;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = accent; ctx.font = '11px monospace';
    ctx.fillText('peak ' + fmtSpeed(max), 6, 14);
  }

  function switchXTab(name) {
    xTab = name;
    document.querySelectorAll('.p2p-xtab').forEach((b) =>
      b.classList.toggle('active', b.dataset.xtab === name));
    ['details', 'pieces', 'bandwidth'].forEach((n) => {
      const p = $('p2p-xfer-' + n); if (p) p.classList.toggle('hidden', n !== name);
    });
    if (name === 'pieces') renderPieces();
    if (name === 'bandwidth') renderBandwidth();
  }

  // clears the UI only -- active transfers keep running (they reappear on the
  // next progress event); completed/errored rows are removed for good.
  function clearXfers() {
    xfers.clear(); xFocus = null; renderXfers();
    if (xTab === 'pieces') renderPieces();
    if (xTab === 'bandwidth') renderBandwidth();
  }

  // ---- network tools -------------------------------------------------------
  async function toggleUpnp() {
    const enable = $('p2p-upnp').checked;
    setStatus('p2p-upnp-status', enable ? 'requesting UPnP…' : 'removing forward…');
    const d = await P2P.upnp(enable);
    if (d.ok) setStatus('p2p-upnp-status', '✓ port ' + d.port + ' forwarded');
    else { setStatus('p2p-upnp-status', d.note || 'UPnP unavailable', true); if (enable) $('p2p-upnp').checked = false; }
  }
  function openGuide() {
    if (window.SIDEBAR && window.SIDEBAR.open) { window.SIDEBAR.open(GUIDE_URL); return; }
    fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: GUIDE_URL }) }).catch(() => {});
  }

  // ---- window open ---------------------------------------------------------
  async function openWindow() {
    $('p2p-modal').classList.remove('hidden');
    refreshStatus();
    try { const d = await P2P.poll(0); chatCursor = d.cursor; } catch { /* ignore */ }
    startPolling();
  }

  function wire() {
    const btn = $('p2p-btn');
    if (!btn) return;
    btn.addEventListener('click', openWindow);
    // setup window
    $('p2p-host-start').addEventListener('click', startHost);
    $('p2p-host-stop').addEventListener('click', stopHost);
    $('p2p-connect').addEventListener('click', connect);
    $('p2p-phon-toggle').addEventListener('click', togglePhon);
    $('p2p-upnp').addEventListener('change', toggleUpnp);
    $('p2p-guide').addEventListener('click', openGuide);
    // session-code auto-format
    const code = $('p2p-c-code');
    code.value = 'AEYE-';
    code.addEventListener('input', formatCode);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect(); } });
    // main-UI chat panel
    $('p2p-chat-send').addEventListener('click', sendChat);
    $('p2p-chat-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
    $('p2p-chat-collapse').addEventListener('click', toggleCollapse);
    $('p2p-chat-disconnect').addEventListener('click', disconnect);
    // clear the new-message notification on any interaction with the panel
    $('p2p-chat').addEventListener('mousedown', clearNotify);
    $('p2p-chat-msg').addEventListener('focus', clearNotify);
    window.addEventListener('resize', () => { if (connected) positionChat(); });
    // Debug Mode (Manage > Chat) -> sync backend verbosity; off clears the log
    // (no message contents left behind)
    const dbg = $('p2p-debug');
    if (dbg) dbg.addEventListener('change', () => {
      P2P.setDebug(dbg.checked).catch(() => {});
      if (!dbg.checked) clearDbg();
    });
    const clr = $('p2p-clear-log');
    if (clr) clr.addEventListener('click', clearDbg);

    // ---- file transfer wiring ----------------------------------------------
    loadFileSettings();
    const fileInput = $('p2p-file-input');
    const upBtn = $('p2p-file-upload');
    if (upBtn && fileInput) {
      upBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => { sendFiles(fileInput.files); fileInput.value = ''; });
    }
    const attach = $('p2p-chat-attach');
    if (attach && fileInput) attach.addEventListener('click', () => fileInput.click());
    const clrX = $('p2p-file-clear');
    if (clrX) clrX.addEventListener('click', clearXfers);
    const chunkSel = $('p2p-file-chunk');
    if (chunkSel) chunkSel.addEventListener('change', () => localStorage.setItem(LS_CHUNK, chunkSel.value));
    const locSel = $('p2p-file-loc');
    if (locSel) locSel.addEventListener('change', () => { localStorage.setItem(LS_LOC, locSel.value); pushFileConfig(); });
    document.querySelectorAll('.p2p-xtab').forEach((b) =>
      b.addEventListener('click', () => switchXTab(b.dataset.xtab)));

    // drag & drop onto the chat panel -> send the dropped file(s)
    const chatEl = $('p2p-chat');
    if (chatEl) {
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ['dragenter', 'dragover'].forEach((t) => chatEl.addEventListener(t, (e) => {
        stop(e); if (connected) chatEl.classList.add('dragging');
      }));
      ['dragleave', 'dragend'].forEach((t) => chatEl.addEventListener(t, (e) => {
        stop(e); if (e.target === chatEl) chatEl.classList.remove('dragging');
      }));
      chatEl.addEventListener('drop', (e) => {
        stop(e); chatEl.classList.remove('dragging');
        if (connected && e.dataTransfer && e.dataTransfer.files) sendFiles(e.dataTransfer.files);
      });
    }
    // when the setup window is dismissed, tidy the phonetic drawer + stop polling if idle
    const modal = $('p2p-modal');
    new MutationObserver(() => {
      if (modal.classList.contains('hidden')) {
        const shell = modal.querySelector('.p2p-shell');
        if (shell) shell.classList.remove('phon-open');
        if (!engaged()) stopPolling();
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
