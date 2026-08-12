/* ================================================================
   AEYE -- procedural ASCII eye.

   Every animation frame a 78x30 character grid is re-rendered into
   <pre id="eye">. Nothing is pre-drawn: the almond outline, iris
   striations, pupil, glints and eyelids are all computed per-cell,
   which is what lets the pupil glide smoothly after the cursor.

   Behaviours:
     - iris tracks the mouse cursor anywhere in the window
     - wanders on its own when the mouse goes quiet
     - blinks at random (sometimes twice), click the eye to force one
     - pupil dilates when the cursor comes near, and when "thinking"
     - iris slowly rotates while a model loads or thinks
     - shimmers while streaming tokens, veins appear on error
     - falls asleep (lids droop, slow breathing) after 4 min idle

   Public API (used by chat.js):
     EYE.setState('idle'|'thinking'|'streaming'|'loading'|'refreshing'|'error'|'asleep')
     EYE.glance(domElement, ms)   -- briefly look at an element
     EYE.blink()
   ================================================================ */
(() => {
  'use strict';

  // ---- grid geometry ---------------------------------------------------
  const W = 78, H = 30;
  const SX = 2.35 / W;        // world units per column
  const SY = SX * 2.05;       // per row (a character cell is ~2x taller)

  const IRIS_R  = 0.355;      // iris radius, world units
  const MAX_OFF = 0.40;       // how far the iris may travel from centre

  const SCLERA_RAMP = ' .,:;=+';
  const IRIS_RAMP   = ' .:-=+*#%@';

  const pre      = document.getElementById('eye');
  const statusEl = document.getElementById('eye-status');

  const STATUS = {
    idle:       '◉ WATCHING',
    thinking:   '◉ THINKING…',
    streaming:  '◉ SPEAKING',
    loading:    '◉ LOADING WEIGHTS…',
    refreshing: '◉ SCANNING THE HUB…',
    error:      '◉ ERROR',
    asleep:     '◌ ASLEEP',
  };
  const PUPIL = {               // resting pupil radius per state
    idle: 0.13, thinking: 0.21, streaming: 0.16,
    loading: 0.19, refreshing: 0.17, error: 0.09, asleep: 0.13,
  };

  const eye = {
    state: 'idle',
    look:   { x: 0, y: 0 },     // current iris offset
    target: { x: 0, y: 0 },     // idle-wander destination
    glance: null,               // temporary override { x, y, until }
    open: 1, openTarget: 1,     // eyelid openness 0..1
    pupil: 0.13, pupilBase: 0.13,
    spin: 0,                    // iris rotation phase
    rageUntil: 0,               // > now: furious (lasered by the user)
    mouse: null,
    lastMouse: performance.now(),
    lastFrame: performance.now(),
  };

  // Optional frame-rate cap (settings > Display). 0 = uncapped: the loop
  // runs at the display's native rate via requestAnimationFrame. A cap makes
  // the paints fewer and more evenly spaced -- steadier under main-thread
  // contention (a model generating) and lighter on CPU/GPU. Animations are
  // dt-based (exp smoothing + spin), so a lower rate keeps the same SPEED,
  // just fewer sample points.
  let frameInterval = 0;
  (function initFps() {
    const s = parseInt(localStorage.getItem('aeye-fps'), 10);
    if (s >= 10 && s < 60) frameInterval = 1000 / s;   // 60+ / unset => uncapped
  })();

  // deterministic per-cell noise, 0..1 (stable => no frame-to-frame sizzle)
  function n2(i, j) {
    let h = (i * 374761393 + j * 668265263) ^ 2654435761;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // no background dots at all -- the ambience comes from game.js's flak
  // bursts instead (user request: remove the flickering lights, keep flak)
  function bgChar() { return ' '; }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // ---- behaviours --------------------------------------------------------

  function blink(double) {
    eye.openTarget = 0;
    setTimeout(() => { if (eye.state !== 'asleep') eye.openTarget = 1; }, 90);
    if (double) setTimeout(() => blink(false), 280);
  }

  (function scheduleBlink() {
    setTimeout(() => {
      if (eye.state !== 'asleep') blink(Math.random() < 0.18);
      scheduleBlink();
    }, 2800 + Math.random() * 4200);
  })();

  (function wander() {          // look around on its own when idle
    setTimeout(() => {
      if (performance.now() - eye.lastMouse > 3500 && eye.state === 'idle') {
        const a = Math.random() * Math.PI * 2;
        const r = 0.1 + Math.random() * 0.28;
        eye.target = { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.5 };
      }
      wander();
    }, 1200 + Math.random() * 2800);
  })();

  setInterval(() => {           // doze off when nobody is around
    if (eye.state === 'idle' && performance.now() - eye.lastMouse > 240000) {
      EYE.setState('asleep');
    }
  }, 5000);

  document.addEventListener('mousemove', (e) => {
    eye.mouse = { x: e.clientX, y: e.clientY };
    eye.lastMouse = performance.now();
    if (eye.state === 'asleep') EYE.setState('idle');   // wake up
  });

  // (clicking the eye used to force a blink -- the boss-fight game owns
  //  clicks now: shooting it point-blank is a right, not a pat)

  // ---- render loop -------------------------------------------------------

  function frame(now) {
    if (eye.hidden) { eye.rafPending = false; return; }   // paused: no GPU work
    // frame-rate cap: skip this rAF tick if we painted too recently. lastFrame
    // is only advanced on real paints, so dt spans the skipped ticks and the
    // physics stay correct. (-1ms tolerance so a 60Hz display still hits 60.)
    if (frameInterval && now - eye.lastFrame < frameInterval - 1) {
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.05, (now - eye.lastFrame) / 1000);
    eye.lastFrame = now;
    const t = now / 1000;
    const rect = pre.getBoundingClientRect();

    // 1. decide where to look
    let tx = eye.target.x, ty = eye.target.y;
    if (eye.glance && now < eye.glance.until) {
      tx = eye.glance.x; ty = eye.glance.y;
    } else if (eye.mouse && now - eye.lastMouse < 3500 && rect.width > 0) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      tx = (eye.mouse.x - cx) / (rect.width * 0.7);
      ty = (eye.mouse.y - cy) / (rect.width * 0.7) * 0.85;
    }
    const mag = Math.hypot(tx, ty);
    if (mag > MAX_OFF) { tx *= MAX_OFF / mag; ty *= MAX_OFF / mag; }
    ty = Math.max(-0.20, Math.min(0.20, ty));
    const k = 1 - Math.exp(-dt * 9);
    eye.look.x += (tx - eye.look.x) * k;
    eye.look.y += (ty - eye.look.y) * k;
    if (!Number.isFinite(eye.look.x) || !Number.isFinite(eye.look.y)) {
      eye.look.x = eye.look.y = 0;   // a zero-size frame must never stick
    }

    // 2. eyelids + pupil dynamics
    if (eye.state === 'asleep') {
      eye.openTarget = 0.07 + 0.035 * Math.sin(t * 0.8);   // slow breathing
    }
    const raging = eye.rageUntil && now < eye.rageUntil;
    if (eye.rageUntil && !raging) {                        // rage just expired
      eye.rageUntil = 0;
      document.body.classList.remove('rage');
      if (eye.state !== 'asleep') eye.openTarget = 1;
      statusEl.textContent = STATUS[eye.state];
    }
    if (raging) {
      eye.openTarget = 0.5;                                // narrowed glare
      statusEl.textContent = '◉ ENRAGED';
    }
    eye.open += (eye.openTarget - eye.open) * (1 - Math.exp(-dt * 16));

    let pt = eye.pupilBase;
    if (eye.state === 'thinking')  pt += 0.015 * Math.sin(t * 3.1);
    if (eye.state === 'streaming') pt += 0.025 * Math.sin(t * 7);
    if (eye.mouse &&
        eye.mouse.x > rect.left - 40 && eye.mouse.x < rect.right + 40 &&
        eye.mouse.y > rect.top - 40 && eye.mouse.y < rect.bottom + 40) {
      pt += 0.035;                                          // proximity dilation
    }
    if (raging) pt = 0.07;                                  // furious pinprick pupil
    eye.pupil += (pt - eye.pupil) * (1 - Math.exp(-dt * 6));

    if (eye.state === 'thinking' || eye.state === 'loading') eye.spin += dt * 1.6;
    if (eye.state === 'refreshing') eye.spin += dt * 0.9;   // lazy scan spin
    if (raging) eye.spin += dt * 5;                         // seething iris

    // 3. paint the grid
    const PR = eye.pupil;
    const lx = eye.look.x, ly = eye.look.y;
    const gx  = lx - IRIS_R * 0.42, gy  = ly - IRIS_R * 0.55; // main glint
    const g2x = lx + IRIS_R * 0.30, g2y = ly + IRIS_R * 0.38; // counter-glint
    const shimmer = eye.state === 'streaming' ? t * 5 : 0;

    let html = '', run = '', runCls = null;
    const flush = () => {
      if (!run) return;
      html += runCls ? '<span class="' + runCls + '">' + esc(run) + '</span>' : esc(run);
      run = '';
    };
    const put = (ch, cls) => {
      if (cls !== runCls) { flush(); runCls = cls; }
      run += ch;
    };

    for (let j = 0; j < H; j++) {
      const yw = (j - (H - 1) / 2) * SY;
      for (let i = 0; i < W; i++) {
        const xw = (i - (W - 1) / 2) * SX;
        const xn = xw / 1.12;                      // -1..1 across the eye
        let f = 1 - xn * xn;
        if (f <= 0) { put(bgChar(i, j, t), 'bg'); continue; }
        f = Math.pow(f, 0.72);

        const top = eye.open * 0.64 * f;                     // upper lid
        const bot = (0.10 + 0.90 * eye.open) * 0.50 * f;     // lower lid

        if (yw < -top || yw > bot) {
          // outside the aperture: draw the lid edge if we're close to it
          const edge = Math.min(Math.abs(yw + top), Math.abs(yw - bot));
          if (edge < SY * 0.95) put(yw < 0 ? '-' : '_', 'lid');
          else put(bgChar(i, j, t), 'bg');
          continue;
        }

        const dx = xw - lx, dy = yw - ly;
        const d = Math.hypot(dx, dy);

        // glints render on top of both pupil and iris
        if (d < IRIS_R) {
          if (Math.hypot(xw - gx, yw - gy) < 0.075) { put('@', 'glint'); continue; }
          if (Math.hypot(xw - g2x, yw - g2y) < 0.035) { put('*', 'glint2'); continue; }
        }

        if (d < PR) {                              // ---- pupil
          put('█', 'pupil');
          continue;
        }

        if (d < IRIS_R) {                          // ---- iris
          const tr = (d - PR) / (IRIS_R - PR);     // 0 inner .. 1 outer
          const ang = Math.atan2(dy, dx);
          let v = 0.82 - tr * 0.50;                              // radial falloff
          v += 0.16 * Math.sin(ang * 14 + eye.spin * 3 + tr * 8);      // striations
          v += 0.08 * Math.sin(ang * 5 - eye.spin * 2 + tr * 20 + shimmer);
          v += (n2(i, j) - 0.5) * 0.10;                          // grain
          if (tr > 0.86) v = 0.97;                               // limbal ring
          if (tr < 0.10) v = Math.max(v, 0.85);                  // pupil rim
          const idx = Math.max(1, Math.min(IRIS_RAMP.length - 1,
            Math.round(v * (IRIS_RAMP.length - 1))));
          put(IRIS_RAMP[idx], 'iris');
          continue;
        }

        // ---- sclera: brightest mid-aperture, shaded toward the lids
        if (eye.state === 'error' && n2(i * 3 + 1, j * 5 + 2) > 0.94) {
          put('~', 'vein');                        // bloodshot
          continue;
        }
        const lidProx = Math.min((top + yw) / (top || 1e-6),
                                 (bot - yw) / (bot || 1e-6));
        let b = 0.30 + 0.55 * Math.max(0, Math.min(1, lidProx));
        b += (n2(i, j) - 0.5) * 0.12;
        const si = Math.max(0, Math.min(SCLERA_RAMP.length - 1,
          Math.round(b * (SCLERA_RAMP.length - 1))));
        put(SCLERA_RAMP[si], 'sclera');
      }
      flush();
      runCls = null;
      html += '\n';
    }
    flush();
    pre.innerHTML = html;
    requestAnimationFrame(frame);
  }

  // ---- public API --------------------------------------------------------

  window.EYE = {
    // `label` overrides the default status text for this state instance (e.g.
    // the web loop reuses 'refreshing' but shows "SEARCHING THE WEB…" instead of
    // the catalog-refresh "SCANNING THE HUB…"). The eye's color/pupil still come
    // from the state itself.
    setState(s, label) {
      if (!(s in PUPIL)) return;
      if (eye.state !== s) {
        eye.state = s;
        eye.pupilBase = PUPIL[s];
        eye.openTarget = s === 'asleep' ? 0.08 : 1;
        document.body.dataset.state = s;
      }
      statusEl.textContent = label || STATUS[s];
    },
    glance(el, ms = 900) {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = pre.getBoundingClientRect();
      if (!p.width) return;
      const cx = p.left + p.width / 2, cy = p.top + p.height / 2;
      eye.glance = {
        x: (r.left + r.width / 2 - cx) / (p.width * 0.7),
        y: (r.top + r.height / 2 - cy) / (p.width * 0.7) * 0.85,
        until: performance.now() + ms,
      };
    },
    blink,
    // cap the animation frame rate (settings slider). n>=60 (or bad) = uncapped.
    setFps(n) {
      n = Math.round(+n);
      frameInterval = (Number.isFinite(n) && n < 60) ? 1000 / Math.max(10, n) : 0;
      localStorage.setItem('aeye-fps', frameInterval ? Math.max(10, n) : 60);
    },
    rage(ms = 1000) {           // SNES-boss damage reaction (used by game.js)
      eye.rageUntil = performance.now() + ms;
      document.body.classList.add('rage');
    },
    // hide + suspend all eye rendering (saves GPU). The chat expands to fill
    // the freed space via body.eye-hidden in the CSS.
    setHidden(hidden) {
      eye.hidden = !!hidden;
      document.body.classList.toggle('eye-hidden', eye.hidden);
      if (!hidden && !eye.rafPending) {         // resume the loop
        eye.rafPending = true;
        eye.lastFrame = performance.now();
        requestAnimationFrame(frame);
      }
    },
    isHidden: () => !!eye.hidden,
  };

  eye.rafPending = true;
  requestAnimationFrame(frame);
})();
