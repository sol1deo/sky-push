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
      // additive glow washes out to WHITE over bright surfaces — fire and
      // smoke ask for normal blending so they keep their color anywhere
      p.spr.material.blending =
        o.blend === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
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

  /* ---------------------- water: splash + underwater ----------------------
   * splash: droplet crown + expanding foam ring at the surface.
   * underwater(vol): the whole GTA treatment while the CAMERA is submerged —
   * dense tinted fog, DOM overlay (tint/caustics/bubbles), muffled audio.  */
  function splash(pos, k) {
    ring(pos.clone(), '#eaf8ff', 2.5 + k * 3, 0.5);
    burst(pos, { count: 8 + Math.round(k * 14), speed: 3 + k * 5, color: '#dff2fc',
      gravity: 9, life: 0.6, size: 0.5 + k * 0.3 });
  }

  /* a single directed streak particle (current jets etc.) */
  function stream(pos, dir, speed, color) {
    spawn({
      pos: pos.clone(),
      vel: new THREE.Vector3(
        dir.x * speed + SKY.U.rand(-0.6, 0.6),
        dir.y * speed + SKY.U.rand(-0.6, 0.6),
        dir.z * speed + SKY.U.rand(-0.6, 0.6)),
      life: SKY.U.rand(0.5, 0.9), size: SKY.U.rand(0.22, 0.45), color,
      gravity: 0, drag: 0.3, opacity: 0.5,
    });
  }

  let uwOn = false, uwFog = null, uwBubbleT = 0, uwBaseCol = null, uwDarkEl = null;
  function underwater(vol, dt) {
    const on = !!vol;
    const el = document.getElementById('uw-ov');
    if (on !== uwOn) {
      uwOn = on;
      if (el) el.classList.toggle('hidden', !on);
      if (SKY.SFX.setUnderwater) SKY.SFX.setUnderwater(on);
      if (on) {
        uwBaseCol = new THREE.Color((vol.opts && vol.opts.color) || '#155a9e')
          .lerp(new THREE.Color('#06121f'), 0.25);
        uwFog = new THREE.Fog(uwBaseCol.clone(), 1.5, 55);
        uwFog.__uw = true;
        uwFog.__saved = scene.fog;
        scene.fog = uwFog;
        if (el && !uwDarkEl) {
          uwDarkEl = document.createElement('i');
          uwDarkEl.className = 'uwd';
          el.appendChild(uwDarkEl);
        }
      } else if (scene.fog && scene.fog.__uw) {
        scene.fog = scene.fog.__saved || null;   // map reloads replace fog anyway
        uwFog = null;
      }
    }
    if (on && camera) {
      // depth + the creator's light dial drive the murk: deeper = darker,
      // shorter sight; a midnight map is nearly black down there
      const depth = Math.max(0, vol.level - camera.position.y);
      const light = SKY.U.clamp(SKY.Map.lightMul ? SKY.Map.lightMul() : 1, 0.05, 2);
      if (uwFog) {
        const dk = SKY.U.clamp01(depth / 26);
        uwFog.far = SKY.U.lerp(52, 13, dk) * SKY.U.clamp(0.45 + light * 0.55, 0.4, 1.2);
        uwFog.color.copy(uwBaseCol)
          .multiplyScalar(SKY.U.clamp(0.25 + light * 0.75, 0.1, 1.15) * (1 - dk * 0.72));
      }
      if (uwDarkEl) {
        uwDarkEl.style.opacity = SKY.U.clamp(
          0.12 + (depth / 30) * 0.55 + (1 - Math.min(1, light)) * 0.35, 0, 0.85);
      }
      // lazy bubbles drifting up past the camera
      uwBubbleT -= dt;
      if (uwBubbleT <= 0) {
        uwBubbleT = 0.33;
        const p = camera.position;
        spawn({
          pos: new THREE.Vector3(p.x + SKY.U.rand(-4, 4), p.y - 2.5, p.z + SKY.U.rand(-4, 4)),
          vel: new THREE.Vector3(SKY.U.rand(-0.2, 0.2), SKY.U.rand(1.2, 2.4), SKY.U.rand(-0.2, 0.2)),
          life: 2.2, size: SKY.U.rand(0.06, 0.2), color: '#bfe6ff',
          gravity: -1.2, drag: 0.2, opacity: 0.55,
        });
      }
    }
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
      if (tip && !grp.userData.noTierGlow && kind !== 'hookgun' && kind !== 'cannon') {
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
        SKY.Profile.applyFinish(grp, finish, W.color, kind);
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

  /* ---------------- grenade models: one SILHOUETTE per type ----------------
   * he = classic pineapple frag · molly = incendiary canister with hazard
   * bands · vortex = sci-fi gyro orb. Shared by the thrown projectile, map
   * pickups and the HUD outline icon, so the shape flying at you matches
   * the shape in the UI. */
  function buildNadeMesh(type) {
    const M = wmats();
    const N = (SKY.TUNING.grenades || {})[type] || {};
    const accent = new THREE.MeshLambertMaterial({
      color: N.color || '#ffffff',
      emissive: new THREE.Color(N.color || '#ffffff').multiplyScalar(0.55),
    });
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => {
      const q = new THREE.Mesh(geo, mat);
      q.position.set(x || 0, y || 0, z || 0);
      g.add(q); return q;
    };
    if (type === 'molly') {
      const body = new THREE.MeshLambertMaterial({ color: 0x8a3020 });
      add(new THREE.CylinderGeometry(0.075, 0.075, 0.21, 12), body);
      add(new THREE.CylinderGeometry(0.079, 0.079, 0.032, 12), M.dark, 0, 0.1);   // cap
      add(new THREE.CylinderGeometry(0.079, 0.079, 0.032, 12), M.dark, 0, -0.1);  // base
      add(new THREE.CylinderGeometry(0.026, 0.032, 0.05, 8), M.metal, 0, 0.14);   // valve
      add(new THREE.TorusGeometry(0.077, 0.013, 6, 16), accent, 0, 0.028).rotation.x = Math.PI / 2;
      add(new THREE.TorusGeometry(0.077, 0.013, 6, 16), accent, 0, -0.04).rotation.x = Math.PI / 2;
    } else if (type === 'vortex') {
      const core = new THREE.MeshLambertMaterial({
        color: 0x2a1650, emissive: new THREE.Color('#8a68ff').multiplyScalar(0.75),
      });
      add(new THREE.SphereGeometry(0.075, 12, 12), core);
      add(new THREE.TorusGeometry(0.115, 0.015, 6, 20), M.metal).rotation.x = Math.PI / 2.6;
      const r2 = add(new THREE.TorusGeometry(0.115, 0.015, 6, 20), M.dark);
      r2.rotation.set(Math.PI / 2.6, 0, Math.PI / 2);
      add(new THREE.CylinderGeometry(0.02, 0.03, 0.045, 8), accent, 0, 0.12);     // pole caps
      add(new THREE.CylinderGeometry(0.03, 0.02, 0.045, 8), accent, 0, -0.12);
    } else {   // 'he' — the classic pineapple
      const body = new THREE.MeshLambertMaterial({ color: 0x44543c });
      add(new THREE.SphereGeometry(0.105, 12, 12), body, 0, -0.01);
      for (let i = -1; i <= 1; i++) {   // frag grooves
        const r = Math.sqrt(Math.max(1e-4, 0.105 * 0.105 - (i * 0.045) ** 2)) + 0.005;
        add(new THREE.TorusGeometry(r, 0.008, 5, 18), M.dark, 0, -0.01 + i * 0.045)
          .rotation.x = Math.PI / 2;
      }
      add(new THREE.TorusGeometry(0.107, 0.008, 5, 18), M.dark, 0, -0.01);        // vertical groove
      add(new THREE.CylinderGeometry(0.034, 0.04, 0.05, 8), M.metal, 0, 0.115);   // fuze head
      add(new THREE.BoxGeometry(0.02, 0.1, 0.03), M.metal, 0.05, 0.08).rotation.z = -0.55;
      add(new THREE.TorusGeometry(0.026, 0.006, 5, 12), accent, -0.05, 0.125);    // pull ring
    }
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return g;
  }

  /* ---------------- fire + vortex recipes (molly pool, effects) ----------------
   * flame(): one flame tongue — bright core inside an orange body, both
   * accelerating UP and tapering to a point, with occasional embers and a
   * faint smoke cap. Reads as fire instead of the old rising orange blob. */
  function flame(pos, s) {
    s = s || 1;
    const swx = SKY.U.rand(-0.6, 0.6), swz = SKY.U.rand(-0.6, 0.6);
    // NORMAL-blended body so the fire stays orange over bright ground
    spawn({ pos, vel: new THREE.Vector3(swx, SKY.U.rand(2, 3.4) * s, swz),
      life: SKY.U.rand(0.4, 0.65), size: SKY.U.rand(0.8, 1.15) * s, sizeEnd: 0.12,
      color: '#ff5a16', gravity: -6, drag: 1.5, blend: 'normal', opacity: 0.95 });
    spawn({ pos, vel: new THREE.Vector3(swx * 0.7, SKY.U.rand(1.8, 3) * s, swz * 0.7),
      life: SKY.U.rand(0.3, 0.48), size: SKY.U.rand(0.5, 0.7) * s, sizeEnd: 0.08,
      color: '#ffc23c', gravity: -5.5, drag: 1.3, blend: 'normal', opacity: 0.95 });
    if (Math.random() < 0.3) {   // ember riding the heat column
      spawn({ pos, vel: new THREE.Vector3(SKY.U.rand(-1.6, 1.6), SKY.U.rand(3, 5.5) * s, SKY.U.rand(-1.6, 1.6)),
        life: SKY.U.rand(0.6, 1.1), size: 0.1, sizeEnd: 0.03, color: '#ffc46a', gravity: -3, drag: 0.6 });
    }
    if (Math.random() < 0.2) {   // smoke cap above the tongues
      spawn({ pos: new THREE.Vector3(pos.x, pos.y + 1.1 * s, pos.z),
        vel: new THREE.Vector3(swx * 0.4, SKY.U.rand(0.8, 1.4), swz * 0.4),
        life: SKY.U.rand(0.6, 1), size: 0.5 * s, sizeEnd: 1.3 * s,
        color: '#33363e', opacity: 0.35, gravity: -0.5, drag: 0.5, blend: 'normal' });
    }
  }

  /* flamethrower muzzle: billowing tongues launched along the aim — the
     sprites GROW as they fly (sizeEnd >> size), so holding the trigger reads
     as one big rolling flame cone instead of confetti */
  function flameJet(pos, dir, speed) {
    const jx = SKY.U.rand(-1.4, 1.4), jy = SKY.U.rand(-0.6, 1.2), jz = SKY.U.rand(-1.4, 1.4);
    spawn({ pos, vel: new THREE.Vector3(dir.x * speed * 0.85 + jx,
        dir.y * speed * 0.85 + jy + 1, dir.z * speed * 0.85 + jz),
      life: SKY.U.rand(0.3, 0.42), size: 0.35, sizeEnd: SKY.U.rand(1.6, 2.4),
      color: '#ff5a16', gravity: -2, drag: 1.8, blend: 'normal', opacity: 0.92 });
    spawn({ pos, vel: new THREE.Vector3(dir.x * speed * 0.95,
        dir.y * speed * 0.95 + 0.5, dir.z * speed * 0.95),
      life: SKY.U.rand(0.22, 0.3), size: 0.3, sizeEnd: SKY.U.rand(0.9, 1.3),
      color: '#ffc23c', gravity: -1.5, drag: 1.6, blend: 'normal', opacity: 0.95 });
    if (Math.random() < 0.4) {   // darker outer roll
      spawn({ pos, vel: new THREE.Vector3(dir.x * speed * 0.6 + jx,
          dir.y * speed * 0.6 + 2, dir.z * speed * 0.6 + jz),
        life: SKY.U.rand(0.35, 0.5), size: 0.5, sizeEnd: 1.9,
        color: '#c2401a', gravity: -3, drag: 2.2, blend: 'normal', opacity: 0.8 });
    }
  }

  /* one growing fire billow along a flame round's flight */
  function flamePuff(pos, s) {
    spawn({ pos, vel: new THREE.Vector3(SKY.U.rand(-0.8, 0.8), SKY.U.rand(0.8, 2), SKY.U.rand(-0.8, 0.8)),
      life: SKY.U.rand(0.2, 0.3), size: s * 0.6, sizeEnd: s * 1.7,
      color: Math.random() < 0.35 ? '#ffc23c' : '#ff5a16',
      gravity: -2.5, drag: 1.4, blend: 'normal', opacity: 0.9 });
  }

  /* one orbiting streak around a vortex center — tangential velocity plus a
     slight inward pull, so the cloud visibly SWIRLS instead of popping */
  const _tan = new THREE.Vector3(), _rad = new THREE.Vector3();
  function swirl(pos, center, speed) {
    _rad.copy(pos).sub(center); _rad.y = 0;
    if (_rad.lengthSq() < 1e-4) _rad.set(1, 0, 0);
    _rad.normalize();
    _tan.set(-_rad.z, 0, _rad.x).multiplyScalar(speed);
    spawn({ pos, vel: new THREE.Vector3(
        _tan.x - _rad.x * speed * 0.35, SKY.U.rand(-0.4, 0.7), _tan.z - _rad.z * speed * 0.35),
      life: SKY.U.rand(0.45, 0.7), size: SKY.U.rand(0.4, 0.7), sizeEnd: 0.12,
      color: Math.random() < 0.3 ? '#dccdff' : '#7a5cff', gravity: 0, drag: 0.4,
      opacity: 0.95, blend: 'normal' });
  }

  /* ---------------- surface decals: bullet holes + blast scorch ----------------
   * Small textured quads glued to whatever got shot. Fixed ring buffer —
   * the oldest mark recycles first, everything fades out near end of life. */
  const DECAL_N = 48;
  const decals = [];
  let decalIdx = 0, holeTexCv = null, scorchTexCv = null;
  function bulletHoleTex() {
    if (holeTexCv) return holeTexCv;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    // ragged dark core with a bright chipped rim
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 15);
    grad.addColorStop(0, 'rgba(8,8,10,0.95)');
    grad.addColorStop(0.7, 'rgba(14,13,15,0.85)');
    grad.addColorStop(1, 'rgba(20,18,20,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(32, 32, 15, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 9; i++) {   // chips + cracks around the rim
      const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * 9;
      g.fillStyle = i % 3 ? 'rgba(10,10,12,0.5)' : 'rgba(235,235,240,0.18)';
      g.beginPath();
      g.arc(32 + Math.cos(a) * r, 32 + Math.sin(a) * r, 1.4 + Math.random() * 2.4, 0, Math.PI * 2);
      g.fill();
    }
    holeTexCv = new THREE.CanvasTexture(cv);
    return holeTexCv;
  }
  function scorchTex() {
    if (scorchTexCv) return scorchTexCv;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(10,9,8,0.7)');
    grad.addColorStop(0.5, 'rgba(16,14,12,0.4)');
    grad.addColorStop(1, 'rgba(20,18,16,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
    // soft charred blotches (crisp spokes read as a cartoon splat)
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 48;
      const br = 3 + Math.random() * 9;
      const x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r;
      const bg = g.createRadialGradient(x, y, 0, x, y, br);
      bg.addColorStop(0, 'rgba(8,7,6,' + (0.28 * (1 - r / 70)).toFixed(2) + ')');
      bg.addColorStop(1, 'rgba(8,7,6,0)');
      g.fillStyle = bg;
      g.beginPath(); g.arc(x, y, br, 0, Math.PI * 2); g.fill();
    }
    scorchTexCv = new THREE.CanvasTexture(cv);
    return scorchTexCv;
  }
  /* flamethrower burn: charred blotch with a faint ember-orange rim — walls
     read as BURNT, not shot (the bullet-hole chips looked like gunfire) */
  let burnTexCv = null;
  function burnTex() {
    if (burnTexCv) return burnTexCv;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 96;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(48, 48, 3, 48, 48, 46);
    grad.addColorStop(0, 'rgba(6,5,4,0.88)');
    grad.addColorStop(0.45, 'rgba(12,9,7,0.62)');
    grad.addColorStop(0.72, 'rgba(52,26,10,0.30)');   // scorched-brown halo
    grad.addColorStop(0.88, 'rgba(96,44,14,0.12)');   // faint ember rim
    grad.addColorStop(1, 'rgba(20,12,8,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(48, 48, 46, 0, Math.PI * 2); g.fill();
    // soot blotches, denser toward the middle (soft — spokes read cartoony)
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 34;
      const br = 3 + Math.random() * 7;
      const x = 48 + Math.cos(a) * r, y = 48 + Math.sin(a) * r;
      const bg = g.createRadialGradient(x, y, 0, x, y, br);
      bg.addColorStop(0, 'rgba(5,4,3,' + (0.34 * (1 - r / 52)).toFixed(2) + ')');
      bg.addColorStop(1, 'rgba(5,4,3,0)');
      g.fillStyle = bg;
      g.beginPath(); g.arc(x, y, br, 0, Math.PI * 2); g.fill();
    }
    burnTexCv = new THREE.CanvasTexture(cv);
    return burnTexCv;
  }
  const _dz = new THREE.Vector3(0, 0, 1);
  function ensureDecals() {
    if (decals.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < DECAL_N; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: null, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      mesh.visible = false;
      mesh.renderOrder = 1;
      scene.add(mesh);
      decals.push({ mesh, life: 0, max: 1 });
    }
  }
  /* burn accumulation spots: flame heat per world location (burnMark) */
  const burnSpots = [];
  let burnIdx = 0;
  for (let i = 0; i < 10; i++) {
    burnSpots.push({ pos: new THREE.Vector3(), normal: new THREE.Vector3(),
      heat: 0, hold: 0, rot: 0, d: null });
  }

  function placeDecal(pos, normal, size, tex, life) {
    if (!scene) return;
    ensureDecals();
    const d = decals[decalIdx++ % DECAL_N];
    d.opMul = 1;                 // burn decals dial this down (degrees of burn)
    d.life = d.max = life;
    if (d.mesh.material.map !== tex) {
      d.mesh.material.map = tex;
      d.mesh.material.needsUpdate = true;   // null->map recompiles the shader
    }
    d.mesh.material.opacity = 1;
    d.mesh.position.copy(pos).addScaledVector(normal, 0.015 + Math.random() * 0.008);
    d.mesh.quaternion.setFromUnitVectors(_dz, normal);
    d.mesh.rotateZ(Math.random() * Math.PI * 2);   // random roll = no wallpaper
    d.mesh.scale.set(size, size, 1);
    d.mesh.visible = true;
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
  /* skin FX objects (embers / shards / sparkles riding a weapon) — same
     ring-buffer deal; each carries its own userData.tick(t) */
  const animObjs = [];
  function registerAnimObj(obj) {
    animObjs.push(obj);
    if (animObjs.length > 40) animObjs.shift();
  }
  function tickAnimMats() {
    const t = performance.now() * 0.001;
    for (const m of animMats) {
      if (m.userData.animFx === 'skin') {           // textured skins drive shader uniforms
        if (m.userData.skinTick) m.userData.skinTick(t, m);
        continue;
      }
      if (!m.emissive) continue;
      if (m.userData.animFx === 'pulse') {
        const k = 0.5 + 0.5 * Math.sin(t * 3.2);
        m.emissive.set(m.userData.accent).multiplyScalar(0.12 + 0.5 * k);
      } else if (m.userData.animFx === 'spectrum') {
        m.emissive.setHSL((t * 0.13) % 1, 0.85, 0.3);
      }
    }
    for (const o of animObjs) {
      if (o.userData.tick && o.parent) o.userData.tick(t, o);
    }
  }

  const thumbCache = {};
  /* skin textures load async — a thumb rendered before its texture landed
     would cache black, so Profile clears the cache on every texture load */
  function invalidateThumbs() {
    for (const k in thumbCache) delete thumbCache[k];
  }
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
  function wireRender(mesh, rotY, zoom) {
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
    // 1.15 frames long thin weapons; chunky shapes (grenade ball) need to
    // sit further back or they overflow the 26° cone and render as slivers
    thumbRig.cam.position.set(0, 0.02, size * (zoom || 1.15));
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
    // crop to the drawn contour — a chunky shape rendered small in the
    // middle of the 280x150 canvas (the grenade) would otherwise show up
    // SQUISHED in its UI box, padded by acres of transparent pixels
    return cropToContent(out).toDataURL();
  }
  function cropToContent(cv) {
    const W = cv.width, H = cv.height;
    const data = cv.getContext('2d').getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return cv;
    const pad = 5;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
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

  /* grenade outline icon for the HUD chip — rendered from THIS type's
     unique model, so HE / fire / vortex are tellable apart at a glance */
  function nadeWireIcon(type, colorHex) {
    const key = 'nade:' + type + '|' + colorHex;
    if (wireCache[key]) return wireCache[key];
    try {
      const src = wireRender(buildNadeMesh(type), -Math.PI / 2 + 0.35, 2.2);
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
    root: null,                 // camera child carrying the WHOLE viewmodel
    group: null, kind: null, kick: 0, bobT: 0, sway: { x: 0, y: 0 },
    baseX: 0.3, baseY: -0.27,   // rest/bob position BEFORE anim offsets
    tipWorld: new THREE.Vector3(),
    swapPhase: null, swapNext: null, swapBlend: 1,   // holster/draw anim
    hook: null, hookTipWorld: new THREE.Vector3(),
    hookTarget: 0, hookBlend: 0,                     // left arm up/down
    cannon: null, cannonT: 0,                        // air-cannon pop (Q)
    visible: true,
  };

  /* first-person weapons live on render layer 1: the main loop draws them in
     a second, depth-cleared pass so they can't poke through walls */
  const VM_LAYER = 1;
  function toVmLayer(grp) {
    grp.traverse((o) => o.layers.set(VM_LAYER));
  }

  /* sway/bob/kick land on this shared root so the gun AND the arms move as
     one body; per-item offsets (rest pose, reload, holster) stay local */
  function ensureRoot() {
    if (vm.root || !camera) return vm.root;
    vm.root = new THREE.Group();
    camera.add(vm.root);
    return vm.root;
  }

  function mountWeapon(kind, draw) {
    if (vm.group) vm.root.remove(vm.group);
    ensureRoot();
    vm.kind = kind;
    const fin = SKY.Profile && SKY.Profile.finishFor(kind);
    vm.group = buildWeaponMesh(kind, fin);
    // mythic finishes can carry a signature reload flourish
    vm.finReload = (fin && SKY.Profile && SKY.Profile.finishDef(fin).reload) || null;
    vm.group.scale.setScalar(0.85);
    vm.group.position.set(0.3, -0.27, -0.52);
    vm.group.visible = vm.visible;
    toVmLayer(vm.group);
    vm.root.add(vm.group);
    if (draw && SKY.Arms) SKY.Arms.startDraw(kind);
  }

  function ensureWeapon(kind) {
    if (!camera || vm.kind === kind || vm.swapNext === kind) return;
    if (!vm.group) { mountWeapon(kind, true); return; }   // first equip
    vm.swapNext = kind;                              // animated holster→draw
    vm.swapPhase = 'down';
  }

  function ensureHook() {
    if (vm.hook || !camera) return;
    ensureRoot();
    vm.hook = buildWeaponMesh('hookgun', SKY.Profile && SKY.Profile.finishFor('hookgun'));
    vm.hook.scale.setScalar(0.85);
    vm.hook.position.set(-0.32, -0.9, -0.5);
    vm.hook.visible = vm.visible;
    toVmLayer(vm.hook);
    vm.root.add(vm.hook);
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
      ensureRoot();
      vm.cannon = buildWeaponMesh('cannon', SKY.Profile && SKY.Profile.finishFor('cannon'));
      vm.cannon.scale.setScalar(0.85);
      vm.cannon.visible = false;
      toVmLayer(vm.cannon);
      vm.root.add(vm.cannon);
    }
    vm.cannonT = 0.0001;
  }

  /* a locker equip changed a finish — rebuild every cached weapon mesh so the
     new skin shows without a page reload (third-person rebuilds itself via
     the gunFin guard in characters.setWeapon) */
  function refreshSkins() {
    if (!camera) return;
    if (vm.kind) mountWeapon(vm.kind);            // remove+rebuild in place
    if (vm.hook) { vm.root.remove(vm.hook); vm.hook = null; }    // lazy rebuild
    if (vm.cannon) { vm.root.remove(vm.cannon); vm.cannon = null; }
    if (SKY.Arms) SKY.Arms.refresh();             // arms follow the character
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
    // scorch mark charred onto whatever's under the blast
    if (SKY.World && SKY.World.raycast) {
      const gh = SKY.World.raycast(pos, _v.set(0, -1, 0), r * 1.2);
      if (gh) placeDecal(gh.point, gh.normal, r * 1.1, scorchTex(), 18);
    }
  }

  function muzzleLight(pos) {
    if (!muzzleLightObj) {
      muzzleLightObj = new THREE.PointLight(0xffd9a0, 0, 9, 2);
      muzzleLightObj.layers.enableAll();   // must also light the vm pass
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

  /* mythic-skin bullets: tint the pooled tracer (null = back to stock warm);
     skinned rounds also get a slightly larger, hotter head */
  function tintTracer(vis, colorHex) {
    vis.head.material.color.set(colorHex || 0xfff2d0);
    vis.trail.material.color.set(colorHex || 0xffe2a8);
    const s = colorHex ? 0.5 : 0.38;
    vis.head.scale.set(s, s, 1);
  }

  /* skin-styled bullet IMPACT — replaces the stock white spark burst so the
     whole shot (muzzle → tracer → trail → impact) wears the mythic */
  function skinImpact(pos, normal, style) {
    const p = pos.clone().addScaledVector(normal, 0.05);
    const kick = (spd, spread) => new THREE.Vector3(
      normal.x * spd + SKY.U.rand(-spread, spread),
      normal.y * spd + SKY.U.rand(-spread * 0.5, spread),
      normal.z * spd + SKY.U.rand(-spread, spread));
    if (style === 'flame') {
      spawn({ pos: p.clone(), life: 0.16, size: 0.45, sizeEnd: 0.95, color: '#ff9838', opacity: 0.85 });
      for (let i = 0; i < 6; i++) {
        spawn({ pos: p.clone(), vel: kick(2.6, 2.2), life: SKY.U.rand(0.25, 0.42),
          size: 0.1, sizeEnd: 0.02, color: i % 2 ? '#ff7a20' : '#ffc23c', gravity: -2, drag: 1.2 });
      }
    } else if (style === 'spark') {
      spawn({ pos: p.clone(), life: 0.1, size: 0.55, sizeEnd: 0.2, color: '#bdefff' });
      for (let i = 0; i < 9; i++) {
        spawn({ pos: p.clone(), vel: kick(4.5, 4.2), life: SKY.U.rand(0.09, 0.2),
          size: 0.08, sizeEnd: 0.015, color: i % 3 ? '#59d8ff' : '#ffffff', drag: 1.5 });
      }
      ring(p, '#59d8ff', 0.9, 0.18);
    } else if (style === 'void') {
      spawn({ pos: p.clone(), life: 0.12, size: 0.4, sizeEnd: 0.12, color: '#8a4dff' });
      for (let i = 0; i < 5; i++) {
        spawn({ pos: p.clone(), vel: kick(1.4, 1.2), life: SKY.U.rand(0.3, 0.5),
          size: 0.14, sizeEnd: SKY.U.rand(0.4, 0.6), color: '#241040',
          opacity: 0.6, drag: 1, blend: 'normal' });
      }
    } else if (style === 'star') {
      spawn({ pos: p.clone(), life: 0.14, size: 0.5, sizeEnd: 0.15, color: '#b46bff' });
      for (let i = 0; i < 7; i++) {
        spawn({ pos: p.clone(), vel: kick(3, 2.6), life: SKY.U.rand(0.2, 0.4),
          size: 0.07, sizeEnd: 0.012, color: i % 2 ? '#e0c8ff' : '#ffffff', drag: 0.8 });
      }
    } else if (style === 'gold') {
      spawn({ pos: p.clone(), life: 0.14, size: 0.45, sizeEnd: 0.15, color: '#ffd34d' });
      for (let i = 0; i < 8; i++) {
        spawn({ pos: p.clone(), vel: kick(2.6, 2.4), life: SKY.U.rand(0.3, 0.5),
          size: 0.08, sizeEnd: 0.015, color: i % 2 ? '#ffd34d' : '#fff4c0', gravity: 5, drag: 0.7 });
      }
    } else if (style === 'blood') {
      // BLOOD MOON: crimson flash, dark droplets that sag, a red ring
      spawn({ pos: p.clone(), life: 0.13, size: 0.45, sizeEnd: 0.14, color: '#ff2e4a' });
      for (let i = 0; i < 7; i++) {
        spawn({ pos: p.clone(), vel: kick(2.2, 1.8), life: SKY.U.rand(0.28, 0.48),
          size: 0.1, sizeEnd: 0.03, color: i % 2 ? '#a3122b' : '#ff4a5e',
          gravity: 7, drag: 0.9, blend: i % 2 ? 'normal' : undefined });
      }
      ring(p, '#ff2e4a', 0.8, 0.16);
    }
  }

  /* mythic-skin bullet trail — one light particle per call, throttled by the
     caller. Styles match the finish: flame/spark/void/star/gold. */
  function skinTrail(pos, style) {
    const p = pos.clone();
    if (style === 'flame') {
      spawn({ pos: p, vel: new THREE.Vector3(SKY.U.rand(-0.4, 0.4), SKY.U.rand(0.5, 1.4), SKY.U.rand(-0.4, 0.4)),
        life: SKY.U.rand(0.22, 0.34), size: SKY.U.rand(0.14, 0.24), sizeEnd: 0.04,
        color: Math.random() < 0.6 ? '#ff7a20' : '#ffc23c', gravity: -2, drag: 1.2,
        blend: 'normal', opacity: 0.9 });
    } else if (style === 'spark') {
      spawn({ pos: p, vel: new THREE.Vector3(SKY.U.rand(-2.5, 2.5), SKY.U.rand(-2.5, 2.5), SKY.U.rand(-2.5, 2.5)),
        life: SKY.U.rand(0.08, 0.16), size: 0.09, sizeEnd: 0.02,
        color: Math.random() < 0.7 ? '#59d8ff' : '#e8fbff', drag: 2 });
    } else if (style === 'void') {
      spawn({ pos: p, vel: new THREE.Vector3(SKY.U.rand(-0.3, 0.3), SKY.U.rand(-0.2, 0.4), SKY.U.rand(-0.3, 0.3)),
        life: SKY.U.rand(0.3, 0.45), size: 0.12, sizeEnd: SKY.U.rand(0.3, 0.45),
        color: '#241040', opacity: 0.55, drag: 0.8, blend: 'normal' });
      if (Math.random() < 0.3) {
        spawn({ pos: p, life: 0.15, size: 0.08, sizeEnd: 0.02, color: '#8a4dff' });
      }
    } else if (style === 'star') {
      spawn({ pos: p, vel: new THREE.Vector3(SKY.U.rand(-0.5, 0.5), SKY.U.rand(-0.5, 0.5), SKY.U.rand(-0.5, 0.5)),
        life: SKY.U.rand(0.25, 0.45), size: 0.07, sizeEnd: 0.015,
        color: Math.random() < 0.75 ? '#b46bff' : '#ffffff', drag: 0.5 });
    } else if (style === 'gold') {
      spawn({ pos: p, vel: new THREE.Vector3(SKY.U.rand(-0.4, 0.4), SKY.U.rand(-0.6, 0.2), SKY.U.rand(-0.4, 0.4)),
        life: SKY.U.rand(0.25, 0.4), size: 0.08, sizeEnd: 0.02,
        color: Math.random() < 0.6 ? '#ffd34d' : '#fff4c0', gravity: 3, drag: 0.6 });
    } else if (style === 'blood') {
      // crimson streak that drips: bright bead + a sagging dark droplet
      spawn({ pos: p, vel: new THREE.Vector3(SKY.U.rand(-0.3, 0.3), SKY.U.rand(-0.8, 0), SKY.U.rand(-0.3, 0.3)),
        life: SKY.U.rand(0.22, 0.38), size: 0.09, sizeEnd: 0.02,
        color: Math.random() < 0.65 ? '#ff2e4a' : '#ff8090', gravity: 4, drag: 0.7 });
      if (Math.random() < 0.25) {
        spawn({ pos: p, life: SKY.U.rand(0.3, 0.45), size: 0.11, sizeEnd: 0.3,
          color: '#3d0a14', opacity: 0.5, drag: 0.8, blend: 'normal' });
      }
    }
  }

  /* ================================================================= */
  /* ---------------- SNOW WEATHER ----------------
   * One Points cloud recycled in a box around the camera. setSnow(x01) is
   * the map's snowfall dial; setSnowStorm(k, dir) is the blizzard event's
   * temporary boost (denser, faster, wind-slanted). Round-65 lesson: bare
   * gl_Points draw as hard squares — the radial blob map is mandatory. */
  const SNOW_N = 1100;
  const SNOW_HX = 46, SNOW_HY = 26, SNOW_HZ = 46;
  let snowPts = null, snowGeo = null, snowMat = null, snowVel = null;
  let snowAmt = 0, snowStorm = 0;
  const snowWind = new THREE.Vector3();
  function ensureSnow() {
    if (snowPts || !scene) return;
    snowGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(SNOW_N * 3);
    snowVel = new Float32Array(SNOW_N * 2);          // [fall speed, drift phase]
    for (let i = 0; i < SNOW_N; i++) {
      pos[i * 3] = SKY.U.rand(-SNOW_HX, SNOW_HX);
      pos[i * 3 + 1] = SKY.U.rand(-SNOW_HY, SNOW_HY);
      pos[i * 3 + 2] = SKY.U.rand(-SNOW_HZ, SNOW_HZ);
      snowVel[i * 2] = 2.2 + Math.random() * 2.6;
      snowVel[i * 2 + 1] = Math.random() * Math.PI * 2;
    }
    snowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    snowMat = new THREE.PointsMaterial({
      map: SKY.U.blobTexture(), color: 0xf4f8ff, size: 0.16,
      transparent: true, opacity: 0.8, depthWrite: false,
    });
    snowPts = new THREE.Points(snowGeo, snowMat);
    snowPts.frustumCulled = false;
    snowPts.renderOrder = 3;
    scene.add(snowPts);
  }
  const _snowWrap = (v, half) => {
    const span = half * 2;
    return ((v % span) + span * 1.5) % span - half;
  };
  function tickSnow(dt) {
    const want = Math.min(1, snowAmt + snowStorm);
    if (!snowPts && want <= 0.01) return;
    ensureSnow();
    if (!snowPts) return;
    snowPts.visible = want > 0.01;
    if (!snowPts.visible || !camera) return;
    const n = Math.max(30, Math.floor(SNOW_N * want));
    snowGeo.setDrawRange(0, n);
    snowMat.opacity = 0.45 + 0.4 * want;
    const cp = camera.position;
    const t = performance.now() * 0.001;
    const a = snowGeo.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const ph = snowVel[i * 2 + 1];
      let x = a[i * 3] + (Math.sin(t * 1.3 + ph) * 0.55 + snowWind.x) * dt;
      let y = a[i * 3 + 1] - snowVel[i * 2] * (1 + snowStorm * 1.7) * dt;
      let z = a[i * 3 + 2] + (Math.cos(t * 1.1 + ph * 1.7) * 0.55 + snowWind.z) * dt;
      // recycle every flake into the camera-centered box (also covers the
      // camera itself moving — flakes wrap instead of being left behind)
      a[i * 3] = cp.x + _snowWrap(x - cp.x, SNOW_HX);
      a[i * 3 + 1] = cp.y + _snowWrap(y - cp.y, SNOW_HY);
      a[i * 3 + 2] = cp.z + _snowWrap(z - cp.z, SNOW_HZ);
    }
    snowGeo.attributes.position.needsUpdate = true;
  }

  /* ---------------- RAIN + LIGHTNING (storm weather) ----------------
   * Rain = line segments recycled around the camera (points read as snow);
   * lightning = screen flash + light spike + a jagged bolt in the distance.
   * Both are COSMETIC — per-client randomness is fine (no sync needed). */
  const RAIN_N = 700;
  const RAIN_HX = 30, RAIN_HY = 22, RAIN_HZ = 30;
  let rainSeg = null, rainGeo = null, rainMat = null, rainDrop = null;
  let rainAmt = 0;
  function ensureRain() {
    if (rainSeg || !scene) return;
    rainGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(RAIN_N * 6);          // 2 verts per drop
    rainDrop = new Float32Array(RAIN_N * 4);           // x,y,z,speed per drop
    for (let i = 0; i < RAIN_N; i++) {
      rainDrop[i * 4] = SKY.U.rand(-RAIN_HX, RAIN_HX);
      rainDrop[i * 4 + 1] = SKY.U.rand(-RAIN_HY, RAIN_HY);
      rainDrop[i * 4 + 2] = SKY.U.rand(-RAIN_HZ, RAIN_HZ);
      rainDrop[i * 4 + 3] = 20 + Math.random() * 9;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rainMat = new THREE.LineBasicMaterial({
      color: 0xaec6e0, transparent: true, opacity: 0.34, depthWrite: false,
    });
    rainSeg = new THREE.LineSegments(rainGeo, rainMat);
    rainSeg.frustumCulled = false;
    rainSeg.renderOrder = 3;
    scene.add(rainSeg);
  }
  function tickRain(dt) {
    if (!rainSeg && rainAmt <= 0.01) return;
    ensureRain();
    if (!rainSeg) return;
    rainSeg.visible = rainAmt > 0.01;
    if (!rainSeg.visible || !camera) return;
    const n = Math.max(40, Math.floor(RAIN_N * rainAmt));
    rainGeo.setDrawRange(0, n * 2);
    rainMat.opacity = 0.2 + 0.22 * rainAmt;
    const cp = camera.position;
    const a = rainGeo.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const v = rainDrop[i * 4 + 3];
      let x = rainDrop[i * 4] + 2.2 * dt;              // slight constant drift
      let y = rainDrop[i * 4 + 1] - v * dt;
      let z = rainDrop[i * 4 + 2];
      x = cp.x + _snowWrap(x - cp.x, RAIN_HX);
      y = cp.y + _snowWrap(y - cp.y, RAIN_HY);
      z = cp.z + _snowWrap(z - cp.z, RAIN_HZ);
      rainDrop[i * 4] = x; rainDrop[i * 4 + 1] = y; rainDrop[i * 4 + 2] = z;
      const len = 0.3 + v * 0.014;
      a[i * 6] = x; a[i * 6 + 1] = y; a[i * 6 + 2] = z;
      a[i * 6 + 3] = x + 0.1; a[i * 6 + 4] = y + len; a[i * 6 + 5] = z;
    }
    rainGeo.attributes.position.needsUpdate = true;
  }
  /* lightning: DOM double-flash + a point-light spike + a distant bolt */
  let stormOv = null, stormFlashT = 0, stormLight = null, boltLine = null, boltT = 0;
  function lightning(k) {
    k = k === undefined ? 1 : k;
    if (!stormOv) {
      stormOv = document.createElement('div');
      stormOv.style.cssText = 'position:fixed;inset:0;background:#eaf2ff;opacity:0;' +
        'pointer-events:none;z-index:3;';
      document.body.appendChild(stormOv);
    }
    stormFlashT = 0.42;                       // double-blink decays in tick
    if (scene && camera) {
      if (!stormLight) {
        stormLight = new THREE.PointLight(0xdfeaff, 0, 500);
        scene.add(stormLight);
      }
      const ang = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
      stormLight.position.set(camera.position.x + Math.cos(ang) * d, 70,
        camera.position.z + Math.sin(ang) * d);
      stormLight.intensity = 2.6 * k;
      // jagged bolt under the light: rebuilt per strike, fades in ~0.18s
      if (!boltLine) {
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(14 * 3), 3));
        boltLine = new THREE.Line(bg, new THREE.LineBasicMaterial({
          color: 0xf2f7ff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false }));
        boltLine.frustumCulled = false;
        scene.add(boltLine);
      }
      const bp = boltLine.geometry.attributes.position.array;
      let bx = stormLight.position.x, bz = stormLight.position.z;
      for (let i = 0; i < 14; i++) {
        const f = i / 13;
        bp[i * 3] = bx; bp[i * 3 + 1] = 78 * (1 - f); bp[i * 3 + 2] = bz;
        bx += SKY.U.rand(-4, 4); bz += SKY.U.rand(-4, 4);
      }
      boltLine.geometry.attributes.position.needsUpdate = true;
      boltT = 0.2;
    }
  }
  function tickStorm(dt) {
    if (stormFlashT > 0) {
      stormFlashT = Math.max(0, stormFlashT - dt);
      // two pulses: a hard leader flash and a softer return stroke
      const tt = 0.42 - stormFlashT;
      const p = tt < 0.08 ? tt / 0.08 : tt < 0.14 ? 0.35 :
                tt < 0.2 ? 0.6 : Math.max(0, stormFlashT / 0.22) * 0.4;
      if (stormOv) stormOv.style.opacity = (p * 0.32).toFixed(3);
    } else if (stormOv && stormOv.style.opacity !== '0') {
      stormOv.style.opacity = '0';
    }
    if (stormLight && stormLight.intensity > 0) {
      stormLight.intensity = Math.max(0, stormLight.intensity - dt * 14);
    }
    if (boltLine && boltT > 0) {
      boltT = Math.max(0, boltT - dt);
      boltLine.material.opacity = Math.min(1, boltT / 0.14);
    } else if (boltLine && boltLine.material.opacity > 0) {
      boltLine.material.opacity = 0;
    }
  }

  return {
    shakeOffset: shakeOff,
    splash, underwater, stream,
    /* map rain dial + a lightning strike trigger (map.js storm ticker) */
    setRain(x01) { rainAmt = SKY.U.clamp01(x01 || 0); },
    lightning,
    /* map snowfall dial (0 = clear skies) */
    setSnow(x01) { snowAmt = SKY.U.clamp01(x01 || 0); },
    /* blizzard event: k = 0..1 storm strength, dir = world wind direction */
    setSnowStorm(k, dir) {
      snowStorm = SKY.U.clamp01(k || 0);
      if (dir && snowStorm > 0) snowWind.copy(dir).setY(0).normalize().multiplyScalar(14 * snowStorm);
      else snowWind.set(0, 0, 0);
    },
    camera() { return camera; },   // map culler / anyone needing the live cam

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
      tickSnow(dt);     // winter weather (map dial + blizzard events)
      tickRain(dt);     // storm weather
      tickStorm(dt);    // lightning flash/bolt decay
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
      // decals age out (fade across the last quarter of their life)
      for (const d of decals) {
        if (d.life <= 0) continue;
        d.life -= dt;
        if (d.life <= 0) { d.mesh.visible = false; continue; }
        d.mesh.material.opacity = Math.min(1, (d.life / d.max) * 4) * (d.opMul || 1);
      }
      // burn spots cool once the flame moves off them
      for (const s of burnSpots) {
        if (s.heat <= 0) continue;
        s.hold -= dt;
        if (s.hold <= 0) {
          s.heat = Math.max(0, s.heat - dt * 6);
          if (s.heat <= 0 && s.d) s.d = null;   // the mark fades on its own
        }
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
      // heavies slide back further AND rear up like the gun wants out.
      // Kick rides the shared ROOT so the arms recoil with the gun.
      if (vm.root) {
        vm.kick = Math.max(0, vm.kick - vm.kick * 8 * dt);
        vm.root.position.z = vm.kick * 0.19;
        vm.root.rotation.x = vm.kick * 0.09;
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
      // holster→draw swap: drop fast, raise snappy (+ arms draw gesture)
      if (vm.swapPhase === 'down') {
        vm.swapBlend = Math.max(0, vm.swapBlend - dt / 0.09);
        if (vm.swapBlend === 0 && vm.swapNext) {
          mountWeapon(vm.swapNext, true);
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
      if (vm.root) vm.root.visible = v;   // covers the arms rig too
      if (vm.group) vm.group.visible = v && vm.hookBlend < 0.96;
      if (vm.hook) vm.hook.visible = v && vm.hookBlend > 0.04;
    },

    /* weapon feel: mouse-lag sway, run bob, fall tilt, slide roll, fire kick.
       Sway/bob/tilt ride the shared ROOT so the gun and the arms move as one
       body; reload/draw choreography (mag out, bolt racks…) is sampled by
       SKY.Arms from per-class timelines. Mythic finishes keep their gun
       flourish (barrel roll / BLOOD MOON toss) on the gun-local transform. */
    viewmodelMotion(dt, speed, grounded, velY, sliding, reloadFrac) {
      if (!vm.group || !vm.root) return;
      const d = SKY.Input.takeFrameDelta();
      vm.sway.x = SKY.U.damp(vm.sway.x, SKY.U.clamp(-d.dx * 0.0022, -0.09, 0.09), 9, dt);
      vm.sway.y = SKY.U.damp(vm.sway.y, SKY.U.clamp(d.dy * 0.0022, -0.07, 0.07), 9, dt);
      let spin = 0, dip = 0, roll = 0;
      if (reloadFrac !== undefined && reloadFrac >= 0 && vm.finReload) {
        const k = reloadFrac * reloadFrac * (3 - 2 * reloadFrac);   // smoothstep
        if (vm.finReload === 'spin') {
          // mythic flourish: sideways BARREL ROLL instead of the mag choreography
          roll = -Math.PI * 2 * k;
          dip = Math.sin(Math.PI * reloadFrac) * 0.05;
        } else if (vm.finReload === 'toss') {
          // BLOOD MOON: the gun is TOSSED — flies up double-flipping, drops
          // back into the hand right as the mag clicks home
          spin = -Math.PI * 4 * k;
          dip = -Math.sin(Math.PI * reloadFrac) * 0.34 * 0.35;   // gun RISES
        }
      }
      // shared root: everything below moves gun + hands + hook together
      const R = vm.root;
      R.rotation.y = vm.sway.x;
      R.rotation.x = vm.kick * 0.5 + vm.sway.y +
        SKY.U.clamp(velY * 0.004, -0.08, 0.08);
      vm.rz = SKY.U.damp(vm.rz || 0, sliding ? 0.18 : vm.sway.x * 0.5, 8, dt);
      R.rotation.z = vm.rz;
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
      R.position.x = vm.baseX - 0.3;
      R.position.y = vm.baseY + 0.27;
      // gun-local: rest pose + mythic flourish; holstering / grappling pulls
      // the weapon down out of frame (the right hand follows it via IK)
      const lower = (1 - vm.swapBlend) * 0.55 + vm.hookBlend * 0.62;
      vm.group.position.set(0.3, -0.27 - dip - lower, -0.52);
      vm.group.rotation.set(
        spin + (1 - vm.swapBlend) * 0.9 + vm.hookBlend * 0.8, 0, roll);
      // the left hook arm pops up while grappling (root already sways/bobs)
      if (vm.hook) {
        const hb = vm.hookBlend;
        vm.hook.position.set(-0.32, -0.28 - (1 - hb) * 0.62, -0.5);
        vm.hook.rotation.set((1 - hb) * 0.9, 0, -0.08);
      }
      // arms: sample the reload/draw timeline, aim hand IK targets, pose
      if (SKY.Arms) SKY.Arms.update(dt, vm, reloadFrac);
    },
    ensureWeapon, setHands, hookTip,
    speedLines: speedLinesTick,

    viewmodelTip() {
      if (!vm.group) return null;
      const tip = vm.group.getObjectByName('tip');
      if (!tip) return null;
      tip.getWorldPosition(vm.tipWorld);
      return vm.tipWorld;
    },
    /* the gun's SCREEN-corner anchor — the visual muzzle whenever the real
       tip can't be used (point-blank aim, tip poking into a wall…). Falling
       back to the EYE put tracers dead-center = "bullets out of my head". */
    muzzleAnchor(out) {
      if (!camera) return null;
      return camera.localToWorld(out.set(0.26, -0.22, -0.45));
    },
    /* the camera-mounted first-person groups (replay greenscreen layers) */
    vmGroups() { return [vm.root].filter(Boolean); },
    _vm: vm,   // debug/test access (CDP tuning harness)
    /* the shared viewmodel root — SKY.Arms parents its rig here so hide /
       sway / kick cover the arms without extra bookkeeping */
    vmRoot() { return ensureRoot(); },

    shake(amp) { shakeAmp = Math.min(shakeAmp + amp, 3); },
    cannonPop,
    getFovKick() { return fovKick; },
    ring(pos, color, size, life) { ring(pos, color, size, life); },
    burst, blastBoom, registerAnimMat, registerAnimObj, invalidateThumbs, refreshSkins,

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
    tracer, muzzleLight, buildWeaponMesh, buildNadeMesh, weaponThumb, weaponSideIcon,
    weaponWireIcon, nadeWireIcon,
    makeTracer, poseTracer, resetTracer, tintTracer, skinTrail, skinImpact,
    flame, swirl, flameJet, flamePuff,
    /* decals */
    bulletHole(pos, normal) {
      placeDecal(pos, normal, 0.15 + Math.random() * 0.07, bulletHoleTex(), 14);
    },
    /* flame impact: burns BUILD UP — nothing shows until a spot has been
       flamed for a beat, then the mark deepens and spreads with exposure
       (degrees of burn). Called for every flame world-hit; heat cools when
       the jet moves away, so a sweep leaves faint scorches and a held jet
       chars the wall black. */
    burnMark(pos, normal) {
      ensureDecals();
      let spot = null;
      for (const s of burnSpots) {
        if (s.heat > 0 && s.pos.distanceToSquared(pos) < 1.1) { spot = s; break; }
      }
      if (!spot) {
        spot = burnSpots[burnIdx++ % burnSpots.length];
        spot.pos.copy(pos);
        spot.normal.copy(normal);
        spot.heat = 0;
        spot.rot = Math.random() * Math.PI * 2;
        if (spot.d) { spot.d.mesh.visible = false; spot.d = null; }
      }
      spot.heat = Math.min(30, spot.heat + 1);
      spot.hold = 1.2;                        // keeps cooling at bay while fed
      // ~0.35s of sustained flame (18 rps) before the first mark shows
      if (!spot.d && spot.heat >= 6) {
        const d = decals[decalIdx++ % DECAL_N];
        d.life = d.max = 14;
        if (d.mesh.material.map !== burnTex()) {
          d.mesh.material.map = burnTex();
          d.mesh.material.needsUpdate = true;
        }
        d.mesh.position.copy(spot.pos).addScaledVector(spot.normal, 0.02);
        d.mesh.quaternion.setFromUnitVectors(_dz, spot.normal);
        d.mesh.rotateZ(spot.rot);
        d.mesh.visible = true;
        spot.d = d;
      }
      if (spot.d) {
        // degree of burn: opacity + size track the accumulated heat
        // (opMul because the decal tick recomputes opacity every frame)
        const k = SKY.U.clamp01((spot.heat - 5) / 22);
        spot.d.life = spot.d.max = 12 + k * 10;      // deep burns outlive light ones
        spot.d.opMul = 0.25 + k * 0.75;
        const sz = 0.55 + k * 1.15;
        spot.d.mesh.scale.set(sz, sz, 1);
      }
    },
    scorch(pos, normal, size, life) {
      placeDecal(pos, normal, size || 2, scorchTex(), life || 18);
    },
    clearDecals() {
      for (const d of decals) { d.life = 0; d.mesh.visible = false; }
    },
    cannonBlast(pos, dir, skin) {
      // a proper pressure wave: dense forward cone + white core flash +
      // double expanding rings that travel with the blast direction.
      // A mythic cannon skin recolors the whole wave and salts it with the
      // skin's signature particles (skin = finish tracer {color, trail}).
      const cone = skin ? skin.color : '#bfe9ff';
      for (let i = 0; i < 26; i++) {
        const v = dir.clone().multiplyScalar(SKY.U.rand(5, 16));
        v.x += SKY.U.rand(-3.5, 3.5); v.y += SKY.U.rand(-1.5, 3.5); v.z += SKY.U.rand(-3.5, 3.5);
        spawn({ pos, vel: v, life: SKY.U.rand(0.25, 0.55), size: SKY.U.rand(0.7, 1.3), color: cone, gravity: 2, drag: 2.5 });
      }
      spawn({ pos, life: 0.15, size: 2.2, sizeEnd: 4.5, color: '#ffffff' });
      ring(pos, cone, 6.5, 0.38);
      const p2 = pos.clone().addScaledVector(dir, 2.2);
      ring(p2, skin ? skin.color : '#e8f4ff', 4.5, 0.3);
      const p3 = pos.clone().addScaledVector(dir, 4.5);
      ring(p3, cone, 3, 0.26);
      if (skin) {
        for (let i = 0; i < 10; i++) {
          skinTrail(pos.clone().addScaledVector(dir, SKY.U.rand(0.4, 4)), skin.trail);
        }
      }
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
