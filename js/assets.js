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
    { id: 'fx:rope',       name: 'hanging rope', folder: 'gadgets' },
    { id: 'fx:plane',      name: 'prop plane', folder: 'planes' },
    { id: 'fx:planewreck', name: 'crashed plane', folder: 'planes' },
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
    // vertex-animated swell field: power = wave height, range = wave length
    sea:        { color: '#155a9e', power: 0.5, range: 18, size: 140 },
    rope:       { color: '#d8c49a', range: 8 },   // range = rope length (m)
    plane:      { color: '#d0483e' },
    planewreck: { color: '#8a92a0' },
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
      hub.onBeforeRender = () => { fan.rotation.y += 0.32; };   // self-spinning
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
      // REAL water: a vertex-animated swell field with recomputed normals —
      // sun glints roll across actual moving geometry, not a scrolled texture
      const size = Math.max(20, o.size);
      const segs = SKY.U.clamp(Math.round(size / 3), 24, 48);
      const geo = new THREE.PlaneGeometry(size, size, segs, segs);
      geo.rotateX(-Math.PI / 2);
      const basePos = geo.attributes.position.array.slice();
      const sea = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
        color: col.clone().convertSRGBToLinear(),   // hex picker is sRGB
        shininess: 55, specular: 0x4a6a88,
        transparent: true, opacity: 0.96,
      }));
      sea.receiveShadow = true;
      const amp = Math.max(0, o.power);
      const kw = (Math.PI * 2) / Math.max(4, o.range);
      const pos = geo.attributes.position;
      sea.onBeforeRender = () => {
        const t = performance.now() * 0.0009;
        const a = pos.array;
        for (let i = 0; i < pos.count; i++) {
          const x = basePos[i * 3], z = basePos[i * 3 + 2];
          a[i * 3 + 1] = basePos[i * 3 + 1] + amp * (
            Math.sin(x * kw + t * 1.9) * 0.55 +
            Math.sin(z * kw * 0.8 + t * 1.4) * 0.3 +
            Math.sin((x + z) * kw * 0.45 - t * 2.3) * 0.35);
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();
      };
      g.add(sea);
    } else if (name === 'rope') {
      // crane-style hanging rope: sagging tube + knot, swaying gently.
      // Hangs DOWN from where you place it — put it on a crane arm / mast.
      const len = Math.max(1, o.range);
      const swayG = new THREE.Group();
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push(new THREE.Vector3(Math.sin(t * Math.PI) * len * 0.035, -t * len, 0));
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
      const phase = Math.random() * Math.PI * 2;
      rope.onBeforeRender = () => {
        const t = performance.now() * 0.0007 + phase;
        swayG.rotation.z = Math.sin(t) * 0.055;
        swayG.rotation.x = Math.cos(t * 0.8) * 0.045;
      };
    } else if (name === 'plane' || name === 'planewreck') {
      buildPlane(g, col.clone().convertSRGBToLinear(), name === 'planewreck');
    }
    return g;
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
      hub.onBeforeRender = () => { prop.rotation.z += 0.55; };          // idle prop spin
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

  const api = {
    onChange: null,
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
