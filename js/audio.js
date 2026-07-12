/* =============================================================================
 * SKY PUSH — audio (WebAudio)
 * Real CC0 samples (assets/audio/sfx, Kenney packs) + music tracks load on
 * https hosts; every event keeps its original synthesized fallback so the
 * game still has sound from file:// or before the samples arrive.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.SFX = (function () {
  let ctx = null, master = null;        // master = the SFX bus
  let outFilter = null, musicBus = null;
  let windGain = null, windFilter = null;
  let slideGain = null;
  let noiseBuf = null;
  let watchdog = null, stuckTicks = 0, wired = false;
  let windLevel = 0, slideOn = false;   // last requested values, survive a rebuild

  function sfxVol() { return SKY.Settings ? (SKY.Settings.data.sfxVol ?? 0.8) : 0.8; }
  function musVol() { return SKY.Settings ? (SKY.Settings.data.musicVol ?? 0.5) : 0.5; }
  /* distance falloff for positional one-shots (other players' guns should
     not fire inside YOUR ear) */
  function att(dist) { return 1 / (1 + (dist === undefined ? 8 : dist) * 0.09); }

  /* ---------------- sample bank (https only) ---------------- */
  const canFetch = /^https?:$/.test(location.protocol);
  const MANIFEST = {
    fire_light: 4, fire_med: 4, fire_heavy: 3, glfire: 3,
    boom: 3, boom_low: 1, thunder_smp: 1,
    hit: 2, headshot: 2, land: 2, step: 5, dash: 2, pad: 1, grapple: 1,
    reload: 1, reload_done: 1, dry: 1, pick: 2, cash: 4, crown: 1, beep: 1,
    go: 1, ko: 2, aircannon: 1, win: 1, lose: 1, uiclick: 4,
    taunt: 1, cheer: 1, alarm: 1,
  };
  const FILE_FOR = { thunder_smp: 'thunder' };   // bank name -> file prefix
  const bank = {};          // name -> [AudioBuffer] (buffers survive rebuilds)
  let samplesKicked = false;

  function loadSamples() {
    if (!canFetch || samplesKicked || !ctx) return;
    samplesKicked = true;
    for (const name in MANIFEST) {
      const prefix = FILE_FOR[name] || name;
      for (let i = 0; i < MANIFEST[name]; i++) {
        const idx = i;
        fetch('assets/audio/sfx/' + prefix + '_' + i + '.ogg')
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((ab) => (ab && ctx ? ctx.decodeAudioData(ab) : null))
          .then((buf) => { if (buf) (bank[name] = bank[name] || [])[idx] = buf; })
          .catch(() => {});
      }
    }
  }

  /* play a random variant; returns false when the bank isn't ready
     so callers can fall back to the synth version */
  function sample(name, vol, rate, delay) {
    const b = bank[name];
    if (!ctx || !master || !b) return false;
    const buf = b[(Math.random() * b.length) | 0];
    if (!buf) return false;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate || 1;
    const g = ctx.createGain();
    g.gain.value = vol == null ? 1 : vol;
    s.connect(g).connect(master);
    s.start(ctx.currentTime + (delay || 0));
    return true;
  }

  /* -------- music: calm ambient only, kept deliberately quiet -------- */
  const MUSIC_FILES = {
    menu: ['assets/audio/music/menu_sky.ogg'],
    game: ['assets/audio/music/game_calm.mp3'],
  };
  const musicBufs = {};     // url -> AudioBuffer
  let musicWant = 'menu';   // 'menu' | 'game' | null — boot lands on the menu
  let musicSrc = null, musicGainNode = null, musicUrl = null, musicRot = 0;

  function stopMusic(fade) {
    if (!musicSrc) return;
    const src = musicSrc, g = musicGainNode;
    musicSrc = null; musicGainNode = null; musicUrl = null;
    try {
      g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + (fade ? 0.9 : 0.05));
      src.stop(ctx.currentTime + (fade ? 1 : 0.1));
    } catch (e) {}
  }

  function applyMusic() {
    if (!ctx || !master || !canFetch) return;
    if (!musicWant) { stopMusic(true); return; }
    const list = MUSIC_FILES[musicWant];
    if (!list) { stopMusic(true); return; }
    const url = list[musicRot % list.length];
    if (musicUrl === url) return;
    stopMusic(true);
    const start = (buf) => {
      if (!ctx || musicUrl) return;       // superseded meanwhile
      musicUrl = url;
      musicSrc = ctx.createBufferSource();
      musicSrc.buffer = buf;
      musicSrc.loop = true;
      musicGainNode = ctx.createGain();
      const level = musicWant === 'menu' ? 0.5 : 0.38;   // scaled by the music slider
      musicGainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
      musicGainNode.gain.linearRampToValueAtTime(level, ctx.currentTime + 1.6);
      musicSrc.connect(musicGainNode).connect(musicBus);
      musicSrc.start();
    };
    if (musicBufs[url]) { start(musicBufs[url]); return; }
    fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => (ab && ctx ? ctx.decodeAudioData(ab) : null))
      .then((buf) => { if (buf) { musicBufs[url] = buf; start(buf); } })
      .catch(() => {});
  }

  function makeNoiseBuffer() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* The context can silently stop mid-match: tab switch, bluetooth headset
     reconnect, OS output-device change, mobile 'interrupted' state. Every
     path below funnels into resumeCtx(); if the context refuses to come
     back it is torn down and rebuilt on the next user gesture. */
  function resumeCtx() {
    if (!ctx || ctx.state === 'running') return;
    if (ctx.state === 'closed') { rebuild(); return; }
    ctx.resume().catch(() => {});
  }

  function rebuild() {
    try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (e) {}
    ctx = null; master = null; outFilter = null; musicBus = null;
    windGain = null; windFilter = null; slideGain = null;
    musicSrc = null; musicGainNode = null; musicUrl = null;
    stuckTicks = 0;
    init();
  }

  function wireRecovery() {
    if (wired) return;
    wired = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeCtx(); });
    window.addEventListener('focus', resumeCtx);
    // any input counts as the user gesture browsers want for resume()
    window.addEventListener('pointerdown', resumeCtx, true);
    window.addEventListener('keydown', resumeCtx, true);
    watchdog = setInterval(() => {
      if (!ctx) return;
      if (ctx.state === 'running') { stuckTicks = 0; return; }
      stuckTicks++;
      resumeCtx();
      if (stuckTicks >= 4) rebuild();   // ~8s dead despite resume attempts
    }, 2000);
  }

  function init() {
    if (ctx) { resumeCtx(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { ctx = new AC(); } catch (e) { ctx = null; return; }
    ctx.onstatechange = () => { if (ctx && ctx.state !== 'running') resumeCtx(); };
    // graph: sfx bus + music bus -> shared lowpass (ear-ring muffle) -> out
    outFilter = ctx.createBiquadFilter();
    outFilter.type = 'lowpass';
    outFilter.frequency.value = 19000;
    outFilter.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = SKY.TUNING.audio.master * sfxVol();
    master.connect(outFilter);
    musicBus = ctx.createGain();
    musicBus.gain.value = musVol();
    musicBus.connect(outFilter);
    noiseBuf = makeNoiseBuffer();

    // --- looping wind bed, gain driven by player speed ---
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuf; windSrc.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass'; windFilter.frequency.value = 400;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(master);
    windSrc.start();

    // --- looping slide scrape ---
    const slideSrc = ctx.createBufferSource();
    slideSrc.buffer = noiseBuf; slideSrc.loop = true;
    const slideFilter = ctx.createBiquadFilter();
    slideFilter.type = 'bandpass'; slideFilter.frequency.value = 900; slideFilter.Q.value = 0.8;
    slideGain = ctx.createGain(); slideGain.gain.value = 0;
    slideSrc.connect(slideFilter).connect(slideGain).connect(master);
    slideSrc.start();

    // restore continuous levels after a mid-match rebuild
    windGain.gain.value = windLevel * SKY.TUNING.audio.windMax;
    slideGain.gain.value = slideOn ? 0.12 : 0;
    wireRecovery();
    loadSamples();
    // music source dies with a torn-down context — restart what was playing
    if (musicWant) { musicUrl = null; applyMusic(); }
  }

  /* one-shot tone helper: frequency slides f0 -> f1 over dur */
  function tone(f0, f1, dur, type, vol, delay) {
    if (!ctx) return;
    if (!isFinite(f0) || !isFinite(vol) || vol <= 0.001) return;  // a NaN here mutes the whole graph
    const t0 = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /* one-shot filtered noise burst */
  function noise(dur, freq, vol, type, delay) {
    if (!ctx) return;
    if (!isFinite(freq) || !isFinite(vol) || vol <= 0.001) return;
    const t0 = ctx.currentTime + (delay || 0);
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type || 'lowpass'; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    s.connect(f).connect(g).connect(master);
    s.start(t0); s.stop(t0 + dur + 0.02);
  }

  /* per-weapon shot table: [bank, rate, vol]. REAL unsuppressed gunshots
     (Rust & Blood) — rates near 1, character comes from the bank:
     light = pistol · med = SMG/assault · heavy = shotgun/sniper ·
     glfire = grenade launcher THOOMP */
  const FIRE_SND = {
    pistol:    ['fire_light', 1.0, 0.90],
    smg:       ['fire_med', 1.05, 0.65],
    blaster:   ['fire_med', 0.92, 0.80],
    burst:     ['fire_light', 1.12, 0.75],
    scatter:   ['fire_heavy', 1.05, 0.90],
    boomstick: ['fire_heavy', 0.85, 1.0],
    longshot:  ['fire_heavy', 1.0, 0.95],
    magnum:    ['fire_light', 0.78, 0.95],
    mega:      ['fire_med', 0.85, 0.80],
    bouncer:   ['fire_light', 1.18, 0.70],
    piston:    ['fire_heavy', 1.12, 0.90],
    seeker:    ['fire_heavy', 0.70, 1.0],    // IT tag cannon: deep BOOM
    lobber:    ['glfire', 1.0, 0.85],
    quad:      ['glfire', 1.1, 0.75],
  };

  return {
    init,
    /* gunshot: kind-specific soft sample, distance-attenuated */
    fire(kind, p, k, dist) {
      k = k || 1;
      const a = att(dist);
      if (a < 0.05) return;
      const row = FIRE_SND[kind] || FIRE_SND.blaster;
      if (sample(row[0], row[2] * a, row[1] * SKY.U.rand(0.96, 1.05))) return;
      const v = SKY.U.clamp(k, 0.45, 1.4) * a;
      noise(0.04, 3200, 0.22 * v, 'highpass');
      tone(420, 180, 0.07, 'triangle', 0.18 * v);
    },
    headshot(dist){ const a = att(dist);
                if (sample('headshot', 0.3 * a, 1.45)) return;
                tone(1180, 880, 0.12, 'square', 0.22 * a); },
    reload()  { if (sample('reload', 0.3, 1.3)) return;
                noise(0.05, 1800, 0.16, 'highpass'); noise(0.05, 1200, 0.14, 'highpass', 0.16); },
    reloadDone(){ if (sample('reload_done', 0.32, 1.15)) return;
                noise(0.05, 2200, 0.18, 'highpass'); tone(520, 380, 0.05, 'square', 0.1); },
    dry()     { if (sample('dry', 0.3, 1.2)) return;
                tone(300, 240, 0.04, 'square', 0.12); },
    dash()    { if (sample('dash', 0.38, SKY.U.rand(1.15, 1.35))) return;
                noise(0.22, 900, 0.25, 'bandpass'); },
    pick()    { if (sample('pick', 0.4, SKY.U.rand(0.95, 1.05))) return;
                tone(620, 930, 0.12, 'triangle', 0.22); tone(930, 1240, 0.14, 'triangle', 0.18, 0.09); },
    /* door swing: soft mechanical clunk */
    door(dist) { const a = att(dist);
                if (a < 0.06) return;
                if (sample('reload', 0.5 * a, 0.7)) return;
                tone(200, 130, 0.09, 'square', 0.12 * a); },
    /* ricochet "boing" */
    bounce(dist) { const a = att(dist);
                if (a < 0.06) return;
                if (sample('pick', 0.2 * a, SKY.U.rand(1.6, 1.9))) return;
                tone(700, 1100, 0.06, 'triangle', 0.14 * a); },
    /* piston compression clicks at 33/66/100% */
    chargeTick(th) {
      if (sample('beep', 0.16 + th * 0.1, 0.7 + th * 0.7)) return;
      tone(240 + th * 420, 240 + th * 420, 0.05, 'square', 0.1 + th * 0.05);
    },
    /* close explosion: brief muffle + faint ring, then hearing comes back */
    earRing(k) {
      if (!ctx || !outFilter) return;
      const t0 = ctx.currentTime;
      const f = outFilter.frequency;
      f.cancelScheduledValues(t0);
      f.setValueAtTime(Math.min(f.value, 900), t0);
      f.exponentialRampToValueAtTime(19000, t0 + 1.4 + k * 0.8);
      const o = ctx.createOscillator();
      o.frequency.value = 3400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05 + 0.06 * k, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
      o.connect(g).connect(ctx.destination);   // rings THROUGH the muffle
      o.start(t0); o.stop(t0 + 1.25);
    },
    /* live volume sliders */
    setVolumes() {
      if (master) master.gain.value = SKY.TUNING.audio.master * sfxVol();
      if (musicBus) musicBus.gain.value = musVol();
    },
    taunt()   { if (sample('taunt', 0.35, SKY.U.rand(0.94, 1.08))) return;
                tone(392, 392, 0.12, 'square', 0.12); },
    /* match-end crowd */
    cheer()   { sample('cheer', 0.45); },
    honk()    { tone(220, 220, 0.35, 'sawtooth', 0.4); tone(277, 277, 0.35, 'sawtooth', 0.35); tone(220, 220, 0.4, 'sawtooth', 0.4, 0.5); tone(277, 277, 0.4, 'sawtooth', 0.35, 0.5); },
    rumble()  { noise(0.6, 140, 0.4); tone(70, 35, 0.5, 'sine', 0.35); },
    thunder() { if (sample('thunder_smp', 0.5, 0.85)) { noise(0.9, 220, 0.2, 'lowpass', 0.1); return; }
                noise(0.08, 4000, 0.35, 'highpass'); noise(0.9, 220, 0.4, 'lowpass', 0.06); },
    gust()    { noise(1.2, 700, 0.22, 'bandpass'); },
    boom(dist){ const a = att(dist);
                if (a < 0.05) return;
                if (sample('boom', 0.95 * a, SKY.U.rand(0.95, 1.1))) {
                  if (a > 0.5) sample('boom_low', 0.55 * a, 1.1, 0.02);
                  return;
                }
                noise(0.5, 300, 0.5 * a); noise(0.08, 3000, 0.25 * a, 'highpass'); },
    beep()    { if (sample('beep', 0.3)) return;
                tone(880, 880, 0.07, 'square', 0.15); },
    /* menu/UI click — soft select tick (400 pack) */
    ui()      { if (sample('uiclick', 0.22, SKY.U.rand(0.96, 1.06))) return;
                tone(700, 700, 0.035, 'square', 0.07); },
    /* footstep: v = 0..1 run intensity, dist for other players' feet */
    step(v, dist) {
      const a = att(dist === undefined ? 0 : dist);
      if (a < 0.07) return;
      sample('step', (0.13 + v * 0.13) * a, SKY.U.rand(0.92, 1.08));
    },
    cash()    { if (sample('cash', 0.26, SKY.U.rand(1.0, 1.15))) return;
                tone(1320, 1760, 0.07, 'square', 0.14); },
    crown()   { if (sample('crown', 0.36)) return;
                [660, 880, 1100].forEach((f, i) => tone(f, f, 0.14, 'triangle', 0.2, i * 0.08)); },
    overtime(){ if (sample('alarm', 0.4)) return;
                tone(220, 110, 0.5, 'sine', 0.18); },
    airCannon(){ if (sample('aircannon', 0.8, 1.05)) return;
                noise(0.32, 420, 0.4); },
    hit(p, dist) { const a = att(dist);
                if (a < 0.06) return;
                if (sample('hit', (0.3 + p * 0.22) * a, 1.15 - p * 0.25)) return;
                tone(130 + p * 90, 40, 0.16, 'sine', (0.3 + p * 0.2) * a); },
    jump()    { noise(0.05, 650, 0.05, 'bandpass'); },   // soft push-off puff
    land(i)   { if (sample('land', SKY.U.clamp(i, 0, 1) * 0.32, SKY.U.rand(0.95, 1.1))) return;
                noise(0.09, 320, SKY.U.clamp(i, 0, 1) * 0.2); },
    pad()     { if (sample('pad', 0.4, 1.35)) return;
                tone(220, 640, 0.24, 'sine', 0.26); },
    grapple() { if (sample('grapple', 0.3, 1.5)) return;
                noise(0.14, 2200, 0.18, 'highpass'); tone(500, 900, 0.12, 'triangle', 0.14); },
    grapMiss(){ tone(300, 180, 0.07, 'square', 0.12); },
    /* heavy-knock jam: a dead mechanical double-clunk — the hook/cannon
       refusing to fire (replaces the old "Hook jammed!" text) */
    jammed()  { if (sample('dry', 0.44, 0.7)) { sample('dry', 0.32, 0.55, 0.09); return; }
                tone(230, 150, 0.05, 'square', 0.16);
                tone(170, 110, 0.07, 'square', 0.13, 0.09); },
    scream(loud) { // falling: a rush of wind, not the old sawtooth siren
      noise(0.8, 750, loud ? 0.2 : 0.1, 'bandpass');
    },
    ko(loud)  { const v = loud ? 0.42 : 0.26;
                if (sample('ko', v, 0.95)) return;
                tone(600, 90, 0.5, 'sawtooth', v); noise(0.3, 500, v * 0.7); },
    countdown(){ if (sample('beep', 0.3, 0.85)) return;
                tone(440, 440, 0.09, 'square', 0.16); },
    go()      { if (sample('go', 0.4)) return;
                tone(660, 660, 0.14, 'square', 0.2); tone(880, 880, 0.2, 'square', 0.18, 0.07); },
    win()     { if (sample('win', 0.38)) return;
                [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.22, 'triangle', 0.22, i * 0.13)); },
    slideStart(){ noise(0.12, 700, 0.15, 'bandpass'); },

    /* background music: 'menu' | 'game' | null. Combat tracks rotate. */
    music(key) {
      if (key === 'game' && musicWant !== 'game') musicRot++;
      musicWant = key || null;
      applyMusic();
    },

    /* continuous feedback, called every frame */
    setWind(x01) {
      if (!isFinite(x01)) return;
      windLevel = SKY.U.clamp01(x01);
      if (!windGain) return;
      windGain.gain.value = windLevel * SKY.TUNING.audio.windMax;
      windFilter.frequency.value = 380 + windLevel * 950;
    },
    setSlide(on) {
      slideOn = !!on;
      if (!slideGain) return;
      slideGain.gain.value = slideOn ? 0.12 : 0;
    },
    resume: resumeCtx,
  };
})();
