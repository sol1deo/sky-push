/* =============================================================================
 * SKY PUSH — player profile: coins, character + weapon-finish ownership.
 * Pure meta/cosmetic progression, persisted to localStorage. Coins are earned
 * at match end (participation + KOs + win bonus) and spent in the LOCKER.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Profile = (function () {
  const KEY = 'skypush-profile';

  /* character catalog: price 0 = starter (always owned) */
  const CHARS = [
    { id: 'Casual_Male',        name: 'SCOUT',    price: 0 },
    { id: 'Casual_Female',      name: 'RUNNER',   price: 0 },
    { id: 'BlueSoldier_Male',   name: 'TROOPER',  price: 0 },
    { id: 'BlueSoldier_Female', name: 'RANGER',   price: 350 },
    { id: 'Worker_Male',        name: 'FOREMAN',  price: 350 },
    { id: 'Chef_Male',          name: 'CHEF',     price: 500 },
    { id: 'Cowboy_Female',      name: 'OUTLAW',   price: 500 },
    { id: 'Pirate_Female',      name: 'CORSAIR',  price: 650 },
    { id: 'Suit_Male',          name: 'AGENT',    price: 650 },
    { id: 'Ninja_Male',         name: 'SHADOW',   price: 800 },
  ];

  /* weapon skins v2 — real painted textures (assets/tex/skins/*.jpg) wrapped
     around the gun with triplanar projection, plus per-skin animated glow and
     MYTHIC tiers that carry living particle FX riding the weapon.
       skin    — texture name; glowLo/glowAmt shape the emissive mask (bright
                 texels glow: lava cracks, circuit traces, stars)
       anim    — how the glow lives: lava (breathing), scan (scanline sweep),
                 drift (texture slowly scrolls), void (dark pulse), shimmer
       orbitFx — mythic particle rig: embers | stars | shards */
  const FINISHES = [
    { id: 'stock',      name: 'STOCK',      price: 0 },
    { id: 'fade',       name: 'FADE',       price: 400,  fx: 'fade' },      // cyan→pink→gold
    { id: 'spectrum',   name: 'SPECTRUM',   price: 600,  fx: 'spectrum' },  // animated hue cycle
    { id: 'gilded',     name: 'GILDED AGE', price: 800,  skin: 'gilded',
      glowLo: 0.72, glowAmt: 0.3 },
    { id: 'cybergrid',  name: 'CYBERGRID',  price: 900,  skin: 'cybergrid',
      glowLo: 0.42, glowAmt: 0.85, anim: 'scan', scanColor: '#59f7ff' },
    { id: 'frostbite',  name: 'FROSTBITE',  price: 1000, skin: 'frostbite',
      glowLo: 0.88, glowAmt: 0.45, anim: 'shimmer' },
    { id: 'dragonfire', name: 'DRAGONFIRE', price: 1800, skin: 'dragonfire', mythic: true,
      glowLo: 0.34, glowAmt: 1.15, anim: 'lava', orbitFx: 'embers' },
    { id: 'nebula',     name: 'NEBULA',     price: 2000, skin: 'nebula', mythic: true,
      glowLo: 0.45, glowAmt: 0.95, anim: 'drift', orbitFx: 'stars' },
    { id: 'voidwalker', name: 'VOIDWALKER', price: 2500, skin: 'voidwalker', mythic: true,
      glowLo: 0.4, glowAmt: 1.05, anim: 'void', orbitFx: 'shards' },
  ];

  /* free cosmetic palettes (no purchase — just identity options) */
  const OUTFIT_COLORS = ['#ffd34d', '#40c8ff', '#ff5db1', '#7dff9e', '#a48aff',
    '#ffb85a', '#e63946', '#2ee6c8', '#f2f4f6', '#3a4150', '#0a0a0d'];

  const DEFAULTS = {
    coins: 300,
    char: null,             // null = surprise me (name-hash pick)
    skin: null,             // index into Characters.SKINS | null = auto
    outfit: null,           // outfit hex | null = your player color
    ownedChars: [],         // ids bought (price-0 chars are implicitly owned)
    ownedFinishes: [],      // finish ids bought ('stock' implicit)
    finishes: {},           // weapon kind -> finish id (missing = stock)
    wpn: 'pistol',          // the weapon your character holds in lobbies
  };

  let data = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      return { ...JSON.parse(JSON.stringify(DEFAULTS)), ...JSON.parse(raw) };
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    // logged-in players carry their cosmetics on the account (debounced push)
    if (SKY.Account && SKY.Account.pushCosmetics) SKY.Account.pushCosmetics();
  }
  /* purchases REQUIRE an account once the account system is configured */
  function purchasesLocked() {
    return !!(SKY.Account && SKY.Account.enabled && !SKY.Account.isLoggedIn());
  }

  function charDef(id) { return CHARS.find(c => c.id === id) || null; }
  function finishDef(id) { return FINISHES.find(f => f.id === id) || FINISHES[0]; }

  /* per-vertex paint along the gun: FADE = smooth tri-color gradient,
     GALAXY = deep-space wash with star sparkles. Geometry is cloned so the
     shared template stays untouched. */
  function paintVertexFx(group, fx) {
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const span = Math.max(0.001, box.max.z - box.min.z);
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    const A = new THREE.Color('#40c8ff'), B = new THREE.Color('#ff5db1'), C = new THREE.Color('#ffd34d');
    const G0 = new THREE.Color('#241a4a'), G1 = new THREE.Color('#5a2a8a');
    group.traverse((o) => {
      if (!o.isMesh || o.name === 'tierglow') return;
      const g = o.geometry = o.geometry.clone();
      const pos = g.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const t = Math.min(1, Math.max(0, (v.z - box.min.z) / span));
        if (fx === 'fade') {
          if (t < 0.5) c.copy(C).lerp(B, t * 2);       // gold at the muzzle...
          else c.copy(B).lerp(A, (t - 0.5) * 2);       // ...cyan at the stock
        } else {
          c.copy(G0).lerp(G1, t * 0.6 + Math.random() * 0.35);
          if (Math.random() < 0.05) c.set(Math.random() < 0.5 ? '#ffffff' : '#7dd8ff');
        }
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      o.material = o.material.clone();
      o.material.vertexColors = true;
      o.material.map = null;
      o.material.color.set('#ffffff');
      if (fx === 'galaxy') o.material.emissive = new THREE.Color('#2a1a55').multiplyScalar(0.5);
    });
  }

  /* ---------------- textured skins: triplanar projection ----------------
   * The Kenney gun UVs map a 2px palette (useless for pictorial art), so the
   * skin texture is projected in GUN space from three axes and blended by the
   * surface normal — wraps any mesh, kitbash parts included. Bright texels
   * also feed the emissive mask, so lava cracks / circuit traces / stars glow
   * out of the paint itself. */
  const skinTexes = {};
  function skinTex(name) {
    if (skinTexes[name]) return skinTexes[name];
    const t = new THREE.TextureLoader().load('assets/tex/skins/' + name + '.jpg', () => {
      // locker thumbs rendered before this landed cached BLACK — flush them
      if (SKY.Effects && SKY.Effects.invalidateThumbs) SKY.Effects.invalidateThumbs();
      const lk = document.getElementById('panel-locker');
      if (lk && !lk.classList.contains('hidden') && SKY.Locker) SKY.Locker.renderPanel();
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    skinTexes[name] = t;
    return t;
  }
  // start the fetches at boot so the locker/loadouts never see a bare gun
  if (window.addEventListener) {
    window.addEventListener('load', () => {
      setTimeout(() => { for (const f of FINISHES) if (f.skin) skinTex(f.skin); }, 2500);
    });
  }
  function kindHash(s) {
    let h = 5381;
    for (let i = 0; i < (s || '').length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }

  function skinMaterial(f, localMat, scale, off) {
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uSkinMap = { value: skinTex(f.skin) };
      sh.uniforms.uSkinLocal = { value: localMat };
      sh.uniforms.uSkinScale = { value: scale };
      sh.uniforms.uSkinOff = { value: off };
      sh.uniforms.uGlowLo = { value: f.glowLo !== undefined ? f.glowLo : 0.7 };
      sh.uniforms.uGlowAmt = { value: f.glowAmt || 0 };
      sh.uniforms.uDrift = { value: f.anim === 'drift' ? 0.014 : 0 };
      sh.uniforms.uScan = { value: f.anim === 'scan' ? 0.55 : 0 };
      sh.uniforms.uScanCol = { value: new THREE.Color(f.scanColor || '#59f7ff') };
      sh.uniforms.uTime = { value: 0 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>',
          '#include <common>\nuniform mat4 uSkinLocal;\nvarying vec3 vSkinP;\nvarying vec3 vSkinN;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n' +
          'vSkinP = (uSkinLocal * vec4(position, 1.0)).xyz;\n' +
          'vSkinN = normalize(mat3(uSkinLocal) * normal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>',
          '#include <common>\n' +
          'uniform sampler2D uSkinMap; uniform float uSkinScale; uniform vec2 uSkinOff;\n' +
          'uniform float uGlowLo; uniform float uGlowAmt; uniform float uDrift;\n' +
          'uniform float uScan; uniform vec3 uScanCol; uniform float uTime;\n' +
          'varying vec3 vSkinP; varying vec3 vSkinN;')
        .replace('#include <map_fragment>',
          'vec3 sw = abs(vSkinN); sw = pow(sw, vec3(3.0)); sw /= (sw.x + sw.y + sw.z + 1e-4);\n' +
          'vec2 sOff = uSkinOff + uTime * uDrift * vec2(1.0, 0.62);\n' +
          'vec4 skinCol = texture2D(uSkinMap, vSkinP.zy * uSkinScale + sOff) * sw.x\n' +
          '  + texture2D(uSkinMap, vSkinP.xz * uSkinScale + sOff) * sw.y\n' +
          '  + texture2D(uSkinMap, vSkinP.xy * uSkinScale + sOff) * sw.z;\n' +
          'diffuseColor.rgb *= skinCol.rgb;')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          'float sLum = dot(skinCol.rgb, vec3(0.299, 0.587, 0.114));\n' +
          'totalEmissiveRadiance += skinCol.rgb * smoothstep(uGlowLo, 1.0, sLum) * uGlowAmt;\n' +
          'if (uScan > 0.0) {\n' +
          '  float band = smoothstep(0.09, 0.0, abs(fract(vSkinP.z * uSkinScale * 0.6 - uTime * 0.45) - 0.5));\n' +
          '  totalEmissiveRadiance += uScanCol * band * uScan;\n' +
          '}');
      m.userData.shader = sh;
    };
    if (f.anim) {
      const base = f.glowAmt || 0.6;
      m.userData.animFx = 'skin';
      m.userData.skinTick = (t) => {
        const sh = m.userData.shader;
        if (!sh) return;
        sh.uniforms.uTime.value = t;
        if (f.anim === 'lava') sh.uniforms.uGlowAmt.value = base * (0.55 + 0.45 * Math.sin(t * 2.2));
        else if (f.anim === 'shimmer') sh.uniforms.uGlowAmt.value = base * (0.75 + 0.25 * Math.sin(t * 1.7));
        else if (f.anim === 'void') sh.uniforms.uGlowAmt.value = base * (0.6 + 0.4 * Math.sin(t * 1.4));
        else if (f.anim === 'drift') sh.uniforms.uGlowAmt.value = base * (0.8 + 0.2 * Math.sin(t * 1.1));
      };
      if (SKY.Effects && SKY.Effects.registerAnimMat) SKY.Effects.registerAnimMat(m);
    }
    return m;
  }

  /* soft round dot for the particle rigs — bare gl_Points are hard squares */
  let dotTex = null;
  function softDot() {
    if (dotTex) return dotTex;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    dotTex = new THREE.CanvasTexture(cv);
    return dotTex;
  }

  /* mythic particle rigs riding the gun: rising embers / twinkling stars /
     orbiting void shards. Children of the weapon group, ticked by Effects. */
  function attachOrbitFx(group, box, type) {
    const c = box.getCenter(new THREE.Vector3());
    const len = Math.max(0.18, box.max.z - box.min.z);
    const rad = Math.max(0.06, Math.max(box.max.x - box.min.x, box.max.y - box.min.y)) * 0.75;
    if (type === 'shards') {
      const fx = new THREE.Group();
      const geo = new THREE.TetrahedronGeometry(0.014);
      const mat = new THREE.MeshLambertMaterial({
        color: 0x1a1030, emissive: new THREE.Color('#8a4dff').multiplyScalar(0.8),
      });
      const shards = [];
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(geo, mat);
        shards.push({ m: s, ph: (i / 5) * Math.PI * 2, tilt: 0.35 + (i % 3) * 0.3 });
        fx.add(s);
      }
      fx.userData.tick = (t) => {
        for (const sd of shards) {
          const a = t * 1.6 + sd.ph;
          sd.m.position.set(
            c.x + Math.cos(a) * (rad + 0.05),
            c.y + Math.sin(a * 0.7 + sd.ph) * 0.045,
            c.z + Math.sin(a) * (len * 0.42));
          sd.m.rotation.set(a * 2.1, a * 1.3, 0);
        }
      };
      group.add(fx);
      if (SKY.Effects && SKY.Effects.registerAnimObj) SKY.Effects.registerAnimObj(fx);
      return;
    }
    const N = type === 'embers' ? 12 : 10;
    const pos = new Float32Array(N * 3);
    const seeds = [];
    for (let i = 0; i < N; i++) {
      seeds.push({
        ph: Math.random() * Math.PI * 2, sp: 0.5 + Math.random() * 0.7,
        x: (Math.random() - 0.5) * rad * 2, z: box.min.z + Math.random() * len,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: type === 'embers' ? 0xff7a20 : 0xaad4ff,
      size: type === 'embers' ? 0.009 : 0.007,
      map: softDot(), transparent: true, opacity: 0.8, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.userData.tick = (t) => {
      const a = geo.attributes.position.array;
      for (let i = 0; i < N; i++) {
        const s = seeds[i];
        if (type === 'embers') {       // embers rise off the gun and loop
          const cyc = ((t * s.sp * 0.35 + s.ph) % 1 + 1) % 1;
          a[i * 3] = c.x + s.x + Math.sin(t * 2 + s.ph) * 0.01;
          a[i * 3 + 1] = box.max.y + cyc * 0.09;
          a[i * 3 + 2] = s.z;
          if (i === 0) mat.opacity = 0.85;
        } else {                       // stars drift in a slow halo + twinkle
          const an = t * 0.5 * s.sp + s.ph;
          a[i * 3] = c.x + Math.cos(an) * (rad + 0.04);
          a[i * 3 + 1] = c.y + Math.sin(an * 1.3) * 0.05;
          a[i * 3 + 2] = c.z + Math.sin(an) * (len * 0.45);
          mat.opacity = 0.55 + 0.35 * Math.sin(t * 3.1);
        }
      }
      geo.attributes.position.needsUpdate = true;
    };
    group.add(pts);
    if (SKY.Effects && SKY.Effects.registerAnimObj) SKY.Effects.registerAnimObj(pts);
  }

  function applySkinFinish(group, f, kind) {
    group.updateMatrixWorld(true);
    const inv = group.matrixWorld.clone().invert();
    const box = new THREE.Box3().setFromObject(group);
    const len = Math.max(0.18, box.max.z - box.min.z);
    // ~1.6 pattern repeats along the gun, landing differently per weapon
    const scale = 1.6 / len;
    const h = kindHash(kind || 'gun');
    const off = new THREE.Vector2((h % 97) / 97, ((h >> 3) % 89) / 89);
    group.traverse((o) => {
      if (!o.isMesh || !o.material || o.name === 'tierglow') return;
      const local = inv.clone().multiply(o.matrixWorld);
      o.material = skinMaterial(f, local, scale, off);
    });
    if (f.orbitFx) attachOrbitFx(group, box, f.orbitFx);
  }

  const api = {
    CHARS, FINISHES, OUTFIT_COLORS,
    get data() { return data; },
    coins() { return data.coins; },

    setSkin(i) {            // index | null = auto
      data.skin = i;
      save();
      if (api.onChange) api.onChange();
    },
    setOutfit(hex) {        // hex | null = player color
      data.outfit = hex;
      save();
      if (api.onChange) api.onChange();
    },

    addCoins(n) {
      data.coins = Math.max(0, Math.round(data.coins + n));
      save();
      if (api.onChange) api.onChange();
    },

    /* match end: participation + KOs + win bonus. Returns the payout. */
    matchReward(won, kos) {
      const payout = 30 + (kos || 0) * 8 + (won ? 120 : 0);
      api.addCoins(payout);
      return payout;
    },

    ownsChar(id) {
      const def = charDef(id);
      return !!def && (def.price === 0 || data.ownedChars.includes(id));
    },
    /* finishes are bought PER WEAPON: 'pistol:pearl' etc. (plain ids from
       the earlier build stay honored as own-everywhere legacy entries) */
    ownsFinish(kind, id) {
      const def = finishDef(id);
      return def.price === 0 ||
        data.ownedFinishes.includes(kind + ':' + id) ||
        data.ownedFinishes.includes(id);
    },

    purchasesLocked,
    buyChar(id) {
      const def = charDef(id);
      if (purchasesLocked()) return false;
      if (!def || api.ownsChar(id) || data.coins < def.price) return false;
      data.coins -= def.price;
      data.ownedChars.push(id);
      save();
      if (api.onChange) api.onChange();
      return true;
    },
    buyFinish(kind, id) {
      const def = finishDef(id);
      if (purchasesLocked()) return false;
      if (!def || api.ownsFinish(kind, id) || data.coins < def.price) return false;
      data.coins -= def.price;
      data.ownedFinishes.push(kind + ':' + id);
      save();
      if (api.onChange) api.onChange();
      return true;
    },

    equipChar(id) {          // null = random
      if (id !== null && !api.ownsChar(id)) return false;
      data.char = id;
      save();
      if (api.onChange) api.onChange();
      return true;
    },
    equipFinish(kind, id) {
      if (!api.ownsFinish(kind, id)) return false;
      if (id === 'stock') delete data.finishes[kind];
      else data.finishes[kind] = id;
      save();
      if (api.onChange) api.onChange();
      return true;
    },

    finishFor(kind) { return data.finishes[kind] || 'stock'; },
    finishDef,
    charDef,

    /* everything cosmetic in one bundle — same shape the net roster carries
       (pawn.cos), so offline pawns/replays render identically to online */
    equipped() {
      return { char: data.char, fin: data.finishes, skin: data.skin, outfit: data.outfit,
        wpn: data.wpn || 'pistol' };
    },
    setLobbyWeapon(k) { data.wpn = k; save(); },

    /* paint a weapon mesh group in a finish (viewmodel/avatar/thumbs) */
    applyFinish(group, finishId, accentHex, kind) {
      const f = finishDef(finishId);
      if (!f) return;
      if (f.skin) { applySkinFinish(group, f, kind); return; }
      if (f.fx === 'fade' || f.fx === 'galaxy') { paintVertexFx(group, f.fx); return; }
      if (f.fx === 'pulse' || f.fx === 'spectrum') {
        group.traverse((o) => {
          if (!o.isMesh || !o.material || o.name === 'tierglow') return;
          o.material = o.material.clone();
          o.material.color.multiplyScalar(f.fx === 'spectrum' ? 0.55 : 0.85);
          o.material.userData.animFx = f.fx;
          o.material.userData.accent = accentHex || '#7dd8ff';
          if (SKY.Effects && SKY.Effects.registerAnimMat) SKY.Effects.registerAnimMat(o.material);
        });
        return;
      }
      if (!f.tint) return;
      const tint = new THREE.Color(f.tint).convertSRGBToLinear().multiplyScalar(f.mult || 1);
      const glow = f.glow ? new THREE.Color(accentHex || '#7dd8ff').multiplyScalar(f.glow) : null;
      group.traverse((o) => {
        if (!o.isMesh || !o.material || o.name === 'tierglow') return;
        o.material = o.material.clone();
        o.material.color.copy(tint);
        if (glow && o.material.emissive) o.material.emissive.copy(glow);
      });
    },

    onChange: null,
  };
  return api;
})();
