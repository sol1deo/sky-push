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
    smg:       { file: 'j', len: 0.38 },
    longshot:  { file: 'e', len: 0.72 },
    magnum:    { file: 'a', len: 0.42, flip: true },
    mega:      { file: 'f', len: 0.60 },
    lobber:    { file: 'm', len: 0.46, flip: true },
    hookgun:   { file: 'n', len: 0.38 },   // pronged front = hook launcher, native -Z
    burst:     { file: 'p', len: 0.54 },
    boomstick: { file: 'q', len: 0.50 },
    bouncer:   { file: 'r', len: 0.40 },
    quad:      { file: 'o', len: 0.36 },
    piston:    { file: 'h', len: 0.42 },
    grenade1:  { file: 'grenade1', len: 0.16 },
    grenade2:  { file: 'grenade2', len: 0.16 },
  };
  const TEX_NAMES = ['concrete', 'metal', 'panel', 'hazard', 'grass', 'dirt', 'sand',
    'stone', 'rock', 'brick', 'planks', 'tiles', 'snow', 'lava', 'grid'];
  const PROP_NAMES = ['Prop_Crate', 'Prop_Crate_Large', 'Prop_Crate_Tarp', 'Prop_Barrel1',
    'Prop_Barrel2_Closed', 'Prop_Locker', 'Prop_SatelliteDish', 'Prop_Shelves_WideTall',
    'Prop_Shelves_ThinTall', 'Prop_Mine', 'Prop_HealthPack', 'Prop_Ammo_Closed', 'Prop_Chest'];
  // extra Blaster-Kit set for the editor's built-in library (self-contained GLBs)
  const KIT_NAMES = ['crate-small', 'crate-medium', 'crate-wide',
    'target-small', 'target-large', 'target-detail', 'smoke'];

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

  const weapons = {};     // kind -> normalized template Group (cloned per use)
  const props = {};       // name -> template Group
  const texImgs = {};     // name -> HTMLImageElement (decoded, ready)
  const texCache = {};    // name|repeat -> THREE.Texture
  const cast = {};        // file -> { root, clips, height, tint }
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

  function loadWeapons(done) {
    const kinds = Object.keys(WEAPON_FIT);
    let pending = kinds.length;
    for (const kind of kinds) {
      const file = WEAPON_FIT[kind].file || kind;
      gl().load('assets/models/weapons/' + file + '.glb', (g) => {
        try { weapons[kind] = normalizeWeapon(kind, g.scene || g.scenes[0]); } catch (e) {}
        if (--pending === 0 && done) done();
      }, undefined, () => { if (--pending === 0 && done) done(); });
    }
  }

  function loadChars() {
    let pending = CAST.length;
    const settle = () => { if (--pending === 0) groupDone(); };
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

  function loadProps() {
    let pending = PROP_NAMES.length + KIT_NAMES.length;
    const settle = () => { if (--pending === 0) groupDone(); };
    const store = (name) => (g) => {
      const root = g.scene || g.scenes[0];
      root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      props[name] = root;
      settle();
    };
    for (const name of PROP_NAMES) {
      gl().load('assets/models/props/' + name + '.gltf', store(name), undefined, settle);
    }
    for (const name of KIT_NAMES) {
      gl().load('assets/models/kit/' + name + '.glb', store(name), undefined, settle);
    }
  }

  function loadTextures() {
    let pending = TEX_NAMES.length;
    const settle = () => { if (--pending === 0) groupDone(); };
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

    init() {
      if (!canLoad || !window.THREE || !THREE.GLTFLoader) return;
      try {
        loadTextures();
        loadWeapons(groupDone);
        loadChars();
        loadProps();
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
    hasProp(name) { return !!props[name]; },
    prop(name) {
      const t = props[name];
      return t ? t.clone(true) : null;
    },
    propNames() { return PROP_NAMES.concat(KIT_NAMES); },
  };
  return api;
})();
