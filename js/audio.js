/* =============================================================================
 * SKY PUSH — audio (WebAudio)
 * Real CC0 samples (assets/audio/sfx, Kenney packs) + music tracks load on
 * https hosts; every event keeps its original synthesized fallback so the
 * game still has sound from file:// or before the samples arrive.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.SFX = (function () {
  let ctx = null, master = null;
  let windGain = null, windFilter = null;
  let slideGain = null;
  let noiseBuf = null;
  let watchdog = null, stuckTicks = 0, wired = false;
  let windLevel = 0, slideOn = false;   // last requested values, survive a rebuild

  /* ---------------- sample bank (https only) ---------------- */
  const canFetch = /^https?:$/.test(location.protocol);
  const MANIFEST = {
    fire_light: 5, fire_med: 5, fire_heavy: 5, boom: 3, boom_low: 1, thunder_smp: 1,
    hit: 3, headshot: 2, land: 3, step: 5, dash: 2, pad: 1, grapple: 1,
    reload: 1, reload_done: 1, dry: 1, pick: 2, cash: 4, crown: 1, beep: 1,
    go: 1, ko: 1, aircannon: 1, win: 1, lose: 1,
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

  /* ---------------- music (menu theme + combat tracks) ---------------- */
  const MUSIC_FILES = {
    menu: ['assets/audio/music/menu_theme.mp3'],
    game: ['assets/audio/music/combat_rush.ogg', 'assets/audio/music/combat_tech.mp3'],
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
      const level = musicWant === 'menu' ? 0.34 : 0.26;
      musicGainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
      musicGainNode.gain.linearRampToValueAtTime(level, ctx.currentTime + 1.2);
      musicSrc.connect(musicGainNode).connect(master);
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
    ctx = null; master = null; windGain = null; windFilter = null; slideGain = null;
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
    master = ctx.createGain();
    master.gain.value = SKY.TUNING.audio.master;
    master.connect(ctx.destination);
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

  return {
    init,
    /* gunshot: real blaster sample by kick-weight tier, synth fallback */
    fire(p, k) {
      k = k || 1;
      const v = SKY.U.clamp(k, 0.45, 1.6);
      const tier = k < 0.75 ? 'fire_light' : k < 1.2 ? 'fire_med' : 'fire_heavy';
      if (sample(tier, 0.4 * v, SKY.U.rand(0.94, 1.08))) return;
      noise(0.05, 3200, 0.4 * v, 'highpass');                    // crack
      noise(0.12 + k * 0.05, 500, 0.3 * v);                      // body
      tone(150 - Math.min(k, 1.5) * 40, 45, 0.12 + k * 0.06, 'sine', 0.45 * v);  // thump
    },
    headshot(){ if (sample('headshot', 0.5, 1.35)) return;
                tone(1180, 880, 0.12, 'square', 0.3); tone(1760, 1320, 0.1, 'sine', 0.2, 0.02); },
    reload()  { if (sample('reload', 0.4, 1.25)) return;
                noise(0.05, 1800, 0.22, 'highpass'); noise(0.05, 1200, 0.2, 'highpass', 0.16); },
    reloadDone(){ if (sample('reload_done', 0.45, 1.1)) return;
                noise(0.05, 2200, 0.25, 'highpass'); tone(520, 380, 0.05, 'square', 0.12); },
    dry()     { if (sample('dry', 0.4, 1.2)) return;
                tone(300, 240, 0.04, 'square', 0.16); },
    dash()    { if (sample('dash', 0.5, SKY.U.rand(1.1, 1.3))) return;
                noise(0.22, 900, 0.35, 'bandpass'); tone(300, 700, 0.18, 'sine', 0.2); },
    pick()    { if (sample('pick', 0.5, SKY.U.rand(0.95, 1.05))) return;
                tone(620, 930, 0.12, 'triangle', 0.3); tone(930, 1240, 0.14, 'triangle', 0.25, 0.09); },
    taunt()   { tone(392, 392, 0.12, 'square', 0.2); tone(523, 523, 0.14, 'square', 0.2, 0.13); },
    honk()    { tone(220, 220, 0.35, 'sawtooth', 0.4); tone(277, 277, 0.35, 'sawtooth', 0.35); tone(220, 220, 0.4, 'sawtooth', 0.4, 0.5); tone(277, 277, 0.4, 'sawtooth', 0.35, 0.5); },
    rumble()  { noise(0.6, 140, 0.55); tone(70, 35, 0.5, 'sine', 0.5); },
    thunder() { if (sample('thunder_smp', 0.7, 0.8)) { noise(0.9, 220, 0.3, 'lowpass', 0.1); return; }
                noise(0.08, 4000, 0.5, 'highpass'); noise(0.9, 220, 0.6, 'lowpass', 0.06); tone(60, 30, 0.8, 'sine', 0.45, 0.05); },
    gust()    { noise(1.2, 700, 0.3, 'bandpass'); },
    boom()    { if (sample('boom', 0.65, SKY.U.rand(0.92, 1.05))) { sample('boom_low', 0.5, 1, 0.02); return; }
                noise(0.5, 300, 0.7); tone(90, 30, 0.5, 'sine', 0.6); noise(0.08, 3000, 0.35, 'highpass'); },
    beep()    { if (sample('beep', 0.4)) return;
                tone(880, 880, 0.07, 'square', 0.2); },
    cash()    { if (sample('cash', 0.4, SKY.U.rand(0.98, 1.12))) return;
                tone(1320, 1760, 0.07, 'square', 0.2); tone(1760, 1760, 0.08, 'square', 0.18, 0.08); },
    crown()   { if (sample('crown', 0.5)) return;
                [660, 880, 1100].forEach((f, i) => tone(f, f, 0.14, 'triangle', 0.26, i * 0.08)); },
    overtime(){ tone(220, 110, 0.5, 'sawtooth', 0.4); tone(330, 165, 0.5, 'sawtooth', 0.3, 0.1); },
    airCannon(){ if (sample('aircannon', 0.6, 1.15)) return;
                noise(0.32, 420, 0.6); tone(160, 40, 0.3, 'sine', 0.5); },
    hit(p)    { if (sample('hit', 0.45 + p * 0.3, 1.15 - p * 0.25)) return;
                tone(130 + p * 90, 40, 0.18, 'sine', 0.5 + p * 0.3); tone(700 + p * 500, 160, 0.1, 'square', 0.18 + p * 0.15); noise(0.1, 800, 0.2); },
    jump()    { tone(300, 430, 0.08, 'sine', 0.14); },
    land(i)   { if (sample('land', SKY.U.clamp(i, 0, 1) * 0.45, SKY.U.rand(0.95, 1.1))) return;
                noise(0.09, 320, SKY.U.clamp(i, 0, 1) * 0.3); },
    pad()     { if (sample('pad', 0.55, 1.3)) return;
                tone(220, 640, 0.24, 'sine', 0.4); tone(110, 320, 0.24, 'triangle', 0.28); },
    grapple() { if (sample('grapple', 0.4, 1.5)) return;
                noise(0.14, 2200, 0.25, 'highpass'); tone(500, 900, 0.12, 'triangle', 0.2); },
    grapMiss(){ tone(300, 180, 0.07, 'square', 0.12); },
    scream(loud) { // comedic falling whistle
      const v = loud ? 0.4 : 0.18;
      tone(900, 200, 0.9, 'sawtooth', v);
      tone(1350, 300, 0.9, 'sine', v * 0.5);
    },
    ko(loud)  { const v = loud ? 0.6 : 0.35;
                if (sample('ko', v, 0.9)) { tone(600, 90, 0.4, 'sawtooth', v * 0.4); return; }
                tone(600, 90, 0.5, 'sawtooth', v); noise(0.3, 500, v * 0.8); },
    countdown(){ if (sample('beep', 0.4, 0.85)) return;
                tone(440, 440, 0.09, 'square', 0.22); },
    go()      { if (sample('go', 0.55)) return;
                tone(660, 660, 0.14, 'square', 0.26); tone(880, 880, 0.2, 'square', 0.24, 0.07); },
    win()     { if (sample('win', 0.5)) return;
                [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.22, 'triangle', 0.3, i * 0.13)); },
    slideStart(){ noise(0.12, 700, 0.2, 'bandpass'); },

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
