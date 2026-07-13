/* =============================================================================
 * SKY PUSH — maps
 * Five arenas, each with its own setting, mood lighting and a scripted EVENT
 * that fires periodically (twice as often in OVERTIME):
 *   sky      golden-hour floating platforms · event: none (OVERTIME crumbles it)
 *   convoy   dusk highway, fight ON three semi-trucks driving forever ·
 *            event: BREAKDOWN — a truck brakes, falls behind, catches back up
 *   foundry  dark lava cavern · event: ERUPTION — telegraphed geysers launch you
 *   rooftop  neon night rooftops · event: WIND GUST — sideways shove for 2.5s
 *   temple   storm-lit ruins · event: LIGHTNING — telegraphed strike, big knock
 * The cinematic look is all lighting: low warm keys, long shadows, gradient
 * sky domes, dense fog — zero post-processing cost.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Map = (function () {
  let scene = null, group = null;
  let currentId = 'sky';
  let dirty = false;
  const decor = [];
  const clouds = [];
  const tickers = [];             // per-map update functions(dt, time)
  const crumbleList = [];
  const fallingMeshes = [];
  let shaking = null;
  let crumbleTimer = 0;
  let overtime = false;
  let eventT = 0, eventCfg = null;
  let starLayer = null, meteor = null, meteorT = 6;   // night-sky animation
  let skyGroup = null;   // dome/stars/sun ride the CAMERA — leaving the dome
                         // sphere used to paint a growing black circle
  const doors = [];               // interactable doors (E toggles, net-synced)
  const _v = new THREE.Vector3();

  const MAPS = {
    sky:      { name: 'SKY ARENA', overtimeMsg: 'the arena is falling apart!' },
    yacht:    { name: 'YACHT',     overtimeMsg: 'the sea is getting rough!' },
    convoy:   { name: 'CONVOY',    overtimeMsg: 'the drivers are getting reckless!' },
    foundry:  { name: 'FOUNDRY',   overtimeMsg: 'the lava is furious!' },
    rooftop:  { name: 'ROOFTOPS',  overtimeMsg: 'the storm is howling!' },
    temple:   { name: 'TEMPLE',    overtimeMsg: 'the sky itself attacks!' },
    terminal: { name: 'TERMINAL',  overtimeMsg: 'the cranes are swinging!' },
  };

  /* ====================== shared helpers ====================== */
  /* checker palette -> real tileable texture (+tint), keyed by colorA.
     White tint = texture as authored; others multiply for palette variety. */
  const PAL_TEX = {
    '#dde4ef': ['concrete', '#ffffff'],   // pearl
    '#c9f0dd': ['tiles', '#bfeed9'],      // mint
    '#f6d4e3': ['tiles', '#f6d4e3'],      // rose
    '#f5e9c4': ['sand', '#ffffff'],       // sand
    '#cfdef6': ['concrete', '#dae4f6'],   // sky (pale blue panels)
    '#ffe3a9': ['sand', '#ffd9a0'],       // amber
    '#b6c2d6': ['metal', '#ffffff'],      // wall
    '#4a4149': ['stone', '#ffffff'],      // stone
    '#3a3238': ['stone', '#b8b0bc'],      // coal (darker)
    '#3f4552': ['metal', '#7a8494'],      // roof (dark metal)
    '#262b38': ['stone', '#8a90a5'],      // slate
    '#8a7a68': ['dirt', '#c8bcac'],       // dune
    '#6a5d50': ['dirt', '#b8a290'],       // clay
    '#f2f4f6': ['panel', '#ffffff'],      // hull
    '#d8c49e': ['planks', '#ffffff'],     // teak
    '#3a4250': ['grid', '#ffffff'],       // navy (glow grid)
    '#c8ccd4': ['concrete', '#e8ecf2'],   // concrete
    '#e8c85a': ['hazard', '#ffffff'],     // hazard
  };
  const _matCache = {};   // shared materials — fewer GL programs/binds
  // NOTE: block geometry carries WORLD-LOCKED UVs (1 tile ≈ 3 units), so
  // materials use repeat 1 and never stretch when a block is resized
  function mat(colorHex, repeat) {
    const px = PAL_TEX[colorHex[0]];
    if (px && SKY.GFX && SKY.GFX.texImage(px[0])) {
      const key = 't' + colorHex[0];
      if (_matCache[key]) return _matCache[key];
      const m = new THREE.MeshLambertMaterial({ color: px[1] });
      m.map = SKY.GFX.texture(px[0], 1);
      _matCache[key] = m;
      return m;
    }
    const key = 'c' + colorHex[0] + colorHex[1];
    if (_matCache[key]) return _matCache[key];
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
    m.map = SKY.U.checkerTexture(colorHex[0], colorHex[1], 1);
    _matCache[key] = m;
    return m;
  }
  function flat(color) {
    const key = 'f' + color;
    if (!_matCache[key]) _matCache[key] = new THREE.MeshLambertMaterial({ color });
    return _matCache[key];
  }

  function plat(x, y, z, sx, sy, sz, opts) {
    opts = opts || {};
    const m = new THREE.Mesh(
      SKY.U.blockGeometry(opts.shape || 'box', sx, sy, sz),
      opts.material || mat(opts.pal, Math.max(2, Math.round(Math.max(sx, sz) / 3)))
    );
    m.position.set(x, y, z);
    m.rotation.set(opts.rotX || 0, opts.rotY || 0, opts.rotZ || 0);
    m.castShadow = true; m.receiveShadow = true;
    if (!opts.path && !opts.move) {
      // static geometry: freeze the matrix so three.js skips it every frame
      // (crumbling platforms re-enable this when they start moving)
      m.updateMatrix();
      m.matrixAutoUpdate = false;
    }
    group.add(m);
    const solid = SKY.World.addSolid({
      x, y, z, sx, sy, sz,
      rotX: opts.rotX || 0, rotY: opts.rotY || 0, rotZ: opts.rotZ || 0,
      mesh: m, path: opts.path, move: opts.move, tag: opts.tag || '',
    });
    if (opts.crumble) crumbleList.push({ solid, mesh: m });
    if (opts.ride) SKY.World.rideSolids.push(solid);
    return solid;
  }

  function jumpPad(x, y, z, launch, color) {
    const c = color || 0x49e07f;
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(1.3, 1.5, 0.22, 20),
      new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.5 })
    );
    m.position.set(x, y + 0.11, z);
    group.add(m);
    SKY.World.addPad(x, y + 0.25, z, 1.5, launch);
    decor.push({ mesh: m, pulse: Math.random() * 6 });
  }

  /* decorative props from the asset pack (https builds only). Placed flush
     against existing cover so lanes stay identical; solid=true adds a
     matching collision box. Silently skipped when the pack isn't loaded. */
  function propAt(name, x, y, z, rotY, scale, solid) {
    if (!SKY.GFX) return;
    const obj = SKY.GFX.prop(name);
    if (!obj) return;
    obj.rotation.y = rotY || 0;
    obj.scale.setScalar(scale || 1);
    obj.position.set(x, y, z);
    group.add(obj);
    if (solid) {
      obj.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(obj);
      const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
      if (isFinite(s.x) && s.x > 0.1) {
        SKY.World.addSolid({ x: c.x, y: c.y, z: c.z, sx: s.x, sy: s.y, sz: s.z });
      }
    }
  }

  function anchor(x, y, z) { SKY.World.recoveryAnchors.push(new THREE.Vector3(x, y, z)); }
  function roam(x, y, z) { SKY.World.roamPoints.push(new THREE.Vector3(x, y, z)); }
  function spawnPt(x, y, z) {
    SKY.World.spawnPoints.push({ pos: new THREE.Vector3(x, y, z), yaw: Math.atan2(x, z) });
  }

  /* mood lighting: warm low key + cool fill + dim ambience = long shadows */
  function mood(o) {
    const hemi = new THREE.HemisphereLight(o.hemiSky, o.hemiGround, o.hemiInt);
    group.add(hemi);
    const sun = new THREE.DirectionalLight(o.sunColor, o.sunInt);
    sun.position.copy(o.sunPos);
    const shQ = SKY.Settings ? SKY.Settings.data.shadows : 'high';
    sun.castShadow = shQ !== 'off';
    sun.shadow.mapSize.set(shQ === 'low' ? 1024 : 2048, shQ === 'low' ? 1024 : 2048);
    sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
    sun.shadow.camera.far = 220;
    sun.shadow.bias = -0.0004;
    group.add(sun);
    if (o.fillColor) {
      const fill = new THREE.DirectionalLight(o.fillColor, o.fillInt || 0.3);
      fill.position.copy(o.fillPos || new THREE.Vector3(-40, 30, -35));
      group.add(fill);
    }
    if (o.shafts) lightShafts(o.sunPos, o.sunColor);
    celestial(o);
    return { hemi, sun };
  }

  /* the visible sun / moon along the key-light direction */
  function celestial(o) {
    if (!o.disc) return;
    const pos = o.sunPos.clone().normalize().multiplyScalar(330);
    const size = o.discSize || 60;
    if (o.disc === 'sun') {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: o.discColor || '#fff2d0', transparent: true,
        opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      glow.position.copy(pos);
      glow.scale.set(size * 2.8, size * 2.8, 1);
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: '#ffffff', transparent: true,
        opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      core.position.copy(pos);
      core.scale.set(size, size, 1);
      // huge sprites at the far plane pop out of the frustum test while
      // their glow should still be on screen — never cull them
      glow.frustumCulled = core.frustumCulled = false;
      skyGroup.add(glow, core);
    } else {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: o.discColor || '#e8f0ff', transparent: true,
        opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      halo.position.copy(pos);
      halo.scale.set(size * 2.4, size * 2.4, 1);
      const moon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.moonTexture(), color: o.discColor || '#e8f0ff', transparent: true,
        depthWrite: false, fog: false,
      }));
      moon.position.copy(pos);
      moon.scale.set(size, size, 1);
      halo.frustumCulled = moon.frustumCulled = false;
      skyGroup.add(halo, moon);
    }
  }

  /* cinematic light shafts angled from the sun — cheap additive planes,
     toggleable in ⚙ settings ("Light shafts") */
  function lightShafts(sunPos, color) {
    if (SKY.Settings && SKY.Settings.data.shafts === false) return;
    const dir = sunPos.clone().normalize();
    for (let i = 0; i < 4; i++) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(SKY.U.rand(8, 16), SKY.U.rand(45, 70)),
        new THREE.MeshBasicMaterial({
          map: SKY.U.shaftTexture(), color, transparent: true,
          opacity: SKY.U.rand(0.045, 0.09), blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide, fog: false,
        }));
      plane.position.set(SKY.U.rand(-22, 22), SKY.U.rand(14, 22), SKY.U.rand(-22, 22));
      plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      plane.rotateY(SKY.U.rand(0, Math.PI));
      group.add(plane);
    }
  }

  /* gradient sky dome (+ optional stars). `fogged` = the map has a fog
     override: let scene fog eat the dome too, otherwise a crisp backdrop
     makes even max-density fog read as "barely any fog" */
  function skyDome(top, mid, horizon, stars, fogged) {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 256;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, top); gr.addColorStop(0.55, mid); gr.addColorStop(1, horizon);
    g.fillStyle = gr; g.fillRect(0, 0, 32, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    // depthWrite OFF: the dome is the farthest backdrop, but its depth at
    // R=380 (centered on the ORIGIN) can dip below the sun sprite's fixed
    // quad depth near the screen edges — writing it cut slices off the sun
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(380, 24, 14),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: !!fogged, depthWrite: false })
    );
    skyGroup.add(dome);
    if (stars) {
      // crisp glowing points, varied size/warmth — no more stretched blobs
      const paint = (n, big) => {
        const sc = document.createElement('canvas');
        sc.width = 2048; sc.height = 1024;
        const sg = sc.getContext('2d');
        for (let i = 0; i < n; i++) {
          const x = Math.random() * 2048;
          const y = Math.random() * 560;         // upper sky band only
          const r = big ? SKY.U.rand(1.6, 3.2) : SKY.U.rand(0.6, 1.6);
          const a = big ? SKY.U.rand(0.7, 1) : SKY.U.rand(0.35, 0.9);
          const warm = Math.random();
          const col = warm < 0.15 ? '190,215,255' : warm < 0.3 ? '255,230,200' : '255,255,255';
          const grad = sg.createRadialGradient(x, y, 0, x, y, r * 3);
          grad.addColorStop(0, `rgba(${col},${a})`);
          grad.addColorStop(0.35, `rgba(${col},${a * 0.5})`);
          grad.addColorStop(1, `rgba(${col},0)`);
          sg.fillStyle = grad;
          sg.beginPath(); sg.arc(x, y, r * 3, 0, Math.PI * 2); sg.fill();
          sg.fillStyle = `rgba(255,255,255,${Math.min(1, a * 1.3)})`;
          sg.beginPath(); sg.arc(x, y, r * 0.55, 0, Math.PI * 2); sg.fill();
        }
        const st = new THREE.CanvasTexture(sc);
        st.encoding = THREE.sRGBEncoding;
        return st;
      };
      const base = new THREE.Mesh(
        new THREE.SphereGeometry(370, 32, 18),
        new THREE.MeshBasicMaterial({ map: paint(320, false), side: THREE.BackSide, transparent: true, fog: !!fogged, depthWrite: false }));
      const bright = new THREE.Mesh(
        new THREE.SphereGeometry(368, 32, 18),
        new THREE.MeshBasicMaterial({ map: paint(50, true), side: THREE.BackSide, transparent: true, fog: !!fogged, depthWrite: false }));
      base.frustumCulled = bright.frustumCulled = false;
      skyGroup.add(base, bright);
      starLayer = bright;      // twinkles + enables shooting stars in tick()
    }
  }

  function cloudField(y0, y1, color, opacity, count) {
    // puffy cumulus sprites (3 painted variants), not the old fuzzy blobs
    const n = count === undefined ? 10 : count;
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.cloudTexture(i), color: color || 0xffffff, transparent: true,
        opacity: (opacity || 0.4) * SKY.U.rand(0.85, 1.15), depthWrite: false,
      }));
      const r = SKY.U.rand(45, 95), a = Math.random() * Math.PI * 2;
      s.position.set(Math.cos(a) * r, SKY.U.rand(y0, y1), Math.sin(a) * r);
      const sc = SKY.U.rand(16, 34);
      s.scale.set(sc, sc * 0.5, 1);
      group.add(s);
      clouds.push({ mesh: s, speed: SKY.U.rand(0.2, 0.7), a, r });
    }
  }

  /* glowing target decal used by event telegraphs */
  function warnDecal(pos, dur, color) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SKY.U.ringTexture(), color, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    s.position.set(pos.x, pos.y + 0.15, pos.z);
    group.add(s);
    const state = { t: 0 };
    tickers.push((dt) => {
      if (state.t < 0) return;
      state.t += dt;
      const k = 1 + Math.sin(state.t * 14) * 0.25;
      s.scale.set(3.5 * k, 3.5 * k, 1);
      if (state.t > dur) { group.remove(s); state.t = -1; }
    });
  }

  function knockArea(pos, radius, force, upVel) {
    for (const p of SKY.Game.pawns) {
      if (!p.alive) continue;
      const dx = p.pos.x - pos.x, dz = p.pos.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > radius || Math.abs(p.pos.y - pos.y) > 4) continue;
      const k = 1 - (d / radius) * 0.5;
      const imp = new THREE.Vector3(
        (d > 0.01 ? dx / d : 1) * force * k, upVel * k, (d > 0.01 ? dz / d : 0) * force * k);
      p.applyKnockback(imp, null);
      p.grounded = false;
    }
  }

  /* ============================================================
   * MAP 1: SKY ARENA (golden hour)
   * ============================================================ */
  function buildSky() {
    SKY.World.killY = -22;
    SKY.World.crownHome = new THREE.Vector3(0, 0.6, 0);
    mood({
      sunColor: 0xffd9a0, sunInt: 1.45, sunPos: new THREE.Vector3(38, 32, 22),
      hemiSky: 0xbfd4f5, hemiGround: 0x5a6070, hemiInt: 0.45,
      fillColor: 0x8aa4e8, fillInt: 0.3,
      shafts: true, disc: 'sun', discSize: 80, discColor: '#ffc97a',
    });
    skyDome('#2f5da8', '#7ba4d8', '#ffd9a4');
    scene.fog = new THREE.Fog(0xa8bede, 90, 280);
    cloudField(-14, 16, 0xfff0dd, 0.45);

    const P = { center: ['#dde4ef', '#a3b2ca'], north: ['#c9f0dd', '#84c5a5'],
                south: ['#f6d4e3', '#d29ab8'], east: ['#f5e9c4', '#d3ba7d'],
                west: ['#cfdef6', '#93aed6'], mover: ['#ffe3a9', '#e8a83e'],
                wall: ['#b6c2d6', '#8593ad'] };

    plat(0, -1, 0, 30, 2, 30, { pal: P.center });
    plat(-5, 0.55, 5, 4.5, 1.1, 0.5, { pal: P.wall, crumble: true });
    plat(5, 0.55, -5, 4.5, 1.1, 0.5, { pal: P.wall, crumble: true });
    plat(6, 0.55, 6, 0.5, 1.1, 4.5, { pal: P.wall, crumble: true });
    plat(-6, 0.55, -6, 0.5, 1.1, 4.5, { pal: P.wall, crumble: true });
    jumpPad(11, 0, -11, new THREE.Vector3(0, 16, 0));
    jumpPad(-11, 0, 11, new THREE.Vector3(0, 16, 0));
    plat(0, 1.67, -20, 7, 0.8, 13.2, { pal: P.north, rotX: 0.332 });
    plat(0, 3.4, -32, 12, 1.6, 12, { pal: P.north, crumble: true });
    jumpPad(0, 4.2, -35, new THREE.Vector3(0, 17, 6));
    plat(0, -0.3, 20, 2.2, 0.6, 10.4, { pal: P.south, crumble: true });
    plat(0, 0.6, 30, 14, 1.2, 10, { pal: P.south, crumble: true });
    plat(9.5, 0.6, 24, 7, 0.6, 5, { pal: P.south, rotZ: -0.30, crumble: true });
    plat(-9.5, 0.6, 24, 7, 0.6, 5, { pal: P.south, rotZ: 0.30, crumble: true });
    jumpPad(0, 1.2, 33, new THREE.Vector3(0, 15, -5));
    plat(19, -0.5, 4, 5, 1, 5, { pal: P.east, crumble: true });
    plat(25, -0.2, -2, 4.5, 1, 4.5, { pal: P.east, crumble: true });
    plat(30.5, 0.1, 4, 4, 1, 4, { pal: P.east, crumble: true });
    plat(36, -0.1, -2, 9, 1.2, 9, { pal: P.east, crumble: true });
    plat(-30, 1.2, 0, 11, 1.6, 11, { pal: P.west, crumble: true });
    plat(-18, -0.4, 0, 4, 0.8, 4, {
      pal: P.mover, tag: 'mover',
      path: (t) => {
        const s = (Math.sin(t * Math.PI * 2 / 5.5) + 1) / 2;
        return new THREE.Vector3(SKY.U.lerp(-18, -22.8, s), SKY.U.lerp(-0.4, 1.5, s), 0);
      },
    });
    plat(23, 2.65, 0, 3.4, 0.7, 3.4, {
      pal: P.mover, tag: 'mover',
      path: (t) => {
        const a = t * Math.PI * 2 / 16;
        return new THREE.Vector3(Math.cos(a) * 23, 2.65, Math.sin(a) * 23);
      },
    });
    plat(-14, -2, -14, 4, 1, 4, { pal: P.center, crumble: true });
    jumpPad(-14, -1.5, -14, new THREE.Vector3(4, 15, 4));
    plat(14, -2.5, 14, 4, 1, 4, { pal: P.center, crumble: true });
    jumpPad(14, -2, 14, new THREE.Vector3(-4, 15, -4));

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      spawnPt(Math.cos(a) * 10, 0.05, Math.sin(a) * 10);
    }
    [[0, 0, 0], [8, 0, 8], [-8, 0, -8], [8, 0, -8], [-8, 0, 8], [12, 0, 0], [-12, 0, 0],
     [0, 4.2, -32], [0, 1.2, 30], [0, 0, 20], [19, 0, 4], [36, 0.5, -2], [-30, 2, 0],
    ].forEach(p => roam(p[0], p[1], p[2]));
    [[14, -0.3, 0], [-14, -0.3, 0], [0, -0.3, 14], [0, -0.3, -14],
     [0, 3.9, -26.5], [0, 0.9, 30], [36, 0.2, -2], [-30, 1.7, 0],
    ].forEach(p => anchor(p[0], p[1], p[2]));

    eventCfg = null;   // sky's "event" is the overtime crumble
  }

  /* ============================================================
   * MAP 2: CONVOY — three semis at dusk, driving forever.
   * The trucks are (nearly) fixed in world space; the road and
   * scenery stream past to sell endless speed.
   * ============================================================ */
  function buildConvoy() {
    SKY.World.killY = 0.25;                 // the asphalt is death at 90 km/h
    SKY.World.crownHome = new THREE.Vector3(5, 3.2, 0);   // above the middle truck
    // warm late-afternoon: bright, readable, long golden shadows
    mood({
      sunColor: 0xffd9a0, sunInt: 1.5, sunPos: new THREE.Vector3(-45, 40, 30),
      hemiSky: 0xbcd0ec, hemiGround: 0x6a625e, hemiInt: 0.6,
      fillColor: 0x8aa4e8, fillInt: 0.3,
      shafts: true, disc: 'sun', discSize: 65, discColor: '#ffd9a0',
    });
    skyDome('#2f5da8', '#84aede', '#ffcf95');
    scene.fog = new THREE.Fog(0xb0bcd4, 70, 260);

    // road: scrolling texture
    const rc = document.createElement('canvas');
    rc.width = 256; rc.height = 128;
    const rg = rc.getContext('2d');
    rg.fillStyle = '#23262e'; rg.fillRect(0, 0, 256, 128);
    rg.strokeStyle = '#c8b060'; rg.lineWidth = 5; rg.setLineDash([26, 22]);
    for (const y of [34, 64, 94]) { rg.beginPath(); rg.moveTo(0, y); rg.lineTo(256, y); rg.stroke(); }
    const roadTex = new THREE.CanvasTexture(rc);
    roadTex.encoding = THREE.sRGBEncoding;
    roadTex.wrapS = roadTex.wrapT = THREE.RepeatWrapping;
    roadTex.repeat.set(10, 1);
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 24),
      new THREE.MeshLambertMaterial({ map: roadTex })
    );
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    group.add(road);
    // dirt shoulders
    for (const z of [-16.5, 16.5]) {
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(240, 9), flat(0x3a2e2c));
      sh.rotation.x = -Math.PI / 2;
      sh.position.set(0, -0.02, z);
      group.add(sh);
    }
    tickers.push((dt) => { roadTex.offset.x += dt * 26 / 24; });   // endless motion

    // scrolling scenery: poles, rocks, distant dunes
    const sceneryItems = [];
    for (let i = 0; i < 8; i++) {
      const pole = new THREE.Group();
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 7, 0.3), flat(0x2a2f3d));
      post.position.y = 3.5;
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.2, 0.3),
        new THREE.MeshLambertMaterial({ color: 0xffc070, emissive: 0xff9040, emissiveIntensity: 0.8 }));
      lamp.position.set(-0.7, 6.9, 0);
      pole.add(post, lamp);
      pole.position.set(-90 + i * 24, 0, i % 2 === 0 ? 13.5 : -13.5);
      group.add(pole);
      sceneryItems.push(pole);
    }
    for (let i = 0; i < 12; i++) {
      const rock = new THREE.Mesh(
        new THREE.BoxGeometry(SKY.U.rand(1, 4), SKY.U.rand(0.6, 2.4), SKY.U.rand(1, 3)), flat(0x4a3a40));
      rock.position.set(SKY.U.rand(-90, 90), 0.3, (Math.random() < 0.5 ? 1 : -1) * SKY.U.rand(15, 26));
      group.add(rock);
      sceneryItems.push(rock);
    }
    tickers.push((dt) => {
      for (const o of sceneryItems) {
        o.position.x -= 26 * dt;
        if (o.position.x < -110) o.position.x += 220;
      }
    });

    // ---------- the trucks ----------
    const trucks = [];
    const TRUCK_DEFS = [
      { lane: -5.2, baseX: -6, color: 0xc4574f },
      { lane: 0,    baseX: 5,  color: 0x4f86c4 },
      { lane: 5.2,  baseX: -2, color: 0x58a86a },
    ];
    TRUCK_DEFS.forEach((td, i) => {
      const truck = { i, offset: 0, offsetVel: 0, phase: 'riding', t: SKY.U.rand(0, 5), shake: 0, swayT: Math.random() * 9 };
      const mkMove = (dx, dz, baseY, driver) => (dt, s) => {
        if (driver) truck.swayT += dt;
        const sway = Math.sin(truck.swayT * 0.9 + i * 2.1) * 0.11 +
                     (truck.shake > 0 ? SKY.U.rand(-0.12, 0.12) : 0);
        s.c.x = td.baseX + dx + truck.offset;
        s.c.z = td.lane + dz + sway;
        s.c.y = baseY + Math.sin(truck.swayT * 2.3 + i) * 0.05;
      };
      // trailer bed (the arena)
      plat(td.baseX, 1.7, td.lane, 11, 0.6, 4.2, {
        material: flat(0x8a94a8), ride: true, tag: 'ride', move: mkMove(0, 0, 1.7, true),
      });
      // cab
      plat(td.baseX + 6.7, 1.9, td.lane, 2.6, 2.6, 3.2, {
        material: flat(td.color), ride: true, tag: 'ride', move: mkMove(6.7, 0, 1.9),
      });
      // container for cover on each bed
      plat(td.baseX - 2.5, 2.8, td.lane, 2.6, 1.6, 2.4, {
        material: flat((td.color & 0xfefefe) >> 1 | 0x202020), ride: true, tag: 'ride', move: mkMove(-2.5, 0, 2.8),
      });
      // wheels (visual)
      for (const wx of [-3.6, -0.5, 2.6, 5.4]) {
        for (const wz of [-1.3, 1.3]) {
          const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 10), flat(0x14171f));
          w.rotation.x = Math.PI / 2;
          group.add(w);
          decor.push({ mesh: w, wheel: { truck, td, wx, wz } });
        }
      }
      trucks.push(truck);
      // one spawn on the bed, one on the cab roof — keeps spawns out of
      // each other's Air Cannon range
      spawnPt(td.baseX + 2.5, 2.1, td.lane);
      spawnPt(td.baseX + 6.7, 3.4, td.lane);
      roam(td.baseX + 2, 2, td.lane); roam(td.baseX - 4.5, 3.7, td.lane);
      anchor(td.baseX + 6.7, 3.3, td.lane); anchor(td.baseX - 2.5, 3.7, td.lane);
    });
    // wheels follow + spin
    tickers.push((dt) => {
      for (const d of decor) {
        if (!d.wheel) continue;
        const w = d.wheel;
        d.mesh.position.set(w.td.baseX + w.wx + w.truck.offset, 0.55, w.td.lane + w.wz);
        d.mesh.rotation.z -= dt * 12;
      }
    });

    // wind streaks (speed feel)
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: 0xcfd8ff, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      s.scale.set(SKY.U.rand(3, 7), 0.12, 1);
      s.position.set(SKY.U.rand(-40, 40), SKY.U.rand(1.5, 6), SKY.U.rand(-14, 14));
      group.add(s);
      decor.push({ mesh: s, streak: SKY.U.rand(30, 46) });
    }
    tickers.push((dt) => {
      for (const d of decor) {
        if (!d.streak) continue;
        d.mesh.position.x -= d.streak * dt;
        if (d.mesh.position.x < -50) d.mesh.position.x += 100;
      }
    });

    // ---------- EVENT: BREAKDOWN ----------
    tickers.push((dt) => {
      for (const tr of trucks) {
        tr.shake = Math.max(0, tr.shake - dt);
        switch (tr.phase) {
          case 'warn':
            tr.t -= dt; tr.shake = 0.2;
            if (tr.t <= 0) { tr.phase = 'brake'; tr.t = 0; }
            break;
          case 'brake':
            tr.offsetVel = Math.max(tr.offsetVel - 14 * dt, -26);
            tr.offset += tr.offsetVel * dt;
            if (tr.offset < -70) { tr.phase = 'gone'; tr.t = 4; tr.offsetVel = 0; }
            break;
          case 'gone':
            tr.t -= dt;
            if (tr.t <= 0) { tr.phase = 'catchup'; }
            break;
          case 'catchup':
            tr.offsetVel = Math.min(tr.offsetVel + 10 * dt, 18);
            tr.offset += tr.offsetVel * dt;
            if (tr.offset >= 0) { tr.offset = 0; tr.offsetVel = 0; tr.phase = 'riding'; }
            break;
        }
      }
    });
    eventCfg = {
      min: 14, max: 22,
      pick() {
        const candidates = trucks.filter(t => t.phase === 'riding');
        if (!candidates.length) return null;
        return { truck: SKY.U.pick(candidates).i };
      },
      exec(p) {
        const tr = trucks[p.truck];
        if (!tr || tr.phase !== 'riding') return;
        tr.phase = 'warn'; tr.t = 2.2;
        SKY.HUD.subMsg('Truck ' + (tr.i + 1) + ' breaking down — jump!', 3);
        SKY.SFX.honk();
      },
    };
  }

  /* ============================================================
   * MAP 3: FOUNDRY — dark cavern over a lava lake.
   * ============================================================ */
  function buildFoundry() {
    SKY.World.killY = -9.5;
    SKY.World.crownHome = new THREE.Vector3(0, 0.6, 0);
    // amber forge: moody but bright enough to read every platform
    mood({
      sunColor: 0xffd0a0, sunInt: 1.25, sunPos: new THREE.Vector3(28, 55, 12),
      hemiSky: 0xb09076, hemiGround: 0x453228, hemiInt: 0.8,
      fillColor: 0xff8a4a, fillInt: 0.3, fillPos: new THREE.Vector3(-30, -10, 20),
    });
    skyDome('#241820', '#4a2a20', '#8a4522');
    scene.fog = new THREE.Fog(0x54301f, 50, 200);

    // lava lake (emissive) + underlight
    const lc = document.createElement('canvas');
    lc.width = lc.height = 256;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#ff5a1a'; lg.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 70; i++) {
      lg.fillStyle = Math.random() < 0.5 ? '#ffb03a' : '#c42a08';
      lg.beginPath();
      lg.arc(Math.random() * 256, Math.random() * 256, SKY.U.rand(6, 30), 0, Math.PI * 2);
      lg.fill();
    }
    const lavaTex = new THREE.CanvasTexture(lc);
    lavaTex.encoding = THREE.sRGBEncoding;
    lavaTex.wrapS = lavaTex.wrapT = THREE.RepeatWrapping;
    lavaTex.repeat.set(6, 6);
    const lava = new THREE.Mesh(new THREE.PlaneGeometry(320, 320),
      new THREE.MeshBasicMaterial({ map: lavaTex }));
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = -10;
    group.add(lava);
    tickers.push((dt) => { lavaTex.offset.x += dt * 0.015; lavaTex.offset.y += dt * 0.008; });
    const glow1 = new THREE.PointLight(0xff6a2a, 2.0, 80, 1.5);
    glow1.position.set(0, -5, 0);
    group.add(glow1);
    const glow2 = new THREE.PointLight(0xff8a3a, 1.3, 60, 1.5);
    glow2.position.set(-20, -4, 15);
    group.add(glow2);
    tickers.push((dt, time) => { glow1.intensity = 1.5 + Math.sin(time * 2.7) * 0.25; });

    const STONE = ['#4a4149', '#2e282f'];
    const DARK = ['#3a3238', '#241f26'];
    plat(0, -1, 0, 20, 2, 20, { pal: STONE });
    plat(3, 0.55, 3, 5, 1.1, 0.6, { pal: DARK });
    plat(-4, 0.55, -3, 0.6, 1.1, 5, { pal: DARK });
    // ring platforms
    const ring = [[20, 0.5, 4, 9], [12, -0.5, -17, 8], [-16, 1.5, -13, 7],
                  [-21, -0.5, 6, 8], [-4, 2.5, 19, 7], [16, 2, 16, 6]];
    ring.forEach(([x, y, z, s]) => {
      plat(x, y - 1, z, s, 2, s, { pal: STONE });
      roam(x, y, z);
      anchor(x, y - 0.3, z);
    });
    // beams between islands (narrow, scary)
    plat(15, -0.6, -8, 1.6, 0.5, 12, { pal: DARK });
    plat(-10, 0.4, 12.5, 12, 0.5, 1.6, { pal: DARK, rotY: 0.35 });
    plat(-18.5, 0.4, -4, 1.6, 0.5, 12, { pal: DARK });
    // elevators
    plat(8, 1, 9, 3.5, 0.6, 3.5, {
      material: flat(0x6a4a35), tag: 'mover',
      path: (t) => new THREE.Vector3(8, 1 + (Math.sin(t * Math.PI * 2 / 7) + 1) * 1.8, 9),
    });
    plat(-9, 1, -9, 3.5, 0.6, 3.5, {
      material: flat(0x6a4a35), tag: 'mover',
      path: (t) => new THREE.Vector3(-9, 1 + (Math.sin(t * Math.PI * 2 / 7 + Math.PI) + 1) * 1.8, -9),
    });
    jumpPad(0, 0, -8, new THREE.Vector3(0, 15, -4), 0xff7a3a);
    jumpPad(-6, 0, 6, new THREE.Vector3(6, 15, 0), 0xff7a3a);
    // rock pillars from the lava (visual)
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2, r = SKY.U.rand(30, 55);
      const pil = new THREE.Mesh(
        new THREE.BoxGeometry(SKY.U.rand(2, 5), SKY.U.rand(8, 18), SKY.U.rand(2, 5)), flat(0x241c22));
      pil.position.set(Math.cos(a) * r, -6, Math.sin(a) * r);
      group.add(pil);
    }
    // rising embers
    for (let i = 0; i < 16; i++) {
      const e = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: 0xff9a4a, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      e.scale.set(0.25, 0.25, 1);
      e.position.set(SKY.U.rand(-25, 25), SKY.U.rand(-9, 4), SKY.U.rand(-25, 25));
      group.add(e);
      decor.push({ mesh: e, ember: SKY.U.rand(0.8, 2) });
    }
    tickers.push((dt) => {
      for (const d of decor) {
        if (!d.ember) continue;
        d.mesh.position.y += d.ember * dt;
        if (d.mesh.position.y > 6) d.mesh.position.y = -9;
      }
    });

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      spawnPt(Math.cos(a) * 7, 0.05, Math.sin(a) * 7);
    }
    [[0, 0, 0], [6, 0, -6], [-6, 0, 6]].forEach(p => roam(p[0], p[1], p[2]));
    [[10, -0.3, 0], [-10, -0.3, 0], [0, -0.3, 10], [0, -0.3, -10]].forEach(p => anchor(p[0], p[1], p[2]));

    // ---------- EVENT: ERUPTION ----------
    const eruptions = [];
    tickers.push((dt) => {
      for (let i = eruptions.length - 1; i >= 0; i--) {
        const e = eruptions[i];
        e.t -= dt;
        if (e.t <= 0) {
          knockArea(e.pos, 3.5, 8, 17);
          for (let j = 0; j < 3; j++) {
            SKY.Effects.burst(new THREE.Vector3(e.pos.x, e.pos.y + j * 1.2, e.pos.z),
              { count: 12, speed: 6, color: '#ff8a3a', gravity: -4, life: 0.7, size: 0.7 });
          }
          SKY.Effects.ring(e.pos.clone(), '#ff8a3a', 5, 0.5);
          SKY.SFX.rumble();
          eruptions.splice(i, 1);
        }
      }
    });
    eventCfg = {
      min: 11, max: 18,
      pick() {
        const spots = [];
        for (let n = 0; n < 2; n++) {
          const rp = SKY.U.pick(SKY.World.roamPoints);
          spots.push([rp.x + SKY.U.rand(-2, 2), rp.y, rp.z + SKY.U.rand(-2, 2)]);
        }
        return { spots };
      },
      exec(p) {
        SKY.HUD.subMsg('Eruption incoming', 2.5);
        for (const s of p.spots) {
          const pos = new THREE.Vector3(s[0], s[1], s[2]);
          warnDecal(pos, 1.6, 0xff6a2a);
          eruptions.push({ pos, t: 1.6 });
        }
      },
    };
  }

  /* ============================================================
   * MAP 4: ROOFTOPS — neon night, wind gusts.
   * ============================================================ */
  function buildRooftop() {
    SKY.World.killY = -14;
    SKY.World.crownHome = new THREE.Vector3(0, 0.6, 0);
    // blue hour: a bright moon, cool sky bounce — evening, not midnight
    mood({
      sunColor: 0xe4eeff, sunInt: 1.4, sunPos: new THREE.Vector3(30, 55, -25),
      hemiSky: 0x7e96d4, hemiGround: 0x39404f, hemiInt: 0.85,
      fillColor: 0xff9ac8, fillInt: 0.22, fillPos: new THREE.Vector3(-30, 20, 30),
      disc: 'moon', discSize: 46, discColor: '#e8f0ff',
    });
    skyDome('#101c3c', '#283c74', '#5a70ac', true);
    scene.fog = new THREE.Fog(0x35446e, 60, 220);
    const neonPink = new THREE.PointLight(0xff4f9a, 1.4, 32, 1.7);
    neonPink.position.set(6, 5, -6);
    group.add(neonPink);
    const neonCyan = new THREE.PointLight(0x35c7ff, 1.1, 28, 1.7);
    neonCyan.position.set(-16, 4, 10);
    group.add(neonCyan);

    const ROOF = ['#3f4552', '#2b3040'];
    const DARK = ['#262b38', '#191d28'];
    // main roof + furniture
    plat(0, -1, 0, 18, 2, 14, { pal: ROOF });
    plat(4, 0.75, -4, 2.4, 1.5, 2.4, { pal: DARK });          // AC unit
    plat(-5, 0.75, 3, 2.4, 1.5, 2.4, { pal: DARK });
    plat(0, 0.5, 6.6, 17.5, 1, 0.5, { pal: DARK });           // parapet
    // billboard (neon sign, climbable backboard)
    plat(7.5, 2.4, -6.5, 4.6, 3, 0.5, { material: flat(0x1a1f2c) });
    const bb = document.createElement('canvas');
    bb.width = 256; bb.height = 128;
    const bg = bb.getContext('2d');
    bg.fillStyle = '#0c0f18'; bg.fillRect(0, 0, 256, 128);
    bg.font = '900 52px Arial'; bg.textAlign = 'center';
    bg.fillStyle = '#ff4f9a'; bg.fillText('SKY', 128, 52);
    bg.fillStyle = '#35c7ff'; bg.fillText('PUSH', 128, 108);
    const bbTex = new THREE.CanvasTexture(bb);
    bbTex.encoding = THREE.sRGBEncoding;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.8),
      new THREE.MeshBasicMaterial({ map: bbTex }));
    sign.position.set(7.5, 2.4, -6.2);
    group.add(sign);

    // satellite roofs
    plat(20, 0, -6, 12, 2, 10, { pal: ROOF });                // top y=1
    plat(21, 1.9, -8, 2, 1.8, 2, { pal: DARK });
    plat(-19, -2, 4, 13, 2, 11, { pal: ROOF });               // top y=-1
    plat(-21, -0.4, 7, 2.6, 1.2, 2.6, { pal: DARK });
    plat(3, -1.5, -18, 10, 2, 9, { pal: ROOF });              // top y=-0.5
    plat(-6, 0.5, 16, 9, 2, 8, { pal: ROOF });                // top y=1.5
    // plank bridges
    plat(11.5, 0.2, -4, 6, 0.25, 0.9, { material: flat(0x6a5138) });
    plat(-12.2, -0.7, 2, 7, 0.25, 0.9, { material: flat(0x6a5138) });
    plat(0, -0.4, -11, 0.9, 0.25, 6, { material: flat(0x6a5138) });
    plat(-3, 0.4, 10.5, 0.9, 0.25, 5, { material: flat(0x6a5138) });
    jumpPad(-2, 0, -3, new THREE.Vector3(0, 15, 0), 0x35c7ff);   // vent fans
    jumpPad(-19, -1, 1, new THREE.Vector3(5, 14, -3), 0x35c7ff);

    // city below (lit windows)
    const wc = document.createElement('canvas');
    wc.width = wc.height = 128;
    const wg = wc.getContext('2d');
    wg.fillStyle = '#12141c'; wg.fillRect(0, 0, 128, 128);
    for (let x = 8; x < 120; x += 18) {
      for (let y = 8; y < 120; y += 14) {
        wg.fillStyle = Math.random() < 0.4 ? '#ffca6a' : '#1c2030';
        wg.fillRect(x, y, 10, 7);
      }
    }
    const winTex = new THREE.CanvasTexture(wc);
    winTex.encoding = THREE.sRGBEncoding;
    for (let i = 0; i < 16; i++) {
      const h = SKY.U.rand(10, 26);
      const b = new THREE.Mesh(new THREE.BoxGeometry(SKY.U.rand(7, 13), h, SKY.U.rand(7, 13)),
        new THREE.MeshLambertMaterial({ map: winTex, color: 0xbcc4dd }));
      const a = Math.random() * Math.PI * 2, r = SKY.U.rand(34, 70);
      b.position.set(Math.cos(a) * r, -6 - h / 2, Math.sin(a) * r);
      group.add(b);
    }

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      spawnPt(Math.cos(a) * 6, 0.05, Math.sin(a) * 5);
    }
    [[0, 0, 0], [20, 1, -6], [-19, -1, 4], [3, -0.5, -18], [-6, 1.5, 16], [5, 0, 3]]
      .forEach(p => roam(p[0], p[1], p[2]));
    [[8, -0.3, 0], [-8, -0.3, 0], [20, 0.7, -6], [-19, -1.3, 4], [3, -0.8, -18], [-6, 1.2, 16]]
      .forEach(p => anchor(p[0], p[1], p[2]));

    // ---------- EVENT: WIND GUST ----------
    const gust = { active: 0, dir: new THREE.Vector3() };
    tickers.push((dt) => {
      if (gust.active <= 0) return;
      gust.active -= dt;
      for (const p of SKY.Game.pawns) {
        if (!p.alive) continue;
        p.vel.addScaledVector(gust.dir, 8 * dt);
      }
      if (Math.random() < dt * 30) {
        const s = new THREE.Vector3(SKY.U.rand(-15, 15), SKY.U.rand(0, 4), SKY.U.rand(-15, 15));
        SKY.Effects.trailPuff(s, '#9fb8d8');
      }
    });
    eventCfg = {
      min: 12, max: 19,
      pick() {
        const dirs = [['→ EAST', 1, 0], ['← WEST', -1, 0], ['↑ NORTH', 0, -1], ['↓ SOUTH', 0, 1]];
        const d = SKY.U.pick(dirs);
        return { label: d[0], dx: d[1], dz: d[2] };
      },
      exec(p) {
        gust.dir.set(p.dx, 0, p.dz);
        gust.active = 2.6;
        SKY.HUD.subMsg('Wind gust ' + p.label, 2.6);
        SKY.SFX.gust();
      },
    };
  }

  /* ============================================================
   * MAP 5: TEMPLE — storm-lit ruins, lightning strikes.
   * ============================================================ */
  function buildTemple() {
    SKY.World.killY = -20;
    SKY.World.crownHome = new THREE.Vector3(0, 2.1, 0);
    // bright warm daylight over the ruins (same family as Sky Arena)
    mood({
      sunColor: 0xffe0b0, sunInt: 1.5, sunPos: new THREE.Vector3(40, 55, -18),
      hemiSky: 0xbccdec, hemiGround: 0x6a6258, hemiInt: 0.6,
      fillColor: 0x9ab0e8, fillInt: 0.3,
      shafts: true, disc: 'sun', discSize: 50, discColor: '#fff4d8',
    });
    skyDome('#2f5da8', '#84aede', '#ffd9a8');
    scene.fog = new THREE.Fog(0xa8b4d0, 85, 280);
    cloudField(10, 22, 0xfff0dd, 0.45);
    // torches
    for (const [tx, tz] of [[6, 6], [-6, -6]]) {
      const tl = new THREE.PointLight(0xffa040, 1.0, 20, 1.8);
      tl.position.set(tx, 3, tz);
      group.add(tl);
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SKY.U.blobTexture(), color: 0xffb050, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      flame.position.set(tx, 3, tz);
      flame.scale.set(0.9, 1.4, 1);
      group.add(flame);
      decor.push({ mesh: flame, pulseSprite: Math.random() * 5 });
      plat(tx, 1.25, tz, 0.5, 2.5, 0.5, { material: flat(0x5f5346) });  // torch post
    }
    tickers.push((dt, time) => {
      for (const d of decor) {
        if (d.pulseSprite === undefined) continue;
        d.pulseSprite += dt * 7;
        d.mesh.scale.y = 1.4 + Math.sin(d.pulseSprite) * 0.25;
      }
    });

    const SAND = ['#8a7a68', '#5f5346'];
    const DARKST = ['#6a5d50', '#453b32'];
    plat(0, -1, 0, 24, 2, 24, { pal: SAND });                 // base, top 0
    plat(0, 0.75, 0, 14, 1.5, 14, { pal: DARKST });           // tier 2, top 1.5
    // columns + walkable roof slab
    for (const [cx, cz] of [[5.5, 5.5], [-5.5, 5.5], [5.5, -5.5], [-5.5, -5.5]]) {
      plat(cx, 3.75, cz, 1.3, 4.5, 1.3, { material: flat(0x7a6d5c) });
    }
    plat(0, 6.3, 0, 12, 1, 12, { pal: SAND });                // roof, top 6.8
    // stairs (ramps)
    plat(0, 0.4, 10.2, 6, 0.5, 5, { pal: DARKST, rotX: 0.29 });
    plat(-10.2, 0.4, 0, 5, 0.5, 6, { pal: DARKST, rotZ: -0.29 });
    // island ring
    const ring = [[22, 0.5, 0, 8], [15, 1.5, -17, 7], [-9, 2.5, -21, 7],
                  [-22, 0, -4, 8], [-15, 1, 15, 7], [8, 2, 20, 6]];
    ring.forEach(([x, y, z, s]) => {
      plat(x, y - 1, z, s, 2, s, { pal: SAND });
      roam(x, y, z);
      anchor(x, y - 0.3, z);
    });
    // stone bridges
    plat(15.5, -0.2, -8, 2, 0.5, 10, { pal: DARKST, rotY: 0.3 });
    plat(-16, 0.2, 6, 2, 0.5, 11, { pal: DARKST, rotY: -0.5 });
    jumpPad(9, 0, -9, new THREE.Vector3(-3, 16, 3), 0xc0a0ff);
    jumpPad(-9, 0, 9, new THREE.Vector3(3, 16, -3), 0xc0a0ff);
    // floating ruin chunks (visual)
    for (let i = 0; i < 7; i++) {
      const ch = new THREE.Mesh(
        new THREE.BoxGeometry(SKY.U.rand(1, 3), SKY.U.rand(1, 2), SKY.U.rand(1, 3)), flat(0x5a4f44));
      const a = Math.random() * Math.PI * 2;
      ch.position.set(Math.cos(a) * SKY.U.rand(28, 45), SKY.U.rand(-6, 8), Math.sin(a) * SKY.U.rand(28, 45));
      group.add(ch);
      decor.push({ mesh: ch, spin: new THREE.Vector3(SKY.U.rand(-0.2, 0.2), SKY.U.rand(-0.2, 0.2), 0) });
    }

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      spawnPt(Math.cos(a) * 9, 0.05, Math.sin(a) * 9);
    }
    [[0, 1.5, 0], [0, 6.8, 0], [8, 0, 8], [-8, 0, -8]].forEach(p => roam(p[0], p[1], p[2]));
    [[12, -0.3, 0], [-12, -0.3, 0], [0, -0.3, 12], [0, -0.3, -12], [0, 6.5, 0]]
      .forEach(p => anchor(p[0], p[1], p[2]));

    // ---------- EVENT: LIGHTNING ----------
    const strikes = [];
    const flash = new THREE.PointLight(0xe8f0ff, 0, 60, 1.4);
    group.add(flash);
    tickers.push((dt) => {
      flash.intensity = Math.max(0, flash.intensity - flash.intensity * 10 * dt);
      for (let i = strikes.length - 1; i >= 0; i--) {
        const st = strikes[i];
        st.t -= dt;
        if (st.bolt) {
          st.boltT -= dt;
          if (st.boltT <= 0) { group.remove(st.bolt); st.bolt = null; }
        }
        if (st.t <= 0 && !st.done) {
          st.done = true;
          // the bolt: jagged stack of glowing slabs
          const bolt = new THREE.Group();
          let bx = st.pos.x, bz = st.pos.z;
          for (let y = st.pos.y; y < st.pos.y + 26; y += 3.2) {
            const seg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 3.6, 0.28),
              new THREE.MeshBasicMaterial({ color: 0xeef4ff }));
            seg.position.set(bx, y + 1.6, bz);
            seg.rotation.z = SKY.U.rand(-0.2, 0.2);
            bolt.add(seg);
            bx += SKY.U.rand(-0.9, 0.9); bz += SKY.U.rand(-0.9, 0.9);
          }
          group.add(bolt);
          st.bolt = bolt; st.boltT = 0.18;
          flash.position.set(st.pos.x, st.pos.y + 8, st.pos.z);
          flash.intensity = 6;
          knockArea(st.pos, 4.5, 15, 13);
          SKY.Effects.ring(st.pos.clone(), '#cfe0ff', 6, 0.4);
          SKY.Effects.burst(st.pos, { count: 18, speed: 8, color: '#cfe0ff', life: 0.5 });
          SKY.SFX.thunder();
          strikes.splice(i, 1);
        }
      }
    });
    eventCfg = {
      min: 10, max: 17,
      pick() {
        const targets = SKY.Game.pawns.filter(p => p.alive);
        if (!targets.length) return null;
        const t = SKY.U.pick(targets);
        return { pos: [t.pos.x, t.pos.y, t.pos.z] };
      },
      exec(p) {
        const pos = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]);
        warnDecal(pos, 1.4, 0xcfe0ff);
        strikes.push({ pos, t: 1.4, done: false });
        SKY.HUD.subMsg('Lightning', 1.6);
      },
    };
  }

  /* ============================================================
   * MAP 6: YACHT — a mega-yacht at sea. Water = KO. Multi-deck
   * elevation: main deck, upper deck, bridge, sun roof, helipad,
   * plus a chase boat bobbing behind the stern.
   * ============================================================ */
  function buildYacht() {
    SKY.World.killY = 0.3;   // sea level (ish)
    SKY.World.crownHome = new THREE.Vector3(0, 8.6, -2);
    mood({
      sunColor: 0xfff2d0, sunInt: 1.6, sunPos: new THREE.Vector3(-35, 55, 25),
      hemiSky: 0xcfe4ff, hemiGround: 0x87b2c8, hemiInt: 0.85,   // sea bounce keeps
      fillColor: 0x8ad4ff, fillInt: 0.4,                         // undersides readable
      shafts: true, disc: 'sun', discSize: 58, discColor: '#fff8e0',
    });
    skyDome('#1e6ac0', '#66aade', '#d8f0ff');
    scene.fog = new THREE.Fog(0xa8d4ea, 90, 300);
    cloudField(14, 26, 0xffffff, 0.5);

    // ocean (animated, deadly)
    const oc = document.createElement('canvas');
    oc.width = oc.height = 128;
    const og = oc.getContext('2d');
    og.fillStyle = '#1a6a9e'; og.fillRect(0, 0, 128, 128);
    og.strokeStyle = 'rgba(255,255,255,.25)'; og.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      og.beginPath();
      og.moveTo(0, SKY.U.rand(0, 128)); og.bezierCurveTo(40, SKY.U.rand(0, 128), 90, SKY.U.rand(0, 128), 128, SKY.U.rand(0, 128));
      og.stroke();
    }
    const seaTex = new THREE.CanvasTexture(oc);
    seaTex.encoding = THREE.sRGBEncoding;
    seaTex.wrapS = seaTex.wrapT = THREE.RepeatWrapping;
    seaTex.repeat.set(16, 16);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(500, 500),
      new THREE.MeshLambertMaterial({ map: seaTex }));
    sea.rotation.x = -Math.PI / 2;
    group.add(sea);
    tickers.push((dt) => { seaTex.offset.x += dt * 0.02; seaTex.offset.y += dt * 0.012; });

    const HULL = ['#f2f4f6', '#c8ced6'];
    const DECK = ['#d8c49e', '#b89f78'];   // teak
    const DARK = ['#3a4250', '#282e3a'];

    // hull (visual walls) + main deck  (bow at -z, stern at +z)
    plat(0, 1.2, 0, 11, 2.4, 46, { pal: HULL });                 // hull block, top y=2.4
    plat(0, 2.55, 0, 10.4, 0.3, 45, { pal: DECK });              // main deck, top y=2.7
    // bow point
    plat(0, 2.4, -26.5, 7, 0.6, 8, { pal: DECK, rotY: 0.0 });
    plat(0, 2.4, -31, 3.5, 0.6, 4, { pal: DECK });
    // railings
    plat(5, 3.1, 0, 0.3, 0.9, 42, { pal: DARK });
    plat(-5, 3.1, 0, 0.3, 0.9, 42, { pal: DARK });
    // superstructure: upper deck + bridge + sun roof
    plat(0, 4.4, -6, 8.5, 3.4, 16, { pal: HULL });               // cabin block, top y=6.1
    plat(0, 6.3, -6, 9, 0.4, 17, { pal: DECK });                 // upper deck, top 6.5
    plat(0, 7.9, -9, 6.5, 2.8, 8, { pal: HULL });                // bridge, top 9.3
    plat(0, 9.5, -9, 7, 0.4, 9, { pal: DECK });                  // sun roof, top 9.7
    // stairs bow-side and stern-side up the superstructure
    plat(0, 3.4, 3.4, 3, 0.4, 5.4, { pal: DARK, rotX: -0.6 });
    plat(0, 7.2, -14.6, 3, 0.4, 5, { pal: DARK, rotX: 0.62 });
    // helipad aft (elevated ring)
    plat(0, 4.3, 16, 9, 0.5, 9, { pal: ['#5a6474', '#434b59'] }); // helipad, top 4.55
    plat(0, 3.3, 11, 2.6, 0.4, 4, { pal: DARK, rotX: -0.5 });     // ramp up
    // pool on main deck (sunken little trap, jump pad inside for fun)
    plat(2.6, 2.75, 6.5, 4, 0.25, 5.5, { material: flat(0x3ab4d8) });
    jumpPad(2.6, 2.9, 6.5, new THREE.Vector3(0, 15, 0), 0x3ad8d8);
    jumpPad(0, 9.7, -9, new THREE.Vector3(0, 14, 8), 0x3ad8d8);   // roof pad
    // deck furniture
    plat(-3.4, 3.0, 8, 1.4, 0.7, 3.6, { pal: HULL });
    plat(-3.4, 3.0, 13, 1.4, 0.7, 3.6, { pal: HULL });
    plat(3.6, 6.75, -12, 1.2, 0.6, 3, { pal: HULL });
    plat(-3.6, 6.75, -1, 1.2, 0.6, 3, { pal: HULL });
    // mast (grapple anchor high up)
    plat(0, 11.5, -6, 0.5, 4, 0.5, { pal: DARK });

    // chase boat bobbing behind the stern — risky flank platform
    plat(0, 1.6, 32, 4, 0.8, 9, {
      material: flat(0xd85f5f), tag: 'ride', ride: true,
      path: (t) => new THREE.Vector3(Math.sin(t * 0.7) * 2, 1.6 + Math.sin(t * 1.7) * 0.35, 32 + Math.sin(t * 0.4) * 1.5),
    });

    // spawns on open deck areas (aft deck, helipad, upper deck, bow)
    spawnPt(0, 2.85, 12); spawnPt(2.8, 2.85, 17); spawnPt(-2.8, 2.85, 17);
    spawnPt(0, 4.7, 16); spawnPt(0, 6.65, -2); spawnPt(0, 2.85, -20);
    [[0, 2.7, -20], [0, 2.7, 10], [0, 6.5, -3], [0, 9.7, -9], [0, 4.55, 16],
     [4.7, 2.7, -6], [-4.7, 2.7, -6], [0, 1.9, 32]]
      .forEach(p => roam(p[0], p[1], p[2]));
    [[0, 6.2, -6], [0, 9.4, -9], [0, 4.3, 16], [4.8, 2.9, 0], [-4.8, 2.9, 0], [0, 11, -6]]
      .forEach(p => anchor(p[0], p[1], p[2]));

    eventCfg = {
      min: 13, max: 20,
      pick() {
        return { dir: Math.random() < 0.5 ? 1 : -1 };   // big wave rolls the deck
      },
      exec(p) {
        SKY.HUD.subMsg('Big wave — hold on!', 2.5);
        SKY.SFX.gust();
        const wave = { t: 2.2, dir: p.dir };
        tickers.push((dt) => {
          if (wave.t <= 0) return;
          wave.t -= dt;
          for (const pw of SKY.Game.pawns) {
            if (!pw.alive || pw.isRemote) continue;
            pw.vel.x += wave.dir * 7 * dt;
          }
        });
      },
    };
  }

  /* ============================================================
   * MAP 7: TERMINAL — big cargo-port arena. A catwalk spine,
   * container cover, and open edges everywhere.
   * ============================================================ */
  function buildTerminal() {
    SKY.World.killY = -14;
    SKY.World.crownHome = new THREE.Vector3(0, 4.7, 0);
    mood({
      sunColor: 0xffe8c0, sunInt: 1.5, sunPos: new THREE.Vector3(35, 50, 20),
      hemiSky: 0xc4d4ec, hemiGround: 0x5e6470, hemiInt: 0.55,
      fillColor: 0x9ab4e8, fillInt: 0.3,
      shafts: true, disc: 'sun', discSize: 55, discColor: '#fff0d0',
    });
    skyDome('#2f5da8', '#84aede', '#e8d8b8');
    scene.fog = new THREE.Fog(0xb0bcd0, 100, 320);

    const CONC = ['#c8ccd4', '#a8adb8'];
    const YEL = ['#e8c85a', '#c4a83e'];
    const containers = [0xc4574f, 0x4f86c4, 0x58a86a, 0xc4a04f, 0x8a6cc4];
    const box = (x, y, z, sx, sy, sz, c) => plat(x, y, z, sx, sy, sz, { material: flat(c) });

    // main aprons (three big slabs with gaps between)
    plat(0, -1, 0, 26, 2, 34, { pal: CONC });                    // mid, top 0
    plat(-26, -1, -6, 20, 2, 30, { pal: CONC });                 // west (site A side)
    plat(26, -1, 4, 20, 2, 30, { pal: CONC });                   // east (site B side)
    // connecting bridges over the gaps
    plat(-14, -0.4, -12, 6, 0.5, 3, { pal: YEL });
    plat(-14, -0.4, 6, 6, 0.5, 3, { pal: YEL });
    plat(14, -0.4, -6, 6, 0.5, 3, { pal: YEL });
    plat(14, -0.4, 12, 6, 0.5, 3, { pal: YEL });
    // team platforms (attackers south, defenders north)
    plat(0, -0.6, 28, 14, 1.2, 8, { pal: YEL });                 // atk spawn, top 0
    plat(0, -0.6, -28, 14, 1.2, 8, { pal: YEL });                // def spawn, top 0
    plat(0, -0.5, 21.5, 4, 0.5, 6, { pal: CONC });               // walkways in
    plat(0, -0.5, -21.5, 4, 0.5, 6, { pal: CONC });

    // SITE A (west, elevated pad)
    plat(-26, 0.6, -8, 9, 1.2, 9, { pal: YEL });                 // top 1.2
    plat(-21, 0.1, -8, 2.6, 0.5, 4, { pal: CONC, rotZ: -0.25 }); // ramp
    // SITE B (east, ground level between containers)
    plat(26, 0.1, 6, 9, 0.25, 9, { pal: YEL });                  // top ~0.2

    // catwalk spine across mid (high ground)
    plat(0, 3.9, 0, 3, 0.4, 30, { pal: DARKC() });
    plat(0, 1.9, 13, 2.4, 0.4, 5, { pal: DARKC(), rotX: -0.55 });
    plat(0, 1.9, -13, 2.4, 0.4, 5, { pal: DARKC(), rotX: 0.55 });

    function DARKC() { return ['#4a505c', '#363b45']; }

    // container stacks (cover + parkour)
    box(-6, 1.25, -4, 3, 2.5, 7, containers[0]);
    box(6, 1.25, 5, 3, 2.5, 7, containers[1]);
    box(7, 3.75, 5, 3, 2.5, 7, containers[2]);                   // stacked
    box(-28, 1.85, 4, 7, 2.5, 3, containers[3]);
    box(24, 1.35, -6, 3, 2.5, 7, containers[4]);
    box(-8, 1.25, 10, 7, 2.5, 3, containers[2]);
    box(30, 1.35, 12, 7, 2.5, 3, containers[0]);
    // crane towers (visual) + crossbeam (walkable, connects to catwalk)
    plat(-1.5, 6.2, 0, 26, 0.5, 1.6, { pal: YEL, rotY: 0 });     // crane beam, top 6.45
    box(-13, 3, 0, 1.4, 6, 1.4, 0x8a919e);
    box(11, 3, 0, 1.4, 6, 1.4, 0x8a919e);
    // cargo dressing (flush against the containers — lanes unchanged)
    propAt('Prop_Crate_Large', -7, 0, 7.4, 0.35, 1, true);
    propAt('Prop_Crate', -5.2, 0, 6.6, 0.9, 1, true);
    propAt('Prop_Barrel1', 22.5, 0, -2, 0, 1, true);
    propAt('Prop_Barrel2_Closed', 23.5, 0, -1.6, 0.6, 1, true);
    propAt('Prop_Locker', -29.5, 0, 6.4, Math.PI, 0.85, true);
    propAt('Prop_SatelliteDish', 30, 2.62, 12, -0.7, 0.6, false);
    propAt('Prop_Ammo_Closed', 5.2, 0, 3.2, -0.4, 1, true);
    propAt('Prop_Crate_Tarp', -25, 0.7, -10, 1.2, 1, true);
    jumpPad(-22, 0, 8, new THREE.Vector3(4, 15, -4), 0xe8c85a);
    jumpPad(22, 0, -8, new THREE.Vector3(-4, 15, 4), 0xe8c85a);

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      spawnPt(Math.cos(a) * 9, 0.1, Math.sin(a) * 9);
    }
    [[0, 0, 0], [-26, 1.3, -8], [26, 0.3, 6], [0, 4.1, 0], [0, 0, 24], [0, 0, -24],
     [-26, 0, 4], [26, 0, -4], [-14, 0, -12], [14, 0, 12]]
      .forEach(p => roam(p[0], p[1], p[2]));
    [[0, 3.7, 0], [-26, 1, -8], [26, 0.2, 6], [-1.5, 6.2, 0], [0, -0.3, 26], [0, -0.3, -26]]
      .forEach(p => anchor(p[0], p[1], p[2]));

    eventCfg = null;   // no random events on this one
  }

  /* ============================================================
   * CUSTOM MAPS — built from a SKY.MapData JSON def (the editor's output)
   * ============================================================ */
  const _texCache = {};
  function texFromDataURL(url, repeat) {
    const key = url.slice(0, 64) + url.length + '|' + repeat;
    if (_texCache[key]) return _texCache[key];
    const tex = new THREE.TextureLoader().load(url);
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = 4;
    _texCache[key] = tex;
    return tex;
  }

  /* per-block texture instance: optional density override (b.rep = tiles
     across the block, like before) + a per-block random offset so repeated
     grass/rock blocks don't look like identical clones */
  function blockTex(b, name) {
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

  function customBlockMaterial(b) {
    const rep = b.rep || Math.max(2, Math.round(Math.max(b.s[0], b.s[2]) / 3));
    if (b.tex) return new THREE.MeshLambertMaterial({ map: texFromDataURL(b.tex, b.rep ? rep : 1) });
    const single = () => {
      if (b.ptex && SKY.U.PROC_TEX[b.ptex]) {
        return new THREE.MeshLambertMaterial({ map: blockTex(b, b.ptex) });
      }
      const pal = SKY.MapData.PALETTES[b.pal];
      if (pal) return mat(pal, 1);
      return flat(b.color || '#8a94a8');
    };
    // per-face paint (boxes): face order +x -x +y(top) -y +z -z
    if (b.ptexF && (!b.shape || b.shape === 'box')) {
      const mats = [];
      for (let f = 0; f < 6; f++) {
        const pf = b.ptexF[f];
        mats.push(pf && SKY.U.PROC_TEX[pf]
          ? new THREE.MeshLambertMaterial({ map: blockTex(b, pf) })
          : single());
      }
      return mats;
    }
    return single();
  }

  /* mover def -> plat() path function */
  function moverPath(b) {
    const m = b.mover;
    if (!m) return null;
    const base = new THREE.Vector3(b.p[0], b.p[1], b.p[2]);
    const period = Math.max(1, m.period || 6);
    if (m.type === 'orbit') {
      const cx = m.c ? m.c[0] : 0, cz = m.c ? m.c[1] : 0;
      const rx = base.x - cx, rz = base.z - cz;
      return (t) => {
        const a = t * Math.PI * 2 / period;
        return new THREE.Vector3(
          cx + rx * Math.cos(a) - rz * Math.sin(a), base.y,
          cz + rx * Math.sin(a) + rz * Math.cos(a));
      };
    }
    // 'line' (and 'elevator' = a vertical line) — glide base <-> base+off
    const off = new THREE.Vector3(...(m.type === 'elevator'
      ? [0, m.amp || 4, 0] : (m.off || [6, 0, 0])));
    return (t) => {
      const s = (Math.sin(t * Math.PI * 2 / period) + 1) / 2;
      return base.clone().addScaledVector(off, s);
    };
  }

  /* stairs get a walkable RAMP solid instead of one giant box (which made
     them impossible to climb). c/s = the prop's local-frame bbox center/size,
     obj already carries its final rotation. */
  function addStairRamp(obj, c, s) {
    // ascent direction: compare average vertex height in each local z-half
    let sumP = 0, nP = 0, sumN = 0, nN = 0;
    obj.traverse((ch) => {
      if (!ch.isMesh || !ch.geometry || !ch.geometry.attributes.position) return;
      const pos = ch.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i), z = pos.getZ(i);
        if (z > 0.01) { sumP += y; nP++; }
        else if (z < -0.01) { sumN += y; nN++; }
      }
    });
    const ascend = (!nP || !nN || sumP / nP >= sumN / nN) ? 1 : -1;
    const h = s.y, run = s.z, L = Math.sqrt(h * h + run * run), t = 0.5;
    const q = obj.quaternion.clone().multiply(new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-ascend * Math.atan2(h, run), 0, 0)));
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    // box center sits half a thickness below the slope's midpoint
    const n = new THREE.Vector3(0, run, -ascend * h).normalize();
    const lc = c.clone().sub(obj.position).addScaledVector(n, -t / 2);
    lc.applyQuaternion(obj.quaternion).add(obj.position);
    SKY.World.addSolid({
      x: lc.x, y: lc.y, z: lc.z, sx: s.x, sy: t, sz: L + 0.15,
      rotX: e.x, rotY: e.y, rotZ: e.z,
    });
  }

  /* collision for walls with a walk-through opening (doorways / arches /
     door frames): raycast a grid of columns through the wall and rebuild
     the solid as jambs + a lintel so the opening is actually passable.
     Runs on the UNROTATED prop; returns pre-rotation boxes {c, s}, or null
     when the piece turns out solid all the way across (plain walls,
     barricaded doorways). `excludeRoot` skips a subtree (the door panel). */
  function carveOpenings(obj, box, excludeRoot) {
    const size = box.getSize(new THREE.Vector3());
    if (size.y < 1.6) return null;                      // too low to walk through
    const wAxis = size.x >= size.z ? 'x' : 'z';         // width across the wall
    const tAxis = wAxis === 'x' ? 'z' : 'x';            // thickness through it
    if (size[wAxis] < 1 || size[tAxis] > size[wAxis]) return null;
    const meshes = [];
    obj.traverse((o) => {
      if (!o.isMesh) return;
      for (let q = o; q; q = q.parent) if (q === excludeRoot) return;
      meshes.push(o);
    });
    if (!meshes.length) return null;
    const rc = new THREE.Raycaster();
    rc.far = size[tAxis] + 2;
    const org = new THREE.Vector3(), dir = new THREE.Vector3();
    dir[tAxis] = 1;
    const nx = 20, ny = 12;
    const openH = [];       // per column: clear height up from the floor
    for (let i = 0; i < nx; i++) {
      const w = box.min[wAxis] + ((i + 0.5) / nx) * size[wAxis];
      let clear = 0;
      for (let j = 0; j < ny; j++) {
        org[wAxis] = w;
        org.y = box.min.y + ((j + 0.5) / ny) * size.y;
        org[tAxis] = box.min[tAxis] - 1;
        rc.set(org, dir);
        if (rc.intersectObjects(meshes, false).length) break;
        clear = ((j + 1) / ny) * size.y;
      }
      openH.push(clear);
    }
    const walk = 1.6;       // min clearance a pawn can run through
    if (!openH.some(h => h >= walk)) return null;       // no opening — keep the box
    // merge consecutive same-type columns into boxes
    const boxes = [];
    const colW = size[wAxis] / nx;
    let i = 0;
    while (i < nx) {
      const open = openH[i] >= walk;
      let j = i, low = Infinity;
      while (j < nx && (openH[j] >= walk) === open) { low = Math.min(low, openH[j]); j++; }
      const bc = new THREE.Vector3(), bs = new THREE.Vector3();
      bc[wAxis] = box.min[wAxis] + ((i + j) / 2) * colW;
      bc[tAxis] = (box.min[tAxis] + box.max[tAxis]) / 2;
      bs[wAxis] = (j - i) * colW;
      bs[tAxis] = size[tAxis];
      if (open) {
        // lintel above the opening (skipped when it reaches the very top)
        const top = box.min.y + low;
        if (box.max.y - top > 0.08) {
          bc.y = (top + box.max.y) / 2;
          bs.y = box.max.y - top;
          boxes.push({ c: bc, s: bs });
        }
      } else {
        bc.y = (box.min.y + box.max.y) / 2;
        bs.y = size.y;
        boxes.push({ c: bc, s: bs });
      }
      i = j;
    }
    return boxes;
  }

  /* =============================================================
   * MESH-FIT PROP COLLISION (prop setting `coll: 'mesh'`)
   * Voxelize the model's actual triangles into a small set of boxes in the
   * prop's LOCAL (unscaled, unrotated) frame, then greedily merge filled
   * cells. Ramps, stacked crates and openings collide like they LOOK
   * instead of as one giant bounding box. Shared with the editor's
   * collision display via SKY.Map.propCollisionLocal.
   * ============================================================= */
  const _pm = new THREE.Matrix4();
  const _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pc = new THREE.Vector3();
  const _pe1 = new THREE.Vector3(), _pe2 = new THREE.Vector3(), _pp = new THREE.Vector3();

  /* matrix of `node` relative to `root` (root's own transform excluded) */
  function relMatrix(node, root, m) {
    m.identity();
    for (let n = node; n && n !== root; n = n.parent) {
      n.updateMatrix();
      m.premultiply(n.matrix);
    }
    return m;
  }

  function collMeshes(obj) {
    const meshes = [];
    obj.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.attributes.position &&
          o.name !== 'edmarker' && o.name !== 'edcoll' && o.name !== 'nocoll') meshes.push(o);
    });
    return meshes;
  }

  /* local-frame bounds — same corner-transform recipe as Box3.setFromObject,
     so the 'box' mode here matches what the game builds */
  function localBounds(obj, meshes) {
    const box = new THREE.Box3();
    const corner = _pa;
    for (const mesh of meshes) {
      relMatrix(mesh, obj, _pm);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      for (let k = 0; k < 8; k++) {
        corner.set(k & 1 ? bb.max.x : bb.min.x,
                   k & 2 ? bb.max.y : bb.min.y,
                   k & 4 ? bb.max.z : bb.min.z).applyMatrix4(_pm);
        box.expandByPoint(corner);
      }
    }
    return box;
  }

  function voxelBoxes(obj, meshes) {
    const bounds = localBounds(obj, meshes);
    if (bounds.isEmpty()) return null;
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!(maxDim > 0.05)) return null;
    // grid: ~16 cells across the largest side, cells never thinner than 14 cm
    const cellT = SKY.U.clamp(maxDim / 16, 0.14, 1.0);
    const nx = SKY.U.clamp(Math.ceil(size.x / cellT), 1, 24);
    const ny = SKY.U.clamp(Math.ceil(size.y / cellT), 1, 24);
    const nz = SKY.U.clamp(Math.ceil(size.z / cellT), 1, 24);
    const cx = size.x / nx, cy = size.y / ny, cz = size.z / nz;
    const fill = new Uint8Array(nx * ny * nz);
    const at = (x, y, z) => x + nx * (y + ny * z);
    const minCell = Math.max(0.02, Math.min(cx, cy, cz));
    const mark = (p) => {
      const ix = SKY.U.clamp(Math.floor((p.x - bounds.min.x) / cx), 0, nx - 1);
      const iy = SKY.U.clamp(Math.floor((p.y - bounds.min.y) / cy), 0, ny - 1);
      const iz = SKY.U.clamp(Math.floor((p.z - bounds.min.z) / cz), 0, nz - 1);
      fill[at(ix, iy, iz)] = 1;
    };
    // sample every triangle's surface at ~half-cell steps: thin ramps and
    // walls fill their cells without a full tri-box intersection test
    let tris = 0;
    for (const mesh of meshes) {
      relMatrix(mesh, obj, _pm);
      const pos = mesh.geometry.attributes.position;
      const idx = mesh.geometry.index;
      const n = idx ? idx.count : pos.count;
      tris += n / 3;
      if (tris > 80000) return null;   // absurd poly count — keep the box
      for (let i = 0; i + 2 < n; i += 3) {
        _pa.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(_pm);
        _pb.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(_pm);
        _pc.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(_pm);
        const e = Math.max(_pa.distanceTo(_pb), _pb.distanceTo(_pc), _pc.distanceTo(_pa));
        const steps = SKY.U.clamp(Math.ceil(e / (minCell * 0.5)), 1, 40);
        _pe1.copy(_pb).sub(_pa);
        _pe2.copy(_pc).sub(_pa);
        for (let u = 0; u <= steps; u++) {
          for (let v = 0; v <= steps - u; v++) {
            _pp.copy(_pa).addScaledVector(_pe1, u / steps).addScaledVector(_pe2, v / steps);
            mark(_pp);
          }
        }
      }
    }
    // flood-fill from the outside: air the player can never reach (sealed
    // crate interiors) becomes solid — fewer, fatter boxes after the merge.
    // Rooms/arches stay open: their openings connect them to the outside.
    const open = new Uint8Array(fill.length);
    const stack = [];
    const tryOpen = (x, y, z) => {
      const ii = at(x, y, z);
      if (fill[ii] || open[ii]) return;
      open[ii] = 1;
      stack.push(x, y, z);
    };
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { tryOpen(0, y, z); tryOpen(nx - 1, y, z); }
    for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) { tryOpen(x, 0, z); tryOpen(x, ny - 1, z); }
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) { tryOpen(x, y, 0); tryOpen(x, y, nz - 1); }
    while (stack.length) {
      const z = stack.pop(), y = stack.pop(), x = stack.pop();
      if (x > 0) tryOpen(x - 1, y, z);
      if (x + 1 < nx) tryOpen(x + 1, y, z);
      if (y > 0) tryOpen(x, y - 1, z);
      if (y + 1 < ny) tryOpen(x, y + 1, z);
      if (z > 0) tryOpen(x, y, z - 1);
      if (z + 1 < nz) tryOpen(x, y, z + 1);
    }
    for (let i = 0; i < fill.length; i++) if (!fill[i] && !open[i]) fill[i] = 1;

    // greedy merge: grow each unvisited filled cell along x, then z, then y
    const visited = new Uint8Array(fill.length);
    const boxes = [];
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i0 = at(x, y, z);
      if (!fill[i0] || visited[i0]) continue;
      let x1 = x;
      while (x1 + 1 < nx && fill[at(x1 + 1, y, z)] && !visited[at(x1 + 1, y, z)]) x1++;
      let z1 = z;
      growZ: while (z1 + 1 < nz) {
        for (let xi = x; xi <= x1; xi++) {
          const ii = at(xi, y, z1 + 1);
          if (!fill[ii] || visited[ii]) break growZ;
        }
        z1++;
      }
      let y1 = y;
      growY: while (y1 + 1 < ny) {
        for (let zi = z; zi <= z1; zi++) for (let xi = x; xi <= x1; xi++) {
          const ii = at(xi, y1 + 1, zi);
          if (!fill[ii] || visited[ii]) break growY;
        }
        y1++;
      }
      for (let zi = z; zi <= z1; zi++) for (let yi = y; yi <= y1; yi++)
        for (let xi = x; xi <= x1; xi++) visited[at(xi, yi, zi)] = 1;
      boxes.push({
        c: new THREE.Vector3(
          bounds.min.x + (x + x1 + 1) / 2 * cx,
          bounds.min.y + (y + y1 + 1) / 2 * cy,
          bounds.min.z + (z + z1 + 1) / 2 * cz),
        s: new THREE.Vector3((x1 - x + 1) * cx, (y1 - y + 1) * cy, (z1 - z + 1) * cz),
      });
    }
    if (!boxes.length || boxes.length > 48) return null;   // degenerate/too fragmented
    return boxes;
  }

  /* collision boxes for a prop in its LOCAL frame (no rotation, no scale).
     mode 'mesh' -> voxel fit (falls back to the plain bounds when the model
     is degenerate); anything else -> one bounding box. */
  function propCollisionLocal(obj, mode) {
    const meshes = collMeshes(obj);
    if (!meshes.length) return [];
    if (mode === 'mesh') {
      const v = voxelBoxes(obj, meshes);
      if (v) return v;
    }
    const b = localBounds(obj, meshes);
    if (b.isEmpty()) return [];
    return [{ c: b.getCenter(new THREE.Vector3()), s: b.getSize(new THREE.Vector3()) }];
  }

  /* =============================================================
   * SEA EVENTS — tsunami / bermuda triangle / kraken / shark.
   * Placed as invisible fx: markers in the editor; fully DETERMINISTIC off
   * the synced round clock (start/every/dur + a seeded chance roll), so
   * every client sees the same show with zero net messages. Forces apply
   * only to pawns this client simulates (own pawn + host's bots).
   * ============================================================= */
  const _ev = new THREE.Vector3();
  const _ev2 = new THREE.Vector3();

  /* seeded 0..1 — identical on every peer for (marker, cycle) */
  function evRand(pr, cycle) {
    let x = (Math.imul((pr.p[0] * 73 + pr.p[2] * 179 + pr.p[1] * 37) | 0, 2654435761) ^
             Math.imul(cycle + 1, 40503)) | 0;
    x = Math.imul(x ^ (x >>> 15), 1 | x);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }

  /* knock that respects ownership (skip remote pawns — their client rolls
     the same event and applies it locally) */
  function evKnock(pos, radius, force, up) {
    for (const p of SKY.Game.pawns) {
      if (!p.alive || p.isRemote) continue;
      _ev.set(p.pos.x - pos.x, 0, p.pos.z - pos.z);
      const d = _ev.length();
      if (d > radius || Math.abs(p.pos.y - pos.y) > 6) continue;
      const k = 1 - (d / radius) * 0.55;
      _ev.multiplyScalar(d > 0.01 ? 1 / d : 0);
      p.applyKnockback(_ev2.set(_ev.x * force * k, up * k, _ev.z * force * k), null);
      p.grounded = false;
    }
  }

  const lamEv = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e || 0x000000 });

  /* ---- per-kind build / tick (vis = { g, ...state }) ---- */
  const EV_BUILD = {
    tsunami(pr, o) {
      const g = new THREE.Group();
      const col = new THREE.Color(o.color).convertSRGBToLinear();
      const w = o.size, h = o.height;
      // rolling crest: a squashed half-cylinder wall + a foam cap
      const body = new THREE.Mesh(new THREE.CylinderGeometry(h, h, w, 18, 1, false,
        0, Math.PI), new THREE.MeshPhongMaterial({
          color: col, transparent: true, opacity: 0.82, shininess: 60,
          specular: 0x668aa8, side: THREE.DoubleSide }));
      body.rotation.z = Math.PI / 2;   // cylinder axis along X = wave width
      body.scale.set(1, 1, 0.62);
      body.position.y = 0;
      const foam = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.16, h * 0.5),
        lamEv(0xf4fbff, 0x3a4148));
      foam.position.y = h * 0.92;
      g.add(body, foam);
      group.add(g);
      const yaw = (pr.r && pr.r[1]) || 0;
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      g.rotation.y = yaw;
      if (SKY.Game.player) {
        SKY.HUD.subMsg('TSUNAMI incoming!', 2.5);
        SKY.SFX.gust();
      }
      return { g, fwd, right, sprayT: 0 };
    },
    triangle(pr, o) {
      const g = new THREE.Group();
      const col = new THREE.Color(o.color).convertSRGBToLinear();
      const r = o.size;
      // glowing triangle ring + swirling mist + a downward throat
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.5, 3, 1, true),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      ring.position.y = 0.4;
      g.add(ring);
      const swirls = [];
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Mesh(new THREE.PlaneGeometry(r * 1.7, r * 1.7),
          new THREE.MeshBasicMaterial({ map: SKY.U.blobTexture(), color: col,
            transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
            depthWrite: false, side: THREE.DoubleSide }));
        s.rotation.x = -Math.PI / 2;
        s.position.y = 0.3 + i * 0.5;
        g.add(s);
        swirls.push(s);
      }
      const throat = new THREE.Mesh(new THREE.ConeGeometry(r * 0.55, 4.5, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      throat.rotation.x = Math.PI;
      throat.position.y = -2;
      g.add(throat);
      const light = new THREE.PointLight(col, 1.6, r * 3.2, 1.6);
      light.position.y = 1.5;
      g.add(light);
      g.position.set(pr.p[0], pr.p[1], pr.p[2]);
      group.add(g);
      if (SKY.Game.player) {
        SKY.HUD.subMsg('The BERMUDA TRIANGLE opens…', 2.5);
        SKY.SFX.thunder();
      }
      return { g, swirls, ring };
    },
    kraken(pr, o) {
      const g = new THREE.Group();
      const col = new THREE.Color(o.color).convertSRGBToLinear();
      const skin = lamEv(col, col.clone().multiplyScalar(0.15));
      const tents = [];
      const n = 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.4;
        const t = new THREE.Group();
        const seg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.6, 4.6, 8), skin);
        seg1.position.y = 2.3;
        const seg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.28, 3.2, 8), skin);
        seg2.position.y = 5.8;
        seg2.rotation.z = 0.35;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), skin);
        tip.position.set(-1, 7.2, 0);
        t.add(seg1, seg2, tip);
        t.position.set(Math.cos(a) * o.size * 0.62, -8, Math.sin(a) * o.size * 0.62);
        t.rotation.y = -a;
        g.add(t);
        tents.push({ t, phase: i * 1.1, baseA: a });
      }
      g.position.set(pr.p[0], pr.p[1], pr.p[2]);
      group.add(g);
      if (SKY.Game.player) {
        SKY.HUD.subMsg('KRAKEN! Tentacles from the deep!', 2.5);
        SKY.SFX.rumble();
      }
      return { g, tents, slamT: 1.2, o };
    },
    shark(pr, o) {
      const g = new THREE.Group();
      const col = new THREE.Color(o.color).convertSRGBToLinear();
      const skin = lamEv(col.clone().multiplyScalar(0.5));
      const fin = new THREE.Group();
      const finMesh = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.5, 4), skin);
      finMesh.position.y = 0.9;
      finMesh.rotation.y = Math.PI / 4;
      finMesh.scale.z = 0.35;
      const back = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 2.4, 4, 8), skin);
      back.rotation.x = Math.PI / 2;
      back.position.y = 0.15;
      fin.add(finMesh, back);
      g.add(fin);
      g.position.set(pr.p[0], pr.p[1], pr.p[2]);
      group.add(g);
      if (SKY.Game.player) SKY.HUD.subMsg('Shark in the water!', 2.2);
      return { g, fin, ang: evRand(pr, 999) * Math.PI * 2, wakeT: 0, o };
    },
  };

  const EV_TICK = {
    tsunami(v, dt, phase, pr, o) {
      // sweep: starts range/2 behind the marker, rides through along facing
      const along = -o.range / 2 + o.range * phase;
      v.g.position.set(pr.p[0] + v.fwd.x * along, pr.p[1], pr.p[2] + v.fwd.z * along);
      // spray off the crest
      v.sprayT -= dt;
      if (v.sprayT <= 0) {
        v.sprayT = 0.09;
        _ev.set(v.g.position.x + v.right.x * SKY.U.rand(-o.size / 2, o.size / 2),
                pr.p[1] + o.height * SKY.U.rand(0.7, 1.05),
                v.g.position.z + v.right.z * SKY.U.rand(-o.size / 2, o.size / 2));
        SKY.Effects.burst(_ev, { count: 3, speed: 3.5, color: '#eaf6ff',
          gravity: 7, life: 0.5, size: 0.6 });
      }
      // push everything caught in the face of the wave
      for (const p of SKY.Game.pawns) {
        if (!p.alive || p.isRemote) continue;
        _ev.set(p.pos.x - v.g.position.x, 0, p.pos.z - v.g.position.z);
        const a = _ev.dot(v.fwd), lat = _ev.dot(v.right);
        if (Math.abs(a) > 4 || Math.abs(lat) > o.size / 2) continue;
        if (p.pos.y > pr.p[1] + o.height + 2.5) continue;
        p.vel.addScaledVector(v.fwd, o.power * dt);
        p.vel.y += o.power * 0.4 * dt;
        p.grounded = false;
      }
    },
    triangle(v, dt, phase, pr, o) {
      const grow = Math.min(1, phase / 0.12) * Math.min(1, (1 - phase) / 0.12);
      v.g.scale.setScalar(Math.max(0.001, grow));
      v.g.rotation.y += dt * 0.8;
      for (let i = 0; i < v.swirls.length; i++) {
        v.swirls[i].rotation.z += dt * (1.6 + i * 0.7);
      }
      v.ring.material.opacity = 0.45 + Math.sin(performance.now() * 0.004) * 0.25;
      // the pull — and the throat swallows anyone who drifts to the middle
      for (const p of SKY.Game.pawns) {
        if (!p.alive || p.isRemote) continue;
        _ev.set(pr.p[0] - p.pos.x, 0, pr.p[2] - p.pos.z);
        const d = _ev.length();
        if (d > o.size || Math.abs(p.pos.y - pr.p[1]) > 7) continue;
        _ev.multiplyScalar(d > 0.01 ? 1 / d : 0);
        const k = grow * (1 - (d / o.size) * 0.4);
        p.vel.addScaledVector(_ev, o.power * k * dt);
        if (d < o.size * 0.35) p.vel.y -= o.power * 0.55 * k * dt;
        p.grounded = false;
      }
    },
    kraken(v, dt, phase, pr, o) {
      const t = performance.now() * 0.001;
      const rise = Math.min(1, phase / 0.15) * Math.min(1, (1 - phase) / 0.12);
      for (const tn of v.tents) {
        tn.t.position.y = -8 + rise * 8;
        tn.t.rotation.z = Math.sin(t * 2.1 + tn.phase) * 0.28;
        tn.t.rotation.x = Math.cos(t * 1.7 + tn.phase) * 0.2;
      }
      v.slamT -= dt;
      if (v.slamT <= 0 && rise > 0.9) {
        v.slamT = 1.6;
        evKnock(v.g.position, o.size + 2, o.power, o.power * 0.55);
        SKY.Effects.ring(_ev.set(v.g.position.x, v.g.position.y + 0.4, v.g.position.z).clone(),
          '#bfe9ff', o.size, 0.5);
        SKY.SFX.boom(SKY.Game.player ? v.g.position.distanceTo(SKY.Game.player.pos) : 20);
      }
    },
    shark(v, dt, phase, pr, o) {
      v.ang += dt * (5.2 / Math.max(3, o.size));   // ~constant surface speed
      const fx = pr.p[0] + Math.cos(v.ang) * o.size;
      const fz = pr.p[2] + Math.sin(v.ang) * o.size;
      v.g.position.set(fx, pr.p[1], fz);
      v.g.rotation.y = -v.ang - Math.PI / 2;       // face along the tangent
      v.wakeT -= dt;
      if (v.wakeT <= 0) {
        v.wakeT = 0.12;
        SKY.Effects.trailPuff(_ev.set(fx, pr.p[1] + 0.25, fz).clone(), '#dceefc');
      }
      // the bite: close + near sea level = launched
      for (const p of SKY.Game.pawns) {
        if (!p.alive || p.isRemote) continue;
        if (Math.abs(p.pos.y - pr.p[1]) > 2.6) continue;
        _ev.set(p.pos.x - fx, 0, p.pos.z - fz);
        if (_ev.lengthSq() > 2.6 * 2.6) continue;
        if (p._sharkT && SKY.Game.time - p._sharkT < 1.3) continue;
        p._sharkT = SKY.Game.time;
        _ev.normalize();
        p.applyKnockback(_ev2.set(_ev.x * o.power, o.power * 0.7, _ev.z * o.power), null);
        SKY.Effects.hitBurst(_ev2.set(p.pos.x, p.pos.y + 0.7, p.pos.z).clone(), 2, '#eaf6ff');
        SKY.SFX.hit(0.7, SKY.Game.player ? p.pos.distanceTo(SKY.Game.player.pos) : 10);
      }
    },
  };

  function registerSeaEvent(kind, pr) {
    const o = { ...(SKY.Assets ? SKY.Assets.fxDefaults('fx:' + kind) : {}), ...(pr.fx || {}) };
    o.start = Math.max(0, o.start || 0);
    o.every = Math.max(5, o.every || 30);
    o.dur = Math.min(Math.max(1, o.dur || 8), o.every);
    const st = { on: false, vis: null };
    tickers.push((dt) => {
      const playing = SKY.Game.state === 'playing' || SKY.Game.state === 'roundend';
      const t = SKY.Game.roundTime;
      let want = false, phase = 0;
      if (playing && t >= o.start) {
        const cyc = Math.floor((t - o.start) / o.every);
        const ph = (t - o.start) - cyc * o.every;
        if (ph < o.dur &&
            evRand(pr, cyc) * 100 < (o.chance !== undefined ? o.chance : 100)) {
          want = true;
          phase = ph / o.dur;
        }
      }
      if (want && !st.on) { st.on = true; st.vis = EV_BUILD[kind](pr, o); }
      else if (!want && st.on) {
        st.on = false;
        if (st.vis) { group.remove(st.vis.g); st.vis = null; }
      }
      if (st.on && st.vis) EV_TICK[kind](st.vis, dt, phase, pr, o);
    });
  }

  /* -------- interactable doors -------- */
  function setDoor(i, open) {
    const d = doors[i];
    if (!d || d.open === open) return;
    d.open = open;
    // swap the panel slab between its closed and open pose (the frame's
    // jambs/lintel are separate static solids and never move)
    if (d.solid) { SKY.World.removeSolid(d.solid); d.solid = null; }
    const opts = open ? d.openOpts : d.closedOpts;
    if (d.wantSolid && opts) d.solid = SKY.World.addSolid(opts);
    if (SKY.SFX && SKY.SFX.door) {
      const me = SKY.Game && SKY.Game.player;
      SKY.SFX.door(me ? d.pos.distanceTo(me.pos) : 10);
    }
  }

  /* the grapple key doubles as USE: toggle a door the player is next to and
     roughly facing — returns true when the press was consumed */
  function tryInteract(pawn) {
    let best = -1, bestD = 2.6;
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (!d) continue;
      const dist = d.pos.distanceTo(pawn.pos);
      if (dist > bestD) continue;
      // facing check keeps the grapple usable while running past doors
      _v.set(d.pos.x - pawn.pos.x, 0, d.pos.z - pawn.pos.z).normalize();
      if (dist > 0.9 &&
          (_v.x * -Math.sin(pawn.yaw) + _v.z * -Math.cos(pawn.yaw)) < 0.35) continue;
      best = i; bestD = dist;
    }
    if (best < 0) return false;
    setDoor(best, !doors[best].open);
    if (SKY.Net.online) SKY.Net.sendDoor(best, doors[best].open);
    return true;
  }

  /* =============================================================
   * SCULPTED TERRAIN (editor TERRAIN tool) — a heightfield grid with a
   * 4-texture splat blend (sand/rock/grass/dirt by default). The visual is
   * a displaced plane; collision is a real heightfield in world.js.
   * ============================================================= */
  function terrainMaterial(tr) {
    const texs = tr.texs || ['sand', 'rock', 'grass', 'dirt'];
    const rep = Math.max(1, tr.rep || Math.round((tr.size || 60) / 6));
    const t = (nm) => (SKY.GFX && SKY.GFX.texture) ? SKY.GFX.texture(nm, 1) : null;
    const t0 = t(texs[0]);
    if (!t0) return new THREE.MeshLambertMaterial({ color: 0xd8c49a });  // file:// look
    const t1 = t(texs[1]) || t0, t2 = t(texs[2]) || t0, t3 = t(texs[3]) || t0;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: t0 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uT1 = { value: t1 };
      sh.uniforms.uT2 = { value: t2 };
      sh.uniforms.uT3 = { value: t3 };
      sh.uniforms.uRep = { value: rep };
      sh.vertexShader = 'attribute vec4 asplat;\nvarying vec4 vSplat;\n' +
        sh.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvSplat = asplat;');
      sh.fragmentShader = ('uniform sampler2D uT1;\nuniform sampler2D uT2;\n' +
        'uniform sampler2D uT3;\nuniform float uRep;\nvarying vec4 vSplat;\n') +
        sh.fragmentShader.replace('#include <map_fragment>', [
          'vec2 tuv = vUv * uRep;',
          'vec4 w = vSplat; w.x += 0.001;',
          'w /= (w.x + w.y + w.z + w.w);',
          'diffuseColor *= texture2D(map, tuv) * w.x + texture2D(uT1, tuv) * w.y +',
          '  texture2D(uT2, tuv) * w.z + texture2D(uT3, tuv) * w.w;',
        ].join('\n'));
    };
    return mat;
  }

  /* perimeter WALLS that follow the sculpted rim + optional bottom cap.
     One mesh, no coplanar faces = no z-fighting with the surface, and raised
     edges are never hollow. `update()` refits the wall to live heights
     (the editor calls it every brush frame). */
  function buildTerrainSides(tr, hts, segs, sx, sz) {
    const n = segs + 1;
    const cellX = sx / segs, cellZ = sz / segs;
    const cap = tr.base && tr.base > 0.05;
    const strips = 4 * n * 2;                       // 2 verts per edge column
    const capVerts = cap ? 4 : 0;
    const posArr = new Float32Array((strips + capVerts) * 3);
    const uvArr = new Float32Array((strips + capVerts) * 2);
    const idx = [];
    for (let e = 0; e < 4; e++) {
      const base = e * n * 2;
      for (let i = 0; i < segs; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    if (cap) {
      const c0 = strips;
      idx.push(c0, c0 + 1, c0 + 2, c0 + 2, c0 + 1, c0 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    geo.setIndex(idx);
    const update = (heights) => {
      let minH = 0;
      for (let i = 0; i < heights.length; i++) if (heights[i] < minH) minH = heights[i];
      const yBot = cap ? -Math.max(0.5, tr.base) : minH - 2.5;
      const edge = (e, i) => {   // -> [x, z, h]
        if (e === 0) return [-sx / 2 + i * cellX, -sz / 2, heights[i]];
        if (e === 1) return [-sx / 2 + i * cellX, sz / 2, heights[segs * n + i]];
        if (e === 2) return [-sx / 2, -sz / 2 + i * cellZ, heights[i * n]];
        return [sx / 2, -sz / 2 + i * cellZ, heights[i * n + segs]];
      };
      for (let e = 0; e < 4; e++) {
        for (let i = 0; i < n; i++) {
          const [x, z, h] = edge(e, i);
          const v = (e * n + i) * 2;
          posArr[v * 3] = x; posArr[v * 3 + 1] = h; posArr[v * 3 + 2] = z;
          posArr[v * 3 + 3] = x; posArr[v * 3 + 4] = yBot; posArr[v * 3 + 5] = z;
          const u = (e < 2 ? x : z) / 4;
          uvArr[v * 2] = u; uvArr[v * 2 + 1] = h / 4;
          uvArr[v * 2 + 2] = u; uvArr[v * 2 + 3] = yBot / 4;
        }
      }
      if (cap) {
        const c0 = strips;
        const cs = [[-sx / 2, -sz / 2], [sx / 2, -sz / 2], [-sx / 2, sz / 2], [sx / 2, sz / 2]];
        for (let i = 0; i < 4; i++) {
          posArr[(c0 + i) * 3] = cs[i][0];
          posArr[(c0 + i) * 3 + 1] = yBot;
          posArr[(c0 + i) * 3 + 2] = cs[i][1];
          uvArr[(c0 + i) * 2] = cs[i][0] / 4;
          uvArr[(c0 + i) * 2 + 1] = cs[i][1] / 4;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.uv.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    };
    update(hts);
    const texs = tr.texs || ['sand', 'rock', 'grass', 'dirt'];
    const wt = (SKY.GFX && SKY.GFX.texture)
      ? (SKY.GFX.texture(texs[1] || texs[0], 1) || SKY.GFX.texture(texs[0], 1)) : null;
    const mat = wt
      ? new THREE.MeshLambertMaterial({ map: wt, side: THREE.DoubleSide,
          color: 0xcfcfcf })
      : new THREE.MeshLambertMaterial({ color: 0x8a7f6e, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = mesh.castShadow = true;
    mesh.frustumCulled = false;
    return { mesh, update };
  }

  function buildTerrain(tr) {
    const segs = SKY.U.clamp(Math.round(tr.segs || 48), 8, 128);
    const sx = Math.max(4, tr.sx !== undefined ? tr.sx : (tr.size || 60));
    const sz = Math.max(4, tr.sz !== undefined ? tr.sz : (tr.size || 60));
    const n = (segs + 1) * (segs + 1);
    const heights = SKY.MapData.decodeHeights(tr.h, n);
    const splat = SKY.MapData.decodeSplat(tr.splat, n);
    const geo = new THREE.PlaneGeometry(sx, sz, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.array[i * 3 + 1] = heights[i];
    geo.computeVertexNormals();
    geo.setAttribute('asplat', new THREE.BufferAttribute(splat, 4, true));
    const mesh = new THREE.Mesh(geo, terrainMaterial(tr));
    mesh.position.set(tr.p[0], tr.p[1], tr.p[2]);
    mesh.receiveShadow = true;
    group.add(mesh);
    // sculpt-following side walls (+ bottom cap and body collision when the
    // terrain came from a converted block)
    const sides = buildTerrainSides(tr, heights, segs, sx, sz);
    sides.mesh.position.set(tr.p[0], tr.p[1], tr.p[2]);
    group.add(sides.mesh);
    if (tr.base && tr.base > 0.05) {
      SKY.World.addSolid({ x: tr.p[0], y: tr.p[1] - tr.base / 2, z: tr.p[2],
        sx, sy: tr.base, sz });
    }
    SKY.World.addTerrain({ x: tr.p[0], z: tr.p[2], sx, sz, segs, heights, y: tr.p[1], mesh });
    return mesh;
  }

  function buildCustomMap(def) {
    const D = SKY.MapData;
    lightMul = def.light !== undefined ? def.light : 1;
    SKY.World.killY = def.killY;
    SKY.World.crownHome = new THREE.Vector3(def.crown[0], def.crown[1], def.crown[2]);
    const M = D.MOODS[def.mood];
    const LM = def.light !== undefined ? def.light : 1;   // global light dial
    mood({
      sunColor: M.sun[0], sunInt: M.sun[1] * LM, sunPos: new THREE.Vector3(...M.sun[2]),
      hemiSky: M.hemi[0], hemiGround: M.hemi[1], hemiInt: M.hemi[2] * LM,
      fillColor: M.fill[0], fillInt: (M.fill[1] || 0.3) * LM,
      fillPos: M.fill[2] ? new THREE.Vector3(...M.fill[2]) : undefined,
      // def.shafts: undefined/null = mood default, false = creator turned
      // the global sky godrays off, true = force them on
      shafts: (def.shafts === undefined || def.shafts === null) ? !!M.shafts : !!def.shafts,
      disc: M.disc || null,
      discSize: M.discSize, discColor: M.discColor,
    });
    // fully custom sky (colors/stars/clouds) beats the preset when present
    const fogged = !!def.fog;
    if (def.skyc) {
      skyDome(def.skyc.top, def.skyc.mid, def.skyc.hor, !!def.skyc.stars, fogged);
      if (def.skyc.clouds) {
        cloudField(-10, 18, new THREE.Color(def.skyc.cloudCol || '#ffffff').getHex(), 0.45,
          def.skyc.cloudN !== undefined ? def.skyc.cloudN : 10);
      }
    } else {
      const S = D.SKIES[def.sky];
      skyDome(S[0], S[1], S[2], S[3], fogged);
      if (M.clouds) cloudField(-10, 18, new THREE.Color(M.clouds).getHex(), 0.45);
    }
    if (def.fog) {
      // creator's global fog override (color + explicit near/far range)
      scene.fog = new THREE.Fog(new THREE.Color(def.fog.color).getHex(),
        def.fog.near !== undefined ? def.fog.near : 30,
        def.fog.far !== undefined ? def.fog.far : 150);
    } else {
      // default distance fog now MATCHES THE SKY: color derives from the
      // active sky's horizon (custom or preset) — a sunset sky used to get
      // the mood's blue haze, which read completely wrong
      const S2 = def.skyc ? [def.skyc.top, def.skyc.mid, def.skyc.hor]
        : D.SKIES[def.sky];
      const fc = new THREE.Color(S2[2]).lerp(new THREE.Color(S2[1]), 0.3);
      scene.fog = new THREE.Fog(fc.getHex(), M.fog[1], M.fog[2]);
    }

    // terrains FIRST: the sea's per-vertex depth measurement needs them
    for (const tr of def.terrains || []) buildTerrain(tr);
    for (const b of def.blocks) {
      plat(b.p[0], b.p[1], b.p[2], b.s[0], b.s[1], b.s[2], {
        material: customBlockMaterial(b),
        shape: b.shape || 'box',
        rotX: b.r[0], rotY: b.r[1], rotZ: b.r[2],
        crumble: !!b.crumble,
        path: moverPath(b),
        tag: b.mover ? 'mover' : '',
      });
    }
    for (const pd of def.pads) {
      jumpPad(pd.p[0], pd.p[1], pd.p[2],
        new THREE.Vector3(pd.launch[0], pd.launch[1], pd.launch[2]));
    }
    for (const s of def.spawns) {
      SKY.World.spawnPoints.push({ pos: new THREE.Vector3(s.p[0], s.p[1], s.p[2]), yaw: s.yaw || 0 });
    }
    for (const it of def.items) {
      // spawner config rides on the vector itself — sparks.js and older
      // consumers keep treating these as plain positions
      const v = new THREE.Vector3(it.p[0], it.p[1], it.p[2]);
      v.item = it.item || '';                                     // '' = random roll
      v.respawn = typeof it.respawn === 'number' ? it.respawn : 0; // 0 = default
      v.mix = it.mix || null;             // weighted rarity pool ('mix' items)
      SKY.World.itemPoints.push(v);
    }
    // 3D asset props — embedded GLB payloads, or built-in pack props
    // referenced as 'gfx:<name>' (shipped with the game, nothing embedded)
    let doorSeq = 0;
    for (const pr of def.props || []) {
      const a = pr.asset || '';
      const isPack = a.startsWith('gfx:') || a.startsWith('fx:');
      const embed = (def.assets || {})[pr.asset];
      if ((!embed && !isPack) || !SKY.Assets) continue;
      // door index is decided in def.props order so every peer agrees on
      // it even though the instantiate callbacks land asynchronously
      const nm = ((embed && embed.name) ? String(embed.name) : a).toLowerCase();
      const isDoor = pr.door !== undefined ? !!pr.door : /door-rotate/.test(nm);
      const doorIdx = isDoor ? doorSeq++ : -1;
      // SEA EVENTS: invisible markers -> deterministic clock-driven shows
      if (a === 'fx:tsunami' || a === 'fx:triangle' || a === 'fx:kraken' || a === 'fx:shark') {
        registerSeaEvent(a.slice(3), pr);
      }
      // WATER: register the swim volume — pawn physics (swim/buoyancy) and
      // the underwater screen/audio treatment key off it. All the dials ride
      // in pr.fx so every sea can feel different.
      if (a === 'fx:sea') {
        const sf = { ...(SKY.Assets ? SKY.Assets.fxDefaults('fx:sea') : {}), ...(pr.fx || {}) };
        const half = (Math.max(20, sf.size) / 2) * (pr.scale || 1);
        // CURRENTS: seeded jets — deterministic from the sea's position so
        // every peer builds the same danger map. ~70% shove down/sideways
        // (the killers), ~30% RISE (the escape routes, brighter particles).
        const nCur = Math.max(0, Math.round(
          sf.currents !== undefined ? sf.currents : half / 5));
        const currents = [];
        let cs = (Math.imul((pr.p[0] * 73 + pr.p[2] * 179 + 1) | 0, 2654435761) | 0) || 1;
        const crnd = () => {
          cs |= 0; cs = (cs + 0x6D2B79F5) | 0;
          let t = Math.imul(cs ^ (cs >>> 15), 1 | cs);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let ci = 0; ci < nCur; ci++) {
          const cx = pr.p[0] + (crnd() * 2 - 1) * half * 0.85;
          const cz = pr.p[2] + (crnd() * 2 - 1) * half * 0.85;
          const fl = SKY.World.terrainHeight(cx, cz);
          const floor = isFinite(fl) ? fl : pr.p[1] - 30;
          const range = pr.p[1] - floor;
          if (range < 4) { continue; }              // too shallow for a jet
          const cy = floor + 1.5 + crnd() * (range - 3);
          const rising = crnd() < 0.3;
          const ang = crnd() * Math.PI * 2;
          const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
          if (rising) { dir.multiplyScalar(0.35); dir.y = 1; }
          else dir.y = -(0.35 + crnd() * 0.75);
          dir.normalize();
          currents.push({ x: cx, y: cy, z: cz, r: 3 + crnd() * 3, dir,
            pow: (sf.currentPower !== undefined ? sf.currentPower : 26) * (0.75 + crnd() * 0.5),
            rising });
        }
        SKY.World.addWater({
          x: pr.p[0], z: pr.p[2], half, level: pr.p[1],
          amp: Math.max(0.01, sf.power || 0.5),
          kw: (Math.PI * 2) / Math.max(4, sf.range || 18),
          currents: currents.length ? currents : null,
          opts: sf,
        });
        // current visuals: directed particle streams so jets READ underwater
        if (currents.length && SKY.Effects.stream) {
          let acc = 0;
          tickers.push((dt) => {
            acc += dt;
            if (acc < 0.06) return;
            acc = 0;
            const cam = SKY.Game && SKY.Game.player ? SKY.Game.player.pos : null;
            for (const c of currents) {
              if (cam && Math.abs(cam.x - c.x) + Math.abs(cam.z - c.z) > 90) continue;
              if (Math.random() > 0.5) continue;
              _v.set(c.x + SKY.U.rand(-c.r, c.r) * 0.6,
                     c.y + SKY.U.rand(-c.r, c.r) * 0.6,
                     c.z + SKY.U.rand(-c.r, c.r) * 0.6);
              SKY.Effects.stream(_v, c.dir, 5 + Math.random() * 4,
                c.rising ? '#bfe9ff' : '#1e4258');
            }
          });
        }
      }
      // AIR VENT: register the updraft column (pawn.tick applies the lift —
      // deterministic from the def, so every peer simulates it identically)
      if (a === 'fx:airvent') {
        const vf = pr.fx || {};
        const vx = pr.p[0], vy = pr.p[1] + 1.2, vz = pr.p[2];
        const vr = 1.35 * (pr.scale || 1);
        SKY.World.vents.push({
          x: vx, y: vy, z: vz, radius: vr,
          height: vf.range !== undefined ? vf.range : 10,
          force: vf.power !== undefined ? vf.power : 40,
        });
        // rising dust so the updraft reads at a glance
        let acc = 0;
        tickers.push((dt) => {
          acc += dt;
          if (acc < 0.13) return;
          acc = 0;
          const ang = Math.random() * Math.PI * 2, rr = Math.random() * vr * 0.8;
          _v.set(vx + Math.cos(ang) * rr, vy + 0.1, vz + Math.sin(ang) * rr);
          SKY.Effects.burst(_v, { count: 1, speed: 1.4, color: '#dfe9f4',
            gravity: -26, life: 0.7, size: 0.5 });
        });
      }
      const g = group;
      SKY.Assets.instantiate(isPack ? pr.asset : embed, (obj) => {
        if (!obj || group !== g) return;   // map changed while parsing
        // light-entity gizmo markers are editor-only — REMOVE them so they
        // don't inflate the collision bbox (the vent's column marker would)
        const edm = [];
        obj.traverse((c) => { if (c.name === 'edmarker') edm.push(c); });
        for (const m of edm) m.parent.remove(m);
        const rot = pr.r || [0, 0, 0];
        obj.position.set(pr.p[0], pr.p[1], pr.p[2]);
        obj.scale.setScalar(pr.scale || 1);
        group.add(obj);
        // collision as a ROTATED OBB: measure the box in the prop's local
        // frame (pre-rotation), then rotate the offset + pass the euler
        obj.rotation.set(0, 0, 0);
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        const c = box.getCenter(new THREE.Vector3());
        const s = box.getSize(new THREE.Vector3());
        const okBox = isFinite(s.x) && s.x > 0.2 && s.y > 0.05 && s.z > 0.2;
        const wantSolid = pr.solid !== false;
        // everything that needs the UNROTATED pose happens here: find the
        // swinging panel, measure its slab + hinge, carve wall openings
        const panel = doorIdx >= 0 ? obj.getObjectByName('door') : null;
        let panelBox = null, hinge = null;
        if (panel) {
          panelBox = new THREE.Box3().setFromObject(panel);
          if (panelBox.isEmpty()) panelBox = null;
          else hinge = panel.getWorldPosition(new THREE.Vector3());
        }
        const collMode = pr.coll || 'box';
        let carved = null;
        if (okBox && wantSolid) {
          if (doorIdx >= 0) { if (panel) carved = carveOpenings(obj, box, panel); }
          else if (collMode !== 'mesh' && /door|arch|gate/.test(nm)) carved = carveOpenings(obj, box, null);
        }
        obj.rotation.set(rot[0], rot[1], rot[2]);
        obj.updateMatrixWorld(true);
        // world-transform-dependent setup (the sea measures seabed depth
        // under each vertex) — delayed so sibling props' solids exist too
        if (obj.userData && obj.userData.postPlace) {
          setTimeout(() => { if (group === g) obj.userData.postPlace(obj); }, 120);
        }
        // pre-rotation box -> rotated OBB opts (offset spun by the prop's quat)
        const toSolid = (bc, bs) => {
          const lc = bc.clone().sub(obj.position);
          lc.applyQuaternion(obj.quaternion).add(obj.position);
          return { x: lc.x, y: lc.y, z: lc.z, sx: bs.x, sy: bs.y, sz: bs.z,
                   rotX: rot[0], rotY: rot[1], rotZ: rot[2] };
        };
        const solidOpts = okBox ? toSolid(c, s) : null;
        if (doorIdx >= 0 && okBox) {
          // interactable door: static frame (carved jambs/lintel) + a slab
          // for the swinging panel that follows its open/closed pose
          if (carved) for (const b of carved) SKY.World.addSolid(toSolid(b.c, b.s));
          let closedOpts = solidOpts, openOpts = null;
          if (panelBox) {
            const pc = panelBox.getCenter(new THREE.Vector3());
            const ps = panelBox.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.12, 0.12, 0.12));
            closedOpts = toSolid(pc, ps);
            // open pose: swing the slab around the panel's hinge. Only for
            // upright props — yaw composes cleanly, arbitrary tilts don't.
            if (Math.abs(rot[0]) < 0.01 && Math.abs(rot[2]) < 0.01) {
              const swing = 1.85;   // matches the visual in Map.tick
              const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, swing, 0));
              const oc = pc.clone().sub(hinge).applyQuaternion(q).add(hinge);
              const lo = oc.clone().sub(obj.position);
              lo.applyQuaternion(obj.quaternion).add(obj.position);
              openOpts = { x: lo.x, y: lo.y, z: lo.z, sx: ps.x, sy: ps.y, sz: ps.z,
                           rotX: 0, rotY: rot[1] + swing, rotZ: 0 };
            }
          }
          doors[doorIdx] = {
            panel: panel || obj, baseY: (panel || obj).rotation.y, open: false, anim: 0,
            pos: new THREE.Vector3(pr.p[0], pr.p[1] + 1, pr.p[2]),
            closedOpts, openOpts, wantSolid,
            solid: wantSolid && closedOpts ? SKY.World.addSolid(closedOpts) : null,
          };
        } else if (wantSolid && okBox) {
          if (collMode === 'custom' && Array.isArray(pr.boxes) && pr.boxes.length) {
            // hand-authored collider boxes (editor 'custom' mode) — stored in
            // the prop's LOCAL unscaled frame, composed with its transform
            const sc = pr.scale || 1;
            for (const b of pr.boxes) {
              const br = b.r || [0, 0, 0];
              const q = obj.quaternion.clone().multiply(new THREE.Quaternion()
                .setFromEuler(new THREE.Euler(br[0], br[1], br[2])));
              const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
              const lc = new THREE.Vector3(b.p[0], b.p[1], b.p[2]).multiplyScalar(sc)
                .applyQuaternion(obj.quaternion).add(obj.position);
              SKY.World.addSolid({ x: lc.x, y: lc.y, z: lc.z,
                sx: Math.max(0.05, b.s[0]) * sc, sy: Math.max(0.05, b.s[1]) * sc,
                sz: Math.max(0.05, b.s[2]) * sc,
                rotX: e.x, rotY: e.y, rotZ: e.z });
            }
          } else if (collMode === 'mesh') {
            // mesh-fit: voxelized boxes in local frame -> scaled/rotated OBBs
            const sc = pr.scale || 1;
            const boxes = propCollisionLocal(obj, 'mesh');
            for (const b of boxes) {
              const lc = b.c.clone().multiplyScalar(sc)
                .applyQuaternion(obj.quaternion).add(obj.position);
              SKY.World.addSolid({ x: lc.x, y: lc.y, z: lc.z,
                sx: b.s.x * sc, sy: b.s.y * sc, sz: b.s.z * sc,
                rotX: rot[0], rotY: rot[1], rotZ: rot[2] });
            }
            if (!boxes.length) SKY.World.addSolid(solidOpts);
          } else if (/stairs/.test(nm)) addStairRamp(obj, c, s);
          else if (carved) for (const b of carved) SKY.World.addSolid(toSolid(b.c, b.s));
          else SKY.World.addSolid(solidOpts);
        }
      }, pr.fx);
    }
    // bots: auto roam/anchor points — big static block tops + spawns
    for (const b of def.blocks) {
      if (b.mover || b.s[0] * b.s[2] < 9) continue;
      const top = b.p[1] + b.s[1] / 2;
      roam(b.p[0], top + 0.1, b.p[2]);
      anchor(b.p[0], top - 0.2, b.p[2]);
      if (SKY.World.roamPoints.length > 26) break;
    }
    for (const s of def.spawns) roam(s.p[0], s.p[1], s.p[2]);
    eventCfg = null;
  }

  let lightMul = 1;    // creator light dial — underwater darkness reads it

  /* ====================== lifecycle ====================== */
  function load(sc, id) {
    scene = sc;
    lightMul = 1;
    if (group) scene.remove(group);
    group = new THREE.Group();
    scene.add(group);
    skyGroup = new THREE.Group();
    group.add(skyGroup);
    decor.length = 0; clouds.length = 0; crumbleList.length = 0;
    tickers.length = 0; fallingMeshes.length = 0; shaking = null;
    overtime = false; dirty = false;
    starLayer = null; meteor = null; meteorT = 6;
    doors.length = 0;
    eventCfg = null; eventT = SKY.U.rand(8, 14);
    SKY.World.reset();
    SKY.World.rideSolids = [];
    scene.background = null;   // sky domes handle the backdrop
    const custom = SKY.MapData && SKY.MapData.get(id);
    if (custom) {
      currentId = id;
      buildCustomMap(custom);
      return;
    }
    currentId = MAPS[id] ? id : 'sky';
    ({ sky: buildSky, convoy: buildConvoy, foundry: buildFoundry,
       rooftop: buildRooftop, temple: buildTemple,
       yacht: buildYacht, terminal: buildTerminal })[currentId]();
  }

  /* the editor takes the stage over: remove the current map entirely */
  function unload() {
    if (group && scene) scene.remove(group);
    group = null;
    scene && (scene.fog = null);
    SKY.World.reset();
  }

  function startOvertime() {
    overtime = true;
    if (currentId === 'sky') crumbleTimer = 1.5;
  }

  function resetRound() {
    overtime = false;
    eventT = SKY.U.rand(8, 14);
    if (dirty) load(scene, currentId);
  }

  function overtimeMsg() {
    return (MAPS[currentId] || { overtimeMsg: 'the arena is getting angry!' }).overtimeMsg;
  }

  /* display name for both built-in and custom maps */
  function displayName(id) {
    if (MAPS[id]) return MAPS[id].name;
    const c = SKY.MapData && SKY.MapData.get(id);
    return c ? c.name : id;
  }

  function tick(dt, time) {
    for (const c of clouds) {
      c.a += c.speed * dt * 0.02;
      c.mesh.position.x = Math.cos(c.a) * c.r;
      c.mesh.position.z = Math.sin(c.a) * c.r;
    }
    // door panels swing smoothly toward their open/closed pose
    for (const d of doors) {
      if (!d) continue;
      const target = d.open ? 1.85 : 0;
      if (Math.abs(target - d.anim) > 0.002) {
        d.anim += (target - d.anim) * Math.min(1, dt * 7);
        d.panel.rotation.y = d.baseY + d.anim;
      }
    }
    // night sky life: the bright-star layer twinkles, meteors streak by
    if (starLayer) {
      starLayer.material.opacity = 0.75 + Math.sin(time * 1.7) * 0.14 + Math.sin(time * 4.3) * 0.08;
      starLayer.rotation.y += dt * 0.002;
      meteorT -= dt;
      if (meteorT <= 0 && !meteor) {
        const a = Math.random() * Math.PI * 2;
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: SKY.U.blobTexture(), color: '#e8f2ff', transparent: true,
          opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }));
        s.scale.set(14, 2.2, 1);
        s.material.rotation = SKY.U.rand(-0.7, -0.3);
        s.frustumCulled = false;
        group.add(s);
        meteor = {
          mesh: s, t: 0,
          from: new THREE.Vector3(Math.cos(a) * 300, SKY.U.rand(160, 240), Math.sin(a) * 300),
          dir: new THREE.Vector3(Math.cos(a + 2.4), -0.55, Math.sin(a + 2.4)).normalize(),
        };
      }
      if (meteor) {
        meteor.t += dt;
        const k = meteor.t / 1.1;
        meteor.mesh.position.copy(meteor.from).addScaledVector(meteor.dir, k * 260);
        meteor.mesh.material.opacity = 0.9 * (1 - k) * Math.min(1, k * 6);
        if (k >= 1) {
          group.remove(meteor.mesh);
          meteor = null;
          meteorT = SKY.U.rand(4, 11);
        }
      }
    }
    for (const d of decor) {
      if (d.spin) { d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt; }
      if (d.pulse !== undefined) {
        d.pulse += dt * 4;
        d.mesh.material.emissiveIntensity = 0.5 + Math.sin(d.pulse) * 0.25;
      }
    }
    for (const fn of tickers) fn(dt, time);

    // scheduled map event — only the authority rolls the dice; in online
    // games the host broadcasts the params so everyone sees the same event
    if (eventCfg && SKY.Game.state === 'playing' &&
        (!SKY.Net || !SKY.Net.online || SKY.Net.role === 'host')) {
      eventT -= dt;
      if (eventT <= 0) {
        const params = eventCfg.pick();
        if (params) {
          eventCfg.exec(params);
          if (SKY.Net && SKY.Net.online) SKY.Net.sendMapEvent(params);
        }
        eventT = SKY.U.rand(eventCfg.min, eventCfg.max) * (overtime ? 0.5 : 1);
      }
    }

    // sky arena overtime crumble
    if (overtime && currentId === 'sky') {
      if (shaking) {
        shaking.t -= dt;
        shaking.mesh.position.set(
          shaking.basePos.x + SKY.U.rand(-0.07, 0.07),
          shaking.basePos.y + SKY.U.rand(-0.05, 0.05),
          shaking.basePos.z + SKY.U.rand(-0.07, 0.07));
        if (shaking.t <= 0) {
          SKY.World.removeSolid(shaking.solid);
          shaking.mesh.position.copy(shaking.basePos);
          fallingMeshes.push({ mesh: shaking.mesh, vy: 0 });
          dirty = true;
          shaking = null;
          crumbleTimer = 4;
        }
      } else if (crumbleList.length) {
        crumbleTimer -= dt;
        if (crumbleTimer <= 0) {
          const next = crumbleList.shift();
          next.mesh.matrixAutoUpdate = true;   // it's about to move every frame
          shaking = { mesh: next.mesh, solid: next.solid, t: 1.4, basePos: next.mesh.position.clone() };
        }
      }
    }
    for (let i = fallingMeshes.length - 1; i >= 0; i--) {
      const f = fallingMeshes[i];
      f.vy += 18 * dt;
      f.mesh.position.y -= f.vy * dt;
      f.mesh.rotation.x += dt * 0.4;
      if (f.mesh.position.y < SKY.World.killY - 15) {
        group.remove(f.mesh);
        fallingMeshes.splice(i, 1);
      }
    }
  }

  /* keep the sky centered on the viewer — call once per rendered frame */
  function skyFollow(camPos) {
    if (skyGroup) skyGroup.position.copy(camPos);
  }

  return { MAPS, load, unload, tick, startOvertime, resetRound, overtimeMsg, displayName,
           setDoor, tryInteract, propCollisionLocal, skyFollow, terrainMaterial,
           buildTerrainSides,
           lightMul() { return lightMul; },
           execEvent(params) { if (eventCfg) eventCfg.exec(params); },
           get currentId() { return currentId; },
           get rootGroup() { return group; } };
})();
