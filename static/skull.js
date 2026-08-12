/* ================================================================
   AEYE -- skull backdrop (hidden-eye mode).
   When the eye is hidden (body.eye-hidden), a dim ASCII skull sits
   BEHIND the chat text; while the model streams tokens its jaw drops
   in a deliberately choppy closed->ajar->open->ajar loop (~8 fps, no
   easing -- retro on purpose). Reasoning ('thinking') and every other
   eye state stay static. Event-driven off the body[data-state]
   attribute + the eye-hidden class, so the interval only exists while
   actually animating: zero timers when idle. Frames are a pure text
   swap of the jaw <span> with a constant total line count -- no
   layout shift, no reflow of the cranium, exact monospace alignment.
   Any failure degrades to a static skull (or an empty layer); never
   an error.
   ================================================================ */
(() => {
  'use strict';

  const JAW_AT = 20;         // 0-based skull.txt line where the mandible begins
                             // (the '-:..' condyle line)
  const DROP = 2;            // rows the jaw falls at full gape
  const SEQ = [0, 1, 2, 1];  // closed -> ajar -> open -> ajar (loops)
  const MS = 125;            // ~8 fps -- choppy is intentional
  // The mandible is a rigid U (rami at the sides, chin bowl below), NOT a
  // row slice: these mouth-interior column runs [start, end) -- keyed by art
  // row offset from JAW_AT -- sit INSIDE the U and stay with the static
  // skull, so the seam follows the bone's curved outline instead of cutting
  // a straight horizontal line. Every other character from JAW_AT down is
  // jaw and moves as one block with an identical offset.
  const MOUTH = { 0: [20, 35], 1: [19, 35], 2: [19, 36] };

  const pre = document.getElementById('skull');
  if (!pre) return;

  let jawEl = null, frames = null, timer = null, step = 0;

  function frame(k) {
    jawEl.textContent = frames[k];
  }

  function build(text) {
    const lines = text.replace(/\r/g, '').replace(/\s+$/, '').split('\n');
    if (lines.length <= JAW_AT) throw new Error('skull too short');
    const W = Math.max(...lines.map((l) => l.length));
    pre.textContent = '';
    pre.append(lines.slice(0, JAW_AT).join('\n') + '\n');  // cranium: static
    jawEl = document.createElement('span');
    pre.append(jawEl);

    // split the lower block into mouth-interior (static) and jaw cells
    const lower = lines.slice(JAW_AT).map((l) => l.padEnd(W).split(''));
    const statics = Array.from({ length: lower.length + DROP },
      () => Array(W).fill(' '));
    const jaw = [];                                  // [row, col, char]
    lower.forEach((cells, r) => {
      const m = MOUTH[r];
      cells.forEach((ch, c) => {
        if (ch === ' ') return;
        if (m && c >= m[0] && c < m[1]) statics[r][c] = ch;
        else jaw.push([r, c, ch]);
      });
    });
    // pre-render every frame once (space-padded rows never collapse, so the
    // <pre> height is identical in all of them); ticking is a pure swap
    frames = [];
    for (let k = 0; k <= DROP; k++) {
      const g = statics.map((row) => row.slice());
      for (const [r, c, ch] of jaw) g[r + k][c] = ch;
      frames.push(g.map((row) => row.join('')).join('\n'));
    }
    frame(0);

    // Optical centering: the art has more empty columns on one side than the
    // other (the widest line reaches the right edge, but every line has leading
    // space), so the flex-centred block LOOKS off-centre. Nudge the whole <pre>
    // (cranium + jaw together, so alignment is untouched) by half that gap.
    // `ch` units == one monospace column, so this is font-size independent.
    const body = lines.filter((l) => l.trim().length);
    const leftGap = Math.min(...body.map((l) => l.length - l.trimStart().length));
    const rightGap = W - Math.max(...lines.map((l) => l.replace(/\s+$/, '').length));
    const shift = (leftGap - rightGap) / 2;                 // columns to move left
    if (Number.isFinite(shift) && shift) {
      pre.style.transform = 'translateX(' + (-shift).toFixed(2) + 'ch)';
    }
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    step = 0;
    try { frame(0); } catch { /* leave whatever is on screen */ }
  }

  // Piper keeps talking after the last token lands -- the jaw chatters for
  // as long as the reply is being spoken (or queued), not just streamed
  function speaking() {
    try { return !!(window.VOICE && VOICE.speakingReply()); }
    catch { return false; }
  }

  function active() {
    return frames !== null
      && document.body.classList.contains('eye-hidden')
      && !document.hidden               // throttled background tab: stand down
      && (document.body.dataset.state === 'streaming' || speaking());
  }

  function tick() {
    try {
      // no body attribute flips when the voice queue drains, so the loop
      // re-checks its own reason to exist each frame and bows out
      if (!active()) { stop(); return; }
      step = (step + 1) % SEQ.length;
      frame(SEQ[step]);
    } catch { stop(); }                 // any hiccup -> static skull, silently
  }

  function sync() {
    if (active() && !timer) timer = setInterval(tick, MS);
    else if (!active() && timer) stop();
  }

  // the eye state machine and the hide-eye toggle both mutate <body>
  // attributes -- watch those instead of polling
  new MutationObserver(sync).observe(document.body,
    { attributes: true, attributeFilter: ['data-state', 'class'] });
  document.addEventListener('visibilitychange', sync);

  fetch('/api/skull')
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then((t) => { build(t); sync(); })
    .catch(() => { /* no skull available -- the layer just stays empty */ });
})();
