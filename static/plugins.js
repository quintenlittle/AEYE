/* ================================================================
   AEYE -- local tool plugins.
   Drop a repo into ./plugins/<name>/ with an aeye-plugin.json manifest
   (name, trigger, command, cwd?, timeout?). Start a chat message with a
   plugin's TRIGGER and the rest of the line is handed to the tool; its
   stdout/stderr streams back into chat.

   Safety boundary: a plugin runs ONLY from an explicit composer submit
   (chat.js calls match() there). Model replies, memory briefings and
   document context are never scanned for triggers -- a model can't emit
   a phrase that runs a local command. The user's query is passed to the
   tool as one argv item server-side (no shell), so it can't inject args
   or a second command.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // respect the chat auto-scroll toggle (Settings > Display). When off, streamed
  // plugin output (e.g. an RSS feed) must NOT yank the view to the bottom.
  const autoscrollOn = () => localStorage.getItem('aeye-autoscroll') !== '0';

  let plugins = [];          // last /api/plugins/list result
  let loaded = false;

  async function load(force) {
    if (loaded && !force) return plugins;
    try {
      const data = await (await fetch('/api/plugins/list')).json();
      plugins = data.plugins || [];
      loaded = true;
    } catch { plugins = []; }
    return plugins;
  }

  // ---- trigger matching (called by chat.js on explicit submit only) --------

  // A message fires a plugin when it starts with the plugin's trigger AND the
  // next char is a boundary (end / space / colon), so "echoes" won't match
  // trigger "echo". Longest trigger wins when several could match.
  function match(text) {
    const t = (text || '').trim();
    const low = t.toLowerCase();
    let best = null;
    for (const p of plugins) {
      if (!p.trigger || p.error) continue;
      const trig = p.trigger.toLowerCase();
      if (!low.startsWith(trig)) continue;
      const after = t.slice(p.trigger.length);
      if (after !== '' && !/^[\s:]/.test(after)) continue;   // boundary required
      if (!best || p.trigger.length > best.plugin.trigger.length) {
        best = { plugin: p, query: after.replace(/^[\s:]+/, '').trim() };
      }
    }
    return best;
  }

  // ---- run: dispatch on the plugin's mode ----------------------------------

  async function run(plugin, query, commandText) {
    if (!window.CHAT) return;
    const cmd = commandText || plugin.trigger;
    if (plugin.mode === 'terminal') return runTerminal(plugin, query, cmd);
    if (plugin.mode === 'interactive') return startSession(plugin, query, cmd);
    return runStream(plugin, query, cmd);              // default: stream output
  }

  // stream mode: run to completion, stdout/stderr into one bubble
  async function runStream(plugin, query, commandText) {
    if (!CHAT.pluginExec) return;
    await CHAT.pluginExec(commandText, async (out) => {
      const res = await fetch('/api/plugins/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: plugin.id, query }),
      });
      let acc = '';
      const append = (s) => {
        acc += (acc ? '\n' : '') + s;
        out.body.textContent = acc;
        if (autoscrollOn()) out.div.scrollIntoView({ block: 'end' });
      };
      for await (const ev of CHAT.sse(res)) {
        if (ev.error) throw new Error(ev.error);       // chat.js appends [error]
        // ev.status is the echoed argv ("$ node plugin.js …") -- internal chrome
        // the user's own command bubble already shows; keep it out of the output.
        if (ev.line !== undefined) append(ev.line);
        // only surface the exit code when it signals a failure; a clean [exit 0]
        // is noise that clutters otherwise-tidy tool output.
        if (ev.done) { if (ev.code) append('\n[exit ' + ev.code + ']'); break; }
      }
      if (!acc) out.body.textContent = '(no output)';
      // now that output is complete, make any URLs in it clickable (once at the
      // end -- never mid-stream, so a URL is never half-formed)
      else if (CHAT.linkify) CHAT.linkify(out.body, acc);
    });
  }

  // terminal mode: launch the tool in its own real console window
  async function runTerminal(plugin, query, commandText) {
    if (!CHAT.pluginExec) return;
    await CHAT.pluginExec(commandText, async (out) => {
      const r = await (await fetch('/api/plugins/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: plugin.id, query }),
      })).json();
      if (!r.ok) throw new Error(r.error);
      out.body.textContent = '↗ launched in a new console window\n$ ' + r.command
        + '\n(this tool is interactive — operate it in that window; its output '
        + 'stays there, not in chat)';
    });
  }

  // ---- interactive mode: a live stdin/stdout session in the chat -----------

  let session = null;                    // { sid, plugin, bubble, acc }
  const origPlaceholder = () => document.getElementById('input').getAttribute('data-ph') || '';

  function sessionActive() { return !!session; }

  function appendSession(text) {
    if (!session) return;
    session.acc += text;
    session.bubble.body.textContent = session.acc;
    if (autoscrollOn()) session.bubble.div.scrollIntoView({ block: 'end' });
  }

  async function startSession(plugin, query, commandText) {
    if (session) return;                 // one interactive session at a time
    if (CHAT.isBusy && CHAT.isBusy()) return;
    CHAT.pluginBubble('user', commandText);
    const bub = CHAT.pluginBubble('assistant', '');
    bub.div.classList.add('streaming');
    let r;
    try {
      r = await (await fetch('/api/plugins/interactive/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: plugin.id, query }),
      })).json();
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
      bub.div.classList.remove('streaming');
      bub.div.classList.add('error');
      bub.body.textContent = '[error] ' + r.error;
      return;
    }
    session = { sid: r.session, plugin, bubble: bub, acc: '$ ' + r.command + '\n' };
    bub.body.textContent = session.acc;
    enterSessionUI(plugin);
    if (window.EYE) EYE.setState('streaming');
    streamSession(session.sid);          // background; not awaited
  }

  async function streamSession(sid) {
    try {
      const res = await fetch('/api/plugins/interactive/stream?session='
        + encodeURIComponent(sid));
      for await (const ev of CHAT.sse(res)) {
        if (!session || session.sid !== sid) break;
        if (ev.error) { appendSession('\n[error] ' + ev.error); break; }
        if (ev.out !== undefined) appendSession(ev.out);
        if (ev.done) { appendSession('\n[exit ' + ev.code + ']'); break; }
      }
    } catch (e) {
      if (session && session.sid === sid) appendSession('\n[stream error] ' + e.message);
    }
    if (session && session.sid === sid) endSession();
  }

  async function sessionInput(line) {
    if (!session) return;
    const sid = session.sid;
    if (line.trim() === '/exit' || line.trim() === '/stop') {
      appendSession('» ' + line + '\n');
      try {
        await fetch('/api/plugins/interactive/stop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sid }),
        });
      } catch { /* ending anyway */ }
      endSession();
      return;
    }
    appendSession('» ' + line + '\n');
    try {
      const r = await (await fetch('/api/plugins/interactive/input', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sid, text: line }),
      })).json();
      if (!r.ok) appendSession('[input error] ' + r.error + '\n');
    } catch (e) { appendSession('[input error] ' + e.message + '\n'); }
  }

  function enterSessionUI(plugin) {
    const inp = document.getElementById('input');
    if (!inp.getAttribute('data-ph')) inp.setAttribute('data-ph', inp.placeholder || '');
    inp.classList.add('plugin-session');
    inp.placeholder = '→ ' + plugin.name + ' — type input, /exit to end';
  }

  function endSession() {
    if (session) session.bubble.div.classList.remove('streaming');
    session = null;
    const inp = document.getElementById('input');
    inp.classList.remove('plugin-session');
    inp.placeholder = origPlaceholder();
    if (window.EYE) EYE.setState('idle');
  }

  // a session must not outlive the page / a chat reset
  window.addEventListener('pagehide', () => {
    if (session) {
      navigator.sendBeacon('/api/plugins/interactive/stop',
        new Blob([JSON.stringify({ session: session.sid })], { type: 'application/json' }));
    }
  });

  // ---- install dependencies (isolated per-plugin venv) ---------------------

  let installing = false;

  async function installDeps(plugin, btn) {
    if (installing) return;
    installing = true;
    const log = $('plug-log');
    const st = $('plug-status');
    log.classList.remove('hidden');
    log.textContent = '';
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'installing…';
    st.textContent = 'installing dependencies for "' + plugin.name + '"…';
    const append = (s) => {
      log.textContent += (log.textContent ? '\n' : '') + s;
      log.scrollTop = log.scrollHeight;
    };
    let failed = null;
    try {
      const res = await fetch('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: plugin.id }),
      });
      for await (const ev of window.CHAT.sse(res)) {
        if (ev.error) { append('⚠ ' + ev.error); failed = ev.error; break; }
        if (ev.status) append(ev.status);
        if (ev.line !== undefined) append(ev.line);
        if (ev.done) {
          append('\n[pip exited ' + ev.code + ']');
          if (ev.code !== 0) failed = 'pip exited ' + ev.code;
          break;
        }
      }
    } catch (e) { append('⚠ ' + e.message); failed = e.message; }
    installing = false;
    btn.disabled = false;
    btn.textContent = label;
    st.textContent = failed
      ? 'install failed — see the log below'
      : 'dependencies installed for "' + plugin.name + '"';
    if (!failed) render();       // refresh the ✓ / installed state
  }

  // ---- clone from GitHub ---------------------------------------------------

  let cloning = false;

  async function clone() {
    if (cloning) return;
    const url = $('plug-url').value.trim();
    if (!url) return;
    cloning = true;
    const btn = $('plug-clone');
    const log = $('plug-log');
    const st = $('plug-status');
    btn.disabled = true;
    btn.textContent = 'cloning…';
    log.classList.remove('hidden');
    log.textContent = '';
    st.textContent = 'cloning ' + url + '…';
    const append = (s) => { log.textContent += (log.textContent ? '\n' : '') + s; log.scrollTop = log.scrollHeight; };
    let newId = null, scaffolded = false, failed = null;
    try {
      const res = await fetch('/api/plugins/clone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      for await (const ev of window.CHAT.sse(res)) {
        if (ev.error) { append('⚠ ' + ev.error); failed = ev.error; break; }
        if (ev.status) append(ev.status);
        if (ev.line !== undefined) append(ev.line);
        if (ev.done) { newId = ev.id; scaffolded = ev.scaffolded; append('\n[cloned as plugins/' + ev.id + ']'); break; }
      }
    } catch (e) { append('⚠ ' + e.message); failed = e.message; }
    cloning = false;
    btn.disabled = false;
    btn.textContent = 'clone';
    if (failed) { st.textContent = 'clone failed — see the log'; return; }
    $('plug-url').value = '';
    st.textContent = 'cloned "' + newId + '"';
    await render();
    // seamless: if we scaffolded a manifest, open it so the command/trigger
    // can be set right away
    if (scaffolded && newId) openEditor(newId);
  }

  // ---- new plugin (write code + manifest from scratch) ---------------------

  const LANG = {
    node: {
      file: 'plugin.js',
      cmd: 'node plugin.js {query}',
      code: "'use strict';\n"
        + '// AEYE plugin. Text after your trigger arrives as the args below;\n'
        + '// whatever you print to stdout is shown in chat.\n'
        + "const query = process.argv.slice(2).join(' ');\n"
        + "console.log('hello from ' + (query || 'the plugin'));\n",
    },
    python: {
      file: 'plugin.py',
      cmd: 'python plugin.py {query}',
      code: 'import sys\n'
        + '# AEYE plugin. Text after your trigger arrives as sys.argv[1:];\n'
        + '# whatever you print is shown in chat.\n'
        + 'query = " ".join(sys.argv[1:])\n'
        + 'print("hello from", query or "the plugin")\n',
    },
    custom: { file: '', cmd: '', code: '' },
  };
  const isTemplateCode = (v) => Object.values(LANG).some((l) => l.code === v);

  function applyLang() {
    const t = LANG[$('pn-lang').value] || LANG.custom;
    $('pn-file').value = t.file;
    $('pn-cmd').value = t.cmd;
    const code = $('pn-code');
    if (!code.value.trim() || isTemplateCode(code.value)) code.value = t.code;
  }

  function showNewForm() {
    closeEditor();
    $('pn-name').value = ''; $('pn-trigger').value = '';
    $('pn-lang').value = 'node'; $('pn-mode').value = 'stream';
    $('pn-code').value = '';
    applyLang();
    $('pn-status').textContent = '';
    const box = $('plug-new-form');
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
    $('pn-name').focus();
  }

  async function createPlugin() {
    const st = $('pn-status');
    const name = $('pn-name').value.trim();
    const trigger = $('pn-trigger').value.trim();
    if (!name) { st.textContent = 'name required'; return; }
    if (!trigger) { st.textContent = 'trigger required'; return; }
    const filename = $('pn-file').value.trim() || 'plugin.txt';
    const command = $('pn-cmd').value.trim().split(/\s+/).filter(Boolean);
    st.textContent = 'creating…';
    let r;
    try {
      r = await (await fetch('/api/plugins/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, trigger, filename, command,
          mode: $('pn-mode').value, code: $('pn-code').value }),
      })).json();
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) { st.textContent = r.error; return; }
    $('plug-new-form').classList.add('hidden');
    await render();
    openEditor(r.id, r.filename, true);      // jump straight into the new code
  }

  // ---- editor (manifest OR any code file in the plugin) --------------------

  let editingId = null;
  let editingFile = null;

  async function openEditor(id, preferFile, preferCode) {
    editingId = id;
    const box = $('plug-editor');
    $('plug-editor-id').textContent = id;
    $('plug-editor-status').textContent = '';
    $('plug-new-form').classList.add('hidden');
    box.classList.remove('hidden');
    box.scrollIntoView({ block: 'nearest' });
    // populate the file dropdown (manifest + every file in the plugin)
    const sel = $('plug-editor-file');
    let files = ['aeye-plugin.json'];
    try {
      const r = await (await fetch('/api/plugins/files?id=' + encodeURIComponent(id))).json();
      if (r.ok && r.files) files = Array.from(new Set(['aeye-plugin.json', ...r.files]));
    } catch { /* manifest only */ }
    sel.innerHTML = '';
    for (const f of files) {
      const o = document.createElement('option');
      o.value = f; o.textContent = f; sel.appendChild(o);
    }
    let target = 'aeye-plugin.json';
    if (preferFile && files.includes(preferFile)) target = preferFile;
    else if (preferCode) target = files.find((f) => f !== 'aeye-plugin.json') || 'aeye-plugin.json';
    sel.value = target;
    await loadFile(target);
  }

  async function loadFile(name) {
    editingFile = name;
    const ta = $('plug-editor-text');
    ta.value = 'loading…';
    const q = 'id=' + encodeURIComponent(editingId);
    try {
      const url = name === 'aeye-plugin.json'
        ? '/api/plugins/manifest?' + q
        : '/api/plugins/file?' + q + '&name=' + encodeURIComponent(name);
      const r = await (await fetch(url)).json();
      ta.value = r.ok ? (r.content || '') : ('# ' + r.error);
    } catch (e) { ta.value = '# ' + e.message; }
  }

  function closeEditor() {
    editingId = null;
    $('plug-editor').classList.add('hidden');
  }

  async function saveEditor() {
    if (!editingId) return;
    const st = $('plug-editor-status');
    st.textContent = 'saving…';
    const content = $('plug-editor-text').value;
    const manifest = editingFile === 'aeye-plugin.json';
    let r;
    try {
      r = await (await fetch(manifest ? '/api/plugins/manifest' : '/api/plugins/file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest
          ? { id: editingId, content }
          : { id: editingId, name: editingFile, content }),
      })).json();
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) { st.textContent = r.error; return; }
    st.textContent = 'saved';
    // a manifest change alters triggers/rows; code changes take effect next run
    render();
  }

  // the entry code file for a plugin (from its command), for the "code" button
  function entryFile(p) {
    for (const a of (p.command || []).slice(1)) {
      if (a && a !== '{query}' && !a.startsWith('-') && /\.\w+$/.test(a)) {
        return a.split(/[\\/]/).pop();
      }
    }
    return null;
  }

  // ---- remove a plugin (delete its folder) ---------------------------------

  async function removePlugin(plugin, btn) {
    btn.disabled = true;
    btn.textContent = 'removing…';
    const st = $('plug-status');
    let r;
    try {
      r = await (await fetch('/api/plugins/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: plugin.id }),
      })).json();
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = '🗑';
      btn.classList.remove('armed');
      st.textContent = 'could not remove "' + plugin.name + '": ' + r.error;
      return;
    }
    st.textContent = 'removed "' + plugin.name + '"';
    render();                          // reloads the list -> trigger cache too
  }

  // ---- manage tab ui -------------------------------------------------------

  async function render() {
    const st = $('plug-status');
    const tb = $('plug-body');
    tb.innerHTML = '';
    let list;
    try { list = await load(true); } catch { st.textContent = 'server unreachable'; return; }

    for (const p of list) {
      const tr = document.createElement('tr');

      const tdN = document.createElement('td');
      tdN.className = 'mem-title';
      tdN.textContent = p.name;
      if (p.description) tdN.title = p.description;

      const tdT = document.createElement('td');
      if (p.error) {
        tdT.className = 'docs-err';
        tdT.textContent = p.error;
        tdT.title = p.error;
      } else {
        const code = document.createElement('code');
        code.textContent = p.trigger;
        tdT.appendChild(code);
        if (p.mode && p.mode !== 'stream') {
          const tag = document.createElement('span');
          tag.className = 'plug-mode';
          tag.textContent = p.mode;
          tag.title = p.mode === 'terminal'
            ? 'opens in its own console window'
            : 'interactive session inside the chat';
          tdT.appendChild(tag);
        }
      }

      const tdC = document.createElement('td');
      tdC.className = 'plug-cmd';
      tdC.textContent = (p.command || []).join(' ');
      tdC.title = tdC.textContent;

      const tdS = document.createElement('td');
      tdS.className = 'plug-setup';
      if (p.requirements) {
        const btn = document.createElement('button');
        btn.textContent = p.installed ? 'reinstall deps' : 'install deps';
        btn.title = 'Create an isolated .venv for this plugin and pip install '
          + p.requirements;
        btn.addEventListener('click', () => installDeps(p, btn));
        tdS.appendChild(btn);
        if (p.installed) {
          const ok = document.createElement('span');
          ok.className = 'plug-ok';
          ok.textContent = ' ✓';
          ok.title = 'dependencies installed';
          tdS.appendChild(ok);
        }
      } else {
        const none = document.createElement('span');
        none.className = 'plug-nodeps';
        none.textContent = 'no deps';
        none.title = 'no requirements.txt — nothing to install';
        tdS.appendChild(none);
      }

      // edit the manifest inline
      const edit = document.createElement('button');
      edit.className = 'plug-edit';
      edit.textContent = 'edit';
      edit.title = 'Edit this plugin\'s aeye-plugin.json (or pick a file in the editor)';
      edit.addEventListener('click', () => openEditor(p.id));
      tdS.appendChild(edit);

      // edit the plugin's code file straight away
      const codeBtn = document.createElement('button');
      codeBtn.className = 'plug-edit';
      codeBtn.textContent = 'code';
      codeBtn.title = 'Edit this plugin\'s code';
      codeBtn.addEventListener('click', () => openEditor(p.id, entryFile(p), true));
      tdS.appendChild(codeBtn);

      // trashcan: fully remove the plugin (folder + .venv). Two-click confirm
      // so a misclick can't nuke a tool -- no reliance on a webview dialog.
      const trash = document.createElement('button');
      trash.className = 'danger plug-trash';
      trash.textContent = '🗑';
      trash.title = 'Remove this plugin — deletes the plugins/' + p.id
        + ' folder and its .venv';
      let armed = false, armT = null;
      trash.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          trash.textContent = 'sure?';
          trash.classList.add('armed');
          armT = setTimeout(() => {
            armed = false; trash.textContent = '🗑'; trash.classList.remove('armed');
          }, 3000);
          return;
        }
        clearTimeout(armT);
        removePlugin(p, trash);
      });
      tdS.appendChild(trash);

      tr.append(tdN, tdT, tdC, tdS);
      tb.appendChild(tr);
    }

    const ok = list.filter((p) => !p.error).length;
    st.textContent = list.length
      ? ok + ' plugin' + (ok === 1 ? '' : 's') + ' ready'
        + (ok < list.length ? ' · ' + (list.length - ok) + ' with errors' : '')
      : 'no plugins — drop a repo + aeye-plugin.json into the plugins/ folder';
  }

  // ---- events --------------------------------------------------------------

  // render when the plugins tab is opened
  document.querySelector('[data-tab="tab-plugins"]')
    .addEventListener('click', render);
  $('plug-rescan').addEventListener('click', render);
  $('plug-clone').addEventListener('click', clone);
  $('plug-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clone(); }
  });
  $('plug-editor-save').addEventListener('click', saveEditor);
  $('plug-editor-cancel').addEventListener('click', closeEditor);
  // new-plugin form
  $('plug-new').addEventListener('click', showNewForm);
  $('pn-lang').addEventListener('change', applyLang);
  $('pn-create').addEventListener('click', createPlugin);
  $('pn-cancel').addEventListener('click', () => $('plug-new-form').classList.add('hidden'));
  $('plug-editor-file').addEventListener('change', (e) => loadFile(e.target.value));

  // ---- LLM tool access (agentic) config ------------------------------------
  // The TOOLS module (tools.js) owns the state + backend sync; this just wires
  // the Manage>Plugins controls to it and reflects the resolved workspace root.
  async function loadToolCfg() {
    if (!window.TOOLS) return;
    const { cfg } = await TOOLS.refresh();
    if ($('tool-enabled')) $('tool-enabled').checked = !!cfg.enabled;
    if ($('tool-mode')) $('tool-mode').value = cfg.mode || 'read';
    if ($('tool-approval')) $('tool-approval').value = cfg.approval || 'auto';
    if ($('tool-dryrun')) $('tool-dryrun').checked = !!cfg.dry_run;
    if ($('tool-forceagent')) $('tool-forceagent').checked = !!cfg.force_agent;
    if ($('tool-root') && document.activeElement !== $('tool-root'))
      $('tool-root').value = cfg.root || '';
  }
  const setToolStatus = (m, err) => {
    const e = $('tool-status'); if (e) { e.textContent = m || ''; e.className = 'mini-status' + (err ? ' err' : ''); }
  };
  async function pushToolCfg(patch, msg) {
    if (!window.TOOLS) return;
    try { await TOOLS.setConfig(patch); setToolStatus(msg || 'saved'); await loadToolCfg(); }
    catch { setToolStatus('failed', true); }
  }
  if ($('tool-enabled'))
    $('tool-enabled').addEventListener('change', (e) =>
      pushToolCfg({ enabled: e.target.checked }, e.target.checked ? 'tool access ON' : 'tool access off'));
  if ($('tool-mode'))
    $('tool-mode').addEventListener('change', (e) => pushToolCfg({ mode: e.target.value }, 'mode: ' + e.target.value));
  if ($('tool-approval'))
    $('tool-approval').addEventListener('change', (e) => pushToolCfg({ approval: e.target.value }, 'approval: ' + e.target.value));
  if ($('tool-dryrun'))
    $('tool-dryrun').addEventListener('change', (e) => pushToolCfg({ dry_run: e.target.checked }, e.target.checked ? 'dry run ON' : 'dry run off'));
  if ($('tool-forceagent'))
    $('tool-forceagent').addEventListener('change', (e) => pushToolCfg({ force_agent: e.target.checked }, e.target.checked ? 'force agent ON' : 'force agent off'));
  // Performance-test profile: reversible startup defaults (tickers/eye/model).
  // "Restore Normal Defaults" turns the profile OFF without touching the user's
  // own saved preferences; a reload then applies normal app defaults.
  (function perfProfileUI() {
    const st = $('perf-state'), btn = $('perf-restore');
    if (!st || !btn) return;
    const on = () => localStorage.getItem('aeye-perf-profile') !== '0';
    const paint = () => {
      st.textContent = on() ? 'ON' : 'OFF';
      btn.textContent = on() ? 'Restore Normal Defaults' : 'Re-enable Test Profile';
    };
    paint();
    btn.addEventListener('click', () => {
      localStorage.setItem('aeye-perf-profile', on() ? '0' : '1');
      paint();
      setToolStatus('profile ' + (on() ? 'ON' : 'OFF') + ' — reloading…');
      setTimeout(() => location.reload(), 500);
    });
  })();
  if ($('tool-root-save'))
    $('tool-root-save').addEventListener('click', () => pushToolCfg({ root: ($('tool-root').value || '').trim() }, 'workspace set'));
  // refresh the config panel whenever the plugins tab is opened
  document.querySelector('[data-tab="tab-plugins"]').addEventListener('click', loadToolCfg);
  loadToolCfg();

  // ---- shared api ----------------------------------------------------------

  window.PLUGINS = { match, run, reload: () => load(true), sessionActive, sessionInput };

  load();      // warm the trigger list at boot so the first message matches
})();
