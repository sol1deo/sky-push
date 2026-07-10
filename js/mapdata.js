/* =============================================================================
 * SKY PUSH — data-driven custom maps
 * The built-in maps are code; EDITOR maps are JSON:
 *   { id, name, mood, sky, killY, crown,
 *     blocks:[{ p,s,r, pal|color|tex, rep, mover, crumble }],
 *     pads:[{ p, launch }], spawns:[{ p, yaw }], items:[{ p }] }
 * Everything a map needs is inside the def (textures ride along as dataURLs)
 * so a def can be saved, exported, or beamed to friends in the lobby.
 *
 * Sources of custom maps:
 *   drafts    — localStorage (the editor's save slot)
 *   deployed  — maps/index.json manifest fetched at boot (https only)
 *   network   — the host sends its map def inside the 'start' message
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.MapData = (function () {
  const DRAFT_KEY = 'skypush-mapdrafts';

  /* mood/lighting presets — lifted from the built-in maps */
  const MOODS = {
    golden: { label: 'Golden hour',
      sun: [0xffd9a0, 1.45, [38, 32, 22]], hemi: [0xbfd4f5, 0x5a6070, 0.45],
      fill: [0x8aa4e8, 0.3, null], fog: ['#a8bede', 90, 280], clouds: '#fff0dd' },
    day: { label: 'Bright day',
      sun: [0xffe0b0, 1.5, [40, 55, -18]], hemi: [0xbccdec, 0x6a6258, 0.6],
      fill: [0x9ab0e8, 0.3, null], fog: ['#a8b4d0', 85, 280], clouds: '#fff0dd' },
    afternoon: { label: 'Warm afternoon',
      sun: [0xffd9a0, 1.5, [-45, 40, 30]], hemi: [0xbcd0ec, 0x6a625e, 0.6],
      fill: [0x8aa4e8, 0.3, null], fog: ['#b0bcd4', 70, 260], clouds: null },
    sea: { label: 'Open sea',
      sun: [0xfff2d0, 1.6, [-35, 55, 25]], hemi: [0xcfe4ff, 0x87b2c8, 0.85],
      fill: [0x8ad4ff, 0.4, null], fog: ['#a8d4ea', 90, 300], clouds: '#ffffff' },
    night: { label: 'Neon night',
      sun: [0xe4eeff, 1.4, [30, 55, -25]], hemi: [0x7e96d4, 0x39404f, 0.85],
      fill: [0xff9ac8, 0.22, [-30, 20, 30]], fog: ['#35446e', 60, 220], clouds: null },
    forge: { label: 'Amber forge',
      sun: [0xffd0a0, 1.25, [28, 55, 12]], hemi: [0xb09076, 0x453228, 0.8],
      fill: [0xff8a4a, 0.3, [-30, -10, 20]], fog: ['#54301f', 50, 200], clouds: null },
    dawn: { label: 'Pale dawn',
      sun: [0xffc4d8, 1.15, [55, 18, 30]], hemi: [0xa8b8e0, 0x4a4552, 0.5],
      fill: [0xffa8c0, 0.25, null], fog: ['#b8a8c8', 70, 240], clouds: '#ffd8e8' },
    dusk: { label: 'Deep dusk',
      sun: [0xff9a5a, 0.85, [-50, 14, 20]], hemi: [0x5a6494, 0x3a3440, 0.45],
      fill: [0x7a6ab8, 0.25, null], fog: ['#4a4468', 55, 200], clouds: null },
    midnight: { label: 'Midnight',
      sun: [0xaac4ff, 0.55, [25, 60, -30]], hemi: [0x2a3a64, 0x14161f, 0.4],
      fill: [0x4a5a9a, 0.18, null], fog: ['#10141f', 40, 160], clouds: null },
  };
  const SKIES = {
    golden: ['#2f5da8', '#7ba4d8', '#ffd9a4', false],
    day: ['#2f5da8', '#84aede', '#ffd9a8', false],
    sunset: ['#2f5da8', '#84aede', '#ffcf95', false],
    sea: ['#1e6ac0', '#66aade', '#d8f0ff', false],
    night: ['#101c3c', '#283c74', '#5a70ac', true],
    forge: ['#241820', '#4a2a20', '#8a4522', false],
    dawn: ['#6a5a9a', '#c88aa8', '#ffd8c0', false],
    dusk: ['#241c3c', '#4a3c6a', '#c86a4a', true],
    midnight: ['#05070f', '#0c1224', '#1a2440', true],
  };
  /* the sky that matches each mood — picking a mood applies it */
  const SKY_FOR_MOOD = {
    golden: 'golden', day: 'day', afternoon: 'sunset', sea: 'sea',
    night: 'night', forge: 'forge', dawn: 'dawn', dusk: 'dusk', midnight: 'midnight',
  };

  /* checker palettes from the built-in maps (id -> [colorA, colorB]) */
  const PALETTES = {
    pearl: ['#dde4ef', '#a3b2ca'], mint: ['#c9f0dd', '#84c5a5'],
    rose: ['#f6d4e3', '#d29ab8'], sand: ['#f5e9c4', '#d3ba7d'],
    sky: ['#cfdef6', '#93aed6'], amber: ['#ffe3a9', '#e8a83e'],
    wall: ['#b6c2d6', '#8593ad'], stone: ['#4a4149', '#2e282f'],
    coal: ['#3a3238', '#241f26'], roof: ['#3f4552', '#2b3040'],
    slate: ['#262b38', '#191d28'], dune: ['#8a7a68', '#5f5346'],
    clay: ['#6a5d50', '#453b32'], hull: ['#f2f4f6', '#c8ced6'],
    teak: ['#d8c49e', '#b89f78'], navy: ['#3a4250', '#282e3a'],
    concrete: ['#c8ccd4', '#a8adb8'], hazard: ['#e8c85a', '#c4a83e'],
  };

  const registry = new Map();   // id -> def (drafts + deployed + net-received)

  function blank() {
    return {
      id: 'd' + Math.random().toString(36).slice(2, 8),
      name: 'NEW MAP',
      mood: 'golden', sky: 'golden',
      killY: -22, crown: [0, 1, 0],
      blocks: [
        { p: [0, -1, 0], s: [26, 2, 26], r: [0, 0, 0], pal: 'pearl', crumble: false, mover: null },
      ],
      pads: [],
      spawns: [
        { p: [6, 0.1, 6], yaw: Math.PI * 0.75 }, { p: [-6, 0.1, 6], yaw: -Math.PI * 0.75 },
        { p: [6, 0.1, -6], yaw: Math.PI * 0.25 }, { p: [-6, 0.1, -6], yaw: -Math.PI * 0.25 },
        { p: [0, 0.1, 8], yaw: Math.PI }, { p: [0, 0.1, -8], yaw: 0 },
      ],
      items: [],
      props: [],
      assets: {},
    };
  }

  function normalize(def) {
    def.blocks = def.blocks || [];
    def.pads = def.pads || [];
    def.spawns = def.spawns || [];
    def.items = def.items || [];
    def.props = def.props || [];     // placed 3D assets
    def.assets = def.assets || {};   // embedded asset payloads (id -> {name,type,data})
    def.mood = MOODS[def.mood] ? def.mood : 'golden';
    def.sky = SKIES[def.sky] ? def.sky : 'golden';
    if (typeof def.killY !== 'number') def.killY = -22;
    if (!def.crown) def.crown = [0, 1, 0];
    if (!def.name) def.name = 'CUSTOM MAP';
    return def;
  }

  /* ---------- localStorage drafts ---------- */
  function loadDraftStore() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveDraftStore(st) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(st)); return true; }
    catch (e) { return false; }   // quota (huge textures) — export instead
  }

  const api = {
    MOODS, SKIES, PALETTES, SKY_FOR_MOOD,
    blank, normalize,

    register(def) {
      normalize(def);
      registry.set(def.id, def);
      if (api.onListChange) api.onListChange();
      return def;
    },
    get(id) { return registry.get(id); },
    list() { return [...registry.values()]; },

    saveDraft(def) {
      const st = loadDraftStore();
      st[def.id] = def;
      const ok = saveDraftStore(st);
      api.register(def);
      return ok;
    },
    deleteDraft(id) {
      const st = loadDraftStore();
      delete st[id];
      saveDraftStore(st);
      registry.delete(id);
      if (api.onListChange) api.onListChange();
    },
    drafts() { return Object.values(loadDraftStore()); },

    onListChange: null,   // menu hooks this to refresh map buttons

    init() {
      for (const d of api.drafts()) api.register(d);
      // deployed maps (https only — fetch fails silently from file://)
      fetch('maps/index.json')
        .then(r => r.json())
        .then(list => Promise.all(list.map(u => fetch(u).then(r => r.json()))))
        .then(defs => defs.forEach(d => api.register(d)))
        .catch(() => {});
    },
  };
  return api;
})();
