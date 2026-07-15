/* =============================================================================
 * SKY PUSH — SFX LAB (hidden sound editor, open with  index.html?sfxlab )
 * Full-screen editor for EVERY game sound: replace the file, set volume /
 * pitch / start-trim (auto-trim on upload) / reverb / lowpass, mute, and test
 * through the exact in-game trigger with a live output meter. Overrides live
 * in localStorage and apply in EVERY session; EXPORT writes a json pack —
 * committed as assets/audio/sfx-pack.json it becomes the shipped mix.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.SfxLab = (function () {
  const KEY = 'skypush-sfxlab';
  let store = { v: 1, events: {} };
  try { store = { v: 1, events: {}, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch (e) {}

  /* -------- IndexedDB for the audio blobs (localStorage chokes on music) -------- */
  let idb = null;
  const idbReady = new Promise((res) => {
    const rq = indexedDB.open('skypush-sfxlab', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('snd');
    rq.onsuccess = () => { idb = rq.result; res(idb); };
    rq.onerror = () => res(null);
  });
  const idbPut = (name, blob) => idbReady.then(() => new Promise((res) => {
    if (!idb) return res(false);
    const tx = idb.transaction('snd', 'readwrite');
    tx.objectStore('snd').put(blob, name);
    tx.oncomplete = () => res(true);
    tx.onerror = () => res(false);
  }));
  const idbGet = (name) => idbReady.then(() => new Promise((res) => {
    if (!idb) return res(null);
    const rq = idb.transaction('snd').objectStore('snd').get(name);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => res(null);
  }));
  const idbDel = (name) => idbReady.then(() => new Promise((res) => {
    if (!idb) return res(false);
    const tx = idb.transaction('snd', 'readwrite');
    tx.objectStore('snd').delete(name);
    tx.oncomplete = () => res(true);
    tx.onerror = () => res(false);
  }));
  // migrate v1 packs that kept dataURLs inside localStorage
  for (const n in store.events) {
    const c = store.events[n];
    if (c.data) {
      const dataUrl = c.data;
      delete c.data;
      c.blob = true;
      fetch(dataUrl).then((r) => r.blob()).then((b) => idbPut(n, b)).catch(() => {});
    }
  }

  /* -------- catalog: every tunable event, its group and a REAL in-game
     trigger so what you hear in the lab is exactly what the game plays ---- */
  const S = () => SKY.SFX;
  /* pretty per-gun labels for the override slots */
  const wLabel = (k) => {
    const w = SKY.TUNING && SKY.TUNING.weapons && SKY.TUNING.weapons[k];
    return (w && w.label) || (k === 'seeker' ? 'TAG CANNON (IT)' : k.toUpperCase());
  };
  const CATALOG = [
    ['WEAPONS', [
      ['fire_light', 'Fire — light (pistol/burst/rico/magnum)', () => S().fire('pistol', 1, 1, 0)],
      ['fire_med', 'Fire — medium (smg/rifle/mega/minigun)', () => S().fire('smg', 1, 1, 0)],
      ['fire_heavy', 'Fire — heavy (scatter/boom/tag)', () => S().fire('scatter', 1, 1.6, 0)],
      ['fire_sniper', 'Fire — sniper (longshot/piston)', () => S().fire('longshot', 1, 1, 0)],
      ['glfire', 'Fire — launcher (lobber/quad)', () => S().fire('lobber', 1, 1.4, 0)],
      ['flame', 'Flamethrower jet', () => S().flame(0)],
      ['reload', 'Reload start', () => S().reload()],
      ['reload_done', 'Reload complete', () => S().reloadDone()],
      ['dry', 'Empty mag click', () => S().dry()],
      ['charge', 'Piston charge tick', () => S().chargeTick(1)],
      ['aircannon', 'Air cannon (Q)', () => S().airCannon(0)],
      ['grapple', 'Grapple fire', () => S().grapple(0)],
      ['grapmiss', 'Grapple miss', () => S().grapMiss()],
      ['bounce', 'Ricochet bounce', () => S().bounce(3)],
    ]],
    // per-gun override slots: guns sharing one bank (rifle + mega + minigun
    // all ride fire_med) get their OWN volume/pitch/file here — until a slot
    // is touched, the gun keeps using the shared bank sound above
    ['PER-GUN FIRE', (SKY.SFX.labFireKinds ? SKY.SFX.labFireKinds() : [])
      .filter((k) => k !== 'flamer')          // the flamer has its own event
      .map((k) => ['wfire_' + k, wLabel(k), () => S().fire(k, 1, 1, 0)])],
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
    ['MUSIC & AMBIENT', [
      ['music_menu', 'Music — menu (drop a file to replace)', () => { S().music(null); setTimeout(() => S().music('menu'), 100); }],
      ['music_game', 'Music — in-game (drop a file to replace)', () => { S().music(null); setTimeout(() => S().music('game'), 100); }],
      ['amb_wind', 'Ambient — speed wind loop', () => {
        S().setWind(0.9); setTimeout(() => S().setWind(0), 1800); }],
      ['amb_slide', 'Ambient — slide scrape loop', () => {
        S().setSlide(true); setTimeout(() => S().setSlide(false), 1400); }],
    ]],
  ];
  const LIVE_HOOK = {
    music_menu: () => S().labApplyMusic(),
    music_game: () => S().labApplyMusic(),
    amb_wind: () => S().labRefreshAmbient(),
    amb_slide: () => S().labRefreshAmbient(),
  };
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
  const packData = {};        // shipped-pack audio (name -> dataURL)
  function decodePending() {
    if (!SKY.SFX.context()) return;
    for (const n in store.events) {
      const c = store.events[n];
      if (!(c.blob || c.data) || decoded.has(n)) continue;
      decoded.add(n);
      const src = c.blob
        ? idbGet(n).then((b) => (b ? b.arrayBuffer() : Promise.reject(new Error('no blob'))))
        : fetch(c.data).then((r) => r.arrayBuffer());
      src.then((ab) => SKY.SFX.labSetBuffer(n, ab))
        .then(() => { if (LIVE_HOOK[n]) LIVE_HOOK[n](); })
        .catch(() => decoded.delete(n));
    }
    for (const n in packData) {                 // shipped mix (local wins)
      if (store.events[n] || decoded.has(n)) continue;
      decoded.add(n);
      fetch(packData[n]).then((r) => r.arrayBuffer())
        .then((ab) => SKY.SFX.labSetBuffer(n, ab))
        .then(() => { if (LIVE_HOOK[n]) LIVE_HOOK[n](); })
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
            const e = { ...pack.events[n] };
            if (e.data) { packData[n] = e.data; delete e.data; delete e.blob; }
            store.events[n] = e;
            SKY.SFX.labState.events[n] = e;
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
  #sfxlab-chip { position:fixed; left:14px; bottom:56px; z-index:60; padding:9px 16px;
    background:#141822; border:1px solid #ffd34d; color:#ffd34d; border-radius:8px;
    font:800 12px Inter,sans-serif; letter-spacing:.14em; cursor:pointer; }
  #sfxlab { position:fixed; inset:0; z-index:58; background:#0b0e14; color:#e8ecf5;
    font:14px/1.55 Inter,sans-serif; display:grid; grid-template-rows:auto 1fr; }
  #sfxlab.hidden { display:none; }
  #sfxlab header { display:flex; align-items:center; gap:14px; padding:14px 22px;
    border-bottom:1px solid rgba(255,255,255,.12); background:#0e1119; }
  #sfxlab header h3 { margin:0; font-size:16px; letter-spacing:.2em; color:#ffd34d; }
  #sfxlab header .sp { flex:1; }
  #sfxlab #sfx-meter { width:180px; height:22px; background:#0a0d14;
    border:1px solid rgba(255,255,255,.15); border-radius:5px; }
  #sfxlab button { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.22);
    color:#e8ecf5; border-radius:7px; padding:8px 14px; font:700 12px Inter,sans-serif;
    letter-spacing:.08em; cursor:pointer; }
  #sfxlab button:hover { border-color:#ffd34d; color:#ffd34d; }
  #sfxlab button.warn { border-color:#ff5a4a; color:#ff8a7a; }
  #sfxlab button.big { padding:11px 20px; font-size:13px; }
  #sfxlab .body { display:grid; grid-template-columns:330px 1fr; min-height:0; }
  #sfxlab .list { overflow-y:auto; border-right:1px solid rgba(255,255,255,.1);
    padding-bottom:30px; }
  #sfxlab .grp { padding:14px 20px 4px; font:800 11px Inter,sans-serif;
    letter-spacing:.24em; color:#8a93a6; }
  #sfxlab .ev { padding:8px 20px; cursor:pointer; display:flex;
    justify-content:space-between; align-items:center; border-left:3px solid transparent;
    font-size:13px; }
  #sfxlab .ev:hover { background:rgba(255,255,255,.05); }
  #sfxlab .ev.sel { background:rgba(255,211,77,.1); border-left-color:#ffd34d; }
  #sfxlab .ev .dot { font-size:10px; color:#57e389; }
  #sfxlab .editor { overflow-y:auto; padding:26px 34px; }
  #sfxlab .editor .inner { max-width:900px; }
  #sfxlab .editor h2 { margin:0; font-size:22px; color:#fff; }
  #sfxlab .src { color:#8a93a6; font-size:13px; margin:2px 0 4px; }
  #sfxlab #sfx-status { min-height:20px; font-size:12px; color:#57e389; margin:4px 0; }
  #sfxlab #sfx-status.err { color:#ff8a7a; }
  #sfxlab canvas#sfx-wave { width:100%; height:170px; background:#0a0d14;
    border:1px solid rgba(255,255,255,.14); border-radius:10px; margin:10px 0 6px;
    cursor:crosshair; display:block; }
  #sfxlab .wavehint { font-size:11px; color:#5d6577; margin-bottom:12px; }
  #sfxlab .sl { display:grid; grid-template-columns:130px 1fr 74px; gap:16px;
    align-items:center; margin:10px 0; }
  #sfxlab .sl label { font-size:12px; letter-spacing:.14em; color:#aeb6c4; }
  #sfxlab .sl input[type=range] { width:100%; accent-color:#ffd34d; height:22px; }
  #sfxlab .sl output { font:700 13px Consolas,monospace; color:#ffd34d; text-align:right; }
  #sfxlab .btns { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; }
  #sfxlab-flash { position:fixed; inset:0; background:#fff; opacity:0; pointer-events:none;
    z-index:70; }
  #sfxlab .hint { font-size:12.5px; color:#8a93a6; margin-top:18px; line-height:1.7;
    border-top:1px solid rgba(255,255,255,.08); padding-top:12px; }`;
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
  chip.onclick = () => {
    SKY.SFX.init();
    panel.classList.toggle('hidden');
    chip.style.display = panel.classList.contains('hidden') ? '' : 'none';
    render();
    // sample banks stream in right after the first init — refresh the info line
    setTimeout(() => { if (!panel.classList.contains('hidden')) render(); }, 900);
  };

  let sel = 'step';
  let meterRaf = 0, meterPeak = 0;

  function customName(n) { return store.events[n] && store.events[n].file; }
  function isTouched(n) {
    const c = store.events[n];
    if (!c) return false;
    return !!(c.data || c.blob || c.mute || c.vol !== 1 || c.rate !== 1 ||
      c.offset != null || c.rev > 0 || (c.lp && c.lp < 19000));
  }
  function status(msg, isErr) {
    const el = panel.querySelector('#sfx-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
  }

  function render() {
    if (panel.classList.contains('hidden')) { cancelAnimationFrame(meterRaf); return; }
    const rows = CATALOG.map(([grp, items]) =>
      `<div class="grp">${grp}</div>` + items.map(([n, label]) =>
        `<div class="ev${n === sel ? ' sel' : ''}" data-ev="${n}">
          <span>${label}</span>
          <span class="dot">${customName(n) ? '● file' : isTouched(n) ? '●' : ''}</span>
        </div>`).join('')).join('');
    const c = cfgOf(sel);
    const takes = SKY.SFX.labBankInfo(sel).takes;
    const hasCustom = !!SKY.SFX.labState.buffers[sel];
    panel.innerHTML = `
      <header>
        <h3>SFX LAB</h3>
        <canvas id="sfx-meter" width="180" height="22" title="live output meter"></canvas>
        <span class="sp"></span>
        <button id="sfx-export">EXPORT PACK</button>
        <button id="sfx-import">IMPORT</button>
        <button id="sfx-resetall" class="warn">RESET ALL</button>
        <button id="sfx-close">CLOSE</button>
        <input type="file" id="sfx-importfile" accept=".json" style="display:none">
      </header>
      <div class="body">
        <div class="list">${rows}</div>
        <div class="editor"><div class="inner">
          <h2>${LABELS[sel] || sel}</h2>
          <div class="src">${customName(sel) ? 'custom file: ' + customName(sel)
            : takes ? 'built-in bank · ' + takes + ' take' + (takes > 1 ? 's' : '')
            : SKY.SFX.context() ? 'no sample — synth fallback (drop a file below)'
            : 'audio starts on first click — hit TEST once'}</div>
          <div id="sfx-status"></div>
          <canvas id="sfx-wave" width="900" height="170"></canvas>
          <div class="wavehint">click the waveform to set the start point (yellow line) —
            everything left of it is skipped</div>
          <div class="sl"><label>VOLUME</label>
            <input type="range" id="sfx-vol" min="0" max="6" step="0.05" value="${c.vol}">
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
            <button id="sfx-test" class="big">▶ TEST IN-GAME</button>
            <button id="sfx-sync" class="big">SYNC ×4</button>
            <button id="sfx-autotrim">AUTO-TRIM</button>
            <button id="sfx-file">REPLACE SOUND…</button>
            <button id="sfx-reset" class="warn">RESET</button>
            <input type="file" id="sfx-filein" accept="audio/*" style="display:none">
          </div>
          <div class="hint">${sel.indexOf('wfire_') === 0
            ? `PER-GUN SLOT: this gun's shared bank sound plays UNCHANGED until you move a
            slider (or drop a file) here — then these settings replace the shared ones for
            THIS gun only. Reset returns it to the shared sound.<br><br>`
            : ''}TEST plays through the exact in-game call (same volume math) —
          watch the meter up top: signal there = the game hears it too. SYNC repeats the
          trigger with a screen flash at the trigger instant; drag START TRIM until sound
          and flash line up. Dropping in a file auto-trims its silent lead-in. Everything
          applies LIVE — close the lab, start a bots match, and play with your mix.
          ${hasCustom ? '' : takes ? '' : 'This event has no sample file yet — the game uses a synthesized fallback until you drop one in.'}</div>
        </div></div>
      </div>`;
    drawWave();
    wire();
    runMeter();
  }

  function runMeter() {
    cancelAnimationFrame(meterRaf);
    const cv = panel.querySelector('#sfx-meter');
    if (!cv) return;
    const g = cv.getContext('2d');
    const buf = new Float32Array(2048);
    const step = () => {
      if (panel.classList.contains('hidden')) return;
      const an = SKY.SFX.labAnalyser && SKY.SFX.labAnalyser();
      let p = 0;
      if (an) {
        an.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
      }
      meterPeak = Math.max(p, meterPeak * 0.93);
      g.fillStyle = '#0a0d14';
      g.fillRect(0, 0, cv.width, cv.height);
      const w = Math.min(1, meterPeak) * (cv.width - 4);
      g.fillStyle = meterPeak > 0.9 ? '#ff5a4a' : meterPeak > 0.02 ? '#57e389' : '#2a3242';
      g.fillRect(2, 4, Math.max(2, w), cv.height - 8);
      meterRaf = requestAnimationFrame(step);
    };
    step();
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
      g.font = '13px Inter';
      g.fillText(SKY.SFX.context()
        ? 'no sample loaded for this event (synth fallback) — REPLACE SOUND to add one'
        : 'click TEST once to start the audio engine, samples load right after',
        20, 90);
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
    const c = cfgOf(sel);
    const off = c.offset ?? (buf.__trim || 0);
    const x = (off / buf.duration) * cv.width;
    g.strokeStyle = '#ffd34d';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke();
    g.lineWidth = 1;
    g.fillStyle = '#5d6577';
    g.font = '11px Consolas';
    g.fillText(buf.duration.toFixed(2) + 's', cv.width - 50, 14);
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
    try {
      (TRIGGERS[sel] || (() => SKY.SFX.labPlayRaw(sel)))();
      const takes = SKY.SFX.labBankInfo(sel).takes;
      const hasCustom = !!SKY.SFX.labState.buffers[sel];
      status(hasCustom ? 'played — custom file'
        : takes ? 'played — bank sample'
        : 'played — synth fallback (no sample file for this event yet)');
    } catch (e) {
      status('trigger error: ' + e.message, true);
    }
  }

  function wire() {
    panel.querySelectorAll('.ev').forEach((el) => {
      el.onclick = () => { sel = el.dataset.ev; render(); };
    });
    const c = cfgOf(sel);
    let hookT = 0;
    const liveHook = () => {           // music/ambient apply live (debounced — sliders drag)
      if (!LIVE_HOOK[sel]) return;
      clearTimeout(hookT);
      hookT = setTimeout(() => { try { LIVE_HOOK[sel](); } catch (e) {} }, 300);
    };
    const bind = (id, key, fmt) => {
      const inp = panel.querySelector(id);
      if (!inp) return;
      inp.oninput = () => {
        c[key] = parseFloat(inp.value);
        inp.parentNode.querySelector('output').textContent = fmt(c[key]);
        SKY.SFX.labState.events[sel] = c;
        save();
        if (key === 'offset') drawWave();
        liveHook();
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
      save(); liveHook(); render();
    };
    panel.querySelector('#sfx-close').onclick = () => {
      panel.classList.add('hidden');
      chip.style.display = '';
      cancelAnimationFrame(meterRaf);
    };
    panel.querySelector('#sfx-test').onclick = trigger;
    panel.querySelector('#sfx-sync').onclick = () => {
      for (let i = 0; i < 4; i++) setTimeout(trigger, i * 700);
    };
    panel.querySelector('#sfx-autotrim').onclick = () => {
      const buf = SKY.SFX.labBuffer(sel);
      if (!buf) { status('nothing to trim — no sample loaded', true); return; }
      c.offset = SKY.SFX.labTrimOf(buf);
      SKY.SFX.labState.events[sel] = c;
      save(); render();
      status('trimmed to ' + Math.round(c.offset * 1000) + 'ms');
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
        delete c.data;
        c.blob = true;
        await idbPut(sel, new Blob([ab], { type: f.type || 'audio/ogg' }));
        SKY.SFX.labState.events[sel] = c;
        decoded.add(sel);
        save(); liveHook(); render();
      } catch (err) { alert('could not decode that file: ' + err.message); }
    };
    panel.querySelector('#sfx-reset').onclick = () => {
      delete store.events[sel];
      delete SKY.SFX.labState.events[sel];
      SKY.SFX.labClearBuffer(sel);
      decoded.delete(sel);
      idbDel(sel);
      save(); decodePending(); liveHook(); render();
    };
    panel.querySelector('#sfx-export').onclick = async () => {
      // embed the idb audio as base64 so the pack is a single portable json
      const out = { v: 1, events: {} };
      for (const n in store.events) {
        const c2 = { ...store.events[n] };
        if (c2.blob) {
          const b = await idbGet(n);
          if (b) {
            c2.data = await new Promise((res) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.readAsDataURL(b);
            });
          }
          delete c2.blob;
        }
        out.events[n] = c2;
      }
      const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
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
        for (const n in store.events) {
          const c2 = store.events[n];
          if (c2.data) {                       // pack audio -> idb
            const b = await fetch(c2.data).then((r) => r.blob());
            await idbPut(n, b);
            delete c2.data;
            c2.blob = true;
          }
        }
        for (const n of Object.keys(SKY.SFX.labState.events)) delete SKY.SFX.labState.events[n];
        decoded.clear();
        installAll(); decodePending(); save(); render();
      } catch (err) { alert('bad pack: ' + err.message); }
    };
    panel.querySelector('#sfx-resetall').onclick = () => {
      if (!confirm('Reset EVERY sound override?')) return;
      for (const n in store.events) if (store.events[n].blob) idbDel(n);
      store = { v: 1, events: {} };
      for (const n of Object.keys(SKY.SFX.labState.events)) {
        delete SKY.SFX.labState.events[n];
        SKY.SFX.labClearBuffer(n);
      }
      decoded.clear();
      save(); decodePending(); render();
      try { S().labApplyMusic(); S().labRefreshAmbient(); } catch (e2) {}
    };
  }

  return { store, render };
})();
