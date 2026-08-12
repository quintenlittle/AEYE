/* ================================================================
   AEYE -- image generation panel.
   Drives the diffusers backend loaded via the library. Reads the
   img pipeline status pushed from chat.js (window.IMAGINE.onStatus)
   and generates images through /api/img/generate.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let ready = false;
  let lastImage = null;

  function status(text, isErr) {
    const st = $('img-status');
    st.textContent = text;
    st.className = 'mini-status' + (isErr ? ' err' : '');
  }

  function onStatus(img) {
    ready = img && img.state === 'ready';
    const label = $('img-model-label');
    const gen = $('img-generate');
    if (!img || !img.available) {
      label.textContent = 'image support not installed — install HuggingFace support';
      gen.disabled = true;
    } else if (img.state === 'ready') {
      label.textContent = 'loaded: ' + img.model_id + '  ·  ' + (img.device || '');
      gen.disabled = false;
    } else if (img.state === 'loading') {
      label.textContent = 'loading pipeline… ' + Math.round(img.elapsed || 0) + 's';
      gen.disabled = true;
    } else if (img.state === 'busy') {
      label.textContent = 'rendering…';
      gen.disabled = true;
    } else if (img.state === 'error') {
      label.textContent = 'error — see the library / img badge';
      gen.disabled = true;
    } else {
      label.textContent = 'no image model loaded — load one from the library';
      gen.disabled = true;
    }
  }

  async function generate() {
    if (!ready) { status('load an image model from the library first', true); return; }
    const prompt = $('img-prompt').value.trim();
    if (!prompt) { status('enter a prompt', true); return; }
    const [w, h] = $('img-size').value.split('x').map(Number);
    const body = {
      prompt,
      negative: $('img-negative').value.trim(),
      steps: parseInt($('img-steps').value, 10) || 30,
      guidance: parseFloat($('img-guidance').value) || 7,
      width: w, height: h,
      seed: parseInt($('img-seed').value, 10),
    };

    $('img-generate').disabled = true;
    status('rendering… the eye is dreaming');
    EYE.setState('thinking');
    const canvas = $('img-canvas');
    canvas.textContent = '';
    canvas.classList.add('rendering');
    CHAT.refreshModels();   // reflect the 'busy' state on the badge

    try {
      const r = await (await fetch('/api/img/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
      if (r.ok === false) throw new Error(r.error);
      lastImage = r.image;

      const im = new Image();
      im.src = r.image;
      canvas.textContent = '';
      canvas.appendChild(im);
      $('img-download').href = r.image;
      $('img-download').classList.remove('hidden');
      $('img-send-chat').disabled = false;
      status('done. seed reuse: set the seed field to repeat a look.');
      EYE.setState('idle');
      EYE.blink();
    } catch (e) {
      status(e.message, true);
      EYE.setState('error');
      setTimeout(() => EYE.setState('idle'), 3500);
    } finally {
      canvas.classList.remove('rendering');
      $('img-generate').disabled = false;
      CHAT.refreshModels();
    }
  }

  // ---- view toggle: imagine occupies the chat column (eye stays visible) ----

  function showImagine() {
    if (window.DREAM) window.DREAM.showChat();   // never both panels at once
    $('chat-panel').classList.add('hidden');
    $('imagine-panel').classList.remove('hidden');
    $('imagine-btn').classList.add('on');
    if (window.IMG_STATE) onStatus(window.IMG_STATE);
    else CHAT.refreshModels();
    $('img-prompt').focus();
  }

  function showChat() {
    $('imagine-panel').classList.add('hidden');
    $('chat-panel').classList.remove('hidden');
    $('imagine-btn').classList.remove('on');
  }

  function toggle() {
    if ($('imagine-panel').classList.contains('hidden')) showImagine();
    else showChat();
  }

  $('imagine-btn').addEventListener('click', toggle);
  $('imagine-back').addEventListener('click', showChat);
  $('img-generate').addEventListener('click', generate);
  $('img-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
  });
  $('img-send-chat').addEventListener('click', () => {
    if (lastImage) {
      CHAT.addImageMessage($('img-prompt').value.trim(), lastImage);
      CHAT.note('Generated image added to the transcript.');
      showChat();
    }
  });

  window.IMAGINE = { onStatus, generate, showImagine, showChat };
})();
