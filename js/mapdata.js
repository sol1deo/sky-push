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
  /* disc: 'sun' | 'moon' | null (the visible celestial body)
     shafts: cinematic light rays — only for sunny/hazy moods */
  const MOODS = {
    golden: { label: 'Golden hour',
      sun: [0xffd9a0, 1.45, [38, 32, 22]], hemi: [0xbfd4f5, 0x5a6070, 0.45],
      fill: [0x8aa4e8, 0.3, null], fog: ['#a8bede', 90, 280], clouds: '#fff0dd',
      disc: 'sun', discSize: 80, discColor: '#ffc97a', shafts: true },
    day: { label: 'Bright day',
      sun: [0xffe0b0, 1.5, [40, 55, -18]], hemi: [0xbccdec, 0x6a6258, 0.6],
      fill: [0x9ab0e8, 0.3, null], fog: ['#a8b4d0', 85, 280], clouds: '#fff0dd',
      disc: 'sun', discSize: 50, discColor: '#fff4d8', shafts: true },
    afternoon: { label: 'Warm afternoon',
      sun: [0xffd9a0, 1.5, [-45, 40, 30]], hemi: [0xbcd0ec, 0x6a625e, 0.6],
      fill: [0x8aa4e8, 0.3, null], fog: ['#b0bcd4', 70, 260], clouds: null,
      disc: 'sun', discSize: 65, discColor: '#ffd9a0', shafts: true },
    sea: { label: 'Open sea',
      sun: [0xfff2d0, 1.6, [-35, 55, 25]], hemi: [0xcfe4ff, 0x87b2c8, 0.85],
      fill: [0x8ad4ff, 0.4, null], fog: ['#a8d4ea', 90, 300], clouds: '#ffffff',
      disc: 'sun', discSize: 58, discColor: '#fff8e0', shafts: true },
    night: { label: 'Neon night',
      sun: [0xe4eeff, 1.4, [30, 55, -25]], hemi: [0x7e96d4, 0x39404f, 0.85],
      fill: [0xff9ac8, 0.22, [-30, 20, 30]], fog: ['#35446e', 60, 220], clouds: null,
      disc: 'moon', discSize: 46, discColor: '#e8f0ff', shafts: false },
    forge: { label: 'Amber forge',
      sun: [0xffd0a0, 1.25, [28, 55, 12]], hemi: [0xb09076, 0x453228, 0.8],
      fill: [0xff8a4a, 0.3, [-30, -10, 20]], fog: ['#54301f', 50, 200], clouds: null,
      disc: null, shafts: false },
    dawn: { label: 'Pale dawn',
      sun: [0xffc4d8, 1.15, [55, 18, 30]], hemi: [0xa8b8e0, 0x4a4552, 0.5],
      fill: [0xffa8c0, 0.25, null], fog: ['#b8a8c8', 70, 240], clouds: '#ffd8e8',
      disc: 'sun', discSize: 95, discColor: '#ffb8d0', shafts: true },
    dusk: { label: 'Sunset dusk',
      sun: [0xff9a5a, 0.95, [-50, 14, 20]], hemi: [0x5a6494, 0x3a3440, 0.4],
      fill: [0x7a6ab8, 0.25, null], fog: ['#4a4468', 55, 210], clouds: null,
      disc: 'sun', discSize: 110, discColor: '#ff8a6a', shafts: true },
    midnight: { label: 'Midnight',
      sun: [0xbfd8ff, 0.95, [25, 60, -30]], hemi: [0x22304f, 0x0c0e16, 0.22],
      fill: [0x4a5a9a, 0.12, null], fog: ['#0c101c', 40, 170], clouds: null,
      disc: 'moon', discSize: 60, discColor: '#dce8ff', shafts: false },
  };
  const SKIES = {
    golden: ['#2f5da8', '#7ba4d8', '#ffd9a4', false],
    day: ['#2f5da8', '#84aede', '#ffd9a8', false],
    sunset: ['#312a6e', '#a86a9e', '#ffab7a', false],
    sea: ['#1e6ac0', '#66aade', '#d8f0ff', false],
    night: ['#101c3c', '#283c74', '#5a70ac', true],
    forge: ['#241820', '#4a2a20', '#8a4522', false],
    dawn: ['#6a5a9a', '#c88aa8', '#ffd8c0', false],
    dusk: ['#241c3c', '#5a3c6a', '#ff9a6a', true],
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
      light: 1,        // global lighting dial (0.05 dark .. 2 blown out)
      skyc: null,      // custom sky {top, mid, hor, stars, clouds, cloudCol}
      shafts: null,    // global sky godrays: null = mood default, true/false = forced
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
    if (typeof def.light !== 'number') def.light = 1;
    if (def.skyc && typeof def.skyc !== 'object') def.skyc = null;
    if (def.fog && typeof def.fog !== 'object') def.fog = null;
    if (def.fog && def.fog.near === undefined) {
      // legacy density dial -> explicit near/far range
      const d = typeof def.fog.density === 'number' ? def.fog.density : 0.3;
      def.fog.near = Math.round(100 - 92 * d);
      def.fog.far = Math.round(340 - 285 * d);
      delete def.fog.density;
    }
    if (def.shafts !== true && def.shafts !== false) def.shafts = null;
    if (typeof def.killY !== 'number') def.killY = -22;
    if (!def.crown) def.crown = [0, 1, 0];
    if (!def.name) def.name = 'CUSTOM MAP';
    return def;
  }

  /* ---------- persistent drafts ----------
   * IndexedDB is the source of truth. localStorage (the old home) has a
   * ~5MB quota that maps with embedded textures blow straight past — the
   * save silently failed and the map VANISHED on reload. It is kept only
   * as a legacy migration source + best-effort mirror for small maps.
   * Records in 'skypush-maps' / 'maps' (key -> { key, id, def, t }):
   *   draft:<id>       explicit saves
   *   autosave:<id>    the editor's rolling autosave (cleared by a save)
   *   backup:<id>:<n>  previous saved versions, newest first, rotated
   */
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const BACKUPS = 3;
  let db = null;
  const draftCache = {};    // id -> { def, t }
  const autoCache = {};     // id -> { def, t }
  const backupCache = {};   // id -> [{ def, t }, ...] newest first
  const deployedIds = new Set();

  function idbPut(rec) {
    if (!db) return;
    try { db.transaction('maps', 'readwrite').objectStore('maps').put(rec); } catch (e) {}
  }
  function idbDel(key) {
    if (!db) return;
    try { db.transaction('maps', 'readwrite').objectStore('maps').delete(key); } catch (e) {}
  }
  function openDb(then) {
    try {
      const req = indexedDB.open('skypush-maps', 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore('maps', { keyPath: 'key' });
      req.onsuccess = (e) => { db = e.target.result; then(); };
      req.onerror = () => then();
    } catch (e) { then(); }
  }
  function loadStores(then) {
    if (!db) { then(); return; }
    try {
      db.transaction('maps', 'readonly').objectStore('maps').getAll().onsuccess = (e) => {
        for (const rec of e.target.result || []) {
          if (!rec || !rec.def) continue;
          if (rec.key.indexOf('draft:') === 0) draftCache[rec.id] = { def: rec.def, t: rec.t || 0 };
          else if (rec.key.indexOf('autosave:') === 0) autoCache[rec.id] = { def: rec.def, t: rec.t || 0 };
          else if (rec.key.indexOf('backup:') === 0) {
            (backupCache[rec.id] = backupCache[rec.id] || []).push({ def: rec.def, t: rec.t || 0 });
          }
        }
        for (const id in backupCache) backupCache[id].sort((a, b) => b.t - a.t);
        then();
      };
    } catch (e) { then(); }
  }

  /* legacy localStorage store (read for migration, written as a mirror) */
  function loadDraftStore() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; }
    catch (e) { return {}; }
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
      normalize(def);
      const snap = clone(def);
      const t = Date.now();
      const prev = draftCache[def.id];
      if (prev) {   // rotate the previous saved version into the backups
        const list = backupCache[def.id] = backupCache[def.id] || [];
        list.unshift(prev);
        if (list.length > BACKUPS) list.length = BACKUPS;
        list.forEach((b, i) => idbPut({ key: 'backup:' + def.id + ':' + i, id: def.id, def: b.def, t: b.t }));
      }
      draftCache[def.id] = { def: snap, t };
      idbPut({ key: 'draft:' + def.id, id: def.id, def: snap, t });
      delete autoCache[def.id];
      idbDel('autosave:' + def.id);
      // legacy mirror — quota failures are fine, IndexedDB is canonical
      let lsOk = false;
      try {
        const st = loadDraftStore();
        st[def.id] = snap;
        localStorage.setItem(DRAFT_KEY, JSON.stringify(st));
        lsOk = true;
      } catch (e) {}
      api.register(snap);
      return !!db || lsOk;
    },

    /* rolling autosave from the editor — recovery net, not a real save */
    autosave(def) {
      normalize(def);
      const snap = clone(def);
      autoCache[def.id] = { def: snap, t: Date.now() };
      idbPut({ key: 'autosave:' + def.id, id: def.id, def: snap, t: Date.now() });
      return !!db;
    },
    autosaveOf(id) { return autoCache[id] || null; },
    draftMeta(id) { return draftCache[id] || null; },
    backupsOf(id) { return backupCache[id] || []; },
    isDeployed(id) { return deployedIds.has(id); },
    /* autosaves with no draft, or newer than their draft — unsaved work */
    recoverables() {
      return Object.keys(autoCache)
        .filter(id => !draftCache[id] || autoCache[id].t > draftCache[id].t)
        .map(id => autoCache[id].def);
    },

    deleteDraft(id) {
      delete draftCache[id];
      delete autoCache[id];
      delete backupCache[id];
      idbDel('draft:' + id);
      idbDel('autosave:' + id);
      for (let i = 0; i < BACKUPS; i++) idbDel('backup:' + id + ':' + i);
      try {
        const st = loadDraftStore();
        delete st[id];
        localStorage.setItem(DRAFT_KEY, JSON.stringify(st));
      } catch (e) {}
      registry.delete(id);
      if (api.onListChange) api.onListChange();
    },
    drafts() { return Object.values(draftCache).map(r => r.def); },

    onListChange: null,   // menu hooks this to refresh map buttons

    init() {
      openDb(() => loadStores(() => {
        // one-time migration: any localStorage draft IndexedDB doesn't know
        for (const [id, def] of Object.entries(loadDraftStore())) {
          if (!draftCache[id]) {
            draftCache[id] = { def: clone(def), t: 0 };
            idbPut({ key: 'draft:' + id, id, def: draftCache[id].def, t: 0 });
          }
        }
        for (const r of Object.values(draftCache)) api.register(r.def);
        // autosave-only maps (crash before the first save) stay visible too
        for (const id of Object.keys(autoCache)) {
          if (!draftCache[id]) api.register(autoCache[id].def);
        }
        // deployed maps (https only — fetch fails silently from file://)
        fetch('maps/index.json')
          .then(r => r.json())
          .then(list => Promise.all(list.map(u => fetch(u).then(r => r.json()))))
          .then(defs => defs.forEach(d => {
            deployedIds.add(d.id);
            if (!draftCache[d.id]) api.register(d);   // a local edit wins
          }))
          .catch(() => {});
      }));
    },
  };
  return api;
})();
