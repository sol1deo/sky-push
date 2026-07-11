/* =============================================================================
 * SKY PUSH — MAP EDITOR (dev tool, menu ▸ EDITOR)
 * Unity-ish scene editing for custom maps:
 *   camera    — hold RMB to look + WASD/E/Q to fly (wheel = speed)
 *   select    — LMB click (viewport) or the OUTLINER list
 *   gizmo     — drag the arrows/rings/boxes; G/R/S switch move/rotate/scale,
 *               hold CTRL to snap (0.5 m / 15°)
 *   F         — drop the selection onto whatever is below (no floaters)
 *   Shift+D   — duplicate · Del — delete · Ctrl+Z — undo
 *   numbers   — every inspector field drag-scrubs (grab the label, drag ⇆)
 * ASSETS panel = the project library (IndexedDB): drop .glb models and images
 * into it, organize in folders, then drag onto the viewport — models become
 * solid props, images texture the block under the cursor. Assets used by a
 * map are embedded in its def, so saved/hosted maps stay self-contained.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Editor = (function () {
  const $ = (id) => document.getElementById(id);
  let scene = null, camera = null;
  let def = null;
  let group = null;
  let grid = null, lights = [];
  let objects = [];               // [{ kind, data, mesh }]
  let sel = -1;
  let selBox = null;
  let history = [];               // undo stack
  let future = [];                // redo stack
  let dirty = false;              // unsaved changes since last save/autosave
  let autosaveTimer = null;
  let clipboard = null;           // { kind, json } — Ctrl+C/X/V
  let pasteCount = 0;
  let lastNudgeT = 0;
  let env = null;                 // sky dome / sun / shafts preview group
  let camYaw = 0.6, camPitch = -0.45;
  const camPos = new THREE.Vector3(24, 18, 24);
  let flySpeed = 14;
  let looking = false;
  let gizmo = null, gizmoDrag = false;
  let previewT = 0, previewOn = true;
  let ui = null;
  const ray = new THREE.Raycaster();
  const _m = new THREE.Vector2();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();

  const api = { active: false, pendingReturn: null };

  /* ================= materials & meshes ================= */
  function blockMaterial(b) {
    const rep = b.rep || Math.max(2, Math.round(Math.max(b.s[0], b.s[2]) / 3));
    if (b.tex) {
      const tex = new THREE.TextureLoader().load(b.tex);
      tex.encoding = THREE.sRGBEncoding;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(rep, rep);
      return new THREE.MeshLambertMaterial({ map: tex });
    }
    if (b.ptex && SKY.U.PROC_TEX[b.ptex]) {
      return new THREE.MeshLambertMaterial({ map: SKY.U.procTexture(b.ptex, rep) });
    }
    const pal = SKY.MapData.PALETTES[b.pal];
    if (pal) {
      const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
      m.map = SKY.U.checkerTexture(pal[0], pal[1], rep);
      return m;
    }
    return new THREE.MeshLambertMaterial({ color: b.color || '#8a94a8' });
  }

  function buildBlockMesh(b) {
    const mesh = new THREE.Mesh(
      SKY.U.blockGeometry(b.shape || 'box', b.s[0], b.s[1], b.s[2]), blockMaterial(b));
    mesh.position.set(b.p[0], b.p[1], b.p[2]);
    mesh.rotation.set(b.r[0], b.r[1], b.r[2]);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }
  function buildPadMesh(pd) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.22, 20),
      new THREE.MeshLambertMaterial({ color: 0x49e07f, emissive: 0x49e07f, emissiveIntensity: 0.5 }));
    g.add(disc);
    const dir = new THREE.Vector3(pd.launch[0], pd.launch[1], pd.launch[2]);
    g.add(new THREE.ArrowHelper(dir.clone().normalize(), new THREE.Vector3(0, 0.2, 0),
      Math.max(1, dir.length() * 0.22), 0x49e07f, 0.6, 0.35));
    g.position.set(pd.p[0], pd.p[1] + 0.11, pd.p[2]);
    return g;
  }
  function buildSpawnMesh(s) {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.0, 10),
      new THREE.MeshLambertMaterial({ color: 0x7dff9e, emissive: 0x2a8f4a }));
    cone.position.y = 0.9;
    g.add(cone);
    const fwd = new THREE.Vector3(-Math.sin(s.yaw || 0), 0, -Math.cos(s.yaw || 0));
    g.add(new THREE.ArrowHelper(fwd, new THREE.Vector3(0, 0.4, 0), 1.6, 0x7dff9e, 0.5, 0.3));
    g.position.set(s.p[0], s.p[1], s.p[2]);
    return g;
  }
  function buildItemMesh(it) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.42),
      new THREE.MeshLambertMaterial({ color: 0xffd34d, emissive: 0x8f6a10 }));
    m.position.set(it.p[0], it.p[1] + 1, it.p[2]);
    return m;
  }
  function buildPropMesh(pr, entry) {
    // placeholder box until the GLB parses, then swapped in place
    const holder = new THREE.Group();
    holder.position.set(pr.p[0], pr.p[1], pr.p[2]);
    const rot = pr.r || [0, 0, 0];
    holder.rotation.set(rot[0], rot[1], rot[2]);
    holder.scale.setScalar(pr.scale || 1);
    const ph = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0x8a5aff, wireframe: true }));
    holder.add(ph);
    const isPack = (pr.asset || '').startsWith('gfx:');
    const embed = def.assets[pr.asset];
    if (embed || isPack) {
      SKY.Assets.instantiate(isPack ? pr.asset : embed, (obj) => {
        if (!obj || !holder.parent) return;
        holder.remove(ph);
        holder.add(obj);
        if (entry && objects[sel] === entry && selBox) selBox.update();
        refreshOutliner();
      });
    }
    return holder;
  }

  function rebuild(keepSel) {
    const oldSel = keepSel ? sel : -1;
    if (gizmo) gizmo.detach();
    if (group) scene.remove(group);
    group = new THREE.Group();
    scene.add(group);
    objects = [];
    for (const b of def.blocks) { const mesh = buildBlockMesh(b); group.add(mesh); objects.push({ kind: 'block', data: b, mesh }); }
    for (const pd of def.pads) { const mesh = buildPadMesh(pd); group.add(mesh); objects.push({ kind: 'pad', data: pd, mesh }); }
    for (const s of def.spawns) { const mesh = buildSpawnMesh(s); group.add(mesh); objects.push({ kind: 'spawn', data: s, mesh }); }
    for (const it of def.items) { const mesh = buildItemMesh(it); group.add(mesh); objects.push({ kind: 'item', data: it, mesh }); }
    for (const pr of def.props) { const entry = { kind: 'prop', data: pr, mesh: null }; entry.mesh = buildPropMesh(pr, entry); group.add(entry.mesh); objects.push(entry); }
    if (!grid) grid = new THREE.GridHelper(160, 160, 0x557799, 0x2a3244);
    group.add(grid);
    applyMood();
    select(oldSel >= 0 && oldSel < objects.length ? oldSel : -1);
    refreshOutliner();
  }

  function applyMood() {
    for (const l of lights) scene.remove(l);
    lights = [];
    if (env) { scene.remove(env); env = null; }
    const M = SKY.MapData.MOODS[def.mood];
    const hemi = new THREE.HemisphereLight(M.hemi[0], M.hemi[1], M.hemi[2]);
    const sun = new THREE.DirectionalLight(M.sun[0], M.sun[1]);
    sun.position.set(M.sun[2][0], M.sun[2][1], M.sun[2][2]);
    sun.castShadow = true;                       // the preview matches the game
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
    sun.shadow.camera.far = 240;
    sun.shadow.bias = -0.0004;
    if (M.fill[0]) {
      const fill = new THREE.DirectionalLight(M.fill[0], M.fill[1]);
      fill.position.set(...(M.fill[2] || [-40, 30, -35]));
      lights.push(fill);
      scene.add(fill);
    }
    lights.push(hemi, sun);
    scene.add(hemi, sun);
    scene.fog = new THREE.Fog(new THREE.Color(M.fog[0]).getHex(), M.fog[1], M.fog[2]);
    // FULL environment preview — same dome / sun / moon / shafts as in-game
    env = new THREE.Group();
    scene.add(env);
    scene.background = null;
    const S = SKY.MapData.SKIES[def.sky];
    env.add(makeDome(S[0], S[1], S[2], S[3]));
    const sunPos = new THREE.Vector3(...M.sun[2]);
    if (M.disc) {
      const pos = sunPos.clone().normalize().multiplyScalar(330);
      const size = M.discSize || 60;
      if (M.disc === 'sun') {
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: SKY.U.blobTexture(), color: M.discColor || '#fff2d0', transparent: true,
          opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }));
        glow.position.copy(pos); glow.scale.set(size * 2.8, size * 2.8, 1);
        const core = new THREE.Sprite(new THREE.SpriteMaterial({
          map: SKY.U.blobTexture(), color: '#ffffff', transparent: true,
          opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }));
        core.position.copy(pos); core.scale.set(size, size, 1);
        env.add(glow, core);
      } else {
        const moon = new THREE.Sprite(new THREE.SpriteMaterial({
          map: SKY.U.moonTexture(), color: M.discColor || '#e8f0ff', transparent: true,
          depthWrite: false, fog: false,
        }));
        moon.position.copy(pos); moon.scale.set(size, size, 1);
        env.add(moon);
      }
    }
    if (M.shafts) {
      const dir = sunPos.clone().normalize();
      for (let i = 0; i < 4; i++) {
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(SKY.U.rand(8, 16), SKY.U.rand(45, 70)),
          new THREE.MeshBasicMaterial({
            map: SKY.U.shaftTexture(), color: M.sun[0], transparent: true,
            opacity: SKY.U.rand(0.045, 0.09), blending: THREE.AdditiveBlending,
            depthWrite: false, side: THREE.DoubleSide, fog: false,
          }));
        plane.position.set(SKY.U.rand(-22, 22), SKY.U.rand(14, 22), SKY.U.rand(-22, 22));
        plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        plane.rotateY(SKY.U.rand(0, Math.PI));
        env.add(plane);
      }
    }
  }

  /* gradient sky dome — same recipe as the game's */
  function makeDome(top, mid, horizon, stars) {
    const g = new THREE.Group();
    const c = document.createElement('canvas');
    c.width = 32; c.height = 256;
    const ctx = c.getContext('2d');
    const gr = ctx.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, top); gr.addColorStop(0.55, mid); gr.addColorStop(1, horizon);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 32, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    g.add(new THREE.Mesh(new THREE.SphereGeometry(380, 24, 14),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })));
    if (stars) {
      const sc = document.createElement('canvas');
      sc.width = sc.height = 512;
      const sg = sc.getContext('2d');
      for (let i = 0; i < 240; i++) {
        sg.fillStyle = `rgba(255,255,255,${SKY.U.rand(0.3, 1)})`;
        sg.fillRect(Math.random() * 512, Math.random() * 320, SKY.U.rand(1, 2.4), SKY.U.rand(1, 2.4));
      }
      g.add(new THREE.Mesh(new THREE.SphereGeometry(370, 24, 14),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), side: THREE.BackSide, transparent: true, fog: false })));
    }
    return g;
  }

  function labelOf(o, i) {
    if (o.kind === 'block') return 'Block · ' + o.data.s.map(v => +v.toFixed(1)).join('×');
    if (o.kind === 'pad') return 'Jump pad';
    if (o.kind === 'spawn') return 'Spawn';
    if (o.kind === 'item') return 'Item point';
    const a = def.assets[o.data.asset];
    return 'Prop · ' + (a ? a.name : '?');
  }

  /* ================= outliner ================= */
  function refreshOutliner() {
    ui.outliner.innerHTML = `<div class="ed-obj${sel < 0 ? ' sel' : ''}" data-i="-1">⚙ Map settings</div>` +
      objects.map((o, i) =>
        `<div class="ed-obj${i === sel ? ' sel' : ''}" data-i="${i}">${labelOf(o, i)}</div>`).join('');
  }

  /* ================= selection & gizmo ================= */
  function writeBack(o) {
    const m = o.mesh, d = o.data;
    if (o.kind === 'block') {
      d.p = [m.position.x, m.position.y, m.position.z];
      d.r = [m.rotation.x, m.rotation.y, m.rotation.z];
    } else if (o.kind === 'pad') {
      d.p = [m.position.x, m.position.y - 0.11, m.position.z];
      // rotating a pad ROTATES ITS LAUNCH VECTOR (the arrow follows)
      if (m.rotation.x || m.rotation.y || m.rotation.z) {
        const v = new THREE.Vector3(d.launch[0], d.launch[1], d.launch[2]).applyEuler(m.rotation);
        d.launch = [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
        m.rotation.set(0, 0, 0);
        rebuildMarker(o);
      }
      m.scale.setScalar(1);
    } else if (o.kind === 'spawn') {
      d.p = [m.position.x, m.position.y, m.position.z];
      d.yaw = m.rotation.y;
      m.rotation.x = m.rotation.z = 0; m.scale.setScalar(1);
    } else if (o.kind === 'item') {
      d.p = [m.position.x, m.position.y - 1, m.position.z];
      m.rotation.set(0, 0, 0); m.scale.setScalar(1);
    } else if (o.kind === 'prop') {
      d.p = [m.position.x, m.position.y, m.position.z];
      d.r = [m.rotation.x, m.rotation.y, m.rotation.z];
      d.scale = m.scale.x;
      m.scale.setScalar(d.scale);
    }
    if (selBox) selBox.update();
    markDirty();
  }

  /* blocks bake gizmo-scale into their size (geometry, not mesh.scale) */
  function bakeBlockScale(o) {
    if (o.kind !== 'block') return;
    const m = o.mesh, d = o.data;
    if (m.scale.x === 1 && m.scale.y === 1 && m.scale.z === 1) return;
    d.s = [Math.max(0.25, d.s[0] * m.scale.x), Math.max(0.25, d.s[1] * m.scale.y), Math.max(0.25, d.s[2] * m.scale.z)];
    m.scale.setScalar(1);
    m.geometry.dispose();
    m.geometry = SKY.U.blockGeometry(d.shape || 'box', d.s[0], d.s[1], d.s[2]);
    if (!d.rep) m.material = blockMaterial(d);   // re-spread the checker evenly
    if (selBox) selBox.update();
  }

  function select(i) {
    sel = i;
    if (selBox) { group.remove(selBox); selBox = null; }
    if (gizmo) gizmo.detach();
    const o = objects[sel];
    if (o) {
      selBox = new THREE.BoxHelper(o.mesh, 0xffd34d);
      group.add(selBox);
      if (gizmo) {
        gizmo.attach(o.mesh);
        // blocks/props: move+rotate+scale · pads/spawns: move+rotate · items: move
        const allowed = (o.kind === 'block' || o.kind === 'prop')
          ? ['translate', 'rotate', 'scale']
          : o.kind === 'item' ? ['translate'] : ['translate', 'rotate'];
        if (allowed.indexOf(gizmo.mode) < 0) gizmo.setMode('translate');
      }
    }
    syncInspector();
    refreshOutliner();
  }

  function pick(clientX, clientY) {
    _m.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(_m, camera);
    let best = -1, bestD = Infinity;
    objects.forEach((o, i) => {
      const hits = ray.intersectObject(o.mesh, true);
      if (hits.length && hits[0].distance < bestD) { bestD = hits[0].distance; best = i; }
    });
    return best;
  }

  /* ray from a screen point to the first block (or the ground plane) */
  function dropPoint(clientX, clientY, out) {
    _m.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(_m, camera);
    let bestD = Infinity, hitObj = null;
    for (const o of objects) {
      if (o.kind !== 'block') continue;
      const hits = ray.intersectObject(o.mesh, false);
      if (hits.length && hits[0].distance < bestD) { bestD = hits[0].distance; out.copy(hits[0].point); hitObj = o; }
    }
    if (!hitObj) {
      // ground plane y=0
      const t = -ray.ray.origin.y / ray.ray.direction.y;
      if (t > 0) { ray.ray.at(t, out); hitObj = 'grid'; }
    }
    return hitObj;
  }

  function focusPoint(out) {
    SKY.U.dirFromYawPitch(camYaw, camPitch, out);
    out.multiplyScalar(14).add(camPos);
    out.x = Math.round(out.x); out.y = Math.max(0, Math.round(out.y)); out.z = Math.round(out.z);
    return out;
  }

  /* ================= autosave (the map must NEVER be lost) ================= */
  function markDirty() {
    dirty = true;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 2500);   // settle, then snapshot
  }
  function autosaveNow() {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    if (!dirty || !def || !api.active) return;
    SKY.MapData.autosave(def);
  }

  /* ================= history (undo / redo) ================= */
  function push() {
    history.push(JSON.stringify(def));
    if (history.length > 60) history.shift();
    future.length = 0;                       // a new action clears redo
    markDirty();
  }
  function undo() {
    if (!history.length) { status('nothing to undo'); return; }
    future.push(JSON.stringify(def));
    def = SKY.MapData.normalize(JSON.parse(history.pop()));
    rebuild(false);
    markDirty();
    status('undo');
  }
  function redo() {
    if (!future.length) { status('nothing to redo'); return; }
    history.push(JSON.stringify(def));
    def = SKY.MapData.normalize(JSON.parse(future.pop()));
    rebuild(false);
    markDirty();
    status('redo');
  }

  /* ================= clipboard ================= */
  function copySel(cut) {
    const o = objects[sel];
    if (!o) return;
    clipboard = { kind: o.kind, json: JSON.stringify(o.data) };
    pasteCount = 0;
    if (cut) { deleteSel(); status('cut'); } else status('copied ' + o.kind);
  }
  function paste() {
    if (!clipboard) { status('clipboard empty'); return; }
    const item = JSON.parse(clipboard.json);
    pasteCount++;
    item.p = [item.p[0] + 2 * pasteCount, item.p[1], item.p[2] + 2 * pasteCount];
    const arr = { block: def.blocks, pad: def.pads, spawn: def.spawns, item: def.items, prop: def.props }[clipboard.kind];
    push();
    arr.push(item);
    rebuild();
    select(objects.findIndex(o => o.data === item));
    status('pasted');
  }

  /* arrow-key nudging (one undo point per burst) */
  function nudge(dx, dy, dz) {
    const o = objects[sel];
    if (!o) return;
    if (performance.now() - lastNudgeT > 900) push();
    lastNudgeT = performance.now();
    o.data.p[0] += dx; o.data.p[1] += dy; o.data.p[2] += dz;
    syncMeshFromData(o);
    syncInspector();
  }

  /* ================= add / duplicate / delete / drop ================= */
  function addAndSelect(arr, item) {
    push();
    arr.push(item);
    rebuild();
    select(objects.findIndex(o => o.data === item));
  }
  function addBlock() {
    focusPoint(_v);
    addAndSelect(def.blocks, { p: [_v.x, _v.y, _v.z], s: [4, 1, 4], r: [0, 0, 0], pal: 'pearl', crumble: false, mover: null });
  }
  /* big textured base plate — the usual first step of a real map */
  function addGround() {
    addAndSelect(def.blocks, { p: [0, -1, 0], s: [80, 2, 80], r: [0, 0, 0], pal: null, ptex: 'grass', crumble: false, mover: null });
    status('ground added — pick another texture in the inspector');
  }
  /* recenter the whole layout so the block bounds sit on the origin (XZ) */
  function centerMap() {
    if (!def.blocks.length) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of def.blocks) {
      minX = Math.min(minX, b.p[0] - b.s[0] / 2); maxX = Math.max(maxX, b.p[0] + b.s[0] / 2);
      minZ = Math.min(minZ, b.p[2] - b.s[2] / 2); maxZ = Math.max(maxZ, b.p[2] + b.s[2] / 2);
    }
    const cx = Math.round((minX + maxX) / 2), cz = Math.round((minZ + maxZ) / 2);
    if (!cx && !cz) { status('already centered'); return; }
    push();
    for (const arr of [def.blocks, def.pads, def.spawns, def.items, def.props]) {
      for (const o of arr) { o.p[0] -= cx; o.p[2] -= cz; }
    }
    for (const b of def.blocks) {
      if (b.mover && b.mover.c) { b.mover.c[0] -= cx; b.mover.c[1] -= cz; }
    }
    def.crown[0] -= cx; def.crown[2] -= cz;
    rebuild(false);
    status(`map centered (shifted ${-cx}, ${-cz})`);
  }
  function addPad() { focusPoint(_v); addAndSelect(def.pads, { p: [_v.x, _v.y, _v.z], launch: [0, 16, 0] }); }
  function addSpawn() { focusPoint(_v); addAndSelect(def.spawns, { p: [_v.x, _v.y, _v.z], yaw: 0 }); }
  function addItem() { focusPoint(_v); addAndSelect(def.items, { p: [_v.x, _v.y, _v.z] }); }

  function arrOf(o) { return { block: def.blocks, pad: def.pads, spawn: def.spawns, item: def.items, prop: def.props }[o.kind]; }

  function duplicateSel() {
    const o = objects[sel];
    if (!o) return;
    const copy = JSON.parse(JSON.stringify(o.data));
    copy.p = [copy.p[0] + 2, copy.p[1], copy.p[2] + 2];
    addAndSelect(arrOf(o), copy);
    status('duplicated');
  }
  function deleteSel() {
    const o = objects[sel];
    if (!o) return;
    if (o.kind === 'block' && def.blocks.length <= 1) { status('a map needs at least one block'); return; }
    if (o.kind === 'spawn' && def.spawns.length <= 2) { status('keep at least 2 spawns'); return; }
    push();
    arrOf(o).splice(arrOf(o).indexOf(o.data), 1);
    rebuild();
    select(-1);
  }
  function dropSel() {
    const o = objects[sel];
    if (!o) return;
    push();
    const halfH = o.kind === 'block' ? (o.data.s[1] / 2) : 0;
    _v.set(o.data.p[0], o.data.p[1] + (o.kind === 'block' ? 0 : 1), o.data.p[2]);
    ray.set(_v, new THREE.Vector3(0, -1, 0));
    let top = 0;
    for (const q of objects) {
      if (q === o || q.kind !== 'block') continue;
      const hits = ray.intersectObject(q.mesh, false);
      if (hits.length) top = Math.max(top, hits[0].point.y);
    }
    o.data.p[1] = +(top + halfH).toFixed(2);
    syncMeshFromData(o);
    syncInspector();
    status('dropped');
  }

  function syncMeshFromData(o) {
    const d = o.data, m = o.mesh;
    if (o.kind === 'block') {
      m.position.set(d.p[0], d.p[1], d.p[2]);
      m.rotation.set(d.r[0], d.r[1], d.r[2]);
      m.geometry.dispose();
      m.geometry = SKY.U.blockGeometry(d.shape || 'box', d.s[0], d.s[1], d.s[2]);
      // keep the checker density even instead of stretching the texture
      if (!d.rep) m.material = blockMaterial(d);
    } else if (o.kind === 'pad') m.position.set(d.p[0], d.p[1] + 0.11, d.p[2]);
    else if (o.kind === 'item') m.position.set(d.p[0], d.p[1] + 1, d.p[2]);
    else if (o.kind === 'spawn') m.position.set(d.p[0], d.p[1], d.p[2]);
    else if (o.kind === 'prop') {
      m.position.set(d.p[0], d.p[1], d.p[2]);
      const r = d.r || [0, 0, 0];
      m.rotation.set(r[0], r[1], r[2]);
      m.scale.setScalar(d.scale || 1);
    }
    if (selBox) selBox.update();
  }

  /* ================= inspector ================= */
  function status(s) { ui.status.textContent = s || ''; }

  function numRow(label, val, key, step) {
    return `<div class="ed-row"><span class="ed-scrub" data-for="${key}">${label}</span>
      <input type="number" data-k="${key}" value="${(+val).toFixed(2)}" step="${step || 0.5}"></div>`;
  }

  function syncInspector() {
    const o = objects[sel];
    ui.insTitle.textContent = o ? labelOf(o).toUpperCase() : 'MAP SETTINGS';
    if (!o) {
      const backups = SKY.MapData.backupsOf(def.id);
      ui.ins.innerHTML = `
        <div class="ed-row"><span>Name</span><input type="text" data-k="name" value="${def.name}" maxlength="18"></div>
        <div class="ed-row"><span>Mood</span><select data-k="mood">${Object.keys(SKY.MapData.MOODS).map(m =>
          `<option value="${m}"${m === def.mood ? ' selected' : ''}>${SKY.MapData.MOODS[m].label}</option>`).join('')}</select></div>
        <div class="ed-row"><span>Sky</span><select data-k="sky">${Object.keys(SKY.MapData.SKIES).map(s =>
          `<option value="${s}"${s === def.sky ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        ${numRow('Kill height', def.killY, 'killY', 1)}
        <div class="ed-row"><span>Layout</span><button class="ed-mini" data-k="centermap">center map XZ</button></div>` +
        (backups.length ? `
        <div class="ed-row"><span>Backups</span><select data-k="restorebackup">
          <option value="">restore…</option>
          ${backups.map((b, i) => `<option value="${i}">${b.t ? new Date(b.t).toLocaleString() : 'older save'}</option>`).join('')}
        </select></div>` : '') + `
        <div class="ed-hint">Picking a mood also sets its matching sky (change the sky after to override).
        Autosave runs a few seconds after every change — even a crash can't eat the map.</div>`;
      return;
    }
    const d = o.data;
    let h = numRow('X', d.p[0], 'p0') + numRow('Y', d.p[1], 'p1') + numRow('Z', d.p[2], 'p2');
    if (o.kind === 'block') {
      const shp = d.shape || 'box';
      h += `<div class="ed-row"><span>Shape</span><select data-k="shape">
        ${[['box', 'Box'], ['cyl', 'Cylinder'], ['hex', 'Hexagon'], ['sphere', 'Sphere'],
           ['cone', 'Cone'], ['pyramid', 'Pyramid']].map(([v, l]) =>
          `<option value="${v}"${shp === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select></div>`;
      h += numRow(shp === 'box' ? 'Width' : 'Diameter', d.s[0], 's0')
        + numRow('Height', d.s[1], 's1')
        + numRow('Length', d.s[2], 's2');
      h += `<div class="ed-row"><span>Extend faces</span></div>
        <div class="ed-row ed-faces">
          <span class="ed-face" data-f="0,-1">−X</span><span class="ed-face" data-f="0,1">+X</span>
          <span class="ed-face" data-f="1,-1">−Y</span><span class="ed-face" data-f="1,1">+Y</span>
          <span class="ed-face" data-f="2,-1">−Z</span><span class="ed-face" data-f="2,1">+Z</span>
        </div>`;
      h += numRow('Rot X°', d.r[0] * 180 / Math.PI, 'r0', 5) + numRow('Rot Y°', d.r[1] * 180 / Math.PI, 'r1', 5) + numRow('Rot Z°', d.r[2] * 180 / Math.PI, 'r2', 5);
      h += `<div class="ed-row"><span>Palette</span><select data-k="pal">
        <option value=""${!d.pal ? ' selected' : ''}>flat color</option>
        ${Object.keys(SKY.MapData.PALETTES).map(p => `<option value="${p}"${d.pal === p ? ' selected' : ''}>${p}</option>`).join('')}
      </select></div>`;
      h += `<div class="ed-row"><span>Color</span><input type="color" data-k="color" value="${d.color || '#8a94a8'}"></div>`;
      h += `<div class="ed-row"><span>Texture</span></div>
        <div class="ed-row ed-swatches">
          <span class="ed-swatch${!d.ptex ? ' sel' : ''}" data-pt="" title="none">✕</span>
          ${Object.keys(SKY.U.PROC_TEX).map(t =>
            `<span class="ed-swatch${d.ptex === t ? ' sel' : ''}" data-pt="${t}" title="${t}" style="background-image:url(${SKY.U.procThumb(t)})"></span>`).join('')}
        </div>`;
      h += numRow('Tiling', d.rep || 0, 'rep', 1);
      if (d.tex) h += `<div class="ed-row"><span>Image tex</span><button class="ed-mini" data-k="cleartex">remove</button></div>`;
      h += `<div class="ed-row"><span>Crumble</span><input type="checkbox" data-k="crumble"${d.crumble ? ' checked' : ''}></div>`;
      const mt = d.mover ? d.mover.type : '';
      h += `<div class="ed-row"><span>Mover</span><select data-k="movertype">
        <option value=""${!mt ? ' selected' : ''}>static</option>
        <option value="elevator"${mt === 'elevator' ? ' selected' : ''}>elevator</option>
        <option value="line"${mt === 'line' ? ' selected' : ''}>line</option>
        <option value="orbit"${mt === 'orbit' ? ' selected' : ''}>orbit</option>
      </select></div>`;
      if (d.mover) {
        h += numRow('Period s', d.mover.period || 6, 'mperiod', 0.5);
        if (d.mover.type === 'elevator') h += numRow('Rise', d.mover.amp || 4, 'mamp');
        if (d.mover.type === 'line') {
          const off = d.mover.off || [6, 0, 0];
          h += numRow('Off X', off[0], 'moff0') + numRow('Off Y', off[1], 'moff1') + numRow('Off Z', off[2], 'moff2');
        }
        if (d.mover.type === 'orbit') {
          const c = d.mover.c || [0, 0];
          h += numRow('Center X', c[0], 'mc0') + numRow('Center Z', c[1], 'mc1');
        }
      }
    } else if (o.kind === 'pad') {
      // intuitive controls: strength + direction (plus raw XYZ below)
      const lv = new THREE.Vector3(d.launch[0], d.launch[1], d.launch[2]);
      const str = lv.length();
      const tilt = str > 0.01 ? Math.acos(SKY.U.clamp(lv.y / str, -1, 1)) * 180 / Math.PI : 0;
      const pyaw = Math.atan2(lv.x, lv.z) * 180 / Math.PI;
      h += numRow('Strength', +str.toFixed(1), 'pstr', 1)
        + numRow('Tilt°', +tilt.toFixed(0), 'ptilt', 5)
        + numRow('Yaw°', +pyaw.toFixed(0), 'pyaw', 15)
        + numRow('Launch X', d.launch[0], 'l0') + numRow('Launch Y', d.launch[1], 'l1') + numRow('Launch Z', d.launch[2], 'l2');
    } else if (o.kind === 'spawn') {
      h += numRow('Yaw°', (d.yaw || 0) * 180 / Math.PI, 'yaw', 15);
    } else if (o.kind === 'prop') {
      h += numRow('Rot Y°', (d.r ? d.r[1] : 0) * 180 / Math.PI, 'pr1', 5);
      h += numRow('Scale', d.scale || 1, 'pscale', 0.1);
      h += `<div class="ed-row"><span>Solid</span><input type="checkbox" data-k="psolid"${d.solid !== false ? ' checked' : ''}></div>`;
    }
    ui.ins.innerHTML = h;
  }

  function onInspectorInput(e) {
    const k = e.target.dataset.k;
    if (!k) return;
    const o = objects[sel];
    if (!o) {
      if (k === 'name') def.name = e.target.value.toUpperCase();
      else if (k === 'mood') {
        def.mood = e.target.value;
        def.sky = SKY.MapData.SKY_FOR_MOOD[def.mood] || def.sky;
        applyMood();
        syncInspector();
      }
      else if (k === 'sky') { def.sky = e.target.value; applyMood(); }
      else if (k === 'killY') def.killY = parseFloat(e.target.value) || -22;
      else if (k === 'restorebackup') {
        const b = SKY.MapData.backupsOf(def.id)[parseInt(e.target.value, 10)];
        if (b) {
          push();
          def = SKY.MapData.normalize(JSON.parse(JSON.stringify(b.def)));
          rebuild(false);
          status('backup restored — Ctrl+Z to go back, Ctrl+S to keep');
        }
        return;
      }
      markDirty();
      return;
    }
    const d = o.data;
    const num = parseFloat(e.target.value) || 0;
    if (k[0] === 'p' && k.length === 2 && !isNaN(+k[1])) d.p[+k[1]] = num;
    else if (k[0] === 's' && k.length === 2) d.s[+k[1]] = Math.max(0.25, num);
    else if (k[0] === 'r' && k.length === 2) d.r[+k[1]] = num * Math.PI / 180;
    else if (k[0] === 'l' && k.length === 2) { d.launch[+k[1]] = num; rebuildMarker(o); }
    else if (k === 'pstr' || k === 'ptilt' || k === 'pyaw') {
      // recompose launch from strength / tilt-from-vertical / compass yaw
      const lv = new THREE.Vector3(d.launch[0], d.launch[1], d.launch[2]);
      let str = lv.length() || 16;
      let tilt = str > 0.01 ? Math.acos(SKY.U.clamp(lv.y / str, -1, 1)) : 0;
      let pyaw = Math.atan2(lv.x, lv.z);
      if (k === 'pstr') str = Math.max(1, num);
      if (k === 'ptilt') tilt = SKY.U.clamp(num, 0, 90) * Math.PI / 180;
      if (k === 'pyaw') pyaw = num * Math.PI / 180;
      d.launch = [
        +(Math.sin(pyaw) * Math.sin(tilt) * str).toFixed(2),
        +(Math.cos(tilt) * str).toFixed(2),
        +(Math.cos(pyaw) * Math.sin(tilt) * str).toFixed(2),
      ];
      rebuildMarker(o);
    }
    else if (k === 'yaw') { d.yaw = num * Math.PI / 180; rebuildMarker(o); }
    else if (k === 'pr1') { d.r = d.r || [0, 0, 0]; d.r[1] = num * Math.PI / 180; }
    else if (k === 'pscale') d.scale = Math.max(0.05, num);
    else if (k === 'psolid') d.solid = e.target.checked;
    else if (k === 'pal') { d.pal = e.target.value || null; if (d.pal) d.ptex = null; o.mesh.material = blockMaterial(d); syncInspector(); }
    else if (k === 'color') { d.color = e.target.value; if (!d.pal && !d.tex && !d.ptex) o.mesh.material = blockMaterial(d); }
    else if (k === 'rep') { d.rep = Math.max(0, Math.round(num)) || null; o.mesh.material = blockMaterial(d); }
    else if (k === 'crumble') d.crumble = e.target.checked;
    else if (k === 'shape') {
      d.shape = e.target.value === 'box' ? null : e.target.value;
      // round shapes use Width as diameter — keep the collision box square
      if (d.shape && d.shape !== 'box') d.s[2] = d.s[0];
      if (d.shape === 'sphere') d.s[1] = d.s[0];
      syncInspector();
    }
    else if (k === 'movertype') {
      const t = e.target.value;
      d.mover = t ? (t === 'elevator' ? { type: t, amp: 4, period: 6 }
        : t === 'line' ? { type: t, off: [6, 0, 0], period: 6 }
        : { type: t, c: [0, 0], period: 12 }) : null;
      syncInspector();
    }
    else if (k === 'mperiod') d.mover.period = Math.max(1, num);
    else if (k === 'mamp') d.mover.amp = num;
    else if (k.indexOf('moff') === 0) { d.mover.off = d.mover.off || [6, 0, 0]; d.mover.off[+k[4]] = num; }
    else if (k.indexOf('mc') === 0) { d.mover.c = d.mover.c || [0, 0]; d.mover.c[+k[2]] = num; }
    else if (k === 'cleartex') { d.tex = null; o.mesh.material = blockMaterial(d); markDirty(); syncInspector(); return; }
    markDirty();
    syncMeshFromData(o);
    refreshOutliner();
  }

  function rebuildMarker(o) {
    const i = objects.indexOf(o);
    group.remove(o.mesh);
    o.mesh = o.kind === 'spawn' ? buildSpawnMesh(o.data) : buildPadMesh(o.data);
    group.add(o.mesh);
    if (i === sel) {
      if (selBox) group.remove(selBox);
      selBox = new THREE.BoxHelper(o.mesh, 0xffd34d);
      group.add(selBox);
      if (gizmo) gizmo.attach(o.mesh);
    }
  }

  /* ================= assets panel ================= */
  let curFolder = 'assets';
  function refreshAssets() {
    const folders = SKY.Assets.folders();
    if (folders.indexOf(curFolder) < 0) curFolder = folders[0];
    ui.folderSel.innerHTML = folders.map(f =>
      `<option value="${f}"${f === curFolder ? ' selected' : ''}>📁 ${f}</option>`).join('');
    const list = SKY.Assets.list().filter(a => (a.folder || 'assets') === curFolder);
    ui.assetGrid.innerHTML = list.length ? list.map(a => `
      <div class="ed-asset" draggable="true" data-id="${a.id}" title="${a.name} — drag into the scene">
        ${a.thumb ? `<img src="${a.thumb}" alt="">` : `<span class="ed-asset-ph">${a.type === 'model' ? '◆' : '🖼'}</span>`}
        <i>${a.name}</i>${a.builtin ? '' : `<b class="ed-asset-x" data-x="${a.id}">×</b>`}
      </div>`).join('')
      : '<div class="ed-hint">Drop .glb models or images here, or use ADD FILES.</div>';
  }

  function placeAsset(assetId, clientX, clientY) {
    const a = SKY.Assets.get(assetId);
    if (!a) return;
    const hit = dropPoint(clientX, clientY, _v);
    if (!hit) { status('drop it over the map'); return; }
    if (a.type === 'image') {
      const o = typeof hit === 'object' ? hit : null;
      if (!o) { status('drop images ONTO a block to texture it'); return; }
      push();
      o.data.tex = a.data;
      o.mesh.material = blockMaterial(o.data);
      status('textured with ' + a.name);
      return;
    }
    // model → a solid prop
    push();
    SKY.Assets.embed(def, assetId);
    const pr = { asset: assetId, p: [+_v.x.toFixed(2), +_v.y.toFixed(2), +_v.z.toFixed(2)], r: [0, 0, 0], scale: 1, solid: true };
    def.props.push(pr);
    rebuild();
    select(objects.findIndex(o => o.data === pr));
    status(a.name + ' placed — G/R/S to adjust');
  }

  /* ================= save / load / export / test ================= */
  function save() {
    def.name = def.name || 'CUSTOM MAP';
    const ok = SKY.MapData.saveDraft(def);
    dirty = false;
    clearTimeout(autosaveTimer);
    refreshLoadList();
    syncInspector();   // the backups row may have just appeared
    status(ok ? 'saved ✓ — the map is in the PLAY list' : '⚠ SAVE FAILED — use EXPORT now so nothing is lost');
  }
  function exportJson() {
    const blob = new Blob([JSON.stringify(def)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status('exported — put it in maps/ + maps/index.json to deploy for everyone');
  }
  function importJson(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        def = SKY.MapData.normalize(JSON.parse(fr.result));
        history = [];
        rebuild(false);
        status('imported ' + def.name);
      } catch (e) { status('that file is not a map'); }
    };
    fr.readAsText(file);
  }
  function refreshLoadList() {
    const D = SKY.MapData;
    const drafts = D.drafts();
    const isDraft = (id) => drafts.some(d => d.id === id);
    const recovered = D.recoverables().filter(d => !isDraft(d.id));   // autosave-only maps
    const deployed = D.list().filter(d => D.isDeployed(d.id) && !isDraft(d.id));
    const opt = (d) => `<option value="${d.id}">${d.name}</option>`;
    const grp = (label, list) => list.length ? `<optgroup label="${label}">${list.map(opt).join('')}</optgroup>` : '';
    ui.loadSel.innerHTML = '<option value="">Open map…</option>' +
      grp('⚠ Recovered (unsaved)', recovered) +
      grp('My maps', drafts) +
      grp('Server maps', deployed);
    ui.loadSel.value = '';
  }
  function clearSceneOwned() {
    if (gizmo) { gizmo.detach(); scene.remove(gizmo); }
    if (group) { scene.remove(group); group = null; }
    if (env) { scene.remove(env); env = null; }
    for (const l of lights) scene.remove(l);
    lights = [];
    objects = [];
    scene.background = null;
    scene.fog = null;
  }
  function testPlay() {
    save();
    api.pendingReturn = def.id;
    ui.root.classList.add('hidden');
    api.active = false;
    clearSceneOwned();                 // no grid / ghost meshes in the match
    SKY.SFX.init();
    SKY.Game.startMatch(2, def.id, 'lbs', { rounds: 9, lives: 5 });
    SKY.Input.requestLock();
  }

  /* ================= open / close ================= */
  function open(defOrId) {
    if (api.active) return;
    api.active = true;
    SKY.Attract.stop();   // the menu show must not leak into the editor scene
    if (def && dirty) SKY.MapData.autosave(def);   // outgoing map is never dropped
    let source = defOrId, recovered = false;
    if (typeof defOrId === 'string') {
      const D = SKY.MapData;
      source = D.get(defOrId) || (D.draftMeta(defOrId) || {}).def;
      // a newer autosave than the last save = work that was about to be lost
      const auto = D.autosaveOf(defOrId), meta = D.draftMeta(defOrId);
      if (auto && (!meta || auto.t > meta.t)) { source = auto.def; recovered = !!meta; }
      if (!source) status('map "' + defOrId + '" not found — opened a new one');
    }
    def = SKY.MapData.normalize(source
      ? JSON.parse(JSON.stringify(source)) : SKY.MapData.blank());
    history = [];
    dirty = false;
    SKY.Map.unload();
    if (gizmo) scene.add(gizmo);
    rebuild(false);
    refreshLoadList();
    refreshAssets();
    ui.root.classList.remove('hidden');
    document.getElementById('menu').classList.add('hidden');
    select(-1);
    status(recovered
      ? '⚠ recovered unsaved changes — Ctrl+S to keep them'
      : 'RMB — fly · click — select · drag the gizmo · TEST to play it');
  }

  function exit() {
    autosaveNow();                     // leaving is never a data loss
    ui.root.classList.add('hidden');
    api.active = false;
    clearSceneOwned();
    SKY.Map.load(scene, 'sky');
    SKY.HUD.showMenu();
  }

  function resume() {
    const id = api.pendingReturn;
    api.pendingReturn = null;
    document.getElementById('menu').classList.add('hidden');
    open(id);
  }

  /* ================= per-frame ================= */
  function frame(rdt) {
    const In = SKY.Input;
    SKY.Effects.tick(rdt);
    // Unity-style: WASD flies ONLY while RMB is held (keys stay free for hotkeys)
    if (looking) {
      const sp = flySpeed * rdt * (In.isDown('ShiftLeft') ? 2.6 : 1);
      SKY.U.dirFromYawPitch(camYaw, camPitch, _v);
      _v2.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
      const mz = (In.isDown('KeyW') ? 1 : 0) - (In.isDown('KeyS') ? 1 : 0);
      const mx = (In.isDown('KeyD') ? 1 : 0) - (In.isDown('KeyA') ? 1 : 0);
      const my = (In.isDown('KeyE') ? 1 : 0) - (In.isDown('KeyQ') ? 1 : 0);
      camPos.addScaledVector(_v, mz * sp).addScaledVector(_v2, mx * sp);
      camPos.y += my * sp;
    }
    camera.position.copy(camPos);
    camera.rotation.set(camPitch, camYaw, 0, 'YXZ');
    camera.fov = 80;
    camera.updateProjectionMatrix();
    // mover preview
    if (previewOn && !gizmoDrag) {
      previewT += rdt;
      for (const o of objects) {
        if (o.kind !== 'block' || !o.data.mover || objects[sel] === o) continue;
        const m = o.data.mover;
        const period = Math.max(1, m.period || 6);
        const s = (Math.sin(previewT * Math.PI * 2 / period) + 1) / 2;
        if (m.type === 'elevator') o.mesh.position.y = o.data.p[1] + (m.amp || 4) * s;
        else if (m.type === 'line') {
          const off = m.off || [6, 0, 0];
          o.mesh.position.set(o.data.p[0] + off[0] * s, o.data.p[1] + off[1] * s, o.data.p[2] + off[2] * s);
        } else {
          const c = m.c || [0, 0];
          const a = previewT * Math.PI * 2 / period;
          const rx = o.data.p[0] - c[0], rz = o.data.p[2] - c[1];
          o.mesh.position.set(c[0] + rx * Math.cos(a) - rz * Math.sin(a), o.data.p[1],
            c[1] + rx * Math.sin(a) + rz * Math.cos(a));
        }
      }
    }
  }

  /* ================= wiring ================= */
  function init(sc, cam) {
    scene = sc; camera = cam;
    ui = {
      root: $('editor-ov'), ins: $('ed-inspector'), insTitle: $('ed-ins-title'),
      status: $('ed-status'), loadSel: $('ed-load'), outliner: $('ed-outliner'),
      folderSel: $('ed-folder'), assetGrid: $('ed-assets'),
    };

    if (THREE.TransformControls) {
      gizmo = new THREE.TransformControls(camera, SKY.Input._canvas);
      gizmo.setSize(0.9);
      gizmo.addEventListener('dragging-changed', (e) => {
        gizmoDrag = e.value;
        if (e.value) push();                       // undo point at drag start
        else {
          const o = objects[sel];
          if (o) { bakeBlockScale(o); writeBack(o); syncInspector(); refreshOutliner(); }
        }
      });
      gizmo.addEventListener('objectChange', () => {
        const o = objects[sel];
        if (o) writeBack(o);
      });
    }

    $('tab-editor').onclick = () => { if (!SKY.Net.online) open(null); };
    $('ed-exit').onclick = exit;
    $('ed-new').onclick = () => { api.active = false; open(null); };
    $('ed-save').onclick = save;
    $('ed-export').onclick = exportJson;
    $('ed-test').onclick = testPlay;
    $('ed-addblock').onclick = addBlock;
    $('ed-addground').onclick = addGround;
    $('ed-addpad').onclick = addPad;
    $('ed-addspawn').onclick = addSpawn;
    $('ed-additem').onclick = addItem;
    $('ed-anim').onclick = (e) => {
      previewOn = !previewOn;
      e.target.classList.toggle('sel', previewOn);
      if (!previewOn) for (const o of objects) syncMeshFromData(o);
    };
    ui.loadSel.onchange = () => {
      const id = ui.loadSel.value;
      if (id) { api.active = false; open(id); }
    };
    $('ed-import').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };
    ui.ins.addEventListener('input', onInspectorInput);
    ui.ins.addEventListener('click', (e) => {
      if (e.target.dataset.k === 'cleartex') { onInspectorInput(e); return; }
      if (e.target.dataset.k === 'centermap') { centerMap(); return; }
      const sw = e.target.closest('.ed-swatch');
      if (sw) {
        const o = objects[sel];
        if (o && o.kind === 'block') {
          push();
          o.data.ptex = sw.dataset.pt || null;
          if (o.data.ptex) o.data.tex = null;   // a picked texture replaces a dropped image
          o.mesh.material = blockMaterial(o.data);
          syncInspector();
        }
      }
    });

    /* outliner clicks */
    ui.outliner.addEventListener('click', (e) => {
      const row = e.target.closest('.ed-obj');
      if (row) select(+row.dataset.i);
    });

    /* drag-scrub the number labels (Blender/Unity style) */
    let scrub = null, faceScrub = null;
    ui.ins.addEventListener('mousedown', (e) => {
      const face = e.target.closest('.ed-face');
      if (face) {
        const o = objects[sel];
        if (o && o.kind === 'block') {
          const [axis, sign] = face.dataset.f.split(',').map(Number);
          push();
          faceScrub = { o, axis, sign, lastX: e.clientX };
        }
        e.preventDefault();
        return;
      }
      const span = e.target.closest('.ed-scrub');
      if (!span) return;
      const input = span.parentNode.querySelector('input[type=number]');
      if (!input) return;
      scrub = { input, lastX: e.clientX, step: parseFloat(input.step) || 0.5 };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (faceScrub) {
        // Blender-style single-face extend: size grows, center shifts by half
        const dx = (e.clientX - faceScrub.lastX) * 0.05;
        faceScrub.lastX = e.clientX;
        const d = faceScrub.o.data;
        const ns = Math.max(0.25, d.s[faceScrub.axis] + dx);
        const grew = ns - d.s[faceScrub.axis];
        d.s[faceScrub.axis] = ns;
        d.p[faceScrub.axis] += faceScrub.sign * grew / 2;
        syncMeshFromData(faceScrub.o);
        return;
      }
      if (!scrub) return;
      const dx = e.clientX - scrub.lastX;
      scrub.lastX = e.clientX;
      scrub.input.value = (parseFloat(scrub.input.value) + dx * scrub.step * 0.25).toFixed(2);
      scrub.input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    window.addEventListener('mouseup', () => {
      if (faceScrub) { syncInspector(); refreshOutliner(); faceScrub = null; }
      scrub = null;
    });

    /* assets panel */
    SKY.Assets.onChange = () => { if (api.active) refreshAssets(); };
    ui.folderSel.onchange = () => { curFolder = ui.folderSel.value; refreshAssets(); };
    $('ed-newfolder').onclick = () => {
      const n = prompt('Folder name:');
      if (n) { curFolder = n.trim().toLowerCase().replace(/[^a-z0-9/_-]+/g, '-'); refreshAssets(); }
    };
    $('ed-addasset').onchange = (e) => {
      SKY.Assets.addFiles([...e.target.files], curFolder, () => refreshAssets());
      e.target.value = '';
    };
    ui.assetGrid.addEventListener('click', (e) => {
      const x = e.target.dataset.x;
      if (x && confirm('Delete this asset from the library?')) SKY.Assets.remove(x);
    });
    ui.assetGrid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.ed-asset');
      if (card) e.dataTransfer.setData('text/skyasset', card.dataset.id);
    });

    /* viewport mouse */
    const canvas = SKY.Input._canvas;
    let lastX = 0, lastY = 0, downX = 0, downY = 0;
    canvas.addEventListener('mousedown', (e) => {
      if (!api.active) return;
      if (e.button === 2) { looking = true; lastX = e.clientX; lastY = e.clientY; }
      if (e.button === 0) { downX = e.clientX; downY = e.clientY; }
    });
    window.addEventListener('mouseup', (e) => {
      if (!api.active) return;
      if (e.button === 2) looking = false;
      if (e.button === 0 && !gizmoDrag && (!gizmo || !gizmo.axis) &&
          Math.abs(e.clientX - downX) < 4 && Math.abs(e.clientY - downY) < 4 &&
          !e.target.closest('#editor-ov')) {
        select(pick(e.clientX, e.clientY));
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!api.active || !looking) return;
      camYaw -= (e.clientX - lastX) * 0.004;
      camPitch = SKY.U.clamp(camPitch - (e.clientY - lastY) * 0.004, -1.5, 1.5);
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('wheel', (e) => {
      if (!api.active || e.target.closest('#editor-ov')) return;
      flySpeed = SKY.U.clamp(flySpeed * (e.deltaY > 0 ? 0.85 : 1.18), 3, 80);
      status('fly speed ' + flySpeed.toFixed(0));
    }, { passive: true });

    /* hotkeys — never while flying (RMB) or typing */
    window.addEventListener('keydown', (e) => {
      if (!api.active || looking) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.ctrlKey && e.code === 'KeyZ' && !e.shiftKey) { undo(); return; }
      if (e.ctrlKey && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { redo(); return; }
      if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); save(); return; }
      if (e.ctrlKey && e.code === 'KeyC') { copySel(false); return; }
      if (e.ctrlKey && e.code === 'KeyX') { copySel(true); return; }
      if (e.ctrlKey && e.code === 'KeyV') { paste(); return; }
      if (e.ctrlKey && e.code === 'KeyD') { e.preventDefault(); duplicateSel(); return; }
      if (gizmo && sel >= 0) {
        if (e.code === 'KeyG') gizmo.setMode('translate');
        if (e.code === 'KeyR') gizmo.setMode('rotate');
        if (e.code === 'KeyS') gizmo.setMode('scale');
      }
      if (e.code === 'KeyF') dropSel();
      if (e.code === 'KeyD' && e.shiftKey) duplicateSel();
      if (e.code === 'Delete' || e.code === 'Backspace') deleteSel();
      if (e.code === 'Escape') select(-1);
      const nstep = e.shiftKey ? 0.1 : 0.5;
      if (e.code === 'ArrowLeft') nudge(-nstep, 0, 0);
      if (e.code === 'ArrowRight') nudge(nstep, 0, 0);
      if (e.code === 'ArrowUp') nudge(0, 0, -nstep);
      if (e.code === 'ArrowDown') nudge(0, 0, nstep);
      if (e.code === 'PageUp') nudge(0, nstep, 0);
      if (e.code === 'PageDown') nudge(0, -nstep, 0);
      if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
        if (gizmo) {
          gizmo.setTranslationSnap(0.5);
          gizmo.setRotationSnap(Math.PI / 12);
          gizmo.setScaleSnap(0.25);
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && gizmo) {
        gizmo.setTranslationSnap(null);
        gizmo.setRotationSnap(null);
        gizmo.setScaleSnap(null);
      }
    });

    /* dropping things on the viewport: library assets, raw files */
    window.addEventListener('dragover', (e) => { if (api.active) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!api.active) return;
      e.preventDefault();
      const assetId = e.dataTransfer.getData('text/skyasset');
      if (assetId && !e.target.closest('#editor-ov')) { placeAsset(assetId, e.clientX, e.clientY); return; }
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      if (files[0].name.endsWith('.json')) { importJson(files[0]); return; }
      // raw files land in the asset library (current folder)
      SKY.Assets.addFiles(files, curFolder, () => { refreshAssets(); status('added to ' + curFolder); });
    });
  }

  api.open = open;
  api.exit = exit;
  api.resume = resume;
  api.frame = frame;
  api.init = init;
  return api;
})();
