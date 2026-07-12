/* =============================================================================
 * SKY PUSH — grapple (pendulum rope)
 * E fires, hold to reel. Real rope physics:
 *   - the rope has a LENGTH (the attach distance); while you're inside it the
 *     rope is slack, outside it acts as a hard pendulum constraint — outward
 *     velocity is cancelled, so you actually SWING.
 *   - holding the key winches the length down (the reel-in).
 * Hooking a PLAYER works the other way: THEY get yanked and reeled to YOU.
 * Visuals: a thick tube that sags when slack and straightens when taut,
 * updated after the camera each frame so it never lags a frame behind.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Grapple = (function () {
  let scene = null;
  const _dir = new THREE.Vector3();
  const _eye = new THREE.Vector3();
  const _mid = new THREE.Vector3();
  const _to = new THREE.Vector3();
  const _imp = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _ptRay = new THREE.Vector3();
  const _ptSeg = new THREE.Vector3();
  const _losPt = new THREE.Vector3();
  const _ray = new THREE.Ray();
  const _start = new THREE.Vector3();
  const _ctrl = new THREE.Vector3();
  const _curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());

  /* world raycast with AIM ASSIST: if the exact crosshair ray misses, search
     a small cone around it — panic saves while falling should just work */
  const _adir = new THREE.Vector3();
  const _aup = new THREE.Vector3();
  const _aright = new THREE.Vector3();
  function assistRaycast(origin, dir, maxDist) {
    let hit = SKY.World.raycast(origin, dir, maxDist);
    if (hit) return hit;
    _aup.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.98) _aup.set(1, 0, 0);
    _aright.crossVectors(dir, _aup).normalize();
    _aup.crossVectors(_aright, dir);
    const base = SKY.TUNING.grapple.assistDeg * Math.PI / 180;
    for (const mult of [1, 2]) {
      const spread = Math.sin(base * mult);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        _adir.copy(dir)
          .addScaledVector(_aright, Math.cos(a) * spread)
          .addScaledVector(_aup, Math.sin(a) * spread)
          .normalize();
        hit = SKY.World.raycast(origin, _adir, maxDist);
        if (hit) return hit;
      }
    }
    return null;
  }

  /* nearest pawn the ray passes through (body capsule), or null */
  function raycastPawns(pawn, origin, dir, maxDist) {
    const R = SKY.TUNING.knock.bodyRadius + 0.15;   // hook is a bit forgiving
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    let best = null, bestT = maxDist;
    for (const p of SKY.Game.pawns) {
      if (p === pawn || !p.alive) continue;
      _a.set(p.pos.x, p.pos.y + 0.25, p.pos.z);
      _b.set(p.pos.x, p.pos.y + p.height - 0.2, p.pos.z);
      const d2 = _ray.distanceSqToSegment(_a, _b, _ptRay, _ptSeg);
      if (d2 > R * R) continue;
      const t = _ptRay.distanceTo(origin);
      if (t < bestT && SKY.World.los(origin, _ptSeg)) { bestT = t; best = p; }
    }
    return best ? { pawn: best, t: bestT } : null;
  }

  function tryFire(pawn) {
    const G = SKY.TUNING.grapple;
    if (!pawn.alive) return false;
    if (pawn.grapple) { release(pawn); return false; }   // press again = detach
    // heavy knock jammed the hook (pawn.hookLockT, set in applyKnockback) —
    // this also blocks the ragdoll-escape below, so a clean yeet STICKS.
    // Feedback is a mechanical jam CLUNK, not text — reads instantly mid-air.
    if (pawn.hookLockT > 0) {
      if (pawn.isLocal) SKY.SFX.jammed();
      return false;
    }
    // ONE hook per airtime — land (or take a hit) to refill
    const airborne = !pawn.grounded;
    if (airborne && pawn.airGrapples <= 0) {
      if (pawn.isLocal) SKY.SFX.grapMiss();
      return false;
    }
    if (pawn.ragdoll) {
      // heroic save: web out of an airborne tumble (headshot knockdowns stay)
      if (pawn.ragdoll.mode !== 'air') return false;
      pawn.exitRagdoll();
    }
    if (pawn.grappleCd > 0) { if (pawn.isLocal) SKY.SFX.grapMiss(); return false; }
    // IT hide phase: the frozen seeker can't rope-pull out of the freeze
    if (SKY.Game.mode === 'it' && pawn.isSeeker &&
        SKY.Game.roundTime < SKY.TUNING.it.hideTime) return false;

    SKY.U.dirFromYawPitch(pawn.yaw, pawn.pitch, _dir);
    pawn.eyePos(_eye);
    const range = G.range * pawn.mods.grappleRangeMult;
    const hit = assistRaycast(_eye, _dir, range);
    const ph = raycastPawns(pawn, _eye, _dir, hit ? hit.t : range);

    if (ph) {
      // hooked a PLAYER: yank them toward you, keep reeling while held
      const v = ph.pawn;
      pawn.grapple = { victim: v, point: v.midPos(new THREE.Vector3()).clone(), len: ph.t, t: 0, sendT: 0 };
      pawn.midPos(_mid);
      v.midPos(_to);
      _imp.copy(_mid).sub(_to).normalize().multiplyScalar(G.playerYank);
      _imp.y += G.playerYankUp;
      if (v.isRemote) {
        SKY.Net.sendHit(v.netId, [+_imp.x.toFixed(2), +_imp.y.toFixed(2), +_imp.z.toFixed(2)], false);
      } else {
        v.applyKnockback(_imp, pawn);
      }
      SKY.Effects.hitBurst(_to.clone(), 1, '#d8c49a');
      if (v.isLocal) SKY.Effects.shake(SKY.TUNING.camera.shakeHitTaken * 0.7);
      SKY.SFX.grapple();
      if (airborne) pawn.airGrapples--;
      return true;
    }
    if (!hit) {
      pawn.grappleCd = G.missCooldown;
      if (pawn.isLocal) SKY.SFX.grapMiss();
      return false;
    }
    pawn.grapple = {
      point: hit.point.clone(),
      solid: hit.solid,
      local: hit.point.clone().sub(hit.solid.c),
      len: Math.max(hit.point.distanceTo(_eye), 1.2),
      t: 0,
    };
    SKY.SFX.grapple();
    if (airborne) pawn.airGrapples--;
    return true;
  }

  function release(pawn) {
    if (!pawn.grapple) return;
    const G = SKY.TUNING.grapple;
    const frac = G.minCdFrac + (1 - G.minCdFrac) * SKY.U.clamp01(pawn.grapple.t / G.maxDuration);
    pawn.grapple = null;
    pawn.grappleCd = G.cooldown * frac * pawn.mods.grappleCdMult;
    if (pawn._rope) pawn._rope.visible = false;
  }

  function disposeRope(pawn) {
    if (!pawn._rope) return;
    scene.remove(pawn._rope);
    if (pawn._rope.geometry) pawn._rope.geometry.dispose();
    if (pawn._rope.material) pawn._rope.material.dispose();
    pawn._rope = null;
  }

  /* physics — runs at the fixed tick */
  function tick(dt, pawn) {
    const g = pawn.grapple;
    if (!g) return;
    const G = SKY.TUNING.grapple;

    // ---- hooked a player: reel THEM to YOU ----
    if (g.victim) {
      const v = g.victim;
      g.t += dt;
      if (v.alive) v.midPos(g.point);              // rope follows the body
      pawn.midPos(_mid);
      _to.copy(_mid).sub(g.point);
      const dist = _to.length();
      if (!v.alive || dist < G.playerBreakDist || g.t > G.playerDuration ||
          !pawn.cmd.grappleHeld || !pawn.alive || pawn.ragdoll) {
        release(pawn);
        return;
      }
      _to.multiplyScalar(1 / dist);
      if (v.isRemote) {
        // remote player: batch the pull into ~7 Hz impulses over the wire
        g.sendT -= dt;
        if (g.sendT <= 0) {
          g.sendT = 0.15;
          _imp.copy(_to).multiplyScalar(G.playerPull * 0.15);
          SKY.Net.sendHit(v.netId, [+_imp.x.toFixed(2), +_imp.y.toFixed(2), +_imp.z.toFixed(2)], false);
        }
      } else {
        v.vel.addScaledVector(_to, G.playerPull * dt);
        if (v.grounded && _to.y > -0.5) { v.grounded = false; v.vel.y = Math.max(v.vel.y, 2); }
        v.lastHitBy = pawn;
        v.lastHitT = SKY.Game.time;
      }
      return;
    }

    if (g.solid.isMover) g.point.copy(g.solid.c).add(g.local);
    g.t += dt;

    pawn.midPos(_mid);
    _to.copy(g.point).sub(_mid);
    const dist = _to.length();

    if (dist < G.breakDist || g.t > G.maxDuration || !pawn.cmd.grappleHeld ||
        (pawn.grounded && dist < 2.2) || !pawn.alive || pawn.ragdoll) {
      release(pawn);
      return;
    }
    _to.multiplyScalar(1 / dist);

    // rope SNAPS when geometry gets between you and the hook point — hooking
    // a floor from underneath no longer drags you up through the slab
    if (dist > 1.5) {
      _losPt.copy(g.point).addScaledVector(_to, -0.35);
      if (!SKY.World.los(_mid, _losPt)) {
        release(pawn);
        if (pawn.isLocal) SKY.SFX.grapMiss();
        return;
      }
    }

    // momentum reel: a near-vertical rope barely winches — climb by SWINGING
    // (tangential speed restores the full rate); dead-hanging goes nowhere
    const rm = Math.max(G.hangReelMin,
      SKY.U.clamp01(1.15 - _to.y),
      SKY.U.clamp01(pawn.vel.length() / G.swingSpeedFull));
    g.len = Math.max(G.breakDist + 0.3, g.len - G.reelSpeed * rm * dt);

    // pendulum constraint: outside the rope length, pull back in and kill
    // outward velocity (this is what makes it swing instead of drag)
    if (dist > g.len) {
      const excess = dist - g.len;
      pawn.pos.addScaledVector(_to, Math.min(excess, 1.2) * 0.85);
      const vr = pawn.vel.dot(_to);
      if (vr < 0) pawn.vel.addScaledVector(_to, -vr);
      pawn.grounded = false;
    }
    // gentle assist toward the point so short reels still feel powerful
    pawn.vel.addScaledVector(_to, G.pullAccel * 0.35 * rm * dt);
  }

  /* rope mesh: fixed-topology tube whose vertices are rewritten in place
     every frame (rebuilding a TubeGeometry per frame was a real CPU cost) */
  const ROPE_SEGS = 12, ROPE_RADIAL = 4, ROPE_R = 0.018;
  const _p = new THREE.Vector3();
  const _p2 = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  const _nrm = new THREE.Vector3();
  const _bin = new THREE.Vector3();

  function makeRopeMesh() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array((ROPE_SEGS + 1) * (ROPE_RADIAL + 1) * 3), 3));
    const idx = [];
    for (let i = 0; i < ROPE_SEGS; i++) {
      for (let j = 0; j < ROPE_RADIAL; j++) {
        const a = i * (ROPE_RADIAL + 1) + j, b = (i + 1) * (ROPE_RADIAL + 1) + j;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    geo.setIndex(idx);
    // MeshBasicMaterial needs no normals — positions only
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xd8c49a }));
    mesh.frustumCulled = false;
    return mesh;
  }

  function updateRopeGeometry(mesh) {
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i <= ROPE_SEGS; i++) {
      const t = i / ROPE_SEGS;
      _curve.getPoint(t, _p);
      _curve.getPoint(Math.min(1, t + 0.02), _p2);
      _tan.copy(_p2).sub(_p);
      if (_tan.lengthSq() < 1e-10) _tan.set(0, 1, 0); else _tan.normalize();
      _nrm.set(0, 1, 0);
      if (Math.abs(_tan.y) > 0.99) _nrm.set(1, 0, 0);
      _bin.crossVectors(_tan, _nrm).normalize();
      _nrm.crossVectors(_bin, _tan);
      for (let j = 0; j <= ROPE_RADIAL; j++) {
        const a = (j / ROPE_RADIAL) * Math.PI * 2;
        const cs = Math.cos(a) * ROPE_R, sn = Math.sin(a) * ROPE_R;
        const k = (i * (ROPE_RADIAL + 1) + j) * 3;
        pos.array[k]     = _p.x + _nrm.x * cs + _bin.x * sn;
        pos.array[k + 1] = _p.y + _nrm.y * cs + _bin.y * sn;
        pos.array[k + 2] = _p.z + _nrm.z * cs + _bin.z * sn;
      }
    }
    pos.needsUpdate = true;
  }

  /* visuals — call AFTER the camera has been positioned for this frame */
  function updateVisuals(pawns, camera) {
    for (const pawn of pawns) {
      const g = pawn.grapple;
      // dead pawns keep no rope (net-replicated grapples have no tick to
      // release them — the alive flag is the reliable signal)
      if (!g || !pawn.alive) { if (pawn._rope) pawn._rope.visible = false; continue; }

      // rope start: the HOOK-GUN tip for the local player, hand-ish for others
      if (pawn.isLocal) {
        camera.updateMatrixWorld();
        const tip = SKY.Effects.hookTip() || SKY.Effects.viewmodelTip();
        if (tip) _start.copy(tip);
        else pawn.eyePos(_start).y -= 0.25;
      } else {
        pawn.eyePos(_start);
        _start.y -= 0.2;
      }

      // sag: slack rope hangs, taut rope is straight
      const dist = _start.distanceTo(g.point);
      const slack = Math.max(0, g.len - dist);
      const sag = SKY.U.clamp(slack * 0.45, 0.02, 3.5);
      _ctrl.copy(_start).add(g.point).multiplyScalar(0.5);
      _ctrl.y -= sag;
      _curve.v0.copy(_start);
      _curve.v1.copy(_ctrl);
      _curve.v2.copy(g.point);

      // thin manila rope — reads on both bright and dark maps
      if (!pawn._rope) {
        pawn._rope = makeRopeMesh();
        scene.add(pawn._rope);
      }
      updateRopeGeometry(pawn._rope);
      pawn._rope.visible = true;
    }
  }

  return {
    tryFire, release, tick, updateVisuals, disposeRope,
    init(sc) { scene = sc; },
  };
})();
