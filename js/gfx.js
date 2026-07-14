/* =============================================================================
 * SKY PUSH — real asset library (models / textures), build 26+
 * Loads the CC0 asset pack from assets/ on https hosts:
 *   - weapons:   Kenney Blaster Kit GLBs (assets/models/weapons/*.glb)
 *   - characters:Quaternius Universal Base Characters + Animation Library
 *   - props:     Quaternius Sci-Fi Essentials (assets/models/props/*.gltf)
 *   - textures:  stylized tileables (assets/tex/*.jpg)
 * On file:// fetch is blocked, so everything silently degrades to the old
 * procedural look — same pattern as the deployed-maps fetch in mapdata.js.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.GFX = (function () {
  const canLoad = /^https?:$/.test(location.protocol);

  /* per-weapon fit: which Blaster-Kit model (file) each weapon uses and how
     it maps onto the procedural gun's frame (-Z barrel, grip near origin).
     len = target length in units; flip = muzzle points +Z natively
     (measured per model — see the calibration grid workflow). */
  const WEAPON_FIT = {
    pistol:    { file: 'b', len: 0.32 },
    // 'd' = classic carbine silhouette; native muzzle already at -Z.
    // (A sign error in the old calibration page had this flipped — the
    // user-facing symptom was "the rifle points at me".)
    blaster:   { file: 'd', len: 0.52 },
    scatter:   { file: 'g', len: 0.50 },
    seeker:    { file: 'g', len: 0.55 },   // IT tag gun — chunky shotgun look
    smg:       { file: 'j', len: 0.38 },
    longshot:  { file: 'e', len: 0.72 },
    // back to the kitbashed revolver (user liked it after all) — v2 welds
    // every part into its neighbor so nothing floats
    magnum:    { build: 'revolver', len: 0.36 },
    minigun:   { build: 'minigun', len: 0.64 },
    flamer:    { build: 'flamer', len: 0.52 },
    mega:      { file: 'f', len: 0.60 },
    lobber:    { file: 'm', len: 0.46 },
    hookgun:   { file: 'n', len: 0.38 },   // pronged front = hook launcher, native -Z
    burst:     { file: 'p', len: 0.54 },
    boomstick: { file: 'q', len: 0.50 },
    bouncer:   { file: 'r', len: 0.40 },
    quad:      { file: 'o', len: 0.36 },
    piston:    { file: 'l', len: 0.46 },
    cannon:    { file: 'h', len: 0.44 },   // the Q air-cannon's left-hand tube
    grenade1:  { file: 'grenade1', len: 0.16 },
    grenade2:  { file: 'grenade2', len: 0.16 },
  };
  const TEX_NAMES = ['concrete', 'metal', 'panel', 'hazard', 'grass', 'grass2', 'grass3',
    'dirt', 'sand', 'stone', 'rock', 'brick', 'planks', 'tiles', 'snow', 'lava', 'grid',
    'crane', 'plywood', 'leather', 'balloon', 'marble', 'carpet', 'circuit', 'camo',
    'gravel', 'cliff', 'scree', 'mossrock',
    'glass', 'office', 'windows', 'facade'];
  const PROP_NAMES = ['Prop_Crate', 'Prop_Crate_Large', 'Prop_Crate_Tarp', 'Prop_Barrel1',
    'Prop_Barrel2_Closed', 'Prop_Locker', 'Prop_SatelliteDish', 'Prop_Shelves_WideTall',
    'Prop_Shelves_ThinTall', 'Prop_Mine', 'Prop_HealthPack', 'Prop_Ammo_Closed', 'Prop_Chest'];
  // extra built-in library models: Blaster-Kit crates/targets + Quaternius cars
  const KIT_NAMES = ['crate-small', 'crate-medium', 'crate-wide',
    'target-small', 'target-large', 'target-detail', 'smoke',
    'car-taxi', 'car-sports', 'car-suv', 'car-police'];
  // Kenney Building Kit — walls / windows / doors / stairs (folder: build/)
  const BUILD_NAMES = ['wall', 'wall-window-square-detailed', 'wall-window-round-detailed',
    'wall-window-wide-square-detailed', 'wall-doorway-square', 'wall-doorway-wide-round',
    'door-rotate-square-a', 'door-rotate-round-a', 'barricade-window-a', 'barricade-doorway-a',
    'stairs-open', 'stairs-closed', 'column', 'column-wide', 'floor', 'roof-flat-square',
    'detail-pipe'];
  // Kenney City Kit Commercial — whole buildings + street details (folder: city/)
  const CITY_NAMES = ['building-a', 'building-c', 'building-e', 'building-g',
    'building-skyscraper-a', 'building-skyscraper-c', 'detail-awning-wide',
    'detail-parasol-a', 'detail-overhang'];
  // Majadroid construction site (CC0, FBX->GLB w/ palette texture): cranes,
  // material piles, containers, machines (folder: site/)
  const SITE_NAMES = ['crane-tower', 'crane-ground',
    'planks-a', 'planks-b', 'planks-c', 'planks-blue', 'planks-yellow',
    'box-stack', 'box-black', 'box-white', 'barrel',
    'container-red', 'container-blue', 'container-green', 'container-small',
    'cargo-blue', 'cargo-white', 'office-green', 'office-red', 'office-stack',
    'porta-potty', 'truck-concrete', 'truck-concrete-red', 'truck-dumper',
    'truck-dumper-green', 'truck-small', 'truck-flatbed', 'site-fence', 'drive-ramp'];
  // Kenney Furniture Kit — interiors (folder: furn/, self-contained GLBs)
  const FURN_NAMES = ['table', 'tableRound', 'tableCoffee', 'chair', 'chairDesk',
    'loungeSofa', 'loungeSofaCorner', 'loungeChair', 'bedDouble', 'bedSingle',
    'bookcaseOpen', 'bookcaseClosedWide', 'desk', 'kitchenCabinet', 'kitchenFridge',
    'kitchenStove', 'kitchenBar', 'televisionModern', 'cabinetTelevision',
    'lampSquareFloor', 'lampRoundFloor', 'pottedPlant', 'rugRectangle', 'toilet',
    'bathtub', 'trashcan', 'cardboardBoxClosed', 'ceilingFan', 'stoolBar', 'washer',
    'stairs', 'wallDoorway', 'wallWindow', 'wall'];
  // Kenney Modular Buildings — house/tower shells + pieces (folder: mod/)
  const MOD_NAMES = ['building-sample-house-a', 'building-sample-house-b',
    'building-sample-house-c', 'building-sample-tower-a', 'building-sample-tower-b',
    'building-sample-tower-c', 'building-block', 'building-door', 'building-window',
    'building-window-awnings', 'building-steps-wide', 'building-corner'];
  // Kenney Nature Kit — trees/bushes/rocks/paths/fences (folder: nature/,
  // self-contained GLBs; the kit is a miniature 1-unit grid -> ×4)
  const NATURE_NAMES = ['tree_default', 'tree_oak', 'tree_detailed', 'tree_fat',
    'tree_simple', 'tree_tall', 'tree_thin', 'tree_small', 'tree_blocks', 'tree_cone',
    'tree_plateau', 'tree_default_fall', 'tree_oak_fall', 'tree_pineDefaultA',
    'tree_pineTallA', 'tree_pineTallB', 'tree_pineRoundA', 'tree_pineRoundC',
    'tree_pineSmallA', 'tree_palm', 'tree_palmTall', 'tree_palmShort', 'tree_palmBend',
    'tree_palmDetailedTall', 'plant_bush', 'plant_bushDetailed', 'plant_bushLarge',
    'plant_bushSmall', 'grass', 'grass_large', 'flower_purpleA', 'flower_redA',
    'flower_yellowA', 'mushroom_red', 'rock_largeA', 'rock_largeC', 'rock_tallA',
    'rock_tallD', 'rock_smallA', 'rock_smallD', 'stone_largeA', 'stone_tallB',
    'stump_round', 'stump_square', 'log', 'log_large', 'log_stack',
    'ground_pathStraight', 'ground_pathBend', 'ground_pathCross', 'ground_pathTile',
    'ground_pathRocks', 'fence_simple', 'fence_planks', 'fence_gate', 'fence_bend',
    'bridge_wood', 'bridge_stone', 'bridge_stoneRound', 'statue_column', 'statue_head',
    'statue_obelisk', 'statue_block', 'campfire_logs', 'campfire_stones', 'sign',
    'pot_large', 'canoe', 'cactus_short', 'cactus_tall',
    // full cliff system + every rock/stone/river piece from the kit
    'cliff_blockCave_rock', 'cliff_blockCave_stone', 'cliff_blockDiagonal_rock', 'cliff_blockDiagonal_stone',
    'cliff_blockHalf_rock', 'cliff_blockHalf_stone', 'cliff_blockQuarter_rock', 'cliff_blockQuarter_stone',
    'cliff_blockSlopeHalfWalls_rock', 'cliff_blockSlopeHalfWalls_stone', 'cliff_blockSlopeWalls_rock', 'cliff_blockSlopeWalls_stone',
    'cliff_blockSlope_rock', 'cliff_blockSlope_stone', 'cliff_block_rock', 'cliff_block_stone',
    'cliff_cave_rock', 'cliff_cave_stone', 'cliff_cornerInnerLarge_rock', 'cliff_cornerInnerLarge_stone',
    'cliff_cornerInnerTop_rock', 'cliff_cornerInnerTop_stone', 'cliff_cornerInner_rock', 'cliff_cornerInner_stone',
    'cliff_cornerLarge_rock', 'cliff_cornerLarge_stone', 'cliff_cornerTop_rock', 'cliff_cornerTop_stone',
    'cliff_corner_rock', 'cliff_corner_stone', 'cliff_diagonal_rock', 'cliff_diagonal_stone',
    'cliff_halfCornerInner_rock', 'cliff_halfCornerInner_stone', 'cliff_halfCorner_rock', 'cliff_halfCorner_stone',
    'cliff_half_rock', 'cliff_half_stone', 'cliff_large_rock', 'cliff_large_stone',
    'cliff_rock', 'cliff_stepsCornerInner_rock', 'cliff_stepsCornerInner_stone', 'cliff_stepsCorner_rock',
    'cliff_stepsCorner_stone', 'cliff_steps_rock', 'cliff_steps_stone', 'cliff_stone',
    'cliff_topDiagonal_rock', 'cliff_topDiagonal_stone', 'cliff_top_rock', 'cliff_top_stone',
    'cliff_waterfallTop_rock', 'cliff_waterfallTop_stone', 'cliff_waterfall_rock', 'cliff_waterfall_stone',
    'crops_bambooStageA', 'crops_bambooStageB', 'ground_riverBend', 'ground_riverCorner',
    'ground_riverCross', 'ground_riverRocks', 'ground_riverStraight', 'path_stone',
    'path_stoneCircle', 'rock_largeB', 'rock_largeD', 'rock_largeE',
    'rock_largeF', 'rock_smallB', 'rock_smallC', 'rock_smallE',
    'rock_smallF', 'rock_smallFlatA', 'rock_smallFlatB', 'rock_smallFlatC',
    'rock_smallG', 'rock_smallH', 'rock_smallI', 'rock_smallTopA',
    'rock_smallTopB', 'rock_tallB', 'rock_tallC', 'rock_tallE',
    'rock_tallF', 'rock_tallG', 'rock_tallH', 'rock_tallI',
    'rock_tallJ', 'stone_largeB', 'stone_largeC', 'stone_largeD',
    'stone_largeE', 'stone_largeF', 'stone_smallA', 'stone_smallB',
    'stone_smallC', 'stone_smallD', 'stone_smallE', 'stone_smallF',
    'stone_smallFlatA', 'stone_smallFlatB', 'stone_smallFlatC', 'stone_smallG',
    'stone_smallH', 'stone_smallI', 'stone_smallTopA', 'stone_smallTopB',
    'stone_tallA', 'stone_tallC', 'stone_tallD', 'stone_tallE',
    'stone_tallF', 'stone_tallG', 'stone_tallH', 'stone_tallI',
    'stone_tallJ'];
  // Kenney Pirate Kit — ships (walkable decks!), palms, sea props (folder: pirate/)
  const PIRATE_NAMES = ['ship-pirate-large', 'ship-pirate-medium', 'ship-pirate-small',
    'ship-large', 'ship-medium', 'ship-small', 'ship-ghost', 'ship-wreck',
    'boat-row-large', 'boat-row-small', 'palm-straight', 'palm-bend',
    'palm-detailed-straight', 'palm-detailed-bend', 'barrel', 'chest', 'crate',
    'crate-bottles', 'bottle', 'bottle-large', 'cannon', 'cannon-mobile', 'cannon-ball',
    'flag-pirate', 'flag-pirate-high', 'mast-ropes', 'structure-platform',
    'structure-platform-dock', 'structure-platform-small', 'tower-complete-small',
    'tower-watch', 'rocks-a', 'rocks-sand-a', 'rocks-sand-c', 'patch-sand',
    'patch-sand-foliage', 'hole', 'tool-paddle'];
  // Kenney Watercraft Pack — modern boats, yachts & big ships (folder: boats/)
  const BOAT_NAMES = ['boat-speed-a', 'boat-speed-c', 'boat-speed-e', 'boat-speed-g',
    'boat-sail-a', 'boat-sail-b', 'boat-fishing-small', 'boat-house-a', 'boat-house-c',
    'boat-tug-a', 'boat-fan', 'ship-cargo-a', 'ship-cargo-b', 'ship-large', 'ship-small',
    'ship-ocean-liner', 'ship-ocean-liner-small', 'buoy', 'buoy-flag',
    'cargo-container-a', 'cargo-pile-a'];
  // Kenney City Kit Roads — roads/pavement/street lights (folder: roads/, ×4)
  const ROAD_NAMES = ['road-straight', 'road-bend', 'road-curve', 'road-crossroad',
    'road-intersection', 'road-crossing', 'road-end', 'road-roundabout', 'road-side',
    'road-straight-half', 'road-curve-pavement', 'road-bend-sidewalk', 'road-square',
    'tile-low', 'tile-high', 'tile-slant', 'bridge-pillar', 'light-curved',
    'light-square', 'light-curved-double', 'construction-barrier', 'construction-cone'];
  // Kenney Survival Kit — camp/beach props (folder: camp/, ×4)
  const CAMP_NAMES = ['tent', 'tent-canvas', 'structure-canvas', 'campfire-pit',
    'campfire-stand', 'campfire-fishing-stand', 'bedroll', 'bedroll-packed', 'box',
    'box-large', 'box-open', 'bucket', 'barrel-open', 'resource-planks',
    'resource-wood', 'resource-stone', 'metal-panel', 'floor-old', 'fence-fortified',
    'tool-axe', 'tool-pickaxe'];
  // new packs load generically; prefixes keep the flat prop registry
  // collision-free ('ship-large' exists in pirate AND watercraft). lambert:
  // swap PBR materials for Lambert — untextured Standard colors wash out
  // pastel under ACES (the mint-tree bug); same fix the characters use.
  const EXTRA_PACKS = [
    { dir: 'nature', prefix: 'nat-', names: NATURE_NAMES, folder: 'nature', scale: 4, lambert: true },
    { dir: 'pirate', prefix: 'pir-', names: PIRATE_NAMES, folder: 'pirate sea', scale: 1, lambert: true },
    { dir: 'boats', prefix: 'sea-', names: BOAT_NAMES, folder: 'boats & ships', scale: 1, lambert: true },
    { dir: 'roads', prefix: 'rd-', names: ROAD_NAMES, folder: 'roads & park', scale: 4, lambert: true },
    { dir: 'camp', prefix: 'camp-', names: CAMP_NAMES, folder: 'camping', scale: 4, lambert: true },
  ];

  /* toy-style character cast (Quaternius UACP) — each GLB carries its own
     17 animation clips. tint = the "main outfit" material recolored to the
     player color for team identity. */
  const CAST = [
    { file: 'BlueSoldier_Male', tint: 'Main' },
    { file: 'BlueSoldier_Female', tint: 'Main' },
    { file: 'Casual_Male', tint: 'Shirt' },
    { file: 'Casual_Female', tint: 'Shirt' },
    { file: 'Ninja_Male', tint: 'Main' },
    { file: 'Cowboy_Female', tint: 'Jacket' },
    { file: 'Worker_Male', tint: 'Vest' },
    { file: 'Chef_Male', tint: 'Clothes' },
    { file: 'Pirate_Female', tint: 'Clothes' },
    { file: 'Suit_Male', tint: 'Black' },
  ];

  // Quaternius sea creatures (CC0, poly.pizza GLBs) — some carry swim clips;
  // prop() clones them with SkeletonUtils and self-plays the animation
  const SEALIFE_NAMES = ['shark', 'fish-a', 'fish-b', 'fish-c', 'dolphin',
    'whale', 'mantaray', 'squidle'];
  const SEALIFE_SCALE = { whale: 1, squidle: 1 };   // filled after calibration

  const weapons = {};     // kind -> normalized template Group (cloned per use)
  const props = {};       // name -> template Group
  const texImgs = {};     // name -> HTMLImageElement (decoded, ready)
  const texCache = {};    // name|repeat -> THREE.Texture
  const cast = {};        // file -> { root, clips, height, tint }
  const sealife = {};     // name -> { root, clips }
  let loader = null;

  // onReady fires ONCE when textures+weapons+characters have all settled
  // (menu rebuilds its background so the first impression isn't fallbacks)
  let groupsLeft = 4, readyFired = false;
  function groupDone() {
    if (--groupsLeft > 0 || readyFired) return;
    readyFired = true;
    api.ready = true;
    if (api.onReady) { try { api.onReady(); } catch (e) {} }
  }

  // per-item progress for the boot loading screen: every model/texture/
  // character counts once, success OR failure — the bar always reaches 100%
  let loadTotal = 0, loadDone = 0;
  function track(n) { loadTotal += n; }
  function tick() { loadDone++; }

  function gl() { return loader || (loader = new THREE.GLTFLoader()); }

  /* normalize a gun GLB: center, barrel along -Z, grip pulled to origin,
     length set per weapon, 'tip' marker at the muzzle. */
  function normalizeWeapon(kind, scene) {
    const inner = new THREE.Group();
    inner.add(scene);
    // every blaster's long axis is Z; a couple have the muzzle at +Z
    const fit0 = WEAPON_FIT[kind];
    if (fit0 && fit0.flip) inner.rotation.y = Math.PI;
    const grp = new THREE.Group();
    grp.add(inner);
    grp.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(grp);
    const size = box.getSize(new THREE.Vector3());
    const fit = WEAPON_FIT[kind] || { len: 0.5 };
    const k = fit.len / Math.max(1e-4, size.z);
    grp.scale.setScalar(k);
    grp.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(grp);
    const c = box2.getCenter(new THREE.Vector3());
    // center X, sit the grip zone near origin, muzzle toward -Z
    inner.position.x -= c.x / k;
    inner.position.y -= c.y / k;
    inner.position.z -= c.z / k;
    grp.updateMatrixWorld(true);
    const box3 = new THREE.Box3().setFromObject(grp);
    const tip = new THREE.Object3D();
    tip.name = 'tip';
    tip.position.set(0, 0.02, box3.min.z - 0.01);
    grp.add(tip);
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    return grp;
  }

  /* ---- kitbashed weapons: assembled from raw Blaster-Kit pieces so new
     archetypes (revolver / minigun / flamethrower) stay 100% in the kit's
     style. Every part is cloned, scaled, then recentered by bbox onto its
     slot — raw kit GLBs all have different origins. ---- */
  const PART_FILES = ['sil-s', 'sil-l', 'clip-l', 'scope-a', 'c', 'k'];
  const rawParts = {};
  const _pbb = new THREE.Box3();
  const _pc = new THREE.Vector3();
  function partPut(g, f, sx, sy, sz, x, y, z, rx, ry, rz) {
    const w = new THREE.Group();
    const m = rawParts[f].clone(true);
    w.add(m);
    m.scale.set(sx, sy, sz);
    if (rx) m.rotation.x = rx;
    if (ry) m.rotation.y = ry;
    if (rz) m.rotation.z = rz;
    w.updateMatrixWorld(true);
    _pbb.setFromObject(w);
    _pbb.getCenter(_pc);
    m.position.sub(_pc);
    w.position.set(x, y, z);
    g.add(w);
    return w;
  }
  const KITBASH = {
    /* classic six-shooter v2 — every part OVERLAPS its neighbor (v1 read as
       floating pieces): barrel butts into the drum, the strap lies on both,
       hammer sinks into the drum's rear, grip tucks under it */
    revolver() {
      const g = new THREE.Group();
      partPut(g, 'sil-s', 0.62, 0.62, 1.05, 0, 0.05, -0.155);        // barrel
      partPut(g, 'scope-a', 0.42, 0.36, 0.52, 0, 0.088, -0.06);      // top strap
      partPut(g, 'sil-l', 1.0, 1.0, 0.45, 0, 0.04, 0.02);            // cylinder drum
      partPut(g, 'sil-s', 0.3, 0.3, 0.35, 0, 0.07, 0.105, -0.6);     // hammer
      partPut(g, 'clip-l', 0.75, 0.7, 0.8, 0, -0.04, 0.075, 0.5);    // grip
      return g;
    },
    /* rotary cannon: chunky 'k' receiver + 5-barrel cluster + ammo box */
    minigun() {
      const g = new THREE.Group();
      partPut(g, 'k', 1, 1, 0.95, 0, 0, 0.10);                       // receiver
      partPut(g, 'sil-l', 0.95, 0.95, 0.55, 0, 0.115, -0.20);        // hub
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.3;
        partPut(g, 'sil-s', 0.42, 0.42, 1.9,
          Math.cos(a) * 0.05, 0.115 + Math.sin(a) * 0.05, -0.42);    // barrels
      }
      partPut(g, 'sil-s', 0.28, 0.28, 2.1, 0, 0.115, -0.43);         // center shaft
      partPut(g, 'clip-l', 1.2, 1.05, 1.35, 0, -0.145, 0.16);        // ammo box
      return g;
    },
    /* flamethrower: 'c' body + fat nozzle + propane tank riding on top */
    flamer() {
      const g = new THREE.Group();
      partPut(g, 'c', 1, 1, 1, 0, 0, 0.05);                          // body
      partPut(g, 'sil-l', 0.85, 0.85, 0.85, 0, 0.075, -0.30);        // nozzle
      partPut(g, 'sil-s', 0.48, 0.48, 0.55, 0, 0.075, -0.425);       // tip
      partPut(g, 'sil-l', 1.35, 1.35, 0.75, 0, 0.235, 0.13);         // tank
      partPut(g, 'sil-s', 0.5, 0.5, 0.4, 0, 0.235, 0.255);           // tank valve
      return g;
    },
  };
  function composeKitbashed() {
    for (const kind of Object.keys(WEAPON_FIT)) {
      const fit = WEAPON_FIT[kind];
      if (!fit.build || !KITBASH[fit.build]) continue;
      if (PART_FILES.some(f => !rawParts[f])) continue;   // a part failed to load
      try { weapons[kind] = normalizeWeapon(kind, KITBASH[fit.build]()); } catch (e) {}
    }
  }

  function loadWeapons(done) {
    const kinds = Object.keys(WEAPON_FIT).filter(k => !WEAPON_FIT[k].build);
    let pending = kinds.length + PART_FILES.length;
    track(pending);
    const settle = () => {
      tick();
      if (--pending === 0) { composeKitbashed(); if (done) done(); }
    };
    for (const f of PART_FILES) {
      gl().load('assets/models/weapons/' + f + '.glb', (g) => {
        rawParts[f] = g.scene || g.scenes[0];
        settle();
      }, undefined, settle);
    }
    for (const kind of kinds) {
      const file = WEAPON_FIT[kind].file || kind;
      gl().load('assets/models/weapons/' + file + '.glb', (g) => {
        try { weapons[kind] = normalizeWeapon(kind, g.scene || g.scenes[0]); } catch (e) {}
        settle();
      }, undefined, settle);
    }
  }

  function loadChars() {
    let pending = CAST.length;
    track(pending);
    const settle = () => { tick(); if (--pending === 0) groupDone(); };
    for (const entry of CAST) {
      gl().load('assets/models/chars/cast/' + entry.file + '.glb', (g) => {
        const root = g.scene || g.scenes[0];
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.frustumCulled = false;
          if (o.material) {
            // materials are flat colors — swap PBR for cheap Lambert
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const conv = mats.map((src) => {
              const m = new THREE.MeshLambertMaterial({
                color: src.color ? src.color.clone() : 0xffffff,
              });
              m.name = src.name || '';
              return m;
            });
            o.material = Array.isArray(o.material) ? conv : conv[0];
          }
        });
        const box = new THREE.Box3().setFromObject(root);
        cast[entry.file] = {
          root, clips: g.animations || [], tint: entry.tint,
          height: Math.max(0.1, box.max.y - box.min.y),
        };
        settle();
      }, undefined, settle);
    }
  }

  // native-size fixes baked into the template (wrapped one level deep so the
  // editor's per-prop scale still composes instead of overwriting it):
  // the crane is a real 48m tower, Kenney modular buildings are dollhouse
  // scale, furniture reads small next to the chunky toon characters
  const PACK_SCALE = { 'crane-tower': 0.35, 'crane-ground': 0.35, 'site-fence': 0.15 };
  for (const n of MOD_NAMES) PACK_SCALE[n] = 5;
  for (const n of FURN_NAMES) PACK_SCALE[n] = 1.4;

  function loadProps() {
    let pending = PROP_NAMES.length + KIT_NAMES.length + BUILD_NAMES.length +
      CITY_NAMES.length + SITE_NAMES.length + FURN_NAMES.length + MOD_NAMES.length;
    for (const p of EXTRA_PACKS) pending += p.names.length;
    track(pending);
    const settle = () => { tick(); if (--pending === 0) groupDone(); };
    const store = (name, scale, lambert) => (g) => {
      let root = g.scene || g.scenes[0];
      const k = scale !== undefined ? scale : PACK_SCALE[name];
      if (k && k !== 1) {
        const inner = new THREE.Group();
        inner.scale.setScalar(k);
        inner.add(root);
        const wrap = new THREE.Group();
        wrap.add(inner);
        root = wrap;
      }
      const lambertCache = {};
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (lambert) {
          // flat-color kits: PBR-without-envmap washes the palette to pastel
          const conv = mats.map((src) => {
            const key = src.uuid;
            if (!lambertCache[key]) {
              const m = new THREE.MeshLambertMaterial({
                color: src.color ? src.color.clone() : 0xffffff,
              });
              if (src.map) m.map = src.map;
              // untextured factors are sRGB-authored (Asset Forge quirk) —
              // read as linear they wash out (the mint-tree bug); convert
              else m.color.convertSRGBToLinear();
              m.name = src.name || '';
              lambertCache[key] = m;
            }
            return lambertCache[key];
          });
          o.material = Array.isArray(o.material) ? conv : conv[0];
          return;
        }
        // guard against metallic-black imports (no env map in this renderer)
        for (const m of mats) {
          if (m && m.metalness !== undefined && m.metalness > 0.3) {
            m.metalness = 0.1; m.roughness = Math.max(m.roughness || 0, 0.7);
          }
        }
      });
      props[name] = root;
      settle();
    };
    for (const name of PROP_NAMES) {
      gl().load('assets/models/props/' + name + '.gltf', store(name), undefined, settle);
    }
    for (const name of KIT_NAMES) {
      gl().load('assets/models/kit/' + name + '.glb', store(name), undefined, settle);
    }
    for (const name of BUILD_NAMES) {
      gl().load('assets/models/build/' + name + '.glb', store(name), undefined, settle);
    }
    for (const name of CITY_NAMES) {
      gl().load('assets/models/city/' + name + '.glb', store(name), undefined, settle);
    }
    for (const name of SITE_NAMES) {
      gl().load('assets/models/site/' + name + '.glb', store(name), undefined, settle);
    }
    for (const name of FURN_NAMES) {
      gl().load('assets/models/furn/' + name + '.glb', store(name), undefined, settle);
    }
    for (const name of MOD_NAMES) {
      gl().load('assets/models/mod/' + name + '.glb', store(name), undefined, settle);
    }
    for (const p of EXTRA_PACKS) {
      for (const name of p.names) {
        gl().load('assets/models/' + p.dir + '/' + name + '.glb',
          store(p.prefix + name, p.scale, p.lambert), undefined, settle);
      }
    }
  }

  /* sea creatures: keep root + clips (skinned — cloned via SkeletonUtils) */
  function loadSealife() {
    track(SEALIFE_NAMES.length);
    for (const name of SEALIFE_NAMES) {
      gl().load('assets/models/sealife/' + name + '.glb', (g) => {
        const root = g.scene || g.scenes[0];
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.frustumCulled = false;
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const conv = mats.map((src) => {
              const m = new THREE.MeshLambertMaterial({
                color: src.color ? src.color.clone() : 0xffffff,
              });
              if (src.map) m.map = src.map;
              m.name = src.name || '';
              return m;
            });
            o.material = Array.isArray(o.material) ? conv : conv[0];
          }
        });
        sealife[name] = { root, clips: g.animations || [] };
        tick();
      }, undefined, tick);
    }
  }

  /* an animated, self-driving clone of a sea creature (or null) */
  function creatureInstance(name) {
    const t = sealife[name];
    if (!t) return null;
    const root = THREE.SkeletonUtils ? THREE.SkeletonUtils.clone(t.root) : t.root.clone(true);
    const wrap = new THREE.Group();
    const inner = new THREE.Group();
    const k = SEALIFE_SCALE[name] || 1;
    if (k !== 1) inner.scale.setScalar(k);
    inner.add(root);
    wrap.add(inner);
    if (t.clips.length) {
      const mixer = new THREE.AnimationMixer(root);
      const clip = t.clips.find(c => /swim|move|idle/i.test(c.name)) || t.clips[0];
      mixer.clipAction(clip).play();
      let last = 0;
      let m = null;
      root.traverse((o) => { if (!m && o.isMesh) m = o; });
      if (m) {
        m.onBeforeRender = () => {
          const now = performance.now();
          mixer.update(Math.min(0.1, last ? (now - last) / 1000 : 0.016));
          last = now;
        };
      }
      wrap.userData.mixer = mixer;
    }
    return wrap;
  }

  function loadTextures() {
    let pending = TEX_NAMES.length;
    track(pending);
    const settle = () => { tick(); if (--pending === 0) groupDone(); };
    for (const name of TEX_NAMES) {
      const img = new Image();
      img.onload = () => { texImgs[name] = img; settle(); };
      img.onerror = settle;
      img.src = 'assets/tex/' + name + '.jpg';
    }
  }

  const api = {
    canLoad,
    ready: false,    // true once textures+weapons+characters settle
    onReady: null,   // fired once at that moment
    /* boot loading screen: fraction of tracked assets that have settled */
    progress() { return { done: loadDone, total: loadTotal }; },

    init() {
      if (!canLoad || !window.THREE || !THREE.GLTFLoader) return;
      try {
        loadTextures();
        loadWeapons(groupDone);
        loadChars();
        loadProps();
        loadSealife();
      } catch (e) {}
    },

    /* ---- weapons ---- */
    hasWeapon(kind) { return !!weapons[kind]; },
    weapon(kind) {
      const t = weapons[kind];
      return t ? t.clone(true) : null;
    },

    /* ---- characters ---- */
    charReady() { return Object.keys(cast).length >= 3; },
    /* hash-stable pick (or an explicit character key, e.g. the LOCKER pick);
       clone with skeleton bindings intact */
    charInstance(h, key) {
      if (!api.charReady()) return null;
      if (key && cast[key]) {
        const t = cast[key];
        const root = THREE.SkeletonUtils.clone(t.root);
        root.traverse((o) => {
          if (o.isMesh && o.material) {
            o.material = Array.isArray(o.material)
              ? o.material.map((m) => m.clone()) : o.material.clone();
          }
        });
        return { root, clips: t.clips, tint: t.tint, height: t.height, key };
      }
      // deterministic across clients: index into the FULL cast list, then
      // walk forward to the nearest loaded entry
      for (let i = 0; i < CAST.length; i++) {
        const entry = CAST[(h + i) % CAST.length];
        const t = cast[entry.file];
        if (!t) continue;
        const root = THREE.SkeletonUtils.clone(t.root);
        // clone materials so per-player tinting doesn't leak between avatars
        root.traverse((o) => {
          if (o.isMesh && o.material) {
            o.material = Array.isArray(o.material)
              ? o.material.map((m) => m.clone()) : o.material.clone();
          }
        });
        return { root, clips: t.clips, tint: t.tint, height: t.height, key: entry.file };
      }
      return null;
    },

    /* ---- textures ---- */
    texImage(name) { return texImgs[name] || null; },
    texture(name, repeat) {
      const img = texImgs[name];
      if (!img) return null;
      const key = name + '|' + (repeat || 1);
      if (texCache[key]) return texCache[key];
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      tex.encoding = THREE.sRGBEncoding;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat || 1, repeat || 1);
      tex.anisotropy = 4;
      texCache[key] = tex;
      return tex;
    },

    /* ---- props ---- */
    hasProp(name) {
      if (name.indexOf('life-') === 0) return !!sealife[name.slice(5)];
      return !!props[name];
    },
    prop(name) {
      if (name.indexOf('life-') === 0) return creatureInstance(name.slice(5));
      const t = props[name];
      return t ? t.clone(true) : null;
    },
    propNames() {
      let out = PROP_NAMES.concat(KIT_NAMES, BUILD_NAMES, CITY_NAMES,
        SITE_NAMES, FURN_NAMES, MOD_NAMES);
      for (const p of EXTRA_PACKS) out = out.concat(p.names.map(n => p.prefix + n));
      out = out.concat(SEALIFE_NAMES.map(n => 'life-' + n));
      return out;
    },
    /* editor asset-panel folder for a pack prop */
    propFolder(name) {
      if (name.indexOf('life-') === 0) return 'sea life';
      // the cliff/rock system is big enough to deserve its own drawer
      if (/^nat-(cliff|rock|stone)_/.test(name)) return 'cliffs & rocks';
      for (const p of EXTRA_PACKS) {
        if (name.indexOf(p.prefix) === 0) return p.folder;
      }
      if (SITE_NAMES.indexOf(name) >= 0) return 'construction';
      if (FURN_NAMES.indexOf(name) >= 0) return 'interior';
      if (MOD_NAMES.indexOf(name) >= 0) return 'buildings';
      return 'pack';
    },
  };
  return api;
})();
