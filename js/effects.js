/* =============================================================================
 * SKY PUSH — juice: particles, rings, camera shake, floating text, viewmodel
 * All placeholder-quality but tuned so hits/launches READ clearly.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Effects = (function () {
  const POOL = 220;
  const parts = [];
  let scene = null, camera = null;
  let shakeAmp = 0;
  const shakeOff = new THREE.Vector3();
  let fovKick = 0;
  const texts = [];       // floating text sprites
  const fireworks = [];   // scheduled celebration bursts
  const _v = new THREE.Vector3();

  /* ------------------------- particle pool ------------------------- */
  function spawn(o) {
    for (const p of parts) {
      if (p.life > 0) continue;
      p.spr.visible = true;
      p.spr.position.copy(o.pos);
      p.vel.copy(o.vel || _v.set(0, 0, 0));
      p.life = p.maxLife = o.life || 0.5;
      p.size0 = o.size || 0.5;
      p.size1 = o.sizeEnd !== undefined ? o.sizeEnd : p.size0 * 0.2;
      p.gravity = o.gravity || 0;
      p.drag = o.drag || 0;
      p.spr.material.color.set(o.color || '#ffffff');
      p.spr.material.opacity = o.opacity !== undefined ? o.opacity : 1;
      p.fade = o.opacity !== undefined ? o.opacity : 1;
      p.ring = !!o.ring;
      p.spr.material.map = o.ring ? SKY.U.ringTexture() : SKY.U.blobTexture();
      return p;
    }
    return null;
  }

  function burst(pos, opts) {
    opts = opts || {};
    const n = opts.count || 10;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = SKY.U.rand(-0.3, 1);
      const sp = SKY.U.rand(0.3, 1) * (opts.speed || 5);
      spawn({
        pos,
        vel: new THREE.Vector3(Math.cos(a) * sp, up * sp, Math.sin(a) * sp),
        life: SKY.U.rand(0.25, opts.life || 0.6),
        size: SKY.U.rand(0.5, 1.2) * (opts.size || 0.5),
        color: opts.color || '#ffffff',
        gravity: opts.gravity !== undefined ? opts.gravity : 6,
        drag: 2,
      });
    }
  }

  function ring(pos, color, size, life) {
    const p = spawn({ pos, life: life || 0.4, size: 0.4, sizeEnd: size || 3.5, color, ring: true, opacity: 0.9 });
    return p;
  }

  /* ------------------------- floating text ------------------------- */
  function floatText(pos, text, color) {
    if (texts.length > 6) return;
    const spr = SKY.U.makeTextSprite(text, { color, px: 48, scale: 0.007 });
    spr.position.copy(pos);
    scene.add(spr);
    texts.push({ spr, life: 1.0 });
  }

  /* ------------------------- weapon models (v2) -------------------------
   * Detailed low-poly guns built from primitives — shared by the first-person
   * viewmodel AND the characters' hands. -Z is the barrel direction.
   * ---------------------------------------------------------------------- */
  const WMAT = {};
  function wmats() {
    if (WMAT.metal) return WMAT;
    WMAT.metal = new THREE.MeshLambertMaterial({ color: 0x2b3450 });
    WMAT.dark = new THREE.MeshLambertMaterial({ color: 0x1b2336 });
    WMAT.body = new THREE.MeshLambertMaterial({ color: 0x3b486b });
    WMAT.grip = new THREE.MeshLambertMaterial({ color: 0x232c44 });
    WMAT.wood = new THREE.MeshLambertMaterial({ color: 0x7a5a3f });
    return WMAT;
  }

  function buildWeaponMesh(kind, finish) {
    const W = SKY.TUNING.weapons[kind] || SKY.TUNING.weapons.blaster;
    // real model (Kenney Blaster Kit GLB) when the asset pack has loaded —
    // procedural primitives below stay as the file:// / slow-net fallback
    if (SKY.GFX && SKY.GFX.hasWeapon(kind)) {
      const grp = SKY.GFX.weapon(kind);
      const tip = grp.getObjectByName('tip');
      if (tip && kind !== 'hookgun' && kind !== 'cannon') {
        // glow strip under the barrel keeps the weapon-tier color readable
        const glow = new THREE.Mesh(
          new THREE.BoxGeometry(0.014, 0.014, Math.abs(tip.position.z) * 0.5),
          new THREE.MeshLambertMaterial({
            color: W.color, emissive: new THREE.Color(W.color).multiplyScalar(0.65),
          }));
        glow.name = 'tierglow';
        glow.position.set(0, tip.position.y - 0.045, tip.position.z * 0.4);
        grp.add(glow);
      }
      if (finish && finish !== 'stock' && SKY.Profile) {
        SKY.Profile.applyFinish(grp, finish, W.color);
      }
      return grp;
    }
    const M = wmats();
    const accent = new THREE.MeshLambertMaterial({
      color: W.color, emissive: new THREE.Color(W.color).multiplyScalar(0.6),
    });
    const grp = new THREE.Group();
    const box = (w, h, d, m, x, y, z, rx, rz) => {
      const q = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      q.position.set(x, y, z);
      if (rx) q.rotation.x = rx;
      if (rz) q.rotation.z = rz;
      grp.add(q); return q;
    };
    const cyl = (r0, r1, l, m, x, y, z, alongZ) => {
      const q = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, l, 10), m);
      if (alongZ !== false) q.rotation.x = Math.PI / 2;
      q.position.set(x, y, z);
      grp.add(q); return q;
    };
    let tip;
    const T = (x, y, z) => {
      tip = new THREE.Object3D();
      tip.position.set(x, y, z);
      tip.name = 'tip';
      grp.add(tip);
    };

    switch (kind) {
      case 'pistol':
        box(0.055, 0.07, 0.2, M.metal, 0, 0.02, -0.04);          // slide
        box(0.05, 0.05, 0.16, M.body, 0, -0.03, -0.03);          // frame
        box(0.012, 0.05, 0.14, accent, 0.032, 0.02, -0.04);      // side stripe
        box(0.012, 0.05, 0.14, accent, -0.032, 0.02, -0.04);
        cyl(0.016, 0.018, 0.05, M.dark, 0, 0.02, -0.165);        // muzzle
        box(0.045, 0.12, 0.06, M.grip, 0, -0.1, 0.045, 0.28);    // grip
        box(0.04, 0.012, 0.05, M.dark, 0, -0.06, -0.06);         // trigger guard
        box(0.012, 0.022, 0.012, M.dark, 0, 0.065, -0.12);       // front sight
        box(0.03, 0.02, 0.012, M.dark, 0, 0.065, 0.05);          // rear sight
        T(0, 0.02, -0.2);
        break;
      case 'scatter':
        cyl(0.028, 0.03, 0.36, M.dark, 0, 0.045, -0.24);         // top barrel
        cyl(0.028, 0.03, 0.36, M.dark, 0, -0.015, -0.24);        // bottom barrel
        box(0.07, 0.045, 0.03, M.metal, 0, 0.015, -0.41);        // muzzle band
        box(0.06, 0.1, 0.14, M.metal, 0, 0, -0.02);              // receiver
        box(0.065, 0.06, 0.18, M.wood, 0, -0.02, -0.22);         // pump/forend
        box(0.055, 0.09, 0.2, M.wood, 0, -0.045, 0.15, 0.12);    // stock
        box(0.06, 0.11, 0.045, M.wood, 0, -0.07, 0.26, 0.12);    // butt
        box(0.012, 0.03, 0.012, accent, 0, 0.075, -0.4);         // bead sight
        box(0.014, 0.014, 0.12, accent, 0.036, 0.015, -0.02);
        T(0, 0.015, -0.44);
        break;
      case 'longshot':
        cyl(0.02, 0.024, 0.5, M.dark, 0, 0.02, -0.36);           // long barrel
        box(0.05, 0.05, 0.07, M.metal, 0, 0.02, -0.63);          // muzzle brake
        box(0.06, 0.09, 0.3, M.body, 0, 0, 0.0);                 // receiver
        box(0.05, 0.07, 0.26, M.body, 0, -0.045, 0.24, 0.06);    // cheek stock
        box(0.055, 0.1, 0.04, M.grip, 0, -0.09, 0.35);           // butt pad
        box(0.045, 0.11, 0.055, M.grip, 0, -0.1, 0.1, 0.3);      // grip
        box(0.04, 0.1, 0.06, M.dark, 0, -0.09, -0.06);           // magazine
        cyl(0.03, 0.03, 0.2, M.dark, 0, 0.085, -0.06);           // scope tube
        cyl(0.036, 0.036, 0.045, M.metal, 0, 0.085, -0.17);      // objective
        cyl(0.034, 0.034, 0.04, M.metal, 0, 0.085, 0.05);        // eyepiece
        (() => {                                                  // glowing lens
          const lens = new THREE.Mesh(new THREE.CircleGeometry(0.026, 10), accent);
          lens.position.set(0, 0.085, -0.193);
          lens.rotation.y = Math.PI;
          grp.add(lens);
          const lens2 = lens.clone();
          lens2.position.z = 0.071;
          lens2.rotation.y = 0;
          grp.add(lens2);
        })();
        box(0.012, 0.03, 0.03, M.metal, 0, 0.05, -0.1);          // scope mounts
        box(0.012, 0.03, 0.03, M.metal, 0, 0.05, 0.0);
        cyl(0.012, 0.012, 0.06, M.metal, 0.05, 0.01, 0.06, false); // bolt handle
        T(0, 0.02, -0.67);
        break;
      case 'mega':
        box(0.1, 0.12, 0.42, M.body, 0, 0, -0.03);               // fat receiver
        cyl(0.034, 0.04, 0.3, M.dark, 0, 0.03, -0.38);           // barrel
        box(0.08, 0.07, 0.09, M.metal, 0, 0.03, -0.52);          // brake
        box(0.02, 0.05, 0.34, accent, 0.062, 0.02, -0.05);       // glow rails
        box(0.02, 0.05, 0.34, accent, -0.062, 0.02, -0.05);
        box(0.05, 0.13, 0.07, M.dark, 0.02, -0.11, -0.02, 0.12); // twin mags
        box(0.05, 0.13, 0.07, M.dark, -0.02, -0.11, 0.02, 0.12);
        box(0.06, 0.1, 0.05, M.grip, 0, -0.1, 0.16, 0.3);        // grip
        box(0.06, 0.08, 0.12, M.grip, 0, -0.02, 0.24);           // stock
        for (let i = 0; i < 3; i++) box(0.11, 0.012, 0.03, M.dark, 0, 0.068, -0.16 + i * 0.07);
        T(0, 0.03, -0.57);
        break;
      case 'smg':
        box(0.055, 0.07, 0.24, M.body, 0, 0.01, -0.04);          // receiver
        cyl(0.018, 0.02, 0.14, M.dark, 0, 0.03, -0.22);          // stub barrel
        box(0.05, 0.1, 0.05, M.grip, 0, -0.08, 0.06, 0.25);      // grip
        box(0.035, 0.14, 0.05, M.dark, 0, -0.1, -0.05, 0.1);     // long mag
        box(0.012, 0.035, 0.16, accent, 0.032, 0.02, -0.05);
        box(0.04, 0.04, 0.1, M.grip, 0, 0.005, 0.12);            // stock
        T(0, 0.03, -0.3);
        break;
      case 'magnum':
        box(0.05, 0.065, 0.16, M.metal, 0, 0.03, -0.1);          // frame
        cyl(0.024, 0.026, 0.2, M.dark, 0, 0.035, -0.22);         // heavy barrel
        cyl(0.036, 0.036, 0.05, M.metal, 0, 0.005, -0.02, false); // cylinder
        box(0.045, 0.11, 0.055, M.wood, 0, -0.08, 0.055, 0.3);   // wooden grip
        box(0.012, 0.02, 0.012, accent, 0, 0.075, -0.3);         // sight
        T(0, 0.035, -0.33);
        break;
      case 'lobber':
        cyl(0.055, 0.06, 0.26, M.body, 0, 0.02, -0.16);          // fat tube
        cyl(0.062, 0.062, 0.05, accent, 0, 0.02, -0.3);          // muzzle ring
        box(0.05, 0.09, 0.12, M.grip, 0, -0.07, 0.06, 0.3);      // grip
        box(0.05, 0.05, 0.1, M.grip, 0, 0.01, 0.12);             // stock
        box(0.012, 0.03, 0.012, M.dark, 0, 0.09, -0.24);
        T(0, 0.02, -0.34);
        break;
      case 'hookgun': {  // the left-hand grapple launcher
        const rope = new THREE.MeshLambertMaterial({
          color: 0xd8c49a, emissive: new THREE.Color(0xd8c49a).multiplyScalar(0.25),
        });
        box(0.075, 0.095, 0.17, M.body, 0, 0, -0.02);            // housing
        cyl(0.032, 0.038, 0.15, M.dark, 0, 0.012, -0.17);        // launch barrel
        cyl(0.052, 0.052, 0.05, rope, 0.055, 0.005, 0.02, false); // rope drum (side)
        cyl(0.056, 0.056, 0.014, M.dark, 0.084, 0.005, 0.02, false);
        box(0.05, 0.11, 0.055, M.grip, 0, -0.095, 0.05, 0.3);    // grip
        box(0.04, 0.012, 0.05, M.dark, 0, -0.05, -0.05);         // guard
        for (let i = 0; i < 3; i++) {                             // hook prongs
          const a = (i / 3) * Math.PI * 2;
          const prong = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.06, 6), M.metal);
          prong.position.set(Math.cos(a) * 0.03, 0.012 + Math.sin(a) * 0.03, -0.26);
          prong.rotation.x = -Math.PI / 2;
          prong.rotation.z = a;
          grp.add(prong);
        }
        T(0, 0.012, -0.25);
        break;
      }
      default: {  // blaster -> PUSH RIFLE
        box(0.06, 0.075, 0.34, M.body, 0, 0.01, -0.02);          // receiver
        cyl(0.02, 0.024, 0.24, M.dark, 0, 0.025, -0.3);          // barrel
        box(0.045, 0.045, 0.05, M.metal, 0, 0.025, -0.43);       // muzzle
        box(0.05, 0.055, 0.16, M.grip, 0, -0.015, -0.24);        // handguard
        box(0.014, 0.04, 0.26, accent, 0.035, 0.01, -0.05);      // glow strips
        box(0.014, 0.04, 0.26, accent, -0.035, 0.01, -0.05);
        box(0.04, 0.12, 0.06, M.dark, 0, -0.1, -0.1, 0.15);      // magazine
        box(0.045, 0.1, 0.05, M.grip, 0, -0.09, 0.1, 0.3);       // grip
        box(0.05, 0.06, 0.12, M.grip, 0, 0, 0.2);                // stock
        box(0.04, 0.08, 0.03, M.grip, 0, -0.02, 0.27);           // butt
        box(0.012, 0.028, 0.012, M.dark, 0, 0.06, -0.36);        // front sight
        box(0.028, 0.022, 0.012, M.dark, 0, 0.06, 0.02);         // rear sight
        T(0, 0.025, -0.46);
      }
    }
    grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return grp;
  }

  /* --------------------- weapon thumbnails (UI) ---------------------
   * Renders the actual 3D weapon model to a small transparent canvas —
   * used by the death-reward cards so a weapon reads at a glance. */
  /* animated weapon-finish materials (PULSE / SPECTRUM) — updated per frame,
     ring-buffered so discarded weapons age out naturally */
  const animMats = [];
  function registerAnimMat(mat) {
    animMats.push(mat);
    if (animMats.length > 60) animMats.shift();
  }
  function tickAnimMats() {
    if (!animMats.length) return;
    const t = performance.now() * 0.001;
    for (const m of animMats) {
      if (!m.emissive) continue;
      if (m.userData.animFx === 'pulse') {
        const k = 0.5 + 0.5 * Math.sin(t * 3.2);
        m.emissive.set(m.userData.accent).multiplyScalar(0.12 + 0.5 * k);
      } else if (m.userData.animFx === 'spectrum') {
        m.emissive.setHSL((t * 0.13) % 1, 0.85, 0.3);
      }
    }
  }

  const thumbCache = {};
  let thumbRig = null;
  function thumbKey(kind, finish) {
    // thumbs re-render once the real GLB arrives (asset pack loads async)
    return kind + (finish ? ':' + finish : '') +
      (SKY.GFX && SKY.GFX.hasWeapon(kind) ? '+glb' : '');
  }
  function weaponThumb(kind, finish) {
    if (thumbCache[thumbKey(kind, finish)]) return thumbCache[thumbKey(kind, finish)];
    try {
      if (!thumbRig) {
        const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        r.setSize(280, 150);
        r.setPixelRatio(1);
        r.outputEncoding = THREE.sRGBEncoding;
        const sc = new THREE.Scene();
        const cam = new THREE.PerspectiveCamera(26, 280 / 150, 0.01, 10);
        sc.add(new THREE.HemisphereLight(0xe8f0ff, 0x3a4150, 1.15));
        const key = new THREE.DirectionalLight(0xffffff, 1.5);
        key.position.set(1.4, 1.9, 1.2);
        sc.add(key);
        thumbRig = { r, sc, cam };
      }
      const mesh = buildWeaponMesh(kind, finish);
      const box = new THREE.Box3().setFromObject(mesh);
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      mesh.position.sub(c);
      const grp = new THREE.Group();
      grp.add(mesh);
      grp.rotation.y = 2.45;    // 3/4 view, barrel to the left
      grp.rotation.x = 0.22;
      thumbRig.sc.add(grp);
      thumbRig.cam.position.set(0, 0.05, size * 1.28);
      thumbRig.cam.lookAt(0, 0, 0);
      thumbRig.r.render(thumbRig.sc, thumbRig.cam);
      const url = thumbRig.r.domElement.toDataURL();
      thumbRig.sc.remove(grp);
      thumbCache[thumbKey(kind, finish)] = url;
      return url;
    } catch (e) { return null; }   // headless / no-GL fallback
  }

  /* bold OUTLINE side icon (CS:GO-style loadout HUD) — the weapon's clean
     silhouette as a thick glowing contour in its rarity color */
  const wireCache = {};
  /* white-silhouette render of any mesh through the thumb rig — shared by
     the weapon and grenade outline icons */
  function wireRender(mesh, rotY) {
    weaponThumb('pistol');                    // ensures thumbRig exists
    if (!thumbRig) return null;
    const solid = new THREE.MeshBasicMaterial({ color: 0xffffff });
    mesh.traverse((o) => { if (o.isMesh) o.material = solid; });
    const box = new THREE.Box3().setFromObject(mesh);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    mesh.position.sub(c);
    const grp = new THREE.Group();
    grp.add(mesh);
    grp.rotation.y = rotY;
    thumbRig.sc.add(grp);
    thumbRig.cam.position.set(0, 0.02, size * 1.15);
    thumbRig.cam.lookAt(0, 0, 0);
    thumbRig.r.render(thumbRig.sc, thumbRig.cam);
    const src = thumbRig.r.domElement;
    thumbRig.sc.remove(grp);
    return src;
  }
  /* 2D compose: tinted silhouette -> thick offset outline + glow, then
     punch out the interior for a clean contour with a faint body fill */
  function composeWire(src, colorHex) {
    const W = src.width, H = src.height;
    const tin = document.createElement('canvas');
    tin.width = W; tin.height = H;
    const tg = tin.getContext('2d');
    tg.drawImage(src, 0, 0);
    tg.globalCompositeOperation = 'source-in';
    tg.fillStyle = colorHex || '#dfe7f2';
    tg.fillRect(0, 0, W, H);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const g = out.getContext('2d');
    g.shadowColor = colorHex || '#dfe7f2';
    g.shadowBlur = 9;
    const o3 = 3;
    for (const [dx, dy] of [[o3, 0], [-o3, 0], [0, o3], [0, -o3],
                            [2.2, 2.2], [-2.2, 2.2], [2.2, -2.2], [-2.2, -2.2]]) {
      g.drawImage(tin, dx, dy);
    }
    g.shadowBlur = 0;
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 0.18;                   // whisper of body fill
    g.drawImage(tin, 0, 0);
    g.globalAlpha = 1;
    return out.toDataURL();
  }
  function weaponWireIcon(kind, colorHex) {
    const key = thumbKey(kind) + '|' + colorHex;
    if (wireCache[key]) return wireCache[key];
    try {
      const mesh = buildWeaponMesh(kind);
      const src = wireRender(mesh, -Math.PI / 2);   // pure side view, barrel right
      if (!src) return null;
      const url = composeWire(src, colorHex);
      wireCache[key] = url;
      return url;
    } catch (e) { return null; }
  }

  /* grenade outline icon for the HUD chip — real GLB when the pack is
     loaded, procedural silhouette otherwise; tinted by grenade type color */
  function nadeWireIcon(type, colorHex) {
    const key = 'nade:' + type + '|' + colorHex +
      (SKY.GFX && SKY.GFX.hasWeapon && SKY.GFX.hasWeapon('grenade1') ? '+glb' : '');
    if (wireCache[key]) return wireCache[key];
    try {
      const g = new THREE.Group();
      const glb = SKY.GFX && SKY.GFX.weapon && SKY.GFX.weapon('grenade1');
      if (glb) g.add(glb);
      else {
        const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 12), m);
        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 8), m);
        neck.position.y = 0.14;
        const lever = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.03), m);
        lever.position.set(0.055, 0.12, 0);
        lever.rotation.z = -0.5;
        g.add(body, neck, lever);
      }
      const src = wireRender(g, -Math.PI / 2 + 0.35);   // slight 3/4 turn
      if (!src) return null;
      const url = composeWire(src, colorHex);
      wireCache[key] = url;
      return url;
    } catch (e) { return null; }
  }

  /* flat SIDE-PROFILE render (PUBG-style inventory icon) */
  const sideCache = {};
  function weaponSideIcon(kind) {
    if (sideCache[thumbKey(kind)]) return sideCache[thumbKey(kind)];
    try {
      weaponThumb(kind);                      // ensures thumbRig exists
      if (!thumbRig) return null;
      const mesh = buildWeaponMesh(kind);
      const box = new THREE.Box3().setFromObject(mesh);
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      mesh.position.sub(c);
      const grp = new THREE.Group();
      grp.add(mesh);
      grp.rotation.y = -Math.PI / 2;          // pure side view, barrel to the right
      thumbRig.sc.add(grp);
      thumbRig.cam.position.set(0, 0.02, size * 1.15);
      thumbRig.cam.lookAt(0, 0, 0);
      thumbRig.r.render(thumbRig.sc, thumbRig.cam);
      const url = thumbRig.r.domElement.toDataURL();
      thumbRig.sc.remove(grp);
      sideCache[thumbKey(kind)] = url;
      return url;
    } catch (e) { return null; }
  }

  /* ------------------------- viewmodel -------------------------
   * Right hand: the active weapon, with an animated HOLSTER→DRAW swap
   * (drops off-screen, new gun snaps up). Left hand: the grapple hook-gun
   * that pops up while the rope is out (and the weapon dips away). */
  const vm = {
    group: null, kind: null, kick: 0, bobT: 0, sway: { x: 0, y: 0 },
    baseX: 0.3, baseY: -0.27,   // rest/bob position BEFORE anim offsets
    tipWorld: new THREE.Vector3(),
    swapPhase: null, swapNext: null, swapBlend: 1,   // holster/draw anim
    hook: null, hookTipWorld: new THREE.Vector3(),
    hookTarget: 0, hookBlend: 0,                     // left arm up/down
    cannon: null, cannonT: 0,                        // air-cannon pop (Q)
    visible: true,
  };

  function mountWeapon(kind) {
    if (vm.group) camera.remove(vm.group);
    vm.kind = kind;
    vm.group = buildWeaponMesh(kind, SKY.Profile && SKY.Profile.finishFor(kind));
    vm.group.scale.setScalar(0.85);
    vm.group.position.set(0.3, -0.27, -0.52);
    vm.group.visible = vm.visible;
    camera.add(vm.group);
  }

  function ensureWeapon(kind) {
    if (!camera || vm.kind === kind || vm.swapNext === kind) return;
    if (!vm.group) { mountWeapon(kind); return; }   // first equip: instant
    vm.swapNext = kind;                              // animated holster→draw
    vm.swapPhase = 'down';
  }

  function ensureHook() {
    if (vm.hook || !camera) return;
    vm.hook = buildWeaponMesh('hookgun', SKY.Profile && SKY.Profile.finishFor('hookgun'));
    vm.hook.scale.setScalar(0.85);
    vm.hook.position.set(-0.32, -0.9, -0.5);
    vm.hook.visible = vm.visible;
    camera.add(vm.hook);
  }

  /* grapple active? left arm up, weapon away — snappy both ways */
  function setHands(hooking) {
    vm.hookTarget = hooking ? 1 : 0;
    if (hooking) ensureHook();
  }

  /* air cannon (Q): the left hand whips the cannon up, blasts, stows it */
  function cannonPop() {
    if (!camera) return;
    if (!vm.cannon) {
      vm.cannon = buildWeaponMesh('cannon');
      vm.cannon.scale.setScalar(0.85);
      vm.cannon.visible = false;
      camera.add(vm.cannon);
    }
    vm.cannonT = 0.0001;
  }

  function hookTip() {
    if (!vm.hook || vm.hookBlend < 0.3) return null;
    const tip = vm.hook.getObjectByName('tip');
    if (!tip) return null;
    tip.getWorldPosition(vm.hookTipWorld);
    return vm.hookTipWorld;
  }

  /* ---------------- speed lines ----------------
   * Anime wind streaks pinned to the EDGES of the screen when you're moving
   * FAST — strongest in the air. Lines live on an ellipse that matches the
   * viewport (n = 1 is the screen border), so the middle 60% of the screen —
   * and the crosshair — always stays clear. Intensity is damped so they
   * build up gradually past ~16 m/s instead of popping into view. */
  let spdGroup = null, spdIntensity = 0;
  const spdLines = [];
  const SPD_N = 20;
  function resetSpeedLine(L, scatter) {
    // stratified angles: each line owns a slice of the ring, so streaks
    // spread around the whole border instead of clumping
    L.ang = (L.slot / SPD_N) * Math.PI * 2 + SKY.U.rand(-0.3, 0.3);
    L.n = scatter ? SKY.U.rand(0.62, 1.2) : SKY.U.rand(0.62, 0.78);
    L.n0 = L.n;
    L.speed = SKY.U.rand(1.4, 2.6);
    L.len = SKY.U.rand(0.45, 1.0);
    L.o = SKY.U.rand(0.3, 0.75);
  }
  function ensureSpeedLines() {
    if (spdGroup || !camera) return;
    spdGroup = new THREE.Group();
    spdGroup.visible = false;
    camera.add(spdGroup);
    for (let i = 0; i < SPD_N; i++) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: 0xdcecff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      }));
      spr.renderOrder = 30;
      const L = { spr, slot: i, ang: 0, n: 0, n0: 0, speed: 1, len: 1, o: 0.5 };
      resetSpeedLine(L, true);
      spdGroup.add(spr);
      spdLines.push(L);
    }
  }
  function speedLinesTick(dt, speed, grounded) {
    let target = SKY.U.clamp01((speed - 16) / 14);   // starts ~16 m/s, full at 30
    if (grounded) target *= 0.35;                    // subtle on foot, real in the air
    spdIntensity = SKY.U.damp(spdIntensity, target, 2.2, dt);   // fade in/out, never pop
    const k = spdIntensity;
    if (!spdGroup) {
      if (k > 0.02) ensureSpeedLines();
      if (!spdGroup) return;
    }
    if (k <= 0.02) {
      if (spdGroup.visible) spdGroup.visible = false;
      return;
    }
    spdGroup.visible = true;
    // half-extents of the viewport at the sprite plane (z = -1.5): n=1 = edge
    const halfH = Math.tan(camera.fov * Math.PI / 360) * 1.5;
    const halfW = halfH * camera.aspect;
    for (const L of spdLines) {
      L.n += L.speed * dt * (0.55 + k * 0.75);
      if (L.n > 1.35) resetSpeedLine(L, false);
      const grow = SKY.U.clamp01((L.n - L.n0) / 0.1);    // ease in after spawn
      const die = SKY.U.clamp01((1.35 - L.n) / 0.22);    // ease out past the border
      const rim = SKY.U.clamp01((L.n - 0.55) / 0.25);    // hard-clear center zone
      L.spr.material.opacity = k * L.o * grow * die * rim * 0.45;
      const x = Math.cos(L.ang) * L.n * halfW;
      const y = Math.sin(L.ang) * L.n * halfH;
      L.spr.material.rotation = Math.atan2(y, x) - Math.PI / 2;   // long axis radial on screen
      L.spr.position.set(x, y, -1.5);
      L.spr.scale.set(0.016 + 0.01 * k, L.len * (0.55 + k * 0.65), 1);
    }
  }

  /* ------------------------- tracers & muzzle light ------------------------- */
  const tracers = [];
  let muzzleLightObj = null;

  function tracer(from, to, isHead) {
    let tr = tracers.find(t => t.life <= 0);
    if (!tr) {
      if (tracers.length >= 24) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xffedc0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      line.frustumCulled = false;
      const spark = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: 0xfff4d8, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      spark.scale.set(0.5, 0.5, 1);
      scene.add(line); scene.add(spark);
      tr = { line, spark, from: new THREE.Vector3(), to: new THREE.Vector3(), life: 0, max: 1 };
      tracers.push(tr);
    }
    tr.from.copy(from); tr.to.copy(to);
    tr.max = 0.11;
    tr.life = tr.max;
    tr.line.material.color.set(isHead ? 0xffb0a0 : 0xffedc0);
    const a = tr.line.geometry.attributes.position.array;
    a[0] = from.x; a[1] = from.y; a[2] = from.z;
    a[3] = to.x; a[4] = to.y; a[5] = to.z;
    tr.line.geometry.attributes.position.needsUpdate = true;
    tr.line.visible = true;
    tr.spark.visible = true;
  }

  /* proper launcher explosion: core flash, fireball, shockwave rings,
     debris, smoke — reads as a BLAST, not a puff */
  function blastBoom(pos, radius) {
    const r = Math.max(2, radius);
    // white core flash that swells, then an orange fireball
    spawn({ pos, life: 0.16, size: r * 1.4, sizeEnd: r * 2.6, color: '#ffffff' });
    spawn({ pos, life: 0.3, size: r * 0.9, sizeEnd: r * 1.9, color: '#ffb85a', opacity: 0.9 });
    burst(pos.clone(), { count: 10, speed: r * 1.6, color: '#ffcf7a', life: 0.35, size: r * 0.5 });
    burst(pos.clone(), { count: 14, speed: r * 2.6, color: '#ff8a3a', life: 0.5, size: r * 0.35 });
    // debris streaks + lingering smoke puffs
    burst(pos.clone(), { count: 16, speed: r * 4.2, color: '#ffe2b0', life: 0.65, size: 0.24, gravity: 16 });
    for (let i = 0; i < 6; i++) {
      spawn({
        pos, life: SKY.U.rand(0.7, 1.2), size: r * 0.45, sizeEnd: r * 1.1,
        color: '#788089', opacity: 0.35,
        vel: new THREE.Vector3(SKY.U.rand(-2, 2), SKY.U.rand(1.5, 4), SKY.U.rand(-2, 2)),
      });
    }
    // double shockwave
    ring(pos.clone(), '#ffd9a0', r * 2.8, 0.42);
    ring(pos.clone(), '#ffffff', r * 1.7, 0.24);
    muzzleLight(pos);
  }

  function muzzleLight(pos) {
    if (!muzzleLightObj) {
      muzzleLightObj = new THREE.PointLight(0xffd9a0, 0, 9, 2);
      scene.add(muzzleLightObj);
    }
    muzzleLightObj.position.copy(pos);
    muzzleLightObj.intensity = 2.6;
  }

  /* ---------------- tracer darts (shared by weapons + replay) ----------------
   * Bright head sprite + an additive RIBBON quad that always faces the camera
   * and tapers toward the tail — reads far better than a 1px line. */
  const _tside = new THREE.Vector3();
  const _ttmp = new THREE.Vector3();

  function makeTracer() {
    const g = new THREE.Group();
    const head = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SKY.U.blobTexture(), color: 0xfff2d0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    head.scale.set(0.38, 0.38, 1);   // bullet-sized, not a comet
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([
      1, 1, 1,  1, 1, 1,  0.2, 0.16, 0.1,  0.2, 0.16, 0.1,
    ]), 3));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    const trail = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffe2a8, transparent: true, opacity: 0.95, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    trail.frustumCulled = false;
    g.add(head, trail);
    scene.add(g);
    return { g, head, trail };
  }

  /* place a tracer: head at pos, ribbon stretching len behind along dir */
  function poseTracer(vis, pos, dir, len) {
    vis.head.position.copy(pos);
    _ttmp.copy(camera.position).sub(pos);
    _tside.crossVectors(dir, _ttmp);
    if (_tside.lengthSq() < 1e-8) _tside.set(-dir.z, 0, dir.x);   // dead-on view
    _tside.normalize();
    const wHead = 0.032, wTail = 0.006;
    const a = vis.trail.geometry.attributes.position.array;
    const tx = pos.x - dir.x * len, ty = pos.y - dir.y * len, tz = pos.z - dir.z * len;
    a[0] = pos.x + _tside.x * wHead; a[1] = pos.y + _tside.y * wHead; a[2] = pos.z + _tside.z * wHead;
    a[3] = pos.x - _tside.x * wHead; a[4] = pos.y - _tside.y * wHead; a[5] = pos.z - _tside.z * wHead;
    a[6] = tx + _tside.x * wTail; a[7] = ty + _tside.y * wTail; a[8] = tz + _tside.z * wTail;
    a[9] = tx - _tside.x * wTail; a[10] = ty - _tside.y * wTail; a[11] = tz - _tside.z * wTail;
    vis.trail.geometry.attributes.position.needsUpdate = true;
  }

  /* collapse the ribbon onto a point (fresh spawn — no stale streak) */
  function resetTracer(vis, pos) {
    vis.head.position.copy(pos);
    const a = vis.trail.geometry.attributes.position.array;
    for (let i = 0; i < 12; i += 3) { a[i] = pos.x; a[i + 1] = pos.y; a[i + 2] = pos.z; }
    vis.trail.geometry.attributes.position.needsUpdate = true;
  }

  /* ================================================================= */
  return {
    shakeOffset: shakeOff,

    init(sc, cam) {
      scene = sc; camera = cam;
      for (let i = 0; i < POOL; i++) {
        const mat = new THREE.SpriteMaterial({
          map: SKY.U.blobTexture(), transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const spr = new THREE.Sprite(mat);
        spr.visible = false;
        scene.add(spr);
        parts.push({ spr, vel: new THREE.Vector3(), life: 0, maxLife: 1, size0: 1, size1: 0, gravity: 0, drag: 0, fade: 1, ring: false });
      }
      ensureWeapon('blaster');
    },

    tick(dt) {
      tickAnimMats();   // PULSE / SPECTRUM weapon finishes
      // particles
      for (const p of parts) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) { p.spr.visible = false; continue; }
        const t = 1 - p.life / p.maxLife;
        p.vel.y -= p.gravity * dt;
        if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
        p.spr.position.addScaledVector(p.vel, dt);
        const s = SKY.U.lerp(p.size0, p.size1, t);
        p.spr.scale.set(s, s, 1);
        p.spr.material.opacity = p.fade * (1 - t * t);
      }
      // floating text
      for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i];
        t.life -= dt;
        t.spr.position.y += dt * 1.6;
        t.spr.material.opacity = SKY.U.clamp01(t.life * 1.6);
        if (t.life <= 0) {
          scene.remove(t.spr);
          t.spr.material.map.dispose(); t.spr.material.dispose();
          texts.splice(i, 1);
        }
      }
      // camera shake (light! see TUNING.camera)
      shakeAmp = Math.max(0, shakeAmp - shakeAmp * 7 * dt - 0.1 * dt);
      const a = shakeAmp * 0.05;
      shakeOff.set(SKY.U.rand(-a, a), SKY.U.rand(-a, a), SKY.U.rand(-a, a));
      fovKick = Math.max(0, fovKick - fovKick * 9 * dt);
      // viewmodel kick recover (sway/bob handled in viewmodelMotion) —
      // heavies slide back further AND rear up like the gun wants out
      if (vm.group) {
        vm.kick = Math.max(0, vm.kick - vm.kick * 8 * dt);
        vm.group.position.z = -0.5 + vm.kick * 0.19;
        vm.group.rotation.x = vm.kick * 0.09;
      }
      // air-cannon left-arm pop: raise fast, blast, stow
      if (vm.cannonT > 0 && vm.cannon) {
        vm.cannonT += dt;
        const t = vm.cannonT;
        const raise = SKY.U.clamp01(t / 0.1) - SKY.U.clamp01((t - 0.55) / 0.25);
        const kickb = t > 0.16 ? Math.exp(-(t - 0.16) * 9) * 0.34 : 0;
        vm.cannon.visible = raise > 0.02;
        vm.cannon.position.set(-0.3, -0.95 + raise * 0.7, -0.52 + kickb);
        vm.cannon.rotation.x = kickb * 1.1 - (1 - raise) * 0.6;
        if (t > 0.85) { vm.cannonT = 0; vm.cannon.visible = false; }
      }
      // holster→draw swap: drop fast, raise snappy
      if (vm.swapPhase === 'down') {
        vm.swapBlend = Math.max(0, vm.swapBlend - dt / 0.09);
        if (vm.swapBlend === 0 && vm.swapNext) {
          mountWeapon(vm.swapNext);
          vm.swapNext = null;
          vm.swapPhase = 'up';
        }
      } else if (vm.swapPhase === 'up') {
        vm.swapBlend = Math.min(1, vm.swapBlend + dt / 0.13);
        if (vm.swapBlend === 1) vm.swapPhase = null;
      }
      // left hook arm in/out — quick and springy; fully hide whichever hand
      // is tucked away so nothing pokes into the frame
      vm.hookBlend = SKY.U.damp(vm.hookBlend, vm.hookTarget, 22, dt);
      if (vm.hook) vm.hook.visible = vm.visible && vm.hookBlend > 0.04;
      if (vm.group) vm.group.visible = vm.visible && vm.hookBlend < 0.96;
      // tracers fade
      for (const tr of tracers) {
        if (tr.life <= 0) continue;
        tr.life -= dt;
        if (tr.life <= 0) { tr.line.visible = false; tr.spark.visible = false; continue; }
        const k = 1 - tr.life / tr.max;
        tr.line.material.opacity = 0.85 * (1 - k * k);
        tr.spark.position.lerpVectors(tr.from, tr.to, Math.min(1, k * 2.2));
        tr.spark.material.opacity = 1 - k;
      }
      if (muzzleLightObj && muzzleLightObj.intensity > 0.01) {
        muzzleLightObj.intensity *= Math.exp(-18 * dt);
      }
      // fireworks scheduler
      for (let i = fireworks.length - 1; i >= 0; i--) {
        const f = fireworks[i];
        f.t -= dt;
        if (f.t <= 0) {
          burst(f.pos, { count: 26, speed: 9, size: 0.8, color: f.color, gravity: 7, life: 1 });
          ring(f.pos, f.color, 6, 0.6);
          fireworks.splice(i, 1);
        }
      }
    },

    setViewmodelVisible(v) {
      vm.visible = v;
      if (vm.group) vm.group.visible = v && vm.hookBlend < 0.96;
      if (vm.hook) vm.hook.visible = v && vm.hookBlend > 0.04;
    },

    /* weapon feel: mouse-lag sway, run bob, fall tilt, slide roll, fire kick,
       and a full backflip spin while reloading (reloadFrac 0..1, or -1) */
    viewmodelMotion(dt, speed, grounded, velY, sliding, reloadFrac) {
      if (!vm.group) return;
      const d = SKY.Input.takeFrameDelta();
      vm.sway.x = SKY.U.damp(vm.sway.x, SKY.U.clamp(-d.dx * 0.0022, -0.09, 0.09), 9, dt);
      vm.sway.y = SKY.U.damp(vm.sway.y, SKY.U.clamp(d.dy * 0.0022, -0.07, 0.07), 9, dt);
      let spin = 0, dip = 0;
      if (reloadFrac !== undefined && reloadFrac >= 0) {
        const k = reloadFrac * reloadFrac * (3 - 2 * reloadFrac);   // smoothstep
        spin = -Math.PI * 2 * k;
        dip = Math.sin(Math.PI * reloadFrac) * 0.07;
      }
      vm.group.rotation.y = vm.sway.x;
      vm.group.rotation.x = vm.kick * 0.5 + vm.sway.y + spin +
        SKY.U.clamp(velY * 0.004, -0.08, 0.08);
      vm.group.rotation.z = SKY.U.damp(vm.group.rotation.z, sliding ? 0.18 : vm.sway.x * 0.5, 8, dt);
      // base (rest/bob) position is tracked SEPARATELY from the anim offsets:
      // damping the final position would fight the dip/holster offsets and
      // blow them up ~16x while airborne (the old jump-mid-reload glitch)
      if (grounded && speed > 1) {
        vm.bobT += dt * speed * 1.4;
        vm.baseY = -0.27 + Math.sin(vm.bobT) * 0.006 * Math.min(speed, 12);
        vm.baseX = 0.3 + Math.cos(vm.bobT * 0.5) * 0.004 * Math.min(speed, 12);
      } else {
        vm.baseY = SKY.U.damp(vm.baseY, -0.27, 8, dt);
        vm.baseX = SKY.U.damp(vm.baseX, 0.3, 8, dt);
      }
      // holstering / grappling pulls the weapon down out of frame
      const lower = (1 - vm.swapBlend) * 0.55 + vm.hookBlend * 0.62;
      vm.group.position.y = vm.baseY - dip - lower;
      vm.group.position.x = vm.baseX;
      vm.group.rotation.x += (1 - vm.swapBlend) * 0.9 + vm.hookBlend * 0.8;
      // the left hook arm mirrors the sway and pops up while grappling
      if (vm.hook) {
        const hb = vm.hookBlend;
        vm.hook.position.set(
          -0.32 - vm.sway.x * 0.4,
          -0.28 - (1 - hb) * 0.62 + Math.sin(vm.bobT) * 0.004 * Math.min(speed, 12),
          -0.5);
        vm.hook.rotation.set((1 - hb) * 0.9 + vm.sway.y, -vm.sway.x * 0.6, -0.08);
      }
    },
    ensureWeapon, setHands, hookTip,
    speedLines: speedLinesTick,

    viewmodelTip() {
      if (!vm.group) return null;
      const tip = vm.group.getObjectByName('tip');
      tip.getWorldPosition(vm.tipWorld);
      return vm.tipWorld;
    },

    shake(amp) { shakeAmp = Math.min(shakeAmp + amp, 3); },
    cannonPop,
    getFovKick() { return fovKick; },
    ring(pos, color, size, life) { ring(pos, color, size, life); },
    burst, blastBoom, registerAnimMat,

    /* ---------------- gameplay-facing effect recipes ---------------- */
    /* muzzle profile scales with the weapon's kick weight: light guns get a
       spark puff, HEAVY guns (lobber/boom/piston/quad) get a launcher-grade
       flash + smoke ring + real screen punch — every class feels different */
    muzzle(pos, tierColor, isLocal, kick) {
      const k = kick || 1;
      if (k >= 1.4) {          // launcher class
        burst(pos, { count: 14, speed: 5, size: 0.7, color: tierColor, gravity: 0, life: 0.28 });
        burst(pos, { count: 8, speed: 2.5, size: 0.55, color: '#ffffff', gravity: 0, life: 0.14 });
        burst(pos, { count: 6, speed: 1.6, size: 0.8, color: '#8a8f9a', gravity: -1.5, life: 0.7 });
        ring(pos.clone(), tierColor, 2.4 + k, 0.3);
      } else if (k >= 0.8) {   // rifle class
        burst(pos, { count: 10, speed: 3.6, size: 0.5, color: tierColor, gravity: 0, life: 0.22 });
      } else {                 // pistol / smg class
        burst(pos, { count: 7, speed: 3, size: 0.4, color: tierColor, gravity: 0, life: 0.18 });
      }
      if (isLocal) {
        if (vm.group) vm.kick = Math.min(k * (k >= 1.4 ? 1.8 : 1.3), 4.2);
        fovKick = (k >= 1.4 ? 2.6 : 1.5) * Math.min(k, 2.2);
        if (k >= 1.4) shakeAmp = Math.min(shakeAmp + k * 0.35, 3);
      }
    },
    hitBurst(pos, tier, tierColor) {
      // meaty: dense core flash + sparks + a ring from tier 1 up
      burst(pos, { count: 14 + tier * 6, speed: 5 + tier * 3, size: 0.5 + tier * 0.15, color: tierColor, life: 0.45 });
      burst(pos, { count: 4, speed: 2, size: 0.9, color: '#ffffff', life: 0.16, gravity: 0 });
      if (tier >= 1) ring(pos, tierColor, 1.6 + tier, 0.3);
    },
    headshotBurst(pos) {
      burst(pos, { count: 24, speed: 7, size: 0.5, color: '#ff8a7a', life: 0.55 });
      burst(pos, { count: 5, speed: 2, size: 1.1, color: '#ffffff', life: 0.16, gravity: 0 });
      ring(pos, '#ff8a7a', 2.6, 0.3);
      ring(pos, '#ffffff', 1.4, 0.2);
    },
    impactSpark(pos, normal) {
      for (let i = 0; i < 5; i++) {
        const v = normal.clone().multiplyScalar(SKY.U.rand(2, 5));
        v.x += SKY.U.rand(-2, 2); v.y += SKY.U.rand(-0.5, 2.5); v.z += SKY.U.rand(-2, 2);
        spawn({ pos, vel: v, life: SKY.U.rand(0.15, 0.3), size: 0.22, color: '#ffd9a0', gravity: 10, drag: 2 });
      }
    },
    tracer, muzzleLight, buildWeaponMesh, weaponThumb, weaponSideIcon, weaponWireIcon, nadeWireIcon,
    makeTracer, poseTracer, resetTracer,
    cannonBlast(pos, dir) {
      // a proper pressure wave: dense forward cone + white core flash +
      // double expanding rings that travel with the blast direction
      for (let i = 0; i < 26; i++) {
        const v = dir.clone().multiplyScalar(SKY.U.rand(5, 16));
        v.x += SKY.U.rand(-3.5, 3.5); v.y += SKY.U.rand(-1.5, 3.5); v.z += SKY.U.rand(-3.5, 3.5);
        spawn({ pos, vel: v, life: SKY.U.rand(0.25, 0.55), size: SKY.U.rand(0.7, 1.3), color: '#bfe9ff', gravity: 2, drag: 2.5 });
      }
      spawn({ pos, life: 0.15, size: 2.2, sizeEnd: 4.5, color: '#ffffff' });
      ring(pos, '#bfe9ff', 6.5, 0.38);
      const p2 = pos.clone().addScaledVector(dir, 2.2);
      ring(p2, '#e8f4ff', 4.5, 0.3);
      const p3 = pos.clone().addScaledVector(dir, 4.5);
      ring(p3, '#bfe9ff', 3, 0.26);
    },
    padRing(pos) { ring(pos, '#7dff9e', 3.2, 0.4); burst(pos, { count: 8, speed: 3, color: '#7dff9e', gravity: -2, life: 0.4 }); },
    trailPuff(pos, color) { spawn({ pos, life: 0.28, size: 0.34, sizeEnd: 0.05, color, opacity: 0.8 }); },
    respawnBeam(pos, color) {
      for (let i = 0; i < 10; i++) {
        spawn({ pos: new THREE.Vector3(pos.x, pos.y + i * 0.35, pos.z), life: 0.5, size: 0.9, sizeEnd: 0.1, color, opacity: 0.7 });
      }
      ring(new THREE.Vector3(pos.x, pos.y + 0.1, pos.z), color, 3, 0.5);
    },
    koBurst(pos, color) {
      burst(pos, { count: 22, speed: 8, size: 0.8, color, life: 0.8 });
      ring(pos, color, 5, 0.5);
    },
    celebrate(centerPos) {
      const colors = ['#ffd34d', '#ff5db1', '#40c8ff', '#7dff9e'];
      for (let i = 0; i < 10; i++) {
        fireworks.push({
          t: i * 0.35,
          color: SKY.U.pick(colors),
          pos: new THREE.Vector3(centerPos.x + SKY.U.rand(-12, 12), centerPos.y + SKY.U.rand(4, 10), centerPos.z + SKY.U.rand(-12, 12)),
        });
      }
    },
    floatText,
  };
})();
