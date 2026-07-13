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

  /* weapon paint jobs: tint multiplies the gun's colormap, mult scales
     brightness, glow adds accent-colored emissive on the whole body */
  const FINISHES = [
    { id: 'stock',    name: 'STOCK',    price: 0,   tint: null },
    { id: 'pearl',    name: 'PEARL',    price: 200, tint: '#ffffff', mult: 1.55 },
    { id: 'crimson',  name: 'CRIMSON',  price: 300, tint: '#ff7a66', mult: 1.15 },
    { id: 'toxic',    name: 'TOXIC',    price: 300, tint: '#8dff70', mult: 1.15 },
    { id: 'gold',     name: 'GOLD',     price: 450, tint: '#ffd970', mult: 1.35 },
    { id: 'midnight', name: 'MIDNIGHT', price: 450, tint: '#5a6488', mult: 0.95, glow: 0.22 },
    { id: 'pulse',    name: 'PULSE',    price: 550, fx: 'pulse' },      // breathing glow
    { id: 'neon',     name: 'NEON',     price: 650, tint: '#3a4266', mult: 0.85, glow: 0.55 },
    { id: 'galaxy',   name: 'GALAXY',   price: 700, fx: 'galaxy' },     // starfield paint
    { id: 'fade',     name: 'FADE',     price: 800, fx: 'fade' },       // cyan→pink→gold
    { id: 'spectrum', name: 'SPECTRUM', price: 1000, fx: 'spectrum' },  // animated hue cycle
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
      return { char: data.char, fin: data.finishes, skin: data.skin, outfit: data.outfit };
    },

    /* paint a weapon mesh group in a finish (viewmodel/avatar/thumbs) */
    applyFinish(group, finishId, accentHex) {
      const f = finishDef(finishId);
      if (!f) return;
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
