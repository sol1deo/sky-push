/* =============================================================================
 * SKY PUSH — MAP EDITOR (dev tool, menu ▸ EDITOR)
 * Blender-ish block-out editor for custom maps:
 *   camera   — hold RMB to look, WASD + E/Q to fly, wheel = speed
 *   select   — LMB click; Esc deselects
 *   G / S / R— grab / scale / rotate the selection with the mouse;
 *              X / Y / Z constrain to an axis, hold CTRL to snap,
 *              LMB/Enter commits, Esc cancels
 *   F        — drop the block onto whatever is below it (no floaters)
 *   Shift+D  — duplicate · Del — delete · Ctrl+Z — undo
 * Blocks get palettes / flat colors / dropped image textures, optional
 * mover paths (elevator, line, orbit) and a crumble flag. Pads, player
 * spawns and item-spawn points are placed the same way. TEST jumps into a
 * bot match on the draft; SAVE keeps it in the browser; EXPORT downloads
 * the JSON (deployable via maps/index.json — then it's in everyone's list).
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Editor = (function () {
  const $ = (id) => document.getElementById(id);
  let scene = null, camera = null;
  let def = null;                 // the working map def
  let group = null;               // all editor meshes
  let grid = null, lights = [];
  let objects = [];               // [{ kind, data, mesh }]
  let sel = -1;
  let selBox = null;              // THREE.BoxHelper highlight
  let history = [];
  let camYaw = 0.6, camPitch = -0.45;
  const camPos = new THREE.Vector3(24, 18, 24);
  let flySpeed = 14;
  let looking = false;
  let xform = null;               // { mode, axis, startData, lastX, lastY }
  let previewT = 0, previewOn = true;
  let ui = null;
  const ray = new THREE.Raycaster();
  const _m = new THREE.Vector2();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();

  const api = {
    active: false,
    pendingReturn: null,          // draft id to reopen after a TEST match
  };

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
    const pal = SKY.MapData.PALETTES[b.pal];
    if (pal) {
      const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
      m.map = SKY.U.checkerTexture(pal[0], pal[1], rep);
      return m;
    }
    return new THREE.MeshLambertMaterial({ color: b.color || '#8a94a8' });
  }

  function buildBlockMesh(b) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.s[0], b.s[1], b.s[2]), blockMaterial(b));
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
    const len = Math.max(1, dir.length() * 0.22);
    g.add(new THREE.ArrowHelper(dir.clone().normalize(), new THREE.Vector3(0, 0.2, 0), len, 0x49e07f, 0.6, 0.35));
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

  function rebuild(keepSel) {
    const oldSel = keepSel ? sel : -1;
    if (group) scene.remove(group);
    group = new THREE.Group();
    scene.add(group);
    objects = [];
    for (const b of def.blocks) { const mesh = buildBlockMesh(b); group.add(mesh); objects.push({ kind: 'block', data: b, mesh }); }
    for (const pd of def.pads) { const mesh = buildPadMesh(pd); group.add(mesh); objects.push({ kind: 'pad', data: pd, mesh }); }
    for (const s of def.spawns) { const mesh = buildSpawnMesh(s); group.add(mesh); objects.push({ kind: 'spawn', data: s, mesh }); }
    for (const it of def.items) { const mesh = buildItemMesh(it); group.add(mesh); objects.push({ kind: 'item', data: it, mesh }); }
    if (!grid) grid = new THREE.GridHelper(160, 160, 0x557799, 0x2a3244);
    group.add(grid);
    select(oldSel >= 0 && oldSel < objects.length ? oldSel : -1);
    applyMood();
  }

  function applyMood() {
    for (const l of lights) scene.remove(l);
    lights = [];
    const M = SKY.MapData.MOODS[def.mood];
    const hemi = new THREE.HemisphereLight(M.hemi[0], M.hemi[1], M.hemi[2] + 0.15);
    const sun = new THREE.DirectionalLight(M.sun[0], M.sun[1]);
    sun.position.set(M.sun[2][0], M.sun[2][1], M.sun[2][2]);
    lights.push(hemi, sun);
    scene.add(hemi, sun);
    const S = SKY.MapData.SKIES[def.sky];
    scene.background = new THREE.Color(S[1]);
    scene.fog = null;
  }

  /* refresh one object's mesh from its data (cheap per-frame edits) */
  function syncMesh(o) {
    if (o.kind === 'block') {
      o.mesh.position.set(o.data.p[0], o.data.p[1], o.data.p[2]);
      o.mesh.rotation.set(o.data.r[0], o.data.r[1], o.data.r[2]);
      // size changes need new geometry
      const g = o.mesh.geometry.parameters;
      if (g.width !== o.data.s[0] || g.height !== o.data.s[1] || g.depth !== o.data.s[2]) {
        o.mesh.geometry.dispose();
        o.mesh.geometry = new THREE.BoxGeometry(o.data.s[0], o.data.s[1], o.data.s[2]);
      }
    } else if (o.kind === 'pad') {
      o.mesh.position.set(o.data.p[0], o.data.p[1] + 0.11, o.data.p[2]);
    } else if (o.kind === 'spawn') {
      o.mesh.position.set(o.data.p[0], o.data.p[1], o.data.p[2]);
    } else {
      o.mesh.position.set(o.data.p[0], o.data.p[1] + 1, o.data.p[2]);
    }
    if (selBox && objects[sel] === o) selBox.update();
  }

  /* ================= selection ================= */
  function select(i) {
    sel = i;
    if (selBox) { group.remove(selBox); selBox = null; }
    if (sel >= 0 && objects[sel]) {
      selBox = new THREE.BoxHelper(objects[sel].mesh, 0xffd34d);
      group.add(selBox);
    }
    syncInspector();
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

  /* point 12m in front of the camera, clamped above the grid */
  function focusPoint(out) {
    SKY.U.dirFromYawPitch(camYaw, camPitch, out);
    out.multiplyScalar(14).add(camPos);
    out.x = Math.round(out.x); out.y = Math.max(0, Math.round(out.y)); out.z = Math.round(out.z);
    return out;
  }

  /* ================= history ================= */
  function push() {
    history.push(JSON.stringify(def));
    if (history.length > 60) history.shift();
  }
  function undo() {
    if (!history.length) return;
    def = SKY.MapData.normalize(JSON.parse(history.pop()));
    rebuild(false);
    status('undo');
  }

  /* ================= add / duplicate / delete ================= */
  function addBlock() {
    push();
    focusPoint(_v);
    def.blocks.push({ p: [_v.x, _v.y, _v.z], s: [4, 1, 4], r: [0, 0, 0], pal: 'pearl', crumble: false, mover: null });
    rebuild();
    select(objects.findIndex(o => o.data === def.blocks[def.blocks.length - 1]));
  }
  function addPad() {
    push();
    focusPoint(_v);
    def.pads.push({ p: [_v.x, _v.y, _v.z], launch: [0, 16, 0] });
    rebuild();
    select(objects.findIndex(o => o.data === def.pads[def.pads.length - 1]));
  }
  function addSpawn() {
    push();
    focusPoint(_v);
    def.spawns.push({ p: [_v.x, _v.y, _v.z], yaw: 0 });
    rebuild();
    select(objects.findIndex(o => o.data === def.spawns[def.spawns.length - 1]));
  }
  function addItem() {
    push();
    focusPoint(_v);
    def.items.push({ p: [_v.x, _v.y, _v.z] });
    rebuild();
    select(objects.findIndex(o => o.data === def.items[def.items.length - 1]));
  }
  function duplicateSel() {
    const o = objects[sel];
    if (!o) return;
    push();
    const copy = JSON.parse(JSON.stringify(o.data));
    copy.p = [copy.p[0] + 2, copy.p[1], copy.p[2] + 2];
    const arr = { block: def.blocks, pad: def.pads, spawn: def.spawns, item: def.items }[o.kind];
    arr.push(copy);
    rebuild();
    select(objects.findIndex(q => q.data === copy));
    status('duplicated');
  }
  function deleteSel() {
    const o = objects[sel];
    if (!o) return;
    if (o.kind === 'block' && def.blocks.length <= 1) { status('a map needs at least one block'); return; }
    if (o.kind === 'spawn' && def.spawns.length <= 2) { status('keep at least 2 spawns'); return; }
    push();
    const arr = { block: def.blocks, pad: def.pads, spawn: def.spawns, item: def.items }[o.kind];
    arr.splice(arr.indexOf(o.data), 1);
    rebuild();
    select(-1);
  }

  /* F — sit the selection on whatever is directly below it (stacking) */
  function dropSel() {
    const o = objects[sel];
    if (!o) return;
    push();
    const halfH = o.kind === 'block' ? o.data.s[1] / 2 : 0;
    _v.set(o.data.p[0], o.data.p[1] + (o.kind === 'block' ? 0 : 1), o.data.p[2]);
    ray.set(_v, new THREE.Vector3(0, -1, 0));
    let top = 0;   // fall back to the grid plane
    for (const q of objects) {
      if (q === o || q.kind !== 'block') continue;
      const hits = ray.intersectObject(q.mesh, false);
      if (hits.length) top = Math.max(top, hits[0].point.y);
    }
    o.data.p[1] = +(top + halfH).toFixed(2);
    syncMesh(o);
    syncInspector();
    status('dropped');
  }

  /* ================= transform modal (G/S/R) ================= */
  function startXform(mode) {
    const o = objects[sel];
    if (!o || xform) return;
    xform = {
      mode, axis: null,
      startData: JSON.stringify(o.data),
      obj: o,
    };
    status(mode === 'g' ? 'move — X/Y/Z axis · CTRL snap · click/Enter OK · Esc cancel'
      : mode === 's' ? 'scale — X/Y/Z axis · CTRL snap · click/Enter OK'
      : 'rotate — X/Y/Z axis (default Y) · CTRL snap 15° · click/Enter OK');
  }
  function cancelXform() {
    if (!xform) return;
    const o = xform.obj;
    Object.assign(o.data, JSON.parse(xform.startData));
    syncMesh(o);
    syncInspector();
    xform = null;
    status('cancelled');
  }
  function commitXform(snap) {
    if (!xform) return;
    const o = xform.obj;
    if (snap) {
      if (o.data.p) o.data.p = o.data.p.map(v => Math.round(v * 2) / 2);
      if (o.data.s && xform.mode === 's') o.data.s = o.data.s.map(v => Math.max(0.25, Math.round(v * 2) / 2));
      if (o.data.r && xform.mode === 'r') {
        o.data.r = o.data.r.map(v => Math.round(v / (Math.PI / 12)) * (Math.PI / 12));
      }
    }
    push();   // (history holds the PRE-edit state via startData? no — push post
    // states stack fine: undo returns to previous committed state)
    syncMesh(o);
    syncInspector();
    xform = null;
    status('ok');
  }
  function applyXformDelta(dx, dy) {
    const o = xform.obj;
    const d = o.data;
    const k = Math.max(2, camera.position.distanceTo(o.mesh.position)) * 0.0016;
    if (xform.mode === 'g') {
      if (xform.axis === 'x') d.p[0] += dx * k;
      else if (xform.axis === 'y') d.p[1] -= dy * k;
      else if (xform.axis === 'z') d.p[2] += dx * k;
      else {
        // view-plane move: camera right + world up
        _v.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
        d.p[0] += _v.x * dx * k;
        d.p[2] += _v.z * dx * k;
        d.p[1] -= dy * k;
      }
    } else if (xform.mode === 's' && d.s) {
      const f = 1 + dx * 0.004;
      if (xform.axis === 'x') d.s[0] = Math.max(0.25, d.s[0] * f);
      else if (xform.axis === 'y') d.s[1] = Math.max(0.25, d.s[1] * f);
      else if (xform.axis === 'z') d.s[2] = Math.max(0.25, d.s[2] * f);
      else for (let i = 0; i < 3; i++) d.s[i] = Math.max(0.25, d.s[i] * f);
    } else if (xform.mode === 'r') {
      if (d.r) {
        const ax = xform.axis === 'x' ? 0 : xform.axis === 'z' ? 2 : 1;
        d.r[ax] += dx * 0.01;
      } else if (d.yaw !== undefined) {
        d.yaw += dx * 0.01;
        // spawns need the arrow refreshed
        rebuildSpawnArrow(o);
      }
    }
    syncMesh(o);
  }
  function rebuildSpawnArrow(o) {
    if (o.kind !== 'spawn') return;
    const i = objects.indexOf(o);
    group.remove(o.mesh);
    o.mesh = buildSpawnMesh(o.data);
    group.add(o.mesh);
    if (i === sel && selBox) { group.remove(selBox); selBox = new THREE.BoxHelper(o.mesh, 0xffd34d); group.add(selBox); }
  }

  /* ================= inspector ================= */
  function status(s) { ui.status.textContent = s || ''; }

  function numRow(label, val, key, step) {
    return `<div class="ed-row"><span>${label}</span>
      <input type="number" data-k="${key}" value="${(+val).toFixed(2)}" step="${step || 0.5}"></div>`;
  }

  function syncInspector() {
    const o = objects[sel];
    ui.insTitle.textContent = o ? o.kind.toUpperCase() : 'MAP';
    if (!o) {
      ui.ins.innerHTML = `
        <div class="ed-row"><span>Name</span><input type="text" data-k="name" value="${def.name}" maxlength="18"></div>
        <div class="ed-row"><span>Mood</span><select data-k="mood">${Object.keys(SKY.MapData.MOODS).map(m =>
          `<option value="${m}"${m === def.mood ? ' selected' : ''}>${SKY.MapData.MOODS[m].label}</option>`).join('')}</select></div>
        <div class="ed-row"><span>Sky</span><select data-k="sky">${Object.keys(SKY.MapData.SKIES).map(s =>
          `<option value="${s}"${s === def.sky ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        ${numRow('Kill height', def.killY, 'killY', 1)}
        <div class="ed-hint">Select an object to edit it. Nothing selected = map settings.</div>`;
      return;
    }
    const d = o.data;
    let h = '';
    h += numRow('X', d.p[0], 'p0') + numRow('Y', d.p[1], 'p1') + numRow('Z', d.p[2], 'p2');
    if (o.kind === 'block') {
      h += numRow('Width', d.s[0], 's0') + numRow('Height', d.s[1], 's1') + numRow('Depth', d.s[2], 's2');
      h += numRow('Rot X°', d.r[0] * 180 / Math.PI, 'r0', 5) + numRow('Rot Y°', d.r[1] * 180 / Math.PI, 'r1', 5) + numRow('Rot Z°', d.r[2] * 180 / Math.PI, 'r2', 5);
      h += `<div class="ed-row"><span>Palette</span><select data-k="pal">
        <option value=""${!d.pal ? ' selected' : ''}>flat color</option>
        ${Object.keys(SKY.MapData.PALETTES).map(p => `<option value="${p}"${d.pal === p ? ' selected' : ''}>${p}</option>`).join('')}
      </select></div>`;
      h += `<div class="ed-row"><span>Color</span><input type="color" data-k="color" value="${d.color || '#8a94a8'}"></div>`;
      h += `<div class="ed-row"><span>Texture</span><input type="file" accept="image/*" data-k="texfile"></div>`;
      if (d.tex) h += `<div class="ed-row"><span></span><button class="ed-mini" data-k="cleartex">remove texture</button></div>`;
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
      h += numRow('Launch X', d.launch[0], 'l0') + numRow('Launch Y', d.launch[1], 'l1') + numRow('Launch Z', d.launch[2], 'l2');
    } else if (o.kind === 'spawn') {
      h += numRow('Yaw°', (d.yaw || 0) * 180 / Math.PI, 'yaw', 15);
    }
    ui.ins.innerHTML = h;
  }

  function onInspectorInput(e) {
    const k = e.target.dataset.k;
    if (!k) return;
    const o = objects[sel];
    // map settings (no selection)
    if (!o) {
      if (k === 'name') def.name = e.target.value.toUpperCase();
      else if (k === 'mood') { def.mood = e.target.value; applyMood(); }
      else if (k === 'sky') { def.sky = e.target.value; applyMood(); }
      else if (k === 'killY') def.killY = parseFloat(e.target.value) || -22;
      return;
    }
    const d = o.data;
    const num = parseFloat(e.target.value) || 0;
    if (k[0] === 'p') d.p[+k[1]] = num;
    else if (k[0] === 's' && k.length === 2) d.s[+k[1]] = Math.max(0.25, num);
    else if (k[0] === 'r' && k.length === 2) d.r[+k[1]] = num * Math.PI / 180;
    else if (k[0] === 'l') d.launch[+k[1]] = num;
    else if (k === 'yaw') { d.yaw = num * Math.PI / 180; rebuildSpawnArrow(o); }
    else if (k === 'pal') { d.pal = e.target.value || null; o.mesh.material = blockMaterial(d); }
    else if (k === 'color') { d.color = e.target.value; if (!d.pal && !d.tex) o.mesh.material = blockMaterial(d); }
    else if (k === 'crumble') d.crumble = e.target.checked;
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
    else if (k === 'texfile') {
      const f = e.target.files && e.target.files[0];
      if (f) applyTextureFile(f, o);
      return;
    }
    else if (k === 'cleartex') { d.tex = null; o.mesh.material = blockMaterial(d); syncInspector(); return; }
    syncMesh(o);
  }

  function applyTextureFile(file, o) {
    const fr = new FileReader();
    fr.onload = () => {
      push();
      o.data.tex = fr.result;
      o.mesh.material = blockMaterial(o.data);
      syncInspector();
      status('texture applied (rides inside the map file)');
    };
    fr.readAsDataURL(file);
  }

  /* ================= save / load / export / test ================= */
  function save() {
    def.name = def.name || 'CUSTOM MAP';
    const ok = SKY.MapData.saveDraft(def);
    status(ok ? 'saved — the map is now in the PLAY map list' : 'saved to session (localStorage full — use EXPORT)');
  }
  function exportJson() {
    const blob = new Blob([JSON.stringify(def)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status('exported — drop the file in maps/ + list it in maps/index.json to deploy');
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
    const drafts = SKY.MapData.drafts();
    ui.loadSel.innerHTML = '<option value="">load draft…</option>' +
      drafts.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  }
  function testPlay() {
    save();
    api.pendingReturn = def.id;
    closeUi();
    SKY.SFX.init();
    SKY.Game.startMatch(2, def.id, 'lbs', { rounds: 9, lives: 5 });
    SKY.Input.requestLock();
  }

  /* ================= open / close ================= */
  function openUi() {
    ui.root.classList.remove('hidden');
    document.getElementById('menu').classList.add('hidden');
  }
  function closeUi() {
    ui.root.classList.add('hidden');
    api.active = false;
  }

  function open(defOrId) {
    if (api.active) return;
    api.active = true;
    def = typeof defOrId === 'string'
      ? JSON.parse(JSON.stringify(SKY.MapData.get(defOrId) || SKY.MapData.blank()))
      : (defOrId ? SKY.MapData.normalize(defOrId) : SKY.MapData.blank());
    history = [];
    SKY.Map.unload();
    rebuild(false);
    refreshLoadList();
    openUi();
    select(-1);
    status('RMB — look around · G/S/R — transform · F — drop · TEST to play it');
  }

  function exit() {
    closeUi();
    if (group) { scene.remove(group); group = null; }
    for (const l of lights) scene.remove(l);
    lights = [];
    objects = [];
    scene.background = null;
    SKY.Map.load(scene, 'sky');       // restore the menu backdrop
    SKY.HUD.showMenu();
  }

  /* back from a TEST match */
  function resume() {
    const id = api.pendingReturn;
    api.pendingReturn = null;
    document.getElementById('menu').classList.add('hidden');
    open(id);
  }

  /* ================= per-frame ================= */
  function frame(rdt) {
    const In = SKY.Input;
    SKY.Effects.tick(rdt);   // let leftover particles fade out
    // fly
    const sp = flySpeed * rdt * (In.isDown('ShiftLeft') ? 2.6 : 1);
    SKY.U.dirFromYawPitch(camYaw, camPitch, _v);
    _v2.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const mz = (In.isDown('KeyW') ? 1 : 0) - (In.isDown('KeyS') ? 1 : 0);
    const mx = (In.isDown('KeyD') ? 1 : 0) - (In.isDown('KeyA') ? 1 : 0);
    const my = (In.isDown('KeyE') ? 1 : 0) - (In.isDown('KeyQ') ? 1 : 0);
    camPos.addScaledVector(_v, mz * sp).addScaledVector(_v2, mx * sp);
    camPos.y += my * sp;
    camera.position.copy(camPos);
    camera.rotation.set(camPitch, camYaw, 0, 'YXZ');
    camera.fov = 80;
    camera.updateProjectionMatrix();
    // mover preview
    if (previewOn) {
      previewT += rdt;
      for (const o of objects) {
        if (o.kind !== 'block' || !o.data.mover) continue;
        const m = o.data.mover;
        const period = Math.max(1, m.period || 6);
        const s = (Math.sin(previewT * Math.PI * 2 / period) + 1) / 2;
        if (m.type === 'elevator') o.mesh.position.y = o.data.p[1] + (m.amp || 4) * s;
        else if (m.type === 'line') {
          const off = m.off || [6, 0, 0];
          o.mesh.position.set(o.data.p[0] + off[0] * s, o.data.p[1] + off[1] * s, o.data.p[2] + off[2] * s);
        } else if (m.type === 'orbit') {
          const c = m.c || [0, 0];
          const a = previewT * Math.PI * 2 / period;
          const rx = o.data.p[0] - c[0], rz = o.data.p[2] - c[1];
          o.mesh.position.set(c[0] + rx * Math.cos(a) - rz * Math.sin(a), o.data.p[1],
            c[1] + rx * Math.sin(a) + rz * Math.cos(a));
        }
        if (selBox && objects[sel] === o) selBox.update();
      }
    }
  }

  /* ================= wiring ================= */
  function init(sc, cam) {
    scene = sc; camera = cam;
    ui = {
      root: $('editor-ov'), ins: $('ed-inspector'), insTitle: $('ed-ins-title'),
      status: $('ed-status'), loadSel: $('ed-load'),
    };
    $('tab-editor').onclick = () => { if (!SKY.Net.online) open(null); };
    $('ed-exit').onclick = exit;
    $('ed-new').onclick = () => { api.active = false; open(null); };
    $('ed-save').onclick = save;
    $('ed-export').onclick = exportJson;
    $('ed-test').onclick = testPlay;
    $('ed-addblock').onclick = addBlock;
    $('ed-addpad').onclick = addPad;
    $('ed-addspawn').onclick = addSpawn;
    $('ed-additem').onclick = addItem;
    $('ed-anim').onclick = (e) => { previewOn = !previewOn; e.target.classList.toggle('sel', previewOn); if (!previewOn) rebuild(true); };
    ui.loadSel.onchange = () => { if (ui.loadSel.value) { api.active = false; open(ui.loadSel.value); } };
    $('ed-import').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };
    ui.ins.addEventListener('input', onInspectorInput);
    ui.ins.addEventListener('click', (e) => { if (e.target.dataset.k === 'cleartex') onInspectorInput(e); });

    const canvas = SKY.Input._canvas;
    let lastX = 0, lastY = 0, downX = 0, downY = 0;
    canvas.addEventListener('mousedown', (e) => {
      if (!api.active) return;
      if (e.button === 2) { looking = true; lastX = e.clientX; lastY = e.clientY; }
      if (e.button === 0) {
        if (xform) { commitXform(false); return; }
        downX = e.clientX; downY = e.clientY;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (!api.active) return;
      if (e.button === 2) looking = false;
      if (e.button === 0 && !xform &&
          Math.abs(e.clientX - downX) < 4 && Math.abs(e.clientY - downY) < 4 &&
          !e.target.closest('#editor-ov')) {
        select(pick(e.clientX, e.clientY));
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!api.active) return;
      if (looking) {
        camYaw -= (e.clientX - lastX) * 0.004;
        camPitch = SKY.U.clamp(camPitch - (e.clientY - lastY) * 0.004, -1.5, 1.5);
        lastX = e.clientX; lastY = e.clientY;
      } else if (xform) {
        applyXformDelta(e.movementX, e.movementY);
      }
    });
    window.addEventListener('wheel', (e) => {
      if (!api.active || e.target.closest('#editor-ov')) return;
      flySpeed = SKY.U.clamp(flySpeed * (e.deltaY > 0 ? 0.85 : 1.18), 3, 80);
      status('fly speed ' + flySpeed.toFixed(0));
    }, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (!api.active) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (xform) {
        if (e.code === 'Escape') { cancelXform(); return; }
        if (e.code === 'Enter') { commitXform(e.ctrlKey); return; }
        if (e.code === 'KeyX') xform.axis = 'x';
        if (e.code === 'KeyY') xform.axis = 'y';
        if (e.code === 'KeyZ' && !e.ctrlKey) xform.axis = 'z';
        if (e.ctrlKey && e.code === 'KeyZ') { cancelXform(); undo(); }
        return;
      }
      if (e.ctrlKey && e.code === 'KeyZ') { undo(); return; }
      if (e.code === 'KeyG') startXform('g');
      if (e.code === 'KeyS' && !e.ctrlKey) startXform('s');
      if (e.code === 'KeyR') startXform('r');
      if (e.code === 'KeyF') dropSel();
      if (e.code === 'KeyD' && e.shiftKey) duplicateSel();
      if (e.code === 'Delete' || e.code === 'Backspace') deleteSel();
      if (e.code === 'Escape') select(-1);
      if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); save(); }
    });
    // commit transforms with a click anywhere (incl. over UI guard above)
    window.addEventListener('mousedown', (e) => {
      if (api.active && xform && e.button === 0 && !e.target.closest('#editor-ov')) {
        commitXform(e.ctrlKey);
      }
    }, true);
    // drop an image anywhere = texture the selected block
    window.addEventListener('dragover', (e) => { if (api.active) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!api.active) return;
      e.preventDefault();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      const o = objects[sel];
      if (f && f.type.indexOf('image/') === 0 && o && o.kind === 'block') applyTextureFile(f, o);
      else if (f && f.name.endsWith('.json')) importJson(f);
    });
  }

  api.open = open;
  api.exit = exit;
  api.resume = resume;
  api.frame = frame;
  api.init = init;
  return api;
})();
