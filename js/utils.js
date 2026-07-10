/* =============================================================================
 * SKY PUSH — small shared helpers
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.U = {
  clamp(v, a, b) { return v < a ? a : (v > b ? b : v); },
  clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); },
  lerp(a, b, t) { return a + (b - a) * t; },
  // frame-rate independent exponential smoothing
  damp(a, b, lambda, dt) { return b + (a - b) * Math.exp(-lambda * dt); },
  rand(a, b) { return a + Math.random() * (b - a); },
  randInt(a, b) { return Math.floor(SKY.U.rand(a, b + 1)); },
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  // shortest signed angle from a to b
  angDelta(a, b) {
    let d = (b - a + Math.PI) % (Math.PI * 2);
    if (d < 0) d += Math.PI * 2;
    return d - Math.PI;
  },

  // aim direction from yaw/pitch (three.js convention: yaw 0 looks down -Z)
  dirFromYawPitch(yaw, pitch, out) {
    const cp = Math.cos(pitch);
    out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    return out;
  },

  /* --- procedural checkerboard texture (grids make speed readable!) ---
     Cached by palette+repeat: maps reuse the same few palettes dozens of
     times — sharing one texture per palette saves GPU memory and binds. */
  checkerTexture(colorA, colorB, repeat) {
    const key = colorA + '|' + colorB + '|' + (repeat || 1);
    SKY.U._checkers = SKY.U._checkers || {};
    if (SKY.U._checkers[key]) return SKY.U._checkers[key];
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = colorA; g.fillRect(0, 0, 128, 128);
    g.fillStyle = colorB; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
    // subtle inner border so every tile edge reads at distance
    g.strokeStyle = 'rgba(0,0,0,0.13)'; g.lineWidth = 3;
    g.strokeRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat || 1, repeat || 1);
    tex.anisotropy = 4;
    SKY.U._checkers[key] = tex;
    return tex;
  },

  /* --- soft radial blob texture, shared by all particles --- */
  blobTexture() {
    if (SKY.U._blob) return SKY.U._blob;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    SKY.U._blob = new THREE.CanvasTexture(c);
    return SKY.U._blob;
  },

  ringTexture() {
    if (SKY.U._ring) return SKY.U._ring;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 10;
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
    SKY.U._ring = new THREE.CanvasTexture(c);
    return SKY.U._ring;
  },

  /* --- text rendered onto a sprite (name tags, floating hit text) --- */
  makeTextSprite(text, opts) {
    opts = opts || {};
    const size = opts.px || 42;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = `900 ${size}px 'Segoe UI', sans-serif`;
    const w = Math.ceil(g.measureText(text).width) + 24;
    c.width = w; c.height = size + 22;
    g.font = `900 ${size}px 'Segoe UI', sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = 'rgba(8,14,30,0.85)';
    g.strokeText(text, w / 2, c.height / 2);
    g.fillStyle = opts.color || '#ffffff';
    g.fillText(text, w / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const spr = new THREE.Sprite(mat);
    const scale = opts.scale || 0.011;
    spr.scale.set(w * scale, c.height * scale, 1);
    return spr;
  },
};
