/* =============================================================================
 * SKY PUSH — asset library (the editor's "project" panel)
 * Drag GLB models / images into the game and use them in maps:
 *   - assets live in IndexedDB ('skypush-assets'), organized in folders
 *   - the editor's ASSETS panel shows thumbnails; drag one into the viewport
 *     to place a prop (model) or texture the block under the cursor (image)
 *   - when a map USES an asset, the payload is embedded into the map def
 *     (def.assets) so exported/hosted maps stay fully self-contained
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Assets = (function () {
  const DB = 'skypush-assets', STORE = 'assets';
  let db = null;
  let items = [];          // [{id, folder, name, type:'model'|'image', data, thumb}]
  const parsedCache = {};  // assetId -> parsed THREE scene (template for cloning)

  function openDb(then) {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = (e) => { db = e.target.result; then && then(); };
      req.onerror = () => then && then();
    } catch (e) { then && then(); }
  }
  function loadAll(then) {
    if (!db) { then && then(); return; }
    try {
      db.transaction(STORE, 'readonly').objectStore(STORE).getAll().onsuccess = (e) => {
        items = e.target.result || [];
        then && then();
      };
    } catch (e) { then && then(); }
  }
  function persist(a) {
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(a); } catch (e) {}
  }
  function unpersist(id) {
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); } catch (e) {}
  }

  /* ---------- base64 <-> ArrayBuffer (GLB payloads in map defs) ---------- */
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /* ---------- GLB parsing (template cached, callers get clones) ---------- */
  function parseModel(id, b64, cb) {
    if (parsedCache[id]) { cb(parsedCache[id].clone(true)); return; }
    if (!THREE.GLTFLoader) { cb(null); return; }
    try {
      new THREE.GLTFLoader().parse(b64ToBuf(b64), '', (gltf) => {
        const root = gltf.scene || gltf.scenes[0];
        root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        parsedCache[id] = root;
        cb(root.clone(true));
      }, () => cb(null));
    } catch (e) { cb(null); }
  }

  /* ---------- thumbnails ---------- */
  let rig = null;
  function thumbFromObject(obj) {
    try {
      if (!rig) {
        const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        r.setSize(96, 96); r.setPixelRatio(1);
        r.outputEncoding = THREE.sRGBEncoding;
        const sc = new THREE.Scene();
        sc.add(new THREE.HemisphereLight(0xe8f0ff, 0x3a4150, 1.2));
        const key = new THREE.DirectionalLight(0xffffff, 1.4);
        key.position.set(1.5, 2, 1.2);
        sc.add(key);
        rig = { r, sc, cam: new THREE.PerspectiveCamera(32, 1, 0.01, 100) };
      }
      const box = new THREE.Box3().setFromObject(obj);
      const c = box.getCenter(new THREE.Vector3());
      const size = Math.max(0.001, box.getSize(new THREE.Vector3()).length());
      const grp = new THREE.Group();
      obj.position.sub(c);
      grp.add(obj);
      grp.rotation.y = 0.7;
      rig.sc.add(grp);
      rig.cam.position.set(0, size * 0.25, size * 1.15);
      rig.cam.lookAt(0, 0, 0);
      rig.r.render(rig.sc, rig.cam);
      const url = rig.r.domElement.toDataURL();
      rig.sc.remove(grp);
      return url;
    } catch (e) { return null; }
  }

  /* built-in LIGHT / ATMOSPHERE decor — code-built groups referenced as
     'fx:<name>'. Real lights (Unity/UE-style entities), dreamy godrays and
     animated fog. Each instance is configurable via the prop's `fx` object
     (color / intensity / size…), edited in the prop inspector. */
  const FX_DEFS = [
    { id: 'fx:pointlight', name: 'point light' },
    { id: 'fx:spot',       name: 'spot light' },
    { id: 'fx:lamp',       name: 'street lamp' },
    { id: 'fx:neonbar',    name: 'neon bar' },
    { id: 'fx:godray',     name: 'godray' },
    { id: 'fx:shaft',      name: 'light shaft' },
    { id: 'fx:groundfog',  name: 'ground fog' },
    { id: 'fx:haze',       name: 'haze' },
    { id: 'fx:airvent',    name: 'air vent', folder: 'gadgets' },
    { id: 'fx:sea',        name: 'sea (real waves)', folder: 'water' },
    { id: 'fx:tsunami',    name: 'EVENT · tsunami', folder: 'water' },
    { id: 'fx:triangle',   name: 'EVENT · bermuda triangle', folder: 'water' },
    { id: 'fx:kraken',     name: 'EVENT · kraken attack', folder: 'water' },
    { id: 'fx:shark',      name: 'EVENT · shark patrol', folder: 'water' },
    { id: 'fx:blizzard',   name: 'EVENT · blizzard wind', folder: 'winter & holiday' },
    { id: 'fx:quake',      name: 'EVENT · structure quake', folder: 'gadgets' },
    { id: 'fx:collapse',   name: 'EVENT · collapse (blocks fall)', folder: 'gadgets' },
    { id: 'fx:mountain',   name: 'mountain (backdrop)', folder: 'cliffs & rocks' },
    { id: 'fx:school',     name: 'fish school (swims)', folder: 'sea life' },
    { id: 'fx:sharkpatrol', name: 'shark — ambient swimmer', folder: 'sea life' },
    { id: 'fx:monster',    name: 'sea monster (animated)', folder: 'sea life' },
    { id: 'fx:whale',      name: 'whale — cruises around', folder: 'sea life' },
    { id: 'fx:dolphin',    name: 'dolphin — swims laps', folder: 'sea life' },
    { id: 'fx:manta',      name: 'manta ray — glides', folder: 'sea life' },
    { id: 'fx:coral',      name: 'coral cluster', folder: 'sea decor' },
    { id: 'fx:kelp',       name: 'kelp (sways)', folder: 'sea decor' },
    { id: 'fx:seagrass',   name: 'seagrass patch', folder: 'sea decor' },
    { id: 'fx:rope',       name: 'hanging rope', folder: 'gadgets' },
    { id: 'fx:pumpjack',   name: 'oil pump (nodding)', folder: 'oil rig' },
    { id: 'fx:derrick',    name: 'drill derrick tower', folder: 'oil rig' },
    { id: 'fx:flare',      name: 'gas flare stack (burns)', folder: 'oil rig' },
    { id: 'fx:oiltank',    name: 'rusty storage tank', folder: 'oil rig' },
    { id: 'fx:plane',      name: 'prop plane', folder: 'aviation' },
    { id: 'fx:planewreck', name: 'crashed plane', folder: 'aviation' },
    { id: 'fx:heli',       name: 'helicopter (rotors spin)', folder: 'aviation' },
    { id: 'fx:jet',        name: 'airliner jet', folder: 'aviation' },
    { id: 'fx:helipad',    name: 'helipad', folder: 'aviation' },
    { id: 'fx:runway',     name: 'runway strip', folder: 'aviation' },
    { id: 'fx:tower',      name: 'control tower', folder: 'aviation' },
    { id: 'fx:hangar',     name: 'hangar', folder: 'aviation' },
  ];
  /* per-type option defaults (merged with the prop's fx settings) */
  const FX_OPTS = {
    pointlight: { color: '#ffd9a0', power: 1.3, range: 15 },
    spot:       { color: '#fff2cc', power: 1.8, range: 20 },
    lamp:       { color: '#ffe0b0', power: 1.15, range: 13 },
    neonbar:    { color: '#40c8ff', power: 0.9, range: 10 },
    godray:     { color: '#fff2cc', alpha: 0.16, width: 3.5, height: 12 },
    shaft:      { color: '#fff2cc', alpha: 0.09, width: 3, height: 16 },
    groundfog:  { color: '#cfd8e6', alpha: 0.16, size: 10 },
    haze:       { color: '#dde6f2', alpha: 0.1, size: 9 },
    // roof updraft: power = lift force, range = column height (m)
    airvent:    { color: '#9fd8ff', power: 40, range: 10 },
    // WATER v3 — vertex-animated swells + real translucency.
    //   power = wave height · range = wave length · size = side length
    //   deepAlpha/shallowAlpha + shallow tint + fade = the depth look
    //   drag/gravity/speed/jumpOut = swim feel (pawn physics reads these)
    //   foam = shoreline foam strength · foamw = foam band width (m of depth)
    //   shorewave = rolling shore-surge height (waves that lap the beach)
    //   storm = 0-1 chaos dial (bigger swell + chop + rogue wave trains)
    //   crestcol = wave-top/foam tint (night maps hated the locked white)
    sea:        { color: '#155a9e', power: 0.5, range: 18, size: 140,
                  deepAlpha: 0.9, shallowAlpha: 0.32, shallow: '#5fd8cf', fade: 10,
                  foam: 0.7, foamw: 3, shorewave: 0.5,
                  storm: 0, crestcol: '#eef6ff',
                  drag: 1.7, gravity: 0.12, speed: 0.65, jumpOut: 1,
                  oxygen: 12, currents: 10, currentPower: 26 },
    // SEA EVENTS — invisible markers in-game; the event system in map.js
    // fires them off the synced round clock. Shared knobs:
    //   start = seconds into the round · every = repeat period ·
    //   dur = active seconds · chance = % roll per cycle (deterministic)
    // tsunami: power = push force, height = wave height, range = travel
    // distance (it starts range/2 BEHIND the marker, moving along its facing),
    // size = wave width
    tsunami:    { color: '#bfe9ff', power: 30, height: 7, range: 160, size: 60,
                  start: 45, every: 60, dur: 8, chance: 100 },
    // bermuda triangle: power = pull, size = radius
    triangle:   { color: '#4dffd0', power: 20, size: 10,
                  start: 30, every: 45, dur: 8, chance: 60 },
    // kraken: power = slam knock, size = tentacle ring radius
    kraken:     { color: '#8a5fd8', power: 24, size: 8,
                  start: 60, every: 70, dur: 9, chance: 100 },
    // shark: power = bite knock, size = patrol circle radius
    shark:      { color: '#d8e4ee', power: 16, size: 11,
                  start: 20, every: 35, dur: 12, chance: 100 },
    // blizzard: heavy wind along the marker's facing — power = push force
    // (airborne players catch the full blast; snowfall thickens while it blows)
    blizzard:   { color: '#dfe9ff', power: 30,
                  start: 30, every: 50, dur: 9, chance: 100 },
    // quake: everything within SIZE sways/shudders, periodic jolts throw
    // players (power = jolt force). collapse: blocks within SIZE shake loose
    // and REALLY fall, nearest to the marker first — build the breakable
    // part of a structure out of BLOCKS and plant this inside it
    quake:      { color: '#d8b45a', power: 26, size: 30,
                  start: 40, every: 55, dur: 10, chance: 100 },
    collapse:   { color: '#ff7a4a', size: 24,
                  start: 60, every: 90, dur: 8, chance: 60 },
    // BACKDROP MOUNTAIN — seeded low-poly massif for valley skylines.
    //   size = base radius · height = peak height · peaks = extra summits ·
    //   seed = variation roll · snow = snowline (0 none … 1 fully capped)
    mountain:   { color: '#8a8f9c', size: 60, height: 55, peaks: 3, seed: 1, snow: 0.5, detail: 2 },
    // SEA LIFE — real Quaternius creatures (swim clips play on their own).
    // school: size = circle radius, count = fish, speed = swim pace
    school:     { color: '#8fd8ff', size: 8, count: 10, speed: 1 },
    sharkpatrol: { color: '#9fb6c8', size: 10, speed: 1 },
    monster:    { color: '#b98fe0', speed: 1 },
    whale:      { color: '#7d95ac', size: 18, speed: 1 },
    dolphin:    { color: '#9fc4d8', size: 12, speed: 1 },
    manta:      { color: '#6a7f96', size: 10, speed: 1 },
    // sea decor: size = footprint radius, count = pieces, seed = variation
    coral:      { color: '#ff7aa8', size: 3, count: 7, seed: 1 },
    kelp:       { color: '#3fa065', size: 2.5, count: 8, seed: 1, height: 6 },
    seagrass:   { color: '#57b878', size: 3, count: 26, seed: 1 },
    rope:       { color: '#d8c49a', range: 8, sway: 1 },   // range = length (m); sway 0 = dead straight
    plane:      { color: '#d0483e' },
    planewreck: { color: '#8a92a0' },
    // oil rig: power = animation speed (pumpjack) / flame flicker (flare),
    // range = tower/stack height, size = tank radius
    pumpjack:   { color: '#8a4f2c', power: 1 },
    derrick:    { color: '#6d5142', range: 14 },
    flare:      { color: '#7c6a58', range: 11, power: 1 },
    oiltank:    { color: '#7c4a2a', size: 3.4, range: 4.6 },
    heli:       { color: '#d0483e' },
    jet:        { color: '#f2f4f6' },
    helipad:    { color: '#2c3140', size: 4.5 },           // size = pad radius
    runway:     { color: '#343945', range: 60, size: 11 }, // range = length, size = width
    tower:      { color: '#c8ccd4' },
    hangar:     { color: '#7a8494', size: 6, range: 14 },  // size = arch radius, range = depth
  };

  function buildFx(name, fx) {
    const o = { ...(FX_OPTS[name] || {}), ...(fx || {}) };
    const col = new THREE.Color(o.color || '#ffffff');
    const g = new THREE.Group();
    const lam = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e || 0x000000 });
    /* editor-only gizmo marker — hidden when the map is played */
    const marker = (geom, c) => {
      const m = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
        color: c, wireframe: true, transparent: true, opacity: 0.7,
      }));
      m.name = 'edmarker';
      return m;
    };

    if (name === 'pointlight') {
      const light = new THREE.PointLight(col, o.power, o.range);
      light.position.y = 0.5;
      const mk = marker(new THREE.SphereGeometry(0.3, 8, 6), col);
      mk.position.y = 0.5;
      g.add(light, mk);
    } else if (name === 'spot') {
      // aims down its local -Y: rotate the prop to steer the beam
      const light = new THREE.SpotLight(col, o.power, o.range, 0.55, 0.6);
      light.position.y = 0.4;
      const tgt = new THREE.Object3D();
      tgt.position.set(0, -4, 0);
      light.target = tgt;
      const mk = marker(new THREE.ConeGeometry(0.35, 0.7, 8), col);
      mk.position.y = 0.4;
      g.add(light, tgt, mk);
    } else if (name === 'lamp') {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.2, 8), lam(0x2c3140));
      pole.position.y = 1.6;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.12), lam(0x2c3140));
      arm.position.set(0.38, 3.2, 0);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8),
        lam(col, col.clone().multiplyScalar(0.85)));
      bulb.position.set(0.75, 3.1, 0);
      const light = new THREE.PointLight(col, o.power, o.range);
      light.position.copy(bulb.position);
      g.add(pole, arm, bulb, light);
    } else if (name === 'neonbar') {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.09, 0.09),
        lam(col, col.clone().multiplyScalar(0.75)));
      bar.position.y = 0.05;
      const light = new THREE.PointLight(col, o.power, o.range);
      light.position.y = 0.4;
      g.add(bar, light);
    } else if (name === 'godray') {
      // dreamy volumetric fake: soft cone + crossed WIDE soft planes + pool
      const w = o.width, h = o.height;
      const coneMat = new THREE.MeshBasicMaterial({
        map: SKY.U.softShaftTexture(), color: col, transparent: true,
        opacity: o.alpha, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const cone = new THREE.Mesh(
        new THREE.CylinderGeometry(w * 0.22, w * 0.75, h, 14, 1, true), coneMat);
      cone.position.y = h / 2;
      g.add(cone);
      for (let i = 0; i < 3; i++) {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.5, h), coneMat.clone());
        plane.material.opacity = o.alpha * 0.7;
        plane.position.y = h / 2;
        plane.rotation.y = i * Math.PI / 3;
        g.add(plane);
      }
      const pool = new THREE.Mesh(new THREE.CircleGeometry(w * 0.9, 18),
        new THREE.MeshBasicMaterial({
          map: SKY.U.blobTexture(), color: col, transparent: true,
          opacity: o.alpha * 1.2, blending: THREE.AdditiveBlending,
          depthWrite: false, fog: false,
        }));
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 0.06;
      g.add(pool);
    } else if (name === 'shaft') {
      // the ORIGINAL thin cinematic rays — crossed narrow streak planes
      const w = o.width, h = o.height;
      for (let i = 0; i < 2; i++) {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
          new THREE.MeshBasicMaterial({
            map: SKY.U.shaftTexture(), color: col, transparent: true,
            opacity: o.alpha, blending: THREE.AdditiveBlending,
            depthWrite: false, side: THREE.DoubleSide, fog: false,
          }));
        plane.position.y = h / 2;
        plane.rotation.y = i * Math.PI / 2;
        g.add(plane);
      }
    } else if (name === 'groundfog' || name === 'haze') {
      // HORIZONTAL soft planes (billboards clipped through floors = ugly
      // hard lines); ground fog drifts on its own via onBeforeRender
      const size = o.size;
      const animated = name === 'groundfog';
      const n = animated ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.MeshBasicMaterial({
            map: SKY.U.blobTexture(), color: col, transparent: true,
            opacity: o.alpha * (1 - i / (n + 2)), depthWrite: false,
          }));
        plane.rotation.x = -Math.PI / 2;
        plane.rotation.z = Math.random() * Math.PI;
        const y0 = animated ? 0.25 + i * 0.28 : 0.6 + i * 0.7;
        plane.position.set(SKY.U.rand(-1.5, 1.5), y0, SKY.U.rand(-1.5, 1.5));
        if (animated) {
          const phase = Math.random() * Math.PI * 2;
          const rad = SKY.U.rand(0.8, 2);
          const bx = plane.position.x, bz = plane.position.z;
          plane.onBeforeRender = () => {
            const t = performance.now() * 0.00012 + phase;
            plane.position.x = bx + Math.cos(t) * rad;
            plane.position.z = bz + Math.sin(t * 0.8) * rad;
            plane.rotation.z += 0.00012;
          };
        }
        g.add(plane);
      }
    } else if (name === 'airvent') {
      // big roof vent: pawns crossing the column get dragged UP (map.js
      // registers the updraft zone; power = force, range = column height)
      const metal = lam(0x6a7382);
      const dark = lam(0x2c3140);
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.9, 2.7), metal);
      base.position.y = 0.45;
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.2, 0.5, 16), dark);
      ring.position.y = 1.05;
      g.add(base, ring);
      const fan = new THREE.Group();
      fan.position.y = 1.12;
      for (let i = 0; i < 4; i++) {
        const holder = new THREE.Group();
        holder.rotation.y = i * Math.PI / 2;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.05, 0.34), lam(0x9aa4b2));
        blade.position.x = 0.52;
        blade.rotation.x = 0.55;              // blade pitch
        holder.add(blade);
        fan.add(holder);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10), dark);
      // driver mesh must NEVER be culled (a culled hub froze the spin while
      // the blades stayed visible) + wall-clock rotation (frame-increment
      // spun slower at low fps and stopped whenever callbacks skipped)
      hub.frustumCulled = false;
      hub.onBeforeRender = () => { fan.rotation.y = performance.now() * 0.0192; };
      fan.add(hub);
      g.add(fan);
      // grate bars over the fan
      for (let i = -1; i <= 1; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.05, 0.09), metal);
        bar.position.set(0, 1.34, i * 0.7);
        g.add(bar);
      }
      // editor-only gizmo: the updraft column
      const mk = marker(new THREE.CylinderGeometry(1.35, 1.35, o.range, 12, 1, true), col);
      mk.position.y = o.range / 2 + 1.3;
      g.add(mk);
    } else if (name === 'sea') {
      // WATER v3: vertex-animated swells + per-vertex COLOR (foam crests) +
      // real translucency. A per-vertex `adeep` attribute (0 = shallow,
      // 1 = deep — measured against whatever is UNDER the surface once the
      // prop is placed) drives a shallow tint + shallow transparency, and a
      // fresnel term makes grazing angles glassier — the water finally reads
      // as water instead of a blue tarp.
      const size = Math.max(20, o.size);
      // v4: double the mesh density AND ditch per-frame computeVertexNormals
      // for ANALYTIC normals (wave derivatives) — the old combo shaded every
      // 3m facet flat-ish, which read as "triangles, way too lowpoly"
      const segs = SKY.U.clamp(Math.round(size / 2), 32, 96);
      const geo = new THREE.PlaneGeometry(size, size, segs, segs);
      geo.rotateX(-Math.PI / 2);
      const basePos = geo.attributes.position.array.slice();
      geo.setAttribute('color', new THREE.BufferAttribute(
        new Float32Array(geo.attributes.position.count * 3), 3));
      const adeep = new Float32Array(geo.attributes.position.count).fill(1);
      geo.setAttribute('adeep', new THREE.BufferAttribute(adeep, 1));
      const base = col.clone().convertSRGBToLinear();
      const deep = base.clone().multiplyScalar(0.35);
      // crest/foam colors are CREATOR-TINTABLE (white tops glowed wrong on
      // night maps) — default keeps the classic near-white look
      const crestFoam = new THREE.Color(o.crestcol || '#eef6ff').convertSRGBToLinear();
      const crest = base.clone().lerp(crestFoam, 0.35);
      const foam = crestFoam.clone();
      const shallowCol = new THREE.Color(o.shallow || '#5fd8cf').convertSRGBToLinear();
      const aDeep = SKY.U.clamp(o.deepAlpha !== undefined ? o.deepAlpha : 0.9, 0.05, 0.98);
      const aShallow = SKY.U.clamp(o.shallowAlpha !== undefined ? o.shallowAlpha : 0.35, 0.02, 0.98);
      const mat = new THREE.MeshPhongMaterial({
        color: 0xffffff, vertexColors: true,
        shininess: 110, specular: 0x4a6a84,
        transparent: true, opacity: 1, depthWrite: false,
        side: THREE.DoubleSide,   // the surface must exist when seen from BELOW
      });
      // fade = meters of depth over which shallow turns into deep (also the
      // scale for the foam band width below — declared before the shader)
      const fade = Math.max(0.5, o.fade !== undefined ? o.fade : 10);
      // shoreline foam: strength / band width (in adeep units = meters/fade)
      const foamK = SKY.U.clamp(o.foam !== undefined ? o.foam : 0.7, 0, 1);
      const foamW = SKY.U.clamp((o.foamw !== undefined ? o.foamw : 3) / fade, 0.02, 1);
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uShallowCol = { value: shallowCol };
        sh.uniforms.uADeep = { value: aDeep };
        sh.uniforms.uAShallow = { value: aShallow };
        sh.uniforms.uFoam = { value: foamK };
        sh.uniforms.uFoamW = { value: foamW };
        sh.uniforms.uFoamCol = { value: crestFoam };
        sh.uniforms.uTime = { value: 0 };
        mat.userData.sh = sh;                    // onBeforeRender ticks uTime
        sh.vertexShader = 'attribute float adeep;\nvarying float vDeep;\nvarying vec3 vWp;\n' +
          sh.vertexShader.replace('#include <begin_vertex>',
            '#include <begin_vertex>\nvDeep = adeep;\n' +
            'vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = ('uniform vec3 uShallowCol;\nuniform float uADeep;\n' +
          'uniform float uAShallow;\nuniform float uFoam;\nuniform float uFoamW;\n' +
          'uniform vec3 uFoamCol;\nuniform float uTime;\nvarying float vDeep;\nvarying vec3 vWp;\n') +
          sh.fragmentShader
            .replace('#include <color_fragment>',
              ['#include <color_fragment>',
               // smoothstep = a real IN-BETWEEN band (linear saturated too fast)
               'float dk = clamp(vDeep, 0.0, 1.0);',
               'dk = dk * dk * (3.0 - 2.0 * dk);',
               // shallows: lighter tint AND clearer water
               'diffuseColor.rgb = mix(uShallowCol * diffuseColor.rgb * 1.9, diffuseColor.rgb, dk);',
               // deep water swallows light: the abyss reads DARK from above,
               // not like a crisp seabed behind blue glass
               'diffuseColor.rgb *= mix(1.0, 0.62, dk);',
               'diffuseColor.a = mix(uAShallow, uADeep, dk);',
               // ---- SHORE FOAM: the waterline used to be a hard blue cutoff.
               // DISCRETE wash lines ride the depth contours (phase = vDeep),
               // wrap around islands and march toward the beach; fizz sparkle
               // lives ON the lines (free-running speckle read as wallpaper).
               'float dkRaw = clamp(vDeep, 0.0, 1.0);',
               'float shoreK = uFoam * pow(1.0 - smoothstep(0.0, uFoamW, dkRaw), 1.6);',
               'if (shoreK > 0.003) {',
               '  float wash = smoothstep(0.55, 0.95, 0.5 + 0.5 * sin(vDeep * 30.0 - uTime * 2.6));',
               '  float wash2 = smoothstep(0.62, 0.97, 0.5 + 0.5 * sin(vDeep * 52.0 - uTime * 4.1 + 1.7));',
               '  float fizz = sin(vWp.x * 9.1 + uTime * 3.4) * sin(vWp.z * 8.3 - uTime * 2.9)',
               '             * sin((vWp.x + vWp.z) * 5.7 + uTime * 4.6);',
               '  fizz = 0.55 + 0.45 * smoothstep(0.0, 0.8, fizz);',
               '  float foamAmt = clamp(shoreK * (wash + wash2 * 0.6) * fizz, 0.0, 1.0);',
               '  // the very waterline keeps a solid lapping edge',
               '  float line = 1.0 - smoothstep(0.0, 0.2 * uFoamW, dkRaw);',
               '  foamAmt = max(foamAmt, uFoam * line * (0.7 + 0.3 * fizz));',
               '  diffuseColor.rgb = mix(diffuseColor.rgb, uFoamCol, foamAmt);',
               '  diffuseColor.a = clamp(diffuseColor.a + foamAmt * 0.55, 0.0, 0.96);',
               '}'].join('\n'))
            .replace('#include <output_fragment>',
              [// fresnel: grazing angles pick up a soft sky sheen and go a bit
               // more solid; steep look-down stays clear (kept SUBTLE — the
               // strong version read as a field of snow from across the map)
               'float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normalize(normal)), 0.0, 1.0), 3.5);',
               'outgoingLight += vec3(0.22, 0.38, 0.55) * fres * 0.28;',
               'diffuseColor.a = clamp(diffuseColor.a + fres * 0.18, 0.0, 0.94);',
               '#include <output_fragment>'].join('\n'));
      };
      const sea = new THREE.Mesh(geo, mat);
      sea.receiveShadow = true;
      sea.renderOrder = 2;   // draw after the seabed so blending reads right
      const amp = Math.max(0.01, o.power);
      const kw = (Math.PI * 2) / Math.max(4, o.range);
      // shore surge: rolling swells whose crests follow the depth contours
      // (phase rides adeep), marching toward the beach and dying on it
      const shoreAmp = Math.max(0, o.shorewave !== undefined ? o.shorewave : 0.5);
      // STORM dial: bigger swell + short chop + traveling ROGUE WAVE trains.
      // World.surfaceAt MIRRORS every open-sea term here (same constants) so
      // the camera's underwater check tracks the storm surface — change one,
      // change both.
      const storm = SKY.U.clamp(o.storm || 0, 0, 1);
      const stormMul = 1 + storm * 2.2;
      const RGX = 0.8321, RGZ = 0.5547;          // rogue travel direction
      const RL = 110, RW = 9;                    // train spacing / swell width
      const rogueH = storm * (1.5 + amp * 1.8);  // meters
      const pos = geo.attributes.position;
      const nrmA = geo.attributes.normal;
      const colA = geo.attributes.color;
      const _c = new THREE.Color();
      sea.onBeforeRender = () => {
        const t = performance.now() * 0.0009;
        if (mat.userData.sh) mat.userData.sh.uniforms.uTime.value = t;
        const a = pos.array, nA = nrmA.array, c = colA.array;
        for (let i = 0; i < pos.count; i++) {
          const x = basePos[i * 3], z = basePos[i * 3 + 2];
          // base swell — sin AND cos per term: the cos terms are the exact
          // surface gradient, which becomes the smooth analytic normal
          const p1 = x * kw + t * 1.9, p2 = z * kw * 0.8 + t * 1.4;
          const p3 = (x + z) * kw * 0.45 - t * 2.3;
          const p4x = x * kw * 2.3 - t * 3.1, p4z = z * kw * 2.1 + t * 2.6;
          const s4x = Math.sin(p4x), s4z = Math.sin(p4z);
          let h = Math.sin(p1) * 0.55 + Math.sin(p2) * 0.3 +
                  Math.sin(p3) * 0.35 + s4x * s4z * 0.14;
          let dhx = (Math.cos(p1) * 0.55 + Math.cos(p3) * 0.1575) * kw +
                    Math.cos(p4x) * s4z * 0.322 * kw;
          let dhz = (Math.cos(p2) * 0.24 + Math.cos(p3) * 0.1575) * kw +
                    s4x * Math.cos(p4z) * 0.294 * kw;
          if (storm > 0) {
            // chop: short, fast, angry
            const q1 = x * kw * 3.1 - t * 4.8, q2 = z * kw * 2.7 + t * 5.4;
            const q3 = (x - z) * kw * 1.9 - t * 6.2;
            h += storm * (Math.sin(q1) * 0.3 + Math.sin(q2) * 0.22 + Math.sin(q3) * 0.18);
            dhx += storm * (Math.cos(q1) * 0.93 + Math.cos(q3) * 0.342) * kw;
            dhz += storm * (Math.cos(q2) * 0.594 - Math.cos(q3) * 0.342) * kw;
          }
          const dkv = adeep[i];
          // shoaling: open-sea swell flattens as the water gets shallow —
          // the surface CALMS onto the beach instead of clipping through it
          const shoal = 0.4 + 0.6 * dkv;
          // surge band peaks mid-shallow, zero at the waterline + open sea
          const band = (1 - dkv) * Math.min(1, dkv / 0.3);
          const surge = shoreAmp * Math.sin(dkv * 8.0 - t * 2.3) * band;
          const dispAmp = amp * stormMul * shoal;
          let y = basePos[i * 3 + 1] + dispAmp * h + surge;
          let gx = dispAmp * dhx, gz = dispAmp * dhz;
          let rh = 0;
          if (rogueH > 0) {
            // rogue swell: a big lone wave marching across the whole sea
            const proj = x * RGX + z * RGZ;
            const su = ((proj - t * 10) % RL + RL) % RL - RL / 2;
            const pulse = Math.exp(-(su * su) / (RW * RW));
            rh = rogueH * pulse * shoal;
            y += rh;
            const dp = rh * (-2 * su / (RW * RW));
            gx += dp * RGX; gz += dp * RGZ;
          }
          a[i * 3 + 1] = y;
          // analytic normal = normalize(-dY/dx, 1, -dY/dz) — buttery smooth,
          // and worlds cheaper than recomputing face normals every frame
          const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
          nA[i * 3] = -gx * inv; nA[i * 3 + 1] = inv; nA[i * 3 + 2] = -gz * inv;
          // height -> hue: mostly the base blue; crests lift late, only the
          // very peaks break into foam — storms whitecap earlier, and the
          // rogue wave carries a foaming crown
          // storm widens the normalization window too — otherwise the chop
          // saturates k and the whole ocean whitecaps (the round-44 trap)
          const hCol = h + rh / Math.max(0.3, amp * stormMul);
          const k = SKY.U.clamp01((hCol + 1.2 + storm * 0.7) / (2.4 + storm * 1.4));
          const th1 = 0.66 - storm * 0.05, th2 = 0.88 - storm * 0.06;
          _c.copy(deep).lerp(base, Math.min(1, k * 1.7));
          if (k > th1) _c.lerp(crest, Math.min(1, (k - th1) / (1 - th1)));
          if (k > th2) _c.lerp(foam, Math.min(1, (k - th2) / (1 - th2)) * 0.9);
          c[i * 3] = _c.r; c[i * 3 + 1] = _c.g; c[i * 3 + 2] = _c.b;
        }
        pos.needsUpdate = true;
        nrmA.needsUpdate = true;
        colA.needsUpdate = true;
      };
      g.add(sea);
      // measure the seabed depth under every vertex ONCE the prop has its
      // world transform (map.js / the editor call this after placing)
      g.userData.postPlace = (obj) => {
        obj.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        const dirDown = new THREE.Vector3(0, -1, 0);
        for (let i = 0; i < pos.count; i++) {
          v.set(basePos[i * 3], 0, basePos[i * 3 + 2]);
          sea.localToWorld(v);
          v.y += 0.5;
          let depth = Infinity;
          const th = SKY.World.terrainHeight ? SKY.World.terrainHeight(v.x, v.z) : -Infinity;
          if (isFinite(th)) depth = (v.y - 0.5) - th;
          const hit = SKY.World.raycast(v, dirDown, Math.min(depth, fade + 2) + 0.5);
          if (hit) depth = Math.min(depth, hit.t - 0.5);
          adeep[i] = SKY.U.clamp01(depth / fade);
        }
        geo.attributes.adeep.needsUpdate = true;
      };
    } else if (name === 'rope') {
      // crane-style hanging rope: sagging tube + knot, swaying gently.
      // Hangs DOWN from where you place it — put it on a crane arm / mast.
      const len = Math.max(1, o.range);
      const swayG = new THREE.Group();
      const sag = (o.sway === undefined || o.sway) ? len * 0.035 : 0;   // straight when sway is off
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push(new THREE.Vector3(Math.sin(t * Math.PI) * sag, -t * len, 0));
      }
      const rope = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.04, 6),
        lam(col.clone().convertSRGBToLinear()));
      rope.castShadow = true;
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6),
        lam(new THREE.Color(col).multiplyScalar(0.7)));
      knot.position.y = -len;
      const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 8), lam(0x2c3140));
      swayG.add(rope, knot);
      g.add(swayG, mount);
      // sway 0 = a dead-straight static rope (creator toggle in the inspector)
      if (o.sway === undefined || o.sway) {
        const phase = Math.random() * Math.PI * 2;
        rope.onBeforeRender = () => {
          const t = performance.now() * 0.0007 + phase;
          swayG.rotation.z = Math.sin(t) * 0.055;
          swayG.rotation.x = Math.cos(t * 0.8) * 0.045;
        };
      }
    } else if (name === 'tsunami') {
      // editor-only marker: the wave wall footprint + a travel-direction arrow
      const mk = marker(new THREE.BoxGeometry(o.size || 60, o.height || 7, 1.6), col);
      mk.position.y = (o.height || 7) / 2;
      const arrow = marker(new THREE.ConeGeometry(0.8, 2.4, 8), col);
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(0, 1.2, -3.2);
      g.add(mk, arrow);
    } else if (name === 'quake' || name === 'collapse') {
      // editor-only marker: the danger radius + a jagged "crack" zigzag
      const r = o.size !== undefined ? o.size : (name === 'quake' ? 30 : 24);
      const mk = marker(new THREE.CylinderGeometry(r, r, 0.6, 24, 1, true), col);
      mk.position.y = 0.4;
      const zig = [];
      for (let i = 0; i <= 8; i++) {
        zig.push(new THREE.Vector3((i - 4) * r * 0.16, 0.5,
          (i % 2 ? 1 : -1) * r * 0.07));
      }
      const crack = new THREE.Line(new THREE.BufferGeometry().setFromPoints(zig),
        new THREE.LineBasicMaterial({ color: col }));
      crack.name = 'edmarker';
      g.add(mk, crack);
    } else if (name === 'blizzard') {
      // editor-only marker: swirling wind ring + a direction arrow (the wind
      // blows along the marker's facing — rotate the prop to aim the storm)
      const mk = marker(new THREE.TorusGeometry(2.2, 0.16, 8, 22), col);
      mk.rotation.x = -Math.PI / 2;
      mk.position.y = 1.2;
      const arrow = marker(new THREE.ConeGeometry(0.8, 2.4, 8), col);
      arrow.rotation.x = -Math.PI / 2;
      arrow.position.set(0, 1.2, -3.2);
      g.add(mk, arrow);
    } else if (name === 'triangle') {
      // a literal triangle ring, of course
      const mk = marker(new THREE.CylinderGeometry(o.size || 10, o.size || 10, 0.8, 3, 1, true), col);
      mk.position.y = 0.5;
      g.add(mk);
    } else if (name === 'kraken') {
      const mk = marker(new THREE.CylinderGeometry(o.size || 8, o.size || 8, 0.6, 12, 1, true), col);
      mk.position.y = 0.4;
      g.add(mk);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const tn = marker(new THREE.ConeGeometry(0.5, 4, 6), col);
        tn.position.set(Math.cos(a) * (o.size || 8) * 0.6, 2, Math.sin(a) * (o.size || 8) * 0.6);
        g.add(tn);
      }
    } else if (name === 'shark') {
      const mk = marker(new THREE.CylinderGeometry(o.size || 11, o.size || 11, 0.5, 20, 1, true), col);
      mk.position.y = 0.3;
      const fin = marker(new THREE.ConeGeometry(0.5, 1.4, 4), col);
      fin.position.set(o.size || 11, 1, 0);
      g.add(mk, fin);
    } else if (name === 'plane' || name === 'planewreck') {
      buildPlane(g, col.clone().convertSRGBToLinear(), name === 'planewreck');
    } else if (name === 'heli' || name === 'jet' || name === 'helipad' ||
               name === 'runway' || name === 'tower' || name === 'hangar') {
      buildAviation(name, g, col.clone().convertSRGBToLinear(), o);
    } else if (name === 'pumpjack' || name === 'derrick' || name === 'flare' ||
               name === 'oiltank') {
      buildOilRig(name, g, col.clone().convertSRGBToLinear(), o);
    } else if (name === 'school' || name === 'sharkpatrol' || name === 'monster' ||
               name === 'whale' || name === 'dolphin' || name === 'manta') {
      buildSeaLife(name, g, col.clone().convertSRGBToLinear(), o, marker);
    } else if (name === 'coral' || name === 'kelp' || name === 'seagrass') {
      buildSeaDecor(name, g, col.clone().convertSRGBToLinear(), o);
    } else if (name === 'mountain') {
      buildMountain(g, col.clone().convertSRGBToLinear(), o);
    }
    return g;
  }

  /* SEA DECOR — seeded procedural reef pieces in the pack's flat-color look.
     coral: mixed cluster (branching / tube / fan / brain), kelp: tall swaying
     strands, seagrass: a patch of crossed blades. All deterministic from
     `seed` so peers and thumbnails agree. */
  function buildSeaDecor(name, g, col, o) {
    const R = Math.max(0.5, o.size || 3);
    let st = ((o.seed !== undefined ? o.seed : 1) * 48271 + 7) | 0 || 1;
    const rnd = () => {
      st |= 0; st = (st + 0x6D2B79F5) | 0;
      let t = Math.imul(st ^ (st >>> 15), 1 | st);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const lam = (c, e) => new THREE.MeshLambertMaterial({
      color: c, emissive: e || 0x000000, side: THREE.DoubleSide });
    const PALETTE = [col,
      col.clone().offsetHSL(0.06, 0, 0.06),
      col.clone().offsetHSL(-0.08, 0.05, -0.04),
      new THREE.Color('#ffb066').convertSRGBToLinear(),
      new THREE.Color('#b98fe0').convertSRGBToLinear(),
      new THREE.Color('#5fd8cf').convertSRGBToLinear()];
    const mat = (i) => lam(PALETTE[i % PALETTE.length]);

    if (name === 'coral') {
      const n = SKY.U.clamp(Math.round(o.count || 7), 1, 16);
      for (let i = 0; i < n; i++) {
        const px = (rnd() * 2 - 1) * R, pz = (rnd() * 2 - 1) * R;
        const kind = rnd();
        const m = mat((rnd() * 6) | 0);
        const piece = new THREE.Group();
        if (kind < 0.35) {
          // branching coral: trunk + child sticks
          const s = 0.5 + rnd() * 0.8;
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * s, 0.09 * s, 0.9 * s, 5), m);
          trunk.position.y = 0.45 * s;
          piece.add(trunk);
          const nb = 3 + (rnd() * 4) | 0;
          for (let b = 0; b < nb; b++) {
            const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * s, 0.055 * s, (0.45 + rnd() * 0.4) * s, 5), m);
            br.position.y = (0.5 + rnd() * 0.45) * s;
            br.rotation.z = (rnd() - 0.5) * 1.6;
            br.rotation.x = (rnd() - 0.5) * 1.6;
            br.translateY(0.22 * s);
            piece.add(br);
          }
        } else if (kind < 0.6) {
          // tube coral: a fistful of hollow-ish tubes
          const s = 0.5 + rnd() * 0.7;
          const nt = 3 + (rnd() * 3) | 0;
          for (let tI = 0; tI < nt; tI++) {
            const h = (0.4 + rnd() * 0.6) * s;
            const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.13 * s, h, 6, 1, true), m);
            tube.position.set((rnd() - 0.5) * 0.4 * s, h / 2, (rnd() - 0.5) * 0.4 * s);
            tube.rotation.z = (rnd() - 0.5) * 0.5;
            piece.add(tube);
          }
        } else if (kind < 0.85) {
          // fan coral: a thin scalloped disc standing up
          const s = 0.6 + rnd() * 0.9;
          const fan = new THREE.Mesh(new THREE.CircleGeometry(0.55 * s, 9, 0, Math.PI), m);
          fan.position.y = 0.1;
          fan.rotation.y = rnd() * Math.PI;
          piece.add(fan);
        } else {
          // brain coral: a squashed sphere
          const s = 0.4 + rnd() * 0.5;
          const brain = new THREE.Mesh(new THREE.SphereGeometry(0.5 * s, 8, 6), m);
          brain.scale.y = 0.62;
          brain.position.y = 0.28 * s;
          piece.add(brain);
        }
        piece.position.set(px, 0, pz);
        piece.rotation.y = rnd() * Math.PI * 2;
        g.add(piece);
      }
    } else if (name === 'kelp') {
      const n = SKY.U.clamp(Math.round(o.count || 8), 1, 20);
      const H = Math.max(1.5, o.height || 6);
      const m = lam(col, col.clone().multiplyScalar(0.08));
      for (let i = 0; i < n; i++) {
        const strand = new THREE.Group();
        const h = H * (0.6 + rnd() * 0.5);
        const segs = 4;
        let holder = strand;
        const sway = [];
        for (let sI = 0; sI < segs; sI++) {
          const seg = new THREE.Group();
          seg.position.y = sI === 0 ? 0 : h / segs;
          const blade = new THREE.Mesh(
            new THREE.PlaneGeometry(0.22 + rnd() * 0.12, h / segs + 0.05), m);
          blade.position.y = h / segs / 2;
          seg.add(blade);
          holder.add(seg);
          holder = seg;
          sway.push(seg);
        }
        strand.position.set((rnd() * 2 - 1) * R, 0, (rnd() * 2 - 1) * R);
        strand.rotation.y = rnd() * Math.PI * 2;
        g.add(strand);
        const phase = rnd() * Math.PI * 2;
        sway[0].children[0].onBeforeRender = () => {
          const t = performance.now() * 0.0009 + phase;
          for (let sI = 0; sI < sway.length; sI++) {
            sway[sI].rotation.z = Math.sin(t + sI * 0.8) * 0.11;
            sway[sI].rotation.x = Math.cos(t * 0.8 + sI * 0.6) * 0.07;
          }
        };
      }
    } else {   // seagrass
      const n = SKY.U.clamp(Math.round(o.count || 26), 4, 60);
      const m = lam(col);
      for (let i = 0; i < n; i++) {
        const h = 0.35 + rnd() * 0.5;
        const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.09, h), m);
        blade.position.set((rnd() * 2 - 1) * R, h / 2, (rnd() * 2 - 1) * R);
        blade.rotation.y = rnd() * Math.PI;
        blade.rotation.z = (rnd() - 0.5) * 0.35;
        g.add(blade);
      }
    }
    g.traverse((oo) => { if (oo.isMesh) oo.castShadow = true; });
  }

  /* seeded backdrop mountain v2: fBm + ridged-noise displaced cones with a
     DETAIL dial (1 = cheap silhouette … 3 = craggy massif that holds up at
     size 200+), irregular bases, slope-aware coloring (steep = bare cliff,
     flats hold the snow, striated rock in between). Deterministic from
     `seed`, so every client builds the identical massif. */
  function buildMountain(g, col, o) {
    const R = Math.max(10, o.size || 60);
    const H = Math.max(8, o.height || 55);
    const peaks = SKY.U.clamp(Math.round(o.peaks !== undefined ? o.peaks : 3), 1, 6);
    const snowline = SKY.U.clamp(o.snow !== undefined ? o.snow : 0.5, 0, 1);
    const detail = SKY.U.clamp(Math.round(o.detail !== undefined ? o.detail : 2), 1, 3);
    const seed = (o.seed !== undefined ? o.seed : 1);
    // mulberry32 — per-peak placement rolls
    let st = (seed * 7919) | 0 || 1;
    const rnd = () => {
      st |= 0; st = (st + 0x6D2B79F5) | 0;
      let t = Math.imul(st ^ (st >>> 15), 1 | st);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // stateless value-noise fBm (position-stable, seed-shifted)
    const h2 = (x, y) => {
      const v = Math.sin(x * 127.1 + y * 311.7 + seed * 17.23) * 43758.5453;
      return v - Math.floor(v);
    };
    const vn = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const sx2 = fx * fx * (3 - 2 * fx), sy2 = fy * fy * (3 - 2 * fy);
      const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
      return a + (b - a) * sx2 + (c - a) * sy2 + (a - b - c + d) * sx2 * sy2;
    };
    const fbm = (x, y) => vn(x, y) * 0.55 + vn(x * 2.13, y * 2.13) * 0.27 + vn(x * 4.31, y * 4.31) * 0.18;
    const ridged = (x, y) => 1 - Math.abs(fbm(x, y) * 2 - 1);

    const snowCol = new THREE.Color(0.9, 0.93, 0.97);
    const cliffCol = col.clone().multiplyScalar(0.42);
    const _c = new THREE.Color();
    const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _nf = new THREE.Vector3();
    const radial = 18 + detail * 14;      // 32 / 46 / 60
    const rings = 5 + detail * 5;         // 10 / 15 / 20

    for (let pi = 0; pi < peaks; pi++) {
      const pr = pi === 0 ? R : R * (0.35 + rnd() * 0.4);
      const ph = pi === 0 ? H : H * (0.4 + rnd() * 0.45);
      const px = pi === 0 ? 0 : (rnd() - 0.5) * R * 1.7;
      const pz = pi === 0 ? 0 : (rnd() - 0.5) * R * 1.7;
      const so = pi * 7.31;               // per-peak noise domain shift
      const geo = new THREE.ConeGeometry(pr, ph, radial, rings).toNonIndexed();
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.array[i * 3], y = pos.array[i * 3 + 1], z = pos.array[i * 3 + 2];
        const rr = Math.hypot(x, z);
        if (rr < 0.01) continue;
        const a = Math.atan2(z, x);
        const t01 = (y + ph / 2) / ph;                        // 0 base .. 1 apex
        // sample noise on the cylinder (cos/sin domain = seam-free)
        const nx = Math.cos(a) * 1.7 + so, nz = Math.sin(a) * 1.7 - so;
        const f = fbm(nx * 2.0 + t01 * 1.1, nz * 2.0 + t01 * 2.6);
        const rg = ridged(nx * 3.4 + t01 * 1.6, nz * 3.4 + t01 * 4.2);
        const k = 1 + (f - 0.5) * 0.72 * (1 - t01 * 0.45)     // bulk mass
                    + (rg - 0.5) * 0.3 * (1 - t01 * 0.25);    // sharp crests
        pos.array[i * 3] = x * k;
        pos.array[i * 3 + 2] = z * k;
        pos.array[i * 3 + 1] = y + (f - 0.5) * ph * 0.12 * (1 - t01 * 0.55);
      }
      // per-face flat colors from SLOPE + height: steep faces = bare cliff,
      // flat-enough high faces hold snow, the rest is striated rock
      const colors = new Float32Array(pos.count * 3);
      for (let fi = 0; fi < pos.count; fi += 3) {
        let avgY = 0;
        for (let v = 0; v < 3; v++) avgY += pos.array[(fi + v) * 3 + 1];
        avgY = avgY / 3 + ph / 2;
        const frac = avgY / ph;
        _e1.set(pos.array[(fi + 1) * 3] - pos.array[fi * 3],
                pos.array[(fi + 1) * 3 + 1] - pos.array[fi * 3 + 1],
                pos.array[(fi + 1) * 3 + 2] - pos.array[fi * 3 + 2]);
        _e2.set(pos.array[(fi + 2) * 3] - pos.array[fi * 3],
                pos.array[(fi + 2) * 3 + 1] - pos.array[fi * 3 + 1],
                pos.array[(fi + 2) * 3 + 2] - pos.array[fi * 3 + 2]);
        _nf.crossVectors(_e1, _e2).normalize();
        const flat = Math.abs(_nf.y);
        const jitter = h2(fi * 0.713, pi * 3.7);
        const snowy = snowline > 0 && flat > 0.42 &&
          frac > (1 - snowline) + (jitter - 0.5) * 0.1;
        if (snowy) {
          _c.copy(snowCol).multiplyScalar(0.9 + jitter * 0.12);
        } else if (flat < 0.34) {
          _c.copy(cliffCol).multiplyScalar(0.85 + jitter * 0.3);   // sheer faces
        } else {
          // striated rock: brightness bands follow altitude
          const band = 0.9 + 0.12 * Math.sin(avgY * 0.55 + jitter * 4);
          _c.copy(col).multiplyScalar((0.6 + jitter * 0.4) * band);
        }
        for (let v = 0; v < 3; v++) {
          colors[(fi + v) * 3] = _c.r;
          colors[(fi + v) * 3 + 1] = _c.g;
          colors[(fi + v) * 3 + 2] = _c.b;
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        vertexColors: true, flatShading: true }));
      m.position.set(px, ph / 2, pz);
      m.rotation.y = rnd() * Math.PI * 2;
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
  }

  /* ambient sea life — REAL Quaternius creatures (CC0) swimming on their own:
     a school circles its marker, the shark/whale/dolphin/manta prowl wider
     rings with banking turns, the squidle monster sits and writhes.
     Primitive fishlets stand in on file://.
     NOTE the driver mesh renders with colorWrite OFF — a `visible:false`
     material is skipped entirely and onBeforeRender NEVER fires (that bug
     shipped once: nothing swam). */
  function buildSeaLife(name, g, col, o, marker) {
    const R = Math.max(2, o.size || 8);
    const speed = Math.max(0.05, o.speed !== undefined ? o.speed : 1);
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
    const creature = (key) => (SKY.GFX && SKY.GFX.hasProp(key)) ? SKY.GFX.prop(key) : null;
    const fallbackFish = (scale) => {
      const f = new THREE.Group();
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.14 * scale, 0.55 * scale, 6), lam(col));
      body.rotation.x = Math.PI / 2;    // nose toward +Z (matches the pack models)
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1 * scale, 0.25 * scale, 4), lam(col));
      tail.rotation.x = -Math.PI / 2;
      tail.position.z = -0.35 * scale;
      f.add(body, tail);
      return f;
    };
    // editor gizmo ring so the patrol circle is visible while placing
    if (name !== 'monster') {
      const mk = marker(new THREE.CylinderGeometry(R, R, 0.3, 24, 1, true), col);
      mk.position.y = 0;
      g.add(mk);
    }
    const driver = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    driver.frustumCulled = false;
    g.add(driver);

    if (name === 'monster') {
      const m = creature('life-squidle') || fallbackFish(6);
      g.add(m);
      driver.onBeforeRender = () => {
        const t = performance.now() * 0.0005 * speed;
        m.rotation.y = Math.sin(t) * 0.6;
        m.position.y = Math.sin(t * 2.3) * 0.35;
      };
      return;
    }

    // one big cruiser per marker for the large species; a shoal for 'school'
    const BIG = {
      sharkpatrol: { key: 'life-shark', spd: 0.55, bobA: 0.5, bobF: 1.2 },
      whale:       { key: 'life-whale', spd: 0.22, bobA: 1.2, bobF: 0.5 },
      dolphin:     { key: 'life-dolphin', spd: 0.85, bobA: 1.6, bobF: 1.6 },
      manta:       { key: 'life-mantaray', spd: 0.35, bobA: 0.9, bobF: 0.8 },
    };
    const swimmers = [];
    if (BIG[name]) {
      const B = BIG[name];
      const s = creature(B.key) || fallbackFish(4);
      g.add(s);
      swimmers.push({ f: s, phase: Math.random() * Math.PI * 2, r: R,
        bob: Math.random() * Math.PI * 2, spd: B.spd, bobA: B.bobA, bobF: B.bobF });
    } else {
      const kinds = ['life-fish-a', 'life-fish-b', 'life-fish-c'];
      const n = SKY.U.clamp(Math.round(o.count || 10), 1, 30);
      for (let i = 0; i < n; i++) {
        const f = creature(kinds[i % kinds.length]) || fallbackFish(1);
        // the source fish are ~2m long — a school wants palm-sized ones
        f.scale.multiplyScalar(SKY.U.rand(0.22, 0.38));
        g.add(f);
        swimmers.push({ f, phase: (i / n) * Math.PI * 2 + SKY.U.rand(-0.25, 0.25),
          r: R * SKY.U.rand(0.55, 1), bob: SKY.U.rand(0, Math.PI * 2),
          spd: SKY.U.rand(0.85, 1.25), bobA: 0.45, bobF: 1.2 });
      }
    }
    driver.onBeforeRender = () => {
      const t = performance.now() * 0.001 * speed;
      for (const sw of swimmers) {
        const a = sw.phase + t * 0.55 * sw.spd;
        const bobP = t * sw.bobF + sw.bob;
        sw.f.position.set(Math.cos(a) * sw.r,
          Math.sin(bobP) * sw.bobA, Math.sin(a) * sw.r);
        // velocity along the circle is (-sin a, cos a); the Quaternius
        // creatures swim along their OWN +Z, so yaw = atan2(vx, vz) = -a
        // (the old π−a had every fish cruising tail-first)
        sw.f.rotation.order = 'YXZ';
        sw.f.rotation.y = -a;
        // bank INTO the turn + pitch with the vertical bob = alive, not a
        // model on a carousel rail
        sw.f.rotation.z = -0.28;
        sw.f.rotation.x = -Math.cos(bobP) * sw.bobA * sw.bobF * 0.12;
      }
    };
  }

  /* oil rig set — rusted, half-abandoned hardware. The pumpjack NODS on
     its own (wall-clock + cull-proof driver, same rules as the heli). */
  function buildOilRig(name, g, col, o) {
    const lam = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e || 0x000000 });
    const rustD = lam(0x54341e);                   // deep corroded brown
    const rustM = lam(col);                        // main rust tone (tintable)
    const rustL = lam(0xa3612e);                   // fresh oxide orange
    const steel = lam(0x63686f);                   // grimy steel
    const warn = lam(0x8f7c34);                    // faded warning yellow
    const sh = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
    const box = (w, h, d, mat, x, y, z, parent) => {
      const q = sh(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
      q.position.set(x, y, z);
      (parent || g).add(q);
      return q;
    };
    const cyl = (r0, r1, l, mat, x, y, z, alongZ, parent) => {
      const q = sh(new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, l, 12), mat));
      if (alongZ) q.rotation.x = Math.PI / 2;
      q.position.set(x, y, z);
      (parent || g).add(q);
      return q;
    };

    if (name === 'pumpjack') {
      // skid + wellhead
      box(2.0, 0.3, 6.8, rustD, 0, 0.15, 0);
      cyl(0.22, 0.26, 0.9, steel, 0, 0.7, -2.9);           // wellhead stub
      // samson post (A-frame) to the beam pivot at (0, 3.1, 0.3)
      for (const sx of [-0.75, 0.75]) {
        const leg = box(0.24, 3.4, 0.24, rustM, sx * 0.5, 1.75, 0.3);
        leg.rotation.z = sx > 0 ? 0.22 : -0.22;
      }
      box(1.4, 0.2, 0.34, rustD, 0, 3.0, 0.3);             // post cap
      // WALKING BEAM group (pivots at the post top) + horsehead at -Z
      const beam = new THREE.Group();
      beam.position.set(0, 3.15, 0.3);
      g.add(beam);
      box(0.34, 0.42, 6.2, rustM, 0, 0, -0.4, beam);
      const head = sh(new THREE.Mesh(
        new THREE.CylinderGeometry(1.05, 1.05, 0.4, 14, 1, false, -0.6, 2.1), rustL));
      head.rotation.z = Math.PI / 2;
      head.rotation.y = Math.PI / 2;
      head.position.set(0, -0.1, -3.4);
      beam.add(head);
      box(0.3, 0.9, 0.26, warn, 0, -0.2, 2.4, beam);       // rear stand-off
      // CRANK + counterweights at the rear (spins), pitman arms to the beam
      const crank = new THREE.Group();
      crank.position.set(0, 1.15, 2.7);
      g.add(crank);
      for (const sx of [-0.62, 0.62]) {
        cyl(0.72, 0.72, 0.14, rustD, sx, 0, 0, true, crank);
        box(0.7, 0.55, 0.18, steel, sx, -0.45, 0, crank);  // counterweight lump
      }
      box(0.16, 0.16, 1.5, steel, 0, 0.45, 0, crank);      // crank pin
      box(1.1, 1.0, 1.5, rustM, 0, 0.6, 2.75);             // gearbox
      box(0.9, 0.8, 1.1, steel, 1.3, 0.55, 2.6);           // motor
      // driver: never culled, wall-clock — beam nods, crank spins in sync
      const hub = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), rustD);
      hub.frustumCulled = false;
      hub.position.set(0, 1.15, 2.7);
      g.add(hub);
      const spd = (o.power || 1) * 0.0016;
      hub.onBeforeRender = () => {
        const a = performance.now() * spd;
        crank.rotation.x = a;
        beam.rotation.x = Math.sin(a) * 0.16;
      };
    } else if (name === 'derrick') {
      const H = o.range || 14;
      const b0 = 2.4, b1 = 0.75;                           // base/top half-width
      const hw = (y) => b0 + (b1 - b0) * (y / H);          // half-width at height
      // exact point-to-point strut — no tilt-angle sign bugs
      const seg = (ax, ay, az, bx, by, bz, r, mat) => {
        const va = new THREE.Vector3(ax, ay, az);
        const vb = new THREE.Vector3(bx, by, bz);
        const m = sh(new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, va.distanceTo(vb), 6), mat));
        m.position.copy(va).add(vb).multiplyScalar(0.5);
        m.lookAt(vb);
        m.rotateX(Math.PI / 2);
        g.add(m);
        return m;
      };
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [sx, sz] of corners) {                    // 4 tapering legs
        seg(sx * b0, 0, sz * b0, sx * b1, H, sz * b1, 0.12, rustM);
      }
      const levels = [0, H * 0.3, H * 0.6, H * 0.88];
      for (let li = 1; li < levels.length; li++) {         // girt rings
        const y = levels[li], w = hw(y);
        for (let i = 0; i < 4; i++) {
          const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
          seg(ax * w, y, az * w, bx * w, y, bz * w, 0.07, rustD);
        }
      }
      for (let li = 0; li < levels.length - 1; li++) {     // X-braces per face
        const y0 = levels[li], y1 = levels[li + 1];
        const w0 = hw(y0), w1 = hw(y1);
        for (let i = 0; i < 4; i++) {
          const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
          seg(ax * w0, y0, az * w0, bx * w1, y1, bz * w1, 0.055, rustL);
          seg(bx * w0, y0, bz * w0, ax * w1, y1, az * w1, 0.055, rustL);
        }
      }
      box(b1 * 2.6, 0.22, b1 * 2.6, rustD, 0, H, 0);       // crown platform
      box(0.5, 0.7, 0.5, steel, 0, H + 0.45, 0);           // crown block
      cyl(0.1, 0.1, H * 0.92, steel, 0, H * 0.46, 0);      // drill string
      box(1.6, 1.2, 1.6, rustL, 1.9, 0.6, 1.9);            // doghouse shack
    } else if (name === 'flare') {
      const H = o.range || 11;
      const seg = (ax, ay, az, bx, by, bz, r, mat) => {
        const va = new THREE.Vector3(ax, ay, az);
        const vb = new THREE.Vector3(bx, by, bz);
        const m = sh(new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, va.distanceTo(vb), 6), mat));
        m.position.copy(va).add(vb).multiplyScalar(0.5);
        m.lookAt(vb);
        m.rotateX(Math.PI / 2);
        g.add(m);
        return m;
      };
      cyl(0.2, 0.26, H, rustM, 0, H / 2, 0);
      cyl(0.3, 0.3, 0.5, rustD, 0, H + 0.2, 0);            // burner tip
      for (let i = 0; i < 3; i++) {                        // guy wires, anchored
        const a = i * Math.PI * 2 / 3 + 0.4;
        seg(Math.cos(a) * H * 0.34, 0, Math.sin(a) * H * 0.34,
          0, H * 0.7, 0, 0.025, steel);
        cyl(0.09, 0.12, 0.3, rustD,
          Math.cos(a) * H * 0.34, 0.15, Math.sin(a) * H * 0.34);  // anchor stub
      }
      box(0.7, 0.5, 0.7, warn, 0.8, 0.25, 0);              // valve skid
      // FLAME: emissive cone + additive glow, flickering on wall clock
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.7, 8),
        new THREE.MeshBasicMaterial({ color: 0xffa640, transparent: true, opacity: 0.9 }));
      flame.position.set(0, H + 1.2, 0);
      g.add(flame);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: 0xff9435, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 }));
      glow.scale.set(2.6, 2.6, 1);
      glow.position.set(0, H + 1.4, 0);
      g.add(glow);
      flame.frustumCulled = false;
      const fspd = (o.power || 1);
      flame.onBeforeRender = () => {
        const t = performance.now() * 0.011 * fspd;
        const f = 0.75 + Math.sin(t) * 0.14 + Math.sin(t * 2.7) * 0.11;
        flame.scale.set(f, 0.8 + f * 0.5, f);
        glow.material.opacity = 0.4 + f * 0.35;
      };
    } else if (name === 'oiltank') {
      const R = o.size || 3.4, H = o.range || 4.6;
      cyl(R, R, H, rustM, 0, H / 2, 0);
      cyl(R * 1.01, R * 1.01, H * 0.18, rustD, 0, H * 0.12, 0);  // corroded base band
      cyl(R * 0.99, R * 1.005, H * 0.16, rustL, 0, H * 0.72, 0); // oxide streak band
      cyl(R + 0.05, R * 0.4, 0.6, rustD, 0, H + 0.28, 0);        // conical cap
      // top railing ring + ladder
      const rail = sh(new THREE.Mesh(new THREE.TorusGeometry(R * 0.9, 0.05, 6, 24), steel));
      rail.rotation.x = Math.PI / 2;
      rail.position.y = H + 0.9;
      g.add(rail);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        box(0.06, 0.8, 0.06, steel, Math.cos(a) * R * 0.9, H + 0.5, Math.sin(a) * R * 0.9);
      }
      for (let i = 0; i < 6; i++) {                        // ladder rungs
        box(0.5, 0.07, 0.07, warn, 0, 0.5 + i * (H - 0.6) / 5, R + 0.06);
      }
      box(0.09, H, 0.09, steel, -0.28, H / 2, R + 0.04);
      box(0.09, H, 0.09, steel, 0.28, H / 2, R + 0.04);
      cyl(0.16, 0.16, R * 1.4, steel, R * 0.7, 0.35, R * 0.7, true); // outflow pipe
    }
  }

  /* airport set — same flat-color toon style as the packs. Helicopter and
     jet park facing -Z; the heli's rotors spin on their own. */
  function buildAviation(name, g, col, o) {
    const lam = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e || 0x000000 });
    const bodyM = lam(col);
    const trimM = lam(0xf2f4f6);
    const darkM = lam(0x2c3140);
    const glassM = new THREE.MeshLambertMaterial({
      color: 0x9fd0e8, emissive: 0x24404e, transparent: true, opacity: 0.85 });
    const sh = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
    const box = (w, h, d, mat, x, y, z, parent) => {
      const q = sh(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
      q.position.set(x, y, z);
      (parent || g).add(q);
      return q;
    };
    const cyl = (r0, r1, l, mat, x, y, z, alongZ, parent) => {
      const q = sh(new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, l, 14), mat));
      if (alongZ) q.rotation.x = Math.PI / 2;
      q.position.set(x, y, z);
      (parent || g).add(q);
      return q;
    };

    if (name === 'heli') {
      box(1.5, 1.35, 3.1, bodyM, 0, 1.35, -0.3);                    // cabin
      const nose = box(1.3, 1.0, 1.0, glassM, 0, 1.3, -2.1);        // glass nose
      nose.rotation.x = 0.08;
      box(0.55, 0.55, 3.6, bodyM, 0, 1.6, 2.6);                     // tail boom
      box(0.12, 1.1, 0.8, bodyM, 0, 2.35, 4.2);                     // tail fin
      box(1.5, 0.1, 0.5, trimM, 0, 1.9, 4.1);                       // h-stab
      // skids
      for (const sx of [-0.85, 0.85]) {
        box(0.12, 0.12, 3.4, darkM, sx, 0.16, -0.2);
        for (const sz of [-1.1, 0.9]) {
          const strut = box(0.09, 0.75, 0.09, darkM, sx * 0.85, 0.6, sz);
          strut.rotation.z = sx > 0 ? -0.25 : 0.25;
        }
      }
      // main rotor — spins
      const rotor = new THREE.Group();
      rotor.position.set(0, 2.25, -0.3);
      cyl(0.14, 0.14, 0.45, darkM, 0, 0, 0, false, rotor);
      for (const a of [0, Math.PI / 2]) {
        const blade = box(0.32, 0.06, 9.4, darkM, 0, 0.18, 0, rotor);
        blade.rotation.y = a;
      }
      g.add(rotor);
      // tail rotor — spins too
      const tail = new THREE.Group();
      tail.position.set(0.35, 2.35, 4.35);
      for (const a of [0, Math.PI / 2]) {
        const blade = box(0.06, 1.5, 0.14, darkM, 0, 0, 0, tail);
        blade.rotation.x = a;
      }
      g.add(tail);
      const hub = sh(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), darkM));
      // never culled + wall-clock spin — the tiny hub driving the rotation
      // got frustum-culled in matches and the rotors froze mid-air
      hub.frustumCulled = false;
      hub.onBeforeRender = () => {
        const t = performance.now();
        rotor.rotation.y = t * 0.0252;
        tail.rotation.x = t * 0.036;
      };
      rotor.add(hub);
    } else if (name === 'jet') {
      cyl(1.1, 1.1, 12, bodyM, 0, 2.5, 0, true);                    // fuselage
      cyl(0.15, 1.1, 2.6, bodyM, 0, 2.5, -7.2, true);               // nose
      cyl(1.1, 0.35, 3, bodyM, 0, 2.65, 7.4, true);                 // tail taper
      box(0.9, 0.9, 2.2, glassM, 0, 2.95, -6.1);                    // cockpit glass
      // wings (swept) + underslung engines
      for (const s of [1, -1]) {
        const wing = box(8.5, 0.22, 2.6, trimM, s * 5.2, 2.2, 0.8);
        wing.rotation.y = s * 0.35;
        wing.rotation.z = s * 0.04;
        cyl(0.55, 0.55, 2.2, darkM, s * 4.2, 1.55, 0.2, true);
        cyl(0.58, 0.58, 0.3, trimM, s * 4.2, 1.55, -1, true);
      }
      box(0.16, 2.8, 2, trimM, 0, 4.4, 8.2);                        // tail fin
      for (const s of [1, -1]) {
        const stab = box(3, 0.12, 1.4, trimM, s * 1.7, 3.4, 8.4);
        stab.rotation.y = s * 0.3;
      }
      // gear
      cyl(0.28, 0.28, 0.2, darkM, 0, 0.5, -5.8);
      box(0.12, 1.6, 0.12, darkM, 0, 1.4, -5.8);
      for (const s of [1, -1]) {
        cyl(0.34, 0.34, 0.25, darkM, s * 1.4, 0.5, 1.6);
        box(0.14, 1.6, 0.14, darkM, s * 1.4, 1.4, 1.6);
      }
    } else if (name === 'helipad') {
      const r = o.size || 4.5;
      const pad = sh(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.3, 26), bodyM));
      pad.position.y = 0.15;
      g.add(pad);
      const ring = sh(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r * 0.82, 0.32, 26, 1, true),
        lam(0xf2f4f6, 0x2a2c30)));
      ring.position.y = 0.155;
      g.add(ring);
      // the H
      box(r * 0.14, 0.04, r * 0.72, trimM, -r * 0.24, 0.32, 0);
      box(r * 0.14, 0.04, r * 0.72, trimM, r * 0.24, 0.32, 0);
      box(r * 0.36, 0.04, r * 0.14, trimM, 0, 0.32, 0);
      // corner beacons
      for (const a of [0.25, 0.75, 1.25, 1.75]) {
        const b = sh(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6),
          lam(0xffd34d, 0xaa7d00)));
        b.position.set(Math.cos(a * Math.PI) * r * 0.94, 0.36, Math.sin(a * Math.PI) * r * 0.94);
        g.add(b);
      }
    } else if (name === 'runway') {
      const L = Math.max(20, o.range || 60), W = Math.max(6, o.size || 11);
      const strip = box(W, 0.24, L, bodyM, 0, 0.12, 0);
      // center dashes + threshold bars
      const n = Math.floor(L / 6);
      for (let i = 0; i < n; i++) {
        box(0.35, 0.03, 2.6, trimM, 0, 0.26, -L / 2 + 3 + i * 6);
      }
      for (const ez of [-L / 2 + 1.2, L / 2 - 1.2]) {
        for (let i = 0; i < Math.floor(W / 1.4); i++) {
          box(0.6, 0.03, 1.6, trimM, -W / 2 + 1 + i * 1.4, 0.26, ez);
        }
      }
      // edge lights
      for (let i = 0; i <= Math.floor(L / 8); i++) {
        for (const sx of [-W / 2 - 0.4, W / 2 + 0.4]) {
          const b = sh(new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 5),
            lam(0xffd34d, 0x8a6a10)));
          b.position.set(sx, 0.2, -L / 2 + i * 8);
          g.add(b);
        }
      }
    } else if (name === 'tower') {
      box(2.8, 12, 2.8, bodyM, 0, 6, 0);                             // shaft
      box(3.4, 0.5, 3.4, darkM, 0, 12.2, 0);                         // deck
      const cab = box(4.6, 2.4, 4.6, glassM, 0, 13.6, 0);            // glass cab
      box(5, 0.4, 5, darkM, 0, 15, 0);                               // roof
      cyl(0.05, 0.05, 2.6, darkM, 0, 16.4, 0);                       // antenna
      const beacon = sh(new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6),
        lam(0xff5d3b, 0xaa2408)));
      beacon.position.y = 17.7;
      g.add(beacon);
      beacon.onBeforeRender = () => {
        beacon.material.emissiveIntensity = 0.5 + Math.sin(performance.now() * 0.006) * 0.5;
      };
      box(1.4, 3, 1.4, darkM, 0, 1.5, 1.6);                          // entrance block
    } else if (name === 'hangar') {
      const r = Math.max(3, o.size || 6), L = Math.max(6, o.range || 14);
      const shell = sh(new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, L, 18, 1, true, 0, Math.PI), bodyM));
      shell.material = new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide });
      shell.rotation.x = Math.PI / 2;
      shell.rotation.z = Math.PI / 2;
      g.add(shell);
      // back wall (front stays open — walk/park inside)
      const back = sh(new THREE.Mesh(new THREE.CircleGeometry(r, 18, 0, Math.PI),
        new THREE.MeshLambertMaterial({ color: 0x565e6c, side: THREE.DoubleSide })));
      back.position.z = L / 2;
      g.add(back);
      // door frame lips on the open end
      for (const s of [1, -1]) {
        box(0.5, r * 0.9, 0.5, darkM, s * (r - 0.3), r * 0.45, -L / 2 + 0.2);
      }
      box(1.2, 0.8, 1.6, darkM, r - 0.4, 0.4, -L / 2 + 2);           // crate dressing
    }
    g.traverse((oo) => { if (oo.isMesh) { oo.castShadow = true; oo.receiveShadow = true; } });
  }

  /* stylized bush plane from primitives (same flat-color look as the packs).
     wreck=true = crashed: nose buried, tail torn off, wing snapped, scorch +
     drifting smoke. Roughly 8m wingspan; nose points -Z. */
  function buildPlane(g, col, wreck) {
    const lam = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e || 0x000000 });
    const bodyM = lam(col);
    const trimM = lam(0xf2f4f6);
    const darkM = lam(0x2c3140);
    const glassM = new THREE.MeshLambertMaterial({
      color: 0x9fd0e8, emissive: 0x24404e, transparent: true, opacity: 0.85 });
    const shadowed = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
    const box = (w, h, d, mat, x, y, z, parent) => {
      const q = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
      q.position.set(x, y, z);
      (parent || g).add(q);
      return q;
    };

    // main body group (so the wreck can tilt/sink it as one piece)
    const body = new THREE.Group();
    g.add(body);
    box(1.3, 1.25, 2.6, bodyM, 0, 1.35, -0.4, body);                   // cabin
    box(1.15, 1.0, 1.3, bodyM, 0, 1.28, -2.2, body);                   // nose
    const windshield = box(1.1, 0.55, 0.7, glassM, 0, 1.95, -1.35, body);
    windshield.rotation.x = 0.35;
    box(0.55, 0.5, 0.35, darkM, 0, 1.2, -2.95, body);                  // engine face
    // wing (full span on top; the wreck snaps the right half off)
    const wingL = box(3.6, 0.14, 1.5, trimM, -2.35, 2.1, -0.55, body);
    const wingR = box(3.6, 0.14, 1.5, trimM, 2.35, 2.1, -0.55, body);
    // wing struts
    for (const sx of [-1.6, 1.6]) {
      const st = box(0.09, 1.15, 0.09, darkM, sx, 1.45, -0.3, body);
      st.rotation.z = sx > 0 ? 0.45 : -0.45;
    }
    // tail boom + fin + stabilizer (separate group so the wreck can rip it off)
    const tail = new THREE.Group();
    box(0.62, 0.62, 2.9, bodyM, 0, 1.45, 2.3, tail);
    box(0.12, 1.25, 0.95, bodyM, 0, 2.35, 3.4, tail);                  // fin
    box(2.3, 0.1, 0.8, trimM, 0, 1.75, 3.45, tail);                    // h-stab
    g.add(tail);
    // propeller: spinner cone + 2 blades — spins on the intact plane
    const prop = new THREE.Group();
    prop.position.set(0, 1.28, -2.92);
    const spinner = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 10), trimM));
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -0.15;
    prop.add(spinner);
    for (const s of [1, -1]) {
      const blade = box(0.16, 1.15, 0.06, darkM, 0, s * 0.62, 0, prop);
      if (wreck) blade.rotation.x = s * 0.8;                            // bent blades
    }
    body.add(prop);
    // landing gear
    const gear = [];
    for (const sx of [-0.75, 0.75]) {
      const strut = box(0.08, 0.6, 0.08, darkM, sx, 0.55, -1.4, body);
      const wheel = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.18, 10), darkM));
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(sx, 0.28, -1.4);
      body.add(wheel);
      gear.push(strut, wheel);
    }

    if (!wreck) {
      const hub = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 8), darkM));
      hub.frustumCulled = false;   // culled driver = frozen prop (see heli)
      hub.onBeforeRender = () => { prop.rotation.z = performance.now() * 0.033; };
      prop.add(hub);
      return;
    }

    // ---- the crash ----
    body.rotation.set(0.14, 0.1, 0.1);
    body.position.y = -0.42;                                            // nose dug in
    // right wing snapped off, planted in the ground beside the hull
    body.remove(wingR);
    wingR.position.set(3.6, 0.55, 0.6);
    wingR.rotation.set(0.2, 0.7, 1.15);
    g.add(wingR);
    // tail section torn off, lying rolled over behind
    tail.position.set(1.3, -0.55, 1.6);
    tail.rotation.set(-0.1, 0.55, 0.8);
    // scorched ground + debris
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(3.4, 20),
      new THREE.MeshLambertMaterial({ color: 0x17191f, transparent: true, opacity: 0.75 }));
    scorch.name = 'nocoll';   // decal — keep it out of the collision build
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.03;
    scorch.receiveShadow = true;
    g.add(scorch);
    for (let i = 0; i < 6; i++) {
      const d = box(SKY.U.rand(0.2, 0.55), SKY.U.rand(0.1, 0.3), SKY.U.rand(0.2, 0.5),
        i % 2 ? darkM : bodyM,
        SKY.U.rand(-2.8, 2.8), 0.12, SKY.U.rand(-2.5, 2.8));
      d.rotation.y = SKY.U.rand(0, Math.PI);
    }
    // lazy smoke column off the engine
    const smokes = [];
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6),
        new THREE.MeshBasicMaterial({
          map: SKY.U.blobTexture(), color: 0x3a3f47, transparent: true,
          opacity: 0.4, depthWrite: false, side: THREE.DoubleSide,
        }));
      s.name = 'nocoll';   // drifting smoke must not inflate the collision
      s.position.set(0.2, 1.4, -2.4);
      g.add(s);
      smokes.push({ m: s, off: i / 3 });
    }
    smokes[0].m.onBeforeRender = () => {
      const t = performance.now() * 0.00025;
      for (const sm of smokes) {
        const k = (t + sm.off) % 1;
        sm.m.position.y = 1.2 + k * 4.2;
        sm.m.position.x = 0.2 + Math.sin((k + sm.off) * 5) * 0.5;
        const sc = 0.8 + k * 2.2;
        sm.m.scale.set(sc, sc, 1);
        sm.m.material.opacity = 0.38 * (1 - k) + 0.05;
        sm.m.rotation.z += 0.0012;
      }
    };
  }

  /* built-in "pack" folder: read-only props from the shipped asset pack
     (SKY.GFX). Maps reference them as 'gfx:<name>' — nothing to embed,
     every https client resolves them locally. */
  const packCache = {};
  function packItems() {
    if (!SKY.GFX) return [];
    const out = [];
    for (const n of SKY.GFX.propNames()) {
      if (!SKY.GFX.hasProp(n)) continue;
      let it = packCache[n];
      if (it && SKY.GFX.propFolder) it.folder = SKY.GFX.propFolder(n);
      if (!it) {
        it = {
          id: 'gfx:' + n,
          folder: SKY.GFX.propFolder ? SKY.GFX.propFolder(n) : 'pack',
          type: 'model', builtin: true, thumb: null,
          name: n.replace(/^Prop_/, '').replace(/^(nat|pir|sea|rd|camp)-/, '')
            .replace(/_/g, ' ').replace(/-/g, ' ').toLowerCase(),
        };
        packCache[n] = it;
      }
      if (!it.thumb) {
        const o = SKY.GFX.prop(n);
        if (o) it.thumb = thumbFromObject(o);
      }
      out.push(it);
    }
    // light & atmosphere decor lives in its own folder ('gadgets' for
    // gameplay entities like the air vent)
    for (const def of FX_DEFS) {
      let it = packCache[def.id];
      if (!it) {
        it = { id: def.id, folder: def.folder || 'lights', type: 'model', builtin: true,
               thumb: null, name: def.name };
        packCache[def.id] = it;
      }
      if (!it.thumb) it.thumb = thumbFromObject(buildFx(def.id.slice(3)));
      out.push(it);
    }
    return out;
  }

  /* ---------- procedural SNOW COVER ----------
   * Whitens upward-facing surfaces of any prop (world-space normal mask) so
   * desert-colored rock/cave kits sit naturally in winter maps. amount 0-1;
   * re-callable: existing patched materials just update their uniform. */
  function applySnow(root, amount) {
    const amt = SKY.U.clamp(amount || 0, 0, 1);
    root.traverse((oo) => {
      if (!oo.isMesh || oo.isSkinnedMesh || !oo.material) return;
      if (oo.name === 'edmarker' || oo.name === 'edcoll' || oo.name === 'nocoll') return;
      const mats = Array.isArray(oo.material) ? oo.material : [oo.material];
      const out = mats.map((m) => {
        if (!m || m.userData.__seaMat) return m;
        if (m.userData.__snow) { m.userData.__snow.value = amt; return m; }
        // materials are SHARED between GLB clones — patch a private copy
        const sm = m.clone();
        sm.userData.__snow = { value: amt };
        const prev = sm.onBeforeCompile;
        sm.onBeforeCompile = (sh) => {
          if (prev) prev(sh);
          sh.uniforms.uSnowAmt = sm.userData.__snow;
          sh.vertexShader = 'varying vec3 vSnowN;\n' + sh.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nvSnowN = normalize(mat3(modelMatrix) * objectNormal);');
          sh.fragmentShader = 'uniform float uSnowAmt;\nvarying vec3 vSnowN;\n' +
            sh.fragmentShader.replace(
              '#include <color_fragment>',
              ['#include <color_fragment>',
               // tops catch the snow; high amounts dust the steeper faces too
               'float snowK = smoothstep(0.35, 0.78, vSnowN.y) * uSnowAmt;',
               'snowK = max(snowK, clamp(vSnowN.y, 0.0, 1.0) * uSnowAmt * 0.3);',
               'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.94, 1.0), snowK);'
              ].join('\n'));
        };
        sm.needsUpdate = true;
        return sm;
      });
      oo.material = Array.isArray(oo.material) ? out : out[0];
    });
  }

  const api = {
    onChange: null,
    applySnow,
    list() { return items.concat(packItems()); },
    get(id) {
      if (!id) return undefined;
      return items.find(a => a.id === id) ||
        (id.startsWith('gfx:') ? packCache[id.slice(4)] : undefined) ||
        (id.startsWith('fx:') ? packCache[id] : undefined);
    },
    folders() {
      const f = new Set(items.map(a => a.folder || 'assets'));
      f.add('assets');
      for (const it of packItems()) f.add(it.folder || 'pack');
      return [...f].sort();
    },

    /* import dropped/browsed files into a folder */
    addFiles(files, folder, done) {
      let pending = 0;
      const finish = () => { if (--pending === 0) { if (api.onChange) api.onChange(); done && done(); } };
      for (const f of files) {
        const id = 'a' + Math.random().toString(36).slice(2, 9);
        const name = f.name.replace(/\.[^.]+$/, '');
        if (/\.(glb)$/i.test(f.name)) {
          pending++;
          const fr = new FileReader();
          fr.onload = () => {
            const b64 = bufToB64(fr.result);
            const a = { id, folder, name, type: 'model', data: b64, thumb: null };
            parseModel(id, b64, (obj) => {
              if (obj) a.thumb = thumbFromObject(obj);
              items.push(a);
              persist(a);
              finish();
            });
          };
          fr.readAsArrayBuffer(f);
        } else if (/^image\//.test(f.type)) {
          pending++;
          const fr = new FileReader();
          fr.onload = () => {
            const a = { id, folder, name, type: 'image', data: fr.result, thumb: fr.result };
            items.push(a);
            persist(a);
            finish();
          };
          fr.readAsDataURL(f);
        }
      }
      if (!pending && done) done();
    },

    remove(id) {
      items = items.filter(a => a.id !== id);
      unpersist(id);
      if (api.onChange) api.onChange();
    },

    /* instantiate a model asset (from the library OR a map def's embedded copy) */
    instantiate(idOrEmbed, cb, fx) {
      if (typeof idOrEmbed === 'string') {
        // built-ins are deferred: callers add their placeholder to the scene
        // right after this call and their callbacks guard on holder.parent
        if (idOrEmbed.startsWith('gfx:')) {
          setTimeout(() => cb(SKY.GFX ? SKY.GFX.prop(idOrEmbed.slice(4)) : null), 0);
          return;
        }
        if (idOrEmbed.startsWith('fx:')) {
          setTimeout(() => cb(buildFx(idOrEmbed.slice(3), fx)), 0);
          return;
        }
        const a = api.get(idOrEmbed);
        if (!a || a.type !== 'model') { cb(null); return; }
        parseModel(a.id, a.data, cb);
      } else {
        parseModel(idOrEmbed.id, idOrEmbed.data, cb);
      }
    },

    /* copy an asset's payload into a map def so the map is self-contained
       (built-in 'gfx:'/'fx:' items ship with the game — nothing to embed) */
    embed(def, id) {
      if (id && (id.startsWith('gfx:') || id.startsWith('fx:'))) return;
      const a = api.get(id);
      if (a && !def.assets[id]) {
        def.assets[id] = { id, name: a.name, type: a.type, data: a.data };
      }
    },

    /* default fx settings for the editor's inspector */
    fxDefaults(id) { return { ...(FX_OPTS[(id || '').slice(3)] || {}) }; },

    init() { openDb(() => loadAll(() => { if (api.onChange) api.onChange(); })); },
  };
  return api;
})();
