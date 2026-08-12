/* ================================================================
   AEYE -- voice OUTPUT via Piper (local neural TTS only).

   Text-to-speech is synthesized on the server by Piper and played
   back in the browser. There is NO speech-to-text and NO cloud
   engine: nothing (no audio, no reply text) ever leaves this machine.

   The speaker toggle makes the eye read a reply aloud once it has
   finished generating. Pick / download voices in Manage / TTS, and try
   the fun pitch effects (goblin / demon / chipmunk / …).
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---- speaker toggle --------------------------------------------------------

  const ttsBtn = $('tts');
  let ttsOn = localStorage.getItem('aeye-tts') !== '0';   // on by default

  function paintTts() {
    ttsBtn.classList.toggle('active', ttsOn);
    ttsBtn.title = ttsOn ? 'replies are spoken aloud (click to mute)'
                         : 'speak replies aloud (local Piper TTS)';
  }

  ttsBtn.addEventListener('click', () => {
    ttsOn = !ttsOn;
    localStorage.setItem('aeye-tts', ttsOn ? '1' : '0');
    if (!ttsOn) stopSpeaking();
    paintTts();
  });
  paintTts();

  // ---- voice settings (voice / effect / rate) --------------------------------

  const voiceSel = $('tts-voice');
  const effectSel = $('tts-effect');
  const rate = $('tts-rate');
  const beeps = $('tts-beeps');
  const vstatus = $('tts-vstatus');

  const storedBeeps = parseInt(localStorage.getItem('aeye-tts-beeps'), 10);
  // out-of-the-box voice character (until the user picks their own):
  // danny-low, dalek effect, rate 0.85 -- installer pre-downloads danny
  const cfg = {
    piperVoice: localStorage.getItem('aeye-tts-pvoice') || 'en_US-danny-low',
    effect: localStorage.getItem('aeye-tts-effect') || 'dalek',
    rate: parseFloat(localStorage.getItem('aeye-tts-rate')) || 0.85,
    beepWords: Number.isFinite(storedBeeps) ? storedBeeps : 4,   // 0 = off
  };
  rate.value = cfg.rate;
  $('tts-rate-val').textContent = (+cfg.rate).toFixed(2);
  beeps.value = cfg.beepWords;
  function paintBeeps() {
    $('tts-beeps-val').textContent = cfg.beepWords > 0 ? 'every ' + cfg.beepWords : 'off';
  }
  paintBeeps();

  let piperData = null;   // { available, voices:[...], effects:[...], horror:[...] }
  let horrorEffects = []; // names of the DSP horror chains, for random shuffle

  function vstat(text, isErr) {
    vstatus.textContent = text || '';
    vstatus.className = 'mini-status' + (isErr ? ' err' : '');
  }

  async function loadPiperVoices() {
    try {
      piperData = await (await fetch('/api/tts/voices')).json();
    } catch { piperData = { available: false, voices: [] }; }
    populateEffects();
    populateVoiceSelect();
  }

  function populateEffects() {
    const effects = (piperData && piperData.effects) || ['normal'];
    horrorEffects = (piperData && piperData.horror) || [];
    // a client-side "random" mode that shuffles the horror effects (and any
    // extra downloaded voices) mid-speech, every few words
    const list = effects.slice();
    if (horrorEffects.length) list.push('random');
    const labels = { random: 'glitched' };
    effectSel.innerHTML = '';
    for (const e of list) {
      const o = document.createElement('option');
      o.value = e; o.textContent = labels[e] || e;
      effectSel.appendChild(o);
    }
    effectSel.value = list.includes(cfg.effect) ? cfg.effect : 'normal';
    cfg.effect = effectSel.value;
  }

  function populateVoiceSelect() {
    voiceSel.innerHTML = '';
    if (!piperData) { vstat('checking Piper…'); return; }
    if (!piperData.available) {
      vstat('Piper not installed — '
        + (window.extrasHint ? window.extrasHint() : 're-run install.bat')
        + ' and enable Piper TTS.', true);
      voiceSel.disabled = true;
      ttsBtn.disabled = true;
      ttsBtn.title = 'install Piper (local TTS) to hear replies';
      return;
    }
    voiceSel.disabled = false;
    ttsBtn.disabled = false;
    for (const v of piperData.voices) {
      const o = document.createElement('option');
      o.value = v.key;
      const meta = [v.accent, v.quality, v.note].filter(Boolean).join(', ');
      o.textContent = (v.downloaded ? '● ' : '○ ') + v.key + (meta ? '  (' + meta + ')' : '');
      voiceSel.appendChild(o);
    }
    voiceSel.value = cfg.piperVoice || piperData.voices[0].key;
    cfg.piperVoice = voiceSel.value;
    refreshDlButton();
  }

  function currentPiper() {
    return piperData && piperData.voices.find((v) => v.key === cfg.piperVoice);
  }
  function refreshDlButton() {
    const dlBtn = $('tts-dl');
    const delBtn = $('tts-del');
    const v = currentPiper();
    if (!v) { dlBtn.classList.add('hidden'); delBtn.classList.add('hidden'); return; }
    dlBtn.classList.toggle('hidden', v.downloaded);
    delBtn.classList.toggle('hidden', !v.downloaded);
    if (v.downloaded) vstat('● downloaded (' + v.size_mb + ' MB) — 🗑 to remove');
    else vstat('○ not downloaded (' + v.size_mb + ' MB) — click download');
  }

  voiceSel.addEventListener('change', () => {
    cfg.piperVoice = voiceSel.value;
    localStorage.setItem('aeye-tts-pvoice', cfg.piperVoice);
    refreshDlButton();
  });
  rate.addEventListener('input', () => {
    cfg.rate = parseFloat(rate.value);
    $('tts-rate-val').textContent = cfg.rate.toFixed(2);
    localStorage.setItem('aeye-tts-rate', cfg.rate);
  });
  effectSel.addEventListener('change', () => {
    cfg.effect = effectSel.value;
    localStorage.setItem('aeye-tts-effect', cfg.effect);
  });
  beeps.addEventListener('input', () => {
    cfg.beepWords = parseInt(beeps.value, 10) || 0;
    localStorage.setItem('aeye-tts-beeps', cfg.beepWords);
    paintBeeps();
  });

  // --- piper download (with polling) ---
  let dlPoll = null;
  $('tts-dl').addEventListener('click', async () => {
    const v = currentPiper();
    if (!v) return;
    vstat('downloading ' + v.key + ' (' + v.size_mb + ' MB)…');
    const r = await (await fetch('/api/tts/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: v.key }),
    })).json();
    if (r.ok === false) { vstat(r.error, true); return; }
    if (dlPoll) clearInterval(dlPoll);
    dlPoll = setInterval(async () => {
      await loadPiperVoices();
      const d = piperData.download || {};
      if (d.state === 'downloading') { vstat('downloading ' + d.key + '… ' + Math.round(d.elapsed || 0) + 's'); return; }
      clearInterval(dlPoll); dlPoll = null;
      if (d.state === 'error') vstat(d.error, true);
      else { CHAT.note('Piper voice ready: ' + v.key); refreshDlButton(); }
    }, 2000);
  });

  // --- piper delete (de-bloat) ---
  $('tts-del').addEventListener('click', async () => {
    const v = currentPiper();
    if (!v || !v.downloaded) return;
    if (!confirm('Delete the downloaded voice "' + v.key + '" (' + v.size_mb + ' MB)?')) return;
    vstat('deleting ' + v.key + '…');
    const r = await (await fetch('/api/tts/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: v.key }),
    })).json();
    if (r.ok === false) { vstat(r.error, true); return; }
    await loadPiperVoices();
    CHAT.note('Deleted voice ' + v.key + ' (freed ' + (r.freed_gb || 0).toFixed(2) + ' GB)');
  });

  $('tts-test').addEventListener('click', () =>
    speak('The eye is watching, and now the eye speaks.', true));

  // ---- speaking (Piper, streamed gaplessly via the Web Audio API) ------------

  // strip code fences / markdown noise so the readout stays clean
  function speakable(text) {
    return text
      .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' (code block) ')
      .replace(/\x60([^\x60]+)\x60/g, '$1')
      .replace(/[*_#>|~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // one AudioContext, resumed on the first user gesture (autoplay policy)
  let audioCtx = null;
  function ensureCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  ['pointerdown', 'keydown'].forEach((e) =>
    window.addEventListener(e, ensureCtx, { once: true }));

  let seq = 0;               // bump to invalidate the current stream
  let pending = '';          // reply text buffered until a chunk is ready
  let started = false;       // has the first chunk been queued this reply?
  let playhead = 0;          // ctx time where the next chunk should start
  let synthChain = Promise.resolve();   // serialize synth to preserve order
  const sources = new Set(); // scheduled BufferSource nodes (to stop on reset)
  let replyActive = false;   // a chat reply is being spoken (or queued) --
                             // the game's taunts must never talk over it

  // random "shifting voice": the horror EFFECT re-rolls at each punctuation
  // mark (the selected voice stays fixed) -- a corrupting-in-place horror
  let randFx = null;

  function pickHorror() {
    const pool = horrorEffects.length ? horrorEffects : ['normal'];
    let fx = pool[Math.floor(Math.random() * pool.length)];
    if (fx === randFx && pool.length > 1) fx = pool[(pool.indexOf(fx) + 1) % pool.length];
    randFx = fx;
    return fx;
  }

  function stopSpeaking() {
    seq++;
    pending = '';
    started = false;
    playhead = 0;
    synthChain = Promise.resolve();
    randFx = null;
    replyActive = false;
    for (const s of sources) { try { s.stop(); } catch { /* already ended */ } }
    sources.clear();
  }
  const resetStream = stopSpeaking;   // a new reply resets the pipeline

  // synth one chunk with a specific voice + effect -> decoded AudioBuffer (or null)
  async function synthChunk(text, fx, voice, flow, mySeq) {
    try {
      const res = await fetch('/api/tts/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: voice || cfg.piperVoice, text,
          length_scale: 1 / (cfg.rate || 1),   // higher rate -> shorter
          effect: fx || 'normal',
          stream: true,
          flow: !!flow,     // mid-phrase word-run -> seamless, no sentence pause
          beep_words: cfg.beepWords,
        }),
      });
      if (mySeq !== seq) return null;
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        if (res.status === 409) vstat('voice not downloaded — click download first', true);
        else vstat('Piper: ' + (msg || res.status), true);
        return null;
      }
      const raw = await res.arrayBuffer();
      const ctx = ensureCtx();
      if (!ctx || mySeq !== seq) return null;
      return await ctx.decodeAudioData(raw);
    } catch (e) {
      vstat('Piper error: ' + e.message, true);
      return null;
    }
  }

  // schedule a decoded buffer to start right after the previous one (gapless)
  function schedule(buffer, mySeq) {
    if (!buffer || mySeq !== seq) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, playhead);
    try { src.start(at); } catch { return; }
    playhead = at + buffer.duration;
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      if (!sources.size && !pending.trim()) replyActive = false;   // queue drained
    };
  }

  // queue a chunk of text: synth (kept in order) then schedule it
  function enqueue(text, opts) {
    const clean = speakable(text);
    if (!clean) return;
    started = true;
    opts = opts || {};
    const fx = opts.fx || (cfg.effect === 'random' ? 'normal' : cfg.effect) || 'normal';
    const voice = opts.voice || cfg.piperVoice;
    const flow = !!opts.flow;
    const mySeq = seq;
    synthChain = synthChain.then(async () => {
      if (mySeq !== seq) return;
      schedule(await synthChunk(clean, fx, voice, flow, mySeq), mySeq);
    });
  }

  // feed streaming reply text; speak each sentence as it completes. The first
  // chunk fires on a short threshold so speech tracks the typewriter from the
  // start; later chunks prefer whole sentences for natural phrasing.
  // Normal mode also breaks on clause marks (:;) for lower latency; random mode
  // breaks ONLY on full sentence enders and re-rolls the horror effect per one.
  const SENTENCE = /^([\s\S]*?[.!?…:;])(\s|$)/;
  const SENTENCE_END = /^([\s\S]*?[.!?…])(\s|$)/;   // random mode: whole sentences
  function feed(delta) {
    if (!ttsOn || !delta) return;
    if (!ensureCtx()) return;
    replyActive = true;               // a real reply owns the voice now
    pending += delta;
    const rand = cfg.effect === 'random';
    const re = rand ? SENTENCE_END : SENTENCE;
    let m;
    while ((m = pending.match(re))) {
      enqueue(pending.slice(0, m[1].length), rand ? { fx: pickHorror() } : undefined);
      pending = pending.slice(m[0].length);
    }
    const limit = started ? 200 : 60;   // low-latency first chunk
    if (pending.length > limit) {
      const cut = pending.lastIndexOf(' ', limit - 15);
      const chunk = cut > 20 ? pending.slice(0, cut) : pending;
      // no punctuation to ride -> flow so we don't force a phrase-final pause
      enqueue(chunk, rand ? { fx: pickHorror(), flow: true } : undefined);
      pending = pending.slice(chunk.length);
    }
  }

  function flush() {
    if (!ttsOn) return;
    if (pending.trim()) {
      const rand = cfg.effect === 'random';
      enqueue(pending, rand ? { fx: pickHorror() } : undefined);
    }
    pending = '';
  }

  // `force` bypasses the on/off toggle (used by the test button)
  function speak(text, force) {
    if ((!ttsOn && !force) || !text) return;
    stopSpeaking();
    if (cfg.effect === 'random') {   // run it through the sentence splitter
      const on = ttsOn; ttsOn = true;
      feed(text + ' '); flush();
      ttsOn = on;
    } else enqueue(text);
  }

  // speak a long passage sentence-by-sentence so playback starts fast (used by
  // the game's maxed-out easter egg). Always streams, always with the CURRENT
  // voice/effect, and bypasses the on/off toggle.
  function speakLong(text) {
    if (!text) return;
    stopSpeaking();
    const on = ttsOn; ttsOn = true;
    feed(text + ' '); flush();
    ttsOn = on;
  }

  window.VOICE = {
    speak, speakLong, stopSpeaking, feed, flush, resetStream,
    isOn: () => ttsOn,
    // true while a chat reply is queued/being read aloud -- the game's taunts
    // check this so they can speak during thinking/image-gen, but never over
    // an actual spoken reply
    speakingReply: () => replyActive,
  };

  // load the Piper voice inventory on boot
  loadPiperVoices();
})();
