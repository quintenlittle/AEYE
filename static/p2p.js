/* ================================================================
   AEYE -- encrypted P2P window.
   Phase 1: session handshake (host a code + listener; a peer dials
   in with IP + port + code, on the 8131 socket -- separate from the
   8130 HTTP server).
   Phase 2: real-time chat over that authenticated connection. No
   encryption / no file transfer / no persistence yet.

   Receive is a poll-based bridge: the backend read loop pushes chat
   + lifecycle events into a hub (p2p.HUB); this window polls
   /api/p2p/poll and renders them. Modal open/close (backdrop, x,
   Esc) is handled globally in library.js for any .overlay.
   ================================================================ */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const GUIDE_URL = 'https://portforward.com/how-to-port-forward/';

  let statusTimer = null;   // host-info poll (2s)
  let chatTimer = null;     // chat-event poll (~0.7s)
  let chatCursor = 0;       // last event seq we've rendered

  async function post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  function setStatus(id, msg, err) {
    const e = $(id);
    if (e) { e.textContent = msg || ''; e.className = 'mini-status' + (err ? ' err' : ''); }
  }

  // ---- host section --------------------------------------------------------
  function fmtExpiry(secs) {
    if (!secs || secs <= 0) return 'expired';
    const m = Math.floor(secs / 60), s = secs % 60;
    return m + 'm ' + String(s).padStart(2, '0') + 's';
  }

  function showHostInfo(d) {
    $('p2p-code').textContent = d.code || '—';
    $('p2p-ip').textContent = d.ip || '—';
    $('p2p-port').textContent = (d.port != null) ? d.port : '—';
    $('p2p-expiry').textContent = fmtExpiry(d.expires_in);
    $('p2p-conns').textContent = (d.connections != null) ? d.connections : 0;
    $('p2p-host-info').classList.remove('hidden');
    $('p2p-host-stop').classList.remove('hidden');
    $('p2p-host-start').textContent = 'Restart Session';
    if (Array.isArray(d.logs)) {
      const log = $('p2p-log');
      log.textContent = d.logs.join('\n');
      log.scrollTop = log.scrollHeight;
    }
  }

  function hideHostInfo() {
    $('p2p-host-info').classList.add('hidden');
    $('p2p-host-stop').classList.add('hidden');
    $('p2p-host-start').textContent = 'Start Session';
  }

  async function refreshStatus() {
    let d;
    try { d = await (await fetch('/api/p2p/status')).json(); }
    catch { return; }
    if (d.hosting) {
      showHostInfo(d);
      setStatus('p2p-host-status', d.expires_in > 0 ? 'hosting' : 'code expired', d.expires_in <= 0);
    } else {
      hideHostInfo();
    }
  }

  async function startHost() {
    setStatus('p2p-host-status', 'starting…');
    const d = await post('/api/p2p/host/start', {});
    if (!d.ok) { setStatus('p2p-host-status', d.error || 'failed to start', true); return; }
    showHostInfo(d);
    setStatus('p2p-host-status', 'hosting');
  }

  async function stopHost() {
    await post('/api/p2p/host/stop', {});
    hideHostInfo();
    $('p2p-log').textContent = '';
    setStatus('p2p-host-status', 'stopped');
  }

  // ---- chat (Phase 2) ------------------------------------------------------
  function appendMsg(who, text) {
    const log = $('p2p-chat-log');
    const div = document.createElement('div');
    div.className = 'p2p-msg ' + (who === 'you' ? 'me' : 'peer');
    div.textContent = (who === 'you' ? 'you  ' : 'peer  ') + text;   // textContent = safe
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  // verbose log line -- only shown when Debug Mode is on (spec: minimal logs /
  // no message contents printed when disabled)
  function debugLine(line) {
    if (!$('p2p-debug').checked) return;
    const log = $('p2p-chat-log');
    const div = document.createElement('div');
    div.className = 'p2p-msg dbg';
    div.textContent = line;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function setChatConnected(on) {
    const st = $('p2p-chat-status');
    st.textContent = on ? 'Connected' : 'Disconnected';
    st.className = 'p2p-status ' + (on ? 'ok' : 'off');
    $('p2p-chat-msg').disabled = !on;
    $('p2p-chat-send').disabled = !on;
    $('p2p-chat-disconnect').classList.toggle('hidden', !on);
  }

  function setAuthFailed() {
    const st = $('p2p-chat-status');
    st.textContent = 'Auth Failed';
    st.className = 'p2p-status err';
  }

  function handleEvent(ev) {
    switch (ev.kind) {
      case 'chat':
        appendMsg('peer', ev.msg);
        break;
      case 'connected':
        setChatConnected(true);
        debugLine('[CONNECTION ESTABLISHED] ' + (ev.peer || ''));
        break;
      case 'disconnected':
        setChatConnected(false);
        debugLine('[DISCONNECTED] ' + (ev.peer || ''));
        break;
      case 'invalid':
        debugLine('[INVALID MESSAGE] ' + (ev.reason || ''));
        break;
      default:
        debugLine('[EVENT] ' + ev.kind);
    }
  }

  async function pollChat() {
    let d;
    try { d = await (await fetch('/api/p2p/poll?since=' + chatCursor)).json(); }
    catch { return; }
    chatCursor = d.cursor;
    (d.events || []).forEach(handleEvent);
    // keep the indicator honest even between explicit connect/disconnect events
    const st = $('p2p-chat-status');
    if (d.connected && st.textContent !== 'Connected') setChatConnected(true);
    if (!d.connected && st.textContent === 'Connected') setChatConnected(false);
  }

  async function sendChat() {
    const inp = $('p2p-chat-msg');
    const text = inp.value;
    if (!text.trim()) return;
    inp.value = '';
    appendMsg('you', text);            // immediate local echo (spec)
    debugLine('[CHAT SENT] ' + text);
    const d = await post('/api/p2p/send', { msg: text });
    if (!d.ok) { debugLine('[SEND FAILED] ' + (d.error || '')); appendMsg('you', '(failed to send: ' + (d.error || 'unknown') + ')'); }
  }

  async function connect() {
    const ip = $('p2p-c-ip').value.trim();
    const port = parseInt($('p2p-c-port').value, 10) || 8131;
    const code = $('p2p-c-code').value.trim().toUpperCase();
    if (!ip) { setStatus('p2p-connect-status', 'enter the host IP', true); return; }
    if (!code) { setStatus('p2p-connect-status', 'enter the session code', true); return; }
    setStatus('p2p-connect-status', 'connecting…');
    // persistent chat connection (new route; the one-shot /api/p2p/connect is untouched)
    const d = await post('/api/p2p/chat/connect', { ip, port, code });
    if (d.ok) {
      setStatus('p2p-connect-status', '✓ connected');
      $('p2p-chat-log').textContent = '';        // fresh session (no persistence)
      setChatConnected(true);
      debugLine('[CONNECTION ESTABLISHED] ' + ip + ':' + port);
    } else if (d.result === 'auth_fail') {
      setStatus('p2p-connect-status', '✗ rejected — bad or expired code', true);
      setAuthFailed();
    } else {
      setStatus('p2p-connect-status', '✗ ' + (d.error || 'could not connect'), true);
      setChatConnected(false);
    }
  }

  async function disconnect() {
    await post('/api/p2p/chat/disconnect', {});
    setChatConnected(false);
  }

  // Debug Mode: sync to the backend so message CONTENTS stay out of the server
  // logs when off (they still show in the chat window). Frontend verbose lines
  // are gated separately in debugLine().
  async function syncDebug() {
    try { await post('/api/p2p/debug', { enabled: $('p2p-debug').checked }); }
    catch { /* ignore */ }
  }

  async function toggleUpnp() {
    const enable = $('p2p-upnp').checked;
    setStatus('p2p-upnp-status', enable ? 'requesting UPnP…' : 'removing forward…');
    const d = await post('/api/p2p/upnp', { enable });
    if (d.ok) {
      setStatus('p2p-upnp-status', '✓ port ' + d.port + ' forwarded');
    } else {
      setStatus('p2p-upnp-status', d.note || 'UPnP unavailable', true);
      if (enable) $('p2p-upnp').checked = false;
    }
  }

  function openGuide() {
    if (window.SIDEBAR && window.SIDEBAR.open) { window.SIDEBAR.open(GUIDE_URL); return; }
    fetch('/api/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: GUIDE_URL }),
    }).catch(() => {});
  }

  // ---- polling lifecycle ---------------------------------------------------
  function startPolling() {
    if (!statusTimer) statusTimer = setInterval(refreshStatus, 2000);
    if (!chatTimer) chatTimer = setInterval(pollChat, 700);
  }
  function stopPolling() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
  }

  async function openWindow() {
    $('p2p-modal').classList.remove('hidden');
    refreshStatus();
    syncDebug();                          // align backend logging with the checkbox
    // prime the chat cursor to the current tail so we don't replay old events
    try {
      const d = await (await fetch('/api/p2p/poll?since=0')).json();
      chatCursor = d.cursor;
      setChatConnected(!!d.connected);
    } catch { /* ignore */ }
    startPolling();
  }

  function wire() {
    const btn = $('p2p-btn');
    if (!btn) return;                    // p2p disabled / older markup
    btn.addEventListener('click', openWindow);
    $('p2p-host-start').addEventListener('click', startHost);
    $('p2p-host-stop').addEventListener('click', stopHost);
    $('p2p-connect').addEventListener('click', connect);
    $('p2p-c-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
    });
    $('p2p-upnp').addEventListener('change', toggleUpnp);
    $('p2p-guide').addEventListener('click', openGuide);
    $('p2p-chat-send').addEventListener('click', sendChat);
    $('p2p-chat-msg').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
    $('p2p-chat-disconnect').addEventListener('click', disconnect);
    $('p2p-debug').addEventListener('change', syncDebug);
    // library.js hides the overlay (backdrop / × / Esc); stop polling when it goes.
    const modal = $('p2p-modal');
    new MutationObserver(() => { if (modal.classList.contains('hidden')) stopPolling(); })
      .observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
