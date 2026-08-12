/* ================================================================
   AEYE -- themes & UI (manage > settings).
   Presets: dark (the :root default in style.css), light, oled, high
   contrast -- switched by setting data-theme on <html>. A CUSTOM theme
   is four user colors (primary/accent/background/text) expanded by
   buildVars() into the full palette and applied as inline CSS variables
   on <html>, which beats every preset block. Everything persists in
   localStorage: 'aeye-theme' (preset name), 'aeye-theme-custom' (the
   four colors), 'aeye-theme-vars' (the computed map -- replayed by the
   inline boot snippet in index.html before first paint, so there is
   never a flash of the wrong theme).
   Contrast guard: text is auto-pushed toward black/white until it
   reads at WCAG 4.5:1 on the chosen background (3:1 for the accent).
   Eye-state colors (body[data-state]) sit on <body>, so they keep
   overriding any theme -- the eye's moods survive every palette.
   ================================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  const PRESETS = ['dark', 'light', 'oled', 'contrast', 'custom'];
  const VAR_KEYS = ['--bg', '--panel', '--line', '--fg', '--dim', '--sclera',
    '--iris', '--pupil', '--glint', '--lid', '--vein', '--accent',
    '--hover', '--row-line', '--well', '--user-line', '--overlay', '--scanline'];
  // custom-creator fields -> the palette var each one seeds from
  const FIELDS = { primary: '--iris', accent: '--accent', bg: '--bg', fg: '--fg' };

  // ---- color math ------------------------------------------------------------

  const hex2rgb = (h) => {
    h = h.replace('#', '');
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgb2hex = (r, g, b) => '#' + [r, g, b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
    .join('');
  const mix = (a, b, t) => {
    const [r1, g1, b1] = hex2rgb(a), [r2, g2, b2] = hex2rgb(b);
    return rgb2hex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
  };
  const lum = (h) => {
    const [r, g, b] = hex2rgb(h).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  // push `color` toward black/white (whichever helps) until it reads on `bg`
  const ensure = (color, bg, min) => {
    if (contrast(color, bg) >= min) return color;
    const target = lum(bg) > 0.5 ? '#000000' : '#ffffff';
    for (let t = 0.1; t <= 1; t += 0.1) {
      const c = mix(color, target, t);
      if (contrast(c, bg) >= min) return c;
    }
    return target;
  };

  const normHex = (v) => {
    v = (v || '').trim().toLowerCase();
    if (/^#?[0-9a-f]{3}$/.test(v) || /^#?[0-9a-f]{6}$/.test(v))
      return rgb2hex(...hex2rgb(v));
    return null;
  };

  // ---- custom palette --------------------------------------------------------

  // expand the four picked colors into the whole variable set; text and
  // accent are contrast-guarded against the chosen background
  function buildVars(cfg) {
    const bg = cfg.bg, dark = lum(bg) < 0.5;
    const fg = ensure(cfg.fg, bg, 4.5);
    const accent = ensure(cfg.accent, bg, 3);
    const [r, g, b] = hex2rgb(bg);
    return {
      vars: {
        '--bg': bg,
        '--panel': mix(bg, fg, 0.05),
        '--well': mix(bg, fg, 0.035),
        '--hover': mix(bg, fg, 0.09),
        '--row-line': mix(bg, fg, 0.12),
        '--line': mix(bg, fg, 0.22),
        '--dim': mix(bg, fg, 0.34),
        '--lid': mix(bg, fg, 0.45),
        '--sclera': mix(bg, fg, 0.62),
        '--fg': fg,
        '--accent': accent,
        '--iris': ensure(cfg.primary, bg, 2),
        '--pupil': dark ? mix(bg, '#000000', 0.7) : mix(cfg.primary, '#000000', 0.8),
        '--glint': dark ? mix(fg, '#ffffff', 0.6) : mix(fg, '#000000', 0.3),
        '--user-line': mix(bg, accent, 0.45),
        '--vein': dark ? '#ff5f56' : '#c62d23',
        '--overlay': 'rgba(' + r + ', ' + g + ', ' + b + ', 0.78)',
        '--scanline': dark ? 'rgba(0, 0, 0, 0.14)' : 'rgba(0, 0, 0, 0.045)',
      },
      adjusted: fg !== cfg.fg || accent !== cfg.accent,
    };
  }

  // the dark palette's seeds, used for reset + as the fallback custom start
  const DEFAULT_CUSTOM = { primary: '#48f0c8', accent: '#48f0c8', bg: '#060a07', fg: '#b8ffcf' };

  function loadCustom() {
    try {
      const c = JSON.parse(localStorage.getItem('aeye-theme-custom') || '');
      const out = {};
      for (const k in FIELDS) {
        out[k] = normHex(c[k]);
        if (!out[k]) return null;
      }
      return out;
    } catch { return null; }
  }

  // seed the creator from whatever palette is on screen right now
  function seedCustom() {
    const cs = getComputedStyle(root);
    const out = {};
    for (const k in FIELDS) out[k] = normHex(cs.getPropertyValue(FIELDS[k])) || DEFAULT_CUSTOM[k];
    return out;
  }

  // ---- apply -----------------------------------------------------------------

  function apply(name, cfg) {
    for (const k of VAR_KEYS) root.style.removeProperty(k);
    if (name === 'dark') root.removeAttribute('data-theme');
    else root.dataset.theme = name;
    let adjusted = false;
    if (name === 'custom') {
      const built = buildVars(cfg);
      adjusted = built.adjusted;
      for (const k in built.vars) root.style.setProperty(k, built.vars[k]);
      localStorage.setItem('aeye-theme-custom', JSON.stringify(cfg));
      // cache the computed map for the pre-paint boot snippet
      localStorage.setItem('aeye-theme-vars', JSON.stringify(built.vars));
    }
    localStorage.setItem('aeye-theme', name);
    return adjusted;
  }

  // ---- ui --------------------------------------------------------------------

  const note = (t) => { $('theme-note').textContent = t || ''; };

  function markPreset(name) {
    document.querySelectorAll('.theme-pick').forEach((b) =>
      b.classList.toggle('on', b.dataset.theme === name));
    $('theme-custom').classList.toggle('hidden', name !== 'custom');
  }

  function fillInputs(cfg) {
    for (const k in FIELDS) {
      $('theme-' + k).value = cfg[k];
      $('theme-' + k + '-hex').value = cfg[k];
    }
  }

  function cfgFromInputs() {
    const out = {};
    for (const k in FIELDS) out[k] = normHex($('theme-' + k).value) || DEFAULT_CUSTOM[k];
    return out;
  }

  function applyCustomFromInputs() {
    const adjusted = apply('custom', cfgFromInputs());
    markPreset('custom');
    note(adjusted ? 'text/accent auto-adjusted to stay readable on that background' : 'saved');
  }

  // preset buttons
  document.querySelectorAll('.theme-pick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.theme;
      if (name === 'custom') {
        const cfg = loadCustom() || seedCustom();
        fillInputs(cfg);
        const adjusted = apply('custom', cfg);
        note(adjusted ? 'text/accent auto-adjusted to stay readable on that background' : '');
      } else {
        apply(name);
        note('');
      }
      markPreset(name);
    });
  });

  // color pickers + hex twins (either edits the other; both apply live)
  for (const k in FIELDS) {
    const pick = $('theme-' + k), hexIn = $('theme-' + k + '-hex');
    pick.addEventListener('input', () => {
      hexIn.value = pick.value;
      applyCustomFromInputs();
    });
    hexIn.addEventListener('change', () => {
      const v = normHex(hexIn.value);
      if (!v) { note('"' + hexIn.value + '" is not a hex color'); return; }
      hexIn.value = v;
      pick.value = v;
      applyCustomFromInputs();
    });
  }

  $('theme-reset').addEventListener('click', () => {
    localStorage.removeItem('aeye-theme-custom');
    localStorage.removeItem('aeye-theme-vars');
    apply('dark');
    markPreset('dark');
    fillInputs(DEFAULT_CUSTOM);
    note('back to the phosphor default');
  });

  // export / import: the four custom colors as a tiny JSON file
  $('theme-export').addEventListener('click', () => {
    const cfg = loadCustom() || cfgFromInputs();
    const blob = new Blob([JSON.stringify({ aeye_theme: 1, ...cfg }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aeye-theme.json';
    a.click();
    URL.revokeObjectURL(a.href);
    note('theme exported');
  });

  $('theme-import').addEventListener('click', () => $('theme-import-file').click());
  $('theme-import-file').addEventListener('change', async () => {
    const f = $('theme-import-file').files[0];
    $('theme-import-file').value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const cfg = {};
      for (const k in FIELDS) {
        cfg[k] = normHex(j[k]);
        if (!cfg[k]) throw new Error('missing/bad "' + k + '"');
      }
      fillInputs(cfg);
      const adjusted = apply('custom', cfg);
      markPreset('custom');
      note('theme imported' + (adjusted ? ' (text auto-adjusted for contrast)' : ''));
    } catch (e) {
      note('import failed: ' + e.message);
    }
  });

  // ---- boot ------------------------------------------------------------------
  // the inline snippet in index.html already applied the stored theme before
  // first paint; here we only re-derive custom vars (in case the derivation
  // logic changed between versions) and reflect state into the controls.

  const saved = localStorage.getItem('aeye-theme');
  const name = PRESETS.includes(saved) ? saved : 'dark';
  const cfg = loadCustom() || DEFAULT_CUSTOM;
  fillInputs(cfg);
  if (name === 'custom') apply('custom', cfg);
  markPreset(name);
})();
