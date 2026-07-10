/* =============================================================================
 * SKY PUSH — synthesized audio (WebAudio, zero asset files)
 * Every sound is a placeholder blip/whoosh generated in code. Swap these for
 * real samples later; the call sites won't need to change.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.SFX = (function () {
  let ctx = null, master = null;
  let windGain = null, windFilter = null;
  let slideGain = null;
  let noiseBuf = null;

  function makeNoiseBuffer() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
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
  }

  /* one-shot tone helper: frequency slides f0 -> f1 over dur */
  function tone(f0, f1, dur, type, vol, delay) {
    if (!ctx) return;
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
    /* gunshot crack: sharp highpass snap + low thump. k = weapon kick weight */
    fire(p, k) {
      k = k || 1;
      const v = SKY.U.clamp(k, 0.45, 1.6);
      noise(0.05, 3200, 0.4 * v, 'highpass');                    // crack
      noise(0.12 + k * 0.05, 500, 0.3 * v);                      // body
      tone(150 - Math.min(k, 1.5) * 40, 45, 0.12 + k * 0.06, 'sine', 0.45 * v);  // thump
    },
    headshot(){ tone(1180, 880, 0.12, 'square', 0.3); tone(1760, 1320, 0.1, 'sine', 0.2, 0.02); },
    reload()  { noise(0.05, 1800, 0.22, 'highpass'); noise(0.05, 1200, 0.2, 'highpass', 0.16); },
    reloadDone(){ noise(0.05, 2200, 0.25, 'highpass'); tone(520, 380, 0.05, 'square', 0.12); },
    dry()     { tone(300, 240, 0.04, 'square', 0.16); },
    dash()    { noise(0.22, 900, 0.35, 'bandpass'); tone(300, 700, 0.18, 'sine', 0.2); },
    pick()    { tone(620, 930, 0.12, 'triangle', 0.3); tone(930, 1240, 0.14, 'triangle', 0.25, 0.09); },
    taunt()   { tone(392, 392, 0.12, 'square', 0.2); tone(523, 523, 0.14, 'square', 0.2, 0.13); },
    honk()    { tone(220, 220, 0.35, 'sawtooth', 0.4); tone(277, 277, 0.35, 'sawtooth', 0.35); tone(220, 220, 0.4, 'sawtooth', 0.4, 0.5); tone(277, 277, 0.4, 'sawtooth', 0.35, 0.5); },
    rumble()  { noise(0.6, 140, 0.55); tone(70, 35, 0.5, 'sine', 0.5); },
    thunder() { noise(0.08, 4000, 0.5, 'highpass'); noise(0.9, 220, 0.6, 'lowpass', 0.06); tone(60, 30, 0.8, 'sine', 0.45, 0.05); },
    gust()    { noise(1.2, 700, 0.3, 'bandpass'); },
    boom()    { noise(0.5, 300, 0.7); tone(90, 30, 0.5, 'sine', 0.6); noise(0.08, 3000, 0.35, 'highpass'); },
    beep()    { tone(880, 880, 0.07, 'square', 0.2); },
    cash()    { tone(1320, 1760, 0.07, 'square', 0.2); tone(1760, 1760, 0.08, 'square', 0.18, 0.08); },
    crown()   { [660, 880, 1100].forEach((f, i) => tone(f, f, 0.14, 'triangle', 0.26, i * 0.08)); },
    overtime(){ tone(220, 110, 0.5, 'sawtooth', 0.4); tone(330, 165, 0.5, 'sawtooth', 0.3, 0.1); },
    airCannon(){ noise(0.32, 420, 0.6); tone(160, 40, 0.3, 'sine', 0.5); },
    hit(p)    { tone(130 + p * 90, 40, 0.18, 'sine', 0.5 + p * 0.3); tone(700 + p * 500, 160, 0.1, 'square', 0.18 + p * 0.15); noise(0.1, 800, 0.2); },
    jump()    { tone(300, 430, 0.08, 'sine', 0.14); },
    land(i)   { noise(0.09, 320, SKY.U.clamp(i, 0, 1) * 0.3); },
    pad()     { tone(220, 640, 0.24, 'sine', 0.4); tone(110, 320, 0.24, 'triangle', 0.28); },
    grapple() { noise(0.14, 2200, 0.25, 'highpass'); tone(500, 900, 0.12, 'triangle', 0.2); },
    grapMiss(){ tone(300, 180, 0.07, 'square', 0.12); },
    scream(loud) { // comedic falling whistle
      const v = loud ? 0.4 : 0.18;
      tone(900, 200, 0.9, 'sawtooth', v);
      tone(1350, 300, 0.9, 'sine', v * 0.5);
    },
    ko(loud)  { const v = loud ? 0.6 : 0.35; tone(600, 90, 0.5, 'sawtooth', v); noise(0.3, 500, v * 0.8); },
    countdown(){ tone(440, 440, 0.09, 'square', 0.22); },
    go()      { tone(660, 660, 0.14, 'square', 0.26); tone(880, 880, 0.2, 'square', 0.24, 0.07); },
    win()     { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.22, 'triangle', 0.3, i * 0.13)); },
    slideStart(){ noise(0.12, 700, 0.2, 'bandpass'); },

    /* continuous feedback, called every frame */
    setWind(x01) {
      if (!windGain) return;
      windGain.gain.value = x01 * SKY.TUNING.audio.windMax;
      windFilter.frequency.value = 380 + x01 * 950;
    },
    setSlide(on) {
      if (!slideGain) return;
      slideGain.gain.value = on ? 0.12 : 0;
    },
  };
})();
