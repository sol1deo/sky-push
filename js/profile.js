/* =============================================================================
 * SKY PUSH — player profile: coins, character + weapon-finish ownership.
 * Pure meta/cosmetic progression, persisted to localStorage. Coins are earned
 * at match end (participation + KOs + win bonus) and spent in the LOCKER.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Profile = (function () {
  // TWO wallets: the guest profile lives under KEY; a signed-in session runs
  // on KEY_ACCT (mirror of the cloud bundle). Sign-out swaps back to the
  // guest wallet — account coins/skins must NOT linger as device data (they
  // used to, which also let a fresh account "adopt" the previous user's bag)
  const KEY = 'skypush-profile';
  const KEY_ACCT = 'skypush-profile-acct';
  let storeKey = KEY;

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
  /* tier: std (flat price paint) | anim (animated) | epic | mythic.
     Mythics also carry: tracer {color, trail} = every bullet you fire wears
     the skin (trail styles live in weapons.js skinTrail), muzzleColor tints
     the flash, reload names a viewmodel flourish (effects.js vm). */
  const FINISHES = [
    { id: 'stock',      name: 'STOCK',      price: 0,    tier: 'std' },
    // ---- cheap PAINTS (spectrum retired — replaced by the paint row) ----
    { id: 'obsidian',   name: 'OBSIDIAN',   price: 250,  tier: 'std', tint: '#17181f' },
    { id: 'arctic',     name: 'ARCTIC',     price: 250,  tier: 'std', tint: '#dfe9f2' },
    { id: 'jungle',     name: 'JUNGLE',     price: 300,  tier: 'std', tint: '#3f6b3a' },
    { id: 'rosegold',   name: 'ROSE GOLD',  price: 350,  tier: 'std', tint: '#e8a68a', mult: 1.05 },
    { id: 'fade',       name: 'FADE',       price: 400,  tier: 'std', fx: 'fade' },
    { id: 'carbonviper', name: 'CARBON VIPER', price: 700, tier: 'std', skin: 'carbonviper',
      glowLo: 0.52, glowAmt: 0.45 },
    { id: 'sakura',     name: 'SAKURA',     price: 750,  tier: 'std', skin: 'sakura',
      glowLo: 0.93, glowAmt: 0.25 },
    { id: 'gilded',     name: 'GILDED AGE', price: 800,  tier: 'epic', skin: 'gilded',
      glowLo: 0.72, glowAmt: 0.3 },
    { id: 'toxic',      name: 'TOXIC OOZE', price: 850,  tier: 'epic', skin: 'toxic',
      glowLo: 0.4, glowAmt: 0.9, anim: 'ooze' },
    { id: 'cybergrid',  name: 'CYBERGRID',  price: 900,  tier: 'epic', skin: 'cybergrid',
      glowLo: 0.42, glowAmt: 0.85, anim: 'scan', scanColor: '#59f7ff' },
    { id: 'frostbite',  name: 'FROSTBITE',  price: 1000, tier: 'epic', skin: 'frostbite',
      glowLo: 0.88, glowAmt: 0.45, anim: 'shimmer' },
    { id: 'aurora',     name: 'AURORA',     price: 1200, tier: 'epic', skin: 'aurora',
      glowLo: 0.5, glowAmt: 0.8, anim: 'drift' },
    { id: 'dragonfire', name: 'DRAGONFIRE', price: 1800, tier: 'mythic', mythic: true,
      skin: 'dragonfire', glowLo: 0.34, glowAmt: 1.15, anim: 'lava', orbitFx: 'embers',
      tracer: { color: '#ff7a20', trail: 'flame' }, muzzleColor: '#ff8830' },
    { id: 'nebula',     name: 'NEBULA',     price: 2000, tier: 'mythic', mythic: true,
      skin: 'nebula', glowLo: 0.45, glowAmt: 0.95, anim: 'drift', orbitFx: 'stars',
      tracer: { color: '#b46bff', trail: 'star' }, muzzleColor: '#b46bff' },
    { id: 'voidwalker', name: 'VOIDWALKER', price: 2500, tier: 'mythic', mythic: true,
      skin: 'voidwalker', glowLo: 0.4, glowAmt: 1.05, anim: 'void', orbitFx: 'shards',
      tracer: { color: '#8a4dff', trail: 'void' }, muzzleColor: '#7a3dff' },
    { id: 'tempest',    name: 'TEMPEST',    price: 2600, tier: 'mythic', mythic: true,
      skin: 'tempest', glowLo: 0.5, glowAmt: 1.1, anim: 'strobe', orbitFx: 'arcs',
      tracer: { color: '#59d8ff', trail: 'spark' }, muzzleColor: '#59d8ff' },
    { id: 'phoenix',    name: 'PHOENIX',    price: 2800, tier: 'mythic', mythic: true,
      skin: 'phoenix', glowLo: 0.42, glowAmt: 1.2, anim: 'lava', orbitFx: 'wings',
      tracer: { color: '#ffb020', trail: 'flame' }, muzzleColor: '#ffc040', reload: 'spin' },
    { id: 'midas',      name: 'MIDAS',      price: 3000, tier: 'mythic', mythic: true,
      skin: 'midas', glowLo: 0.55, glowAmt: 0.9, anim: 'shimmer', orbitFx: 'coins',
      tracer: { color: '#ffd34d', trail: 'gold' }, muzzleColor: '#ffd34d', reload: 'spin' },
    // flagship drop: obsidian-black body, molten crimson eclipse cracks,
    // precessing blood-ring halo, crimson tracers, TOSS reload (gun flips
    // up and gets caught), 'eclipse' glow — calm, then a surge
    { id: 'bloodmoon',  name: 'BLOOD MOON', price: 3200, tier: 'mythic', mythic: true,
      skin: 'bloodmoon', glowLo: 0.36, glowAmt: 1.2, anim: 'eclipse', orbitFx: 'halo',
      tracer: { color: '#ff2e4a', trail: 'blood' }, muzzleColor: '#ff3050', reload: 'toss' },
  ];

  /* free cosmetic palettes (no purchase — just identity options) */
  const OUTFIT_COLORS = ['#ffd34d', '#40c8ff', '#ff5db1', '#7dff9e', '#a48aff',
    '#ffb85a', '#e63946', '#2ee6c8', '#f2f4f6', '#3a4150', '#0a0a0d'];

  /* universal TRACER FX (store-only): your bullets shed these particles on
     EVERY weapon — a mythic skin's own signature tracer still wins on the
     gun that wears it */
  const TRACERS = [
    { id: 'flame', name: 'DRAGON BREATH', price: 800, color: '#ff7a20', trail: 'flame',
      desc: 'every bullet billows fire' },
    { id: 'spark', name: 'STATIC SURGE',  price: 800, color: '#59d8ff', trail: 'spark',
      desc: 'crackling electric wake' },
    { id: 'star',  name: 'STARDUST',      price: 800, color: '#b46bff', trail: 'star',
      desc: 'a ribbon of falling stars' },
    { id: 'gold',  name: 'GOLD RUSH',     price: 850, color: '#ffd34d', trail: 'gold',
      desc: 'rounds that rain gold dust' },
    { id: 'void',  name: 'VOID WAKE',     price: 900, color: '#8a4dff', trail: 'void',
      desc: 'darkness follows every shot' },
    { id: 'blood', name: 'BLOOD TRAIL',   price: 950, color: '#ff2e4a', trail: 'blood',
      desc: 'crimson drops mark your line of fire' },
  ];
  /* KO SOUNDS (store-only): the noise YOUR victims make when you knock them
     out — everyone in the match hears your signature */
  const KO_SOUNDS = [
    { id: 'oof',  name: 'OOF',         price: 400, desc: 'the classic. never gets old' },
    { id: 'bonk', name: 'BONK',        price: 450, desc: 'wooden. deeply disrespectful' },
    { id: 'fall', name: 'AIIEEE',      price: 500, desc: 'a long theatrical plummet' },
    { id: 'horn', name: 'SAD TRUMPET', price: 600, desc: 'womp womp' },
  ];

  const DEFAULTS = {
    coins: 300,
    char: null,             // null = surprise me (name-hash pick)
    skin: null,             // index into Characters.SKINS | null = auto
    outfit: null,           // outfit hex | null = your player color
    ownedChars: [],         // ids bought (price-0 chars are implicitly owned)
    ownedFinishes: [],      // finish ids bought ('stock' implicit)
    finishes: {},           // weapon kind -> finish id (missing = stock)
    wpn: 'pistol',          // the weapon your character holds in lobbies
    ownedFx: [],            // universal tracer FX bought (store)
    fxTracer: null,         // equipped tracer FX id | null
    ownedSnd: [],           // KO sounds bought (store)
    koSnd: null,            // equipped KO sound id | null
  };

  let data = load();

  function load() {
    try {
      const raw = localStorage.getItem(storeKey);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      return { ...JSON.parse(JSON.stringify(DEFAULTS)), ...JSON.parse(raw) };
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  function save() {
    try { localStorage.setItem(storeKey, JSON.stringify(data)); } catch (e) {}
    // logged-in players carry their cosmetics on the account (debounced push)
    if (SKY.Account && SKY.Account.pushCosmetics) SKY.Account.pushCosmetics();
  }
  /* wardrobe/loadout visuals re-resolve after a wallet swap */
  function refreshAfterSwap() {
    if (SKY.Effects && SKY.Effects.refreshSkins) SKY.Effects.refreshSkins();
    if (api.onChange) api.onChange();
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

  function skinMaterial(f, localMat, scale, off, baseMap) {
    // keeping the ORIGINAL colormap bound gives the shader the gun's real
    // paint: dark texels = scopes/rails/grips, which STAY unskinned so the
    // wrap reads as a tailored paint job, not a shrink-wrap over everything
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff, map: baseMap || null });
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
          'float skinMix = 1.0;\n' +
          '#ifdef USE_MAP\n' +
          '  vec4 baseCol = texture2D(map, vUv);\n' +
          '  float baseLum = dot(baseCol.rgb, vec3(0.299, 0.587, 0.114));\n' +
          '  skinMix = smoothstep(0.028, 0.085, baseLum);\n' +   // dark attachments keep base paint
          '  diffuseColor.rgb = mix(baseCol.rgb, skinCol.rgb, skinMix);\n' +
          '#else\n' +
          '  diffuseColor.rgb *= skinCol.rgb;\n' +
          '#endif')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          'float sLum = dot(skinCol.rgb, vec3(0.299, 0.587, 0.114));\n' +
          'totalEmissiveRadiance += skinCol.rgb * smoothstep(uGlowLo, 1.0, sLum) * uGlowAmt * skinMix;\n' +
          'if (uScan > 0.0) {\n' +
          '  float band = smoothstep(0.09, 0.0, abs(fract(vSkinP.z * uSkinScale * 0.6 - uTime * 0.45) - 0.5));\n' +
          '  totalEmissiveRadiance += uScanCol * band * uScan * skinMix;\n' +
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
        else if (f.anim === 'ooze') sh.uniforms.uGlowAmt.value = base * (0.65 + 0.35 * Math.sin(t * 0.9));
        else if (f.anim === 'eclipse') {
          // long calm smolder, then a slow blood-red SURGE sweeping through
          const cyc = (t * 0.22) % 1;
          const surge = Math.max(0, Math.sin(cyc * Math.PI * 2)) ** 3;
          sh.uniforms.uGlowAmt.value = base * (0.4 + 1.0 * surge);
        }
        else if (f.anim === 'strobe') {
          // lightning: mostly calm, with sharp random-feeling double flashes
          const ph = t * 1.9;
          const burst = Math.max(0, Math.sin(ph * 7) * Math.sin(ph * 1.3) - 0.55) * 2.2;
          sh.uniforms.uGlowAmt.value = base * (0.45 + burst);
        }
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
    if (type === 'arcs') {             // TEMPEST: jagged lightning crawling the gun
      const fx = new THREE.Group();
      const arcs = [];
      for (let i = 0; i < 3; i++) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
        const l = new THREE.Line(g, new THREE.LineBasicMaterial({
          color: 0x9de8ff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        l.frustumCulled = false;
        arcs.push({ l, g, next: 0, ph: i * 1.3 });
        fx.add(l);
      }
      fx.userData.tick = (t) => {
        for (const ac of arcs) {
          if (t > ac.next) {           // re-strike: new zigzag along the body
            ac.next = t + 0.09 + ((t * 997 + ac.ph) % 1) * 0.35;
            const z0 = box.min.z + ((t * 131 + ac.ph) % 1) * len;
            const z1 = z0 + (((t * 173) % 1) - 0.5) * len * 0.5;
            const a = ac.g.attributes.position.array;
            for (let k = 0; k < 7; k++) {
              const f2 = k / 6;
              a[k * 3] = c.x + (((t * 37 + k * 13 + ac.ph) % 1) - 0.5) * rad * 2.4;
              a[k * 3 + 1] = c.y + (((t * 53 + k * 29) % 1) - 0.5) * rad * 2.4;
              a[k * 3 + 2] = z0 + (z1 - z0) * f2;
            }
            ac.g.attributes.position.needsUpdate = true;
            ac.l.material.opacity = 0.9;
          }
          ac.l.material.opacity *= 0.82;   // strikes decay fast
        }
      };
      group.add(fx);
      if (SKY.Effects && SKY.Effects.registerAnimObj) SKY.Effects.registerAnimObj(fx);
      return;
    }
    if (type === 'halo') {
      // BLOOD MOON: a FLOWING ring of blood embers — two comet streams chase
      // each other around a slowly precessing orbit, bright at the head and
      // fading down the tail (the solid torus ring read cheap + off-color)
      const fx = new THREE.Group();
      const N2 = 46;
      const pos2 = new Float32Array(N2 * 3);
      const col2 = new Float32Array(N2 * 3);
      const geo2 = new THREE.BufferGeometry();
      geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
      geo2.setAttribute('color', new THREE.BufferAttribute(col2, 3));
      const pts2 = new THREE.Points(geo2, new THREE.PointsMaterial({
        size: 0.0095, map: softDot(), vertexColors: true, transparent: true,
        opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
        sizeAttenuation: true }));
      pts2.frustumCulled = false;
      fx.add(pts2);
      const R2 = rad + 0.07;
      // additive particles WASH WHITE over bright skies — the tail must run
      // nearly black (invisible in additive) so only the comet heads burn
      const bright = new THREE.Color('#ff4652');
      const midC = new THREE.Color('#a3121f');
      const dim = new THREE.Color('#1c0306');
      const _cc = new THREE.Color();
      fx.userData.tick = (t) => {
        const tiltX = Math.sin(t * 0.5) * 0.4, tiltZ = Math.cos(t * 0.42) * 0.4;
        for (let i = 0; i < N2; i++) {
          const u = i / N2;
          const an = u * Math.PI * 2 + t * 1.15;   // the whole orbit turns...
          const x = Math.cos(an) * R2;
          const z = Math.sin(an) * (len * 0.42);
          pos2[i * 3] = c.x + x;
          pos2[i * 3 + 1] = c.y + x * tiltZ * 0.45 + z * tiltX * 0.4 +
            Math.sin(an * 3 + t) * 0.006;          // ...on a precessing plane
          pos2[i * 3 + 2] = c.z + z;
          // ...while two ember HEADS drift through the particles, each
          // dragging an exponential tail — reads as flowing streams
          const ph = ((u - t * 0.16) % 1 + 1) % 1;
          const k = Math.min(1, Math.exp(-ph * 12) + Math.exp(-((ph + 0.5) % 1) * 12) * 0.8);
          _cc.copy(dim).lerp(midC, Math.min(1, k * 1.3));
          if (k > 0.65) _cc.lerp(bright, (k - 0.65) / 0.35);
          col2[i * 3] = _cc.r; col2[i * 3 + 1] = _cc.g; col2[i * 3 + 2] = _cc.b;
        }
        geo2.attributes.position.needsUpdate = true;
        geo2.attributes.color.needsUpdate = true;
      };
      group.add(fx);
      if (SKY.Effects && SKY.Effects.registerAnimObj) SKY.Effects.registerAnimObj(fx);
      return;
    }
    const KINDS = {
      embers: { n: 12, color: 0xff7a20, size: 0.009 },
      stars: { n: 10, color: 0xaad4ff, size: 0.007 },
      wings: { n: 14, color: 0xffc040, size: 0.01 },
      coins: { n: 9, color: 0xffd34d, size: 0.008 },
    };
    const K = KINDS[type] || KINDS.embers;
    const N = K.n;
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
      color: K.color, size: K.size,
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
        } else if (type === 'wings') { // PHOENIX: flame feathers streaming back
          const cyc = ((t * s.sp * 0.5 + s.ph) % 1 + 1) % 1;
          a[i * 3] = c.x + s.x * 0.7 + Math.sin(t * 3 + s.ph) * 0.012;
          a[i * 3 + 1] = c.y + Math.abs(s.x) * 0.6 + cyc * 0.05 + Math.sin(cyc * 9 + s.ph) * 0.012;
          a[i * 3 + 2] = box.max.z * 0.2 + cyc * (len * 0.9);   // muzzle → past the stock
          mat.opacity = 0.9;
        } else if (type === 'coins') { // MIDAS: gold dripping off the gun
          const cyc = ((t * s.sp * 0.4 + s.ph) % 1 + 1) % 1;
          a[i * 3] = c.x + s.x * 0.8;
          a[i * 3 + 1] = box.min.y + 0.02 - cyc * cyc * 0.12;   // accelerating drip
          a[i * 3 + 2] = s.z;
          mat.opacity = 0.85;
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
      o.material = skinMaterial(f, local, scale, off, o.material.map || null);
    });
    if (f.orbitFx) attachOrbitFx(group, box, f.orbitFx);
  }

  const api = {
    CHARS, FINISHES, OUTFIT_COLORS, TRACERS, KO_SOUNDS,
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
      // live-refresh the viewmodel/hook/cannon — no page reload needed
      if (SKY.Effects && SKY.Effects.refreshSkins) SKY.Effects.refreshSkins();
      if (api.onChange) api.onChange();
      return true;
    },

    finishFor(kind) { return data.finishes[kind] || 'stock'; },
    finishDef,
    charDef,

    /* -------- store-only cosmetics: universal tracers + KO sounds -------- */
    fxDef(id) { return TRACERS.find(t => t.id === id) || null; },
    sndDef(id) { return KO_SOUNDS.find(s => s.id === id) || null; },
    ownsFx(id) { return data.ownedFx.includes(id); },
    ownsSnd(id) { return data.ownedSnd.includes(id); },
    buyFx(id) {
      const def = api.fxDef(id);
      if (purchasesLocked() || !def || api.ownsFx(id) || data.coins < def.price) return false;
      data.coins -= def.price;
      data.ownedFx.push(id);
      save();
      if (api.onChange) api.onChange();
      return true;
    },
    buySnd(id) {
      const def = api.sndDef(id);
      if (purchasesLocked() || !def || api.ownsSnd(id) || data.coins < def.price) return false;
      data.coins -= def.price;
      data.ownedSnd.push(id);
      save();
      if (api.onChange) api.onChange();
      return true;
    },
    equipFx(id) {           // null = off
      if (id !== null && !api.ownsFx(id)) return false;
      data.fxTracer = id;
      save();
      if (api.onChange) api.onChange();
      return true;
    },
    equipSnd(id) {          // null = off
      if (id !== null && !api.ownsSnd(id)) return false;
      data.koSnd = id;
      save();
      if (api.onChange) api.onChange();
      return true;
    },

    /* -------- wallet swap (account.js drives this) --------
     * accountMode(cloud): sign-in — run on the account wallet. A non-empty
     * cloud bundle REPLACES the working data; an empty one (first login)
     * adopts the current guest bag as the account's starting wardrobe.
     * guestMode(): sign-out — reload the untouched guest wallet. */
    accountMode(cloud) {
      const adopt = !(cloud && Object.keys(cloud).length);
      const guestBag = adopt ? JSON.parse(JSON.stringify(data)) : null;
      storeKey = KEY_ACCT;
      data = adopt
        ? guestBag
        : { ...JSON.parse(JSON.stringify(DEFAULTS)), ...cloud };
      save();                      // mirror locally + push (covers adoption)
      refreshAfterSwap();
    },
    guestMode() {
      if (storeKey === KEY) return;
      storeKey = KEY;
      data = load();
      refreshAfterSwap();
    },

    /* everything cosmetic in one bundle — same shape the net roster carries
       (pawn.cos), so offline pawns/replays render identically to online */
    equipped() {
      return { char: data.char, fin: data.finishes, skin: data.skin, outfit: data.outfit,
        wpn: data.wpn || 'pistol', fxt: data.fxTracer, ksnd: data.koSnd };
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
