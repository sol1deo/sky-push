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

  /* per-weapon fit: how a Kenney blaster GLB maps onto the procedural gun's
     frame (-Z barrel, grip near origin). len = target length in units;
     flip = model's muzzle points +Z natively (measured per model). */
  const WEAPON_FIT = {
    pistol:   { len: 0.30 },
    blaster:  { len: 0.52, flip: true },
    scatter:  { len: 0.50 },
    smg:      { len: 0.38 },
    longshot: { len: 0.72 },
    magnum:   { len: 0.42, flip: true },
    mega:     { len: 0.60 },
    lobber:   { len: 0.44 },
    hookgun:  { len: 0.34 },
    grenade1: { len: 0.16 },
    grenade2: { len: 0.16 },
  };
  const TEX_NAMES = ['concrete', 'metal', 'panel', 'hazard', 'grass', 'dirt', 'sand',
    'stone', 'rock', 'brick', 'planks', 'tiles', 'snow', 'lava', 'grid'];
  const PROP_NAMES = ['Prop_Crate', 'Prop_Crate_Large', 'Prop_Crate_Tarp', 'Prop_Barrel1',
    'Prop_Barrel2_Closed', 'Prop_Locker', 'Prop_SatelliteDish', 'Prop_Shelves_WideTall',
    'Prop_Shelves_ThinTall', 'Prop_Mine', 'Prop_HealthPack', 'Prop_Ammo_Closed', 'Prop_Chest'];

  const weapons = {};     // kind -> normalized template Group (cloned per use)
  const props = {};       // name -> template Group
  const texImgs = {};     // name -> HTMLImageElement (decoded, ready)
  const texCache = {};    // name|repeat -> THREE.Texture
  const chars = {};       // m/f -> { root(SkinnedMesh scene), height }
  let clips = null;       // THREE.AnimationClip[]
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
      gl().load('assets/models/weapons/' + kind + '.glb', (g) => {
        try { weapons[kind] = normalizeWeapon(kind, g.scene || g.scenes[0]); } catch (e) {}
        if (--pending === 0 && done) done();
      }, undefined, () => { if (--pending === 0 && done) done(); });
    }
  }

  function loadChars() {
    let pending = 3;
    const settle = () => { if (--pending === 0) groupDone(); };
    const prep = (key) => (g) => {
      const root = g.scene || g.scenes[0];
      root.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
        if (o.isMesh && o.material) {
          // stylized look: kill PBR response. The BODY drops its skin texture
          // entirely — avatars ship as solid player-color "hero figures"
          // (the base-character skin texture reads as undressed otherwise).
          const src = o.material;
          const isBody = (src.name || '').toLowerCase().includes('superhero');
          const m = new THREE.MeshLambertMaterial({
            map: isBody ? null : (src.map || null),
            color: isBody ? 0xc8ccd6 : (src.color ? src.color.clone() : 0xffffff),
          });
          m.name = src.name || '';
          o.material = m;
        }
      });
      const box = new THREE.Box3().setFromObject(root);
      chars[key] = { root, height: Math.max(0.1, box.max.y - box.min.y) };
      settle();
    };
    gl().load('assets/models/chars/hero_m.gltf', prep('m'), undefined, settle);
    gl().load('assets/models/chars/hero_f.gltf', prep('f'), undefined, settle);
    gl().load('assets/models/chars/anims.glb', (g) => { clips = g.animations || []; settle(); },
      undefined, settle);
  }

  function loadProps() {
    let pending = PROP_NAMES.length;
    const settle = () => { if (--pending === 0) groupDone(); };
    for (const name of PROP_NAMES) {
      gl().load('assets/models/props/' + name + '.gltf', (g) => {
        const root = g.scene || g.scenes[0];
        root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        props[name] = root;
        settle();
      }, undefined, settle);
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
    charReady() { return !!(clips && clips.length && (chars.m || chars.f)); },
    /* hash-stable pick; clone with skeleton bindings intact */
    charInstance(h) {
      if (!api.charReady()) return null;
      const key = chars.m && chars.f ? (h % 2 ? 'f' : 'm') : (chars.m ? 'm' : 'f');
      const t = chars[key];
      const root = THREE.SkeletonUtils.clone(t.root);
      // clone materials so per-player tinting doesn't leak between avatars
      root.traverse((o) => { if (o.isMesh && o.material) o.material = o.material.clone(); });
      return { root, height: t.height, key };
    },
    clip(name) {
      if (!clips) return null;
      for (const c of clips) if (c.name === name) return c;
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
    propNames() { return PROP_NAMES.slice(); },
  };
  return api;
})();
