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

  /* --- procedural block textures (the editor's texture picker) ---
     Each draws onto a 128px canvas. Map defs store only the texture NAME
     (b.ptex), so textured maps stay tiny — nothing to embed or upload. */
  PROC_TEX: (() => {
    const speck = (g, s, n, colors, r0, r1) => {
      for (let i = 0; i < n; i++) {
        g.fillStyle = colors[(Math.random() * colors.length) | 0];
        const r = r0 + Math.random() * (r1 - r0);
        g.beginPath(); g.arc(Math.random() * s, Math.random() * s, r, 0, Math.PI * 2); g.fill();
      }
    };
    return {
      grass(g, s) {
        g.fillStyle = '#579540'; g.fillRect(0, 0, s, s);
        speck(g, s, 240, ['rgba(101,175,74,0.45)', 'rgba(66,118,46,0.45)', 'rgba(130,198,96,0.3)'], 1, 3);
        g.strokeStyle = 'rgba(46,92,32,0.5)'; g.lineWidth = 1;
        for (let i = 0; i < 130; i++) {
          const x = Math.random() * s, y = Math.random() * s;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() * 2 - 1) * 2, y - 3 - Math.random() * 4); g.stroke();
        }
      },
      dirt(g, s) {
        g.fillStyle = '#7a5a3e'; g.fillRect(0, 0, s, s);
        speck(g, s, 36, ['rgba(0,0,0,0.09)', 'rgba(255,255,255,0.05)'], 4, 12);
        speck(g, s, 190, ['rgba(48,32,18,0.35)', 'rgba(178,142,98,0.3)'], 0.5, 2);
        speck(g, s, 12, ['#96805e', '#6a4c32'], 1.5, 3);
      },
      sand(g, s) {
        g.fillStyle = '#e3cc96'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(150,120,70,0.22)'; g.lineWidth = 3;
        for (let y = 8; y < s; y += 16) {
          g.beginPath(); g.moveTo(0, y);
          g.quadraticCurveTo(s * 0.25, y - 5, s * 0.5, y);
          g.quadraticCurveTo(s * 0.75, y + 5, s, y);
          g.stroke();
        }
        speck(g, s, 150, ['rgba(0,0,0,0.07)', 'rgba(255,255,255,0.28)'], 0.5, 1.4);
      },
      stone(g, s) {
        g.fillStyle = '#9096a0'; g.fillRect(0, 0, s, s);
        speck(g, s, 26, ['rgba(255,255,255,0.06)', 'rgba(20,22,30,0.08)'], 5, 14);
        g.strokeStyle = 'rgba(40,44,54,0.4)'; g.lineWidth = 2;
        for (let i = 0; i <= 4; i++) {
          const j = () => (Math.random() * 6 - 3);
          g.beginPath(); g.moveTo(i * 32 + j(), 0); g.lineTo(i * 32 + j(), s); g.stroke();
          g.beginPath(); g.moveTo(0, i * 32 + j()); g.lineTo(s, i * 32 + j()); g.stroke();
        }
        speck(g, s, 110, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.1)'], 0.5, 1.6);
      },
      rock(g, s) {
        g.fillStyle = '#5c5f68'; g.fillRect(0, 0, s, s);
        speck(g, s, 30, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.07)'], 5, 16);
        g.strokeStyle = 'rgba(18,20,26,0.45)'; g.lineWidth = 1.6;
        for (let i = 0; i < 9; i++) {
          let x = Math.random() * s, y = Math.random() * s;
          g.beginPath(); g.moveTo(x, y);
          for (let k = 0; k < 4; k++) { x += Math.random() * 26 - 13; y += Math.random() * 26 - 13; g.lineTo(x, y); }
          g.stroke();
        }
        speck(g, s, 90, ['rgba(0,0,0,0.16)', 'rgba(220,226,240,0.08)'], 0.5, 1.6);
      },
      brick(g, s) {
        g.fillStyle = '#cfc6b8'; g.fillRect(0, 0, s, s);
        const tints = ['#a0523a', '#a85940', '#984d36', '#ab5f45'];
        for (let row = 0; row < 8; row++) {
          const off = (row % 2) * 16;
          for (let col = -1; col < 4; col++) {
            g.fillStyle = tints[(Math.random() * tints.length) | 0];
            g.fillRect(col * 32 + off + 1, row * 16 + 1, 30, 14);
          }
        }
        speck(g, s, 90, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.06)'], 0.5, 1.6);
      },
      planks(g, s) {
        for (let p = 0; p < 4; p++) {
          g.fillStyle = ['#9a7143', '#91683c', '#a2794b', '#8d6538'][p];
          g.fillRect(p * 32, 0, 32, s);
          g.strokeStyle = 'rgba(64,40,18,0.3)'; g.lineWidth = 1;
          for (let i = 0; i < 5; i++) {
            const x = p * 32 + 4 + Math.random() * 24;
            g.beginPath(); g.moveTo(x, 0);
            g.quadraticCurveTo(x + (Math.random() * 6 - 3), s / 2, x, s);
            g.stroke();
          }
        }
        g.strokeStyle = 'rgba(40,25,12,0.6)'; g.lineWidth = 2;
        for (let p = 0; p <= 4; p++) { g.beginPath(); g.moveTo(p * 32, 0); g.lineTo(p * 32, s); g.stroke(); }
        speck(g, s, 5, ['rgba(58,36,16,0.5)'], 2, 3.5);
      },
      metal(g, s) {
        g.fillStyle = '#9aa4b2'; g.fillRect(0, 0, s, s);
        for (let i = 0; i < 70; i++) {
          g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(30,36,48,0.05)';
          g.fillRect(0, Math.random() * s, s, 1);
        }
        g.strokeStyle = 'rgba(52,60,74,0.5)'; g.lineWidth = 2;
        for (let i = 0; i <= 2; i++) {
          g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, s); g.stroke();
          g.beginPath(); g.moveTo(0, i * 64); g.lineTo(s, i * 64); g.stroke();
        }
        for (let x = 8; x < s; x += 48) {
          for (let y = 8; y < s; y += 48) {
            g.fillStyle = '#78828f';
            g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
            g.fillStyle = 'rgba(255,255,255,0.5)';
            g.beginPath(); g.arc(x - 0.8, y - 0.8, 1, 0, Math.PI * 2); g.fill();
          }
        }
      },
      tiles(g, s) {
        g.fillStyle = '#dfe4ec'; g.fillRect(0, 0, s, s);
        for (let x = 0; x < 4; x++) {
          for (let y = 0; y < 4; y++) {
            g.fillStyle = `rgba(120,132,156,${Math.random() * 0.1 + (Math.random() < 0.12 ? 0.18 : 0)})`;
            g.fillRect(x * 32, y * 32, 32, 32);
          }
        }
        g.strokeStyle = 'rgba(90,100,124,0.45)'; g.lineWidth = 2;
        for (let i = 0; i <= 4; i++) {
          g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, s); g.stroke();
          g.beginPath(); g.moveTo(0, i * 32); g.lineTo(s, i * 32); g.stroke();
        }
      },
      snow(g, s) {
        g.fillStyle = '#eef3fa'; g.fillRect(0, 0, s, s);
        speck(g, s, 90, ['rgba(150,172,205,0.2)', 'rgba(190,205,228,0.25)'], 1, 3);
        speck(g, s, 60, ['rgba(255,255,255,0.9)'], 0.4, 0.9);
      },
      hazard(g, s) {
        g.fillStyle = '#e8c531'; g.fillRect(0, 0, s, s);
        g.fillStyle = '#22262e';
        for (let i = -s; i < s * 2; i += 32) {
          g.beginPath();
          g.moveTo(i, s); g.lineTo(i + s, 0); g.lineTo(i + s + 16, 0); g.lineTo(i + 16, s);
          g.fill();
        }
        speck(g, s, 60, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.06)'], 0.5, 1.5);
      },
      lava(g, s) {
        g.fillStyle = '#2a1014'; g.fillRect(0, 0, s, s);
        g.shadowColor = '#ff5a20'; g.shadowBlur = 7;
        for (let i = 0; i < 10; i++) {
          g.strokeStyle = `rgba(255,${110 + (Math.random() * 60 | 0)},40,0.85)`;
          g.lineWidth = 1.5 + Math.random() * 2.5;
          const x = Math.random() * s, y = Math.random() * s;
          g.beginPath(); g.moveTo(x, y);
          g.quadraticCurveTo(x + Math.random() * 50 - 25, y + Math.random() * 50 - 25,
            x + Math.random() * 70 - 35, y + Math.random() * 70 - 35);
          g.stroke();
        }
        g.shadowBlur = 0;
        speck(g, s, 10, ['rgba(255,154,64,0.35)'], 3, 9);
      },
    };
  })(),

  procTexture(id, repeat) {
    SKY.U._proc = SKY.U._proc || {};
    const key = id + '|' + (repeat || 1);
    if (SKY.U._proc[key]) return SKY.U._proc[key];
    SKY.U._procCanvas = SKY.U._procCanvas || {};
    let c = SKY.U._procCanvas[id];
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = 128;
      SKY.U.PROC_TEX[id](c.getContext('2d'), 128);
      SKY.U._procCanvas[id] = c;
    }
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat || 1, repeat || 1);
    tex.anisotropy = 4;
    SKY.U._proc[key] = tex;
    return tex;
  },
  procThumb(id) {
    SKY.U._procThumbs = SKY.U._procThumbs || {};
    if (!SKY.U._procThumbs[id]) {
      SKY.U.procTexture(id, 1);   // ensures the canvas exists
      SKY.U._procThumbs[id] = SKY.U._procCanvas[id].toDataURL();
    }
    return SKY.U._procThumbs[id];
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

  /* --- the moon: soft-edged disc with faint maria blotches --- */
  moonTexture() {
    if (SKY.U._moon) return SKY.U._moon;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 30, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.85, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(120,135,160,0.32)';
    for (const [x, y, r] of [[46, 50, 13], [78, 44, 9], [66, 78, 15], [44, 82, 7], [86, 70, 6]]) {
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // terminator shading for depth
    const sh = g.createRadialGradient(84, 50, 10, 64, 64, 64);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(30,40,60,0.35)');
    g.fillStyle = sh;
    g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
    SKY.U._moon = new THREE.CanvasTexture(c);
    return SKY.U._moon;
  },

  /* --- soft vertical light-shaft streaks (cinematic sun rays) --- */
  shaftTexture() {
    if (SKY.U._shaft) return SKY.U._shaft;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const g = c.getContext('2d');
    for (let i = 0; i < 5; i++) {
      const x = 12 + Math.random() * 104, w = 6 + Math.random() * 22;
      const grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.35, 'rgba(255,255,255,' + (0.25 + Math.random() * 0.4) + ')');
      grad.addColorStop(0.75, 'rgba(255,255,255,' + (0.15 + Math.random() * 0.25) + ')');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(x - w / 2, 0, w, 256);
    }
    SKY.U._shaft = new THREE.CanvasTexture(c);
    return SKY.U._shaft;
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
