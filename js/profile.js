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
    { id: 'neon',     name: 'NEON',     price: 650, tint: '#3a4266', mult: 0.85, glow: 0.55 },
  ];

  const DEFAULTS = {
    coins: 300,
    char: null,             // null = surprise me (name-hash pick)
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
  }

  function charDef(id) { return CHARS.find(c => c.id === id) || null; }
  function finishDef(id) { return FINISHES.find(f => f.id === id) || FINISHES[0]; }

  const api = {
    CHARS, FINISHES,
    get data() { return data; },
    coins() { return data.coins; },

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

    buyChar(id) {
      const def = charDef(id);
      if (!def || api.ownsChar(id) || data.coins < def.price) return false;
      data.coins -= def.price;
      data.ownedChars.push(id);
      save();
      if (api.onChange) api.onChange();
      return true;
    },
    buyFinish(kind, id) {
      const def = finishDef(id);
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

    /* paint a weapon mesh group in a finish (viewmodel/avatar/thumbs) */
    applyFinish(group, finishId, accentHex) {
      const f = finishDef(finishId);
      if (!f || !f.tint) return;
      const tint = new THREE.Color(f.tint).multiplyScalar(f.mult || 1);
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
