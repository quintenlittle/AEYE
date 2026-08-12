/* ================================================================
   AEYE -- local document RAG (the DOCUMENTS half of the memory drawer).
   Upload PDF/TXT/MD/DOCX; the server chunks + embeds them 100% LOCALLY
   (sentence-transformers, optional install) and persists the vectors
   under ./memory/docs. Per send, chat.js asks contextFor(text): the
   message is embedded, the top chunks over a relevance floor ride along
   as system context ("prefer the excerpts; if they don't cover it, say
   so"). Retrieval is gated on the "use in chat" toggle (localStorage
   'aeye-docs'); indexing only ever happens on an explicit upload.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CTX_CAP = 7000;    // max chars of injected excerpt context
  const TOP_K = 4;         // chunks asked for per query (floor may drop some)

  // ON by default: uploading a document IS the opt-in act
  const on = () => localStorage.getItem('aeye-docs') !== '0';

  let cache = null, cacheAt = 0, pollTimer = null;

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function list(force) {
    if (!force && cache && Date.now() - cacheAt < 15000) return cache;
    cache = await api('/api/docs/list');
    cacheAt = Date.now();
    return cache;
  }

  // ---- drawer ui -------------------------------------------------------------

  const fmtBytes = (b) => b >= 1048576
    ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, (b / 1024) | 0) + ' KB';

  function stateText(d) {
    if (d.status === 'ready') return d.chunks + ' chunks';
    if (d.status === 'error') return 'error: ' + (d.error || '?');
    const p = d.progress;
    if (p && p.stage === 'embedding' && p.total) return 'embedding ' + p.done + '/' + p.total;
    return (p && p.stage) || d.status;         // queued / extracting / chunking
  }

  function modalOpen() { return !$('memory-modal').classList.contains('hidden'); }

  function schedule(busy) {
    clearTimeout(pollTimer);
    // keep polling only while something is indexing AND the drawer is open --
    // the server finishes on its own either way
    if (busy && modalOpen()) pollTimer = setTimeout(render, 1000);
  }

  async function render() {
    const st = $('docs-status');
    $('docs-use').checked = on();
    let data;
    try { data = await list(true); } catch { st.textContent = 'server unreachable'; return; }

    $('docs-add').disabled = !data.available;
    const docs = data.docs || [];
    const tb = $('docs-body');
    tb.innerHTML = '';
    for (const d of docs) {
      const tr = document.createElement('tr');

      const tdN = document.createElement('td');
      tdN.className = 'mem-title';
      tdN.textContent = d.name;
      tdN.title = d.name;

      const tdS = document.createElement('td');
      tdS.textContent = fmtBytes(d.bytes || 0);

      const tdT = document.createElement('td');
      tdT.textContent = stateText(d);
      if (d.status === 'error') { tdT.className = 'docs-err'; tdT.title = d.error || ''; }
      const p = d.progress;
      if (p && p.total) {
        const bar = document.createElement('div');
        bar.className = 'docs-barline';
        const fill = document.createElement('i');
        fill.style.width = ((p.done / p.total) * 100).toFixed(0) + '%';
        bar.appendChild(fill);
        tdT.appendChild(bar);
      }

      const tdA = document.createElement('td');
      tdA.className = 'mem-actions';
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '🗑';
      del.title = 'Remove this document and its index';
      del.addEventListener('click', async () => {
        del.disabled = true;
        await api('/api/docs/delete', { id: d.id });
        cacheAt = 0;
        render();
      });
      tdA.appendChild(del);

      tr.append(tdN, tdS, tdT, tdA);
      tb.appendChild(tr);
    }

    if (!data.available) {
      st.textContent = 'document memory (RAG) not installed — '
        + (window.extrasHint ? window.extrasHint() : 're-run install.bat')
        + ' to add it';
    } else if (!docs.length) {
      st.textContent = 'no documents yet — add PDF, text or Word files to chat about them';
    } else {
      const ready = docs.filter((d) => d.status === 'ready').length;
      st.textContent = ready + '/' + docs.length + ' indexed — embeddings & search stay on this machine ('
        + (data.faiss ? 'faiss' : 'numpy') + ')';
    }
    schedule(docs.some((d) => d.status === 'queued' || d.status === 'indexing'));
  }

  // ---- upload ----------------------------------------------------------------

  async function upload(files) {
    const st = $('docs-status');
    for (const f of files) {
      st.textContent = 'uploading ' + f.name + '…';
      try {
        const r = await fetch('/api/docs/upload?name=' + encodeURIComponent(f.name),
          { method: 'POST', body: f });
        const j = await r.json();
        if (!j.ok) { st.textContent = f.name + ': ' + j.error; }
      } catch (e) { st.textContent = f.name + ': ' + e.message; }
    }
    cacheAt = 0;
    render();
  }

  // ---- context injection (chat.js calls this per send) ------------------------

  async function contextFor(text) {
    if (!on() || !text || text.length < 8) return '';
    let data;
    try { data = await list(); } catch { return ''; }
    if (!data.available || !(data.docs || []).some((d) => d.status === 'ready')) return '';
    let r;
    try { r = await api('/api/docs/search', { q: text, k: TOP_K }); } catch { return ''; }
    if (!r.ok || !(r.results || []).length) return '';

    let out = "[DOCUMENTS] Excerpts from the user's local documents that match their message:";
    for (const c of r.results) {
      const src = c.name + (c.label ? ' ' + c.label : '');
      const room = CTX_CAP - out.length - src.length - 40;
      if (room < 400) break;               // no cramped scraps
      let body = c.text;
      if (body.length > room) body = body.slice(0, room) + '…';
      out += '\n--- ' + src + ' ---\n' + body;
    }
    return out + '\n--- end of excerpts ---\n'
      + 'Prefer these excerpts when answering and name the source file. If they '
      + 'do not cover the question, say so and answer from general knowledge.';
  }

  // ---- events ----------------------------------------------------------------

  $('docs-add').addEventListener('click', () => $('docs-file').click());
  $('docs-file').addEventListener('change', () => {
    const files = [...$('docs-file').files];
    $('docs-file').value = '';
    if (files.length) upload(files);
  });
  $('docs-use').addEventListener('change', () =>
    localStorage.setItem('aeye-docs', $('docs-use').checked ? '1' : '0'));
  // piggyback on the memory drawer opening (memory.js owns the modal itself)
  $('memory-btn').addEventListener('click', render);

  // ---- shared api ------------------------------------------------------------

  window.DOCS = { contextFor };
})();
