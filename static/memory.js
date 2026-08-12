/* ================================================================
   AEYE -- opt-in chat memory + projects.
   OFF by default (localStorage 'aeye-memory'); while off, nothing is
   ever written to disk -- the original no-chat-logging posture.
   While on: every completed exchange is appended to a local JSON file
   (./memory on the server), chats can be grouped into projects, and a
   model-written briefing (summary) is refreshed on exit so a resumed
   chat re-reads a paragraph + the last few messages, never the whole
   transcript. Briefings from the selected project (or, in automatic
   mode, topic-matched briefings) are injected as system context.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const TAIL = 12;          // raw messages kept verbatim when resuming
  const CTX_CAP = 5000;     // max chars of injected memory context

  // ---- session state -------------------------------------------------------

  let chatId = null;        // server id of the chat being appended to
  let savedUpto = 0;        // how many of CHAT's messages are already on disk
  let cache = null;         // /api/memory/list result
  let cacheAt = 0;

  const enabled = () => localStorage.getItem('aeye-memory') === '1';
  const activeProject = () => localStorage.getItem('aeye-memory-project') || '';

  // ---- server io -----------------------------------------------------------

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function list(force) {
    if (!force && cache && Date.now() - cacheAt < 30000) return cache;
    cache = await api('/api/memory/list');
    cacheAt = Date.now();
    return cache;
  }

  // strip attachments etc. -- only role + text are remembered
  const clean = (m) => ({ role: m.role, content: m.content || '' });

  // ---- autosave (called by chat.js after every exchange) --------------------

  let saving = false;
  async function autosave(messages) {
    if (!enabled() || saving) return;
    const fresh = messages.slice(savedUpto).map(clean)
      .filter((m) => m.role !== 'system');
    if (!fresh.length) return;
    saving = true;
    try {
      const r = await api('/api/memory/save', { id: chatId, append: fresh });
      if (r.ok) {
        if (!chatId && activeProject()) {
          // a brand-new chat born inside a selected project joins it
          await api('/api/memory/assign',
            { id: r.chat.id, project_id: activeProject() });
        }
        chatId = r.chat.id;
        savedUpto = messages.length;
        cacheAt = 0;                       // list is stale now
        updateBadge();
      }
    } catch { /* keep savedUpto -- retried on the next exchange */ }
    finally { saving = false; }
  }

  // ---- exit briefing ---------------------------------------------------------

  function beacon(path, payload) {
    try {
      navigator.sendBeacon(path,
        new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    } catch { /* best-effort */ }
  }

  // refresh the current chat's briefing; beacon=true survives page close
  function finalize(useBeacon) {
    if (!enabled() || !chatId) return;
    const [backend, model] = window.CHAT.currentModel();
    if (!backend) return;
    const payload = { id: chatId, backend, model };
    if (useBeacon) beacon('/api/memory/summarize', payload);
    else api('/api/memory/summarize', payload).catch(() => {});
  }

  // start a fresh conversation: brief the old one, reset counters
  function newChat() {
    finalize(false);
    chatId = null;
    savedUpto = 0;
  }

  // the desktop window hard-exits right after this fires -- flush any unsaved
  // tail with a beacon, then request the briefing. If the process dies before
  // the summary lands, resume() regenerates it lazily next boot.
  window.addEventListener('pagehide', () => {
    if (!enabled()) return;
    const msgs = window.CHAT.getMessages();
    const fresh = msgs.slice(savedUpto).map(clean)
      .filter((m) => m.role !== 'system');
    if (fresh.length && chatId) beacon('/api/memory/save', { id: chatId, append: fresh });
    finalize(true);
  });

  // ---- resume ---------------------------------------------------------------

  async function resume(id, statusEl) {
    newChat();                              // brief whatever was open
    let chat = await api('/api/memory/chat?id=' + encodeURIComponent(id));
    if (chat.error) { window.CHAT.note(chat.error, true); return; }

    // long chat with a stale briefing: refresh it now so the context the
    // model sees actually covers the messages we are about to drop
    const stale = (chat.summary_upto || 0) < chat.messages.length;
    if (chat.messages.length > TAIL && (!chat.summary || stale)) {
      if (statusEl) statusEl.textContent = 'the eye recollects… (writing briefing)';
      const [backend, model] = window.CHAT.currentModel();
      if (backend) {
        const r = await api('/api/memory/summarize', { id, backend, model });
        if (r.ok) chat.summary = r.summary;
      }
    }

    let ctx, dropped = 0;
    if (chat.summary && chat.messages.length > TAIL) {
      dropped = chat.messages.length - TAIL;
      ctx = [{
        role: 'system',
        content: '[MEMORY] You are resuming an earlier conversation with this '
          + 'user. Briefing of the ' + dropped + ' earlier messages:\n'
          + chat.summary,
      }, ...chat.messages.slice(-TAIL).map(clean)];
    } else {
      ctx = chat.messages.map(clean);
    }

    window.CHAT.loadConversation(ctx,
      'Resumed "' + chat.title + '"'
      + (dropped ? ' — ' + dropped + ' earlier messages folded into a briefing.' : '.'));
    chatId = chat.id;
    savedUpto = ctx.length;                 // only NEW messages get appended
    updateBadge();
  }

  // ---- context injection (chat.js calls this per send) -----------------------

  const tokenize = (t) => [...new Set((t.toLowerCase().match(/[a-z0-9]{4,}/g) || []))];

  async function contextFor(text) {
    if (!enabled()) return '';
    let data;
    try { data = await list(); } catch { return ''; }
    const chats = (data.chats || []).filter((c) => c.summary && c.id !== chatId);
    if (!chats.length) return '';
    const projName = (pid) => {
      const p = (data.projects || []).find((x) => x.id === pid);
      return p ? p.name : '';
    };

    let picked = [];
    const pid = activeProject();
    if (pid) {
      // project mode: this project's briefings always ride along
      picked = chats.filter((c) => c.project_id === pid).slice(0, 6);
    } else {
      // automatic: only chats whose briefing overlaps the new message's topic
      const toks = tokenize(text);
      if (toks.length < 2) return '';
      const need = Math.min(3, toks.length);
      picked = chats
        .map((c) => {
          const hay = (c.title + ' ' + c.summary).toLowerCase();
          return [toks.filter((t) => hay.includes(t)).length, c];
        })
        .filter(([score]) => score >= need)
        .sort((a, b) => b[0] - a[0])
        .slice(0, 2)
        .map(([, c]) => c);
    }
    if (!picked.length) return '';

    let out = '[MEMORY] Briefings of past conversations with this user'
      + (pid ? ' in the "' + projName(pid) + '" project' : '') + ':';
    for (const c of picked) {
      const entry = '\n• "' + c.title + '"'
        + (c.project_id && !pid ? ' (' + projName(c.project_id) + ')' : '')
        + ': ' + c.summary;
      if (out.length + entry.length > CTX_CAP) break;
      out += entry;
    }
    return out + '\nUse this memory when relevant; do not mention the memory '
      + 'system unless asked.';
  }

  // ---- modal ui --------------------------------------------------------------

  const fmtAge = (ts) => {
    const s = (Date.now() / 1000 - ts) | 0;
    if (s < 3600) return ((s / 60) | 0) + 'm ago';
    if (s < 86400) return ((s / 3600) | 0) + 'h ago';
    return ((s / 86400) | 0) + 'd ago';
  };

  function updateBadge() {
    const btn = $('memory-btn');
    btn.classList.toggle('mem-on', enabled());
    btn.title = enabled()
      ? 'Memory is ON — chats are saved locally' + (chatId ? ' (this chat is being remembered)' : '')
      : 'Memory is OFF — nothing is saved (click to manage)';
  }

  async function render() {
    const st = $('mem-status');
    $('mem-toggle').checked = enabled();
    let data;
    try { data = await list(true); } catch { st.textContent = 'server unreachable'; return; }
    const projects = data.projects || [];
    const chats = data.chats || [];

    // context project selector
    const sel = $('mem-context');
    sel.innerHTML = '';
    sel.append(new Option('automatic (topic match)', ''));
    for (const p of projects) sel.append(new Option('project: ' + p.name, p.id));
    sel.value = projects.some((p) => p.id === activeProject()) ? activeProject() : '';

    // project chips
    const box = $('mem-projects');
    box.innerHTML = '';
    for (const p of projects) {
      const chip = document.createElement('span');
      chip.className = 'mem-chip';
      chip.textContent = p.name + ' (' + chats.filter((c) => c.project_id === p.id).length + ')';
      const x = document.createElement('button');
      x.className = 'mem-chip-x';
      x.textContent = '×';
      x.title = 'Delete project (its chats become unassigned)';
      x.addEventListener('click', async () => {
        await api('/api/memory/project/delete', { id: p.id });
        if (activeProject() === p.id) localStorage.setItem('aeye-memory-project', '');
        render();
      });
      chip.appendChild(x);
      box.appendChild(chip);
    }
    if (!projects.length) box.textContent = 'no projects yet';

    // chat rows
    const tb = $('mem-body');
    tb.innerHTML = '';
    for (const c of chats) {
      const tr = document.createElement('tr');

      const tdT = document.createElement('td');
      tdT.className = 'mem-title';
      tdT.textContent = c.title;
      if (c.summary) tdT.title = c.summary;
      if (c.id === chatId) tdT.textContent += '  ◉';

      const tdI = document.createElement('td');
      tdI.textContent = c.n + ' msg · ' + fmtAge(c.updated)
        + (c.summary ? ((c.summary_upto || 0) < c.n ? ' · briefing stale' : ' · briefed') : '');

      const tdP = document.createElement('td');
      const ps = document.createElement('select');
      ps.append(new Option('— no project —', ''));
      for (const p of projects) ps.append(new Option(p.name, p.id));
      ps.value = c.project_id || '';
      ps.addEventListener('change', () =>
        api('/api/memory/assign', { id: c.id, project_id: ps.value || null }));
      tdP.appendChild(ps);

      const tdA = document.createElement('td');
      tdA.className = 'mem-actions';
      const go = document.createElement('button');
      go.textContent = 'resume';
      go.addEventListener('click', async () => {
        go.disabled = true;
        await resume(c.id, st);
        document.querySelector('[data-close="memory-modal"]').click();
      });
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '🗑';
      del.title = 'Forget this conversation';
      del.addEventListener('click', async () => {
        await api('/api/memory/delete', { id: c.id });
        if (chatId === c.id) { chatId = null; savedUpto = window.CHAT.getMessages().length; }
        render();
      });
      tdA.append(go, del);

      tr.append(tdT, tdI, tdP, tdA);
      tb.appendChild(tr);
    }
    st.textContent = chats.length
      ? chats.length + ' remembered conversation' + (chats.length === 1 ? '' : 's')
      : enabled() ? 'nothing remembered yet — chats save as you talk' : 'memory is off';
  }

  // ---- events ----------------------------------------------------------------

  $('memory-btn').addEventListener('click', () => {
    $('memory-modal').classList.remove('hidden');
    render();
  });

  $('mem-toggle').addEventListener('change', () => {
    localStorage.setItem('aeye-memory', $('mem-toggle').checked ? '1' : '');
    if (!$('mem-toggle').checked) { chatId = null; savedUpto = 0; }
    updateBadge();
    render();
  });

  $('mem-context').addEventListener('change', () =>
    localStorage.setItem('aeye-memory-project', $('mem-context').value));

  $('mem-project-add').addEventListener('click', async () => {
    const name = $('mem-project-name').value.trim();
    if (!name) return;
    const r = await api('/api/memory/project', { name });
    if (!r.ok) { $('mem-status').textContent = r.error; return; }
    $('mem-project-name').value = '';
    render();
  });
  $('mem-project-name').addEventListener('keydown',
    (e) => e.key === 'Enter' && $('mem-project-add').click());

  // ---- shared api ------------------------------------------------------------

  window.MEMORY = { enabled, autosave, contextFor, newChat };

  updateBadge();
})();
