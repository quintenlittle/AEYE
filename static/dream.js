/* ================================================================
   AEYE -- video generation panel ("dream").
   Drives the diffusers text-to-video backend loaded via the library.
   Reads the vid pipeline status pushed from chat.js
   (window.DREAM.onStatus) and generates clips through /api/vid/generate.
   Output is an mp4 (<video>) or an animated GIF (<img>) fallback.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let ready = false;
  let lastVideo = null;   // { url, mime }

  function status(text, isErr) {
    const st = $('vid-status');
    st.textContent = text;
    st.className = 'mini-status' + (isErr ? ' err' : '');
  }

  function onStatus(vid) {
    ready = vid && vid.state === 'ready';
    const label = $('vid-model-label');
    const gen = $('vid-generate');
    if (!vid || !vid.available) {
      label.textContent = 'video support not installed — install HuggingFace support';
      gen.disabled = true;
    } else if (vid.state === 'ready') {
      label.textContent = 'loaded: ' + vid.model_id + '  ·  ' + (vid.device || '');
      gen.disabled = false;
    } else if (vid.state === 'loading') {
      label.textContent = 'loading pipeline… ' + Math.round(vid.elapsed || 0) + 's';
      gen.disabled = true;
    } else if (vid.state === 'busy') {
      label.textContent = 'dreaming…';
      gen.disabled = true;
    } else if (vid.state === 'error') {
      label.textContent = 'error — see the library / vid badge';
      gen.disabled = true;
    } else {
      label.textContent = 'no video model loaded — load one from the library';
      gen.disabled = true;
    }
  }

  function renderClip(canvas, url, mime) {
    canvas.textContent = '';
    if (mime === 'video/mp4') {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true; v.autoplay = true; v.loop = true; v.muted = true;
      v.playsInline = true;
      canvas.appendChild(v);
    } else {                         // animated GIF fallback
      const im = new Image();
      im.src = url;
      canvas.appendChild(im);
    }
  }

  async function generate() {
    if (!ready) { status('load a video model from the library first', true); return; }
    const prompt = $('vid-prompt').value.trim();
    if (!prompt) { status('enter a prompt', true); return; }
    const [w, h] = $('vid-size').value.split('x').map(Number);
    const body = {
      prompt,
      negative: $('vid-negative').value.trim(),
      steps: parseInt($('vid-steps').value, 10) || 25,
      guidance: parseFloat($('vid-guidance').value) || 7,
      num_frames: parseInt($('vid-frames').value, 10) || 16,
      fps: parseInt($('vid-fps').value, 10) || 8,
      width: w || 0, height: h || 0,
      seed: parseInt($('vid-seed').value, 10),
    };

    $('vid-generate').disabled = true;
    status('dreaming… video takes a while — hang tight');
    EYE.setState('thinking');
    const canvas = $('vid-canvas');
    canvas.textContent = '';
    canvas.classList.add('rendering');
    CHAT.refreshModels();   // reflect the 'busy' state on the badge

    try {
      const r = await (await fetch('/api/vid/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
      if (r.ok === false) throw new Error(r.error);
      lastVideo = { url: r.video, mime: r.mime };

      renderClip(canvas, r.video, r.mime);
      const dl = $('vid-download');
      dl.href = r.video;
      dl.download = r.mime === 'video/mp4' ? 'aeye.mp4' : 'aeye.gif';
      dl.classList.remove('hidden');
      $('vid-send-chat').disabled = false;
      status('done. reuse the seed to keep a look; raise frames for longer clips.');
      EYE.setState('idle');
      EYE.blink();
    } catch (e) {
      status(e.message, true);
      EYE.setState('error');
      setTimeout(() => EYE.setState('idle'), 3500);
    } finally {
      canvas.classList.remove('rendering');
      $('vid-generate').disabled = false;
      CHAT.refreshModels();
    }
  }

  // ---- view toggle: dream occupies the chat column (eye stays visible) ----

  function showDream() {
    if (window.IMAGINE) window.IMAGINE.showChat();   // never both panels at once
    $('chat-panel').classList.add('hidden');
    $('dream-panel').classList.remove('hidden');
    $('dream-btn').classList.add('on');
    if (window.VID_STATE) onStatus(window.VID_STATE);
    else CHAT.refreshModels();
    $('vid-prompt').focus();
  }

  function showChat() {
    $('dream-panel').classList.add('hidden');
    $('chat-panel').classList.remove('hidden');
    $('dream-btn').classList.remove('on');
  }

  function toggle() {
    if ($('dream-panel').classList.contains('hidden')) showDream();
    else showChat();
  }

  $('dream-btn').addEventListener('click', toggle);
  $('dream-back').addEventListener('click', showChat);
  $('vid-generate').addEventListener('click', generate);
  $('vid-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
  });
  $('vid-send-chat').addEventListener('click', () => {
    if (lastVideo) {
      CHAT.addVideoMessage($('vid-prompt').value.trim(), lastVideo.url, lastVideo.mime);
      CHAT.note('Generated video added to the transcript.');
      showChat();
    }
  });

  window.DREAM = { onStatus, generate, showDream, showChat };
})();
