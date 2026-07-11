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
    }
    return g;
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
          name: n.replace(/^Prop_/, '').replace(/_/g, ' ').replace(/-/g, ' ').toLowerCase(),
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
