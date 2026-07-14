/* =============================================================================
 * SKY PUSH — REPLAY / MATCH EDITOR (v2 of the clip-farm dream)
 * The 120 Hz fixed tick + cmd-driven pawns were always meant as recording
 * hooks — this is the first payoff.
 *
 * RECORDER  — during play, a ring buffer keeps the last ~30s:
 *   - 60 Hz snapshots of every pawn (transform, anim state, weapon, and the
 *     11 ragdoll particles whenever the verlet puppet is active)
 *   - every visual effect call (SKY.Effects.* is wrapped at init) and every
 *     bullet spawn, timestamped for re-firing
 * PLAYBACK  — the live sim freezes; "ghost" avatars (same Characters rig)
 *   are posed from interpolated snapshots. Cameras: FREE fly, POV of any
 *   player (with viewmodel + optional crosshair), ORBIT around them, or KEYS —
 *   camera keyframes interpolated Rockstar-editor style during playback.
 * EDITING   — cursor always visible, HOLD LMB to look. Timeline zooms (wheel
 *   over it), keyframes are clickable/drag-able/deletable/overridable.
 * DoF       — optional depth of field (SKY.DoF): auto-focus on the selected
 *   player, or manual focus; both recorded into camera keyframes.
 * ARCHIVE   — finished rounds are archived by SKY.Demos and can be re-opened
 *   from the menu's MATCHES tab via openArchive().
 * Open with V (rebindable). Offline matches only for now.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Replay = (function () {
  const HZ = 30;                 // snapshot rate — full MATCHES are recorded now,
                                 // 30 Hz + playback interpolation keeps memory sane
  // recording continues through the live round-end phase (arena stays hot)
  function recordable() {
    const st = SKY.Game.state;
    return st === 'playing' || st === 'roundend';
  }
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _qa = new THREE.Quaternion();
  const _qb = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');

  let scene = null, camera = null;
  let WK = null;                 // weapon kind list (index <-> id)

  /* ========================= recorder ========================= */
  let frames = [];               // { t, pw:[per-pawn snapshot] }
  let events = [];               // { t, fn, a } effect calls + '__bullet'
  let marks = [];                // { t, label } round starts on the timeline
  let roster = null;             // [{ name, color }] captured with the frames
  let recAcc = 0;
  let fxOrig = null;             // unwrapped SKY.Effects functions

  const FX = ['burst', 'ring', 'hitBurst', 'headshotBurst', 'impactSpark',
              'koBurst', 'muzzle', 'muzzleLight', 'cannonBlast', 'padRing',
              'respawnBeam', 'trailPuff', 'floatText', 'bulletHole', 'flame', 'swirl',
              'flameJet', 'flamePuff'];

  function serArg(a) {
    if (a && a.isVector3) return { v: [a.x, a.y, a.z] };
    if (a && typeof a === 'object') {
      const o = {};
      for (const k in a) if (a[k] === null || typeof a[k] !== 'object') o[k] = a[k];
      return { o };
    }
    return a;
  }
  function deserArg(a) {
    if (a && a.v) return new THREE.Vector3(a.v[0], a.v[1], a.v[2]);
    if (a && a.o) return a.o;
    return a;
  }

  function hookFx() {
    if (fxOrig) return;
    fxOrig = {};
    for (const name of FX) {
      const orig = SKY.Effects[name];
      fxOrig[name] = orig;
      SKY.Effects[name] = function (...args) {
        if (!api.active && recordable()) {
          events.push({ t: SKY.Game.time, fn: name, a: args.map(serArg) });
        }
        return orig(...args);
      };
    }
  }

  function wipe() {
    frames.length = 0;
    events.length = 0;
    marks.length = 0;
    roster = null;
    recAcc = 0;
  }

  /* called from Game.tick while the arena is live (after visualTick) */
  function record(dt) {
    if (api.active || !recordable()) return;
    recAcc += dt;
    if (recAcc < 1 / HZ - 1e-6) return;
    recAcc = 0;
    if (!WK) WK = Object.keys(SKY.TUNING.weapons);
    const G = SKY.Game;
    if (!roster || roster.length !== G.pawns.length) {
      frames.length = 0; events.length = 0;
      // cos rides along so ghosts wear the right character/skin/outfit
      roster = G.pawns.map(p => ({ name: p.name, color: p.color, cos: p.cos || null }));
    }
    const fr = { t: G.time, pw: [] };
    for (const p of G.pawns) {
      let f = 0;
      if (p.alive) f |= 1;
      if (p.grounded) f |= 2;
      if (p.sliding) f |= 4;
      if (p.fellScreamed) f |= 8;
      if (p.tauntT > 0) f |= 16;
      if (p.inWater || p._netSwim) f |= 32;   // swim pose for playback ghosts
      const g = p.grapple;
      const d = {
        p: [p.pos.x, p.pos.y, p.pos.z],
        v: [p.vel.x, p.vel.y, p.vel.z],
        yaw: p.yaw, pit: p.pitch, h: p.height, e: p.eyeHeight,
        w: p.weapon ? Math.max(0, WK.indexOf(p.weapon)) : 255, f,   // 255 = bare hands
        am: p.ammo,                    // POV HUD ammo readout
        // grapple rope (attach point + slack length) so playback draws hooks
        gp: g && g.point ? [+g.point.x.toFixed(2), +g.point.y.toFixed(2),
                            +g.point.z.toFixed(2), +(g.len || 0).toFixed(1)] : null,
        tv: p.tumbleVel.lengthSq() > 0.01
          ? [p.tumbleVel.x, p.tumbleVel.y, p.tumbleVel.z] : null,
        rag: null,
      };
      const av = p.avatar;
      if (av && av.ragActive) {
        const r = new Float32Array(33);
        for (let i = 0; i < 11; i++) {
          r[i * 3] = av.pts[i].x; r[i * 3 + 1] = av.pts[i].y; r[i * 3 + 2] = av.pts[i].z;
        }
        d.rag = r;
      }
      fr.pw.push(d);
    }
    // moving platforms (trucks, elevators, the chase boat) — so the map
    // actually moves during playback instead of freezing
    const movers = SKY.World.movers;
    if (movers.length) {
      const mv = new Float32Array(movers.length * 3);
      for (let i = 0; i < movers.length; i++) {
        mv[i * 3] = movers[i].c.x; mv[i * 3 + 1] = movers[i].c.y; mv[i * 3 + 2] = movers[i].c.z;
      }
      fr.mv = mv;
    }
    frames.push(fr);
    const cutoff = G.time - SKY.TUNING.replay.seconds;
    while (frames.length && frames[0].t < cutoff) frames.shift();
    while (events.length && events[0].t < cutoff) events.shift();
    while (marks.length && marks[0].t < cutoff) marks.shift();
  }

  /* bullet spawns can't be caught via Effects — weapons.js calls this */
  function bullet(pos, vel, gravity, life) {
    if (api.active || !recordable()) return;
    events.push({
      t: SKY.Game.time, fn: '__bullet',
      p: [pos.x, pos.y, pos.z], v: [vel.x, vel.y, vel.z], g: gravity, l: life,
    });
  }

  /* ========================= playback ========================= */
  let T = 0, playing = false, speed = 1;
  let camMode = 'free', sel = 0;
  let ghosts = [], kf = [], gb = [];
  let cur = 0, evi = 0;
  let fcPos = new THREE.Vector3();
  let freeFov = 80, orbitDist = 6;
  let savedYaw = 0, savedPitch = 0;
  let scrubbing = false;
  let ui = null;
  let archived = null;           // demo record being viewed from the menu
  let selKf = -1, dragObj = null;
  let viewStart = 0, viewEnd = 1;  // timeline zoom window (seconds)
  let pathDriven = false;          // camera was on the key path last frame
  let holdLook = false;            // LMB held = mouse captured for looking
  let crossOn = false;             // POV crosshair
  let namesOn = true;              // player nickname sprites
  let povHud = false;              // POV: full game HUD overlay
  let hudWasOn = false;            // restore combat() when the HUD drops
  let dof = 0;                     // 0 off · 1 auto · 2 manual focus
  let dofFocus = 10, dofBlur = 0.5, dofAutoF = 10, dofBokeh = 1;
  let dofRange = 1.6;              // in-focus DEPTH band (m) — covers a person
  let layerMode = 0;               // 0 final · 1 depth map · 2 greenscreen
  const greenKeep = { world: false, players: true, fx: false, weapon: true };
  let shakeAmt = 0, shakeSpd = 1;  // handheld camera wobble
  let dvRange = 100;               // depth-layer visual range (m to black)
  let freeRoll = 0;                // Z/X camera roll (free cam)
  let pathMode = 'ease';           // 'ease' stops at keys · 'smooth' glides through
  let attachMode = 0;              // 0 off · 1 position · 2 full (rides the yaw)
  const attachPrev = new THREE.Vector3();
  let attachPrevYaw = 0, attachInit = false;
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  const _ray = new THREE.Ray();
  const _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
  const _rp1 = new THREE.Vector3(), _rp2 = new THREE.Vector3();
  const GREENBG = new THREE.Color(0x00ff00);

  function makeGhost(r) {
    const stub = {
      name: r.name, color: r.color, cos: r.cos || null, isLocal: false,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      tumbleVel: new THREE.Vector3(),
      yaw: 0, pitch: 0, height: 1.8, eyeHeight: 1.62,
      grounded: true, sliding: false, alive: true, fellScreamed: false,
      ragdoll: null, weapon: 'pistol',
      grapple: null,                  // rope replayed from the gp snapshots
      // enough pawn surface for SKY.HUD.update / Weapons.computePush so the
      // POV camera can show the real game HUD (values not in the recording
      // fall back to calm defaults)
      slots: { 1: null, 2: 'pistol' }, activeSlot: 2, ammo: 8,
      reloadT: 0, chargeT: 0, pbCd: 0, acCd: 0, grappleCd: 0,
      nades: null, sparks: 0, koCount: 0, lives: 3, roundWins: 0,
      zoomed: false, eliminated: false,
      mods: { speedMult: 1, jumpMult: 1, cdMult: 1, knockResist: 1,
              grappleRangeMult: 1, grappleCdMult: 1, magMult: 1, gravMult: 1, powerMult: 1 },
      abilities: { doubleJump: false, dash: false, pound: false },
      speedH() { return Math.hypot(this.vel.x, this.vel.z); },
      speed3() { return this.vel.length(); },
      eyePos(out) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); },
      midPos(out) { return out.set(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z); },
    };
    stub.avatar = SKY.Characters.create(stub, scene);
    return { stub, av: stub.avatar, rag: false, taunted: false };
  }

  /* pooled replay darts — no allocation churn during playback */
  const dartPool = [];
  function makeDart(at) {
    let v = dartPool.pop();
    if (!v) v = SKY.Effects.makeTracer();
    if (at) SKY.Effects.resetTracer(v, at);
    v.g.visible = true;
    return v;
  }
  function freeDart(v) { v.g.visible = false; dartPool.push(v); }
  function killDarts() {
    for (const b of gb) freeDart(b.vis);
    gb.length = 0;
  }

  /* is a recorded world position the POV player's own muzzle? (roughly at
     their eye/shoulder) — those events re-anchor to the LIVE viewmodel so
     bullets/flashes leave the gun on screen instead of the head */
  function povStub() {
    return camMode === 'pov' && ghosts[sel] && ghosts[sel].stub.alive
      ? ghosts[sel].stub : null;
  }
  function nearPovMuzzle(p) {
    const s = povStub();
    if (!s || !p) return false;
    return Math.abs(p.x - s.pos.x) < 1.7 &&
           Math.abs(p.y - (s.pos.y + s.eyeHeight)) < 1.9 &&
           Math.abs(p.z - s.pos.z) < 1.7;
  }

  function fire(e) {
    if (e.fn === '__bullet') {
      const pos = new THREE.Vector3(e.p[0], e.p[1], e.p[2]);
      if (nearPovMuzzle(pos)) {
        const tip = SKY.Effects.viewmodelTip();
        if (tip) pos.copy(tip);
      }
      gb.push({
        pos,
        vel: new THREE.Vector3(e.v[0], e.v[1], e.v[2]),
        g: e.g, life: e.l, vis: makeDart(pos),
      });
      return;
    }
    const args = e.a.map(deserArg);
    if (e.fn === 'muzzle') {
      // POV's own shot: flash at the viewmodel tip + real recoil kick;
      // everyone else's flashes stay world-anchored and never kick us
      if (nearPovMuzzle(args[0])) {
        const tip = SKY.Effects.viewmodelTip();
        if (tip) args[0] = tip.clone();
        args[2] = true;
      } else args[2] = false;
    }
    if (e.fn === 'cannonBlast' && nearPovMuzzle(args[0])) {
      SKY.Effects.cannonPop();                 // the cannon whips up in POV
    }
    fxOrig[e.fn](...args);
    // a little sound sells the moment (only while playing forward)
    if (e.fn === 'hitBurst') SKY.SFX.hit((args[1] || 0) / 3);
    else if (e.fn === 'headshotBurst') SKY.SFX.headshot();
    else if (e.fn === 'koBurst') SKY.SFX.ko(false);
    else if (e.fn === 'muzzle') SKY.SFX.fire(0.4, (args[3] || 1) * 0.7);
    else if (e.fn === 'cannonBlast') SKY.SFX.airCannon();
  }

  function evLowerBound(tAbs) {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].t <= tAbs) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function seek(t) {
    T = SKY.U.clamp(t, 0, api.duration);
    if (frames.length) evi = evLowerBound(frames[0].t + T);
    killDarts();
  }

  function setPlaying(on) {
    playing = on;
    if (ui) ui.play.classList.toggle('playing', on);
  }

  function pose(rdt) {
    if (!frames.length) return;
    const tAbs = frames[0].t + T;
    while (cur < frames.length - 2 && frames[cur + 1].t <= tAbs) cur++;
    while (cur > 0 && frames[cur].t > tAbs) cur--;
    const A = frames[cur], B = frames[Math.min(cur + 1, frames.length - 1)];
    const u = SKY.U.clamp01((tAbs - A.t) / Math.max(1e-4, B.t - A.t));

    // replay the moving platforms (visual meshes only; the sim is frozen)
    if (A.mv) {
      const movers = SKY.World.movers;
      const mb = B.mv || A.mv;
      const n = Math.min(movers.length, A.mv.length / 3);
      for (let i = 0; i < n; i++) {
        const mesh = movers[i].mesh;
        if (!mesh) continue;
        mesh.position.set(
          SKY.U.lerp(A.mv[i * 3], mb[i * 3], u),
          SKY.U.lerp(A.mv[i * 3 + 1], mb[i * 3 + 1], u),
          SKY.U.lerp(A.mv[i * 3 + 2], mb[i * 3 + 2], u));
      }
    }

    ghosts.forEach((g, i) => {
      const a = A.pw[i], b = B.pw[i] || a;
      if (!a) return;
      const s = g.stub;
      s.alive = !!(b.f & 1);
      s.grounded = !!(b.f & 2);
      s.sliding = !!(b.f & 4);
      s.fellScreamed = !!(b.f & 8);
      s.inWater = !!(b.f & 32);
      s.pos.set(SKY.U.lerp(a.p[0], b.p[0], u), SKY.U.lerp(a.p[1], b.p[1], u), SKY.U.lerp(a.p[2], b.p[2], u));
      s.vel.set(b.v[0], b.v[1], b.v[2]);
      s.yaw = a.yaw + SKY.U.angDelta(a.yaw, b.yaw) * u;
      s.pitch = SKY.U.lerp(a.pit, b.pit, u);
      s.height = SKY.U.lerp(a.h, b.h, u);
      s.eyeHeight = SKY.U.lerp(a.e, b.e, u);
      if (b.tv) s.tumbleVel.set(b.tv[0], b.tv[1], b.tv[2]);
      else s.tumbleVel.set(0, 0, 0);
      s.weapon = b.w === 255 ? null : (WK[b.w] || 'pistol');
      // POV HUD mirrors: weapon slots + recorded ammo
      s.slots[1] = s.weapon && s.weapon !== 'pistol' ? s.weapon : null;
      s.slots[2] = s.weapon ? 'pistol' : null;
      s.activeSlot = s.weapon === 'pistol' ? 2 : 1;
      s.ammo = b.am !== undefined ? b.am
        : (SKY.TUNING.weapons[s.weapon] || SKY.TUNING.weapons.pistol).mag;
      // grapple rope replay (drawn by Grapple.updateVisuals in frame())
      const gp = b.gp || a.gp;
      if (gp && s.alive) {
        if (!s.grapple) s.grapple = { point: new THREE.Vector3(), len: 0, t: 0 };
        s.grapple.point.set(gp[0], gp[1], gp[2]);
        s.grapple.len = gp[3] || 0;
      } else s.grapple = null;
      const taunt = !!(b.f & 16);
      if (taunt && !g.taunted) g.av.playEmote();
      g.taunted = taunt;

      const ra = a.rag || b.rag, rb = b.rag || a.rag;
      if (ra && s.alive) {
        // drive the verlet proxy straight from the recorded particles
        if (!g.rag) {
          g.rag = true;
          g.av.ragActive = true;
          g.av.root.visible = false;
          g.av.proxyRoot.visible = true;
        }
        if (s.weapon !== g.av.gunKind) g.av.setWeapon(s.weapon);
        for (let k = 0; k < 11; k++) {
          g.av.pts[k].set(
            SKY.U.lerp(ra[k * 3], rb[k * 3], u),
            SKY.U.lerp(ra[k * 3 + 1], rb[k * 3 + 1], u),
            SKY.U.lerp(ra[k * 3 + 2], rb[k * 3 + 2], u));
        }
        g.av._poseProxy();
        if (g.av.nameSpr) {
          g.av.nameSpr.visible = namesOn;
          g.av.nameSpr.position.set(g.av.pts[1].x, g.av.pts[1].y + 0.8, g.av.pts[1].z);
        }
      } else {
        if (g.rag) { g.rag = false; g.av.endRagdoll(); }
        g.av.ragActive = false;
        g.av.update(Math.max(rdt, 1e-3));
      }
      // POV: don't render the head you're looking out of
      const hidden = camMode === 'pov' && i === sel;
      if (s.alive) {
        if (g.rag) { g.av.root.visible = false; g.av.proxyRoot.visible = !hidden; }
        else { g.av.root.visible = !hidden; g.av.proxyRoot.visible = false; }
        if (g.av.nameSpr) g.av.nameSpr.visible = !hidden && namesOn;
      }
    });
  }

  function tickDarts(sdt) {
    if (sdt <= 0) return;
    for (let i = gb.length - 1; i >= 0; i--) {
      const b = gb[i];
      b.life -= sdt;
      b.vel.y -= b.g * sdt;
      _v.copy(b.vel).normalize();
      b.pos.addScaledVector(b.vel, sdt);
      SKY.Effects.poseTracer(b.vis, b.pos, _v, 1.8);
      if (b.life <= 0) {
        freeDart(b.vis);
        gb.splice(i, 1);
      }
    }
  }

  /* keyframe neighbours + blend at time tt.
     'ease' smoothsteps each segment (settles at every key);
     'smooth' keeps time linear — position runs a Catmull-Rom through the
     keys so multi-point shots glide instead of stop-starting. */
  function kfLerp(tt) {
    let i = 0;
    while (i < kf.length - 2 && kf[i + 1].t <= tt) i++;
    const a = kf[i], b = kf[Math.min(i + 1, kf.length - 1)];
    let s = tt <= a.t ? 0 : tt >= b.t ? 1 : (tt - a.t) / Math.max(1e-4, b.t - a.t);
    if (pathMode !== 'smooth') s = s * s * (3 - 2 * s);
    return { a, b, s, i };
  }

  /* Catmull-Rom position through p0..p3 (arrays), t in [0,1] on p1->p2 */
  function catmull(out, p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    for (let k = 0; k < 3; k++) {
      out.setComponent(k, 0.5 * (
        2 * p1[k] +
        (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
    }
    return out;
  }

  /* is the camera currently driven by the keyframe path? */
  function onPath() {
    return camMode === 'keys' && kf.length >= 2 &&
           (playing || scrubbing || dragObj !== null);
  }

  /* playback window: the active clip's in/out, else the whole timeline */
  function playStart() { return clips[activeClip] ? clips[activeClip].in : 0; }
  function playEnd() { return clips[activeClip] ? clips[activeClip].out : api.duration; }

  function cameraTick(rdt) {
    const In = SKY.Input;
    if (onPath()) {
      // KEYS during playback/scrub: glide through the user's keyframes.
      // While paused you keep full free-fly control to line up the next key.
      const { a, b, s, i } = kfLerp(T);
      if (pathMode === 'smooth' && kf.length >= 2) {
        const p0 = kf[Math.max(0, i - 1)].p, p3 = kf[Math.min(kf.length - 1, i + 2)].p;
        camera.position.copy(catmull(_v, p0, a.p, b.p, p3, s));
      } else {
        _v.fromArray(a.p); _v2.fromArray(b.p);
        camera.position.lerpVectors(_v, _v2, s);
      }
      _qa.fromArray(a.q); _qb.fromArray(b.q);
      camera.quaternion.slerpQuaternions(_qa, _qb, s);
      camera.fov = SKY.U.lerp(a.fov, b.fov, s);
      pathDriven = true;
    } else {
      if (pathDriven) {
        // hand control back exactly where the path left the camera
        pathDriven = false;
        fcPos.copy(camera.position);
        _e.setFromQuaternion(camera.quaternion);
        In.yaw = _e.y; In.pitch = _e.x;
        freeRoll = _e.z;
        freeFov = camera.fov;
      }
      if (camMode === 'pov' && ghosts[sel]) {
        const s = ghosts[sel].stub;
        camera.position.set(s.pos.x, s.pos.y + s.eyeHeight, s.pos.z);
        camera.rotation.set(s.pitch, s.yaw, 0, 'YXZ');
        camera.fov = SKY.U.damp(camera.fov, SKY.TUNING.camera.baseFov, 10, rdt);
      } else if (camMode === 'orbit' && ghosts[sel]) {
        const s = ghosts[sel].stub;
        const yaw = In.yaw, pit = SKY.U.clamp(In.pitch, -1.25, 1.25);
        _v.set(s.pos.x, s.pos.y + s.height * 0.6, s.pos.z);
        camera.position.set(
          _v.x + Math.sin(yaw) * Math.cos(pit) * orbitDist,
          _v.y - Math.sin(pit) * orbitDist,
          _v.z + Math.cos(yaw) * Math.cos(pit) * orbitDist);
        camera.lookAt(_v);
        camera.fov = SKY.U.damp(camera.fov, 70, 10, rdt);
      } else {
        // FREE fly (also KEYS while paused, so you can line up shots)
        // ATTACH: the camera rides the selected player — position deltas
        // (and yaw pivots in Full mode) carry the free cam along, so it can
        // sit "mounted" on a weapon, shoulder, anywhere
        if (attachMode && ghosts[sel] && ghosts[sel].stub.alive) {
          const s = ghosts[sel].stub;
          if (attachInit) {
            fcPos.x += s.pos.x - attachPrev.x;
            fcPos.y += s.pos.y - attachPrev.y;
            fcPos.z += s.pos.z - attachPrev.z;
            if (attachMode === 2) {
              const dy = SKY.U.angDelta(attachPrevYaw, s.yaw);
              _v2.copy(fcPos).sub(_v.set(s.pos.x, fcPos.y, s.pos.z));
              _v2.applyAxisAngle(Y_AXIS, dy);
              fcPos.copy(_v).add(_v2);
              In.yaw += dy;
            }
          }
          attachPrev.copy(s.pos);
          attachPrevYaw = s.yaw;
          attachInit = true;
        } else attachInit = false;

        const fast = In.isDown('ShiftLeft') || In.isDown('ShiftRight');
        const sp = (fast ? 26 : 10) * rdt;
        SKY.U.dirFromYawPitch(In.yaw, In.pitch, _v);
        _v2.set(Math.cos(In.yaw), 0, -Math.sin(In.yaw));
        const mz = (In.action('forward') ? 1 : 0) - (In.action('back') ? 1 : 0);
        const mx = (In.action('right') ? 1 : 0) - (In.action('left') ? 1 : 0);
        const my = (In.isDown('KeyE') ? 1 : 0) - (In.isDown('KeyQ') ? 1 : 0);
        fcPos.addScaledVector(_v, mz * sp).addScaledVector(_v2, mx * sp);
        fcPos.y += my * sp;
        // Z / X — dutch roll (C resets)
        if (In.isDown('KeyZ')) freeRoll += 1.1 * rdt;
        if (In.isDown('KeyX')) freeRoll -= 1.1 * rdt;
        if (In.isDown('KeyC')) freeRoll = SKY.U.damp(freeRoll, 0, 14, rdt);
        camera.position.copy(fcPos);
        camera.rotation.set(In.pitch, In.yaw, freeRoll, 'YXZ');
        camera.fov = SKY.U.damp(camera.fov, freeFov, 12, rdt);
      }
    }
    const eff = effective();
    if (eff.shA > 0.001) applyShake(eff.shA, eff.shS);
    camera.updateProjectionMatrix();
  }

  /* ---------------- keyframes ---------------- */
  function currentFocus() { return dof === 2 ? dofFocus : dofAutoF; }

  function addKf() {
    // OVERRIDE: a key already sitting at (almost) this time gets replaced
    let k = kf.find(x => Math.abs(x.t - T) < 0.08);
    if (!k) { k = { t: T }; kf.push(k); }
    k.p = camera.position.toArray();
    k.q = camera.quaternion.toArray();
    k.fov = camera.fov;
    // each key carries the FULL lens + shake setup — edit any key later and
    // playback blends between neighbouring keys' settings (no jumps)
    k.dofMode = dof;
    k.focus = currentFocus();
    k.blur = dofBlur;
    k.bokeh = dofBokeh;
    k.rng = dofRange;
    k.shA = shakeAmt;
    k.shS = shakeSpd;
    kf.sort((x, y) => x.t - y.t);
    selKf = kf.indexOf(k);
    renderKf();
    // dropping a key while free-flying means "I'm building a camera path" —
    // switch to KEYS so playback actually follows it (paused = still free-fly)
    if (camMode === 'free') setCam('keys');
    // note: adding a key does NOT hijack the camera — keep flying freely.
  }
  function deleteKf(i) {
    if (i < 0 || i >= kf.length) return;
    kf.splice(i, 1);
    selKf = -1;
    renderKf();
  }
  function clearKf() { kf.length = 0; selKf = -1; dragObj = null; renderKf(); }

  function renderKf() {
    ui.keys.innerHTML = kf.map((k, i) =>
      `<div class="rp-kf${i === selKf ? ' sel' : ''}" data-i="${i}"></div>`).join('');
    positionKf();
    ui.delkf.classList.toggle('rp-disabled', selKf < 0);
  }
  function positionKf() {
    const w = Math.max(1e-4, viewEnd - viewStart);
    const els = ui.keys.children;
    for (let i = 0; i < els.length; i++) {
      const p = (kf[i].t - viewStart) / w;
      els[i].style.left = (p * 100) + '%';
      els[i].style.display = (p < -0.01 || p > 1.01) ? 'none' : '';
    }
    positionMarks();
    updateClipShade();
  }

  /* round-start tick marks along the timeline (R1 / R2 / …) */
  function renderMarks() {
    if (!frames.length || !marks.length) { ui.marks.innerHTML = ''; return; }
    const t0 = frames[0].t;
    ui.marks.innerHTML = marks.map(m =>
      `<div class="rp-mark" data-t="${Math.max(0, m.t - t0).toFixed(2)}"><span>${m.label}</span></div>`).join('');
    positionMarks();
  }
  function positionMarks() {
    if (!ui.marks) return;
    const w = Math.max(1e-4, viewEnd - viewStart);
    for (const el of ui.marks.children) {
      const p = (+el.dataset.t - viewStart) / w;
      el.style.left = (p * 100) + '%';
      el.style.display = (p < -0.005 || p > 1.005) ? 'none' : '';
    }
  }

  /* ---------------- DoF / per-keyframe editing ----------------
     With a keyframe SELECTED, the lens/shake panels edit THAT key's stored
     settings; with nothing selected they edit the session globals. */
  function editKf() { return selKf >= 0 ? kf[selKf] : null; }

  function paintDof(n) {
    ui.dof.querySelectorAll('.rp-pill').forEach(b =>
      b.classList.toggle('sel', +b.dataset.d === n));
    ui.dofpanel.classList.toggle('hidden', !n);
    ui.focrow.style.display = n === 2 ? '' : 'none';
  }
  function setDof(n) {
    const k = editKf();
    if (k) k.dofMode = n; else dof = n;
    paintDof(n);
  }

  /* reflect either a keyframe's stored settings or the globals in the panels */
  function syncPanels(k) {
    const g = (field, glob) => k && k[field] != null ? k[field] : glob;
    paintDof(k ? (k.dofMode !== undefined ? k.dofMode : dof) : dof);
    const focus = g('focus', dofFocus);
    ui.foc.value = focMToSlider(SKY.U.clamp(focus, 0.5, 80));
    ui.focv.textContent = focus < 10 ? focus.toFixed(1) + 'm' : Math.round(focus) + 'm';
    const blur = g('blur', dofBlur);
    ui.blur.value = blur;
    ui.blurv.textContent = 'f/' + (1.2 / Math.max(0.05, blur)).toFixed(1);
    const bokeh = g('bokeh', dofBokeh);
    ui.bok.value = bokeh;
    ui.bokv.textContent = Math.round(bokeh * 100) + '%';
    const rng = g('rng', dofRange);
    ui.rng.value = rng;
    ui.rngv.textContent = rng.toFixed(1) + 'm';
    const shA = g('shA', shakeAmt);
    ui.shake.value = shA;
    ui.shakev.textContent = shA <= 0.001 ? 'off' : Math.round(shA * 100) + '%';
    const shS = g('shS', shakeSpd);
    ui.shakespd.value = shS;
    ui.shakespdv.textContent = Math.round(shS * 100) + '%';
  }

  /* ---------------- layers ---------------- */
  function setLayer(n) {
    layerMode = n;
    ui.layers.querySelectorAll('.rp-pill').forEach(b =>
      b.classList.toggle('sel', +b.dataset.l === n));
    ui.greenpanel.classList.toggle('hidden', n !== 2);
    ui.depthpanel.classList.toggle('hidden', n !== 1);
  }

  function setAttach(n) {
    attachMode = n;
    attachInit = false;
    ui.attach.querySelectorAll('.rp-pill').forEach(b =>
      b.classList.toggle('sel', +b.dataset.a === n));
  }
  function setPathMode(m) {
    pathMode = m;
    ui.pathmode.querySelectorAll('.rp-pill').forEach(b =>
      b.classList.toggle('sel', b.dataset.p === m));
  }

  /* ---------------- CLIPS (the project layer) ----------------
     A clip = an in/out slice of the match + its OWN keyframes and settings.
     Build several clips of the same moment from different angles, hop
     between them to edit, play (or render) the whole project in order. */
  let clips = [], activeClip = -1, projPlaying = false;
  let scratchKf = kf;              // the keyframe list used outside any clip

  function snapSettings() {
    return { dof, dofFocus, dofBlur, dofBokeh, dofRange, shakeAmt, shakeSpd,
             pathMode, camMode, sel, attachMode, crossOn, namesOn };
  }
  function applySnap(s) {
    if (!s) return;
    dof = s.dof || 0; dofFocus = s.dofFocus || 10; dofBlur = s.dofBlur || 0.5;
    dofBokeh = s.dofBokeh || 1; dofRange = s.dofRange != null ? s.dofRange : 1.6;
    shakeAmt = s.shakeAmt || 0; shakeSpd = s.shakeSpd || 1;
    setPathMode(s.pathMode || 'ease');
    setAttach(s.attachMode || 0);
    crossOn = !!s.crossOn;
    ui.crossbtn.classList.toggle('sel', crossOn);
    namesOn = s.namesOn !== false;
    ui.namebtn.classList.toggle('sel', namesOn);
    setSel(s.sel || 0);
    setCam(s.camMode || 'free');
    syncPanels(null);
  }

  function saveClip() {
    if (activeClip >= 0 && clips[activeClip]) {
      clips[activeClip].set = snapSettings();   // kf is edited by reference
    }
  }
  function loadClip(i) {
    saveClip();
    activeClip = i;
    selKf = -1; dragObj = null;
    if (i >= 0 && clips[i]) {
      const c = clips[i];
      kf = c.kf;
      applySnap(c.set);
      viewStart = Math.max(0, c.in - 0.5);
      viewEnd = Math.min(api.duration, c.out + 0.5);
      seek(SKY.U.clamp(T, c.in, c.out));
    } else {
      kf = scratchKf;
      viewStart = 0; viewEnd = api.duration;
    }
    renderKf();
    renderClips();
  }
  function newClip() {
    saveClip();
    const zoomed = viewEnd - viewStart < api.duration - 0.01;
    const cin = +(zoomed ? viewStart : 0).toFixed(2);
    const cout = +(zoomed ? viewEnd : api.duration).toFixed(2);
    clips.push({
      name: 'Clip ' + (clips.length + 1),
      in: cin, out: cout,
      // carry any keys already inside the window (copies — scratch keeps its own)
      kf: kf.filter(k => k.t >= cin - 1e-3 && k.t <= cout + 1e-3).map(k => ({ ...k })),
      set: snapSettings(),
    });
    loadClip(clips.length - 1);
  }
  function deleteClip(i) {
    clips.splice(i, 1);
    if (activeClip === i) { activeClip = -1; kf = scratchKf; renderKf(); }
    else if (activeClip > i) activeClip--;
    renderClips();
  }
  function trimClip() {
    const c = clips[activeClip];
    if (!c || !kf.length) return;
    c.in = Math.max(0, +(kf[0].t - 0.4).toFixed(2));
    c.out = Math.min(api.duration, +(kf[kf.length - 1].t + 0.4).toFixed(2));
    viewStart = Math.max(0, c.in - 0.5);
    viewEnd = Math.min(api.duration, c.out + 0.5);
    positionKf();
    renderClips();
  }
  function renderClips() {
    ui.clips.innerHTML = clips.map((c, i) =>
      `<div class="rp-clip${i === activeClip ? ' sel' : ''}" data-i="${i}">
        ${c.name} <i>${(c.out - c.in).toFixed(1)}s</i><span class="x" data-x="${i}">×</span>
      </div>`).join('');
    ui.trimclip.classList.toggle('rp-disabled', activeClip < 0);
    updateClipShade();
  }
  function updateClipShade() {
    const c = clips[activeClip];
    if (!c) { ui.clipshade.innerHTML = ''; return; }
    const w = Math.max(1e-4, viewEnd - viewStart);
    const l = SKY.U.clamp01((c.in - viewStart) / w) * 100;
    const r = SKY.U.clamp01((c.out - viewStart) / w) * 100;
    ui.clipshade.innerHTML =
      `<div style="left:0;width:${l}%"></div>` +
      `<div style="left:${r}%;right:0"></div>` +
      `<i style="left:${l}%"></i><i style="left:${r}%"></i>`;
  }
  function playProject() {
    if (!clips.length) return;
    projPlaying = true;
    loadClip(0);
    seek(clips[0].in);
    setPlaying(true);
  }
  function focSliderToM(v) { return 0.5 * Math.pow(160, v); }   // 0.5 .. 80 m
  function focMToSlider(m) { return Math.log(m / 0.5) / Math.log(160); }

  /* per-key lens/shake with global fallbacks (old keys may miss fields) */
  function kfSettings(k) {
    const mode = k.dofMode !== undefined ? k.dofMode : dof;
    return {
      focus: mode === 1 ? dofAutoF : (k.focus != null ? k.focus : currentFocus()),
      blur: mode === 0 ? 0 : (k.blur != null ? k.blur : dofBlur),
      bokeh: k.bokeh != null ? k.bokeh : dofBokeh,
      rng: k.rng != null ? k.rng : dofRange,
      shA: k.shA != null ? k.shA : shakeAmt,
      shS: k.shS != null ? k.shS : shakeSpd,
    };
  }

  /* the lens + shake values in effect THIS frame: on the key path every
     field blends between the neighbouring keyframes' own settings, so an
     auto-focus key can hand over to a manual key with no visible jump */
  function effective() {
    if (onPath()) {
      const { a, b, s } = kfLerp(T);
      const A = kfSettings(a), B = kfSettings(b);
      return {
        focus: SKY.U.lerp(A.focus, B.focus, s),
        blur: SKY.U.lerp(A.blur, B.blur, s),
        bokeh: SKY.U.lerp(A.bokeh, B.bokeh, s),
        rng: SKY.U.lerp(A.rng, B.rng, s),
        shA: SKY.U.lerp(A.shA, B.shA, s),
        shS: SKY.U.lerp(A.shS, B.shS, s),
      };
    }
    return { focus: currentFocus(), blur: dof ? dofBlur : 0,
             bokeh: dofBokeh, rng: dofRange, shA: shakeAmt, shS: shakeSpd };
  }

  function autoFocusTick(rdt) {
    // runs when auto AF is the live mode OR any keyframe on the path uses it
    const wantAuto = dof === 1 ||
      (camMode === 'keys' && kf.some(k => k.dofMode === 1));
    if (!wantAuto || !ghosts.length) return;
    // real-camera CENTER AF: the character the crosshair RAY actually passes
    // near wins (nearest one, capsule test — the old ~26° "most centered"
    // cone missed constantly); nobody there -> orbit target -> the world
    // under the crosshair; still nothing -> hold (no snapping to infinity)
    _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _ray.origin.copy(camera.position);
    _ray.direction.copy(_v);
    let target = -1;
    ghosts.forEach((g, i) => {
      if (!g.stub.alive) return;
      if (camMode === 'pov' && i === sel) return;   // never AF on your own head
      const s = g.stub;
      _ra.set(s.pos.x, s.pos.y + 0.15, s.pos.z);
      _rb.set(s.pos.x, s.pos.y + s.height, s.pos.z);
      const miss = Math.sqrt(_ray.distanceSqToSegment(_ra, _rb, _rp1, _rp2));
      const d = _rp1.distanceTo(camera.position);
      if (d < 0.4) return;
      // allowance widens with distance (far people are small on screen)
      if (miss < 0.6 + d * 0.05 && (target < 0 || d < target)) target = d;
    });
    if (target < 0 && camMode === 'orbit' && ghosts[sel]) {
      const s = ghosts[sel].stub;
      _v2.set(s.pos.x, s.pos.y + s.height * 0.6, s.pos.z);
      target = camera.position.distanceTo(_v2);
    }
    if (target < 0) {
      const hit = SKY.World.raycast(camera.position, _v, 180);
      if (hit) target = hit.t;
    }
    if (target < 0) target = dofAutoF;
    dofAutoF = SKY.U.damp(dofAutoF, SKY.U.clamp(target, 0.5, 150), 12, rdt);
  }

  /* ---------------- handheld shake (layered sines — deterministic in T,
     so scrubbing back and forth reproduces the exact same wobble) -------- */
  function applyShake(amt, spd) {
    const t = T * spd;
    const a = amt * 0.016;
    const n = (f, s) => Math.sin(t * f + s) * 0.6 +
                        Math.sin(t * f * 2.3 + s * 1.7) * 0.28 +
                        Math.sin(t * f * 5.1 + s * 3.1) * 0.12;
    _e.set(n(1.9, 1.3) * a, n(1.4, 4.7) * a, n(1.1, 8.9) * a * 0.5);
    _qa.setFromEuler(_e);
    camera.quaternion.multiply(_qa);
    camera.position.x += n(1.2, 2.2) * a * 0.6;
    camera.position.y += n(1.6, 6.1) * a * 0.6;
  }

  /* ---------------- greenscreen (HLAE-style layer isolation) ----------------
     Renders ONLY the kept layers over pure #00ff00 — fog off, background
     swapped, everything else hidden for one render call, then restored. */
  function renderGreen(renderer, sc, cam) {
    const stash = [];
    const hide = (o) => { if (o.visible) { o.visible = false; stash.push(o); } };
    const playerObjs = new Set();
    for (const g of ghosts) {
      playerObjs.add(g.av.root);
      playerObjs.add(g.av.proxyRoot);
      if (g.av.nameSpr) playerObjs.add(g.av.nameSpr);
      if (g.stub._rope) playerObjs.add(g.stub._rope);
    }
    const mapRoot = SKY.Map.rootGroup;
    for (const ch of sc.children) {
      if (ch === cam || ch.isLight || ch.isCamera) continue;   // lights stay lit
      if (ch === mapRoot) {
        // hide the world's MESHES only — its mood lights keep shading the cast
        if (!greenKeep.world) {
          ch.traverse(o => {
            if (o.isMesh || o.isSprite || o.isPoints || o.isLine) hide(o);
          });
        }
        continue;
      }
      if (playerObjs.has(ch)) { if (!greenKeep.players) hide(ch); continue; }
      if (!greenKeep.fx) hide(ch);
    }
    if (!greenKeep.weapon) for (const g of SKY.Effects.vmGroups()) hide(g);
    const bg = sc.background, fog = sc.fog;
    renderer.getClearColor(_gcPrev);
    const prevA = renderer.getClearAlpha();
    sc.background = null; sc.fog = null;
    renderer.setClearColor(GREENBG, 1);   // clear color skips tone mapping = pure key green
    renderer.render(sc, cam);
    renderer.setClearColor(_gcPrev, prevA);
    sc.background = bg; sc.fog = fog;
    for (const o of stash) o.visible = true;
  }
  const _gcPrev = new THREE.Color();

  /* ---------------- UI ---------------- */
  const SPEEDS = [0.25, 0.5, 1, 2];
  const CAMS = [['free', 'Free'], ['pov', 'POV'], ['orbit', 'Orbit'], ['keys', 'Keys']];

  function setCam(mode) {
    camMode = mode;
    if (mode === 'free' || mode === 'keys') {
      // continue flying from wherever the camera is now
      fcPos.copy(camera.position);
      _e.setFromQuaternion(camera.quaternion);
      SKY.Input.yaw = _e.y;
      SKY.Input.pitch = _e.x;
      freeFov = camera.fov;
    }
    ui.cams.querySelectorAll('.rp-pill').forEach(b =>
      b.classList.toggle('sel', b.dataset.c === mode));
  }

  function setSpeed(s, el) {
    speed = s;
    ui.speeds.querySelectorAll('.rp-pill').forEach(b => {
      b.classList.toggle('sel', +b.dataset.s === s);
      b.classList.remove('bump');
    });
    if (el) { void el.offsetWidth; el.classList.add('bump'); }
  }

  function setSel(i) {
    if (!roster || !roster.length) return;
    sel = ((i % roster.length) + roster.length) % roster.length;
    ui.pname.textContent = roster[sel].name;
  }

  function fmt(t) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function uiTick() {
    const w = Math.max(1e-4, viewEnd - viewStart);
    const k = SKY.U.clamp01((T - viewStart) / w);
    ui.fill.style.width = (k * 100) + '%';
    ui.handle.style.left = (k * 100) + '%';
    const zoomed = viewEnd - viewStart < api.duration - 0.01;
    ui.time.textContent = fmt(T) + ' / ' + fmt(api.duration) + (zoomed ? ' 🔍' : '');
    positionKf();
    ui.cross.classList.toggle('hidden', !(crossOn && camMode === 'pov'));
  }

  function xToTime(clientX) {
    const r = ui.track.getBoundingClientRect();
    return viewStart + (viewEnd - viewStart) * SKY.U.clamp01((clientX - r.left) / r.width);
  }

  function initUI() {
    const $ = (id) => document.getElementById(id);
    ui = {
      root: $('replay-ov'), bar: $('rp-bar'), play: $('rp-play'),
      time: $('rp-time'), track: $('rp-track'), fill: $('rp-fill'),
      handle: $('rp-handle'), keys: $('rp-keys'), speeds: $('rp-speeds'),
      cams: $('rp-cams'), pname: $('rp-pname'), delkf: $('rp-delkf'),
      dof: $('rp-dof'), dofpanel: $('rp-dofpanel'), focrow: $('rp-focrow'),
      foc: $('rp-foc'), focv: $('rp-focv'), blur: $('rp-blur'), blurv: $('rp-blurv'),
      bok: $('rp-bok'), bokv: $('rp-bokv'),
      crossbtn: $('rp-crossbtn'), cross: $('rp-cross'),
      namebtn: $('rp-namebtn'), hudbtn: $('rp-hudbtn'),
      tl: $('rp-timeline'), marks: $('rp-marks'),
      layers: $('rp-layers'), greenpanel: $('rp-greenpanel'), keeps: $('rp-keeps'),
      shake: $('rp-shake'), shakev: $('rp-shakev'),
      shakespd: $('rp-shakespd'), shakespdv: $('rp-shakespdv'),
      rng: $('rp-rng'), rngv: $('rp-rngv'),
      depthpanel: $('rp-depthpanel'), dvrng: $('rp-dvrng'), dvrngv: $('rp-dvrngv'),
      attach: $('rp-attach'), pathmode: $('rp-pathmode'),
      clips: $('rp-clips'), clipshade: $('rp-clipshade'),
      trimclip: $('rp-trimclip'),
    };
    ui.speeds.innerHTML = SPEEDS.map(s =>
      `<button class="rp-pill${s === 1 ? ' sel' : ''}" data-s="${s}">${s}×</button>`).join('');
    ui.cams.innerHTML = CAMS.map(([id, label]) =>
      `<button class="rp-pill${id === 'free' ? ' sel' : ''}" data-c="${id}">${label}</button>`).join('');
    ui.dof.innerHTML =
      `<button class="rp-pill sel" data-d="0">Off</button>` +
      `<button class="rp-pill" data-d="1">Auto</button>` +
      `<button class="rp-pill" data-d="2">Focus</button>`;
    ui.layers.innerHTML =
      `<button class="rp-pill sel" data-l="0">Final</button>` +
      `<button class="rp-pill" data-l="1">Depth</button>` +
      `<button class="rp-pill" data-l="2">Green</button>`;
    ui.keeps.innerHTML = [['world', 'World'], ['players', 'Players'],
                          ['fx', 'FX'], ['weapon', 'Weapon']].map(([k, label]) =>
      `<button class="rp-pill${greenKeep[k] ? ' sel' : ''}" data-k="${k}">${label}</button>`).join('');

    ui.play.addEventListener('click', () => {
      projPlaying = false;
      if (!playing && T >= playEnd() - 0.01) seek(playStart());
      setPlaying(!playing);
    });
    ui.speeds.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) setSpeed(+b.dataset.s, b);
    });
    ui.cams.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) setCam(b.dataset.c);
    });
    ui.dof.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) setDof(+b.dataset.d);
    });
    ui.layers.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) setLayer(+b.dataset.l);
    });
    ui.keeps.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (!b) return;
      greenKeep[b.dataset.k] = !greenKeep[b.dataset.k];
      b.classList.toggle('sel', greenKeep[b.dataset.k]);
    });
    ui.shake.addEventListener('input', () => {
      const v = +ui.shake.value;
      const k = editKf();
      if (k) k.shA = v; else shakeAmt = v;
      ui.shakev.textContent = v <= 0.001 ? 'off' : Math.round(v * 100) + '%';
    });
    ui.shakespd.addEventListener('input', () => {
      const v = +ui.shakespd.value;
      const k = editKf();
      if (k) k.shS = v; else shakeSpd = v;
      ui.shakespdv.textContent = Math.round(v * 100) + '%';
    });
    ui.rng.addEventListener('input', () => {
      const v = +ui.rng.value;
      const k = editKf();
      if (k) k.rng = v; else dofRange = v;
      ui.rngv.textContent = v.toFixed(1) + 'm';
    });
    ui.dvrng.addEventListener('input', () => {
      dvRange = +ui.dvrng.value;
      ui.dvrngv.textContent = dvRange + 'm';
    });
    ui.attach.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) setAttach(+b.dataset.a);
    });
    ui.pathmode.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) setPathMode(b.dataset.p);
    });
    ui.foc.addEventListener('input', () => {
      const m = focSliderToM(+ui.foc.value);
      const k = editKf();
      if (k) k.focus = m; else dofFocus = m;
      ui.focv.textContent = m < 10 ? m.toFixed(1) + 'm' : Math.round(m) + 'm';
    });
    // aperture reads as an f-number (small f = shallow depth = more blur)
    ui.blur.addEventListener('input', () => {
      const v = +ui.blur.value;
      const k = editKf();
      if (k) k.blur = v; else dofBlur = v;
      ui.blurv.textContent = 'f/' + (1.2 / v).toFixed(1);
    });
    ui.blurv.textContent = 'f/' + (1.2 / dofBlur).toFixed(1);
    ui.bok.addEventListener('input', () => {
      const v = +ui.bok.value;
      const k = editKf();
      if (k) k.bokeh = v; else dofBokeh = v;
      ui.bokv.textContent = Math.round(v * 100) + '%';
    });
    ui.crossbtn.addEventListener('click', () => {
      crossOn = !crossOn;
      ui.crossbtn.classList.toggle('sel', crossOn);
    });
    ui.namebtn.addEventListener('click', () => {
      namesOn = !namesOn;
      ui.namebtn.classList.toggle('sel', namesOn);
      for (const g of ghosts) if (g.av.nameSpr) g.av.nameSpr.visible = namesOn && g.stub.alive;
    });
    ui.hudbtn.addEventListener('click', () => {
      povHud = !povHud;
      ui.hudbtn.classList.toggle('sel', povHud);
      if (povHud && camMode !== 'pov') setCam('pov');   // the HUD only makes sense in POV
    });
    $('rp-prev').addEventListener('click', () => setSel(sel - 1));
    $('rp-next').addEventListener('click', () => setSel(sel + 1));
    $('rp-addkf').addEventListener('click', addKf);
    ui.delkf.addEventListener('click', () => { deleteKf(selKf); syncPanels(null); });
    $('rp-clearkf').addEventListener('click', () => { clearKf(); syncPanels(null); });
    $('rp-exit').addEventListener('click', () => api.close());
    $('rp-newclip').addEventListener('click', newClip);
    ui.trimclip.addEventListener('click', trimClip);
    $('rp-playproj').addEventListener('click', playProject);
    $('rp-render').addEventListener('click', () => SKY.VidRender.openDialog());
    ui.clips.addEventListener('click', (e) => {
      const x = e.target.closest('.x');
      if (x) { e.stopPropagation(); deleteClip(+x.dataset.x); return; }
      const chip = e.target.closest('.rp-clip');
      if (chip) loadClip(+chip.dataset.i);
    });

    /* ----- timeline: scrub, zoom, keyframe select/drag/delete ----- */
    ui.track.addEventListener('mousedown', (e) => {
      scrubbing = true; setPlaying(false); projPlaying = false;
      if (selKf >= 0) { selKf = -1; renderKf(); syncPanels(null); }  // back to globals
      seek(xToTime(e.clientX));
    });
    ui.keys.addEventListener('mousedown', (e) => {
      const m = e.target.closest('.rp-kf');
      if (!m) return;
      e.stopPropagation();               // don't scrub underneath
      selKf = +m.dataset.i;
      if (e.button === 2) { deleteKf(selKf); syncPanels(null); return; }
      dragObj = kf[selKf];
      setPlaying(false);
      seek(dragObj.t);
      renderKf();
      syncPanels(kf[selKf]);             // panels now edit THIS key's settings
    });
    window.addEventListener('mousemove', (e) => {
      if (dragObj) {
        // reposition live; re-sort only on release (keeps markers stable)
        dragObj.t = SKY.U.clamp(xToTime(e.clientX), 0, api.duration);
        seek(dragObj.t);
        positionKf();
      } else if (scrubbing) seek(xToTime(e.clientX));
    });
    window.addEventListener('mouseup', (e) => {
      scrubbing = false;
      if (dragObj) {
        const obj = dragObj;
        dragObj = null;
        kf.sort((x, y) => x.t - y.t);
        selKf = kf.indexOf(obj);
        renderKf();
      }
      if (api.active && e.button === 0 && holdLook) {
        holdLook = false;
        if (document.pointerLockElement) document.exitPointerLock();
      }
    });
    ui.tl.addEventListener('wheel', (e) => {
      // zoom the timeline around the cursor (precise keyframe placement)
      e.preventDefault();
      if (api.duration <= 0) return;
      const r = ui.track.getBoundingClientRect();
      const frac = SKY.U.clamp01((e.clientX - r.left) / r.width);
      const tAt = viewStart + frac * (viewEnd - viewStart);
      const w = viewEnd - viewStart;
      const nw = SKY.U.clamp(w * (e.deltaY > 0 ? 1.35 : 1 / 1.35), 0.75, api.duration);
      viewStart = SKY.U.clamp(tAt - frac * nw, 0, api.duration - nw);
      viewEnd = viewStart + nw;
      positionKf();
    }, { passive: false });
    ui.tl.addEventListener('dblclick', () => {   // reset zoom
      viewStart = 0; viewEnd = api.duration; positionKf();
    });

    /* ----- cursor: always visible — HOLD LMB on the world to look ----- */
    let dragLast = null;   // plain-mouse fallback when pointer lock is denied
    SKY.Input._canvas.addEventListener('mousedown', (e) => {
      if (api.active && e.button === 0 && !SKY.Input.locked) {
        holdLook = true;
        dragLast = { x: e.clientX, y: e.clientY };
        SKY.Input.requestLock();
      }
    });
    window.addEventListener('mousemove', (e) => {
      // pointer lock can silently fail (browser cooldowns, permissions) —
      // then holding LMB still looks around via ordinary mouse deltas
      if (!api.active || !holdLook || SKY.Input.locked || !dragLast) return;
      SKY.Input.yaw -= (e.clientX - dragLast.x) * 0.004;
      SKY.Input.pitch = SKY.U.clamp(
        SKY.Input.pitch - (e.clientY - dragLast.y) * 0.004, -1.55, 1.55);
      dragLast = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', () => { dragLast = null; });

    window.addEventListener('keydown', (e) => {
      if (!api.active) return;
      if (e.code === 'Escape') { if (!document.pointerLockElement) api.close(); return; }
      if (e.code === SKY.Settings.data.binds.replay) { api.close(); return; }
      if (e.code === 'Space') {
        projPlaying = false;
        if (!playing && T >= playEnd() - 0.01) seek(playStart());
        setPlaying(!playing);
      }
      if (e.code === 'KeyK') addKf();
      if (e.code === 'KeyI' && clips[activeClip]) {   // clip in-point at cursor
        clips[activeClip].in = Math.min(+T.toFixed(2), clips[activeClip].out - 0.2);
        renderClips();
      }
      if (e.code === 'KeyO' && clips[activeClip]) {   // clip out-point at cursor
        clips[activeClip].out = Math.max(+T.toFixed(2), clips[activeClip].in + 0.2);
        renderClips();
      }
      if (e.code === 'Delete' || e.code === 'Backspace') { deleteKf(selKf); syncPanels(null); }
      if (e.code === 'KeyH') ui.root.classList.toggle('ui-hidden');
      const step = e.shiftKey ? 0.1 : 1;
      if (e.code === 'ArrowLeft') { setPlaying(false); seek(T - step); }
      if (e.code === 'ArrowRight') { setPlaying(false); seek(T + step); }
      if (e.code === 'Comma') { setPlaying(false); seek(T - 1 / HZ); }
      if (e.code === 'Period') { setPlaying(false); seek(T + 1 / HZ); }
    });
    window.addEventListener('wheel', (e) => {
      if (!api.active) return;
      if (e.target.closest && e.target.closest('#rp-bar')) return;  // bar owns its wheel
      if (camMode === 'orbit') orbitDist = SKY.U.clamp(orbitDist + e.deltaY * 0.01, 1.5, 24);
      else freeFov = SKY.U.clamp(freeFov + e.deltaY * 0.02, 28, 110);
    }, { passive: true });
  }

  /* shared editor bring-up for both live rounds and archived demos */
  function beginSession() {
    if (!WK) WK = Object.keys(SKY.TUNING.weapons);
    api.active = true;
    // the menu's attract-mode cast would otherwise stand frozen inside the
    // replay (its cleanup runs from Game.renderTick, which we replace)
    SKY.Attract.stop();
    cur = 0; evi = 0;
    kf = scratchKf;
    kf.length = 0; selKf = -1; dragObj = null;
    // archived demos carry their saved clip projects back in
    clips = archived && archived.clips
      ? archived.clips.map(c => ({ ...c, kf: c.kf.map(k => ({ ...k })) })) : [];
    activeClip = -1; projPlaying = false;
    renderClips();
    viewStart = 0; viewEnd = api.duration;
    crossOn = false;
    povHud = false; hudWasOn = false;
    ui.crossbtn.classList.remove('sel');
    ui.hudbtn.classList.remove('sel');
    ui.namebtn.classList.toggle('sel', namesOn);
    dof = 0;
    setLayer(0);
    setAttach(0);
    setPathMode('ease');
    freeRoll = 0;
    dofAutoF = 10;
    shakeAmt = 0;
    syncPanels(null);
    renderMarks();
    document.body.classList.add('replaying');
    ui.root.classList.remove('hidden');
    ui.root.classList.remove('ui-hidden');
    SKY.Effects.setViewmodelVisible(false);
    SKY.SFX.setWind(0); SKY.SFX.setSlide(false);
    ghosts = roster.map(makeGhost);
    api._stubList = ghosts.map(g => g.stub);
    setSel(0);
    setSpeed(1);
    savedYaw = SKY.Input.yaw; savedPitch = SKY.Input.pitch;
    fcPos.copy(camera.position);
    freeFov = 80;
    pathDriven = false;
    holdLook = false;
    setCam('free');
    renderKf();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /* ========================= public ========================= */
  const api = {
    active: false,
    duration: 0,

    init(sc, cam) {
      scene = sc; camera = cam;
      hookFx();
      initUI();
    },

    record, wipe, bullet, seek,
    frameCount() { return frames.length; },
    mark(label) {
      if (api.active) return;
      marks.push({ t: SKY.Game.time, label });
    },

    /* snapshot the current buffer for the match-history archive */
    archive() {
      if (!roster || frames.length < HZ) return null;
      return {
        frames: frames.slice(),
        events: events.slice(),
        marks: marks.slice(),
        roster: roster.map(r => ({ ...r })),
        duration: +(frames[frames.length - 1].t - frames[0].t).toFixed(1),
      };
    },

    open() {
      if (api.active) return;
      const G = SKY.Game;
      if (SKY.Net.online) {
        SKY.HUD.subMsg('Online rounds land in menu ▸ MATCHES when the round ends', 3);
        return;
      }
      if (frames.length < HZ / 2) { SKY.HUD.subMsg('Nothing recorded yet', 2); return; }
      archived = null;
      api.duration = frames[frames.length - 1].t - frames[0].t;

      G.paused = true;
      SKY.HUD.setPause(false);
      SKY.HUD.combat(false);
      for (const p of G.pawns) {
        if (!p.avatar) continue;
        p.avatar.root.visible = false;
        p.avatar.proxyRoot.visible = false;
        if (p.avatar.nameSpr) p.avatar.nameSpr.visible = false;
      }
      beginSession();
      // start rolling the last few seconds — instant gratification
      seek(Math.max(0, api.duration - 6));
      setPlaying(true);
    },

    /* watch an archived round from the menu (MATCHES tab) */
    openArchive(rec) {
      if (api.active || SKY.Game.state !== 'menu') return;
      if (!rec || !rec.frames || rec.frames.length < 2 || !rec.roster) return;
      archived = rec;
      frames = rec.frames.slice();
      events = rec.events.slice();
      marks = (rec.marks || []).slice();
      roster = rec.roster.map(r => ({ ...r }));
      if (SKY.Map.currentId !== rec.map) SKY.Map.load(scene, rec.map);
      api.duration = frames[frames.length - 1].t - frames[0].t;
      beginSession();
      seek(0);
      setPlaying(true);
    },

    close() {
      if (!api.active) return;
      api.active = false;
      document.body.classList.remove('replaying');
      document.body.classList.remove('rp-hud');
      hudWasOn = false;
      ui.root.classList.add('hidden');
      setPlaying(false);
      for (const g of ghosts) {
        SKY.Grapple.disposeRope(g.stub);   // replayed ropes live on the stubs
        g.av.dispose();
      }
      ghosts = [];
      api._stubList = null;
      killDarts();
      // put mover meshes back where the live sim has them
      for (const m of SKY.World.movers) if (m.mesh) m.mesh.position.copy(m.c);
      SKY.Effects.setViewmodelVisible(false);
      SKY.Input.yaw = savedYaw; SKY.Input.pitch = savedPitch;
      SKY.Input.clearEdges();
      camera.fov = SKY.TUNING.camera.baseFov;
      camera.updateProjectionMatrix();
      if (document.pointerLockElement) document.exitPointerLock();
      if (archived) {
        // the clip project rides home with the demo (survives via IndexedDB)
        saveClip();
        archived.clips = clips.map(c => ({ ...c, kf: c.kf.map(k => ({ ...k })) }));
        if (SKY.Demos.persistRec) SKY.Demos.persistRec(archived);
        archived = null;
        wipe();
        SKY.Game.paused = false;
        return;
      }
      // un-hide the live match actors (their update() takes over on resume)
      for (const p of SKY.Game.pawns) {
        const av = p.avatar;
        if (!av) continue;
        if (av.ragActive) av.proxyRoot.visible = !p.isLocal;
        else av.root.visible = !p.isLocal && p.alive;
        if (av.nameSpr) av.nameSpr.visible = p.alive;
      }
      const st = SKY.Game.state;
      if (st === 'playing' || st === 'countdown') {
        // still mid-round: resume seamlessly if the mouse is captured,
        // otherwise land on the pause screen
        SKY.Game.paused = !SKY.Input.locked;
        SKY.HUD.setPause(SKY.Game.paused);
      } else {
        SKY.Game.paused = false;
      }
    },

    /* per-render-frame while active (replaces Game.renderTick) */
    frame(rdt) {
      const sdt = playing ? rdt * speed : 0;
      if (playing) {
        T += sdt;
        const end = playEnd();
        if (T >= end) {
          if (projPlaying && activeClip < clips.length - 1) {
            // project playback: roll straight into the next clip's cameras
            loadClip(activeClip + 1);
            seek(clips[activeClip].in);
          } else {
            T = end;
            projPlaying = false;
            setPlaying(false);
          }
        }
        const tAbs = frames.length ? frames[0].t + T : 0;
        while (evi < events.length && events[evi].t <= tAbs) { fire(events[evi]); evi++; }
      }
      pose(rdt);
      tickDarts(sdt);
      SKY.Effects.tick(rdt);
      cameraTick(rdt);
      SKY.Map.skyFollow(camera.position);
      autoFocusTick(rdt);
      // grapple ropes replayed from the snapshots (must run after the camera)
      if (api._stubList && api._stubList.length) {
        SKY.Grapple.updateVisuals(api._stubList, camera);
      }
      // POV shows the player's viewmodel (weapon in hand)
      const povGhost = camMode === 'pov' && ghosts[sel] && ghosts[sel].stub.alive
        ? ghosts[sel] : null;
      for (const g of ghosts) g.stub._pov = false;
      if (povGhost) {
        const s = povGhost.stub;
        s._pov = true;                       // rope starts at the hook gun tip
        if (s.weapon) SKY.Effects.ensureWeapon(s.weapon);
        SKY.Effects.setViewmodelVisible(!!(s.weapon || s.grapple));
        SKY.Effects.setHands(!!s.grapple);   // hook arm up while roped
        SKY.Effects.viewmodelMotion(rdt, s.speedH(), s.grounded, s.vel.y, s.sliding, -1);
      } else {
        SKY.Effects.setViewmodelVisible(false);
        SKY.Effects.setHands(false);
      }
      // POV + HUD toggle: drive the real game HUD off the ghost's snapshot
      if (povGhost && povHud) {
        const G = SKY.Game;
        document.body.classList.add('rp-hud');
        SKY.HUD.combat(true);
        hudWasOn = true;
        const sp = G.player, ss = G.state, sr = G.roundTime;
        G.player = povGhost.stub; G.state = 'playing'; G.roundTime = T;
        try { SKY.HUD.update(rdt); } catch (e) { /* HUD must never kill playback */ }
        G.player = sp; G.state = ss; G.roundTime = sr;
      } else if (hudWasOn) {
        hudWasOn = false;
        document.body.classList.remove('rp-hud');
        SKY.HUD.combat(false);
      }
      uiTick();
    },

    /* ---- video-export hooks (SKY.VidRender drives these) ---- */
    exportInfo() {
      return {
        clips: clips.map((c, i) => ({ i, in: c.in, out: c.out })),
        activeClip,
        start: playStart(),
        end: playEnd(),
      };
    },
    exportUseClip(i) { if (clips[i]) { loadClip(i); projPlaying = false; } },
    /* advance exactly one export frame (deterministic offline stepping) */
    exportStep(dt) {
      playing = true;                    // frame() only advances while playing
      const sp = speed;
      speed = 1;
      api.frame(dt);
      speed = sp;
    },
    exportSeek(t) { projPlaying = false; seek(t); setPlaying(true); },
    exportDone() { setPlaying(false); },

    /* render hook — returns true if a layer mode / DoF handled the frame */
    render(renderer, sc, cam) {
      if (layerMode === 1) { SKY.DoF.renderDepth(renderer, sc, cam, dvRange); return true; }
      if (layerMode === 2) { renderGreen(renderer, sc, cam); return true; }
      const d = effective();
      if (d.blur <= 0.001) return false;
      SKY.DoF.render(renderer, sc, cam, d.focus, d.blur, d.bokeh, d.rng);
      return true;
    },
  };

  return api;
})();
