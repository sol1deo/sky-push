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
  const HZ = 60;                 // snapshot rate (every 2nd physics tick)
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
  let roster = null;             // [{ name, color }] captured with the frames
  let recAcc = 0;
  let fxOrig = null;             // unwrapped SKY.Effects functions

  const FX = ['burst', 'ring', 'hitBurst', 'headshotBurst', 'impactSpark',
              'koBurst', 'muzzle', 'muzzleLight', 'cannonBlast', 'padRing',
              'respawnBeam', 'trailPuff', 'floatText'];

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
        if (!api.active && SKY.Game.state === 'playing') {
          events.push({ t: SKY.Game.time, fn: name, a: args.map(serArg) });
        }
        return orig(...args);
      };
    }
  }

  function wipe() {
    frames.length = 0;
    events.length = 0;
    roster = null;
    recAcc = 0;
  }

  /* called from Game.tick while state === 'playing' (after visualTick) */
  function record(dt) {
    if (api.active || SKY.Game.state !== 'playing') return;
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
      const g = p.grapple;
      const d = {
        p: [p.pos.x, p.pos.y, p.pos.z],
        v: [p.vel.x, p.vel.y, p.vel.z],
        yaw: p.yaw, pit: p.pitch, h: p.height, e: p.eyeHeight,
        w: Math.max(0, WK.indexOf(p.weapon)), f,
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
  }

  /* bullet spawns can't be caught via Effects — weapons.js calls this */
  function bullet(pos, vel, gravity, life) {
    if (api.active || SKY.Game.state !== 'playing') return;
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

  function fire(e) {
    if (e.fn === '__bullet') {
      const pos = new THREE.Vector3(e.p[0], e.p[1], e.p[2]);
      gb.push({
        pos,
        vel: new THREE.Vector3(e.v[0], e.v[1], e.v[2]),
        g: e.g, life: e.l, vis: makeDart(pos),
      });
      return;
    }
    const args = e.a.map(deserArg);
    if (e.fn === 'muzzle') args[2] = false;    // never kick the editor camera
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
      s.pos.set(SKY.U.lerp(a.p[0], b.p[0], u), SKY.U.lerp(a.p[1], b.p[1], u), SKY.U.lerp(a.p[2], b.p[2], u));
      s.vel.set(b.v[0], b.v[1], b.v[2]);
      s.yaw = a.yaw + SKY.U.angDelta(a.yaw, b.yaw) * u;
      s.pitch = SKY.U.lerp(a.pit, b.pit, u);
      s.height = SKY.U.lerp(a.h, b.h, u);
      s.eyeHeight = SKY.U.lerp(a.e, b.e, u);
      if (b.tv) s.tumbleVel.set(b.tv[0], b.tv[1], b.tv[2]);
      else s.tumbleVel.set(0, 0, 0);
      s.weapon = WK[b.w] || 'pistol';
      // POV HUD mirrors: weapon slots + recorded ammo
      s.slots[1] = s.weapon !== 'pistol' ? s.weapon : null;
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

  /* keyframe neighbours + smoothstep blend at time tt */
  function kfLerp(tt) {
    let i = 0;
    while (i < kf.length - 2 && kf[i + 1].t <= tt) i++;
    const a = kf[i], b = kf[Math.min(i + 1, kf.length - 1)];
    let s = tt <= a.t ? 0 : tt >= b.t ? 1 : (tt - a.t) / Math.max(1e-4, b.t - a.t);
    s = s * s * (3 - 2 * s);
    return { a, b, s };
  }

  /* is the camera currently driven by the keyframe path? */
  function onPath() {
    return camMode === 'keys' && kf.length >= 2 &&
           (playing || scrubbing || dragObj !== null);
  }

  function cameraTick(rdt) {
    const In = SKY.Input;
    if (onPath()) {
      // KEYS during playback/scrub: glide through the user's keyframes.
      // While paused you keep full free-fly control to line up the next key.
      const { a, b, s } = kfLerp(T);
      _v.fromArray(a.p); _v2.fromArray(b.p);
      camera.position.lerpVectors(_v, _v2, s);
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
        const fast = In.isDown('ShiftLeft') || In.isDown('ShiftRight');
        const sp = (fast ? 26 : 10) * rdt;
        SKY.U.dirFromYawPitch(In.yaw, In.pitch, _v);
        _v2.set(Math.cos(In.yaw), 0, -Math.sin(In.yaw));
        const mz = (In.action('forward') ? 1 : 0) - (In.action('back') ? 1 : 0);
        const mx = (In.action('right') ? 1 : 0) - (In.action('left') ? 1 : 0);
        const my = (In.isDown('KeyE') ? 1 : 0) - (In.isDown('KeyQ') ? 1 : 0);
        fcPos.addScaledVector(_v, mz * sp).addScaledVector(_v2, mx * sp);
        fcPos.y += my * sp;
        camera.position.copy(fcPos);
        camera.rotation.set(In.pitch, In.yaw, 0, 'YXZ');
        camera.fov = SKY.U.damp(camera.fov, freeFov, 12, rdt);
      }
    }
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
    k.focus = dof ? currentFocus() : null;
    k.blur = dof ? dofBlur : null;
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
  }

  /* ---------------- DoF ---------------- */
  function setDof(n) {
    dof = n;
    ui.dof.querySelectorAll('.rp-pill').forEach(b =>
      b.classList.toggle('sel', +b.dataset.d === n));
    ui.dofpanel.classList.toggle('hidden', !n);
    ui.focrow.style.display = n === 2 ? '' : 'none';
  }
  function focSliderToM(v) { return 0.5 * Math.pow(160, v); }   // 0.5 .. 80 m
  function focMToSlider(m) { return Math.log(m / 0.5) / Math.log(160); }

  /* focus/blur to use this frame (keyframed values win during path playback) */
  function effectiveDof() {
    if (!dof) return null;
    let focus = currentFocus(), blur = dofBlur;
    if (onPath()) {
      const { a, b, s } = kfLerp(T);
      const fa = a.focus !== null && a.focus !== undefined ? a.focus : focus;
      const fb = b.focus !== null && b.focus !== undefined ? b.focus : focus;
      const ba = a.blur !== null && a.blur !== undefined ? a.blur : blur;
      const bb = b.blur !== null && b.blur !== undefined ? b.blur : blur;
      focus = SKY.U.lerp(fa, fb, s);
      blur = SKY.U.lerp(ba, bb, s);
    }
    return { focus, blur };
  }

  function autoFocusTick(rdt) {
    if (dof !== 1 || !ghosts.length) return;
    // real-camera CENTER AF: focus the character nearest the middle of the
    // frame; nobody there -> the world under the crosshair; still nothing ->
    // hold the last focus (no snapping to infinity)
    _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    let target = -1, bestDot = 0.9;                 // ~26° cone around center
    ghosts.forEach((g, i) => {
      if (!g.stub.alive) return;
      if (camMode === 'pov' && i === sel) return;   // never AF on your own head
      _v2.set(g.stub.pos.x, g.stub.pos.y + g.stub.height * 0.6, g.stub.pos.z)
         .sub(camera.position);
      const d = _v2.length();
      if (d < 0.4) return;
      const dot = _v2.multiplyScalar(1 / d).dot(_v);
      if (dot > bestDot) { bestDot = dot; target = d; }
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
    dofAutoF = SKY.U.damp(dofAutoF, SKY.U.clamp(target, 0.5, 150), 8, rdt);
  }

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
    };
    ui.speeds.innerHTML = SPEEDS.map(s =>
      `<button class="rp-pill${s === 1 ? ' sel' : ''}" data-s="${s}">${s}×</button>`).join('');
    ui.cams.innerHTML = CAMS.map(([id, label]) =>
      `<button class="rp-pill${id === 'free' ? ' sel' : ''}" data-c="${id}">${label}</button>`).join('');
    ui.dof.innerHTML =
      `<button class="rp-pill sel" data-d="0">No DoF</button>` +
      `<button class="rp-pill" data-d="1">Auto</button>` +
      `<button class="rp-pill" data-d="2">Focus</button>`;

    ui.play.addEventListener('click', () => {
      if (!playing && T >= api.duration - 0.01) seek(0);
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
    ui.foc.addEventListener('input', () => {
      dofFocus = focSliderToM(+ui.foc.value);
      ui.focv.textContent = dofFocus < 10 ? dofFocus.toFixed(1) + 'm' : Math.round(dofFocus) + 'm';
    });
    // aperture reads as an f-number (small f = shallow depth = more blur)
    const fLabel = () => { ui.blurv.textContent = 'f/' + (1.2 / dofBlur).toFixed(1); };
    ui.blur.addEventListener('input', () => { dofBlur = +ui.blur.value; fLabel(); });
    fLabel();
    ui.bok.addEventListener('input', () => {
      dofBokeh = +ui.bok.value;
      ui.bokv.textContent = Math.round(dofBokeh * 100) + '%';
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
    ui.delkf.addEventListener('click', () => deleteKf(selKf));
    $('rp-clearkf').addEventListener('click', clearKf);
    $('rp-exit').addEventListener('click', () => api.close());

    /* ----- timeline: scrub, zoom, keyframe select/drag/delete ----- */
    ui.track.addEventListener('mousedown', (e) => {
      scrubbing = true; setPlaying(false); seek(xToTime(e.clientX));
    });
    ui.keys.addEventListener('mousedown', (e) => {
      const m = e.target.closest('.rp-kf');
      if (!m) return;
      e.stopPropagation();               // don't scrub underneath
      selKf = +m.dataset.i;
      if (e.button === 2) { deleteKf(selKf); return; }   // right-click = delete
      dragObj = kf[selKf];
      setPlaying(false);
      seek(dragObj.t);
      renderKf();
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
    ui.track.addEventListener('wheel', (e) => {
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
    ui.track.addEventListener('dblclick', () => {   // reset zoom
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
        if (!playing && T >= api.duration - 0.01) seek(0);
        setPlaying(!playing);
      }
      if (e.code === 'KeyK') addKf();
      if (e.code === 'Delete' || e.code === 'Backspace') deleteKf(selKf);
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
    kf.length = 0; selKf = -1; dragObj = null;
    viewStart = 0; viewEnd = api.duration;
    crossOn = false;
    povHud = false; hudWasOn = false;
    ui.crossbtn.classList.remove('sel');
    ui.hudbtn.classList.remove('sel');
    ui.namebtn.classList.toggle('sel', namesOn);
    setDof(0);
    dofAutoF = 10;
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

    /* snapshot the current buffer for the match-history archive */
    archive() {
      if (!roster || frames.length < HZ) return null;
      return {
        frames: frames.slice(),
        events: events.slice(),
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
        // demo from the menu: just drop our copies — the menu is still there
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
        if (T >= api.duration) { T = api.duration; setPlaying(false); }
        const tAbs = frames.length ? frames[0].t + T : 0;
        while (evi < events.length && events[evi].t <= tAbs) { fire(events[evi]); evi++; }
      }
      pose(rdt);
      tickDarts(sdt);
      SKY.Effects.tick(rdt);
      cameraTick(rdt);
      autoFocusTick(rdt);
      // grapple ropes replayed from the snapshots (must run after the camera)
      if (api._stubList && api._stubList.length) {
        SKY.Grapple.updateVisuals(api._stubList, camera);
      }
      // POV shows the player's viewmodel (weapon in hand)
      const povGhost = camMode === 'pov' && ghosts[sel] && ghosts[sel].stub.alive
        ? ghosts[sel] : null;
      if (povGhost) {
        const s = povGhost.stub;
        SKY.Effects.ensureWeapon(s.weapon);
        SKY.Effects.setViewmodelVisible(true);
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

    /* render hook — returns true if DoF handled the frame */
    render(renderer, sc, cam) {
      const d = effectiveDof();
      if (!d || d.blur <= 0.001) return false;
      SKY.DoF.render(renderer, sc, cam, d.focus, d.blur, dofBokeh);
      return true;
    },
  };

  return api;
})();
