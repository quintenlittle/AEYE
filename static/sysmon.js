/* ================================================================
   AEYE -- live system monitor in the header.

   Polls /api/stats and paints colorful bar graphs for CPU, RAM,
   GPU, VRAM and network throughput. GPU/VRAM show n/a when there's
   no NVIDIA GPU; everything degrades gracefully.
   ================================================================ */
(() => {
  'use strict';

  // ---- header clock (local system date + time, ticks every second) ----------
  // The webview runs on the user's machine, so new Date() is the real system
  // clock -- the same "now" web.js hands the model to anchor recency.
  const clock = document.getElementById('clock');
  if (clock) {
    const pad = (n) => String(n).padStart(2, '0');
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const drawClock = () => {
      const d = new Date();
      clock.innerHTML =
        '<span class="clk-date">' + DAYS[d.getDay()] + ' ' + MONS[d.getMonth()]
          + ' ' + d.getDate() + ', ' + d.getFullYear() + '</span>'
        + '<span class="clk-time">' + pad(d.getHours()) + ':' + pad(d.getMinutes())
          + ':' + pad(d.getSeconds()) + '</span>';
    };
    drawClock();
    setInterval(drawClock, 1000);
  }

  const host = document.getElementById('sysmon');
  if (!host) return;

  // temperature thermometers were removed from the header (see the clock above);
  // CPU/GPU/VRAM now show usage bars only. Backend temps still poll for tooltips.
  const defs = [
    { key: 'cpu',  label: 'CPU',  cls: 'm-cpu' },
    { key: 'ram',  label: 'RAM',  cls: 'm-ram' },
    { key: 'gpu',  label: 'GPU',  cls: 'm-gpu' },
    { key: 'vram', label: 'VRAM', cls: 'm-vram' },
    { key: 'net',  label: 'NET',  cls: 'm-net' },
  ];

  const els = {};
  for (const d of defs) {
    const g = document.createElement('div');
    g.className = 'gauge ' + d.cls;
    g.innerHTML =
      '<span class="g-label">' + d.label + '</span>' +
      '<span class="g-track"><span class="g-fill"></span></span>' +
      '<span class="g-val">&ndash;</span>' +
      (d.therm ? '<span class="g-thermo"><span class="g-mercury"></span></span>'
               + '<span class="g-temp"></span>' : '');
    host.appendChild(g);
    els[d.key] = {
      box: g,
      fill: g.querySelector('.g-fill'),
      val: g.querySelector('.g-val'),
      mercury: g.querySelector('.g-mercury'),
      temp: g.querySelector('.g-temp'),
    };
    const th = g.querySelector('.g-thermo');
    if (th) th.style.display = 'none';   // shown by setTemp on first reading
  }

  // tiny thermometer next to CPU / GPU / VRAM: mercury height = °C, colour by
  // heat. Hidden entirely while there's no reading (no bare empty track).
  function setTemp(el, t) {
    if (!el.temp) return;
    if (t == null || !isFinite(t)) {
      el.temp.textContent = '';
      el.mercury.style.height = '0%';
      el.mercury.parentElement.style.display = 'none';
      return;
    }
    el.mercury.parentElement.style.display = '';
    const heat = t >= 85 ? 'crit' : t >= 70 ? 'warm' : 'cool';
    el.temp.textContent = Math.round(t) + '°';
    el.temp.className = 'g-temp ' + heat;
    el.mercury.style.height = Math.max(8, Math.min(100, t)) + '%';
    el.mercury.className = 'g-mercury ' + heat;
  }

  let netMax = 64;  // KB/s, rolling scale for the network bar

  function setBar(el, p, hotAt) {
    p = Math.max(0, Math.min(100, p || 0));
    el.fill.style.width = p.toFixed(0) + '%';
    el.box.classList.toggle('hot', p >= (hotAt == null ? 90 : hotAt));
  }

  function fmtRate(kb) {
    if (kb >= 1024) return (kb / 1024).toFixed(1) + 'M';
    if (kb >= 1) return Math.round(kb) + 'k';
    return '0';
  }

  function na(el) { el.box.classList.add('na'); el.fill.style.width = '0%'; el.val.textContent = 'n/a'; }

  async function tick() {
    let s;
    try { s = await (await fetch('/api/stats')).json(); }
    catch { return; }
    const src = s.hwinfo ? ' · HWiNFO' : '';

    if (typeof s.cpu_pct === 'number') {
      setBar(els.cpu, s.cpu_pct);
      els.cpu.val.textContent = Math.round(s.cpu_pct) + '%';
      setTemp(els.cpu, s.cpu_temp);
      if (s.cpu_temp != null)
        els.cpu.box.title = 'CPU ' + Math.round(s.cpu_pct) + '% · ' + Math.round(s.cpu_temp) + '°C' + src;
    }
    if (typeof s.ram_pct === 'number') {
      setBar(els.ram, s.ram_pct);
      els.ram.val.textContent = Math.round(s.ram_pct) + '%';
      els.ram.box.title = 'RAM ' + (s.ram_used_gb ?? '?') + ' / ' + (s.ram_total_gb ?? '?') + ' GB';
    }

    if (typeof s.gpu_pct === 'number') {
      els.gpu.box.classList.remove('na');
      setBar(els.gpu, s.gpu_pct);
      els.gpu.val.textContent = Math.round(s.gpu_pct) + '%';
      setTemp(els.gpu, s.gpu_temp);
      if (s.gpu_temp != null)
        els.gpu.box.title = 'GPU ' + Math.round(s.gpu_pct) + '% · ' + Math.round(s.gpu_temp) + '°C' + src;
    } else { na(els.gpu); setTemp(els.gpu, null); }

    if (typeof s.vram_pct === 'number') {
      els.vram.box.classList.remove('na');
      setBar(els.vram, s.vram_pct);
      els.vram.val.textContent = (s.vram_used_gb != null)
        ? s.vram_used_gb.toFixed(1) + 'G' : Math.round(s.vram_pct) + '%';
      setTemp(els.vram, s.vram_temp);
      els.vram.box.title = 'VRAM ' + (s.vram_used_gb ?? '?') + ' / ' + (s.vram_total_gb ?? '?') + ' GB'
        + (s.vram_temp != null ? ' · ' + Math.round(s.vram_temp) + '°C' + src : '');
    } else { na(els.vram); setTemp(els.vram, null); }

    if (typeof s.net_down_kbps === 'number') {
      const down = s.net_down_kbps, up = s.net_up_kbps || 0;
      const mx = Math.max(down, up);
      netMax = Math.max(netMax * 0.9, mx, 32);   // decay, but grow to fit spikes
      setBar(els.net, mx / netMax * 100, 101);   // never "hot" — traffic isn't bad
      els.net.val.textContent = fmtRate(down) + '↓ ' + fmtRate(up) + '↑';
      els.net.box.title = 'network  down ' + fmtRate(down) + '/s · up ' + fmtRate(up) + '/s';
    }
  }

  tick();
  setInterval(tick, 1500);
})();
