/* ================================================================
   AEYE -- chat + model management.
   Streams tokens from /api/chat (SSE) into chat bubbles and drives
   the eye's mood: thinking -> streaming -> idle (or error).
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const input = $('input');
  const modelSel = $('model-select');

  const state = { messages: [], busy: false, attachments: [] };
  let lastGood = localStorage.getItem('aeye-model') || '';

  // whether we're the frozen/installed build (vs a from-source run) -- lets
  // "not installed" hints point users at the right place (the "Install AI
  // Extras" step vs install.bat). Fetched once; defaults to source wording.
  window.AEYE_FROZEN = false;
  fetch('/api/version').then((r) => r.json())
    .then((v) => { window.AEYE_FROZEN = !!v.frozen; }).catch(() => {});
  // guidance string shared by the optional-feature tabs (docs/stt/voice)
  window.extrasHint = () => (window.AEYE_FROZEN
    ? 'run "Install or Repair AI Extras" from the Start Menu'
    : 're-run install.bat');

  // preferred out-of-the-box model on a machine with no saved choice yet
  // (the installer pulls it automatically, so fresh machines can talk at once)
  const DEFAULT_MODEL = 'ollama::dolphin-mistral:latest';
  // Performance-test profile (separate, reversible; see PERF.restore). Default ON
  // for this testing build; the user's saved model/ticker/eye choices always win.
  // GGUF pulled into Ollama is named hf.co/<repo>:latest; only used if installed
  // (never auto-downloaded), and a user's saved model choice always wins.
  const PERF_MODEL = 'ollama::hf.co/empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:latest';
  const perfProfile = () => localStorage.getItem('aeye-perf-profile') !== '0';

  // ---- helpers -----------------------------------------------------------

  const autoscrollOn = () => localStorage.getItem('aeye-autoscroll') !== '0';
  // when auto-scroll is OFF, replies never yank the view to the bottom -- so long
  // output (e.g. an RSS feed) stays readable from the top
  function scrollDown() { if (autoscrollOn()) messagesEl.scrollTop = messagesEl.scrollHeight; }

  // images: array of data URLs (data:image/...;base64,XXXX)
  function bubble(role, text, images) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = role === 'user' ? 'YOU' : 'AEYE';
    div.appendChild(who);
    if (images && images.length) {
      const gallery = document.createElement('div');
      gallery.className = 'msg-images';
      for (const src of images) {
        const img = document.createElement('img');
        img.src = src;
        // click to enlarge (capped so huge images can't overflow), click again
        // to shrink back -- window.open was a dead end inside the webview
        img.addEventListener('click', () => img.classList.toggle('expanded'));
        gallery.appendChild(img);
      }
      div.appendChild(gallery);
    }
    const body = document.createElement('span');
    body.className = 'body';
    // linkify URLs in the assistant's answer (incl. resumed history); live
    // streaming starts empty and is linkified once when it finishes (see send()).
    if (role === 'assistant' && text) linkify(body, text);
    else body.textContent = text || '';
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollDown();

    // lazily-created reasoning panel for models that stream a 'thinking' field
    let thinkWrap = null, thinkBody = null;
    function addThinking(t) {
      if (!thinkWrap) {
        thinkWrap = document.createElement('details');
        thinkWrap.className = 'think';
        thinkWrap.open = true;                 // visible while it reasons
        const sum = document.createElement('summary');
        sum.textContent = '💭 reasoning';
        thinkWrap.appendChild(sum);
        thinkBody = document.createElement('div');
        thinkBody.className = 'think-body';
        thinkWrap.appendChild(thinkBody);
        div.insertBefore(thinkWrap, body);     // above the answer
      }
      thinkBody.textContent += t;
      scrollDown();
    }
    function collapseThink() { if (thinkWrap) thinkWrap.open = false; }

    return { div, body, addThinking, collapseThink };
  }

  function note(text, isErr) {
    const div = document.createElement('div');
    div.className = 'msg note' + (isErr ? ' error' : '');
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollDown();
  }

  // open a URL in the system browser (the webview has no tabs). http/https only,
  // re-validated server-side; the click is always user-initiated.
  function openExternal(url) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).catch(() => { /* noop */ });
  }

  const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

  // populate `el` with `text`, turning any http(s) URL into a clickable link
  // (opens in the system browser). Trailing sentence punctuation and unbalanced
  // brackets are kept out of the href. stopPropagation so a link inside a
  // <summary> opens the page instead of toggling the disclosure.
  function linkify(el, text) {
    el.textContent = '';
    let last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text || ''))) {
      let url = m[0], tail = '';
      for (;;) {                              // peel trailing punctuation off the href
        const c = url[url.length - 1];
        if ('.,;:!?'.includes(c)) { tail = c + tail; url = url.slice(0, -1); continue; }
        if (c === ')' || c === ']') {
          const open = c === ')' ? '(' : '[';
          const nO = url.split(open).length - 1, nC = url.split(c).length - 1;
          if (nC > nO) { tail = c + tail; url = url.slice(0, -1); continue; }
        }
        break;
      }
      if (!url) { last = m.index; break; }
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.className = 'chip-link';
      a.href = url;
      a.title = url;
      a.textContent = url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openExternal(url);
      });
      el.appendChild(a);
      if (tail) el.appendChild(document.createTextNode(tail));
      last = m.index + m[0].length;
    }
    if (last < (text || '').length) el.appendChild(document.createTextNode(text.slice(last)));
  }

  // collapsed activity chip for a web tool-call (reuses the .think panel look).
  // Keeps the model's raw tool-call JSON out of the transcript: the label shows
  // what was searched/fetched, expanding reveals the raw results. URLs in both
  // the label and the body are clickable. Returns a setter for the results.
  function webChip(container, label, initial) {
    const d = document.createElement('details');
    d.className = 'think web';
    const s = document.createElement('summary');
    linkify(s, label);
    d.appendChild(s);
    const b = document.createElement('div');
    b.className = 'think-body';
    linkify(b, initial || '');
    d.appendChild(b);
    container.appendChild(d);
    scrollDown();
    return (txt) => { linkify(b, txt); scrollDown(); };
  }

  // an in-chat question card with clickable options (like Claude asking how to
  // proceed). Renders in the transcript and resolves to the chosen option's
  // value on click; buttons lock in the choice. Used when a web reply looks
  // fabricated and we want the user to pick the recovery path.
  function chatQuestion(promptText, options) {
    return new Promise((resolve) => {
      const div = document.createElement('div');
      div.className = 'msg question';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = 'AEYE';
      div.appendChild(who);
      const q = document.createElement('div');
      q.className = 'q-text';
      q.textContent = promptText;
      div.appendChild(q);
      const row = document.createElement('div');
      row.className = 'q-options';
      let done = false;
      options.forEach((opt, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-opt' + (i === 0 ? ' primary' : '');
        b.textContent = opt.label;
        b.addEventListener('click', () => {
          if (done) return;
          done = true;
          [...row.children].forEach((c) => { c.disabled = true; });
          b.classList.add('chosen');
          resolve(opt.value);
        });
        row.appendChild(b);
      });
      div.appendChild(row);
      messagesEl.appendChild(div);
      scrollDown();
    });
  }

  // "Sources" footer under a web-assisted answer: the pages the reply drew on,
  // deduped, as clickable links. The desktop webview has no tabs, so a click
  // opens the URL in the system browser via /api/open (works in-browser too --
  // server == client on a local app). http/https only, validated server-side.
  function sourcesFooter(container, sources) {
    const seen = new Set(), items = [];
    for (const s of sources || []) {
      if (!s || !s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      items.push(s);
      if (items.length >= 6) break;
    }
    if (!items.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'sources';
    const lab = document.createElement('div');
    lab.className = 'sources-label';
    lab.textContent = 'Sources';
    wrap.appendChild(lab);
    items.forEach((s, i) => {
      let host = s.url;
      try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* noop */ }
      const a = document.createElement('a');
      a.className = 'source-link';
      a.href = s.url;
      a.title = s.url;
      const label = (s.title && s.title !== s.url) ? s.title : host;
      a.textContent = '[' + (i + 1) + '] ' + label + '  —  ' + host;
      a.addEventListener('click', (e) => { e.preventDefault(); openExternal(s.url); });
      wrap.appendChild(a);
    });
    container.appendChild(wrap);
    scrollDown();
  }

  async function* sse(res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) yield JSON.parse(line.slice(6));
        }
      }
    }
  }

  // ---- model list --------------------------------------------------------

  let hfPoll = null;
  // true only while a load the USER asked for is in flight -- the startup
  // auto-reload must never steal the model selection when it finishes
  let hfLoadRequested = false;

  async function refreshModels() {
    let data;
    try {
      data = await (await fetch('/api/models')).json();
    } catch {
      $('ollama-badge').textContent = 'server: offline';
      $('ollama-badge').className = 'badge err';
      return;
    }

    const prev = modelSel.value || localStorage.getItem('aeye-model') || '';
    modelSel.innerHTML = '';

    const ogOllama = document.createElement('optgroup');
    ogOllama.label = 'Ollama';
    for (const name of data.ollama) {
      const o = document.createElement('option');
      o.value = 'ollama::' + name;
      o.textContent = name;
      ogOllama.appendChild(o);
    }
    if (data.ollama.length) modelSel.appendChild(ogOllama);

    const hf = data.hf || {};
    if (hf.state === 'ready' || hf.state === 'loading') {
      // list the model while it's still warming up too, so the last-used
      // selection can point at it from the very first poll after a restart
      const og = document.createElement('optgroup');
      og.label = 'HuggingFace';
      const o = document.createElement('option');
      o.value = 'hf::' + hf.model_id;
      o.textContent = hf.state === 'loading'
        ? hf.model_id + ' (loading…)'
        : hf.model_id + ' [' + (hf.device || '?') + ']';
      og.appendChild(o);
      modelSel.appendChild(og);
    }
    if (!modelSel.options.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '-- no models: pull or load one below --';
      modelSel.appendChild(o);
    }

    // suggested pulls that fit this machine (from the hardware-scanned catalog)
    const cat = window.CATALOG;
    if (cat && data.ollama_online) {
      const installed = new Set(data.ollama);
      const has = (tag) => installed.has(tag) || installed.has(tag + ':latest');
      // uncensored/abliterated first, then the mistral/dolphin family
      const rank = (m) => m.cat === 'uncensored' ? 0
        : /mistral|mixtral|dolphin|heretic|abliterat/i.test(m.name) ? 1 : 2;
      const sug = cat.models.filter(
        (m) => m.pop && m.ollama && m.fit !== 'no' && !has(m.ollama))
        .sort((a, b) => rank(a) - rank(b)).slice(0, 8);
      if (sug.length) {
        const og = document.createElement('optgroup');
        og.label = '── suggested for your hardware (select to pull)';
        for (const m of sug) {
          const o = document.createElement('option');
          o.value = 'suggest::' + m.ollama;
          o.textContent = '⤓ ' + m.name + '  (' + m.size_gb + ' GB, '
            + (m.fit === 'gpu' ? 'GPU' : 'CPU') + ')';
          og.appendChild(o);
        }
        modelSel.appendChild(og);
      }
    }

    const stored = localStorage.getItem('aeye-model') || '';
    const usable = (v) => v && !v.startsWith('suggest::')
      && [...modelSel.options].some((o) => o.value === v);
    // the last model actually used wins -- every pick/pull/load saves it, and
    // it survives restarts. Fall back to the pre-rebuild selection, then the
    // house default (if installed), then the auto-reloaded HF model.
    if (usable(stored)) modelSel.value = stored;
    else if (usable(prev)) modelSel.value = prev;
    else if (perfProfile() && usable(PERF_MODEL)) modelSel.value = PERF_MODEL;  // perf-test default (if installed)
    else if (usable(DEFAULT_MODEL)) modelSel.value = DEFAULT_MODEL;
    else if (!stored && (hf.state === 'ready' || hf.state === 'loading'))
      modelSel.value = 'hf::' + hf.model_id;

    // badges
    const ob = $('ollama-badge');
    ob.textContent = data.ollama_online
      ? 'ollama: ' + data.ollama.length + ' model' + (data.ollama.length === 1 ? '' : 's')
      : 'ollama: offline';
    ob.className = 'badge ' + (data.ollama_online ? 'on' : 'err');

    const hb = $('hf-badge');
    const hs = $('hf-status');
    if (!hf.available) {
      hb.textContent = 'hf: not installed';
      hb.className = 'badge';
    } else if (hf.state === 'loading') {
      hb.textContent = 'hf: loading ' + Math.round(hf.elapsed || 0) + 's';
      hb.className = 'badge on';
      hs.textContent = 'loading ' + hf.model_id + '... (' + Math.round(hf.elapsed || 0) + 's — first load downloads weights)';
      hs.className = 'mini-status';
      if (!state.busy) EYE.setState('loading');
    } else if (hf.state === 'ready') {
      hb.textContent = 'hf: ' + hf.model_id.split('/').pop();
      hb.className = 'badge on';
      hs.textContent = 'ready on ' + hf.device;
      hs.className = 'mini-status';
    } else if (hf.state === 'error') {
      hb.textContent = 'hf: error';
      hb.className = 'badge err';
      hb.title = hf.error || 'load failed';
      hs.textContent = hf.error || 'load failed';
      hs.className = 'mini-status err';
    } else {
      hb.textContent = 'hf: idle';
      hb.className = 'badge';
      hs.textContent = '';
    }

    // image-generation pipeline badge
    const img = data.img || {};
    const ib = $('img-badge');
    if (!img.available) {
      ib.textContent = 'img: n/a';
      ib.className = 'badge';
      ib.title = 'install HuggingFace support to enable image generation';
    } else if (img.state === 'loading') {
      ib.textContent = 'img: loading ' + Math.round(img.elapsed || 0) + 's';
      ib.className = 'badge on';
    } else if (img.state === 'ready') {
      ib.textContent = 'img: ' + img.model_id.split('/').pop();
      ib.className = 'badge on';
    } else if (img.state === 'busy') {
      ib.textContent = 'img: rendering…';
      ib.className = 'badge on';
    } else if (img.state === 'error') {
      ib.textContent = 'img: error';
      ib.className = 'badge err';
      ib.title = img.error || '';
    } else {
      ib.textContent = 'img: idle';
      ib.className = 'badge';
    }
    window.IMG_STATE = img;
    if (window.IMAGINE) window.IMAGINE.onStatus(img);

    // video-generation pipeline badge
    const vid = data.vid || {};
    const vb = $('vid-badge');
    if (!vid.available) {
      vb.textContent = 'vid: n/a';
      vb.className = 'badge';
      vb.title = 'install HuggingFace support to enable video generation';
    } else if (vid.state === 'loading') {
      vb.textContent = 'vid: loading ' + Math.round(vid.elapsed || 0) + 's';
      vb.className = 'badge on';
    } else if (vid.state === 'ready') {
      vb.textContent = 'vid: ' + vid.model_id.split('/').pop();
      vb.className = 'badge on';
    } else if (vid.state === 'busy') {
      vb.textContent = 'vid: dreaming…';
      vb.className = 'badge on';
    } else if (vid.state === 'error') {
      vb.textContent = 'vid: error';
      vb.className = 'badge err';
      vb.title = vid.error || '';
    } else {
      vb.textContent = 'vid: idle';
      vb.className = 'badge';
    }
    window.VID_STATE = vid;
    if (window.DREAM) window.DREAM.onStatus(vid);

    // keep polling while a HF, image, or video load is in flight; settle after
    const loading = hf.state === 'loading' || img.state === 'loading'
      || vid.state === 'loading';
    if (loading && !hfPoll) {
      hfPoll = setInterval(refreshModels, 2500);
    } else if (!loading && hfPoll) {
      clearInterval(hfPoll);
      hfPoll = null;
      if (!state.busy) EYE.setState(hf.state === 'error' ? 'error' : 'idle');
      if (hf.state === 'error') setTimeout(() => !state.busy && EYE.setState('idle'), 4000);
      if (hf.state === 'ready' && hfLoadRequested && !modelSel.value.startsWith('hf::')) {
        modelSel.value = 'hf::' + hf.model_id;
        modelSel.dispatchEvent(new Event('change'));
        note('HuggingFace model ready: ' + hf.model_id);
      }
      hfLoadRequested = false;   // the in-flight load (if any) has settled
    }
  }

  // ---- chat --------------------------------------------------------------

  // max web tool-call round-trips per user turn before we force a final answer
  const MAX_WEB_ROUNDS = 3;
  // hard cap on tool calls per user turn (loop-control -- prevents runaway)
  const MAX_TOOL_CALLS = 5;

  // stream one /api/chat call into `out`, returning the accumulated reply text.
  // voiceMode controls live TTS, which tracks the typewriter token-by-token:
  //   'live'    -> speak every token (web off: the reply is always a real answer)
  //   'guarded' -> speak live too, but never raw tool-call JSON or a faked
  //                "[WEB RESULTS]" wrapper: stay silent until the reply is
  //                confidently prose (WEB.toolish), and cut speech off if a
  //                tool/fake signal appears mid-reply. Genuine tool calls open
  //                with { / a fence / XML, so they're caught before any audio.
  //   'off'     -> never speak
  async function streamInto(payload, out, voiceMode) {
    let acc = '';
    let voiceDead = false;   // guarded mode latched to silent for this round
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    for await (const ev of sse(res)) {
      if (ev.error) throw new Error(ev.error);
      if (ev.thinking) { EYE.setState('thinking'); out.addThinking(ev.thinking); }
      if (ev.token) {
        if (!acc) { EYE.setState('streaming'); out.collapseThink(); }
        acc += ev.token;
        out.body.textContent = acc;
        if (window.VOICE && voiceMode !== 'off' && !voiceDead) {
          let speak = voiceMode === 'live';
          if (voiceMode === 'guarded') {
            if ((window.WEB && WEB.toolish(acc)) ||
                (window.TOOLS && TOOLS.enabled() && /^\s*[<{`]/.test(acc))) {
              // tool-call / faked wrapper -> go (and stay) silent this round;
              // cut off anything already speaking (e.g. a greeting before a fake)
              voiceDead = true;
              try { window.VOICE.stopSpeaking(); } catch { /* noop */ }
            } else if (/\S/.test(acc)) {
              speak = true;               // real prose has arrived -> safe to read
            }                             // else: only whitespace so far -> wait
          }
          if (speak && !voiceDead) { try { window.VOICE.feed(ev.token); } catch { /* noop */ } }
        }
        scrollDown();
      }
      if (ev.done) break;
    }
    return acc;
  }

  async function send(text) {
    const [backend, model] = (modelSel.value || '').split('::');
    if (!backend) { note('No model selected — pull an Ollama model or load a HF model first.', true); return; }

    state.busy = true;
    $('send').disabled = true;
    EYE.setState('thinking');

    // snapshot + clear any attached images
    const imgs = state.attachments.slice();
    state.attachments = [];
    renderAttachments();

    const userMsg = { role: 'user', content: text };
    if (imgs.length) {
      // ollama expects raw base64 (no data-URL prefix) in message.images
      userMsg.images = imgs.map((d) => d.replace(/^data:image\/[^;]+;base64,/, ''));
      if (backend !== 'ollama') {
        note('Heads-up: image input works with Ollama vision models (llava, llama3.2-vision, gemma3). The HF text backend will ignore the image.');
      }
    }
    state.messages.push(userMsg);
    bubble('user', text, imgs);

    const sys = $('system-prompt').value.trim();
    // memory briefings + document excerpts + the web tool instruction (all
    // opt-in) ride along as extra system context; never fatal
    let memCtx = '';
    if (window.MEMORY) { try { memCtx = await MEMORY.contextFor(text); } catch { /* noop */ } }
    let docCtx = '';
    if (window.DOCS) { try { docCtx = await DOCS.contextFor(text); } catch { /* noop */ } }
    let webCtx = '';
    if (window.WEB) { try { webCtx = WEB.systemPrompt(); } catch { /* noop */ } }
    // PHASE 3 -- ROUTER: pick an execution mode (SIMPLE / STANDARD / AGENT). Only
    // selects the prompt + tool registry we send; the loop enforces safety
    // regardless of this choice. Conservative: AGENT on any danger/multi signal.
    let execMode = 'simple';
    let toolCtx = '';
    if (window.TOOLS) {
      try {
        // ALWAYS refresh from the authoritative backend FIRST -- reading
        // TOOLS.enabled() before this saw stale default (enabled=false) config on
        // a fresh page load, so tools silently didn't engage until the user pressed
        // "Set". Refreshing first makes a saved workspace active with no button.
        await TOOLS.refresh();
        if (TOOLS.enabled()) {
          execMode = TOOLS.classifyMode(text);
          toolCtx = TOOLS.systemPrompt(execMode);   // '' for simple
        }
      } catch { /* noop */ }
    }
    if (window.DEBUG && DEBUG.enabled()) {
      const c = (window.TOOLS && TOOLS.config && TOOLS.config()) || {};
      const av = (window.TOOLS && TOOLS.enabled()) ? TOOLS.toolsForMode(execMode).map((t) => t.name) : [];
      DEBUG.log('agent', '[ROUTER]', { mode: execMode.toUpperCase(), tool_prompt: toolCtx ? 'yes' : 'no' });
      DEBUG.log('model', '[MODEL]', { selected: model, backend, advertised_tools: av });
      DEBUG.log('model', '[PROMPT]', { mode: execMode.toUpperCase(), system_chars: (sys ? sys.length : 0) + toolCtx.length, tool_count: av.length });
      DEBUG.log('workspace', '[WORKSPACE]', { configured_root: c.root, root_valid: c.root_valid, root_active: c.root_active });
      DEBUG.log('agent', '[AGENT CONFIG]', { enabled: c.enabled, permission: c.mode, approval: c.approval, dry_run: c.dry_run, force_agent: c.force_agent });
    }
    const sysAll = [sys, webCtx, toolCtx, docCtx, memCtx].filter(Boolean).join('\n\n');

    // the loop's working transcript: state.messages plus any tool-call rounds.
    // tool exchanges live ONLY here (not state.messages) so the visible/saved
    // transcript stays clean -- just the user turn and the final answer.
    const webOn = !!(window.WEB && WEB.enabled());
    const toolsOn = !!(window.TOOLS && TOOLS.enabled()) && execMode !== 'simple';
    const work = state.messages.slice();
    const buildPayload = () => ({
      backend, model,
      messages: sysAll ? [{ role: 'system', content: sysAll }, ...work] : work,
      temperature: parseFloat($('temp').value),
      max_tokens: parseInt($('max-tokens').value, 10) || -1,   // -1 = unlimited (default)
      num_ctx: parseInt($('num-ctx').value, 10) || 16384,
    });

    // TTS is best-effort and must never interrupt generation. resetStream stops
    // any prior speech before this reply. With web on we stream in guarded mode
    // (see streamInto): only the prose answer is read, tool-call rounds and faked
    // wrappers stay silent -- so voice tracks the typewriter here too.
    if (window.VOICE) { try { window.VOICE.resetStream(); } catch { /* noop */ } }

    let curOut = null, rounds = 0, toolCalls = 0, successfulOps = 0;
    // agent-loop stability: stop on repeated identical failures / env errors /
    // identical repeated calls
    let lastToolErr = null, sameErrCount = 0, lastCallSig = null;
    // PHASE 4/13 -- context state (internal; drives planning + progress)
    const agent = { plan: [], step: 0, planCount: 0, touched: new Set(),
                    completed: [], failed: [], lastResult: null, opsPerFile: {} };
    // PHASE 2 -- perf instrumentation (debug-only)
    const perf = { t0: performance.now(), model_ms: 0, tool_ms: 0, ctxChars: 0, planning_ms: 0 };
    // operations that must ALWAYS go through the full AGENT plan path
    const DANGEROUS = new Set(['delete_file', 'move_file', 'run_command', 'pip_install']);

    // PHASE 5 -- controller-owned STANDARD write: the model decided the content;
    // the controller runs the required preview -> hash-gate -> write -> validate
    // sequence itself (all backend-authoritative) in ONE round, no extra model
    // generations. Returns the TOOLS.run-shaped result.
    async function controllerWrite(args) {
      const path = String(args.path || '');
      const content = args.content;
      const t = performance.now();
      const dbg = window.DEBUG && DEBUG.enabled();
      // 1) preview: records the file hash + reports whether it exists (gate prep)
      const pv = await TOOLS.run({ name: 'preview_diff', args: { path, new_content: content } });
      if (dbg) DEBUG.log('agent', '[FAST PATH]', { operation: 'edit ' + path, preview: pv.ok ? 'ok' : 'fail', hash_gate: pv.ok ? 'recorded' : 'n/a' });
      if (!pv.ok) { perf.tool_ms += performance.now() - t; return pv; }
      // 2) write: the diff-gate + hash check now pass for this exact content
      const wr = await TOOLS.run({ name: 'write_file', args: { path, content } });
      perf.tool_ms += performance.now() - t;
      if (dbg) DEBUG.log('tools', '[FAST PATH] write', { path, success: wr.ok });
      if (!wr.ok) return wr;
      let extra = '';
      // 3) targeted validation (Phase 14): only the file we just changed
      if (/\.(py|js|mjs|cjs|ts|jsx)$/i.test(path)) {
        const tc = performance.now();
        const ck = await TOOLS.run({ name: 'check_code', args: { path } });
        perf.tool_ms += performance.now() - tc;
        if (dbg) DEBUG.log('tools', '[FAST PATH] validation', { path, syntax_ok: ck.ok });
        extra = ck.ok ? ' Syntax OK.' : (' Syntax check FAILED: ' + ck.error);
      }
      const output = String(wr.output || 'Write successful') + extra;
      return { ok: true, error: '',
        message: '[TOOL RESULT]\n' + JSON.stringify({ success: true, output, error: null }),
        display: output };
    }
    const stopAgent = (out, msg) => {           // safe exit: show msg, no more loops
      if (out) out.body.textContent = msg;
      state.messages.push({ role: 'assistant', content: msg });
      EYE.setState('idle');
    };
    const allSources = [];      // pages the web tools drew on -> "Sources" footer
    try {
      for (;;) {
        const out = bubble('assistant', '');
        curOut = out;
        out.div.classList.add('streaming');
        // while speaking, the eye occasionally glances down at its own words
        const glancer = setInterval(() => EYE.glance(out.div, 700), 2400);
        let acc = '';
        const _m0 = performance.now();
        try {
          acc = await streamInto(buildPayload(), out, (webOn || toolsOn) ? 'guarded' : 'live');
        } finally {
          clearInterval(glancer);
          out.div.classList.remove('streaming');
          perf.model_ms += performance.now() - _m0;   // PHASE 2: model round latency
          perf.rounds = (perf.rounds || 0) + 1;
        }

        // did the model ask for a web tool? (only when the toggle is on)
        const call = webOn ? WEB.detect(acc) : null;
        if (call && rounds < MAX_WEB_ROUNDS) {
          rounds++;
          // hide the raw tool-call JSON; show a collapsed activity chip instead
          out.body.textContent = '';
          const fill = webChip(out.div, call.label, 'running…');
          work.push({ role: 'assistant', content: acc });
          EYE.setState('refreshing',
            call.tool === 'fetch_url' ? '◉ READING THE PAGE…' : '◉ SEARCHING THE WEB…');
          let result;
          // the user's original message is the relevance signal for ranked fetch
          try { result = await WEB.run(call, text); }
          catch (e) { result = { message: '[WEB RESULTS] (tool error: ' + e.message + ')', display: e.message, sources: [] }; }
          fill(result.display);
          if (result.sources && result.sources.length) allSources.push(...result.sources);
          // feed the results back as a user-role message ([WEB RESULTS] tag) --
          // HF-safe, no dedicated tool role needed -- and loop for the answer
          work.push({ role: 'user', content: result.message });
          continue;
        }

        // guard: the model faked the results wrapper ("[WEB RESULTS] …") and
        // made the details up instead of actually searching -- don't pass that
        // off as an answer; ask the user how to proceed.
        if (webOn && WEB.looksFaked(acc)) {
          out.div.remove();                         // drop the hallucinated bubble
          EYE.setState('idle');
          const choice = await chatQuestion(
            'That answer wasn’t from a real search — the model wrote its own '
            + '“[WEB RESULTS]” and made the details up instead of looking anything '
            + 'up. Do you want to try another way?',
            [
              { value: 'search', label: '🔎 Try again — actually search the web' },
              { value: 'plain', label: '💬 Answer from what the model already knows' },
              { value: 'stop', label: '✋ Stop here' },
            ]);
          if (choice === 'stop') {
            note('Okay — stopped. Nothing was searched. Rephrase or ask again whenever you like.');
            break;                                  // no assistant message saved
          }
          EYE.setState('thinking');
          // keep the mistake in the loop's context, then correct it and retry
          work.push({ role: 'assistant', content: acc });
          work.push({ role: 'user', content: choice === 'search'
            ? '[SYSTEM] Do NOT write "[WEB RESULTS]" yourself or invent web content. '
              + 'If you need current information, reply with ONE line of JSON exactly '
              + 'like {"tool":"web_search","query":"..."} and nothing else. Otherwise '
              + 'answer the user plainly.'
            : '[SYSTEM] Answer the user directly from your own knowledge. Do NOT use '
              + 'any web tool or write "[WEB RESULTS]" for this reply.' });
          continue;
        }

        // strict tool-call detection: a valid call, a malformed attempt, or null
        // (plain prose = final answer). Mirrors the web branch structure.
        const tcall = toolsOn ? TOOLS.detect(acc) : null;

        // PHASE 1/2 -- PLANNING: a [PLAN] reply (no tool call) is VALIDATED and
        // recorded before execution, then we drive the model through it.
        if (toolsOn && !tcall && !agent.step) {
          const p = TOOLS.parsePlan(acc);
          if (p && p.error && agent.planCount < 3) {          // invalid plan -> reject
            agent.planCount++;
            out.body.textContent = '';
            webChip(out.div, '🧠 invalid plan', 'rejected');
            work.push({ role: 'assistant', content: acc });
            work.push({ role: 'user', content: '[PLAN ERROR]\n'
              + JSON.stringify({ success: false, error: p.error }) });
            EYE.setState('thinking', '◉ AEYE IS PLANNING…');
            continue;
          }
          if (p && p.steps && agent.planCount < 3) {           // valid plan -> record
            agent.plan = p.steps; agent.planCount++;
            out.body.textContent = '';
            webChip(out.div, '🧠 plan · ' + p.steps.length + ' step' + (p.steps.length === 1 ? '' : 's'),
              p.steps.map((s, i) => (i + 1) + '. ' + s).join('\n'));
            work.push({ role: 'assistant', content: acc });
            work.push({ role: 'user', content: '[SYSTEM] Plan recorded (' + p.steps.length
              + ' steps). Now execute step 1 with a SINGLE raw-JSON tool call. Do not repeat the plan.' });
            EYE.setState('thinking', '◉ AEYE IS PLANNING…');
            continue;
          }
        }

        if (tcall) {
          // LOOP CONTROL: hard cap of MAX_TOOL_CALLS per user turn
          if (toolCalls >= MAX_TOOL_CALLS) {
            stopAgent(out, 'Execution stopped: tool call limit reached (' + MAX_TOOL_CALLS + ').');
            break;
          }
          toolCalls++;
          work.push({ role: 'assistant', content: acc });

          // STRICT FORMAT: malformed call -> structured error back, no execution
          if (tcall.malformed) {
            out.body.textContent = '';
            webChip(out.div, '⚠ invalid tool call', 'rejected');
            const key = 'malformed:' + TOOLS.errKey(tcall.error);
            if (key === lastToolErr) sameErrCount++; else { sameErrCount = 1; lastToolErr = key; }
            if (sameErrCount >= 2) { stopAgent(out, 'Execution stopped: repeated failure detected.'); break; }
            work.push({ role: 'user', content: '[TOOL RESULT]\n'
              + JSON.stringify({ success: false, output: null, error: tcall.error }) });
            EYE.setState('thinking');
            continue;
          }

          // DEDUP: identical tool + args two times in a row -> stop
          const sig = tcall.name + ':' + JSON.stringify(tcall.args);
          if (sig === lastCallSig) {
            stopAgent(out, 'Execution stopped: repeated identical tool call.');
            break;
          }
          lastCallSig = sig;

          const mutating = TOOLS.isMutator(tcall.name);
          const dangerous = DANGEROUS.has(tcall.name);
          const fp = tcall.args && (tcall.args.path || tcall.args.path_to || tcall.args.path_from);
          // a mutation to a 2nd distinct file this turn = multi-file -> needs AGENT
          const secondFile = !!fp && !(fp in agent.opsPerFile) && Object.keys(agent.opsPerFile).length >= 1;
          // PHASE 1/3/4 -- a plan is required for dangerous ops, AGENT-classified
          // turns, or multi-file work; simple single-file writes are NOT gated here
          const needPlan = mutating && (dangerous || execMode === 'agent' || secondFile);

          // PHASE 1 -- HARD plan enforcement (mode-aware). No auto-continue.
          if (needPlan && !agent.plan.length) {
            out.body.textContent = '';
            webChip(out.div, '🧠 plan required', 'rejected');
            const key = 'noplan';
            if (key === lastToolErr) sameErrCount++; else { sameErrCount = 1; lastToolErr = key; }
            if (sameErrCount >= 2) { stopAgent(out, 'Execution stopped: repeated failure detected.'); break; }
            const why = dangerous ? ('"' + tcall.name + '" is a guarded operation')
              : (secondFile ? 'changing more than one file' : 'this task');
            work.push({ role: 'user', content: '[TOOL RESULT]\n'
              + JSON.stringify({ success: false, output: null, error: 'Plan required before file operations' })
              + '\n[SYSTEM] ' + why + ' requires a plan first. Reply with a [PLAN] — numbered, ≤5 steps, one '
              + 'short sentence each, name file paths, NO tool call — then execute one step per reply.' });
            EYE.setState('thinking', '◉ AEYE IS PLANNING…');
            continue;
          }

          // PHASE 5 -- controller-owned STANDARD fast path for a single-file write:
          // the model already decided the content; run preview->write->validate here
          // (no [PLAN], no extra model rounds), safety checks still backend-enforced.
          if (!agent.plan.length && execMode !== 'agent' && tcall.name === 'write_file' && !needPlan) {
            if (fp) agent.opsPerFile[fp] = (agent.opsPerFile[fp] || 0) + 1;
            if (fp && agent.opsPerFile[fp] > 3) { stopAgent(out, 'Redundant operation detected on ' + fp + '.'); break; }
            out.body.textContent = '';
            const fill = webChip(out.div, tcall.label, 'editing…');
            EYE.setState('refreshing', '◉ AEYE IS EDITING A FILE…');
            const res = await controllerWrite(tcall.args);
            fill(res.display);
            agent.lastResult = res;
            if (fp) agent.touched.add(fp);
            if (!res.ok) {
              if (TOOLS.isEnvError(res.error)) { stopAgent(out, 'Dependency or environment issue. Cannot be resolved with file tools.'); break; }
              const k = TOOLS.errKey(res.error);
              if (k && k === lastToolErr) sameErrCount++; else { sameErrCount = 1; lastToolErr = k; }
              if (sameErrCount >= 2) { stopAgent(out, 'Execution stopped: repeated failure detected.'); break; }
            } else { lastToolErr = null; sameErrCount = 0; successfulOps++; }
            perf.ctxChars += res.message.length;
            work.push({ role: 'user', content: res.message });
            EYE.setState('thinking');
            continue;
          }

          // PHASE 3 -- execution enforcement: a mutation must match its plan step
          if (mutating && agent.plan.length) {
            const cur = agent.plan[Math.min(agent.step, agent.plan.length - 1)] || '';
            if (!TOOLS.stepMatches(cur, tcall)) {
              out.body.textContent = '';
              webChip(out.div, '⏱ step mismatch', 'rejected');
              const key = 'stepmismatch:' + TOOLS.errKey(cur);
              if (key === lastToolErr) sameErrCount++; else { sameErrCount = 1; lastToolErr = key; }
              if (sameErrCount >= 2) { stopAgent(out, 'Execution stopped: repeated failure detected.'); break; }
              work.push({ role: 'user', content: '[TOOL RESULT]\n' + JSON.stringify({
                success: false, output: null,
                error: 'Step does not match plan (expected: "' + cur + '")' }) });
              EYE.setState('thinking');
              continue;
            }
          }

          // PHASE 11 -- redundancy control: cap mutations per file per turn
          if (mutating && tcall.args) {
            const fpath = tcall.args.path || tcall.args.path_to || tcall.args.path_from;
            if (fpath) {
              const n = (agent.opsPerFile[fpath] || 0) + 1;
              agent.opsPerFile[fpath] = n;
              if (n > 3) {
                stopAgent(out, 'Redundant operation detected on ' + fpath + '.');
                break;
              }
            }
          }

          // "confirm" approval: a write/exec tool needs an explicit yes
          if (TOOLS.needsConfirm(tcall)) {
            out.body.textContent = '';
            const choice = await chatQuestion(
              'The model wants to run a tool: ' + tcall.label + '. Allow it?',
              [{ value: 'yes', label: '✅ Run it' }, { value: 'no', label: '✋ Skip' }]);
            if (choice !== 'yes') {
              webChip(out.div, tcall.label, 'skipped by you');
              work.push({ role: 'user', content: '[TOOL RESULT]\n' + JSON.stringify({
                success: false, output: null,
                error: 'the user declined to run this tool; continue without it or explain what you need',
              }) });
              EYE.setState('thinking');
              continue;
            }
          }

          // USER FEEDBACK (step-aware) + run the tool
          out.body.textContent = '';
          const fill = webChip(out.div, tcall.label, 'running…');
          EYE.setState('refreshing', agent.plan.length
            ? '◉ AEYE IS EXECUTING STEP ' + Math.min(agent.step + 1, agent.plan.length) + '/' + agent.plan.length + '…'
            : '◉ AEYE IS USING TOOLS…');
          // track touched files (Phase 3/4) from any file-tool path argument
          if (tcall.args && tcall.args.path) agent.touched.add(String(tcall.args.path));
          if (window.DEBUG) DEBUG.log('tools', '[TOOL CALL]', { name: tcall.name, args: tcall.args });
          const _t0 = performance.now();
          const res = await TOOLS.run(tcall);
          perf.tool_ms += performance.now() - _t0;   // PHASE 2: tool exec latency
          perf.ctxChars += (res.message || '').length;
          if (window.DEBUG) DEBUG.log('tools', '[TOOL RESULT]', { name: tcall.name, success: res.ok, error: res.error || null });
          fill(res.display);
          agent.lastResult = res;

          if (!res.ok) {
            agent.failed.push({ step: agent.step + 1, tool: tcall.name, error: res.error });
            // ENVIRONMENT/DEPENDENCY error -> unfixable with file tools, stop
            if (TOOLS.isEnvError(res.error)) {
              stopAgent(out, 'Dependency or environment issue. Cannot be resolved with file tools.');
              break;
            }
            // REPEAT FAILURE -- same normalized error twice in a row -> stop
            // (this gives exactly one retry with an adjusted approach, then stop)
            const key = TOOLS.errKey(res.error);
            if (key && key === lastToolErr) sameErrCount++; else { sameErrCount = 1; lastToolErr = key; }
            if (sameErrCount >= 2) {
              stopAgent(out, 'Execution stopped: repeated failure detected.');
              break;
            }
          } else {
            lastToolErr = null; sameErrCount = 0; successfulOps++;   // a success breaks the streak
            agent.completed.push({ step: agent.step + 1, tool: tcall.name });
            if (agent.plan.length) agent.step = Math.min(agent.step + 1, agent.plan.length);
          }

          work.push({ role: 'user', content: res.message });
          EYE.setState('thinking');
          continue;
        }

        // the model fabricated our "[TOOL RESULT]" wrapper instead of emitting a
        // real tool call -- don't pass the made-up result off as an answer; correct
        // it and retry (mirrors the web faked-results guard).
        if (toolsOn && TOOLS.looksFaked(acc) && toolRounds < MAX_TOOL_ROUNDS) {
          toolRounds++;
          out.body.textContent = '';
          webChip(out.div, '⚙ tool', 'model faked a result — retrying');
          work.push({ role: 'assistant', content: acc });
          work.push({ role: 'user', content: '[SYSTEM] Do NOT write "[TOOL RESULT]" '
            + 'yourself or claim a tool ran. To actually use a tool, reply with ONLY '
            + '<tool_call>{"name":"...","args":{...}}</tool_call> and nothing else. If no '
            + 'tool is needed, answer plainly with no "[TOOL RESULT]" text.' });
          EYE.setState('thinking');
          continue;
        }

        // PHASE 5 -- AUTHORITATIVE ACTION: a tool-directed turn that did ZERO real
        // tool ops but whose prose CLAIMS a file action is a hallucination. Never
        // pass it off as done -- surface that nothing actually happened on disk.
        if (execMode !== 'simple' && successfulOps === 0 &&
            /\b(deleted|removed|created|wrote|written|modified|edited|updated|saved|renamed|moved|ran|executed|installed)\b[\s\S]{0,40}\b(file|it|that|the\s+\w+|directory|folder|script|package)\b/i.test(acc)) {
          acc += '\n\n⚠ Note: no tool action was actually performed — this is a description, not a completed operation. Nothing was changed on disk. Re-issue the request (a valid tool call is required to make the change).';
          if (curOut) curOut.body.textContent = acc;
          if (window.DEBUG) DEBUG.log('agent', '[ERROR]', { component: 'authoritative-action', summary: 'model claimed a file action with 0 successful tool ops' });
        }
        // final answer (tool budget spent, web off, or no tool asked). With web
        // on it was already streamed live in guarded mode above -- no need to
        // re-feed the whole thing at the end.
        state.messages.push({ role: 'assistant', content: acc });
        // now that the answer is complete, turn any http(s) URLs in it into
        // clickable links (done once at the end -- never mid-stream, so a URL is
        // never half-formed). Same opener as the sources: /api/open.
        if (curOut) linkify(curOut.body, acc);
        if (allSources.length && curOut) sourcesFooter(curOut.div, allSources);
        break;
      }
      // FINAL RESPONSE GUARANTEE: a turn never ends without an assistant message
      const lastMsg = state.messages[state.messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant') {
        const summary = toolCalls
          ? 'Finished after ' + toolCalls + ' tool call' + (toolCalls === 1 ? '' : 's') + '.'
          : 'Done.';
        if (curOut && !curOut.body.textContent) curOut.body.textContent = summary;
        state.messages.push({ role: 'assistant', content: summary });
      }
      EYE.setState('idle');
      if (window.VOICE) { try { window.VOICE.flush(); } catch { /* noop */ } }
    } catch (e) {
      const partial = curOut ? curOut.body.textContent : '';
      if (curOut) {
        curOut.div.classList.add('error');
        curOut.body.textContent = partial + (partial ? '\n' : '') + '[error] ' + e.message;
      }
      if (partial) state.messages.push({ role: 'assistant', content: partial });
      EYE.setState('error');
      setTimeout(() => !state.busy && EYE.setState('idle'), 4000);
    } finally {
      // PHASE 2/16 -- perf summary (DEBUG ONLY; nothing persisted when off)
      try {
        if (window.TOOLS && TOOLS.enabled() && TOOLS.config().debug) {
          const total = Math.round(performance.now() - perf.t0);
          const modeLabel = (execMode || 'simple').toUpperCase()
            + (TOOLS.forceAgent() ? ' (forced)' : '');
          console.log('[AGENT PERF]\nmode=' + modeLabel
            + '\nmodel_rounds=' + (perf.rounds || 0)
            + '\ntool_calls=' + toolCalls
            + '\nmodel_ms=' + Math.round(perf.model_ms)
            + '\ntool_ms=' + Math.round(perf.tool_ms)
            + '\ntool_result_chars=' + perf.ctxChars
            + '\ntotal_ms=' + total);
        }
      } catch { /* noop */ }
      state.busy = false;
      $('send').disabled = false;
      input.focus();
      // remember the exchange (no-op unless the memory toggle is on)
      if (window.MEMORY) { try { MEMORY.autosave(state.messages); } catch { /* noop */ } }
    }
  }

  // ---- ollama pull -------------------------------------------------------

  async function startPull(name, st) {
    st = st || $('pull-status');
    st.className = 'mini-status';
    $('pull-btn').disabled = true;
    EYE.setState('loading');
    try {
      const res = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      for await (const ev of sse(res)) {
        if (ev.error) throw new Error(ev.error);
        if (ev.done) break;
        let line = ev.status || '';
        if (ev.total) {
          const pct = Math.floor((ev.completed || 0) / ev.total * 100);
          line += '  ' + pct + '%  [' + '#'.repeat(Math.floor(pct / 5)).padEnd(20, '.') + ']';
        }
        st.textContent = line;
      }
      st.textContent = 'done: ' + name;
      note('Pulled ' + name);
      await refreshModels();
      const opt = [...modelSel.options].find((o) =>
        o.value === 'ollama::' + name || o.value === 'ollama::' + name + ':latest');
      if (opt) {
        modelSel.value = opt.value;
        lastGood = opt.value;
        localStorage.setItem('aeye-model', opt.value);
      }
      if (!state.busy) EYE.setState('idle');
    } catch (e) {
      st.textContent = friendlyPullError(e.message, name);
      st.className = 'mini-status err';
      EYE.setState('error');
      setTimeout(() => !state.busy && EYE.setState('idle'), 4000);
    } finally {
      $('pull-btn').disabled = false;
    }
  }

  // turn Ollama's cryptic pull errors into something actionable
  function friendlyPullError(msg, name) {
    const low = (msg || '').toLowerCase();
    if (low.includes('realm host') || low.includes('does not match original host')
        || (low.includes('401') && low.includes('hf.co'))
        || low.includes('authenticat') || low.includes('gated')) {
      return 'This is a gated HuggingFace repo — Ollama can’t pull gated GGUFs '
        + '(your hf_token.txt only covers hf load / imagine, not Ollama). Accept the '
        + 'license on its HF page and use "hf load", or pick a non-gated model.';
    }
    return msg;
  }

  function pull() {
    const name = $('pull-name').value.trim();
    if (name) startPull(name);
  }

  // ---- HF load / unload ----------------------------------------------------

  async function hfLoadById(id, fourBit) {
    const r = await (await fetch('/api/hf/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: id,
        four_bit: !!fourBit,
        trust_remote_code: !!($('hf-trust') && $('hf-trust').checked),
      }),
    })).json();
    if (r.ok === false) {
      $('hf-status').textContent = r.error;
      $('hf-status').className = 'mini-status err';
      return r;
    }
    hfLoadRequested = true;   // deliberate load -> select it once it's ready
    $('hf-id').value = id;
    refreshModels();
    return r;
  }

  function hfLoad() {
    const id = $('hf-id').value.trim();
    if (id) hfLoadById(id, $('hf-4bit').checked);
  }

  async function hfUnload() {
    await fetch('/api/hf/unload', { method: 'POST' });
    refreshModels();
  }

  // ---- events --------------------------------------------------------------

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    // an active interactive plugin session owns the composer: each line is fed
    // to the tool's stdin (empty line allowed -- it can mean "accept default")
    if (window.PLUGINS && PLUGINS.sessionActive && PLUGINS.sessionActive()) {
      const line = input.value;
      input.value = '';
      PLUGINS.sessionInput(line);
      return;
    }
    const text = input.value.trim();
    if (!text || state.busy) return;
    // plugin trigger? ONLY from this explicit composer submit -- never from a
    // model reply, memory or docs -- so a model can't run a local tool.
    if (window.PLUGINS) {
      const hit = PLUGINS.match(text);
      if (hit) { input.value = ''; PLUGINS.run(hit.plugin, hit.query, text); return; }
    }
    input.value = '';
    send(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('clear').addEventListener('click', () => {
    // with memory on, the outgoing chat gets its exit briefing first
    if (window.MEMORY) { try { MEMORY.newChat(); } catch { /* noop */ } }
    state.messages = [];
    state.attachments = [];
    renderAttachments();
    messagesEl.innerHTML = '';   // clear completely -- no note, just a blink
    EYE.blink();
  });

  // ---- image attachments -----------------------------------------------------

  function renderAttachments() {
    const box = $('attachments');
    box.innerHTML = '';
    box.classList.toggle('hidden', !state.attachments.length);
    state.attachments.forEach((src, i) => {
      const chip = document.createElement('div');
      chip.className = 'thumb';
      const img = document.createElement('img');
      img.src = src;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'thumb-x';
      x.textContent = '×';
      x.title = 'remove';
      x.addEventListener('click', () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      });
      chip.append(img, x);
      box.appendChild(chip);
    });
  }

  function addFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => { state.attachments.push(reader.result); renderAttachments(); };
      reader.readAsDataURL(file);
    }
  }

  $('attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  // paste image from clipboard
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imgs = [...items].filter((it) => it.type.startsWith('image/'));
    if (!imgs.length) return;
    addFiles(imgs.map((it) => it.getAsFile()).filter(Boolean));
  });

  // drag & drop anywhere over the chat panel
  const dropZone = $('chat-panel') || document.body;
  const hint = $('drop-hint');
  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) hint.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; hint.classList.add('hidden'); }
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    hint.classList.add('hidden');
    addFiles(e.dataTransfer.files);
  });

  $('refresh').addEventListener('click', refreshModels);
  $('pull-btn').addEventListener('click', pull);
  $('pull-name').addEventListener('keydown', (e) => e.key === 'Enter' && pull());
  $('hf-btn').addEventListener('click', hfLoad);
  $('hf-id').addEventListener('keydown', (e) => e.key === 'Enter' && hfLoad());
  $('hf-unload').addEventListener('click', hfUnload);

  $('temp').addEventListener('input', () => { $('temp-val').textContent = $('temp').value; });
  modelSel.addEventListener('change', () => {
    const v = modelSel.value;
    if (v.startsWith('suggest::')) {
      // picking a suggestion starts the pull, then selection snaps back
      const tag = v.slice('suggest::'.length);
      modelSel.value = [...modelSel.options].some((o) => o.value === lastGood) ? lastGood : '';
      if (window.SETTINGS) SETTINGS.open('tab-models');   // show the pull status
      $('pull-name').value = tag;
      note('Pulling suggested model: ' + tag);
      startPull(tag);
      return;
    }
    lastGood = v;
    localStorage.setItem('aeye-model', v);
  });

  // ---- shared API for library.js ---------------------------------------------

  window.CHAT = {
    note, refreshModels, startPull, hfLoadById, sse, linkify,
    // plugins.js hook: run a streaming local tool with the chat 'busy' lock,
    // a user bubble echoing the command, and an assistant bubble to stream
    // into. runner(out) gets the assistant bubble; it streams + may throw.
    // a bare bubble for plugins to stream into WITHOUT the busy lock -- an
    // interactive session keeps the composer usable for typing input
    pluginBubble(role, text) { return bubble(role || 'assistant', text || ''); },
    async pluginExec(commandText, runner) {
      if (state.busy) return false;
      state.busy = true;
      $('send').disabled = true;
      EYE.setState('thinking');
      bubble('user', commandText);
      const out = bubble('assistant', '');
      out.div.classList.add('streaming');
      try {
        await runner(out);
        EYE.setState('idle');
      } catch (e) {
        out.div.classList.add('error');
        out.body.textContent += (out.body.textContent ? '\n' : '') + '[error] ' + e.message;
        EYE.setState('error');
        setTimeout(() => !state.busy && EYE.setState('idle'), 4000);
      } finally {
        out.div.classList.remove('streaming');
        scrollDown();
        state.busy = false;
        $('send').disabled = false;
        input.focus();
      }
      return true;
    },
    // drop an image into the transcript (used by the imagine panel)
    addImageMessage(prompt, dataUrl) {
      bubble('assistant', '“' + prompt + '”', [dataUrl]);
    },
    // drop a generated video/gif into the transcript (used by the dream panel)
    addVideoMessage(prompt, url, mime) {
      const b = bubble('assistant', '“' + prompt + '”');
      const wrap = document.createElement('div');
      wrap.className = 'msg-images';
      let media;
      if (mime === 'video/mp4') {
        media = document.createElement('video');
        media.src = url; media.controls = true; media.loop = true;
        media.muted = true; media.playsInline = true;
      } else {
        media = document.createElement('img');
        media.src = url;
        media.addEventListener('click', () => media.classList.toggle('expanded'));
      }
      wrap.appendChild(media);
      b.div.insertBefore(wrap, b.body);
      scrollDown();
    },
    setInput(text) { input.value = text; input.focus(); },
    appendInput(text) {
      input.value = (input.value ? input.value + ' ' : '') + text;
      input.focus();
    },
    // send whatever is in the composer (used by voice auto-send); returns
    // false if it's empty or a reply is already generating
    submit() {
      const text = input.value.trim();
      if (!text || state.busy) return false;
      input.value = '';
      send(text);
      return true;
    },
    isBusy: () => state.busy,
    inputValue: () => input.value,
    // live dictation preview: set the composer text and flag it as in-progress
    // (stt.js updates this every ~second so you see words as you speak)
    dictate(text, live) {
      input.value = text;
      input.classList.toggle('dictating', !!live);
      input.focus();
    },
    // ---- memory.js hooks ----
    getMessages: () => state.messages,
    currentModel: () => (modelSel.value || '').split('::'),
    // replace the transcript with a resumed conversation (briefing + tail)
    loadConversation(msgs, noteText) {
      state.messages = msgs;
      state.attachments = [];
      renderAttachments();
      messagesEl.innerHTML = '';
      if (noteText) note(noteText);
      for (const m of msgs) {
        if (m.role === 'system') continue;   // the briefing stays behind the curtain
        bubble(m.role === 'user' ? 'user' : 'assistant', m.content);
      }
      EYE.blink();
    },
  };

  // ---- settings toggles (manage > settings, and the system prompt) ---------

  (function settingsToggles() {
    // hide the eye: suspend its render loop + expand chat (saves GPU). Hidden
    // when the user asks (checkbox → aeye-hide-eye) OR automatically on a low
    // resolution, where the ~600px eye panel would crush the chat. The auto
    // rule never overwrites the saved preference — widen the window past the
    // breakpoint and (unless manually hidden) the eye comes back.
    const hideEye = $('hide-eye');
    if (hideEye && window.EYE && EYE.setHidden) {
      const EYE_AUTOHIDE_W = 1080;   // viewport width below which the eye auto-hides
      const manual = () => localStorage.getItem('aeye-hide-eye') === '1';
      const manualSet = () => localStorage.getItem('aeye-hide-eye') !== null;
      const tooNarrow = () => window.innerWidth < EYE_AUTOHIDE_W;
      // perf-test profile hides the eye at boot UNTIL the user picks (either way)
      const perfHide = () => perfProfile() && !manualSet();
      const apply = () => EYE.setHidden(manual() || perfHide() || tooNarrow());
      hideEye.checked = manual() || perfHide();
      apply();
      hideEye.addEventListener('change', () => {
        localStorage.setItem('aeye-hide-eye', hideEye.checked ? '1' : '0');
        apply();
      });
      window.addEventListener('resize', apply);
    }
    // eye frame-rate cap (eye.js already read the saved value on boot; here we
    // just reflect it into the slider and apply live changes)
    const fps = $('eye-fps');
    const fpsVal = $('eye-fps-val');
    if (fps && fpsVal && window.EYE && EYE.setFps) {
      const saved = parseInt(localStorage.getItem('aeye-fps'), 10);
      const v = (saved >= 15 && saved <= 60) ? saved : 60;
      fps.value = v;
      fpsVal.textContent = v + ' fps' + (v >= 60 ? ' (native)' : '');
      fps.addEventListener('input', () => {
        const n = parseInt(fps.value, 10);
        fpsVal.textContent = n + ' fps' + (n >= 60 ? ' (native)' : '');
        EYE.setFps(n);
      });
    }
    // remember system prompt across restarts (off by default)
    const sp = $('system-prompt');
    const rem = $('sysprompt-remember');
    if (sp && rem) {
      const remembering = localStorage.getItem('aeye-remember-sysprompt') === '1';
      rem.checked = remembering;
      if (remembering) sp.value = localStorage.getItem('aeye-sysprompt') || '';
      const save = () => { if (rem.checked) localStorage.setItem('aeye-sysprompt', sp.value); };
      sp.addEventListener('input', save);
      rem.addEventListener('change', () => {
        localStorage.setItem('aeye-remember-sysprompt', rem.checked ? '1' : '0');
        if (rem.checked) save(); else localStorage.removeItem('aeye-sysprompt');
      });
    }
    // auto-scroll toggle (default ON). OFF keeps your scroll position while a
    // reply streams -- so you can read long output from the top.
    const autoscroll = $('autoscroll-toggle');
    if (autoscroll) {
      autoscroll.checked = localStorage.getItem('aeye-autoscroll') !== '0';
      autoscroll.addEventListener('change', () => {
        localStorage.setItem('aeye-autoscroll', autoscroll.checked ? '1' : '0');
      });
    }
  })();

  // ---- boot ----------------------------------------------------------------

  refreshModels();
  setInterval(() => { if (!state.busy && !hfPoll) refreshModels(); }, 30000);
  input.focus();
})();
