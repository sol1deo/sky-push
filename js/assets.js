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
     'fx:<name>'. Real lights included, so maps can be moody. */
  const FX_DEFS = [
    { id: 'fx:lamp',      name: 'street lamp' },
    { id: 'fx:spotlight', name: 'spotlight' },
    { id: 'fx:neonbar',   name: 'neon bar' },
    { id: 'fx:godray',    name: 'godray' },
    { id: 'fx:haze',      name: 'haze' },
  ];
  function buildFx(name) {
    const g = new THREE.Group();
    const lam = (c, e) => new THREE.MeshLambertMaterial({
      color: c, emissive: e || 0x000000,
    });
    if (name === 'lamp') {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.2, 8), lam(0x2c3140));
      pole.position.y = 1.6;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.12), lam(0x2c3140));
      arm.position.set(0.38, 3.2, 0);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8),
        lam(0xfff2cc, 0xffdf9e));
      bulb.position.set(0.75, 3.1, 0);
      const light = new THREE.PointLight(0xffe0b0, 1.15, 13);
      light.position.copy(bulb.position);
      g.add(pole, arm, bulb, light);
    } else if (name === 'spotlight') {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.18, 10), lam(0x2c3140));
      base.position.y = 0.09;
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 0.45, 10),
        lam(0x3b486b, 0x201808));
      head.rotation.x = -Math.PI / 4;
      head.position.y = 0.42;
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.15, 10), lam(0xffffff, 0xfff2cc));
      lens.position.set(0, 0.58, 0.16);
      lens.rotation.x = -Math.PI / 4;
      const light = new THREE.PointLight(0xfff2cc, 1.5, 17);
      light.position.set(0, 1.4, 1.2);
      g.add(base, head, lens, light);
    } else if (name === 'neonbar') {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.09, 0.09),
        lam(0x40c8ff, 0x2f9ecf));
      bar.position.y = 0.05;
      const light = new THREE.PointLight(0x40c8ff, 0.9, 10);
      light.position.y = 0.4;
      g.add(bar, light);
    } else if (name === 'godray') {
      for (let i = 0; i < 2; i++) {
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(3.2, 11),
          new THREE.MeshBasicMaterial({
            map: SKY.U.shaftTexture(), color: 0xfff2cc, transparent: true,
            opacity: 0.08, blending: THREE.AdditiveBlending,
            depthWrite: false, side: THREE.DoubleSide, fog: false,
          }));
        plane.position.y = 5;
        plane.rotation.z = 0.28;
        plane.rotation.y = i * Math.PI / 2;
        g.add(plane);
      }
    } else if (name === 'haze') {
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: SKY.U.blobTexture(), color: 0xdde6f2, transparent: true,
          opacity: 0.09, depthWrite: false,
        }));
        s.position.set(SKY.U.rand(-2, 2), SKY.U.rand(0.5, 2.2), SKY.U.rand(-2, 2));
        const sc = SKY.U.rand(7, 11);
        s.scale.set(sc, sc * 0.55, 1);
        g.add(s);
      }
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
      if (!it) {
        it = {
          id: 'gfx:' + n, folder: 'pack', type: 'model', builtin: true, thumb: null,
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
    // light & atmosphere decor lives in its own folder
    for (const def of FX_DEFS) {
      let it = packCache[def.id];
      if (!it) {
        it = { id: def.id, folder: 'lights', type: 'model', builtin: true,
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
      if (packItems().length) { f.add('pack'); f.add('lights'); }
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
    instantiate(idOrEmbed, cb) {
      if (typeof idOrEmbed === 'string') {
        // built-ins are deferred: callers add their placeholder to the scene
        // right after this call and their callbacks guard on holder.parent
        if (idOrEmbed.startsWith('gfx:')) {
          setTimeout(() => cb(SKY.GFX ? SKY.GFX.prop(idOrEmbed.slice(4)) : null), 0);
          return;
        }
        if (idOrEmbed.startsWith('fx:')) {
          setTimeout(() => cb(buildFx(idOrEmbed.slice(3))), 0);
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

    init() { openDb(() => loadAll(() => { if (api.onChange) api.onChange(); })); },
  };
  return api;
})();
