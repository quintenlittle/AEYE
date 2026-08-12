/* ================================================================
   AEYE -- model library + modelfile editor.

   On boot it fetches /api/catalog (which includes the server-side
   hardware scan), lights up the hardware badge, feeds the catalog
   to chat.js for dropdown suggestions, and renders the full model
   library table: EVERY catalog model with its requirements and a
   fits-GPU / CPU-only / too-big verdict, plus pull (Ollama) and
   download/load (HuggingFace) buttons per row.

   The modelfile editor reads an installed model's Modelfile via
   `ollama show` and builds new models via `ollama create`.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  window.CATALOG = null;
  let hw = null;
  let filterFit = 'all';
  let sortBy = 'trending';

  const FIT_LABEL = { gpu: 'FITS GPU', cpu: 'CPU ONLY', no: 'TOO BIG', unknown: 'SIZE ?' };
  const FIT_TITLE = {
    gpu: 'fits entirely in VRAM -- fast',
    cpu: 'fits in system RAM -- runs, but slowly',
    no: 'exceeds both VRAM and RAM on this machine',
    unknown: 'size could not be determined from the model name -- check the repo',
  };

  // ---- installed inventory (for the de-bloat trashcan) ---------------------

  window.INSTALLED = null;

  async function refreshInstalled() {
    try {
      const d = await (await fetch('/api/installed')).json();
      d.ollamaNames = new Set(d.ollama.map((m) => m.name));
      d.hfRepos = new Set(d.hf.map((m) => m.repo));
      window.INSTALLED = d;
    } catch { /* leave prior data */ }
  }

  // an Ollama catalog tag counts as installed if its bare or :latest form is on disk
  function ollamaInstalledName(tag) {
    const i = window.INSTALLED;
    if (!i) return null;
    if (i.ollamaNames.has(tag)) return tag;
    if (i.ollamaNames.has(tag + ':latest')) return tag + ':latest';
    return null;
  }
  const ollamaInstalled = (tag) => !!ollamaInstalledName(tag);
  const hfCached = (repo) => !!(window.INSTALLED && window.INSTALLED.hfRepos.has(repo));

  function trashBtn(kind, id, statusEl) {
    const b = document.createElement('button');
    b.className = 'trash';
    b.innerHTML = '&#128465;';
    b.title = 'delete ' + id + ' from disk';
    b.addEventListener('click', async () => {
      b.disabled = true;
      await (kind === 'ollama' ? deleteOllama(id, statusEl) : deleteHF(id, statusEl));
      b.disabled = false;
    });
    return b;
  }

  async function deleteOllama(name, statusEl) {
    if (!confirm('Delete Ollama model "' + name + '" from disk?')) return;
    if (statusEl) { statusEl.textContent = 'deleting ' + name + '…'; statusEl.className = 'lib-status'; }
    const r = await (await fetch('/api/ollama/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })).json();
    if (r.ok === false) { if (statusEl) { statusEl.textContent = r.error; statusEl.classList.add('err'); } return; }
    CHAT.note('Deleted Ollama model ' + name);
    await refreshInstalled();
    await CHAT.refreshModels();
    renderTable();
  }

  async function deleteHF(repo, statusEl) {
    if (!confirm('Delete cached HuggingFace repo "' + repo + '" from disk?')) return;
    if (statusEl) { statusEl.textContent = 'deleting ' + repo + '…'; statusEl.className = 'lib-status'; }
    const r = await (await fetch('/api/hf/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    })).json();
    if (r.ok === false) { if (statusEl) { statusEl.textContent = r.error; statusEl.classList.add('err'); } return; }
    CHAT.note('Deleted ' + repo + ' (freed ' + (r.freed_gb || 0).toFixed(2) + ' GB)');
    await refreshInstalled();
    CHAT.refreshModels();
    renderTable();
  }

  function renderInstalled(tbody, q) {
    const i = window.INSTALLED;
    if (!i) {
      const tr = document.createElement('tr');
      const c = td(tr, 'lib-empty'); c.colSpan = 9; c.textContent = 'scanning disk…';
      tbody.appendChild(tr); return;
    }
    const rows = [
      ...i.ollama.map((m) => ({ kind: 'ollama', id: m.name, size: m.size_gb, sub: 'Ollama model — select it in the model dropdown to use', loaded: false })),
      ...i.hf.map((m) => ({ kind: 'hf', hfKind: m.kind, id: m.repo, size: m.size_gb,
        sub: m.kind === 'image' ? 'diffusers image model'
          : m.kind === 'video' ? 'diffusers video model' : 'HuggingFace cache',
        loaded: m.loaded })),
    ].filter((r) => !q || r.id.toLowerCase().includes(q))
     .sort((a, b) => b.size - a.size);   // biggest first — best for de-bloating

    const total = rows.reduce((s, r) => s + r.size, 0);
    const head = document.createElement('tr');
    const hc = td(head, 'lib-installed-head'); hc.colSpan = 9;
    hc.textContent = rows.length + ' downloaded · ' + total.toFixed(1) + ' GB on disk'
      + (i.ollama_online ? '' : '  (ollama offline — HF cache only)');
    tbody.appendChild(head);

    for (const r of rows) {
      const tr = document.createElement('tr');
      const name = td(tr, 'lib-name');
      const url = r.kind === 'hf' ? 'https://huggingface.co/' + r.id
        : r.id.indexOf('hf.co/') === 0
          ? 'https://huggingface.co/' + r.id.slice('hf.co/'.length).replace(/:.*$/, '')
          : 'https://ollama.com/library/' + r.id.replace(/:.*$/, '');
      name.appendChild(nameLink(r.id, url));
      if (r.loaded) {
        const s = document.createElement('span');
        s.className = 'lib-loaded'; s.textContent = ' ● loaded';
        s.title = 'currently loaded — deleting will unload it first';
        name.appendChild(s);
      }
      td(tr).textContent = '';                                    // params
      td(tr).textContent = r.kind === 'ollama' ? 'ollama' : 'hf cache';
      td(tr).textContent = '';                                    // likes (n/a)
      td(tr).textContent = '';                                    // updated (n/a)
      td(tr).textContent = r.size.toFixed(2) + ' GB';
      td(tr, 'lib-req').textContent = r.sub;
      td(tr).textContent = '';
      const act = td(tr, 'lib-actions');
      const rowStatus = document.createElement('div');
      rowStatus.className = 'lib-status';
      // reload a cached model straight from the installed list (a restart drops
      // the in-memory pipeline, so this is how you bring an image model back)
      if (r.kind === 'hf') {
        act.appendChild(r.hfKind === 'image'
          ? imagineLoadBtn(r.id, rowStatus)
          : r.hfKind === 'video'
            ? dreamLoadBtn(r.id, rowStatus)
            : hfLoadBtn(r.id, rowStatus));
      }
      act.appendChild(trashBtn(r.kind, r.id, rowStatus));
      act.appendChild(rowStatus);
      tbody.appendChild(tr);
    }

    if (!rows.length) {
      const tr = document.createElement('tr');
      const c = td(tr, 'lib-empty'); c.colSpan = 9;
      c.textContent = q ? 'nothing installed matches' : 'nothing downloaded yet';
      tbody.appendChild(tr);
    }
  }

  // ---- modal plumbing ------------------------------------------------------

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  document.querySelectorAll('.close[data-close]').forEach((b) =>
    b.addEventListener('click', () => closeModal(b.dataset.close)));
  document.querySelectorAll('.overlay').forEach((ov) =>
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.classList.add('hidden'); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
      document.querySelectorAll('.overlay').forEach((ov) => ov.classList.add('hidden'));
  });

  // ---- hardware + catalog boot ----------------------------------------------

  async function boot() {
    try {
      const data = await (await fetch('/api/catalog')).json();
      window.CATALOG = data;
      hw = data.hw;

      const gpu = hw.gpus && hw.gpus.length ? hw.gpus[0].name : 'no GPU';
      const vram = hw.vram_gb ? ' ' + hw.vram_gb + 'GB' : '';
      const badge = $('hw-badge');
      badge.textContent = (hw.cores || '?') + 'c · ' + (hw.ram_gb || '?') + 'GB · ' + gpu + vram;
      badge.className = 'badge on';
      badge.title = hw.cpu + '\n' + hw.ram_gb + ' GB RAM\n'
        + (hw.gpus.map((g) => g.name + (g.vram_gb ? ' (' + g.vram_gb + ' GB VRAM)' : '')).join('\n') || 'no GPU detected');

      $('lib-hw').textContent = hw.cpu + ' · ' + hw.cores + ' cores · '
        + hw.ram_gb + ' GB RAM · '
        + (hw.gpus.map((g) => g.name + (g.vram_gb ? ' (' + g.vram_gb + ' GB)' : '')).join(', ') || 'no GPU');

      CHAT.refreshModels();   // now the dropdown can add hardware-fit suggestions
      await refreshInstalled();
      renderTable();
      handleRefresh(data.refresh);
      // startup lightshow: the server's boot refresh often finishes before the
      // window opens -- kick a fresh scan so the eye always does its violet
      // sweep (and the trending list is current) on every launch
      if (!data.refresh || data.refresh.state !== 'running') triggerRefresh();
    } catch {
      $('hw-badge').textContent = 'hw scan failed';
      $('hw-badge').className = 'badge err';
    }
  }

  // ---- trending-refresh progress --------------------------------------------

  let refreshPoll = null;

  // an ISO timestamp (HF createdAt/lastModified) -> "3 d ago" style relative
  function fmtWhen(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? fmtAgo(t / 1000) : '—';
  }

  function fmtAgo(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return Math.round(s) + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  function updateRefreshUI(r) {
    // the eye IS the indicator: it turns violet while scanning the hubs and
    // reverts when done. Never steal it from real work (thinking/streaming/…).
    const running = r.state === 'running';
    const cur = document.body.dataset.state;
    if (running && (cur === 'idle' || cur === 'asleep')) EYE.setState('refreshing');
    else if (!running && cur === 'refreshing') EYE.setState('idle');
    const line = $('lib-refresh-status');
    if (r.state === 'running') {
      line.textContent = '⟳ scanning for trending models… ' + (r.phase || '');
      line.className = 'busy';
    } else if (r.state === 'offline') {
      line.textContent = '○ offline — showing ' + (r.count || 0) + ' cached trending models';
      line.className = '';
    } else if (r.state === 'error') {
      line.textContent = '× trending refresh failed' + (r.error ? ' (' + r.error + ')' : '');
      line.className = 'err';
    } else {
      line.textContent = (r.count || 0) + ' trending models · updated ' + fmtAgo(r.updated);
      line.className = '';
    }
  }

  function handleRefresh(r) {
    if (!r) return;
    updateRefreshUI(r);
    if (r.state === 'running' && !refreshPoll) pollRefresh();
  }

  function pollRefresh() {
    clearInterval(refreshPoll);
    refreshPoll = setInterval(async () => {
      let r;
      try { r = await (await fetch('/api/refresh/status')).json(); }
      catch { return; }
      updateRefreshUI(r);
      if (r.state !== 'running') {
        clearInterval(refreshPoll);
        refreshPoll = null;
        // pull in the freshly-merged models and re-render
        try {
          const data = await (await fetch('/api/catalog')).json();
          window.CATALOG = data;
          renderTable();
          CHAT.refreshModels();
        } catch { /* leave current view */ }
      }
    }, 900);
  }

  async function triggerRefresh() {
    const btn = $('lib-refresh-btn');
    btn.disabled = true;
    try {
      await fetch('/api/refresh', { method: 'POST' });
      updateRefreshUI({ state: 'running', phase: 'connecting', done: 0, total: 4 });
      pollRefresh();
    } finally {
      setTimeout(() => { btn.disabled = false; }, 1500);
    }
  }

  // ---- gated-repo helpers ----------------------------------------------------

  // a catalog row is gated if flagged, or its note mentions it
  const isGated = (m) => !!(m.gated || /gated/i.test(m.note || ''));

  // the HuggingFace page where you accept the license. A real HF repo is
  // always `owner/name` -- a bare token (e.g. an Ollama-native "llama3", which
  // _dyn_from_ollama stores as `repo`) is NOT HF and must fall through to the
  // Ollama library page instead.
  function hfPageUrl(m) {
    const hfRepo = (v) => (v && v.indexOf('/') > 0 ? v : null);
    let repo = hfRepo(m.hf) || hfRepo(m.repo);
    if (!repo && m.ollama && m.ollama.indexOf('hf.co/') === 0)
      repo = m.ollama.slice('hf.co/'.length).replace(/:.*$/, '');
    return repo ? 'https://huggingface.co/' + repo : null;
  }

  // the public page for any model: HuggingFace repo page, or the Ollama
  // library page for native Ollama tags (hf.co/… tags go to HuggingFace)
  function modelPageUrl(m) {
    const hf = hfPageUrl(m);
    if (hf) return hf;
    if (m.ollama) return 'https://ollama.com/library/' + m.ollama.replace(/:.*$/, '');
    return null;
  }

  // a model-name link: overview + benchmarks live on the model page. Opens in
  // the system browser via /api/open (the desktop window has no tabs).
  function nameLink(text, url) {
    const a = document.createElement('a');
    a.className = 'lib-name-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    a.title = 'open ' + url + ' (overview & benchmarks)';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fetch('/api/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).catch(() => window.open(url, '_blank'));
    });
    return a;
  }

  // an "accept license ↗" link that opens the model page in a new tab
  function licenseLink(m) {
    const url = hfPageUrl(m);
    if (!url) return null;
    const a = document.createElement('a');
    a.className = 'license-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'accept license ↗';
    a.title = 'Opens ' + url + ' — click "Agree and access" there, then load again';
    return a;
  }

  // ---- shared load buttons (used by catalog + installed views) ---------------

  // load an image/diffusers repo into the imagine pipeline
  function imagineLoadBtn(repo, statusEl) {
    const b = document.createElement('button');
    b.textContent = 'load ▸ imagine';
    b.title = 'load ' + repo + ' into the image pipeline';
    b.addEventListener('click', async () => {
      b.disabled = true;
      statusEl.classList.remove('err');
      statusEl.textContent = 'loading diffusion pipeline… (watch the img badge)';
      try {
        const r = await (await fetch('/api/img/load', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: repo }),
        })).json();
        if (r.ok === false) { statusEl.textContent = r.error; statusEl.classList.add('err'); }
        else { statusEl.textContent = 'loading… open imagine when the img badge is ready';
          CHAT.note('Loading image model: ' + repo); CHAT.refreshModels(); }
      } finally { b.disabled = false; }
    });
    return b;
  }

  // load a text-to-video repo into the dream pipeline
  function dreamLoadBtn(repo, statusEl) {
    const b = document.createElement('button');
    b.textContent = 'load ▸ dream';
    b.title = 'load ' + repo + ' into the video pipeline';
    b.addEventListener('click', async () => {
      b.disabled = true;
      statusEl.classList.remove('err');
      statusEl.textContent = 'loading video pipeline… (watch the vid badge)';
      try {
        const r = await (await fetch('/api/vid/load', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: repo }),
        })).json();
        if (r.ok === false) { statusEl.textContent = r.error; statusEl.classList.add('err'); }
        else { statusEl.textContent = 'loading… open dream when the vid badge is ready';
          CHAT.note('Loading video model: ' + repo); CHAT.refreshModels(); }
      } finally { b.disabled = false; }
    });
    return b;
  }

  // load a transformers repo as the chat model
  function hfLoadBtn(repo, statusEl) {
    const b = document.createElement('button');
    b.textContent = 'hf load';
    b.title = 'load ' + repo + ' via transformers\n(uses the 4-bit checkbox in Manage)';
    b.addEventListener('click', () => {
      statusEl.classList.remove('err');
      statusEl.textContent = 'loading via transformers… (watch the hf badge)';
      CHAT.hfLoadById(repo, $('hf-4bit').checked);
      CHAT.note('Loading HuggingFace model: ' + repo);
    });
    return b;
  }

  // ---- library table ---------------------------------------------------------

  function td(parent, cls) {
    const cell = document.createElement('td');
    if (cls) cell.className = cls;
    parent.appendChild(cell);
    return cell;
  }

  // ---- catalog sorting (the HuggingFace-style "sort by" dropdown) ------------

  // numeric parameter count from the display string, for the param sorts:
  // "8B"->8, "3.8B"->3.8, "8x7B MoE"->56, "47B MoE"->47, "~7B"->7, "?"->NaN.
  function paramsNum(m) {
    const p = String(m.params || '').replace('~', '');
    const moe = p.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
    if (moe) return parseFloat(moe[1]) * parseFloat(moe[2]);
    const n = p.match(/\d+(?:\.\d+)?/);
    return n ? parseFloat(n[0]) : NaN;
  }

  // comparators that always sink missing values (NaN / undefined / empty) to
  // the bottom -- curated & Ollama entries lack HF's likes/created/updated, so
  // they trail the trending HF models instead of scrambling the top.
  const numDesc = (f) => (a, b) => {
    const x = f(a), y = f(b), xn = Number.isFinite(x), yn = Number.isFinite(y);
    return (xn && yn) ? y - x : (yn ? 1 : 0) - (xn ? 1 : 0);
  };
  const numAsc = (f) => (a, b) => {
    const x = f(a), y = f(b), xn = Number.isFinite(x), yn = Number.isFinite(y);
    return (xn && yn) ? x - y : (yn ? 1 : 0) - (xn ? 1 : 0);
  };
  const strDesc = (f) => (a, b) => {         // ISO date strings sort chronologically
    const x = f(a) || '', y = f(b) || '';
    return (x && y) ? (x < y ? 1 : x > y ? -1 : 0) : (y ? 1 : 0) - (x ? 1 : 0);
  };

  // the default view: uncensored/abliterated first, then mistral/dolphin
  // family; within a bucket, freshly-trending first, then by popularity.
  function trendingSort(a, b) {
    const rank = (m) => m.cat === 'uncensored' ? 0
      : /mistral|mixtral|dolphin|heretic|abliterat/i.test(m.name) ? 1 : 2;
    return (rank(a) - rank(b))
      || ((b.trending ? 1 : 0) - (a.trending ? 1 : 0))
      || ((b.downloads || 0) - (a.downloads || 0));
  }

  function sortModels(models) {
    const cmp = {
      trending: trendingSort,
      likes: numDesc((m) => m.likes),
      downloads: numDesc((m) => m.downloads),
      created: strDesc((m) => m.created),
      updated: strDesc((m) => m.updated),
      'params-desc': numDesc(paramsNum),
      'params-asc': numAsc(paramsNum),
    }[sortBy] || trendingSort;
    // trending order breaks ties so equal-key rows stay in a sensible order
    models.sort((a, b) => cmp(a, b) || trendingSort(a, b));
  }

  function renderTable() {
    const tbody = $('lib-body');
    tbody.innerHTML = '';
    if (!window.CATALOG) return;
    const q = $('lib-search').value.trim().toLowerCase();

    // update filter-button counts
    const inst = window.INSTALLED;
    const counts = { all: 0, installed: 0, trend: 0, unc: 0, image: 0, video: 0, gpu: 0, cpu: 0, no: 0, unknown: 0 };
    counts.installed = inst ? (inst.ollama.length + inst.hf.length) : 0;
    for (const m of window.CATALOG.models) {
      counts.all++;
      counts[m.fit]++;
      if (m.trending) counts.trend++;
      if (m.cat === 'uncensored') counts.unc++;
      if (m.cat === 'image') counts.image++;
      if (m.cat === 'video') counts.video++;
    }
    document.querySelectorAll('#lib-filters button').forEach((b) => {
      const base = { all: 'all', installed: '💾 installed', trend: '🔥 trending',
        unc: 'uncensored', image: 'image gen', video: 'video gen', gpu: 'fits gpu',
        cpu: 'cpu only', no: 'too big' }[b.dataset.fit];
      b.textContent = base + ' (' + (counts[b.dataset.fit] || 0) + ')';
      b.classList.toggle('on', b.dataset.fit === filterFit);
    });

    if (filterFit === 'installed') { renderInstalled(tbody, q); return; }

    const models = window.CATALOG.models.filter((m) => {
      if (filterFit === 'trend') { if (!m.trending) return false; }
      else if (filterFit === 'unc') { if (m.cat !== 'uncensored') return false; }
      else if (filterFit === 'image') { if (m.cat !== 'image') return false; }
      else if (filterFit === 'video') { if (m.cat !== 'video') return false; }
      else if (filterFit !== 'all' && m.fit !== filterFit) return false;
      if (q) {
        const hay = (m.name + ' ' + (m.ollama || '') + ' ' + (m.hf || '') + ' '
          + m.cat + ' ' + m.note).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    sortModels(models);

    for (const m of models) {
      const tr = document.createElement('tr');
      tr.className = 'fit-' + m.fit;

      const name = td(tr, 'lib-name');
      const pageUrl = modelPageUrl(m);
      const nameText = pageUrl ? nameLink(m.name, pageUrl) : document.createElement('span');
      if (!pageUrl) nameText.textContent = m.name;
      name.appendChild(nameText);
      if (m.trending) {
        const flame = document.createElement('span');
        flame.className = 'lib-trend';
        flame.textContent = ' 🔥';
        flame.title = 'trending — added automatically from the latest models';
        name.appendChild(flame);
      }
      if (m.note) {
        const small = document.createElement('div');
        small.className = 'lib-note';
        small.textContent = m.note;
        name.appendChild(small);
      }

      td(tr).textContent = m.params;
      td(tr, m.cat === 'uncensored' ? 'lib-unc' : m.cat === 'image' ? 'lib-img' : '').textContent = m.cat;

      const likesCell = td(tr, 'lib-likes');
      if (typeof m.likes === 'number') {
        likesCell.textContent = '♥ ' + fmtNum(m.likes);
        likesCell.title = m.likes + ' likes on HuggingFace';
      } else { likesCell.textContent = '—'; }

      const upCell = td(tr, 'lib-when');
      if (m.updated) {
        upCell.textContent = fmtWhen(m.updated);
        upCell.title = 'updated ' + m.updated
          + (m.created ? '\ncreated ' + m.created : '');
      } else { upCell.textContent = '—'; }

      td(tr).textContent = m.size_gb ? m.size_gb + ' GB' : '—';
      td(tr, 'lib-req').textContent = m.vram_gb
        ? 'RAM ≥ ' + m.ram_gb + ' GB · VRAM ≥ ' + m.vram_gb + ' GB'
        : 'requirements unknown';

      const fit = td(tr);
      const fb = document.createElement('span');
      fb.className = 'fit-badge fit-badge-' + m.fit;
      fb.textContent = FIT_LABEL[m.fit];
      fb.title = FIT_TITLE[m.fit];
      fit.appendChild(fb);

      const act = td(tr, 'lib-actions');
      const rowStatus = document.createElement('div');
      rowStatus.className = 'lib-status';

      if (m.ollama) {
        const b = document.createElement('button');
        b.textContent = 'pull';
        b.title = 'ollama pull ' + m.ollama;
        b.addEventListener('click', async () => {
          b.disabled = true;
          await CHAT.startPull(m.ollama, rowStatus);
          b.disabled = false;
        });
        act.appendChild(b);
      }
      if (m.hf && m.cat === 'image') {
        // image-gen models load into the diffusers pipeline, not the LLM
        act.appendChild(imagineLoadBtn(m.hf, rowStatus));
      } else if (m.hf && m.cat === 'video') {
        act.appendChild(dreamLoadBtn(m.hf, rowStatus));
      } else if (m.hf) {
        act.appendChild(hfLoadBtn(m.hf, rowStatus));
      }
      // gated repos: a one-click link to accept the license on HuggingFace
      if (isGated(m)) {
        const ll = licenseLink(m);
        if (ll) act.appendChild(ll);
      }
      // inline trashcan for whatever this row has downloaded on disk
      if (m.ollama && ollamaInstalled(m.ollama))
        act.appendChild(trashBtn('ollama', ollamaInstalledName(m.ollama), rowStatus));
      if (m.hf && hfCached(m.hf))
        act.appendChild(trashBtn('hf', m.hf, rowStatus));
      act.appendChild(rowStatus);

      tbody.appendChild(tr);
    }

    if (!models.length) {
      const tr = document.createElement('tr');
      const cell = td(tr, 'lib-empty');
      cell.colSpan = 9;
      cell.textContent = 'nothing matches';
      tbody.appendChild(tr);
    }
  }

  $('library-btn').addEventListener('click', async () => {
    openModal('library-modal'); renderTable();
    await refreshInstalled(); renderTable();
  });
  $('lib-refresh-btn').addEventListener('click', triggerRefresh);
  $('lib-search').addEventListener('input', renderTable);
  $('lib-sort').addEventListener('change', (e) => { sortBy = e.target.value; renderTable(); });
  document.querySelectorAll('#lib-filters button').forEach((b) =>
    b.addEventListener('click', () => { filterFit = b.dataset.fit; renderTable(); }));

  // ---- live hub search (ALL of HuggingFace + Ollama, catalog or not) ---------

  const KIND_LABEL = {
    gguf:  ['GGUF', 'pull straight into Ollama (llama.cpp quant)'],
    hf:    ['transformers', 'load in-process with transformers'],
    image: ['image gen', 'load into the diffusers image pipeline'],
    video: ['video gen', 'load into the diffusers video (dream) pipeline'],
  };

  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
    return '' + (n || 0);
  }

  function hubRow(container, title, subtitle, url) {
    const row = document.createElement('div');
    row.className = 'hub-row';
    const info = document.createElement('div');
    info.className = 'hub-info';
    const t = document.createElement('div');
    t.className = 'hub-title';
    // clickable title -> opens the model page in the system browser via
    // /api/open, exactly like the curated-catalog name links (the webview has
    // no tabs, so a plain target=_blank is unreliable)
    if (url) t.appendChild(nameLink(title, url));
    else t.textContent = title;
    info.appendChild(t);
    if (subtitle) {
      const s = document.createElement('div');
      s.className = 'hub-sub';
      s.textContent = subtitle;
      info.appendChild(s);
    }
    row.appendChild(info);
    const act = document.createElement('div');
    act.className = 'hub-actions';
    row.appendChild(act);
    const st = document.createElement('div');
    st.className = 'lib-status';
    row.appendChild(st);
    container.appendChild(row);
    return { row, info, act, st };
  }

  function badge(parent, text, cls, title) {
    const b = document.createElement('span');
    b.className = 'hub-badge' + (cls ? ' ' + cls : '');
    b.textContent = text;
    if (title) b.title = title;
    parent.appendChild(b);
    return b;
  }

  function renderHfResult(container, m) {
    const kl = KIND_LABEL[m.kind] || ['model', ''];
    const meta = [];
    if (m.pipeline) meta.push(m.pipeline);
    if (m.vision) meta.push('vision');
    if (m.tags && m.tags.length) meta.push(m.tags.slice(0, 5).join(' · '));
    const { info, act, st } = hubRow(container, m.id, meta.join('   ·   '),
      'https://huggingface.co/' + m.id);

    const badges = document.createElement('div');
    badges.className = 'hub-badges';
    badge(badges, kl[0], 'k-' + m.kind, kl[1]);
    badge(badges, '⬇ ' + fmtNum(m.downloads), 'muted', m.downloads + ' downloads');
    badge(badges, '♥ ' + fmtNum(m.likes), 'muted');
    if (m.gated) {
      const g = document.createElement('a');
      g.className = 'hub-badge warn gated-badge';
      g.textContent = 'gated ↗';
      g.href = 'https://huggingface.co/' + m.id;
      g.target = '_blank';
      g.rel = 'noopener';
      g.title = 'Gated: open the HuggingFace page to accept the license, then load';
      badges.appendChild(g);
    }
    info.appendChild(badges);

    if (m.kind === 'gguf') {
      let sel = null;
      const pq = (m.pull_quants && m.pull_quants.length) ? m.pull_quants : ['latest'];
      if (pq.length) {
        sel = document.createElement('select');
        sel.className = 'hub-quant';
        sel.title = 'quantization tag to pull (latest = maintainer default)';
        for (const q of pq) {
          const o = document.createElement('option');
          o.value = o.textContent = q;
          sel.appendChild(o);
        }
        sel.value = m.default_quant && pq.includes(m.default_quant) ? m.default_quant : pq[0];
        act.appendChild(sel);
      }
      const b = document.createElement('button');
      b.textContent = 'pull';
      const nameFor = () => 'hf.co/' + m.id + (sel ? ':' + sel.value : '');
      b.title = 'ollama pull ' + nameFor();
      b.addEventListener('click', async () => {
        b.disabled = true;
        await CHAT.startPull(nameFor(), st);
        b.disabled = false;
      });
      act.appendChild(b);
    } else if (m.kind === 'image') {
      const b = document.createElement('button');
      b.textContent = 'load ▸ imagine';
      b.title = 'download + load ' + m.id + ' into the image pipeline';
      b.addEventListener('click', async () => {
        st.textContent = 'loading diffusion pipeline… (watch the img badge)';
        const r = await (await fetch('/api/img/load', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: m.id }),
        })).json();
        if (r.ok === false) { st.textContent = r.error; st.classList.add('err'); }
        else { CHAT.note('Loading image model: ' + m.id); CHAT.refreshModels(); }
      });
      act.appendChild(b);
    } else if (m.kind === 'video') {
      const b = document.createElement('button');
      b.textContent = 'load ▸ dream';
      b.title = 'download + load ' + m.id + ' into the video pipeline';
      b.addEventListener('click', async () => {
        st.textContent = 'loading video pipeline… (watch the vid badge)';
        const r = await (await fetch('/api/vid/load', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_id: m.id }),
        })).json();
        if (r.ok === false) { st.textContent = r.error; st.classList.add('err'); }
        else { CHAT.note('Loading video model: ' + m.id); CHAT.refreshModels(); }
      });
      act.appendChild(b);
    } else {
      const b = document.createElement('button');
      b.textContent = 'hf load';
      b.title = 'download + load ' + m.id + ' via transformers\n(uses the 4-bit checkbox in Manage)';
      b.addEventListener('click', () => {
        st.textContent = 'loading via transformers… (watch the hf badge)';
        CHAT.hfLoadById(m.id, $('hf-4bit').checked);
        CHAT.note('Loading HuggingFace model: ' + m.id);
      });
      act.appendChild(b);
    }

    const link = document.createElement('a');
    link.className = 'hub-link';
    link.href = 'https://huggingface.co/' + m.id;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '↗';
    link.title = 'open on huggingface.co';
    act.appendChild(link);
  }

  function renderOllamaResult(container, name) {
    const { act, st } = hubRow(container, name, 'ollama library',
      'https://ollama.com/library/' + name);
    const b = document.createElement('button');
    b.textContent = 'pull';
    b.title = 'ollama pull ' + name;
    b.addEventListener('click', async () => {
      b.disabled = true;
      await CHAT.startPull(name, st);
      b.disabled = false;
    });
    act.appendChild(b);
    const link = document.createElement('a');
    link.className = 'hub-link';
    link.href = 'https://ollama.com/library/' + name;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '↗';
    link.title = 'open on ollama.com';
    act.appendChild(link);
  }

  function section(container, title) {
    const h = document.createElement('div');
    h.className = 'hub-section';
    h.textContent = title;
    container.appendChild(h);
  }

  // status/loading line for the hub box -- textContent so a search query or a
  // server error string can never inject markup
  function hubMsg(text, isErr) {
    const d = document.createElement('div');
    d.className = 'hub-loading' + (isErr ? ' err' : '');
    d.textContent = text;
    return d;
  }

  let hubSeq = 0;
  async function onlineSearch() {
    const q = $('lib-online-q').value.trim();
    const box = $('lib-online');
    const clear = $('lib-online-clear');
    const modal = $('library-modal');
    if (!q) {
      box.classList.add('hidden'); clear.classList.add('hidden');
      modal.classList.remove('hub-open');   // give the room back to the catalog
      return;
    }
    const seq = ++hubSeq;
    box.classList.remove('hidden');
    clear.classList.remove('hidden');
    modal.classList.add('hub-open');         // shrink catalog, expand the hub box
    box.replaceChildren(hubMsg('searching HuggingFace + Ollama for “' + q + '”…'));
    try {
      const data = await (await fetch('/api/search?limit=25&q=' + encodeURIComponent(q))).json();
      if (seq !== hubSeq) return;   // a newer search superseded this one
      box.innerHTML = '';

      if (data.ollama && data.ollama.length) {
        section(box, 'Ollama library (' + data.ollama.length + ')');
        for (const n of data.ollama) renderOllamaResult(box, n);
      }
      if (data.hf && data.hf.length) {
        section(box, 'HuggingFace Hub (' + data.hf.length + ')');
        for (const m of data.hf) renderHfResult(box, m);
      }
      if ((!data.hf || !data.hf.length) && (!data.ollama || !data.ollama.length)) {
        const e = (data.errors && (data.errors.hf || data.errors.ollama)) || '';
        box.replaceChildren(hubMsg('no models found for “' + q + '”' + (e ? ' (' + e + ')' : '')));
      }
    } catch (err) {
      if (seq !== hubSeq) return;
      box.replaceChildren(hubMsg('search failed: ' + err.message, true));
    }
  }

  let hubTimer = null;
  $('lib-online-btn').addEventListener('click', onlineSearch);
  $('lib-online-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onlineSearch(); }
  });
  $('lib-online-q').addEventListener('input', () => {
    clearTimeout(hubTimer);
    const v = $('lib-online-q').value.trim();
    if (!v) { onlineSearch(); return; }        // clears instantly when emptied
    if (v.length < 3) return;                  // wait for a meaningful query
    hubTimer = setTimeout(onlineSearch, 450);  // debounce while typing
  });
  $('lib-online-clear').addEventListener('click', () => {
    $('lib-online-q').value = '';
    onlineSearch();
    $('lib-online-q').focus();
  });

  // ---- modelfile editor --------------------------------------------------------

  function mfStatus(text, isErr) {
    const st = $('mf-status');
    st.textContent = text;
    st.className = 'mini-status' + (isErr ? ' err' : '');
  }

  async function mfPopulate() {
    try {
      const data = await (await fetch('/api/models')).json();
      const sel = $('mf-source');
      const prev = sel.value;
      sel.innerHTML = '';
      for (const name of data.ollama) {
        const o = document.createElement('option');
        o.value = o.textContent = name;
        sel.appendChild(o);
      }
      if (!data.ollama.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '-- no installed ollama models --';
        sel.appendChild(o);
      }
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    } catch { /* server unreachable; leave as-is */ }
  }

  async function mfLoad() {
    const name = $('mf-source').value;
    if (!name) { mfStatus('no installed model selected', true); return; }
    mfStatus('fetching modelfile…');
    const r = await (await fetch('/api/ollama/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })).json();
    if (!r.ok) { mfStatus(r.error, true); return; }
    $('mf-editor').value = r.modelfile;
    if (!$('mf-name').value.trim()) $('mf-name').value = name.split(':')[0] + '-custom';
    mfStatus('loaded modelfile of ' + name + ' — edit it, name it, hit create');
  }

  async function mfCreate() {
    const name = $('mf-name').value.trim();
    const modelfile = $('mf-editor').value.trim();
    if (!name || !modelfile) {
      openModal('modelfile-modal');
      mfPopulate();
      mfStatus('need both a new model name and modelfile content', true);
      return;
    }
    $('mf-create').disabled = true;
    EYE.setState('loading');
    try {
      const res = await fetch('/api/ollama/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, modelfile }),
      });
      for await (const ev of CHAT.sse(res)) {
        if (ev.error) throw new Error(ev.error);
        if (ev.status) mfStatus(ev.status);
        if (ev.done) break;
      }
      mfStatus('created: ' + name);
      CHAT.note('Created model "' + name + '" from modelfile');
      await CHAT.refreshModels();
      EYE.setState('idle');
      EYE.blink();
    } catch (e) {
      mfStatus(e.message, true);
      EYE.setState('error');
      setTimeout(() => EYE.setState('idle'), 4000);
    } finally {
      $('mf-create').disabled = false;
    }
  }

  $('modelfile-btn').addEventListener('click', () => { openModal('modelfile-modal'); mfPopulate(); });
  $('create-btn').addEventListener('click', () => {
    // create straight away if the editor is primed, otherwise open it
    if ($('mf-name').value.trim() && $('mf-editor').value.trim()) mfCreate();
    else { openModal('modelfile-modal'); mfPopulate(); mfStatus('load or write a modelfile, name it, then hit create'); }
  });
  $('mf-load').addEventListener('click', mfLoad);
  $('mf-create').addEventListener('click', mfCreate);

  // ---- go --------------------------------------------------------------------

  boot();
})();
