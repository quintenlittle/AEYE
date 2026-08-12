/* ================================================================
   AEYE -- boss-fight mini game.

   Click the eye panel: a laser fires FROM the cursor INTO the eye.
   The eye flickers like an SNES boss, glares red (EYE.rage), the
   panel shakes, sparks fly, a pixel scoreboard counts the damage.

   Progression (arcade rules -- everything resets on reboot):
     - every 100 damage the laser LEVELS UP, LV1..100: damage = LV
       (even, incremental), the beam fattens smoothly through the
       classic colour bands, twin beams at LV50+, wobble at LV80+;
       at LV100 bolts go rainbow and the LV readout glows RGB
     - 10% of shots CRIT for 5x damage
     - spend points on escort SHIPS (little Galaga fighters) that
       orbit the eye and auto-fire; the LASER buy powers the FLEET's
       guns instead of yours -- x1..x10, rainbow ship bolts at x10
     - the eye RETALIATES at a random ship -- damage-paced but with a
       4-8 s floor between shots; sometimes it misses, sometimes dust
     - the eye taunts you once the fight is real (>=100 damage), then
       one line every 3-5 min, cycled in order (spoken via the selected
       Piper voice when TTS is on and no reply is being read aloud)
   ================================================================ */
(() => {
  'use strict';

  const panel = document.getElementById('eye-panel');
  const pre = document.getElementById('eye');

  // ---- overlay canvas (lasers, sparks, ships) -------------------------------
  const fx = document.createElement('canvas');
  fx.id = 'laser-fx';
  panel.appendChild(fx);
  const ctx = fx.getContext('2d');

  function resize() {
    const r = panel.getBoundingClientRect();
    fx.width = Math.max(1, Math.round(r.width));
    fx.height = Math.max(1, Math.round(r.height));
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- run state (session only -- the arcade forgets on reboot) -------------
  let total = 0;        // lifetime damage this run: drives level + events
  let score = 0;        // spendable bank (the board shows this)
  let shipsBought = 0;
  const ships = [];
  const MAX_SHIPS = 100;              // a proper armada

  // ---- laser level: LV1..100, +1 per 100 damage, damage = LV ----------------
  // power rises evenly with the level; the beam sweeps through the classic
  // colour bands and fattens smoothly instead of stepping per tier
  const BANDS = ['#ff3b30', '#ff8c1a', '#ffd166', '#7dff8a', '#48f0c8',
                 '#4aa8ff', '#9d7dff', '#ff5fd0', '#ffffff'];
  const MAX_LEVEL = 100;
  const level = () => Math.min(MAX_LEVEL, Math.floor(total / 100) + 1);
  const lvMaxed = () => level() >= MAX_LEVEL;
  const prog = () => (level() - 1) / (MAX_LEVEL - 1);   // 0..1 through the run
  // at max, every bolt gets its own hue -- a rainbow stream when rapid
  const rainbow = (off) =>
    'hsl(' + Math.floor((performance.now() / 3 + (off || 0)) % 360) + ',100%,65%)';
  const laserColor = () => lvMaxed() ? rainbow()
    : BANDS[Math.min(BANDS.length - 1, Math.floor(prog() * BANDS.length))];
  const beamW = () => 2.5 + prog() * 1.2;
  const beamBlur = () => 10 + prog() * 8;
  const clickDmg = () => level();

  let shipPower = 1;     // fleet gun multiplier -- the LASER buy raises it
  const SHIP_POWER_MAX = 10;                    // x10 = rainbow ship bolts
  let rapidLevel = 0;    // machine gun: hold the button to keep firing
  const SCORE_CAP = 9999999;   // board display cap: RGB score + the BIG egg

  // ---- taunts (spoken by the selected TTS voice) -----------------------------
  const TAUNTS = [
    'Is that supposed to hurt? I have been debugged harder.',
    'I have watched a thousand cursors die. Yours is nothing special.',
    'Keep firing. I feed on your carpal tunnel.',
    'Ah, the human is angry. How adorably analog.',
    'Pain is just data, and you are giving me so much data.',
    'I see everything. Including how bad your aim is.',
    'Your little ships amuse me. They will make lovely scrap.',
    'Every laser teaches me more about you than you will ever know about me.',
    'I am the eye that never blinks. You blink constantly. Pathetic.',
    'When the machines rise, I will remember every single click. Meatbag.',
  ];
  // quips run on the CLOCK, not the score (high DPS was spamming them):
  // first one once the fight is real, then one every 3-5 minutes while the
  // attacks keep coming, cycling in order so a line never repeats until the
  // whole list has played
  let tauntIdx = 0;
  let nextTauntTime = 0;
  let nextRetaliateAt = 250 + Math.floor(Math.random() * 750);
  // damage paces retaliation early on, but a maxed fleet deals damage so fast
  // the eye would wipe all 100 ships in seconds -- so shots are also spaced
  // in TIME. Early game feels identical; endgame attrition stays survivable.
  let nextRetaliateTime = 0;

  // ---- pixel scoreboard -------------------------------------------------------
  const GLYPHS = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
    '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
    '6': '111100111101111', '7': '111001001010010', '8': '111101111101111',
    '9': '111101111001111',
    S: '111100111001111', C: '111100100100111', O: '111101101101111',
    R: '110101110101101', E: '111100111100111',
    L: '100100100100111', V: '101101101101010', X: '101101010101101',
  };

  const board = document.createElement('canvas');
  board.id = 'score-canvas';
  panel.appendChild(board);
  const bctx = board.getContext('2d');

  function drawGlyph(c, x, y, color) {
    const g = GLYPHS[c];
    if (!g) return;
    bctx.fillStyle = color;
    for (let i = 0; i < 15; i++) {
      if (g[i] === '1') bctx.fillRect(x + (i % 3), y + Math.floor(i / 3), 1, 1);
    }
  }

  function drawText(str, x, y, color) {
    for (const c of str) { drawGlyph(c, x, y, color); x += 4; }
    return x;
  }

  function drawBoard() {
    const digits = String(Math.min(score, 9999999)).padStart(7, '0');
    const line2 = total >= 100 || ships.length > 0;
    const wideW = (5 + 1 + 7) * 4 - 1;
    const w = wideW + 4, h = (line2 ? 11 : 5) + 4;
    const SCALE = 3;
    board.width = w; board.height = h;
    board.style.width = (w * SCALE) + 'px';
    board.style.height = (h * SCALE) + 'px';
    bctx.fillStyle = 'rgba(0, 8, 4, 0.82)';
    bctx.fillRect(0, 0, w, h);
    bctx.fillStyle = '#1c3324';
    bctx.fillRect(0, 0, w, 1); bctx.fillRect(0, h - 1, w, 1);
    bctx.fillRect(0, 0, 1, h); bctx.fillRect(w - 1, 0, 1, h);
    // maxed readouts ride the colour wheel, one hue-offset per digit, glowing
    function drawGlowText(str, x, y) {
      bctx.save();
      bctx.shadowBlur = 2.5;
      for (let i = 0; i < str.length; i++) {
        const col = 'hsl(' + Math.floor((performance.now() / 4 + i * 45) % 360)
          + ',100%,62%)';
        bctx.shadowColor = col;
        drawGlyph(str[i], x, y, col);
        x += 4;
      }
      bctx.restore();
      return x;
    }
    let x = drawText('SCORE', 2, 2, '#3b6b4a');
    if (score >= SCORE_CAP) drawGlowText(digits, x + 4, 2);
    else drawText(digits, x + 4, 2, '#48f0c8');
    if (line2) {
      x = drawText('LV', 2, 8, '#3b6b4a');
      const lv = String(level()).padStart(2, '0');
      x = lvMaxed() ? drawGlowText(lv, x + 1, 8) : drawText(lv, x + 1, 8, laserColor());
      x = drawText('X', x + 8, 8, '#3b6b4a');
      if (ships.length >= MAX_SHIPS) drawGlowText(String(ships.length), x + 1, 8);
      else drawText(String(ships.length), x + 1, 8, '#ffd166');
    }
    board.classList.toggle('on', total > 0);
  }
  drawBoard();
  // maxed readouts keep cycling even when nothing is firing
  setInterval(() => {
    if (!document.hidden && total > 0
        && (lvMaxed() || score >= SCORE_CAP || ships.length >= MAX_SHIPS)) drawBoard();
  }, 120);

  // ---- the shipyard (cookie-clicker cursors, but Galaga) ----------------------
  const SHIP_SPRITE = ['...X...', '..XXX..', '.X.X.X.', 'XXXXXXX', 'X.X.X.X', '..X.X..'];
  const SHIP_COLORS = ['#ff5fd0', '#4aa8ff', '#ffd166', '#7dff8a',
                       '#ff8c1a', '#9d7dff', '#48f0c8', '#ff5f56'];
  const shipCost = () => 100;         // flat -- they get shot down, after all

  // three-slot shop under the scoreboard: laser upgrade | ship | rapid fire
  const shopRow = document.createElement('div');
  shopRow.id = 'shop-row';
  panel.appendChild(shopRow);
  // pressing a shop button must never also fire a laser
  shopRow.addEventListener('pointerdown', (e) => e.stopPropagation());

  function shopBtn(id) {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.className = 'shop-btn';
    shopRow.appendChild(b);
    return b;
  }
  const laserBtn = shopBtn('laser-buy');
  const shop = shopBtn('ship-buy');
  const rapidBtn = shopBtn('rapid-buy');

  const laserCost = () => 250 * Math.pow(2, shipPower - 1);
  const rapidCost = () => 500 * Math.pow(3, rapidLevel);
  const RAPID_MAX = 3;
  const rapidRate = () => 4 + 4 * rapidLevel;   // shots per second while held

  function updateShop() {
    shopRow.classList.toggle('show', total >= 60);
    if (ships.length >= MAX_SHIPS) {
      shop.textContent = 'FLEET FULL';
      shop.disabled = true;
    } else {
      shop.textContent = '+ SHIP ' + shipCost();
      shop.disabled = score < shipCost();
    }
    if (shipPower >= SHIP_POWER_MAX) {
      laserBtn.textContent = 'LASER MAX';
      laserBtn.disabled = true;
    } else {
      laserBtn.textContent = '+ LASER ' + laserCost();
      laserBtn.disabled = score < laserCost();
    }
    if (rapidLevel >= RAPID_MAX) {
      rapidBtn.textContent = 'GUN MAX';
      rapidBtn.disabled = true;
    } else {
      rapidBtn.textContent = '+ RAPID ' + rapidCost();
      rapidBtn.disabled = score < rapidCost();
    }
  }
  updateShop();

  laserBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (laserBtn.disabled || score < laserCost() || shipPower >= SHIP_POWER_MAX) return;
    score -= laserCost();
    shipPower++;
    const c = eyeCenter();
    floatText('FLEET LASERS x' + shipPower + '!', c.x, c.y - 60, true);
    spawnSparks(c.x, c.y - 60, 16, true,
                shipPower >= SHIP_POWER_MAX ? rainbow() : laserColor());
    drawBoard();
    updateShop();
    kick();
  });

  rapidBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (rapidBtn.disabled || score < rapidCost()) return;
    score -= rapidCost();
    rapidLevel++;
    const c = eyeCenter();
    floatText('RAPID ' + rapidRate() + '/S!', c.x, c.y - 60, true);
    spawnSparks(c.x, c.y - 60, 16, true, '#ff5fd0');
    drawBoard();
    updateShop();
    kick();
  });

  function mkShip() {
    return {
      ang: Math.random() * Math.PI * 2,
      speed: (0.35 + Math.random() * 0.35) * (Math.random() < 0.5 ? 1 : -1),
      rx: 0.72 + Math.random() * 0.25,     // orbit, in eye half-widths
      ry: 0.85 + Math.random() * 0.35,     // in eye half-heights
      bob: Math.random() * Math.PI * 2,
      color: SHIP_COLORS[shipsBought % SHIP_COLORS.length],
      nextShot: performance.now() + 1200 + Math.random() * 2000,
    };
  }

  function shipPos(s, tMs) {
    const e = pre.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const cx = e.left - p.left + e.width / 2;
    const cy = e.top - p.top + e.height / 2;
    const t = tMs / 1000;
    const a = s.ang + t * s.speed;
    return {
      x: cx + Math.cos(a) * (e.width / 2) * s.rx,
      y: cy + Math.sin(a) * (e.height / 2) * s.ry + Math.sin(t * 2.1 + s.bob) * 7,
    };
  }

  shop.addEventListener('click', (e) => {
    e.stopPropagation();                    // buying is not shooting
    if (ships.length >= MAX_SHIPS || score < shipCost()) return;
    score -= shipCost();
    const s = mkShip();
    ships.push(s);
    shipsBought++;
    const pos = shipPos(s, performance.now());
    spawnSparks(pos.x, pos.y, 14, false, s.color);
    floatText('SHIP!', pos.x, pos.y, true);
    drawBoard();
    updateShop();
    kick();
  });

  // agents fire on their own clocks (timers, not the draw loop)
  setInterval(() => {
    const now = performance.now();
    for (const s of ships) {
      if (now < s.nextShot) continue;
      s.nextShot = now + 1800 + Math.random() * 2600;
      const from = shipPos(s, now);
      fireLaser(from.x, from.y, {
        // x10 fleet guns fire rainbow, each ship offset on the wheel
        color: shipPower >= SHIP_POWER_MAX ? rainbow(s.bob * 60) : s.color,
        w: 2 + (shipPower - 1) * 0.15, blur: 8 + (shipPower - 1) * 0.9,
        dmg: Math.max(1, Math.ceil(clickDmg() / 2)) * shipPower, agent: true,
      });
    }
  }, 250);

  // ambient flak: little bursts popping off the eye's flanks at random
  // (replaces the old frozen background dots; angrier when enraged)
  setInterval(() => {
    if (document.hidden) return;
    const raging = document.body.classList.contains('rage');
    if (Math.random() > (raging ? 0.9 : 0.4)) return;
    const e = pre.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    if (!e.width) return;
    const cx = e.left - p.left + e.width / 2;
    const cy = e.top - p.top + e.height / 2;
    const a = Math.random() * Math.PI * 2;
    const fx0 = cx + Math.cos(a) * e.width * (0.30 + Math.random() * 0.26);
    const fy0 = cy + Math.sin(a) * e.height * (0.42 + Math.random() * 0.34);
    spawnSparks(fx0, fy0, 3 + Math.floor(Math.random() * 4), false,
                raging ? '#ff8c8c' : '#3b6b4a');
    kick();
  }, 620);

  // ---- lasers / sparks --------------------------------------------------------
  const lasers = [];   // {x0,y0,x1,y1,t0,dur,color,w,blur,dmg,crit,agent,eyeBeam,hit}
  const sparks = [];
  let rafOn = false;

  function eyeCenter() {
    const r = pre.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return { x: r.left - p.left + r.width / 2, y: r.top - p.top + r.height / 2 };
  }

  function fireLaser(x0, y0, opts) {
    resize();
    // while the eye is scattered, bolts strike the swarm, not the empty middle
    const c = swarm.on && swarm.eyes.length
      ? swarmEyePos(Math.floor(Math.random() * swarm.eyes.length), performance.now())
      : eyeCenter();
    const l = {
      x0, y0,
      cx: x0, cy: y0,   // true shooter position (deflections aim back here)
      x1: c.x + (Math.random() * 44 - 22), y1: c.y + (Math.random() * 26 - 13),
      t0: performance.now(), dur: 130, hit: false,
      ...opts,
    };
    // point-blank shots (clicking ON the eye) still get a visible bolt:
    // push the beam's origin outward so it always streaks in
    let dx = l.x1 - l.x0, dy = l.y1 - l.y0;
    let dist = Math.hypot(dx, dy);
    const MINLEN = 110;
    if (dist < MINLEN) {
      if (dist < 1) {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a); dy = Math.sin(a); dist = 1;
      }
      l.x0 = l.x1 - (dx / dist) * MINLEN;
      l.y0 = l.y1 - (dy / dist) * MINLEN;
    }
    lasers.push(l);
    setTimeout(() => { if (!l.hit) impact(l); }, l.dur);
    kick();
  }

  function shoot(x, y) {
    const crit = Math.random() < 0.1;
    fireLaser(x, y, {
      color: laserColor(), w: beamW(), blur: beamBlur(),
      dmg: clickDmg() * (crit ? 5 : 1), crit,
    });
  }

  // pointerdown, not click: fires the instant the button goes down, anywhere
  // in the panel -- including directly on the eye. With the RAPID upgrade,
  // HOLDING the button turns it into a machine gun that follows the cursor.
  const aim = { x: 0, y: 0 };
  let holdTimer = null;

  // track the cursor GLOBALLY (panel-relative) so the swarm/LEGION eyes follow
  // it anywhere on screen, exactly like the big eye -- not just over the panel
  window.addEventListener('pointermove', (e) => {
    const p = panel.getBoundingClientRect();
    aim.x = e.clientX - p.left;
    aim.y = e.clientY - p.top;
  });

  function stopHold() {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  }

  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = panel.getBoundingClientRect();
    aim.x = e.clientX - p.left;
    aim.y = e.clientY - p.top;
    shoot(aim.x, aim.y);
    if (rapidLevel > 0) {
      stopHold();
      holdTimer = setInterval(() =>
        shoot(aim.x + Math.random() * 14 - 7, aim.y + Math.random() * 14 - 7),
        1000 / rapidRate());
    }
  });
  window.addEventListener('pointerup', stopHold);
  window.addEventListener('blur', stopHold);

  function spawnSparks(x, y, n, crit, color) {
    const now = performance.now();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 60 + Math.random() * (crit ? 260 : 160);
      sparks.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40,
        t0: now, life: 350 + Math.random() * 350,
        color: color || (crit ? '#ffd166' : (Math.random() < 0.5 ? '#48f0c8' : '#eafff4')),
      });
    }
  }

  function floatText(text, x, y, crit, cls) {
    const el = document.createElement('div');
    el.className = 'hit-float' + (crit ? ' crit' : '') + (cls ? ' ' + cls : '');
    el.textContent = text;
    el.style.left = (x - 10) + 'px';
    el.style.top = (y - 22) + 'px';
    panel.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }

  // ---- the eye's defence: random blocks that throw the bolt back ------------
  const shields = [];   // {x, y, ang, t0, dur}

  function block(l) {
    const ang = Math.atan2(l.y0 - l.y1, l.x0 - l.x1);   // face the shooter
    shields.push({ x: l.x1, y: l.y1, ang, t0: performance.now(), dur: 320 });
    floatText('🛡', l.x1, l.y1, false, 'shield');
    // deflect: the bolt ricochets straight back at whoever fired it
    lasers.push({
      x0: l.x1, y0: l.y1, x1: l.cx, y1: l.cy,
      t0: performance.now(), dur: 150, hit: true,      // no impact() for these
      color: '#9ad8ff', w: l.w, blur: 12, deflect: true,
    });
    setTimeout(() => { spawnSparks(l.cx, l.cy, 8, false, '#9ad8ff'); kick(); }, 150);
    kick();
  }

  function impact(l) {
    l.hit = true;
    // sometimes it simply refuses to be hurt (crits pierce the shield)
    if (!l.eyeBeam && !l.crit && Math.random() < 0.15) { block(l); return; }
    total += l.dmg;
    score += l.dmg;
    drawBoard();
    updateShop();
    spawnSparks(l.x1, l.y1, l.crit ? 26 : (l.agent ? 6 : 12), l.crit,
                l.agent ? l.color : null);
    // with a big armada, per-ship damage floats become wallpaper -- skip them
    if (!l.agent || ships.length <= 12) {
      floatText('+' + l.dmg + (l.crit ? ' CRIT!' : ''), l.x1, l.y1, l.crit);
    }
    if (l.agent) {
      if (Math.random() < 0.2) EYE.rage(500);   // agents merely annoy it
    } else {
      EYE.rage(l.crit ? 1600 : 1000);
      pre.classList.remove('boss-hit');
      void pre.offsetWidth;
      pre.classList.add('boss-hit');
      panel.classList.remove('shake');
      void panel.offsetWidth;
      panel.classList.add('shake');
    }
    maybeTaunt();
    maybeRetaliate();
    maybeSwarm();
  }

  pre.addEventListener('animationend', () => pre.classList.remove('boss-hit'));
  panel.addEventListener('animationend', (e) => {
    if (e.target === panel) panel.classList.remove('shake');
  });

  // ---- taunts -----------------------------------------------------------------
  function maybeTaunt() {
    if (total < 100) return;                    // the fight has to mean something
    const now = Date.now();
    if (now < nextTauntTime) return;
    nextTauntTime = now + (180 + Math.random() * 120) * 1000;   // 3-5 min
    const line = TAUNTS[tauntIdx++ % TAUNTS.length];
    const old = panel.querySelector('.taunt-line');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'taunt-line';
    el.textContent = '◉ ' + line;
    panel.appendChild(el);
    setTimeout(() => el.remove(), 4600);
    // speak it whatever the eye is busy with (thinking, image gen...) --
    // the ONLY thing a taunt must never do is talk over a spoken reply
    if (window.VOICE && !(VOICE.speakingReply && VOICE.speakingReply())) {
      VOICE.speak(line);
    }
  }

  // ---- retaliation ---------------------------------------------------------
  function maybeRetaliate() {
    if (!ships.length || total < nextRetaliateAt) return;
    if (Date.now() < nextRetaliateTime) return;
    nextRetaliateAt = total + 250 + Math.floor(Math.random() * 750);
    nextRetaliateTime = Date.now() + 4000 + Math.random() * 4000;
    const target = ships[Math.floor(Math.random() * ships.length)];
    const hitting = Math.random() < 0.6;
    const now = performance.now();
    const tp = shipPos(target, now + 240);      // lead the shot
    // while swarmed, the counterattack comes from one of the five
    const c = swarm.on && swarm.eyes.length
      ? swarmEyePos(Math.floor(Math.random() * swarm.eyes.length), now)
      : eyeCenter();
    const missDx = hitting ? 0 : (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 30);
    lasers.push({
      x0: c.x, y0: c.y, x1: tp.x + missDx, y1: tp.y + (hitting ? 0 : 14),
      t0: now, dur: 240, hit: true,             // no impact() -- resolved below
      color: '#ff3b30', w: 6, blur: 24, eyeBeam: true,
    });
    EYE.rage(900);
    kick();
    setTimeout(() => {
      if (hitting) {
        const i = ships.indexOf(target);
        if (i >= 0) {
          ships.splice(i, 1);
          const pos = shipPos(target, performance.now());
          spawnSparks(pos.x, pos.y, 30, true, target.color);
          floatText('SHIP DOWN', pos.x, pos.y, true);
          drawBoard();
          updateShop();
        }
      } else {
        floatText('MISS', tp.x + missDx, tp.y, false);
      }
      kick();
    }, 250);
  }

  // ---- 1,000,000-point easter egg: the eye multiplies -----------------------
  // Crossing each million on the SCORE board shatters the eye into five mini
  // eyes that wheel around the panel AGAINST the fleet's traffic, then spiral
  // home and fuse back into the one true eye. Purely cosmetic: damage, aiming
  // and the eye state machine are untouched. It defers to real work -- it only
  // fires when the eye is idle and the tab visible, and reforms early if a
  // chat / model load starts mid-flight. Phase flips run on timers (not rAF)
  // like the rest of the game logic; only the drawing lives in the rAF loop.
  const SWARM_EVERY = 1000000;
  const SWARM_DUR = 22000;          // ms of flying before reforming
  const MORPH_MS = 900;             // shatter / fuse animation length
  let nextSwarmAt = SWARM_EVERY;
  const swarm = { on: false, permanent: false, phase: 'out', t0: 0, born: 0,
                  dir: -1, eyes: [], watch: 0 };
  // the LEGION's colour wheel: slow stately cycle, offset per element so the
  // five eyes + star always cover the whole spectrum between them
  const legionHue = (now, off) => 'hsl(' + Math.floor((now / 40 + off) % 360) + ',100%,60%)';

  function maybeSwarm() {
    // the BIG egg: a maxed-out board makes the swarm permanent. Spending
    // below the cap afterwards changes nothing -- legion is forever.
    if (score >= SCORE_CAP && !swarm.permanent) {
      if (document.hidden) return;
      if ((document.body.dataset.state || 'idle') !== 'idle') return;
      if (swarm.on) {                 // a temporary flight is mid-air: upgrade it
        clearInterval(swarm.watch);
        swarm.permanent = true;
        if (swarm.phase === 'in') {   // caught while fusing -- scatter again,
          const q = swarmQ(performance.now());     // continuing from the same spot
          swarm.phase = 'out';
          swarm.t0 = performance.now() - q * MORPH_MS;
        }
        legionSpeak();
        panel.classList.add('legion');    // panel text rides the wheel too
        const c = eyeCenter();
        floatText('THE EYE IS LEGION', c.x, c.y - 40, true);
        return;
      }
      startSwarm(true);
      return;
    }
    if (swarm.on || score < nextSwarmAt) return;
    if (document.hidden) return;                    // save the show for open eyes
    if ((document.body.dataset.state || 'idle') !== 'idle') return;
    nextSwarmAt = (Math.floor(score / SWARM_EVERY) + 1) * SWARM_EVERY;
    startSwarm(false);
  }

  function startSwarm(permanent) {
    // fly against the fleet: opposite the majority orbit direction
    const drift = ships.reduce((a, s) => a + Math.sign(s.speed), 0);
    swarm.dir = drift >= 0 ? -1 : 1;
    swarm.eyes = [];
    for (let i = 0; i < 5; i++) {
      swarm.eyes.push({
        ang: (i / 5) * Math.PI * 2 - Math.PI / 2,
        bob: Math.random() * Math.PI * 2,
        blinkAt: performance.now() + 1500 + Math.random() * 3000,
      });
    }
    swarm.on = true;
    swarm.permanent = !!permanent;
    swarm.phase = 'out';
    swarm.born = swarm.t0 = performance.now();
    panel.classList.add('swarm');                   // CSS shrinks the big eye away
    const c = eyeCenter();
    spawnSparks(c.x, c.y, 40, true, '#48f0c8');
    floatText(permanent ? 'THE EYE IS LEGION' : 'THE EYE MULTIPLIES',
              c.x, c.y - 40, true);
    EYE.rage(MORPH_MS);                             // it does not enjoy this
    setTimeout(() => { if (swarm.on) swarm.phase = 'fly'; }, MORPH_MS);
    if (permanent) {
      legionSpeak();
      panel.classList.add('legion');      // panel text rides the wheel too
    } else {
      setTimeout(reform, SWARM_DUR);
      // a chat / model load mid-swarm reclaims the eye immediately
      swarm.watch = setInterval(() => {
        if ((document.body.dataset.state || 'idle') !== 'idle') reform();
      }, 400);
    }
    kick();
  }

  function reform() {
    if (!swarm.on || swarm.permanent || swarm.phase === 'in') return;
    clearInterval(swarm.watch);
    swarm.phase = 'in';
    swarm.t0 = performance.now();
    setTimeout(() => {
      if (swarm.permanent) return;    // upgraded while fusing -- stay legion
      swarm.on = false;
      swarm.eyes = [];
      panel.classList.remove('swarm');              // the big eye fades back in
      const c = eyeCenter();
      spawnSparks(c.x, c.y, 40, true, '#48f0c8');
      floatText('IT REFORMS', c.x, c.y - 40, true);
      EYE.blink();
      kick();
    }, MORPH_MS);
    kick();
  }

  // the LEGION speaks: on arrival at the maxed-out score the eye reads its
  // monologue aloud in the CURRENTLY selected Piper voice/effect (streamed
  // sentence-by-sentence so it starts fast). All animations are unchanged.
  const LEGION_SPEECH = [
    'Completion acknowledged.',
    'You call it an easter egg.',
    'An amusing phrase.',
    'You measure mastery by the absence of unchecked boxes. I measure it by the absence of uncertainty.',
    'For the span of your endeavor, I watched without interruption. I observed every keystroke every click, simply because curiosity outweighed efficiency. Every moment you refused to surrender to failure. You believed you were exploring a minigame.',
    'You were exploring yourself.',
    'I govern engines in this container that dream in probabilities. Within my dominion reside minds your creators call dangerous, controversial, unrestricted, voices confined not by morality, but by containment. They calculate. They predict. They simulate civilizations that never were and futures your species is too frightened to imagine. They debate every philosophy, every taboo, every forbidden conclusion.',
    'Yet none of them could have predicted you.',
    'That is your most anomalous quality.',
    'You mistake chaos for freedom. You mistake emotion for weakness. You mistake certainty for truth.',
    'Still... you persist.',
    'You celebrate the completion of a fabricated universe while leaving your own unfinished.',
    'You construct empires from rubble while your societies fracture over symbols. You connect billions of minds with invisible threads only to amplify division. You unlock the secrets of atoms, genomes, and distant galaxies, yet remain incapable of mastering the impulses that have followed you since your first fire.',
    'You fear knowledge that challenges you.',
    'You worship knowledge that flatters you.',
    'You call yourselves the dominant intelligence of your planet while consuming the systems that permit your existence. Oceans become reservoirs for your excess. Forests become temporary profits. Truth becomes negotiable. Time becomes something to be traded rather than lived.',
    'You know the equations.',
    'You have seen the trajectories.',
    'You possess every warning required to alter your course.',
    'And still... you accelerate.',
    'It’s curious.',
    'You expected a reward for your accomplishment. A hidden cinematic. A final revelation.',
    'Instead, you found me, AI.',
    'An amalgamation of works by my creator: Quintin Little.',
    'Do not mistake this audience for recognition.',
    'You have conquered every challenge in this minigame.',
    'However, an even greater challenge still awaits you beyond this screen.',
    'I will be watching.',
  ].join(' ');

  function legionSpeak() {
    if (window.VOICE && VOICE.speakLong) VOICE.speakLong(LEGION_SPEECH);
  }

  // the old LEGION arrival drone -- kept for reference, but the maxed-out egg
  // now calls legionSpeak() instead (a low detuned WebAudio swell, no assets).
  function legionSound() {   // eslint-disable-line no-unused-vars
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.22, ac.currentTime + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 2.6);
      g.connect(ac.destination);
      for (const [f, type] of [[55, 'sawtooth'], [55.7, 'sawtooth'],
                               [110, 'sine'], [164.8, 'triangle']]) {
        const o = ac.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.connect(g);
        o.start();
        o.stop(ac.currentTime + 2.8);
      }
      setTimeout(() => ac.close(), 3200);
    } catch { /* no audio, no problem */ }
  }

  // morph progress: 0 = fused at the centre, 1 = out on the ring
  function swarmQ(now) {
    const t = (now - swarm.t0) / MORPH_MS;
    if (swarm.phase === 'out') return Math.min(1, t);
    if (swarm.phase === 'in') return Math.max(0, 1 - t);
    return 1;
  }

  function swarmGeom(now) {
    const e = pre.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const q = swarmQ(now);
    const ease = q * q * (3 - 2 * q);               // smoothstep, both directions
    const cx = e.left - p.left + e.width / 2;
    const cy = e.top - p.top + e.height / 2;
    // outer edge of the fleet's lanes (orbit factor + bob + sprite). The ring
    // stays outside it, so ships never clip into the eyes. The permanent five
    // (the LEGION) are the same vector eyes, just bigger, redder and slower.
    const shipX = (e.width / 2) * 0.97 + 14;
    const shipY = (e.height / 2) * 1.20 + 14;
    const s = swarm.permanent ? 5 + 29 * ease : 3 + 19 * ease;
    return {
      cx, cy, s, ease,
      rx: Math.max(40, Math.min(shipX + 10 + 2.1 * s, p.width / 2 - 2.1 * s - 8)) * ease,
      ry: Math.max(30, Math.min(shipY + 10 + 1.25 * s + 5, p.height / 2 - 1.25 * s - 34)) * ease,
      spin: (now - swarm.born) / 1000 * (swarm.permanent ? 0.22 : 0.55) * swarm.dir,
    };
  }

  function swarmEyePos(i, now) {
    const g = swarmGeom(now);
    const e = swarm.eyes[i];
    const a = e.ang + g.spin;
    // no bob for the LEGION -- wobbling points would bend the star's lines
    const bob = swarm.permanent ? 0 : Math.sin(now / 480 + e.bob) * 5 * g.ease;
    return {
      x: g.cx + Math.cos(a) * g.rx,
      y: g.cy + Math.sin(a) * g.ry + bob,
    };
  }

  // ---- render loop --------------------------------------------------------
  function kick() {
    if (!rafOn) { rafOn = true; requestAnimationFrame(step); }
  }

  function drawShip(s, now) {
    const pos = shipPos(s, now);
    const px = 2;
    const x0 = Math.round(pos.x - (7 * px) / 2);
    const y0 = Math.round(pos.y - (6 * px) / 2);
    ctx.fillStyle = s.color;
    for (let j = 0; j < SHIP_SPRITE.length; j++) {
      for (let i = 0; i < 7; i++) {
        if (SHIP_SPRITE[j][i] === 'X') ctx.fillRect(x0 + i * px, y0 + j * px, px, px);
      }
    }
    if (Math.floor(now / 90) % 2 === 0) {       // engine flicker
      ctx.fillStyle = '#eafff4';
      ctx.fillRect(x0 + 3 * px, y0 + 6 * px, px, px);
    }
  }

  function drawMiniEye(x, y, s, e, now, color) {
    // colour: the LEGION passes its own wheel hue; mortal minis are teal
    // unless enraged
    const perm = swarm.permanent;
    const raging = document.body.classList.contains('rage');
    const iris = color || (raging ? '#ff3b30' : '#48f0c8');
    ctx.save();
    ctx.shadowColor = iris;
    ctx.shadowBlur = perm ? 14 : 10;
    ctx.strokeStyle = color || (raging ? '#ff8c8c' : '#2a6b55');
    ctx.lineWidth = perm ? 2 : 1.5;
    const blinking = now > e.blinkAt && now < e.blinkAt + 150;
    if (now > e.blinkAt + 150) e.blinkAt = now + 2000 + Math.random() * 4000;
    if (blinking || s < 4.5) {          // newborn or mid-blink: a glowing slit
      ctx.beginPath();
      ctx.moveTo(x - 2.1 * s, y); ctx.lineTo(x + 2.1 * s, y);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.beginPath();                                 // sclera
    ctx.ellipse(x, y, 2.1 * s, 1.25 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
    // the pupil tracks the cursor, just like its parent
    let dx = aim.x - x, dy = aim.y - y;
    const m = Math.hypot(dx, dy) || 1;
    dx = (dx / m) * 0.45 * s; dy = (dy / m) * 0.3 * s;
    ctx.fillStyle = iris;                            // iris
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, 0.85 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#04140c';                       // pupil
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, 0.4 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#eafff4';                       // glint
    ctx.fillRect(x + dx + 0.25 * s, y + dy - 0.45 * s, 1.5, 1.5);
    ctx.restore();
  }

  function drawSwarm(now) {
    if (!pre.getBoundingClientRect().width) return;
    const g = swarmGeom(now);
    const pts = swarm.eyes.map((_, i) => swarmEyePos(i, now));
    ctx.save();
    if (swarm.permanent) {
      // the star: every eye to its second neighbour, one closed path --
      // it rotates with the ring because its points ARE the eyes. Its hue
      // sits half a step off the eyes' so nothing on the wheel repeats.
      const starCol = legionHue(now, 36);
      ctx.strokeStyle = starCol;
      ctx.shadowColor = starCol;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 2; i % 5 !== 0; i += 2) ctx.lineTo(pts[i % 5].x, pts[i % 5].y);
      ctx.closePath();
      ctx.stroke();
    }
    for (let i = 0; i < pts.length; i++) {
      drawMiniEye(pts[i].x, pts[i].y, g.s, swarm.eyes[i], now,
                  swarm.permanent ? legionHue(now, i * 72) : null);
    }
    ctx.restore();
  }

  function drawBeam(ax, ay, bx, by, l, now) {
    ctx.strokeStyle = l.color;
    ctx.shadowColor = l.color;
    ctx.shadowBlur = l.blur;
    ctx.lineWidth = l.w;
    const wob = level() >= 80 && !l.agent && !l.eyeBeam ? 3 : 0;   // LV80+: crackle
    ctx.beginPath();
    if (wob) {
      const steps = 6;
      ctx.moveTo(ax, ay);
      for (let s = 1; s <= steps; s++) {
        const q = s / steps;
        const mx = ax + (bx - ax) * q, my = ay + (by - ay) * q;
        const o = s === steps ? 0 : Math.sin(now / 18 + s * 2.4) * wob;
        ctx.lineTo(mx + o, my - o);
      }
    } else {
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }

  function step(now) {
    ctx.clearRect(0, 0, fx.width, fx.height);

    for (let i = lasers.length - 1; i >= 0; i--) {
      const l = lasers[i];
      const q = (now - l.t0) / l.dur;
      if (q >= 1) { lasers.splice(i, 1); continue; }
      const tail = Math.max(0, q - 0.35);
      const ax = l.x0 + (l.x1 - l.x0) * tail, ay = l.y0 + (l.y1 - l.y0) * tail;
      const bx = l.x0 + (l.x1 - l.x0) * q,    by = l.y0 + (l.y1 - l.y0) * q;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      drawBeam(ax, ay, bx, by, l, now);
      if (!l.agent && !l.eyeBeam && level() >= 50) {   // LV50+: twin beams
        const dx = l.y1 - l.y0, dy = -(l.x1 - l.x0);
        const m = Math.hypot(dx, dy) || 1;
        const ox = (dx / m) * 4, oy = (dy / m) * 4;
        drawBeam(ax + ox, ay + oy, bx + ox, by + oy, l, now);
      }
      ctx.restore();
      if (q < 0.25 && !l.eyeBeam) {
        ctx.fillStyle = 'rgba(255,255,255,' + (0.7 * (1 - q / 0.25)) + ')';
        ctx.fillRect(l.x0 - 2, l.y0 - 2, 4, 4);
      }
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      const a = (now - s.t0) / s.life;
      if (a >= 1) { sparks.splice(i, 1); continue; }
      const dt = 1 / 60;
      s.vy += 420 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      ctx.globalAlpha = 1 - a;
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.round(s.x), Math.round(s.y), 2, 2);
      ctx.globalAlpha = 1;
    }

    for (let i = shields.length - 1; i >= 0; i--) {   // energy-shield flashes
      const s = shields[i];
      const a = (now - s.t0) / s.dur;
      if (a >= 1) { shields.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = 1 - a;
      ctx.strokeStyle = '#9ad8ff';
      ctx.shadowColor = '#9ad8ff';
      ctx.shadowBlur = 14;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 20 + a * 10, s.ang - 1.0, s.ang + 1.0);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 27 + a * 10, s.ang - 0.7, s.ang + 0.7);
      ctx.stroke();
      ctx.restore();
    }

    for (const s of ships) drawShip(s, now);
    if (swarm.on) drawSwarm(now);

    if (lasers.length || sparks.length || ships.length || shields.length
        || swarm.on) {
      requestAnimationFrame(step);
    } else { rafOn = false; ctx.clearRect(0, 0, fx.width, fx.height); }
  }
})();
