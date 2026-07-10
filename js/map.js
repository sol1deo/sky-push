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
  const _matCache = {};   // shared materials — fewer GL programs/binds
  function mat(colorHex, repeat) {
    const key = 'c' + colorHex[0] + colorHex[1] + (repeat || 4);
    if (_matCache[key]) return _matCache[key];
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
    m.map = SKY.U.checkerTexture(colorHex[0], colorHex[1], repeat || 4);
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
      new THREE.BoxGeometry(sx, sy, sz),
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
    return { hemi, sun };
  }

  /* gradient sky dome (+ optional stars) */
  function skyDome(top, mid, horizon, stars) {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 256;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, top); gr.addColorStop(0.55, mid); gr.addColorStop(1, horizon);
    g.fillStyle = gr; g.fillRect(0, 0, 32, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(380, 24, 14),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })
    );
    group.add(dome);
    if (stars) {
      const sc = document.createElement('canvas');
      sc.width = sc.height = 512;
      const sg = sc.getContext('2d');
      for (let i = 0; i < 240; i++) {
        sg.fillStyle = `rgba(255,255,255,${SKY.U.rand(0.3, 1)})`;
        sg.fillRect(Math.random() * 512, Math.random() * 320, SKY.U.rand(1, 2.4), SKY.U.rand(1, 2.4));
      }
      const st = new THREE.CanvasTexture(sc);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(370, 24, 14),
        new THREE.MeshBasicMaterial({ map: st, side: THREE.BackSide, transparent: true, fog: false })
      );
      group.add(sphere);
    }
  }

  function cloudField(y0, y1, color, opacity) {
    const cloudTex = SKY.U.blobTexture();
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, color: color || 0xffffff, transparent: true,
        opacity: opacity || 0.4, depthWrite: false,
      }));
      const r = SKY.U.rand(45, 90), a = Math.random() * Math.PI * 2;
      s.position.set(Math.cos(a) * r, SKY.U.rand(y0, y1), Math.sin(a) * r);
      const sc = SKY.U.rand(14, 30);
      s.scale.set(sc, sc * 0.45, 1);
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
   * MAP 7: TERMINAL — big cargo-port arena built for BOMB mode
   * (also playable in party modes). Two sites, a catwalk spine,
   * container cover, and open edges everywhere.
   * ============================================================ */
  function buildTerminal() {
    SKY.World.killY = -14;
    SKY.World.crownHome = new THREE.Vector3(0, 4.7, 0);
    mood({
      sunColor: 0xffe8c0, sunInt: 1.5, sunPos: new THREE.Vector3(35, 50, 20),
      hemiSky: 0xc4d4ec, hemiGround: 0x5e6470, hemiInt: 0.55,
      fillColor: 0x9ab4e8, fillInt: 0.3,
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
    jumpPad(-22, 0, 8, new THREE.Vector3(4, 15, -4), 0xe8c85a);
    jumpPad(22, 0, -8, new THREE.Vector3(-4, 15, 4), 0xe8c85a);

    // bomb sites + spawns
    SKY.World.bombSites = [
      { name: 'A', pos: new THREE.Vector3(-26, 1.3, -8), r: 4 },
      { name: 'B', pos: new THREE.Vector3(26, 0.3, 6), r: 4 },
    ];
    for (const site of SKY.World.bombSites) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(site.r - 0.35, site.r, 28),
        new THREE.MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(site.pos).y += 0.06;
      group.add(ring);
      const label = SKY.U.makeTextSprite(site.name, { color: '#ffc040', px: 64, scale: 0.02 });
      label.position.set(site.pos.x, site.pos.y + 3, site.pos.z);
      group.add(label);
    }
    for (let i = 0; i < 6; i++) {
      SKY.World.teamSpawns.atk.push({ pos: new THREE.Vector3(-5 + i * 2, 0.1, 28), yaw: Math.PI });
      SKY.World.teamSpawns.def.push({ pos: new THREE.Vector3(-5 + i * 2, 0.1, -28), yaw: 0 });
      const a = (i / 6) * Math.PI * 2;
      spawnPt(Math.cos(a) * 9, 0.1, Math.sin(a) * 9);   // party-mode spawns
    }
    [[0, 0, 0], [-26, 1.3, -8], [26, 0.3, 6], [0, 4.1, 0], [0, 0, 24], [0, 0, -24],
     [-26, 0, 4], [26, 0, -4], [-14, 0, -12], [14, 0, 12]]
      .forEach(p => roam(p[0], p[1], p[2]));
    [[0, 3.7, 0], [-26, 1, -8], [26, 0.2, 6], [-1.5, 6.2, 0], [0, -0.3, 26], [0, -0.3, -26]]
      .forEach(p => anchor(p[0], p[1], p[2]));

    eventCfg = null;   // no random events on the competitive map
  }

  /* ====================== lifecycle ====================== */
  function load(sc, id) {
    scene = sc;
    if (group) scene.remove(group);
    group = new THREE.Group();
    scene.add(group);
    decor.length = 0; clouds.length = 0; crumbleList.length = 0;
    tickers.length = 0; fallingMeshes.length = 0; shaking = null;
    overtime = false; dirty = false;
    eventCfg = null; eventT = SKY.U.rand(8, 14);
    SKY.World.reset();
    SKY.World.rideSolids = [];
    currentId = MAPS[id] ? id : 'sky';
    scene.background = null;   // sky domes handle the backdrop
    ({ sky: buildSky, convoy: buildConvoy, foundry: buildFoundry,
       rooftop: buildRooftop, temple: buildTemple,
       yacht: buildYacht, terminal: buildTerminal })[currentId]();
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

  function overtimeMsg() { return MAPS[currentId].overtimeMsg; }

  function tick(dt, time) {
    for (const c of clouds) {
      c.a += c.speed * dt * 0.02;
      c.mesh.position.x = Math.cos(c.a) * c.r;
      c.mesh.position.z = Math.sin(c.a) * c.r;
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

  return { MAPS, load, tick, startOvertime, resetRound, overtimeMsg,
           execEvent(params) { if (eventCfg) eventCfg.exec(params); },
           get currentId() { return currentId; } };
})();
