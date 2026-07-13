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

  /* player icon chip (replaces the old colored ● markers everywhere).
     av: 'e:🙂' emoji preset | image URL | null → colored initial disc */
  avatarHtml(av, color, name, cls) {
    const c = 'pav' + (cls ? ' ' + cls : '');
    if (av && av.indexOf('e:') === 0) return `<span class="${c}">${av.slice(2)}</span>`;
    // 'c:<CharId>' = rendered character portrait (AccountUI fills the cache;
    // until it exists, fall through to the initial disc)
    if (av && av.indexOf('c:') === 0 && window.SKY && SKY._charIcons && SKY._charIcons[av.slice(2)]) {
      return `<span class="${c}"><img src="${SKY._charIcons[av.slice(2)]}" alt=""></span>`;
    }
    if (av && /^https?:/.test(av)) return `<span class="${c}"><img src="${av}" alt=""></span>`;
    const ch = String(name || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?';
    return `<span class="${c} pav-d" style="background:${color || '#8a94a8'}">${ch}</span>`;
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
      concrete(g, s) {
        g.fillStyle = '#ccd2dc'; g.fillRect(0, 0, s, s);
        speck(g, s, 90, ['rgba(0,0,0,0.05)', 'rgba(255,255,255,0.07)'], 1, 3);
        g.strokeStyle = 'rgba(90,100,120,0.35)'; g.lineWidth = 2;
        for (let i = 0; i <= 2; i++) {
          g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, s); g.stroke();
          g.beginPath(); g.moveTo(0, i * 64); g.lineTo(s, i * 64); g.stroke();
        }
      },
      panel(g, s) {
        g.fillStyle = '#eef1f5'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(130,142,160,0.4)'; g.lineWidth = 2;
        for (let i = 0; i <= 2; i++) {
          g.beginPath(); g.moveTo(0, i * 64); g.lineTo(s, i * 64); g.stroke();
        }
        g.strokeStyle = 'rgba(64,200,255,0.55)'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(0, 96); g.lineTo(s, 96); g.stroke();
      },
      grid(g, s) {
        g.fillStyle = '#1b2336'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(64,200,255,0.5)'; g.lineWidth = 2;
        for (let i = 0; i <= 4; i++) {
          g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, s); g.stroke();
          g.beginPath(); g.moveTo(0, i * 32); g.lineTo(s, i * 32); g.stroke();
        }
      },
      crane(g, s) {
        g.fillStyle = '#e8b23a'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(90,60,10,0.5)'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(s, s); g.moveTo(s, 0); g.lineTo(0, s); g.stroke();
        g.strokeStyle = 'rgba(90,60,10,0.35)'; g.lineWidth = 2;
        g.strokeRect(2, 2, s - 4, s - 4);
        for (let x = 12; x < s; x += 34) for (let y = 12; y < s; y += 34) {
          g.fillStyle = '#a87c20';
          g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
        }
      },
      plywood(g, s) {
        g.fillStyle = '#d8b47c'; g.fillRect(0, 0, s, s);
        for (let i = 0; i < 160; i++) {
          g.fillStyle = `rgba(${150 + (Math.random() * 60 | 0)},${110 + (Math.random() * 50 | 0)},60,0.35)`;
          g.save();
          g.translate(Math.random() * s, Math.random() * s);
          g.rotate(Math.random() * Math.PI);
          g.fillRect(-6, -2, 12, 4);
          g.restore();
        }
      },
      leather(g, s) {
        g.fillStyle = '#7a4b2a'; g.fillRect(0, 0, s, s);
        speck(g, s, 200, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.05)'], 0.5, 1.5);
        g.strokeStyle = 'rgba(240,220,180,0.4)'; g.lineWidth = 1.5;
        g.setLineDash([3, 3]);
        for (let i = -s; i < s; i += 32) {
          g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.stroke();
          g.beginPath(); g.moveTo(i + s, 0); g.lineTo(i, s); g.stroke();
        }
        g.setLineDash([]);
      },
      balloon(g, s) {
        g.fillStyle = '#e8483a'; g.fillRect(0, 0, s, s);
        for (let x = 16; x < s; x += 42) for (let y = 16; y < s; y += 42) {
          const grad = g.createRadialGradient(x - 4, y - 4, 2, x, y, 18);
          grad.addColorStop(0, 'rgba(255,255,255,0.5)');
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grad;
          g.beginPath(); g.arc(x, y, 18, 0, Math.PI * 2); g.fill();
        }
      },
      marble(g, s) {
        g.fillStyle = '#eceef0'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(140,148,160,0.35)';
        for (let i = 0; i < 7; i++) {
          g.lineWidth = 1 + Math.random() * 1.5;
          let x = Math.random() * s, y = Math.random() * s;
          g.beginPath(); g.moveTo(x, y);
          for (let k = 0; k < 5; k++) {
            x += Math.random() * 40 - 20; y += Math.random() * 40 - 20;
            g.lineTo(x, y);
          }
          g.stroke();
        }
      },
      carpet(g, s) {
        g.fillStyle = '#2a6a68'; g.fillRect(0, 0, s, s);
        speck(g, s, 500, ['rgba(255,255,255,0.06)', 'rgba(0,0,0,0.08)'], 0.5, 1);
        g.fillStyle = 'rgba(220,200,140,0.25)';
        for (let x = 16; x < s; x += 32) for (let y = 16; y < s; y += 32) {
          g.fillRect(x - 2, y - 2, 4, 4);
        }
      },
      circuit(g, s) {
        g.fillStyle = '#12401f'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(220,180,60,0.55)'; g.lineWidth = 2;
        for (let i = 0; i < 9; i++) {
          let x = (Math.random() * 4 | 0) * 32 + 16, y = (Math.random() * 4 | 0) * 32 + 16;
          g.beginPath(); g.moveTo(x, y);
          const horiz = Math.random() < 0.5;
          if (horiz) { g.lineTo(x + 64, y); g.lineTo(x + 64, y + 32); } else { g.lineTo(x, y + 64); g.lineTo(x + 32, y + 64); }
          g.stroke();
          g.fillStyle = '#d8bc50';
          g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
        }
        g.fillStyle = '#0a2a12';
        g.fillRect(70, 70, 26, 20);
      },
      camo(g, s) {
        g.fillStyle = '#7a7c52'; g.fillRect(0, 0, s, s);
        const cols = ['#4c503a', '#a89a6a', '#3a3c2c'];
        for (let i = 0; i < 22; i++) {
          g.fillStyle = cols[i % 3];
          const x = Math.random() * s, y = Math.random() * s, r = 10 + Math.random() * 18;
          g.beginPath();
          g.ellipse(x, y, r, r * 0.65, Math.random() * Math.PI, 0, Math.PI * 2);
          g.fill();
        }
      },
      /* --- mountain set (real tileables in assets/tex; these are the
             file:// fallbacks + editor swatch sources) --- */
      gravel(g, s) {
        g.fillStyle = '#8c8578'; g.fillRect(0, 0, s, s);
        speck(g, s, 320, ['rgba(60,56,50,0.5)', 'rgba(180,172,158,0.5)', 'rgba(110,102,92,0.6)'], 1.5, 4);
      },
      cliff(g, s) {
        g.fillStyle = '#7d8288'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(40,44,50,0.4)'; g.lineWidth = 2;
        for (let i = 0; i < 14; i++) {
          const x = Math.random() * s;
          g.beginPath(); g.moveTo(x, 0);
          g.lineTo(x + (Math.random() * 2 - 1) * 20, s);
          g.stroke();
        }
        speck(g, s, 60, ['rgba(255,255,255,0.06)', 'rgba(0,0,0,0.1)'], 3, 9);
      },
      scree(g, s) {
        g.fillStyle = '#9a9284'; g.fillRect(0, 0, s, s);
        for (let i = 0; i < 90; i++) {
          g.fillStyle = ['#847c6e', '#aca496', '#6e675c'][i % 3];
          const x = Math.random() * s, y = Math.random() * s, r = 4 + Math.random() * 9;
          g.beginPath();
          g.moveTo(x, y - r); g.lineTo(x + r, y + r * 0.6); g.lineTo(x - r, y + r * 0.7);
          g.closePath(); g.fill();
        }
      },
      mossrock(g, s) {
        g.fillStyle = '#767c80'; g.fillRect(0, 0, s, s);
        speck(g, s, 40, ['rgba(0,0,0,0.1)', 'rgba(255,255,255,0.06)'], 4, 12);
        speck(g, s, 60, ['rgba(84,140,72,0.55)', 'rgba(110,168,90,0.45)'], 3, 10);
      },
    };
  })(),

  procTexture(id, repeat) {
    // real stylized tileable (assets/tex) when the asset pack has loaded;
    // hand-drawn canvas below remains the file:// fallback
    if (SKY.GFX) {
      const real = SKY.GFX.texture(id, repeat || 1);
      if (real) return real;
    }
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
    if (SKY.GFX && SKY.GFX.texImage(id)) return 'assets/tex/' + id + '.jpg';
    SKY.U._procThumbs = SKY.U._procThumbs || {};
    if (!SKY.U._procThumbs[id]) {
      SKY.U.procTexture(id, 1);   // ensures the canvas exists
      SKY.U._procThumbs[id] = SKY.U._procCanvas[id].toDataURL();
    }
    return SKY.U._procThumbs[id];
  },

  /* --- block geometry factory (editor + custom maps share it) ---
     Non-box shapes still collide as their bounding box — tops are what
     matters for platforming. sx doubles as the diameter.
     UVs are WORLD-LOCKED (1 texture tile per ~3 units on every face), so
     resizing a block never stretches its texture. */
  blockGeometry(shape, sx, sy, sz) {
    const D = 3;   // world units per texture tile
    let g;
    switch (shape) {
      case 'cyl':    g = new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 24); break;
      case 'hex':    g = new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 6); break;
      case 'cone':   g = new THREE.CylinderGeometry(sx * 0.08, sx / 2, sy, 20); break;
      case 'sphere': g = new THREE.SphereGeometry(sx / 2, 18, 14); break;
      case 'pyramid': g = new THREE.CylinderGeometry(0.01, sx / 2, sy, 4); break;
      default: {
        g = new THREE.BoxGeometry(sx, sy, sz);
        // per-face UV density (face order: +x -x +y -y +z -z, 4 verts each)
        const uv = g.attributes.uv;
        const dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
        for (let f = 0; f < 6; f++) {
          const du = dims[f][0] / D, dv = dims[f][1] / D;
          for (let i = 0; i < 4; i++) {
            const idx = f * 4 + i;
            uv.setXY(idx, uv.getX(idx) * du, uv.getY(idx) * dv);
          }
        }
        uv.needsUpdate = true;
        return g;
      }
    }
    // round shapes: uniform approximate density
    const uv = g.attributes.uv;
    const du = Math.max(1, (Math.PI * sx) / D * 0.5), dv = Math.max(0.5, sy / D);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * du, uv.getY(i) * dv);
    uv.needsUpdate = true;
    return g;
  },

  /* --- soft wide light-shaft band (dreamy godrays, not thin lines) --- */
  softShaftTexture() {
    if (SKY.U._softShaft) return SKY.U._softShaft;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 128, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 256);
    // vertical fade: bright at the top, dissolves toward the ground
    const gv = g.createLinearGradient(0, 0, 0, 256);
    gv.addColorStop(0, 'rgba(0,0,0,0)');
    gv.addColorStop(0.75, 'rgba(0,0,0,0.35)');
    gv.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = gv; g.fillRect(0, 0, 128, 256);
    g.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(c);
    SKY.U._softShaft = tex;
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

  /* --- puffy cumulus cloud (3 cached variants, pick by any int) --- */
  cloudTexture(v) {
    SKY.U._cloudTex = SKY.U._cloudTex || {};
    const k = ((v || 0) % 3 + 3) % 3;
    if (SKY.U._cloudTex[k]) return SKY.U._cloudTex[k];
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    const base = 88;                        // the flat-ish cloud underside
    const puffs = 9 + k * 2;
    for (let i = 0; i < puffs; i++) {
      const t = puffs > 1 ? i / (puffs - 1) : 0.5;
      const x = 34 + t * 188 + (Math.random() - 0.5) * 14;
      // dome silhouette: tall tufts in the middle, low ones at the edges
      const r = (16 + Math.random() * 15) * (0.5 + 0.5 * Math.sin(Math.PI * t));
      const y = base - r * (0.5 + Math.random() * 0.4);
      const gr = g.createRadialGradient(x, y - r * 0.15, r * 0.1, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.95)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.6)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // wide squashed tufts hugging the base line = soft flat bottom
    for (let i = 0; i < 5; i++) {
      const x = 56 + (i / 4) * 144 + (Math.random() - 0.5) * 10;
      g.save();
      g.translate(x, base - 4); g.scale(1.7, 0.5); g.translate(-x, -(base - 4));
      const gr = g.createRadialGradient(x, base - 4, 3, x, base - 4, 30);
      gr.addColorStop(0, 'rgba(244,246,250,0.6)');
      gr.addColorStop(1, 'rgba(244,246,250,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, base - 4, 30, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    const tex = new THREE.CanvasTexture(c);
    SKY.U._cloudTex[k] = tex;
    return tex;
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
