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
  let sel = -1;                   // primary selection (drives inspector + gizmo)
  let msel = [];                  // ALL selected indices (multi via shift-click)
  let mboxes = [];                // outline helpers for the extra selections
  let groupDrag = null;           // start transforms while group-translating
  let selBox = null;
  let history = [];               // undo stack
  let future = [];                // redo stack
  let dirty = false;              // unsaved changes since last save/autosave
  let autosaveTimer = null;
  let clipboard = null;           // { kind, json } — Ctrl+C/X/V
  let lastNudgeT = 0;
  let env = null;                 // sky dome / sun / shafts preview group
  let camYaw = 0.6, camPitch = -0.45;
  const camPos = new THREE.Vector3(24, 18, 24);
  let flySpeed = 14;
  let looking = false;
  let gizmo = null, gizmoDrag = false;
  let previewT = 0, previewOn = true;
  let paintFace = -1;   // -1 = ALL faces; 0..5 = +x,-x,top,bot,+z,-z
  let ui = null;
  const ray = new THREE.Raycaster();
  const _m = new THREE.Vector2();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();

  const api = { active: false, pendingReturn: null };

  /* ================= materials & meshes ================= */
  /* geometry UVs are world-locked (1 tile ≈ 3 units) — repeat stays 1,
     b.rep acts as a relative density override, blocks get a random texture
     offset so identical materials don't tile in visible lockstep */
  function edBlockTex(b, name) {
    const base = SKY.U.procTexture(name, 1);
    const autoRep = Math.max(2, Math.round(Math.max(b.s[0], b.s[2]) / 3));
    const density = b.rep ? b.rep / autoRep : 1;
    const seed = Math.abs(Math.round(b.p[0] * 71 + b.p[2] * 137 + b.p[1] * 29));
    const t = base.clone();
    t.needsUpdate = true;
    t.repeat.set(density, density);
    t.offset.set((seed % 97) / 97, ((seed >> 2) % 89) / 89);
    return t;
  }

  function blockMaterial(b) {
    if (b.tex) {
      const tex = new THREE.TextureLoader().load(b.tex);
      tex.encoding = THREE.sRGBEncoding;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(b.rep || 1, b.rep || 1);
      return new THREE.MeshLambertMaterial({ map: tex });
    }
    const single = () => {
      if (b.ptex && SKY.U.PROC_TEX[b.ptex]) {
        return new THREE.MeshLambertMaterial({ map: edBlockTex(b, b.ptex) });
      }
      const pal = SKY.MapData.PALETTES[b.pal];
      if (pal) {
        const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
        m.map = SKY.U.checkerTexture(pal[0], pal[1], 1);
        return m;
      }
      return new THREE.MeshLambertMaterial({ color: b.color || '#8a94a8' });
    };
    if (b.ptexF && (!b.shape || b.shape === 'box')) {
      const mats = [];
      for (let f = 0; f < 6; f++) {
        const pf = b.ptexF[f];
        mats.push(pf && SKY.U.PROC_TEX[pf]
          ? new THREE.MeshLambertMaterial({ map: edBlockTex(b, pf) })
          : single());
      }
      return mats;
    }
    return single();
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
    const isPack = (pr.asset || '').startsWith('gfx:') || (pr.asset || '').startsWith('fx:');
    const embed = def.assets[pr.asset];
    if (embed || isPack) {
      SKY.Assets.instantiate(isPack ? pr.asset : embed, (obj) => {
        if (!obj || !holder.parent) return;
        holder.remove(ph);
        holder.add(obj);
        if (entry) { entry.inner = obj; updateCollVis(entry, true); }
        if (entry && objects[sel] === entry && selBox) selBox.update();
        // world-position setup (the sea measures seabed depth per vertex)
        if (obj.userData && obj.userData.postPlace) {
          setTimeout(() => { if (holder.parent) obj.userData.postPlace(obj); }, 150);
        }
        refreshOutliner();
      }, pr.fx);
    }
    return holder;
  }

  /* ================= TERRAIN (Unity-style sculpt & paint) =================
   * def.terrains[i] = { p, size, segs, h(b64 heights), splat(b64 weights),
   * texs:[4 texture names], rep }. The editor keeps LIVE decoded arrays on
   * the object entry (o.hts / o.splat8) and encodes back after each stroke.
   * Tools: raise / lower / smooth / flatten / paint — LMB drags the brush. */
  let terra = null;         // { tool, radius, strength, chan } — sculpt mode
  let terraStroke = null;   // { o, target } while LMB is held
  let brushRing = null;
  let brushAt = null;       // last brush hit point (world)

  function buildTerrainMesh(tr, entry) {
    const segs = SKY.U.clamp(Math.round(tr.segs || 48), 8, 128);
    const size = Math.max(4, tr.size || 60);
    const n = (segs + 1) * (segs + 1);
    const hts = SKY.MapData.decodeHeights(tr.h, n);
    const splat8 = SKY.MapData.decodeSplat(tr.splat, n);
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.array[i * 3 + 1] = hts[i];
    geo.computeVertexNormals();
    geo.setAttribute('asplat', new THREE.BufferAttribute(splat8, 4, true));
    const mesh = new THREE.Mesh(geo, SKY.Map.terrainMaterial(tr));
    mesh.position.set(tr.p[0], tr.p[1], tr.p[2]);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;   // geometry mutates while sculpting
    if (entry) { entry.hts = hts; entry.splat8 = splat8; entry.geo = geo; }
    return mesh;
  }

  /* the editor mirrors terrains into SKY.World so the sea's shallow-depth
     measurement (and anything else height-based) works while editing */
  function syncWorldTerrains() {
    SKY.World.terrains.length = 0;
    for (const o of objects) {
      if (o.kind !== 'terrain') continue;
      const tr = o.data;
      SKY.World.addTerrain({ x: tr.p[0], z: tr.p[2], size: Math.max(4, tr.size || 60),
        segs: SKY.U.clamp(Math.round(tr.segs || 48), 8, 128),
        heights: o.hts, y: tr.p[1], mesh: o.mesh });
    }
  }

  function addTerrain() {
    focusPoint(_v);
    addAndSelect(def.terrains, {
      p: [_v.x, 0, _v.z], size: 60, segs: 48, h: '', splat: '',
      texs: ['sand', 'rock', 'grass', 'dirt'], rep: 10,
    });
    status('terrain added — open SCULPT in the inspector to shape it');
  }

  function enterSculpt(tool) {
    const o = objects[sel];
    if (!o || o.kind !== 'terrain') return;
    if (terra && terra.tool === tool) { exitSculpt(); return; }
    terra = terra || { radius: 7, strength: 6, chan: 0 };
    terra.tool = tool;
    if (gizmo) gizmo.detach();
    if (!brushRing) {
      brushRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 8, 40),
        new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true,
          opacity: 0.85, depthTest: false }));
      brushRing.rotation.x = -Math.PI / 2;
      brushRing.renderOrder = 6;
      brushRing.raycast = () => {};
    }
    if (!brushRing.parent) group.add(brushRing);
    brushRing.scale.setScalar(terra.radius);
    syncInspector();
    status(tool.toUpperCase() + ' — hold LMB on the terrain and drag · ESC to finish');
  }
  function exitSculpt() {
    terra = null;
    terraStroke = null;
    if (brushRing && brushRing.parent) brushRing.parent.remove(brushRing);
    if (gizmo && objects[sel]) gizmo.attach(objects[sel].mesh);
    syncInspector();
    status('');
  }

  function terrainHit(clientX, clientY) {
    const o = objects[sel];
    if (!o || o.kind !== 'terrain' || !o.mesh) return null;
    _m.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(_m, camera);
    const hits = ray.intersectObject(o.mesh, false);
    return hits.length ? hits[0].point : null;
  }

  /* one brush application (called per animation frame while the LMB is down) */
  function applyBrush(dt) {
    if (!terra || !terraStroke || !brushAt) return;
    const o = terraStroke.o;
    const tr = o.data;
    const segs = SKY.U.clamp(Math.round(tr.segs || 48), 8, 128);
    const size = Math.max(4, tr.size || 60);
    const cell = size / segs, n = segs + 1;
    const hts = o.hts, pos = o.geo.attributes.position;
    const R = terra.radius, S = terra.strength;
    const cx = (brushAt.x - tr.p[0] + size / 2) / cell;
    const cz = (brushAt.z - tr.p[2] + size / 2) / cell;
    const rg = Math.ceil(R / cell) + 1;
    const ix0 = Math.max(0, Math.floor(cx - rg)), ix1 = Math.min(segs, Math.ceil(cx + rg));
    const iz0 = Math.max(0, Math.floor(cz - rg)), iz1 = Math.min(segs, Math.ceil(cz + rg));
    let touched = false;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = (ix - cx) * cell, dz = (iz - cz) * cell;
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        const t = 1 - d / R;
        const fall = t * t * (3 - 2 * t);   // smoothstep falloff
        const i = iz * n + ix;
        if (terra.tool === 'raise') hts[i] += S * fall * dt;
        else if (terra.tool === 'lower') hts[i] -= S * fall * dt;
        else if (terra.tool === 'flatten') {
          hts[i] += (terraStroke.target - hts[i]) * Math.min(1, 6 * fall * dt);
        } else if (terra.tool === 'smooth') {
          const l = hts[iz * n + Math.max(0, ix - 1)], r = hts[iz * n + Math.min(segs, ix + 1)];
          const u = hts[Math.max(0, iz - 1) * n + ix], dn = hts[Math.min(segs, iz + 1) * n + ix];
          hts[i] += ((l + r + u + dn) / 4 - hts[i]) * Math.min(1, 8 * fall * dt);
        } else if (terra.tool === 'paint') {
          const s8 = o.splat8, b = i * 4;
          const gain = Math.min(255, 900 * fall * dt);
          s8[b + terra.chan] = Math.min(255, s8[b + terra.chan] + gain);
          // renormalize so the four weights keep summing to ~255
          const sum = s8[b] + s8[b + 1] + s8[b + 2] + s8[b + 3];
          if (sum > 255) {
            const k = 255 / sum;
            s8[b] *= k; s8[b + 1] *= k; s8[b + 2] *= k; s8[b + 3] *= k;
          }
          o.geo.attributes.asplat.needsUpdate = true;
          touched = true;
          continue;
        }
        hts[i] = SKY.U.clamp(hts[i], -80, 160);
        pos.array[i * 3 + 1] = hts[i];
        touched = true;
      }
    }
    if (touched && terra.tool !== 'paint') {
      pos.needsUpdate = true;
      o.geo.computeVertexNormals();
    }
  }

  /* stroke ended: bake the arrays back into the def + refresh dependents */
  function endStroke() {
    if (!terraStroke) return;
    const o = terraStroke.o;
    terraStroke = null;
    o.data.h = SKY.MapData.encodeHeights(o.hts);
    o.data.splat = SKY.MapData.encodeSplat(o.splat8);
    o.geo.computeBoundingSphere();
    markDirty();
    // seas re-measure their shallow tint against the new seabed
    for (const q of objects) {
      if (q.kind === 'prop' && q.inner && q.inner.userData.postPlace) {
        q.inner.userData.postPlace(q.inner);
      }
    }
  }

  /* ---- collision display: green wireframes = the game's ACTUAL solids ----
     Computed by the same code the game uses (SKY.Map.propCollisionLocal),
     so what you see in the editor is exactly what you collide with. */
  let collOn = false;
  let collMat = null, collEditMat = null;
  let collEdit = null;   // { o, i, mesh } — a custom collider box owns the gizmo
  function updateCollVis(o, invalidate) {
    if (!o || o.kind !== 'prop' || !o.mesh) return;
    if (o.collVis) {
      if (o.collVis.parent) o.collVis.parent.remove(o.collVis);
      o.collVis = null;
    }
    if (invalidate) o._collBoxes = null;
    const d = o.data;
    const show = (collOn || objects[sel] === o) && d.solid !== false;
    if (!show || !o.inner) return;
    const mode = d.coll || 'box';
    if (!collMat) {
      collMat = new THREE.MeshBasicMaterial({
        color: 0x35ff8a, wireframe: true, transparent: true, opacity: 0.5, depthTest: false });
      collEditMat = new THREE.MeshBasicMaterial({
        color: 0xffd34d, wireframe: true, transparent: true, opacity: 0.9, depthTest: false });
    }
    const g = new THREE.Group();
    g.name = 'edcoll';
    if (mode === 'custom') {
      // hand-authored boxes straight from the def (no cache — they're edited live)
      (d.boxes || []).forEach((b, i) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(
          Math.max(0.05, b.s[0]), Math.max(0.05, b.s[1]), Math.max(0.05, b.s[2])),
          collEdit && collEdit.o === o && collEdit.i === i ? collEditMat : collMat);
        m.name = 'edcoll';
        m.position.set(b.p[0], b.p[1], b.p[2]);
        const br = b.r || [0, 0, 0];
        m.rotation.set(br[0], br[1], br[2]);
        m.renderOrder = 5;
        m.raycast = () => {};
        m.userData.cbi = i;
        g.add(m);
      });
    } else {
      if (!o._collBoxes || o._collMode !== mode) {
        o._collMode = mode;
        o._collBoxes = SKY.Map.propCollisionLocal(o.inner, mode);
      }
      for (const b of o._collBoxes) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(b.s.x, b.s.y, b.s.z), collMat);
        m.name = 'edcoll';
        m.position.copy(b.c);
        m.renderOrder = 5;
        m.raycast = () => {};   // display only — never steals viewport clicks
        g.add(m);
      }
    }
    o.inner.add(g);   // inherits the holder's position/rotation/scale
    o.collVis = g;
    // the gizmo target was just rebuilt — re-attach to the fresh mesh
    if (collEdit && collEdit.o === o) {
      const m = g.children.find(ch => ch.userData.cbi === collEdit.i);
      if (m) { collEdit.mesh = m; if (gizmo) gizmo.attach(m); }
      else collEdit = null;
    }
  }
  function refreshCollVis(invalidate) { for (const o of objects) updateCollVis(o, invalidate); }

  /* ---- custom collider editing (gizmo drives one box of pr.boxes) ---- */
  function enterCollEdit(o, i) {
    if (!o || o.kind !== 'prop' || !o.data.boxes || !o.data.boxes[i]) return;
    collEdit = { o, i, mesh: null };
    updateCollVis(o);            // recolors + re-attaches the gizmo
    if (collEdit && gizmo && collEdit.mesh) {
      gizmo.attach(collEdit.mesh);
      status('editing collider box ' + (i + 1) + ' — G/R/S, click elsewhere to finish');
    }
    syncInspector();
  }
  function exitCollEdit(silent) {
    if (!collEdit) return;
    const o = collEdit.o;
    collEdit = null;
    updateCollVis(o);
    // hand the gizmo back to the selected object
    if (gizmo && objects[sel]) gizmo.attach(objects[sel].mesh);
    if (!silent) { syncInspector(); }
  }

  /* first collider = the model's own bounds, so you carve from something real */
  function seedColliderBox(o) {
    if (o.inner) {
      const b = SKY.Map.propCollisionLocal(o.inner, 'box');
      if (b.length) {
        return { p: [+b[0].c.x.toFixed(2), +b[0].c.y.toFixed(2), +b[0].c.z.toFixed(2)],
                 s: [+b[0].s.x.toFixed(2), +b[0].s.y.toFixed(2), +b[0].s.z.toFixed(2)],
                 r: [0, 0, 0] };
      }
    }
    return { p: [0, 1, 0], s: [2, 2, 2], r: [0, 0, 0] };
  }
  /* live gizmo motion -> box def (scale baked on drag end) */
  function writeBackCollider(final) {
    if (!collEdit || !collEdit.mesh) return;
    const { o, i, mesh } = collEdit;
    const b = o.data.boxes[i];
    b.p = [+mesh.position.x.toFixed(3), +mesh.position.y.toFixed(3), +mesh.position.z.toFixed(3)];
    b.r = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z];
    if (final && (mesh.scale.x !== 1 || mesh.scale.y !== 1 || mesh.scale.z !== 1)) {
      b.s = [Math.max(0.05, b.s[0] * mesh.scale.x),
             Math.max(0.05, b.s[1] * mesh.scale.y),
             Math.max(0.05, b.s[2] * mesh.scale.z)].map(v => +v.toFixed(3));
      mesh.scale.set(1, 1, 1);
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BoxGeometry(b.s[0], b.s[1], b.s[2]);
    }
    markDirty();
    if (final) syncInspector();
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
    for (const tr of def.terrains) { const entry = { kind: 'terrain', data: tr, mesh: null }; entry.mesh = buildTerrainMesh(tr, entry); group.add(entry.mesh); objects.push(entry); }
    syncWorldTerrains();
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
    const LM = def.light !== undefined ? def.light : 1;   // global light dial
    const hemi = new THREE.HemisphereLight(M.hemi[0], M.hemi[1], M.hemi[2] * LM);
    const sun = new THREE.DirectionalLight(M.sun[0], M.sun[1] * LM);
    sun.position.set(M.sun[2][0], M.sun[2][1], M.sun[2][2]);
    sun.castShadow = true;                       // the preview matches the game
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
    sun.shadow.camera.far = 240;
    sun.shadow.bias = -0.0004;
    if (M.fill[0]) {
      const fill = new THREE.DirectionalLight(M.fill[0], M.fill[1] * LM);
      fill.position.set(...(M.fill[2] || [-40, 30, -35]));
      lights.push(fill);
      scene.add(fill);
    }
    lights.push(hemi, sun);
    scene.add(hemi, sun);
    if (def.fog) {
      scene.fog = new THREE.Fog(new THREE.Color(def.fog.color).getHex(),
        def.fog.near !== undefined ? def.fog.near : 30,
        def.fog.far !== undefined ? def.fog.far : 150);
    } else {
      scene.fog = new THREE.Fog(new THREE.Color(M.fog[0]).getHex(), M.fog[1], M.fog[2]);
    }
    // FULL environment preview — same dome / sun / moon / shafts as in-game
    env = new THREE.Group();
    scene.add(env);
    scene.background = null;
    const S = def.skyc
      ? [def.skyc.top, def.skyc.mid, def.skyc.hor, !!def.skyc.stars]
      : SKY.MapData.SKIES[def.sky];
    env.add(makeDome(S[0], S[1], S[2], S[3], !!def.fog));
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
    const shaftsOn = (def.shafts === undefined || def.shafts === null)
      ? !!M.shafts : !!def.shafts;
    if (shaftsOn) {
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

  /* gradient sky dome — same recipe as the game's. `fogged` lets the map's
     fog override eat the sky so the creator sees the real effect */
  function makeDome(top, mid, horizon, stars, fogged) {
    const g = new THREE.Group();
    const c = document.createElement('canvas');
    c.width = 32; c.height = 256;
    const ctx = c.getContext('2d');
    const gr = ctx.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, top); gr.addColorStop(0.55, mid); gr.addColorStop(1, horizon);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, 32, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    // depthWrite off — same reason as the game dome: writing dome depth
    // slices the sun/moon sprites near the screen edges
    g.add(new THREE.Mesh(new THREE.SphereGeometry(380, 24, 14),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: !!fogged, depthWrite: false })));
    if (stars) {
      const sc = document.createElement('canvas');
      sc.width = sc.height = 512;
      const sg = sc.getContext('2d');
      for (let i = 0; i < 240; i++) {
        sg.fillStyle = `rgba(255,255,255,${SKY.U.rand(0.3, 1)})`;
        sg.fillRect(Math.random() * 512, Math.random() * 320, SKY.U.rand(1, 2.4), SKY.U.rand(1, 2.4));
      }
      g.add(new THREE.Mesh(new THREE.SphereGeometry(370, 24, 14),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), side: THREE.BackSide, transparent: true, fog: !!fogged, depthWrite: false })));
    }
    return g;
  }

  function labelOf(o, i) {
    if (o.kind === 'block') return 'Block · ' + o.data.s.map(v => +v.toFixed(1)).join('×');
    if (o.kind === 'pad') return 'Jump pad';
    if (o.kind === 'terrain') return 'Terrain · ' + (+(o.data.size || 60)).toFixed(0) + 'm';
    if (o.kind === 'spawn') return 'Spawn';
    if (o.kind === 'item') {
      const it = o.data.item;
      if (it === 'mix' && o.data.mix) {
        const parts = ['common', 'rare', 'epic']
          .filter(r => (o.data.mix[r] || 0) > 0)
          .map(r => (o.data.mix[r] || 0) + '% ' + r);
        return 'Item · ' + (parts.join(' / ') || 'mix');
      }
      if (it && it.startsWith('r:')) return 'Item · random ' + it.slice(2);
      return 'Item · ' + (it || 'random');
    }
    const a = def.assets[o.data.asset] || SKY.Assets.get(o.data.asset);
    return 'Prop · ' + (a ? a.name : '?');
  }

  /* ================= outliner ================= */
  function refreshOutliner() {
    ui.outliner.innerHTML = `<div class="ed-obj${sel < 0 ? ' sel' : ''}" data-i="-1">⚙ Map settings</div>` +
      objects.map((o, i) =>
        `<div class="ed-obj${i === sel ? ' sel' : msel.indexOf(i) >= 0 ? ' msel' : ''}" data-i="${i}">${labelOf(o, i)}</div>`).join('');
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
    } else if (o.kind === 'terrain') {
      d.p = [m.position.x, m.position.y, m.position.z];
      m.rotation.set(0, 0, 0); m.scale.setScalar(1);
      syncWorldTerrains();
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

  function updateSelVisuals() {
    if (collEdit) exitCollEdit(true);   // any selection action ends collider editing
    if (selBox) { group.remove(selBox); selBox = null; }
    for (const b of mboxes) group.remove(b);
    mboxes = [];
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
          : (o.kind === 'item' || o.kind === 'terrain') ? ['translate'] : ['translate', 'rotate'];
        if (allowed.indexOf(gizmo.mode) < 0) gizmo.setMode('translate');
      }
    }
    for (const i of msel) {
      if (i === sel || !objects[i]) continue;
      const b = new THREE.BoxHelper(objects[i].mesh, 0x6fc3ff);
      group.add(b);
      mboxes.push(b);
    }
    refreshCollVis();   // the selected prop always shows its real collision
  }

  function select(i) {
    // changing selection always leaves sculpt mode
    if (terra && (!objects[i] || objects[i] !== objects[sel])) {
      terra = null;
      terraStroke = null;
      if (brushRing && brushRing.parent) brushRing.parent.remove(brushRing);
    }
    sel = i;
    msel = i >= 0 ? [i] : [];
    updateSelVisuals();
    syncInspector();
    refreshOutliner();
  }

  /* shift-click: add/remove from the multi-selection; the last one clicked
     becomes primary (gizmo handle + inspector) */
  function toggleSel(i) {
    if (i < 0 || !objects[i]) return;
    const at = msel.indexOf(i);
    if (at >= 0) msel.splice(at, 1);
    else msel.push(i);
    sel = msel.length ? msel[msel.length - 1] : -1;
    updateSelVisuals();
    syncInspector();
    refreshOutliner();
    if (msel.length > 1) status(msel.length + ' selected — drag moves all · del deletes all');
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
      if (o.kind !== 'block' && o.kind !== 'terrain') continue;
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
    if (cut) { deleteSel(); status('cut'); } else status('copied ' + o.kind);
  }
  function paste() {
    if (!clipboard) { status('clipboard empty'); return; }
    // paste IN PLACE — an offset broke axis alignment; move it with G after
    const item = JSON.parse(clipboard.json);
    const arr = { block: def.blocks, pad: def.pads, spawn: def.spawns, item: def.items, prop: def.props, terrain: def.terrains }[clipboard.kind];
    push();
    arr.push(item);
    rebuild();
    select(objects.findIndex(o => o.data === item));
    status('pasted');
  }

  /* arrow-key nudging (one undo point per burst) — moves the whole selection */
  function nudge(dx, dy, dz) {
    if (!msel.length) return;
    if (performance.now() - lastNudgeT > 900) push();
    lastNudgeT = performance.now();
    for (const i of msel) {
      const o = objects[i];
      if (!o) continue;
      o.data.p[0] += dx; o.data.p[1] += dy; o.data.p[2] += dz;
      syncMeshFromData(o);
    }
    for (const b of mboxes) b.update();
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
    for (const arr of [def.blocks, def.pads, def.spawns, def.items, def.props, def.terrains]) {
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

  function arrOf(o) { return { block: def.blocks, pad: def.pads, spawn: def.spawns, item: def.items, prop: def.props, terrain: def.terrains }[o.kind]; }

  function duplicateSel() {
    if (msel.length > 1) {
      push();
      const copies = [];
      for (const i of msel) {
        const o = objects[i];
        if (!o) continue;
        const copy = JSON.parse(JSON.stringify(o.data));
        copy.p = [copy.p[0] + 2, copy.p[1], copy.p[2] + 2];
        arrOf(o).push(copy);
        copies.push(copy);
      }
      rebuild();
      msel = [];
      objects.forEach((o, ix) => { if (copies.indexOf(o.data) >= 0) msel.push(ix); });
      sel = msel.length ? msel[msel.length - 1] : -1;
      updateSelVisuals(); syncInspector(); refreshOutliner();
      status(copies.length + ' duplicated');
      return;
    }
    const o = objects[sel];
    if (!o) return;
    const copy = JSON.parse(JSON.stringify(o.data));
    copy.p = [copy.p[0] + 2, copy.p[1], copy.p[2] + 2];
    addAndSelect(arrOf(o), copy);
    status('duplicated');
  }
  function deleteSel() {
    if (msel.length > 1) {
      const del = msel.map(i => objects[i]).filter(Boolean);
      const nSpawns = del.filter(o => o.kind === 'spawn').length;
      if (def.spawns.length - nSpawns < 2) { status('keep at least 2 spawns'); return; }
      push();
      for (const o of del) {
        const arr = arrOf(o), ix = arr.indexOf(o.data);
        if (ix >= 0) arr.splice(ix, 1);
      }
      rebuild();
      select(-1);
      status(del.length + ' deleted');
      return;
    }
    const o = objects[sel];
    if (!o) return;
    // blocks can all go — props carry collision now (a props-only map is fine)
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
    } else if (o.kind === 'terrain') {
      m.position.set(d.p[0], d.p[1], d.p[2]);
      syncWorldTerrains();
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
        ${numRow('Light %', Math.round((def.light !== undefined ? def.light : 1) * 100), 'light', 10)}
        <div class="ed-row"><span>Sun godrays</span>
          <input type="checkbox" data-k="shaftsOn" ${((def.shafts === undefined || def.shafts === null)
            ? SKY.MapData.MOODS[def.mood].shafts : def.shafts) ? 'checked' : ''}></div>
        <div class="ed-row"><span>Fog override</span>
          <input type="checkbox" data-k="fogOn" ${def.fog ? 'checked' : ''}></div>` +
        (def.fog ? `
        <div class="ed-row"><span>Fog color</span><input type="color" data-k="fogCol" value="${def.fog.color}"></div>
        ${numRow('Fog near', def.fog.near !== undefined ? def.fog.near : 30, 'fogNear', 5)}
        ${numRow('Fog far', def.fog.far !== undefined ? def.fog.far : 150, 'fogFar', 10)}
        <div class="ed-hint">Fog starts at NEAR and is solid past FAR (the sky fades with it).
        Keep FAR above ~400 for a light haze that leaves the sky visible.</div>` : '') + `
        <div class="ed-row"><span>Custom sky</span>
          <input type="checkbox" data-k="skycOn" ${def.skyc ? 'checked' : ''}></div>` +
        (def.skyc ? `
        <div class="ed-row"><span>Sky top</span><input type="color" data-k="skycTop" value="${def.skyc.top}"></div>
        <div class="ed-row"><span>Sky mid</span><input type="color" data-k="skycMid" value="${def.skyc.mid}"></div>
        <div class="ed-row"><span>Horizon</span><input type="color" data-k="skycHor" value="${def.skyc.hor}"></div>
        <div class="ed-row"><span>Stars</span><input type="checkbox" data-k="skycStars" ${def.skyc.stars ? 'checked' : ''}></div>
        <div class="ed-row"><span>Clouds</span><input type="checkbox" data-k="skycClouds" ${def.skyc.clouds ? 'checked' : ''}></div>` +
        (def.skyc.clouds ? `
        <div class="ed-row"><span>Cloud color</span><input type="color" data-k="skycCloudCol" value="${def.skyc.cloudCol || '#ffffff'}"></div>
        ${numRow('Cloud count', def.skyc.cloudN !== undefined ? def.skyc.cloudN : 10, 'skycCloudN', 2)}` : '') : '') + `
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
      h += `<div class="ed-row"><span>Extend faces <small>drag</small></span></div>
        <div class="ed-row ed-faces">
          <span class="ed-face" data-f="0,-1">−X</span><span class="ed-face" data-f="0,1">+X</span>
          <span class="ed-face" data-f="1,-1">−Y</span><span class="ed-face" data-f="1,1">+Y</span>
          <span class="ed-face" data-f="2,-1">−Z</span><span class="ed-face" data-f="2,1">+Z</span>
        </div>`;
      h += `<div class="ed-row"><span>Extrude <small>new flush block</small></span></div>
        <div class="ed-row ed-faces">
          <span class="ed-face ed-ext" data-e="0,-1">−X</span><span class="ed-face ed-ext" data-e="0,1">+X</span>
          <span class="ed-face ed-ext" data-e="1,-1">−Y</span><span class="ed-face ed-ext" data-e="1,1">+Y</span>
          <span class="ed-face ed-ext" data-e="2,-1">−Z</span><span class="ed-face ed-ext" data-e="2,1">+Z</span>
        </div>`;
      h += numRow('Rot X°', d.r[0] * 180 / Math.PI, 'r0', 5) + numRow('Rot Y°', d.r[1] * 180 / Math.PI, 'r1', 5) + numRow('Rot Z°', d.r[2] * 180 / Math.PI, 'r2', 5);
      h += `<div class="ed-row"><span>Palette</span><select data-k="pal">
        <option value=""${!d.pal ? ' selected' : ''}>flat color</option>
        ${Object.keys(SKY.MapData.PALETTES).map(p => `<option value="${p}"${d.pal === p ? ' selected' : ''}>${p}</option>`).join('')}
      </select></div>`;
      h += `<div class="ed-row"><span>Color</span><input type="color" data-k="color" value="${d.color || '#8a94a8'}"></div>`;
      // which face the next texture click paints (boxes only)
      const faceNames = ['ALL', '+X', '−X', 'TOP', 'BOT', '+Z', '−Z'];
      if (!d.shape || d.shape === 'box') {
        h += `<div class="ed-row"><span>Paint face</span></div>
          <div class="ed-row ed-faces">
            ${faceNames.map((n, i) =>
              `<span class="ed-face ed-pf${paintFace === i - 1 ? ' sel' : ''}" data-pf="${i - 1}">${n}</span>`).join('')}
          </div>`;
      }
      const curPt = paintFace >= 0 ? (d.ptexF || {})[paintFace] : d.ptex;
      h += `<div class="ed-row"><span>Texture</span></div>
        <div class="ed-row ed-swatches">
          <span class="ed-swatch${!curPt ? ' sel' : ''}" data-pt="" title="none">✕</span>
          ${Object.keys(SKY.U.PROC_TEX).map(t =>
            `<span class="ed-swatch${curPt === t ? ' sel' : ''}" data-pt="${t}" title="${t}" style="background-image:url(${SKY.U.procThumb(t)})"></span>`).join('')}
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
    } else if (o.kind === 'item') {
      const loot = (SKY.Loot && SKY.Loot.ITEMS) || [];
      h += `<div class="ed-row"><span>Item</span><select data-k="itemid">
        <option value=""${!d.item ? ' selected' : ''}>random (any)</option>
        <option value="r:common"${d.item === 'r:common' ? ' selected' : ''}>RANDOM COMMON</option>
        <option value="r:rare"${d.item === 'r:rare' ? ' selected' : ''}>RANDOM RARE</option>
        <option value="r:epic"${d.item === 'r:epic' ? ' selected' : ''}>RANDOM EPIC</option>
        <option value="mix"${d.item === 'mix' ? ' selected' : ''}>CUSTOM MIX %…</option>
        ${loot.map(it => `<option value="${it.id}"${d.item === it.id ? ' selected' : ''}>
          ${(it.name || it.id).toUpperCase()} · ${it.rarity}</option>`).join('')}
      </select></div>`;
      if (d.item === 'mix') {
        const mx = d.mix || {};
        h += numRow('Common %', mx.common || 0, 'mixc', 5)
          + numRow('Rare %', mx.rare || 0, 'mixr', 5)
          + numRow('Epic %', mx.epic || 0, 'mixe', 5);
      }
      h += numRow('Respawn s', d.respawn !== undefined && d.respawn > 0 ? d.respawn : 20, 'respawn', 5);
      h += `<div class="ed-hint">Spawns here at round start and returns RESPAWN seconds
        after someone grabs it. RANDOM rolls a new item each time; CUSTOM MIX
        rolls the rarity by your percentages (e.g. 80 rare / 20 epic).</div>`;
    } else if (o.kind === 'terrain') {
      const texList = ['sand', 'rock', 'grass', 'dirt', 'gravel', 'cliff', 'scree',
        'mossrock', 'stone', 'snow', 'concrete', 'metal', 'planks', 'tiles',
        'lava', 'brick', 'marble', 'camo'];
      h += numRow('Size m', d.size || 60, 'tsize', 5)
        + numRow('Detail', d.segs || 48, 'tsegs', 8)
        + numRow('Tex tiling', d.rep || 10, 'trep', 1);
      const texs = d.texs || ['sand', 'rock', 'grass', 'dirt'];
      for (let ti = 0; ti < 4; ti++) {
        h += `<div class="ed-row"><span>Texture ${ti + 1}</span><select data-k="ttex${ti}">
          ${texList.map(t => `<option value="${t}"${texs[ti] === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select></div>`;
      }
      const tool = terra ? terra.tool : '';
      h += `<div class="ed-row"><span>Sculpt</span></div>
        <div class="ed-row ed-faces">
          ${[['raise', '▲ RAISE'], ['lower', '▼ LOWER'], ['smooth', '≈ SMOOTH'],
             ['flatten', '▬ FLAT'], ['paint', '🖌 PAINT']].map(([t, l]) =>
            `<span class="ed-face${tool === t ? ' sel' : ''}" data-tt="${t}">${l}</span>`).join('')}
        </div>`;
      if (terra) {
        h += numRow('Brush size', terra.radius, 'tbrush', 1)
          + numRow('Strength', terra.strength, 'tstr', 1);
        if (terra.tool === 'paint') {
          h += `<div class="ed-row"><span>Paint with</span></div>
            <div class="ed-row ed-faces">
              ${texs.map((t, ti) =>
                `<span class="ed-face${terra.chan === ti ? ' sel' : ''}" data-tc="${ti}">${t}</span>`).join('')}
            </div>`;
        }
      }
      h += `<div class="ed-hint">TERRAIN: pick a sculpt tool, then HOLD LMB on the
        terrain and drag — Unity-style. RAISE/LOWER shape hills and sea
        trenches, SMOOTH softens, FLAT levels to the click height, PAINT blends
        the four textures. ESC exits the brush. Collision matches exactly.
        Drop an fx:sea ABOVE a bowl of terrain for a swimmable beach.</div>`;
    } else if (o.kind === 'prop') {
      h += numRow('Rot Y°', (d.r ? d.r[1] : 0) * 180 / Math.PI, 'pr1', 5);
      h += numRow('Scale', d.scale || 1, 'pscale', 0.1);
      h += `<div class="ed-row"><span>Solid</span><input type="checkbox" data-k="psolid"${d.solid !== false ? ' checked' : ''}></div>`;
      if (d.solid !== false) {
        h += `<div class="ed-row"><span>Collision</span><select data-k="pcoll">
          <option value=""${!d.coll ? ' selected' : ''}>box (whole bounds)</option>
          <option value="mesh"${d.coll === 'mesh' ? ' selected' : ''}>mesh (fits the shape)</option>
          <option value="custom"${d.coll === 'custom' ? ' selected' : ''}>custom boxes</option>
        </select></div>`;
        if (d.coll === 'custom') {
          const boxes = d.boxes || [];
          h += `<div class="ed-row"><span>Collider boxes</span>
            <button class="ed-mini" data-k="cbadd">+ add box</button></div>`;
          boxes.forEach((b, i) => {
            const on = collEdit && collEdit.o === o && collEdit.i === i;
            h += `<div class="ed-row"><span>box ${i + 1}${on ? ' ✎' : ''}</span><span>
              <button class="ed-mini" data-cbe="${i}">${on ? 'done' : 'edit'}</button>
              <button class="ed-mini" data-cbx="${i}">×</button></span></div>`;
          });
          if (collEdit && collEdit.o === o && boxes[collEdit.i]) {
            const b = boxes[collEdit.i];
            const br = b.r || [0, 0, 0];
            h += numRow('Box X', b.p[0], 'cbp0') + numRow('Box Y', b.p[1], 'cbp1')
              + numRow('Box Z', b.p[2], 'cbp2')
              + numRow('Box W', b.s[0], 'cbs0') + numRow('Box H', b.s[1], 'cbs1')
              + numRow('Box L', b.s[2], 'cbs2')
              + numRow('Box RX°', br[0] * 180 / Math.PI, 'cbr0', 5)
              + numRow('Box RY°', br[1] * 180 / Math.PI, 'cbr1', 5)
              + numRow('Box RZ°', br[2] * 180 / Math.PI, 'cbr2', 5);
          }
          h += `<div class="ed-hint">CUSTOM: you author the collider boxes yourself
          (e.g. give a crane a walkable top only). EDIT puts the gizmo on a box —
          G/R/S move/rotate/resize it; boxes live in the prop's local space so
          they follow the prop everywhere.</div>`;
        } else {
          h += `<div class="ed-hint">MESH builds collision from the model's real shape —
          ramps, stacked crates and openings become walkable/passable. The green
          wireframe (shown on selection, or COLL up top) is the exact result.</div>`;
        }
      }
      const isDoor = d.door !== undefined ? d.door : /door-rotate/.test(d.asset || '');
      h += `<div class="ed-row"><span>Door <small>use key opens</small></span>
        <input type="checkbox" data-k="pdoor"${isDoor ? ' checked' : ''}></div>`;
      // light / atmosphere entities expose their look settings
      if ((d.asset || '').startsWith('fx:')) {
        const fx = { ...SKY.Assets.fxDefaults(d.asset), ...(d.fx || {}) };
        h += `<div class="ed-row"><span>Color</span><input type="color" data-k="fxcolor" value="${fx.color}"></div>`;
        if (fx.power !== undefined) h += numRow('Intensity', fx.power, 'fxpower', 0.1);
        if (fx.range !== undefined) h += numRow('Range', fx.range, 'fxrange', 1);
        if (fx.alpha !== undefined) h += numRow('Haze', fx.alpha, 'fxalpha', 0.02);
        if (fx.width !== undefined) h += numRow('Width', fx.width, 'fxwidth', 0.5);
        if (fx.height !== undefined) h += numRow('Height', fx.height, 'fxheight', 1);
        if (fx.size !== undefined) h += numRow('Size', fx.size, 'fxsize', 1);
        // hanging rope: sway on/off (off = dead straight, e.g. flag poles)
        if (fx.sway !== undefined) {
          h += `<div class="ed-row"><span>Sway</span>
            <input type="checkbox" data-k="fxsway"${fx.sway ? ' checked' : ''}></div>`;
        }
        // backdrop mountain: summits / variation / snowline
        if (fx.peaks !== undefined) h += numRow('Peaks', fx.peaks, 'fxpeaks', 1);
        if (fx.seed !== undefined) h += numRow('Seed', fx.seed, 'fxseed', 1);
        if (fx.snow !== undefined) h += numRow('Snow 0–1', fx.snow, 'fxsnow', 0.1);
        // sea life: school headcount + swim pace
        if (fx.count !== undefined) h += numRow('Count', fx.count, 'fxcount', 1);
        if (fx.speed !== undefined && fx.deepAlpha === undefined) {
          h += numRow('Speed ×', fx.speed, 'fxspeed', 0.1);
        }
        // WATER v3 (fx:sea): look + swim-feel dials
        if (fx.deepAlpha !== undefined) {
          h += numRow('Deep opacity', fx.deepAlpha, 'fxdeepa', 0.05)
            + `<div class="ed-row"><span>Shallow tint</span><input type="color" data-k="fxshallow" value="${fx.shallow}"></div>`
            + numRow('Shallow opacity', fx.shallowAlpha, 'fxshalla', 0.05)
            + numRow('Depth fade m', fx.fade, 'fxfade', 1)
            + numRow('Swim drag', fx.drag, 'fxdrag', 0.2)
            + numRow('Sink rate', fx.gravity, 'fxgrav', 0.05)
            + numRow('Swim speed ×', fx.speed, 'fxspeed', 0.05)
            + numRow('Jump out ×', fx.jumpOut, 'fxjumpout', 0.1)
            + numRow('Oxygen s', fx.oxygen !== undefined ? fx.oxygen : 12, 'fxoxy', 1)
            + numRow('Currents', fx.currents !== undefined ? fx.currents : 10, 'fxcurn', 1)
            + numRow('Current power', fx.currentPower !== undefined ? fx.currentPower : 26, 'fxcurp', 2)
            + `<div class="ed-hint">WATER: players SWIM inside it (forward dives where
            you look, SPACE up / CTRL down, SPACE at the surface jumps out).
            Shallow areas over a sculpted seabed pick up the SHALLOW TINT and
            turn clearer — pair it with a TERRAIN for beaches.</div>`;
        }
        // event timing (sea events: tsunami / triangle / kraken / shark)
        if (fx.start !== undefined) h += numRow('Starts at s', fx.start, 'fxstart', 5);
        if (fx.every !== undefined) h += numRow('Every s', fx.every, 'fxevery', 5);
        if (fx.dur !== undefined) h += numRow('Duration s', fx.dur, 'fxdur', 1);
        if (fx.chance !== undefined) h += numRow('Chance %', fx.chance, 'fxchance', 10);
        if (fx.start !== undefined) {
          h += `<div class="ed-hint">Event: first fires STARTS-AT seconds into the round,
          then repeats EVERY seconds, staying active for DURATION. CHANCE rolls
          per cycle (same result for every player). Place several markers for
          random-feeling spawns.</div>`;
        }
        // tip: Rot X/Z steer spot lights — rotate via the raw fields
        if (d.asset === 'fx:spot') {
          h += numRow('Tilt X°', (d.r ? d.r[0] : 0) * 180 / Math.PI, 'pr0', 5)
            + numRow('Tilt Z°', (d.r ? d.r[2] : 0) * 180 / Math.PI, 'pr2', 5);
        }
      }
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
      else if (k === 'light') {
        def.light = SKY.U.clamp((parseFloat(e.target.value) || 100) / 100, 0.05, 2);
        applyMood();
      }
      else if (k === 'shaftsOn') { def.shafts = e.target.checked; applyMood(); }
      else if (k === 'fogOn') {
        def.fog = e.target.checked ? { color: '#a8bede', near: 30, far: 150 } : null;
        applyMood();
        syncInspector();
      }
      else if (k === 'fogCol' && def.fog) { def.fog.color = e.target.value; applyMood(); }
      else if (k === 'fogNear' && def.fog) {
        def.fog.near = SKY.U.clamp(parseFloat(e.target.value) || 0, 0, 900);
        if (def.fog.far <= def.fog.near) def.fog.far = def.fog.near + 10;
        applyMood();
      }
      else if (k === 'fogFar' && def.fog) {
        def.fog.far = SKY.U.clamp(parseFloat(e.target.value) || 150,
          (def.fog.near || 0) + 5, 1000);
        applyMood();
      }
      else if (k === 'skycOn') {
        def.skyc = e.target.checked
          ? { top: '#2f5da8', mid: '#7ba4d8', hor: '#ffd9a4', stars: false, clouds: true, cloudCol: '#ffffff' }
          : null;
        applyMood();
        syncInspector();
      }
      else if (k.indexOf('skyc') === 0 && def.skyc) {
        if (k === 'skycTop') def.skyc.top = e.target.value;
        else if (k === 'skycMid') def.skyc.mid = e.target.value;
        else if (k === 'skycHor') def.skyc.hor = e.target.value;
        else if (k === 'skycStars') def.skyc.stars = e.target.checked;
        else if (k === 'skycClouds') { def.skyc.clouds = e.target.checked; syncInspector(); }
        else if (k === 'skycCloudCol') def.skyc.cloudCol = e.target.value;
        else if (k === 'skycCloudN') {
          def.skyc.cloudN = SKY.U.clamp(Math.round(parseFloat(e.target.value) || 10), 0, 40);
        }
        applyMood();
      }
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
    else if (k === 'itemid') {
      d.item = e.target.value;
      if (d.item === 'mix' && !d.mix) d.mix = { common: 50, rare: 35, epic: 15 };
      refreshOutliner(); syncInspector();   // mix rows appear/disappear
    }
    else if (k === 'mixc') { d.mix = d.mix || {}; d.mix.common = SKY.U.clamp(num || 0, 0, 100); refreshOutliner(); }
    else if (k === 'mixr') { d.mix = d.mix || {}; d.mix.rare = SKY.U.clamp(num || 0, 0, 100); refreshOutliner(); }
    else if (k === 'mixe') { d.mix = d.mix || {}; d.mix.epic = SKY.U.clamp(num || 0, 0, 100); refreshOutliner(); }
    else if (k === 'respawn') d.respawn = SKY.U.clamp(num || 20, 3, 300);
    else if (k === 'pr1') { d.r = d.r || [0, 0, 0]; d.r[1] = num * Math.PI / 180; }
    else if (k === 'pr0') { d.r = d.r || [0, 0, 0]; d.r[0] = num * Math.PI / 180; }
    else if (k === 'pr2') { d.r = d.r || [0, 0, 0]; d.r[2] = num * Math.PI / 180; }
    else if (k === 'pscale') d.scale = Math.max(0.05, num);
    else if (k === 'psolid') { d.solid = e.target.checked; updateCollVis(o); syncInspector(); }
    else if (k === 'pcoll') {
      d.coll = e.target.value || null;
      exitCollEdit(true);
      if (d.coll === 'custom' && (!d.boxes || !d.boxes.length)) d.boxes = [seedColliderBox(o)];
      updateCollVis(o, true);
      syncInspector();
    }
    else if (k.indexOf('cbp') === 0 || k.indexOf('cbs') === 0 || k.indexOf('cbr') === 0) {
      if (collEdit && collEdit.o === o && d.boxes && d.boxes[collEdit.i]) {
        const b = d.boxes[collEdit.i];
        const ax = +k[3];
        if (k[1] === 'b' && k[2] === 'p') b.p[ax] = num;
        else if (k[2] === 's') b.s[ax] = Math.max(0.05, num);
        else if (k[2] === 'r') { b.r = b.r || [0, 0, 0]; b.r[ax] = num * Math.PI / 180; }
        updateCollVis(o);
      }
    }
    else if (k === 'pdoor') d.door = e.target.checked;
    else if (k === 'tsize' || k === 'tsegs' || k === 'trep' || k.indexOf('ttex') === 0) {
      // terrain shape/looks: resample heights on size/detail change so the
      // sculpt survives, then rebuild the mesh in place
      if (o.kind !== 'terrain') return;
      if (k === 'tsize') d.size = SKY.U.clamp(num || 60, 10, 400);
      else if (k === 'tsegs') {
        const oldSegs = SKY.U.clamp(Math.round(d.segs || 48), 8, 128);
        const newSegs = SKY.U.clamp(Math.round(num || 48), 8, 128);
        if (newSegs !== oldSegs && o.hts) {
          const on = oldSegs + 1, nn = newSegs + 1;
          const out = new Float32Array(nn * nn);
          for (let z = 0; z < nn; z++) {
            for (let x = 0; x < nn; x++) {
              const fx = (x / newSegs) * oldSegs, fz = (z / newSegs) * oldSegs;
              const ix = Math.min(oldSegs - 1, Math.floor(fx)), iz = Math.min(oldSegs - 1, Math.floor(fz));
              const ax = fx - ix, az = fz - iz;
              out[z * nn + x] =
                (o.hts[iz * on + ix] * (1 - ax) + o.hts[iz * on + ix + 1] * ax) * (1 - az) +
                (o.hts[(iz + 1) * on + ix] * (1 - ax) + o.hts[(iz + 1) * on + ix + 1] * ax) * az;
            }
          }
          d.h = SKY.MapData.encodeHeights(out);
          d.splat = '';   // weights don't resample cleanly — repaint
        }
        d.segs = newSegs;
      }
      else if (k === 'trep') d.rep = SKY.U.clamp(Math.round(num || 10), 1, 80);
      else d.texs = Object.assign(d.texs || ['sand', 'rock', 'grass', 'dirt'],
        { [+k[4]]: e.target.value });
      markDirty();
      rebuildTerrainMesh(o);
      return;
    }
    else if (k === 'tbrush') { if (terra) { terra.radius = SKY.U.clamp(num || 7, 1, 40); if (brushRing) brushRing.scale.setScalar(terra.radius); } return; }
    else if (k === 'tstr') { if (terra) terra.strength = SKY.U.clamp(num || 6, 0.5, 40); return; }
    else if (k.indexOf('fx') === 0 && o.kind === 'prop') {
      d.fx = { ...SKY.Assets.fxDefaults(d.asset), ...(d.fx || {}) };
      if (k === 'fxcolor') d.fx.color = e.target.value;
      else if (k === 'fxpower') d.fx.power = Math.max(0, num);
      else if (k === 'fxrange') d.fx.range = Math.max(1, num);
      else if (k === 'fxalpha') d.fx.alpha = SKY.U.clamp(num, 0.01, 0.6);
      else if (k === 'fxwidth') d.fx.width = Math.max(0.5, num);
      else if (k === 'fxheight') d.fx.height = Math.max(1, num);
      else if (k === 'fxsize') d.fx.size = Math.max(1, num);
      else if (k === 'fxstart') d.fx.start = Math.max(0, num);
      else if (k === 'fxevery') d.fx.every = Math.max(5, num);
      else if (k === 'fxdur') d.fx.dur = Math.max(1, num);
      else if (k === 'fxchance') d.fx.chance = SKY.U.clamp(num, 0, 100);
      else if (k === 'fxcount') d.fx.count = SKY.U.clamp(Math.round(num), 1, 30);
      else if (k === 'fxsway') d.fx.sway = e.target.checked ? 1 : 0;
      else if (k === 'fxpeaks') d.fx.peaks = SKY.U.clamp(Math.round(num), 1, 6);
      else if (k === 'fxseed') d.fx.seed = Math.round(num) || 1;
      else if (k === 'fxsnow') d.fx.snow = SKY.U.clamp(num, 0, 1);
      else if (k === 'fxdeepa') d.fx.deepAlpha = SKY.U.clamp(num, 0.05, 0.98);
      else if (k === 'fxshallow') d.fx.shallow = e.target.value;
      else if (k === 'fxshalla') d.fx.shallowAlpha = SKY.U.clamp(num, 0.02, 0.98);
      else if (k === 'fxfade') d.fx.fade = SKY.U.clamp(num, 0.5, 60);
      else if (k === 'fxdrag') d.fx.drag = SKY.U.clamp(num, 0, 10);
      else if (k === 'fxgrav') d.fx.gravity = SKY.U.clamp(num, -1, 2);
      else if (k === 'fxspeed') d.fx.speed = SKY.U.clamp(num, 0.1, 3);
      else if (k === 'fxjumpout') d.fx.jumpOut = SKY.U.clamp(num, 0, 3);
      else if (k === 'fxoxy') d.fx.oxygen = SKY.U.clamp(num, 2, 120);
      else if (k === 'fxcurn') d.fx.currents = SKY.U.clamp(Math.round(num), 0, 60);
      else if (k === 'fxcurp') d.fx.currentPower = SKY.U.clamp(num, 0, 120);
      markDirty();
      rebuildProp(o);
      return;
    }
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

  /* Blender-style extrude: a NEW block flush against the chosen face,
     same cross-section and look — chain them to build L-shapes fast */
  function extrudeFace(spec) {
    const o = objects[sel];
    if (!o || o.kind !== 'block') return;
    const [axis, sign] = spec.split(',').map(Number);
    const d = o.data;
    push();
    const nb = JSON.parse(JSON.stringify(d));
    delete nb.mover;
    nb.mover = null;
    const depth = d.s[axis];               // extrude by the block's own depth
    nb.p = d.p.slice();
    nb.p[axis] += sign * depth;
    def.blocks.push(nb);
    rebuild();
    select(objects.findIndex(q => q.data === nb));
    status('extruded — drag the face chips or gizmo to shape it');
  }

  /* rebuild ONE terrain mesh in place (size/detail/texture changed) */
  function rebuildTerrainMesh(o) {
    if (o.kind !== 'terrain') return;
    const i = objects.indexOf(o);
    group.remove(o.mesh);
    o.mesh = buildTerrainMesh(o.data, o);
    group.add(o.mesh);
    syncWorldTerrains();
    if (i === sel) {
      if (selBox) group.remove(selBox);
      selBox = new THREE.BoxHelper(o.mesh, 0xffd34d);
      group.add(selBox);
      if (gizmo && !terra) gizmo.attach(o.mesh);
    }
  }

  /* rebuild ONE prop mesh in place (fx settings changed) */
  function rebuildProp(o) {
    if (o.kind !== 'prop') return;
    const i = objects.indexOf(o);
    o.inner = null; o.collVis = null; o._collBoxes = null;   // reloads async
    group.remove(o.mesh);
    o.mesh = buildPropMesh(o.data, o);
    group.add(o.mesh);
    if (i === sel) {
      if (selBox) group.remove(selBox);
      selBox = new THREE.BoxHelper(o.mesh, 0xffd34d);
      group.add(selBox);
      if (gizmo) gizmo.attach(o.mesh);
    }
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
    // model → a prop. Light/atmosphere decor defaults to non-solid, and so
    // do the lattice-y construction pieces (their bbox would be a giant
    // invisible wall — creators can still tick Solid on)
    push();
    SKY.Assets.embed(def, assetId);
    const airy = /crane|site-fence/.test(assetId);
    // fx decor defaults non-solid — except aviation, which is real cover
    const solidFx = /^fx:(plane|heli|jet|helipad|runway|tower|hangar)/.test(assetId);
    // new props default to MESH collision — the shape you see is what you hit
    const pr = { asset: assetId, p: [+_v.x.toFixed(2), +_v.y.toFixed(2), +_v.z.toFixed(2)],
      r: [0, 0, 0], scale: 1,
      solid: (!assetId.startsWith('fx:') || solidFx) && !airy, coll: 'mesh' };
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
    // terrain brush: keeps applying while the LMB is held
    if (terraStroke) applyBrush(Math.min(rdt, 0.05));
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
        if (collEdit) {                            // a collider box owns the gizmo
          if (e.value) push();
          else writeBackCollider(true);
          return;
        }
        if (e.value) {
          push();                                  // undo point at drag start
          // group translate: remember where everyone started
          groupDrag = (msel.length > 1 && objects[sel]) ? {
            startP: objects[sel].mesh.position.clone(),
            others: msel.filter(i => i !== sel && objects[i]).map(i => ({
              o: objects[i], p0: objects[i].mesh.position.clone(),
            })),
          } : null;
        } else {
          const o = objects[sel];
          if (o) { bakeBlockScale(o); writeBack(o); syncInspector(); refreshOutliner(); }
          if (groupDrag) for (const g of groupDrag.others) writeBack(g.o);
          groupDrag = null;
        }
      });
      gizmo.addEventListener('objectChange', () => {
        if (collEdit) { writeBackCollider(false); return; }
        const o = objects[sel];
        if (!o) return;
        writeBack(o);
        // the rest of the selection rides along (translate only)
        if (groupDrag && gizmo.mode === 'translate') {
          _v.copy(o.mesh.position).sub(groupDrag.startP);
          for (const g of groupDrag.others) {
            g.o.mesh.position.copy(g.p0).add(_v);
            writeBack(g.o);
          }
          for (const b of mboxes) b.update();
        }
      });
    }

    $('tab-editor').onclick = () => { if (!SKY.Net.online) open(null); };
    $('ed-exit').onclick = exit;
    $('ed-new').onclick = () => { api.active = false; open(null); };
    $('ed-save').onclick = save;
    $('ed-export').onclick = exportJson;
    $('ed-delete').onclick = () => {
      if (!def) return;
      const stored = SKY.MapData.draftMeta(def.id) || SKY.MapData.autosaveOf(def.id);
      if (!stored) { status('nothing saved to delete — this map only exists here'); return; }
      if (!confirm('Delete map "' + def.name + '"?\nThis removes the map and its backups for good.')) return;
      clearTimeout(autosaveTimer);   // a pending autosave would resurrect it
      dirty = false;
      SKY.MapData.deleteDraft(def.id);
      api.active = false;
      open(null);                    // fresh blank map
      status('map deleted');
    };
    $('ed-test').onclick = testPlay;
    $('ed-addblock').onclick = addBlock;
    $('ed-addground').onclick = addGround;
    $('ed-addterrain').onclick = addTerrain;
    $('ed-addpad').onclick = addPad;
    $('ed-addspawn').onclick = addSpawn;
    $('ed-additem').onclick = addItem;
    $('ed-anim').onclick = (e) => {
      previewOn = !previewOn;
      e.target.classList.toggle('sel', previewOn);
      if (!previewOn) for (const o of objects) syncMeshFromData(o);
    };
    $('ed-coll').onclick = (e) => {
      collOn = !collOn;
      e.target.classList.toggle('sel', collOn);
      refreshCollVis();
      status(collOn ? 'showing the game\'s real collision boxes (green)' : '');
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
      /* custom collider box buttons */
      if (e.target.dataset.k === 'cbadd') {
        const o = objects[sel];
        if (o && o.kind === 'prop') {
          push();
          o.data.boxes = o.data.boxes || [];
          o.data.boxes.push(seedColliderBox(o));
          markDirty();
          updateCollVis(o);
          syncInspector();
        }
        return;
      }
      if (e.target.dataset.cbe !== undefined) {
        const o = objects[sel];
        const i = +e.target.dataset.cbe;
        if (collEdit && collEdit.o === o && collEdit.i === i) exitCollEdit();
        else enterCollEdit(o, i);
        return;
      }
      if (e.target.dataset.cbx !== undefined) {
        const o = objects[sel];
        const i = +e.target.dataset.cbx;
        if (o && o.data.boxes && o.data.boxes[i]) {
          push();
          exitCollEdit(true);
          o.data.boxes.splice(i, 1);
          markDirty();
          updateCollVis(o);
          syncInspector();
        }
        return;
      }
      // terrain sculpt tool + paint channel chips
      const tt = e.target.closest('[data-tt]');
      if (tt) { enterSculpt(tt.dataset.tt); return; }
      const tc = e.target.closest('[data-tc]');
      if (tc) { if (terra) { terra.chan = +tc.dataset.tc; syncInspector(); } return; }
      const pf = e.target.closest('.ed-pf');
      if (pf) { paintFace = parseInt(pf.dataset.pf, 10); syncInspector(); return; }
      const ext = e.target.closest('.ed-ext');
      if (ext) { extrudeFace(ext.dataset.e); return; }
      const sw = e.target.closest('.ed-swatch');
      if (sw) {
        const o = objects[sel];
        if (o && o.kind === 'block') {
          push();
          const val = sw.dataset.pt || null;
          if (paintFace >= 0 && (!o.data.shape || o.data.shape === 'box')) {
            // paint just the selected face
            o.data.ptexF = o.data.ptexF || {};
            if (val) o.data.ptexF[paintFace] = val;
            else delete o.data.ptexF[paintFace];
            if (!Object.keys(o.data.ptexF).length) o.data.ptexF = null;
          } else {
            o.data.ptex = val;
            if (o.data.ptex) o.data.tex = null;  // picked texture replaces a dropped image
          }
          o.mesh.material = blockMaterial(o.data);
          markDirty();
          syncInspector();
        }
      }
    });

    /* outliner clicks (shift = add/remove from the multi-selection) */
    ui.outliner.addEventListener('click', (e) => {
      const row = e.target.closest('.ed-obj');
      if (!row) return;
      const i = +row.dataset.i;
      if (e.shiftKey && i >= 0) toggleSel(i);
      else select(i);
    });

    /* drag-scrub the number labels (Blender/Unity style) */
    let scrub = null, faceScrub = null;
    let mouseX = 0, mouseY = 0;    // last cursor spot (viewport E face-extend)

    /* hold E over a box face to extend it right in the viewport */
    function startFaceExtend() {
      _m.set((mouseX / window.innerWidth) * 2 - 1, -(mouseY / window.innerHeight) * 2 + 1);
      ray.setFromCamera(_m, camera);
      let best = null, bestD = Infinity;
      objects.forEach((o, i) => {
        if (o.kind !== 'block' || (o.data.shape && o.data.shape !== 'box')) return;
        const hits = ray.intersectObject(o.mesh, false);
        if (hits.length && hits[0].distance < bestD) { bestD = hits[0].distance; best = { o, i, hit: hits[0] }; }
      });
      if (!best || !best.hit.face) { status('E — aim at a box face to extend it'); return; }
      const n = best.hit.face.normal;   // local space = the block's own axes
      const axis = Math.abs(n.x) > 0.5 ? 0 : Math.abs(n.y) > 0.5 ? 1 : 2;
      const sign = (axis === 0 ? n.x : axis === 1 ? n.y : n.z) > 0 ? 1 : -1;
      if (best.i !== sel) select(best.i);
      push();
      faceScrub = { o: best.o, axis, sign, lastX: mouseX };
      status('extending ' + (sign > 0 ? '+' : '−') + 'XYZ'[axis] + ' — move the mouse, release E');
    }

    ui.ins.addEventListener('mousedown', (e) => {
      // only the "Extend faces" chips carry data-f; the Paint-face (data-pf)
      // and Extrude (data-e) chips share the .ed-face class and are handled
      // by the click handler above — touching dataset.f there was a crash
      const face = e.target.closest('.ed-face');
      if (face && face.dataset.f !== undefined) {
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
      mouseX = e.clientX; mouseY = e.clientY;
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

    /* draggable splitter between the inspector and the assets pane */
    const assetsPane = $('ed-side-assets');
    let splitDrag = null;
    $('ed-split').addEventListener('mousedown', (e) => {
      splitDrag = { y: e.clientY, h: assetsPane.getBoundingClientRect().height };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!splitDrag) return;
      const h = SKY.U.clamp(splitDrag.h - (e.clientY - splitDrag.y),
        90, window.innerHeight - 260);
      assetsPane.style.flex = '0 0 ' + h + 'px';
    });
    window.addEventListener('mouseup', () => { splitDrag = null; });

    /* viewport mouse */
    const canvas = SKY.Input._canvas;
    let lastX = 0, lastY = 0, downX = 0, downY = 0;
    canvas.addEventListener('mousedown', (e) => {
      if (!api.active) return;
      if (e.button === 2) { looking = true; lastX = e.clientX; lastY = e.clientY; }
      if (e.button === 0) {
        downX = e.clientX; downY = e.clientY;
        // sculpt mode: LMB starts a brush stroke instead of a selection
        if (terra && objects[sel] && objects[sel].kind === 'terrain') {
          const pt = terrainHit(e.clientX, e.clientY);
          if (pt) {
            push();
            brushAt = pt;
            terraStroke = { o: objects[sel],
              target: (SKY.World.terrainHeight(pt.x, pt.z) - objects[sel].data.p[1]) || 0 };
          }
        }
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (!api.active) return;
      if (e.button === 2) looking = false;
      if (e.button === 0 && terraStroke) { endStroke(); return; }
      if (e.button === 0 && terra) return;   // brush mode never re-selects
      if (e.button === 0 && !gizmoDrag && (!gizmo || !gizmo.axis) &&
          Math.abs(e.clientX - downX) < 4 && Math.abs(e.clientY - downY) < 4 &&
          !(e.target.closest && e.target.closest('#editor-ov'))) {
        const hit = pick(e.clientX, e.clientY);
        if (e.shiftKey && hit >= 0) toggleSel(hit);
        else select(hit);
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!api.active) return;
      if (terra && !looking && !(e.target.closest && e.target.closest('#editor-ov'))) {
        const pt = terrainHit(e.clientX, e.clientY);
        if (pt) {
          brushAt = pt;
          if (brushRing) {
            brushRing.position.set(pt.x, pt.y + 0.15, pt.z);
            brushRing.scale.setScalar(terra.radius);
          }
        }
      }
      if (!looking) return;
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
      if (e.code === 'KeyE' && !e.repeat && !faceScrub) startFaceExtend();
      if (e.code === 'KeyF') dropSel();
      if (e.code === 'KeyD' && e.shiftKey) duplicateSel();
      if (e.code === 'Delete' || e.code === 'Backspace') deleteSel();
      if (e.code === 'Escape') { if (terra) { exitSculpt(); return; } select(-1); }
      const nstep = e.shiftKey ? 0.1 : 0.5;
      if (e.code === 'ArrowLeft') nudge(-nstep, 0, 0);
      if (e.code === 'ArrowRight') nudge(nstep, 0, 0);
      if (e.code === 'ArrowUp') nudge(0, 0, -nstep);
      if (e.code === 'ArrowDown') nudge(0, 0, nstep);
      if (e.code === 'PageUp') nudge(0, nstep, 0);
      if (e.code === 'PageDown') nudge(0, -nstep, 0);
      if (e.code === 'ControlLeft' || e.code === 'ControlRight' ||
          e.code === 'ShiftLeft' || e.code === 'ShiftRight') updateSnaps(e);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyE' && faceScrub) {
        syncInspector(); refreshOutliner(); faceScrub = null;
        status('face extended');
      }
      if (e.code === 'ControlLeft' || e.code === 'ControlRight' ||
          e.code === 'ShiftLeft' || e.code === 'ShiftRight') updateSnaps(e);
    });

    /* gizmo snapping: Ctrl = fine grid (0.5 / 15°), Shift = big rotation
       STOPS (45° -> 0/45/90/...); Shift wins when both are held */
    function updateSnaps(e) {
      if (!gizmo) return;
      if (e.shiftKey) {
        gizmo.setTranslationSnap(1);
        gizmo.setRotationSnap(Math.PI / 4);
        gizmo.setScaleSnap(0.5);
      } else if (e.ctrlKey) {
        gizmo.setTranslationSnap(0.5);
        gizmo.setRotationSnap(Math.PI / 12);
        gizmo.setScaleSnap(0.25);
      } else {
        gizmo.setTranslationSnap(null);
        gizmo.setRotationSnap(null);
        gizmo.setScaleSnap(null);
      }
    }

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
