/* ================================================================
   AEYE -- startup model picker.

   Models are NO LONGER auto-loaded on boot (loading chat + image + video
   at once ate a lot of RAM). Instead this asks the server what the last-used
   model per category was (and whether it's still cached), and offers a small
   popup to restore only what the user wants. Nothing cached to restore ->
   no popup. Choices go to /api/autoload; the badges then come up as usual.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const CATS = [
    { key: 'chat',  label: 'Chat model' },
    { key: 'image', label: 'Image generation' },
    { key: 'video', label: 'Video generation' },
  ];

  async function init() {
    let opts;
    try { opts = await (await fetch('/api/autoload/options')).json(); }
    catch { return; }                       // server not ready -> just skip

    const rows = CATS
      .map((c) => ({ ...c, o: opts[c.key] }))
      .filter((c) => c.o && c.o.available && c.o.cached && c.o.model);
    if (!rows.length) return;               // nothing restorable -> no popup

    const host = $('startup-options');
    host.innerHTML = '';
    for (const r of rows) {
      const lab = document.createElement('label');
      lab.className = 'startup-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.key = r.key;
      const txt = document.createElement('span');
      txt.className = 'startup-label';
      const strong = document.createElement('b');
      strong.textContent = r.label;
      const sub = document.createElement('span');
      sub.className = 'startup-model';
      sub.textContent = r.o.model;
      txt.appendChild(strong);
      txt.appendChild(sub);
      lab.appendChild(cb);
      lab.appendChild(txt);
      host.appendChild(lab);
    }
    $('startup-modal').classList.remove('hidden');
  }

  function wire() {
    const load = $('startup-load');
    const skip = $('startup-skip');
    if (load) load.addEventListener('click', async () => {
      const sel = { chat: false, image: false, video: false };
      document.querySelectorAll('#startup-options input[type=checkbox]').forEach((cb) => {
        if (cb.checked) sel[cb.dataset.key] = true;
      });
      $('startup-modal').classList.add('hidden');
      if (sel.chat || sel.image || sel.video) {
        try {
          await fetch('/api/autoload', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sel),
          });
          if (window.CHAT) CHAT.refreshModels();   // start watching the badges
        } catch { /* ignore -- user can load from the library */ }
      }
    });
    if (skip) skip.addEventListener('click', () => $('startup-modal').classList.add('hidden'));
    init();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
