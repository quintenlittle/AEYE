/* ================================================================
   AEYE -- voice INPUT via local Whisper (faster-whisper).

   The mic button records from your microphone and transcribes the
   clip on the server's /api/stt endpoint. 100% on-device -- the model
   downloads once, then nothing (no audio) ever leaves this machine,
   mirroring the local-only stance of Piper TTS on the output side.

   While recording you get a LIVE preview: the audio-so-far is
   re-transcribed roughly once a second and shown in the chat box, so
   you can watch what it's about to send. With "auto-send" on, it stops
   itself on ~2 s of silence (or ~7 s total) and sends automatically;
   otherwise click the mic again to stop and drop the text in the box.
   ================================================================ */
(() => {
  'use strict';

  const btn = document.getElementById('mic');
  if (!btn) return;

  let available = false;
  let recording = false;
  let busy = false;              // final transcription in flight
  let warmed = false;
  let autoSend = localStorage.getItem('aeye-autosend') === '1';
  let hotkey = localStorage.getItem('aeye-mic-hotkey') === '1';

  let recorder = null, stream = null, chunks = [], mime = '';
  let base = '';                 // composer text from before dictation started
  let interimTimer = null, interimBusy = false;
  let audioCtx = null, vadTimer = null;

  const INTERIM_MS = 1100;       // how often to refresh the live preview
  const SILENCE_MS = 2000;       // auto-send: stop after this much trailing silence
  const MAX_TOTAL_MS = 7000;     // auto-send: hard cap on one utterance
  const VAD_TICK = 100, START_RMS = 0.02;

  // ---- helpers ---------------------------------------------------------------

  function paint() {
    btn.classList.toggle('recording', recording);
    btn.classList.toggle('busy', busy);
    if (!available) {
      btn.disabled = true;
      btn.title = 'install speech-to-text (local Whisper) to dictate — '
        + (window.extrasHint ? window.extrasHint() : 're-run install.bat');
    } else if (recording) {
      btn.title = autoSend ? 'listening… stops on silence (or click to cut short)'
                           : 'listening… click to stop and transcribe';
    } else if (busy) {
      btn.title = 'transcribing locally…';
    } else {
      btn.title = 'dictate with your mic (local Whisper — nothing leaves this machine)';
    }
  }

  function pickMime() {
    const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const m of prefs) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  // POST the audio-so-far, return the transcript text ('' = silence, null = error)
  async function postAudio(blob) {
    try {
      const r = await fetch('/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      const data = await r.json();
      if (data.ok === false) { CHAT.note('Speech-to-text: ' + (data.error || 'failed'), true); return null; }
      return (data.text || '').trim();
    } catch (e) {
      CHAT.note('Speech-to-text error: ' + e.message, true);
      return null;
    }
  }

  const withBase = (text) => (base ? base + ' ' : '') + text;

  // ---- recording lifecycle ---------------------------------------------------

  async function start() {
    if (busy) return;
    if (!warmed) { warmed = true; fetch('/api/stt/warm', { method: 'POST' }).catch(() => {}); }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { CHAT.note('Microphone access denied or unavailable (' + e.name + ').', true); return; }

    base = CHAT.inputValue().trim();
    chunks = [];
    mime = pickMime();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = finalize;
    recorder.start(250);                       // 250 ms chunks -> growing buffer
    recording = true;
    paint();

    // live preview: re-transcribe the buffer-so-far ~once a second
    interimTimer = setInterval(async () => {
      if (interimBusy || !recording || !chunks.length) return;
      interimBusy = true;
      const text = await postAudio(new Blob(chunks, { type: mime || 'audio/webm' }));
      interimBusy = false;
      if (recording && text) CHAT.dictate(withBase(text), true);
    }, INTERIM_MS);

    if (autoSend) startVad();                  // hands-free stop on silence/timer
  }

  function startVad() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      audioCtx.resume().catch(() => {});       // fresh contexts start suspended
      const src = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const startT = performance.now();
      let lastLoudT = startT, heardSpeech = false;
      vadTimer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const level = Math.sqrt(s / buf.length);
        const now = performance.now();
        if (level > START_RMS) { lastLoudT = now; heardSpeech = true; }
        if (now - startT > MAX_TOTAL_MS || (heardSpeech && now - lastLoudT > SILENCE_MS)) stop();
      }, VAD_TICK);
    } catch { /* no analyser -> falls back to manual click-to-stop */ }
  }

  function cleanup() {
    if (interimTimer) { clearInterval(interimTimer); interimTimer = null; }
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  function stop() {
    if (!recorder || recorder.state === 'inactive') return;
    recording = false;
    paint();
    try { recorder.stop(); } catch { /* already stopping */ }   // -> finalize()
  }

  async function finalize() {
    cleanup();
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    chunks = [];
    if (!blob.size) { CHAT.dictate(base, false); paint(); return; }
    busy = true; paint();
    const text = await postAudio(blob);
    busy = false;
    if (text) {
      CHAT.dictate(withBase(text), false);
      if (autoSend && !CHAT.isBusy()) setTimeout(() => CHAT.submit(), 60);
    } else {
      CHAT.dictate(base, false);               // restore box; silence or error
      if (text === '') CHAT.note('Heard only silence — nothing to transcribe.');
    }
    paint();
  }

  btn.addEventListener('click', () => {
    if (!available || busy) return;
    if (recording) stop(); else start();
  });

  // ---- init ------------------------------------------------------------------

  async function init() {
    const auto = document.getElementById('stt-autosend');
    if (auto) {
      auto.checked = autoSend;
      auto.addEventListener('change', () => {
        autoSend = auto.checked;
        localStorage.setItem('aeye-autosend', autoSend ? '1' : '0');
      });
    }
    const hk = document.getElementById('stt-hotkey');
    if (hk) {
      hk.checked = hotkey;
      hk.addEventListener('change', () => {
        hotkey = hk.checked;
        localStorage.setItem('aeye-mic-hotkey', hotkey ? '1' : '0');
      });
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) { available = false; paint(); return; }
    try { available = !!(await (await fetch('/api/stt/info')).json()).available; }
    catch { available = false; }
    paint();
  }

  // Space toggles the mic when the hotkey is on. To never fight with typing,
  // STARTING only fires when nothing (esp. the chat box) is focused; while
  // already recording, Space always stops (the composer holds focus then).
  window.addEventListener('keydown', (e) => {
    if (!hotkey || !available || e.code !== 'Space' || e.repeat) return;
    if (!recording) {
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae.tagName !== 'HTML') return;   // busy typing/interacting
    }
    e.preventDefault();
    btn.click();                     // reuses the button's start/stop + guards
  });

  init();
})();
