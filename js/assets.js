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

  const api = {
    onChange: null,
    list() { return items; },
    get(id) { return items.find(a => a.id === id); },
    folders() {
      const f = new Set(items.map(a => a.folder || 'assets'));
      f.add('assets');
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
        const a = api.get(idOrEmbed);
        if (!a || a.type !== 'model') { cb(null); return; }
        parseModel(a.id, a.data, cb);
      } else {
        parseModel(idOrEmbed.id, idOrEmbed.data, cb);
      }
    },

    /* copy an asset's payload into a map def so the map is self-contained */
    embed(def, id) {
      const a = api.get(id);
      if (a && !def.assets[id]) {
        def.assets[id] = { id, name: a.name, type: a.type, data: a.data };
      }
    },

    init() { openDb(() => loadAll(() => { if (api.onChange) api.onChange(); })); },
  };
  return api;
})();
