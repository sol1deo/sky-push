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
  let windSrcRef = null, slideSrcRef = null, slideFilterRef = null;
  let noiseBuf = null;
  let watchdog = null, stuckTicks = 0, wired = false;
  let windLevel = 0, slideOn = false;   // last requested values, survive a rebuild

  function sfxVol() { return SKY.Settings ? (SKY.Settings.data.sfxVol ?? 0.8) : 0.8; }
  function musVol() { return SKY.Settings ? (SKY.Settings.data.musicVol ?? 0.5) : 0.5; }
  /* distance falloff for LOUD positional one-shots (gunshots, explosions) —
     steeper than before: across-the-map fire is present but never in-ear */
  function att(dist) { return 1 / (1 + (dist === undefined ? 8 : dist) * 0.14); }
  /* movement & utility sounds (steps, hooks, jumps, dashes…) from OTHER
     players are close-quarters only: full for your own (dist 0), fading to
     SILENT by ~15m — ten people swinging around must not fill your ears */
  function attClose(dist) {
    const d = dist === undefined ? 8 : dist;
    if (d <= 0.01) return 1;
    const t = Math.max(0, 1 - d / 15);
    return t * t;
  }

  /* ---------------- sample bank (https only) ---------------- */
  const canFetch = /^https?:$/.test(location.protocol);
  // NOTE: the old `dash` bank (R&B "swings") is deliberately GONE — it was a
  // literal sword-swing whoosh playing at full volume for every bot dash
  // across the map ("why do I hear sword fights, we have no swords")
  const MANIFEST = {
    fire_light: 4, fire_med: 4, fire_heavy: 2, fire_sniper: 3, glfire: 3,
    flame: 1,
    boom: 3, boom_low: 1, thunder_smp: 1,
    hit: 2, headshot: 2, land: 2, step: 5, pad: 1, grapple: 1,
    reload: 1, reload_done: 1, dry: 1, pick: 2, cash: 4, crown: 1, beep: 1,
    go: 1, ko: 2, aircannon: 1, win: 1, lose: 1, uiclick: 4,
    taunt: 1, cheer: 1, alarm: 1,
  };
  const FILE_FOR = { thunder_smp: 'thunder' };   // bank name -> file prefix
  const bank = {};          // name -> [AudioBuffer] (buffers survive rebuilds)
  let samplesKicked = false;

  /* library recordings ship with a silent lead-in (some R&B files carry close
     to a second of it) — played raw, EVERY sound landed noticeably after the
     action. Measure the real start once at decode time; playback skips it. */
  function trimStart(buf) {
    const thr = 0.004;                     // ≈ -48 dB: content, not noise floor
    let first = buf.length;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < first; i++) {
        if (d[i] > thr || d[i] < -thr) { first = i; break; }
      }
    }
    if (first >= buf.length) first = 0;
    return Math.max(0, first / buf.sampleRate - 0.003);   // keep a 3ms pre-roll
  }

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
          .then((buf) => {
            if (!buf) return;
            buf.__trim = trimStart(buf);
            (bank[name] = bank[name] || [])[idx] = buf;
          })
          .catch(() => {});
      }
    }
  }

  /* ---------------- SFX LAB override layer ----------------
   * The sound editor (?sfxlab, js/sfxlab.js) tunes every event here: custom
   * buffer, volume/pitch multipliers, start trim, reverb send, filter, mute.
   * Overrides load from localStorage on every boot, so a finished mix plays
   * in normal sessions too. */
  const LAB = { events: {}, buffers: {} };   // name -> cfg / decoded custom buffer
  let labReverbNode = null;
  function labReverb() {
    if (labReverbNode || !ctx) return labReverbNode;
    // generated impulse: 1.8s exponential-decay noise (no IR files needed)
    const len = (ctx.sampleRate * 1.8) | 0;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    }
    labReverbNode = ctx.createConvolver();
    labReverbNode.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.8;
    labReverbNode.connect(wet).connect(master);
    return labReverbNode;
  }

  /* has this lab cfg actually been CHANGED from the defaults? (selecting an
     event in the lab creates a default cfg — that alone must not override) */
  function labTouched(c) {
    return !!(c && (c.mute || (c.vol !== undefined && c.vol !== 1) ||
      (c.rate !== undefined && c.rate !== 1) || c.offset != null ||
      (c.rev || 0) > 0 || (c.lp && c.lp < 19000)));
  }

  /* play a bank sample; `variant` picks a FIXED take (weapons must sound the
     same every shot), otherwise a random one (footsteps like variety).
     `wkey` = an optional PER-WEAPON lab key ('wfire_mega'): when that event
     was tweaked (or given its own file) it replaces the shared bank cfg, so
     every gun on one bank can still be tuned separately in the SFX LAB.
     Returns false when the bank isn't ready so callers can fall back to the
     synth version */
  function sample(name, vol, rate, delay, variant, wkey) {
    if (!ctx || !master) return false;
    let o = LAB.events[name];
    let custom = LAB.buffers[name] || null;
    if (wkey) {
      const wo = LAB.events[wkey];
      const wb = LAB.buffers[wkey] || null;
      if (wb || labTouched(wo)) { o = wo; custom = wb || custom; }
    }
    if (o && o.mute) return true;              // deliberately silenced
    const b = bank[name];
    if (!custom && !b) return false;
    const buf = custom || (variant === undefined
      ? b[(Math.random() * b.length) | 0]
      : b[variant % b.length]);
    if (!buf) return false;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = (rate || 1) * ((o && o.rate) || 1);
    const g = ctx.createGain();
    g.gain.value = (vol == null ? 1 : vol) * ((o && o.vol) || 1);
    let head = s;
    if (o && o.lp && o.lp < 19000) {           // optional tone filter
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      head.connect(f); head = f;
    }
    head.connect(g).connect(master);
    if (o && o.rev > 0 && labReverb()) {       // reverb send
      const send = ctx.createGain();
      send.gain.value = o.rev;
      g.connect(send).connect(labReverbNode);
    }
    // start trim: the editor's per-event value wins; bank auto-trim otherwise
    const off = (o && o.offset != null) ? o.offset : (buf.__trim || 0);
    s.start(ctx.currentTime + (delay || 0), off);
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
      // SFX LAB can replace the track outright and tune its level/pitch
      const mo = LAB.events['music_' + musicWant];
      const custom = LAB.buffers['music_' + musicWant];
      if (mo && mo.mute) return;
      musicSrc = ctx.createBufferSource();
      musicSrc.buffer = custom || buf;
      musicSrc.loop = true;
      musicSrc.playbackRate.value = (mo && mo.rate) || 1;
      musicGainNode = ctx.createGain();
      const level = (musicWant === 'menu' ? 0.5 : 0.38) * ((mo && mo.vol) || 1);
      musicGainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
      musicGainNode.gain.linearRampToValueAtTime(level, ctx.currentTime + 1.6);
      musicSrc.connect(musicGainNode).connect(musicBus);
      musicSrc.start();
    };
    // a LAB replacement track doesn't need the shipped file at all
    if (LAB.buffers['music_' + musicWant]) { start(null); return; }
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
    try { ctx = new AC({ latencyHint: 'interactive' }); }
    catch (e) { try { ctx = new AC(); } catch (e2) { ctx = null; return; } }
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
    windSrc.buffer = LAB.buffers.amb_wind || noiseBuf; windSrc.loop = true;
    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass'; windFilter.frequency.value = 400;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(master);
    windSrc.start();
    windSrcRef = windSrc;

    // --- looping slide scrape ---
    const slideSrc = ctx.createBufferSource();
    slideSrc.buffer = LAB.buffers.amb_slide || noiseBuf; slideSrc.loop = true;
    const slideFilter = ctx.createBiquadFilter();
    slideFilter.type = 'bandpass'; slideFilter.frequency.value = 900; slideFilter.Q.value = 0.8;
    slideGain = ctx.createGain(); slideGain.gain.value = 0;
    slideSrc.connect(slideFilter).connect(slideGain).connect(master);
    slideSrc.start();
    slideSrcRef = slideSrc; slideFilterRef = slideFilter;

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

  /* per-weapon shot table: [bank, rate, vol, variant]. REAL unsuppressed
     gunshots (Rust & Blood) — rates near 1, character comes from the bank:
     light = pistol · med = SMG/assault · heavy = SHOTGUN only ·
     sniper = bolt rifles · glfire = grenade launcher THOOMP.
     `variant` pins ONE take per weapon: a gun fires the SAME sound every
     single shot (random takes + random pitch read as a broken soundboard).
     Different weapons on the same bank use different takes + rates, so each
     still has its own voice. */
  const FIRE_SND = {
    pistol:    ['fire_light', 1.0, 0.90, 0],
    burst:     ['fire_light', 1.12, 0.75, 1],
    bouncer:   ['fire_light', 1.18, 0.70, 2],
    magnum:    ['fire_light', 0.78, 0.95, 3],
    smg:       ['fire_med', 1.05, 0.65, 0],
    blaster:   ['fire_med', 0.92, 0.80, 1],
    mega:      ['fire_med', 0.85, 0.80, 2],
    scatter:   ['fire_heavy', 1.05, 0.90, 0],
    boomstick: ['fire_heavy', 0.85, 1.0, 1],
    seeker:    ['fire_heavy', 0.72, 1.0, 1],   // IT tag cannon: shotgun BOOM
    longshot:  ['fire_sniper', 1.0, 0.95, 0],
    piston:    ['fire_sniper', 1.12, 0.90, 1],
    lobber:    ['glfire', 1.0, 0.85, 0],
    quad:      ['glfire', 1.1, 0.75, 1],
    minigun:   ['fire_med', 1.22, 0.42, 2],   // 13 rps — each shot stays quiet
    flamer:    ['fire_light', 1.35, 0.22, 2], // soft huffs under the flame visuals
  };

  return {
    init,
    /* raw context for modules that build their own graphs (voice chat) —
       may be null until the first user gesture calls init() */
    context() { return ctx; },
    /* gunshot: ONE fixed take per weapon at a fixed pitch — every shot of a
       gun sounds identical (only distance changes the level) */
    fire(kind, p, k, dist) {
      k = k || 1;
      const a = att(dist);
      if (a < 0.05) return;
      const row = FIRE_SND[kind] || FIRE_SND.blaster;
      // 'wfire_<kind>' = the SFX LAB's per-weapon override slot
      if (sample(row[0], row[2] * a, row[1], 0, row[3], 'wfire_' + kind)) return;
      const v = SKY.U.clamp(k, 0.45, 1.4) * a;
      noise(0.04, 3200, 0.22 * v, 'highpass');
      tone(420, 180, 0.07, 'triangle', 0.18 * v);
    },
    /* flamethrower jet: its own event (throttled to ~6/s by the caller) —
       overlapping 0.55s roars read as one continuous flame */
    flame(dist) {
      const a = att(dist);
      if (a < 0.05) return;
      if (sample('flame', 0.55 * a, SKY.U.rand(0.96, 1.05))) return;
      noise(0.3, 750, 0.2 * a, 'bandpass');
      noise(0.28, 240, 0.22 * a, 'lowpass', 0.02);
    },
    headshot(dist){ const a = att(dist);
                if (sample('headshot', 0.3 * a, 1.45)) return;
                tone(1180, 880, 0.12, 'square', 0.22 * a); },
    reload()  { if (sample('reload', 0.62, 1.3)) return;
                noise(0.05, 1800, 0.16, 'highpass'); noise(0.05, 1200, 0.14, 'highpass', 0.16); },
    reloadDone(){ if (sample('reload_done', 0.55, 1.15)) return;
                noise(0.05, 2200, 0.18, 'highpass'); tone(520, 380, 0.05, 'square', 0.1); },
    dry()     { if (sample('dry', 0.3, 1.2)) return;
                tone(300, 240, 0.04, 'square', 0.12); },
    /* dash / ground-pound windup: a soft AIR puff (the old sample was a
       sword-swing recording), heard quietly and only nearby */
    dash(dist) { const a = attClose(dist === undefined ? 0 : dist);
                if (a < 0.08) return;
                if (sample('dash', 0.5 * a)) return;
                noise(0.16, 750, 0.14 * a, 'bandpass'); },
    pick()    { if (sample('pick', 0.4, SKY.U.rand(0.95, 1.05))) return;
                tone(620, 930, 0.12, 'triangle', 0.22); tone(930, 1240, 0.14, 'triangle', 0.18, 0.09); },
    /* door swing: soft mechanical clunk */
    door(dist) { const a = attClose(dist);
                if (a < 0.05) return;
                if (sample('door', 0.5 * a)) return;
                if (sample('reload', 0.5 * a, 0.7)) return;
                tone(200, 130, 0.09, 'square', 0.12 * a); },
    /* ricochet "boing" */
    bounce(dist) { const a = att(dist);
                if (a < 0.06) return;
                if (sample('bounce', 0.35 * a)) return;
                if (sample('pick', 0.2 * a, SKY.U.rand(1.6, 1.9))) return;
                tone(700, 1100, 0.06, 'triangle', 0.14 * a); },
    /* piston compression clicks at 33/66/100% */
    chargeTick(th) {
      if (sample('charge', 0.2 + th * 0.15, 0.8 + th * 0.5)) return;
      if (sample('beep', 0.16 + th * 0.1, 0.7 + th * 0.7)) return;
      tone(240 + th * 420, 240 + th * 420, 0.05, 'square', 0.1 + th * 0.05);
    },
    /* water entry: layered noise splash, k = 0..1 plunge intensity */
    splash(k, dist) {
      const a = attClose(dist === undefined ? 0 : dist);
      if (a < 0.05) return;
      if (sample('splash', (0.25 + k * 0.5) * a)) return;
      const v = (0.2 + k * 0.5) * a;
      noise(0.09, 2400, v * 0.8, 'highpass');
      noise(0.5, 900, v, 'bandpass', 0.02);
      tone(220, 70, 0.28, 'sine', v * 0.5, 0.01);
    },
    /* head under the surface: everything muffles (GTA-style) */
    setUnderwater(on) {
      if (!ctx || !outFilter) return;
      if (this._uw === !!on) return;
      this._uw = !!on;
      const t0 = ctx.currentTime;
      const f = outFilter.frequency;
      f.cancelScheduledValues(t0);
      f.setValueAtTime(Math.max(200, f.value), t0);
      f.exponentialRampToValueAtTime(on ? 620 : 19000, t0 + 0.22);
    },
    /* close explosion: brief muffle + faint ring, then hearing comes back */
    earRing(k) {
      if (!ctx || !outFilter) return;
      const t0 = ctx.currentTime;
      const f = outFilter.frequency;
      f.cancelScheduledValues(t0);
      f.setValueAtTime(Math.min(f.value, 900), t0);
      // hearing comes back — to "muffled" if we're under water right now
      f.exponentialRampToValueAtTime(this._uw ? 620 : 19000, t0 + 1.4 + k * 0.8);
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
    taunt(dist) { const a = attClose(dist === undefined ? 0 : dist);
                if (a < 0.05) return;
                if (sample('taunt', 0.35 * a, SKY.U.rand(0.94, 1.08))) return;
                tone(392, 392, 0.12, 'square', 0.12 * a); },
    /* match-end crowd */
    cheer()   { sample('cheer', 0.45); },
    honk()    { if (sample('honk', 0.5)) return;
                tone(220, 220, 0.35, 'sawtooth', 0.4); tone(277, 277, 0.35, 'sawtooth', 0.35); tone(220, 220, 0.4, 'sawtooth', 0.4, 0.5); tone(277, 277, 0.4, 'sawtooth', 0.35, 0.5); },
    rumble(dist) { const a = att(dist === undefined ? 0 : dist);
                if (a < 0.06) return;
                if (sample('rumble', 0.5 * a)) return;
                noise(0.6, 140, 0.4 * a); tone(70, 35, 0.5, 'sine', 0.35 * a); },
    thunder() { if (sample('thunder_smp', 0.5, 0.85)) { noise(0.9, 220, 0.2, 'lowpass', 0.1); return; }
                noise(0.08, 4000, 0.35, 'highpass'); noise(0.9, 220, 0.4, 'lowpass', 0.06); },
    gust()    { if (sample('gust', 0.35)) return;
                noise(1.2, 700, 0.22, 'bandpass'); },
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
      const a = attClose(dist === undefined ? 0 : dist);
      if (a < 0.05) return;
      sample('step', (0.3 + v * 0.3) * a, SKY.U.rand(0.92, 1.08));
    },
    cash()    { if (sample('cash', 0.26, SKY.U.rand(1.0, 1.15))) return;
                tone(1320, 1760, 0.07, 'square', 0.14); },
    crown()   { if (sample('crown', 0.36)) return;
                [660, 880, 1100].forEach((f, i) => tone(f, f, 0.14, 'triangle', 0.2, i * 0.08)); },
    overtime(){ if (sample('alarm', 0.4)) return;
                tone(220, 110, 0.5, 'sine', 0.18); },
    airCannon(dist){ const a = att(dist === undefined ? 0 : dist);
                if (a < 0.05) return;
                if (sample('aircannon', 0.8 * a, 1.05)) return;
                noise(0.32, 420, 0.4 * a); },
    hit(p, dist) { const a = att(dist);
                if (a < 0.06) return;
                if (sample('hit', (0.3 + p * 0.22) * a, 1.15 - p * 0.25)) return;
                tone(130 + p * 90, 40, 0.16, 'sine', (0.3 + p * 0.2) * a); },
    jump(dist) { const a = attClose(dist === undefined ? 0 : dist);
                if (a < 0.1) return;
                if (sample('jump', 0.4 * a, SKY.U.rand(0.95, 1.05))) return;
                noise(0.05, 650, 0.05 * a, 'bandpass'); },   // soft push-off puff
    land(i, dist) { const a = attClose(dist === undefined ? 0 : dist);
                if (a < 0.05) return;
                if (sample('land', SKY.U.clamp(i, 0, 1) * 0.32 * a, SKY.U.rand(0.95, 1.1))) return;
                noise(0.09, 320, SKY.U.clamp(i, 0, 1) * 0.2 * a); },
    pad()     { if (sample('pad', 0.4, 1.35)) return;
                tone(220, 640, 0.24, 'sine', 0.26); },
    grapple(dist) { const a = attClose(dist === undefined ? 0 : dist);
                if (a < 0.05) return;
                // the new sample IS the rope whoosh — play it as designed
                if (sample('grapple', 0.5 * a, SKY.U.rand(0.96, 1.08))) return;
                noise(0.14, 2200, 0.18 * a, 'highpass'); tone(500, 900, 0.12, 'triangle', 0.14 * a); },
    grapMiss(){ if (sample('grapmiss', 0.3)) return;
                tone(300, 180, 0.07, 'square', 0.12); },
    /* heavy-knock jam: a dead mechanical double-clunk — the hook/cannon
       refusing to fire (replaces the old "Hook jammed!" text) */
    jammed()  { if (sample('dry', 0.44, 0.7)) { sample('dry', 0.32, 0.55, 0.09); return; }
                tone(230, 150, 0.05, 'square', 0.16);
                tone(170, 110, 0.07, 'square', 0.13, 0.09); },
    scream(loud) { // falling: a rush of wind, not the old sawtooth siren
      if (sample('scream', loud ? 0.5 : 0.3)) return;
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
    slideStart(dist) { const a = attClose(dist === undefined ? 0 : dist);
                if (a < 0.08) return;
                if (sample('slide', 0.4 * a)) return;
                noise(0.12, 700, 0.15 * a, 'bandpass'); },

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
      const o = LAB.events.amb_wind;
      if (o && o.mute) { windGain.gain.value = 0; return; }
      windGain.gain.value = windLevel * SKY.TUNING.audio.windMax * ((o && o.vol) || 1);
      windFilter.frequency.value = 380 + windLevel * 950;
    },
    setSlide(on) {
      slideOn = !!on;
      if (!slideGain) return;
      const o = LAB.events.amb_slide;
      slideGain.gain.value = (slideOn && !(o && o.mute))
        ? 0.12 * ((o && o.vol) || 1) : 0;
    },
    /* SFX LAB live hooks: re-apply the current music with fresh overrides /
       swap the ambient loop sources for custom buffers */
    labApplyMusic() {
      musicUrl = null;
      stopMusic(false);
      applyMusic();
    },
    labRefreshAmbient() {
      if (!ctx) return;
      const swap = (ref, buffer, dest, rate) => {
        try { ref.stop(); } catch (e) {}
        const s = ctx.createBufferSource();
        s.buffer = buffer;
        s.loop = true;
        s.playbackRate.value = rate || 1;
        s.connect(dest);
        s.start();
        return s;
      };
      if (windFilter) {
        const o = LAB.events.amb_wind;
        windSrcRef = swap(windSrcRef, LAB.buffers.amb_wind || noiseBuf, windFilter,
          o && o.rate);
      }
      if (slideGain && slideFilterRef) {
        const o = LAB.events.amb_slide;
        slideSrcRef = swap(slideSrcRef, LAB.buffers.amb_slide || noiseBuf, slideFilterRef,
          o && o.rate);
      }
    },
    resume: resumeCtx,

    /* ================= SFX LAB (js/sfxlab.js drives this) ================= */
    labState: LAB,                    // { events: {name: cfg}, buffers }
    labBankNames() { return Object.keys(MANIFEST); },
    /* per-weapon fire slots ('wfire_mega') resolve to the exact bank take
       that weapon is pinned to, so the lab shows/plays the right sound */
    labFireKinds() { return Object.keys(FIRE_SND); },
    labFireRow(name) {
      if (name.slice(0, 6) !== 'wfire_') return null;
      return FIRE_SND[name.slice(6)] || FIRE_SND.blaster;
    },
    labBankInfo(name) {
      const fr = this.labFireRow(name);
      if (fr) {
        const b = bank[fr[0]];
        return { takes: b && b.length && b[fr[3] % b.length] ? 1 : 0 };
      }
      const b = bank[name];
      return { takes: b ? b.filter(Boolean).length : 0 };
    },
    /* the buffer the lab shows/edits: custom first, else bank take 0 */
    labBuffer(name) {
      if (LAB.buffers[name]) return LAB.buffers[name];
      const fr = this.labFireRow(name);
      if (fr) {
        if (LAB.buffers[fr[0]]) return LAB.buffers[fr[0]];   // bank-wide custom file
        const b = bank[fr[0]];
        return (b && b.length && b[fr[3] % b.length]) || null;
      }
      return (bank[name] && bank[name][0]) || null;
    },
    labTrimOf(buf) { return trimStart(buf); },
    labSetBuffer(name, arrayBuffer) {
      if (!ctx) return Promise.reject(new Error('audio not started'));
      return ctx.decodeAudioData(arrayBuffer).then((buf) => {
        buf.__trim = 0;               // the lab's offset dial owns custom trims
        LAB.buffers[name] = buf;
        return buf;
      });
    },
    labClearBuffer(name) { delete LAB.buffers[name]; },
    /* raw preview: the configured sound, none of the event's in-game scaling */
    labPlayRaw(name) { return sample(name, 0.9, 1); },
    /* output meter for the lab (taps the shared out node: SFX + music) */
    labAnalyser() {
      if (!ctx || !outFilter) return null;
      if (!this._labAn) {
        this._labAn = ctx.createAnalyser();
        this._labAn.fftSize = 512;
        outFilter.connect(this._labAn);
      }
      return this._labAn;
    },
  };
})();
