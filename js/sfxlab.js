/* =============================================================================
 * SKY PUSH — SFX LAB (hidden sound editor, open with  index.html?sfxlab )
 * Tune EVERY game sound: drop in a replacement file, set volume / pitch /
 * start-trim (with auto-trim) / reverb / lowpass, mute it, and test it
 * against the real in-game trigger. Overrides persist in localStorage and
 * apply in EVERY session (with or without the editor open); EXPORT writes a
 * json pack that can be committed into the repo.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.SfxLab = (function () {
  const KEY = 'skypush-sfxlab';
  let store = { v: 1, events: {} };
  try { store = { v: 1, events: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch (e) {}

  /* -------- catalog: every tunable event, its group and a REAL in-game
     trigger so what you hear in the lab is exactly what the game plays ---- */
  const S = () => SKY.SFX;
  const CATALOG = [
    ['WEAPONS', [
      ['fire_light', 'Fire — light (pistol/burst/rico/magnum/flamer)', () => S().fire('pistol', 1, 1, 0)],
      ['fire_med', 'Fire — medium (smg/rifle/mega/minigun)', () => S().fire('smg', 1, 1, 0)],
      ['fire_heavy', 'Fire — heavy (scatter/boom/tag)', () => S().fire('scatter', 1, 1.6, 0)],
      ['fire_sniper', 'Fire — sniper (longshot/piston)', () => S().fire('longshot', 1, 1, 0)],
      ['glfire', 'Fire — launcher (lobber/quad)', () => S().fire('lobber', 1, 1.4, 0)],
      ['reload', 'Reload start', () => S().reload()],
      ['reload_done', 'Reload complete', () => S().reloadDone()],
      ['dry', 'Empty mag click', () => S().dry()],
      ['charge', 'Piston charge tick', () => S().chargeTick(1)],
      ['aircannon', 'Air cannon (Q)', () => S().airCannon(0)],
      ['grapple', 'Grapple fire', () => S().grapple(0)],
      ['grapmiss', 'Grapple miss', () => S().grapMiss()],
      ['bounce', 'Ricochet bounce', () => S().bounce(3)],
    ]],
    ['IMPACTS', [
      ['hit', 'Bullet hit (body)', () => S().hit(0.6, 4)],
      ['headshot', 'Headshot', () => S().headshot(4)],
      ['boom', 'Explosion', () => S().boom(5)],
      ['boom_low', 'Explosion sub-layer', () => S().boom(1)],
      ['ko', 'Knockout', () => S().ko(true)],
    ]],
    ['MOVEMENT', [
      ['step', 'Footstep', () => S().step(0.85, 0)],
      ['jump', 'Jump push-off', () => S().jump(0)],
      ['land', 'Landing', () => S().land(0.85, 0)],
      ['slide', 'Slide start', () => S().slideStart(0)],
      ['dash', 'Air dash', () => S().dash(0)],
      ['pad', 'Jump pad', () => S().pad()],
      ['scream', 'Falling wind', () => S().scream(true)],
      ['splash', 'Water splash', () => S().splash(0.8, 0)],
    ]],
    ['UI & META', [
      ['uiclick', 'Menu click', () => S().ui()],
      ['beep', 'Countdown beep', () => S().countdown()],
      ['go', 'Round GO', () => S().go()],
      ['win', 'Round won', () => S().win()],
      ['lose', 'Round lost', () => S().labPlayRaw('lose')],
      ['pick', 'Pickup / reward', () => S().pick()],
      ['cash', 'Coins', () => S().cash()],
      ['crown', 'Crown grab', () => S().crown()],
      ['taunt', 'Taunt', () => S().taunt(0)],
      ['cheer', 'Match-end crowd', () => S().cheer()],
      ['alarm', 'Overtime alarm', () => S().overtime()],
    ]],
    ['WORLD', [
      ['door', 'Door swing', () => S().door(2)],
      ['rumble', 'Rumble (fire pool / quake)', () => S().rumble(0)],
      ['thunder_smp', 'Thunder', () => S().thunder()],
      ['gust', 'Wind gust', () => S().gust()],
      ['honk', 'Horn', () => S().honk()],
    ]],
  ];
  const TRIGGERS = {};
  const LABELS = {};
  for (const [, items] of CATALOG) for (const [n, l, t] of items) { TRIGGERS[n] = t; LABELS[n] = l; }

  const DEF = { vol: 1, rate: 1, offset: null, rev: 0, lp: 19000, mute: false };

  /* -------- runtime install: cfg + decoded buffers into SKY.SFX -------- */
  function cfgOf(name) {
    let c = store.events[name];
    if (!c) c = store.events[name] = { ...DEF };
    return c;
  }
  function installAll() {
    for (const n in store.events) SKY.SFX.labState.events[n] = store.events[n];
  }
  const decoded = new Set();
  function decodePending() {
    if (!SKY.SFX.context()) return;
    for (const n in store.events) {
      const c = store.events[n];
      if (!c.data || decoded.has(n)) continue;
      decoded.add(n);
      fetch(c.data).then((r) => r.arrayBuffer())
        .then((ab) => SKY.SFX.labSetBuffer(n, ab))
        .catch(() => decoded.delete(n));
    }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); return true; }
    catch (e) { alert('SFX LAB: storage full — export your pack, then remove some custom files.'); return false; }
  }

  installAll();
  // keep polling: the audio context arrives on the first user gesture, and
  // the shipped pack (below) can land after that — decodePending is cheap
  setInterval(decodePending, 700);

  // a committed pack (assets/audio/sfx-pack.json) is the SHIPPED sound mix:
  // everyone gets it; anything tweaked locally in the lab wins over it
  if (/^https?:$/.test(location.protocol)) {
    fetch('assets/audio/sfx-pack.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((pack) => {
        if (!pack || !pack.events) return;
        for (const n in pack.events) {
          if (!store.events[n]) {
            store.events[n] = pack.events[n];
            SKY.SFX.labState.events[n] = pack.events[n];
          }
        }
        decodePending();
      })
      .catch(() => {});
  }

  /* ==================== UI (only with ?sfxlab) ==================== */
  if (!/sfxlab/.test(location.search)) return { store };

  const css = document.createElement('style');
  css.textContent = `
  #sfxlab-chip { position:fixed; left:14px; bottom:56px; z-index:60; padding:8px 14px;
    background:#141822; border:1px solid #ffd34d; color:#ffd34d; border-radius:8px;
    font:800 11px Inter,sans-serif; letter-spacing:.14em; cursor:pointer; }
  #sfxlab { position:fixed; right:0; top:0; bottom:0; width:400px; z-index:59;
    background:rgba(11,14,20,.97); border-left:1px solid rgba(255,255,255,.14);
    color:#e8ecf5; font:12px/1.5 Inter,sans-serif; display:flex; flex-direction:column; }
  #sfxlab.hidden { display:none; }
  #sfxlab header { padding:12px 14px 8px; border-bottom:1px solid rgba(255,255,255,.1); }
  #sfxlab header h3 { margin:0 0 6px; font-size:13px; letter-spacing:.18em; color:#ffd34d; }
  #sfxlab header .row { display:flex; gap:6px; flex-wrap:wrap; }
  #sfxlab button { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.2);
    color:#e8ecf5; border-radius:6px; padding:4px 9px; font:700 10px Inter,sans-serif;
    letter-spacing:.08em; cursor:pointer; }
  #sfxlab button:hover { border-color:#ffd34d; color:#ffd34d; }
  #sfxlab button.warn { border-color:#ff5a4a; color:#ff8a7a; }
  #sfxlab .list { overflow-y:auto; flex:1; }
  #sfxlab .grp { padding:8px 14px 2px; font:800 9.5px Inter,sans-serif; letter-spacing:.22em;
    color:#8a93a6; }
  #sfxlab .ev { padding:5px 14px; cursor:pointer; display:flex; justify-content:space-between;
    align-items:center; border-left:3px solid transparent; }
  #sfxlab .ev:hover { background:rgba(255,255,255,.05); }
  #sfxlab .ev.sel { background:rgba(255,211,77,.09); border-left-color:#ffd34d; }
  #sfxlab .ev .dot { font-size:9px; color:#57e389; }
  #sfxlab .ed { border-top:1px solid rgba(255,255,255,.14); padding:10px 14px 14px;
    max-height:56%; overflow-y:auto; }
  #sfxlab .ed h4 { margin:0 0 2px; font-size:12px; color:#fff; }
  #sfxlab .ed small { color:#8a93a6; }
  #sfxlab canvas { width:100%; height:56px; background:#0a0d14; border:1px solid rgba(255,255,255,.12);
    border-radius:6px; margin:8px 0 4px; cursor:crosshair; display:block; }
  #sfxlab .sl { display:grid; grid-template-columns:86px 1fr 52px; gap:8px; align-items:center;
    margin:5px 0; }
  #sfxlab .sl label { font-size:10px; letter-spacing:.1em; color:#aeb6c4; }
  #sfxlab .sl input[type=range] { width:100%; accent-color:#ffd34d; }
  #sfxlab .sl output { font:700 10px Consolas,monospace; color:#ffd34d; text-align:right; }
  #sfxlab .btns { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  #sfxlab-flash { position:fixed; inset:0; background:#fff; opacity:0; pointer-events:none;
    z-index:70; }
  #sfxlab .hint { font-size:10px; color:#8a93a6; margin-top:8px; line-height:1.55; }`;
  document.head.appendChild(css);

  const chip = document.createElement('button');
  chip.id = 'sfxlab-chip';
  chip.textContent = 'SFX LAB';
  document.body.appendChild(chip);
  const flash = document.createElement('div');
  flash.id = 'sfxlab-flash';
  document.body.appendChild(flash);

  const panel = document.createElement('div');
  panel.id = 'sfxlab';
  panel.className = 'hidden';
  document.body.appendChild(panel);
  chip.onclick = () => { SKY.SFX.init(); panel.classList.toggle('hidden'); render(); };

  let sel = 'step';

  function customName(n) { return store.events[n] && store.events[n].file; }
  function isTouched(n) {
    const c = store.events[n];
    if (!c) return false;
    return !!(c.data || c.mute || c.vol !== 1 || c.rate !== 1 ||
      c.offset != null || c.rev > 0 || (c.lp && c.lp < 19000));
  }

  function render() {
    if (panel.classList.contains('hidden')) return;
    const rows = CATALOG.map(([grp, items]) =>
      `<div class="grp">${grp}</div>` + items.map(([n, label]) =>
        `<div class="ev${n === sel ? ' sel' : ''}" data-ev="${n}">
          <span>${label}</span>
          <span class="dot">${customName(n) ? '● file' : isTouched(n) ? '●' : ''}</span>
        </div>`).join('')).join('');
    const c = cfgOf(sel);
    const takes = SKY.SFX.labBankInfo(sel).takes;
    panel.innerHTML = `
      <header>
        <h3>SFX LAB</h3>
        <div class="row">
          <button id="sfx-export">EXPORT PACK</button>
          <button id="sfx-import">IMPORT</button>
          <button id="sfx-resetall" class="warn">RESET ALL</button>
          <input type="file" id="sfx-importfile" accept=".json" style="display:none">
        </div>
      </header>
      <div class="list">${rows}</div>
      <div class="ed">
        <h4>${LABELS[sel] || sel}</h4>
        <small>${customName(sel) ? 'custom: ' + customName(sel)
          : takes ? 'built-in bank · ' + takes + ' take' + (takes > 1 ? 's' : '')
          : 'no sample yet — synth fallback (drop a file below)'}</small>
        <canvas id="sfx-wave" width="368" height="56"></canvas>
        <div class="sl"><label>VOLUME</label>
          <input type="range" id="sfx-vol" min="0" max="3" step="0.05" value="${c.vol}">
          <output>${Math.round(c.vol * 100)}%</output></div>
        <div class="sl"><label>PITCH</label>
          <input type="range" id="sfx-rate" min="0.25" max="3" step="0.05" value="${c.rate}">
          <output>${c.rate.toFixed(2)}×</output></div>
        <div class="sl"><label>START TRIM</label>
          <input type="range" id="sfx-off" min="0" max="1" step="0.005" value="${c.offset ?? 0}">
          <output>${Math.round((c.offset ?? 0) * 1000)}ms</output></div>
        <div class="sl"><label>REVERB</label>
          <input type="range" id="sfx-rev" min="0" max="1" step="0.05" value="${c.rev}">
          <output>${Math.round(c.rev * 100)}%</output></div>
        <div class="sl"><label>LOWPASS</label>
          <input type="range" id="sfx-lp" min="300" max="19000" step="100" value="${c.lp}">
          <output>${c.lp >= 19000 ? 'off' : (c.lp / 1000).toFixed(1) + 'k'}</output></div>
        <div class="sl"><label>MUTE</label>
          <input type="checkbox" id="sfx-mute"${c.mute ? ' checked' : ''} style="justify-self:start"><span></span></div>
        <div class="btns">
          <button id="sfx-test">▶ TEST IN-GAME</button>
          <button id="sfx-sync">SYNC ×4</button>
          <button id="sfx-autotrim">AUTO-TRIM</button>
          <button id="sfx-file">REPLACE SOUND…</button>
          <button id="sfx-reset" class="warn">RESET</button>
          <input type="file" id="sfx-filein" accept="audio/*" style="display:none">
        </div>
        <div class="hint">TEST plays through the exact in-game call (same volume math).
        SYNC repeats it with a screen flash at the trigger instant — drag START TRIM
        until sound and flash line up. Dropping in a file auto-trims its silent lead-in.
        Everything here applies LIVE: start a bots match and play with it.</div>
      </div>`;
    drawWave();
    wire();
  }

  function drawWave() {
    const cv = panel.querySelector('#sfx-wave');
    if (!cv) return;
    const g = cv.getContext('2d');
    g.fillStyle = '#0a0d14';
    g.fillRect(0, 0, cv.width, cv.height);
    const buf = SKY.SFX.labBuffer(sel);
    if (!buf) {
      g.fillStyle = '#4a5264';
      g.font = '10px Inter';
      g.fillText('no sample loaded (synth fallback)', 10, 32);
      return;
    }
    const d = buf.getChannelData(0);
    const mid = cv.height / 2;
    g.strokeStyle = '#57a3e8';
    g.beginPath();
    for (let x = 0; x < cv.width; x++) {
      const i0 = ((x / cv.width) * d.length) | 0;
      const i1 = (((x + 1) / cv.width) * d.length) | 0;
      let lo = 1, hi = -1;
      for (let i = i0; i < i1; i += 4) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      g.moveTo(x + 0.5, mid - hi * mid * 0.94);
      g.lineTo(x + 0.5, mid - lo * mid * 0.94);
    }
    g.stroke();
    // trim marker
    const c = cfgOf(sel);
    const off = c.offset ?? (buf.__trim || 0);
    const x = (off / buf.duration) * cv.width;
    g.strokeStyle = '#ffd34d';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke();
    g.lineWidth = 1;
  }

  function doFlash() {
    flash.style.transition = 'none';
    flash.style.opacity = 0.55;
    requestAnimationFrame(() => {
      flash.style.transition = 'opacity .18s';
      flash.style.opacity = 0;
    });
  }
  function trigger() {
    SKY.SFX.init();
    doFlash();
    try { (TRIGGERS[sel] || (() => SKY.SFX.labPlayRaw(sel)))(); } catch (e) {}
  }

  function wire() {
    panel.querySelectorAll('.ev').forEach((el) => {
      el.onclick = () => { sel = el.dataset.ev; render(); };
    });
    const c = cfgOf(sel);
    const bind = (id, key, fmt) => {
      const inp = panel.querySelector(id);
      if (!inp) return;
      inp.oninput = () => {
        c[key] = parseFloat(inp.value);
        inp.parentNode.querySelector('output').textContent = fmt(c[key]);
        SKY.SFX.labState.events[sel] = c;
        save();
        if (key === 'offset') drawWave();
      };
    };
    bind('#sfx-vol', 'vol', (v) => Math.round(v * 100) + '%');
    bind('#sfx-rate', 'rate', (v) => v.toFixed(2) + '×');
    bind('#sfx-off', 'offset', (v) => Math.round(v * 1000) + 'ms');
    bind('#sfx-rev', 'rev', (v) => Math.round(v * 100) + '%');
    bind('#sfx-lp', 'lp', (v) => v >= 19000 ? 'off' : (v / 1000).toFixed(1) + 'k');
    panel.querySelector('#sfx-mute').onchange = (e) => {
      c.mute = e.target.checked;
      SKY.SFX.labState.events[sel] = c;
      save(); render();
    };
    panel.querySelector('#sfx-test').onclick = trigger;
    panel.querySelector('#sfx-sync').onclick = () => {
      for (let i = 0; i < 4; i++) setTimeout(trigger, i * 700);
    };
    panel.querySelector('#sfx-autotrim').onclick = () => {
      const buf = SKY.SFX.labBuffer(sel);
      if (!buf) return;
      c.offset = SKY.SFX.labTrimOf(buf);
      SKY.SFX.labState.events[sel] = c;
      save(); render();
    };
    panel.querySelector('#sfx-wave').onclick = (e) => {
      const buf = SKY.SFX.labBuffer(sel);
      if (!buf) return;
      const r = e.target.getBoundingClientRect();
      c.offset = Math.max(0, ((e.clientX - r.left) / r.width) * buf.duration);
      SKY.SFX.labState.events[sel] = c;
      save(); render();
    };
    panel.querySelector('#sfx-file').onclick = () => panel.querySelector('#sfx-filein').click();
    panel.querySelector('#sfx-filein').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      SKY.SFX.init();
      const ab = await f.arrayBuffer();
      try {
        const buf = await SKY.SFX.labSetBuffer(sel, ab.slice(0));
        c.file = f.name;
        c.offset = SKY.SFX.labTrimOf(buf);   // auto-trim the silent lead-in
        // store as dataURL so it survives reloads + exports
        const fr = new FileReader();
        fr.onload = () => { c.data = fr.result; SKY.SFX.labState.events[sel] = c; save(); render(); };
        fr.readAsDataURL(new Blob([ab], { type: f.type || 'audio/ogg' }));
      } catch (err) { alert('could not decode that file: ' + err.message); }
    };
    panel.querySelector('#sfx-reset').onclick = () => {
      delete store.events[sel];
      delete SKY.SFX.labState.events[sel];
      SKY.SFX.labClearBuffer(sel);
      decoded.delete(sel);
      save(); render();
    };
    panel.querySelector('#sfx-export').onclick = () => {
      const blob = new Blob([JSON.stringify(store)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'skypush-sfx-pack.json';
      a.click();
    };
    panel.querySelector('#sfx-import').onclick = () => panel.querySelector('#sfx-importfile').click();
    panel.querySelector('#sfx-importfile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        store = { v: 1, events: {}, ...JSON.parse(await f.text()) };
        for (const n of Object.keys(SKY.SFX.labState.events)) delete SKY.SFX.labState.events[n];
        decoded.clear();
        installAll(); decodePending(); save(); render();
      } catch (err) { alert('bad pack: ' + err.message); }
    };
    panel.querySelector('#sfx-resetall').onclick = () => {
      if (!confirm('Reset EVERY sound override?')) return;
      store = { v: 1, events: {} };
      for (const n of Object.keys(SKY.SFX.labState.events)) {
        delete SKY.SFX.labState.events[n];
        SKY.SFX.labClearBuffer(n);
      }
      decoded.clear();
      save(); render();
    };
  }

  return { store, render };
})();
