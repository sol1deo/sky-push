/* =============================================================================
 * SKY PUSH — weapons (fast projectiles)
 * Bullets are glowing tracer darts with REAL travel time — near-instant up
 * close, dodgeable at range. Each gun's projSpeed sets that dial (pistol 46,
 * sniper 160). Per-tick segment sweeps catch heads, bodies and world.
 *
 * THE CORE MECHANIC (every weapon): knockback scales with the SHOOTER's speed
 * at fire time:
 *   force = baseKnockback + shooterSpeed * speedMult
 *   ... * airborneBonus / slideBonus / headshotMult
 *
 * CINEMATIC REACTIONS:
 *   headshot           -> victim ragdolls on the spot, stands back up
 *   hit while airborne -> victim ragdolls until close to the ground
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Weapons = (function () {
  let scene = null;
  const bullets = [];
  const _dir = new THREE.Vector3();
  const _pdir = new THREE.Vector3();
  const _eye = new THREE.Vector3();
  const _muzzle = new THREE.Vector3();
  const _tip = new THREE.Vector3();
  const _aim = new THREE.Vector3();
  const _imp = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _ptRay = new THREE.Vector3();
  const _ptSeg = new THREE.Vector3();
  const _ray = new THREE.Ray();
  const _sph = new THREE.Sphere();
  const _hitP = new THREE.Vector3();

  const TIERS = [
    { name: 'WEAK',   color: '#dfe7f2' },
    { name: 'SOLID',  color: '#7dd8ff' },
    { name: 'STRONG', color: '#ffd34d' },
    { name: 'MEGA',   color: '#ff5db1' },
  ];

  function defOf(pawn) {
    return SKY.TUNING.weapons[pawn.weapon] || SKY.TUNING.weapons.pistol;
  }

  /* momentum -> knockback. Also drives the crosshair power preview. */
  function computePush(pawn) {
    const W = defOf(pawn);
    let force = W.baseKnockback + pawn.speed3() * W.speedMult;
    if (!pawn.grounded) force *= W.airborneBonus;
    if (pawn.sliding) force *= W.slideBonus;
    force *= pawn.mods.powerMult;
    force = Math.min(force, W.maxKnockback * pawn.mods.powerMult);
    const total = force * (W.pellets > 1 ? W.pellets * 0.75 : 1);
    const tier = total < 8 ? 0 : total < 14 ? 1 : total < 21 ? 2 : 3;
    return { force, tier, name: TIERS[tier].name, color: TIERS[tier].color };
  }

  function tryReload(pawn) {
    const W = defOf(pawn);
    if (!pawn.alive || pawn.reloadT > 0 || pawn.ammo >= W.mag || pawn.ragdoll) return false;
    pawn.reloadT = W.reloadTime * pawn.mods.cdMult;
    if (pawn.isLocal) SKY.SFX.reload();
    return true;
  }

  /* pooled dart visuals — spawning/despawning bullets allocates nothing */
  const dartPool = [];
  function makeBulletVisual(color, at) {
    let v = dartPool.pop();
    if (!v) v = SKY.Effects.makeTracer();
    // reset to the muzzle so the first rendered frame isn't stale
    if (at) SKY.Effects.resetTracer(v, at);
    v.g.visible = true;
    return v;
  }

  function tryFirePrimary(pawn) {
    const W = defOf(pawn);
    if (pawn.pbCd > 0 || !pawn.alive || pawn.tauntT > 0 || pawn.ragdoll || pawn.reloadT > 0) return false;
    if (pawn.grapple || pawn.drawT > 0) return false;   // hook arm out / mid-draw
    if (SKY.Game.roundTime < 0.75) return false;   // no spawn-cheese at GO!
    if (pawn.ammo <= 0) {
      if (pawn.isLocal) SKY.SFX.dry();
      tryReload(pawn);
      return false;
    }
    pawn.pbCd = W.cooldown * pawn.mods.cdMult;
    pawn.ammo--;

    const push = computePush(pawn);
    SKY.U.dirFromYawPitch(pawn.yaw, pawn.pitch, _dir);
    pawn.eyePos(_eye);
    // Bullets leave the actual gun BARREL (viewmodel tip for the local player,
    // the avatar's third-person gun for bots/remotes) and converge onto the
    // eye-ray aim point, so shots still land exactly on the crosshair.
    _muzzle.copy(_eye).addScaledVector(_dir, 0.55);
    _muzzle.y -= 0.1;                              // fallback: near-eye
    const tip = pawn.isLocal ? SKY.Effects.viewmodelTip()
      : pawn.avatar ? pawn.avatar.gunTipWorld(_tip) : null;
    const wallHit = SKY.World.raycast(_eye, _dir, W.range);
    const aimDist = wallHit ? wallHit.t : W.range;
    // point-blank / barrel-in-wall: keep the eye muzzle so nothing spawns
    // behind geometry
    if (tip && aimDist > 2.0 && SKY.World.los(_eye, tip)) {
      _muzzle.copy(tip);
      _aim.copy(_eye).addScaledVector(_dir, aimDist);
      _dir.copy(_aim).sub(_muzzle).normalize();
    }

    _up.set(0, 1, 0);
    _right.crossVectors(_dir, _up).normalize();
    _up.crossVectors(_right, _dir);
    const spread = (pawn.zoomed ? W.zoomSpreadDeg : W.spreadDeg) * Math.PI / 180;

    // shooter-authoritative bullets: mine, or a bot's if I'm the host
    const auth = !SKY.Net.online || pawn.isLocal || (SKY.Net.role === 'host' && pawn.isBot);
    const netDirs = [];
    for (let i = 0; i < (W.pellets || 1); i++) {
      _pdir.copy(_dir);
      if (spread > 0) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * spread;
        _pdir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
      }
      netDirs.push([+_pdir.x.toFixed(3), +_pdir.y.toFixed(3), +_pdir.z.toFixed(3)]);
      bullets.push({
        pos: _muzzle.clone(),
        prev: _muzzle.clone(),
        vel: _pdir.clone().multiplyScalar(W.projSpeed).addScaledVector(pawn.vel, 0.25),
        force: push.force, tier: push.tier, color: push.color,
        up: W.upFactor, headMult: W.headshotMult, maxK: W.maxKnockback,
        gravity: W.projGravity || 0,
        blast: W.blastRadius || 0, blastUp: W.blastUp || 0,
        owner: pawn, auth,
        life: W.range / W.projSpeed + 0.15,
        vis: makeBulletVisual(0xffe2a8, _muzzle),
      });
      SKY.Replay.bullet(_muzzle, bullets[bullets.length - 1].vel,
        W.projGravity || 0, W.range / W.projSpeed + 0.15);
    }
    if (SKY.Net.online && auth) {
      SKY.Net.sendFire({
        id: pawn.netId, w: pawn.weapon,
        ori: [+_muzzle.x.toFixed(2), +_muzzle.y.toFixed(2), +_muzzle.z.toFixed(2)],
        dirs: netDirs, force: +push.force.toFixed(2), tier: push.tier,
      });
    }

    // recoil + feedback
    pawn.vel.addScaledVector(_dir, -W.selfRecoil);
    if (pawn.grounded && pawn.vel.y > 1) pawn.grounded = false;
    SKY.Effects.muzzle(_muzzle, W.color, pawn.isLocal, W.kick);
    SKY.Effects.muzzleLight(_muzzle);
    SKY.SFX.fire(push.tier / 3, W.kick);
    if (pawn.isLocal) {
      SKY.Effects.shake(SKY.TUNING.camera.shakeFire * W.kick);
      // RECOIL: kick the view up with a hair of horizontal jitter — recovers
      // by the player pulling back down (per-weapon TUNING.weapons.*.kickPitch)
      SKY.Input.pitch = SKY.U.clamp(SKY.Input.pitch + (W.kickPitch || 0), -1.55, 1.55);
      SKY.Input.yaw += SKY.U.rand(-0.35, 0.35) * (W.kickPitch || 0);
    }

    if (pawn.ammo <= 0) tryReload(pawn);
    return true;
  }

  /* one simulation step of one bullet: sweep prev->pos against everything */
  function sweep(b, segLen) {
    _ray.origin.copy(b.prev);
    _ray.direction.copy(_dir);
    let bestT = segLen + 0.01, hitPawn = null, head = false, world = null;
    const wh = SKY.World.raycast(b.prev, _dir, segLen);
    if (wh) { bestT = wh.t; world = wh; }

    const K = SKY.TUNING.knock;
    for (const p of SKY.Game.pawns) {
      if (p === b.owner || !p.alive) continue;
      let pawnT = Infinity, pawnHead = false;
      _sph.center.set(p.pos.x, p.pos.y + p.eyeHeight + 0.05, p.pos.z);
      _sph.radius = K.headRadius;
      if (_ray.intersectSphere(_sph, _hitP)) {
        const t = _hitP.distanceTo(b.prev);
        if (t <= segLen && t < pawnT) { pawnT = t; pawnHead = true; }
      }
      _a.set(p.pos.x, p.pos.y + 0.25, p.pos.z);
      _b.set(p.pos.x, p.pos.y + p.height - 0.2, p.pos.z);
      const d2 = _ray.distanceSqToSegment(_a, _b, _ptRay, _ptSeg);
      if (d2 < K.bodyRadius * K.bodyRadius) {
        const t = _ptRay.distanceTo(b.prev);
        if (t <= segLen && t < pawnT) pawnT = t;   // head keeps priority
      }
      if (pawnT < bestT) { bestT = pawnT; hitPawn = p; head = pawnHead; world = null; }
    }
    return { t: bestT, pawn: hitPawn, head, world };
  }

  function removeBullet(i) {
    const b = bullets[i];
    b.vis.g.visible = false;
    dartPool.push(b.vis);
    bullets.splice(i, 1);
  }

  function tick(dt, pawns) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.life -= dt;
      b.vel.y -= b.gravity * dt;
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      _dir.copy(b.pos).sub(b.prev);
      const segLen = _dir.length();
      if (segLen < 1e-6) continue;
      _dir.multiplyScalar(1 / segLen);

      const res = sweep(b, segLen);
      if (res.pawn || res.world) {
        const point = b.prev.clone().addScaledVector(_dir, res.t);
        if (b.blast > 0) {
          // LOBBER shells: area blast wherever they land
          if (b.auth) blastAt(point, b.blast, b.force, b.blastUp, b.owner);
          SKY.Effects.burst(point.clone(), { count: 18, speed: 8, color: b.color, life: 0.5, size: 0.6 });
          SKY.Effects.ring(point.clone(), b.color, b.blast * 1.5, 0.35);
          SKY.SFX.boom();
          removeBullet(i);
          continue;
        }
        if (res.pawn && b.auth) {
          const victim = res.pawn;
          const wasAirborne = !victim.grounded;
          let force = b.force * (res.head ? b.headMult : 1);
          force = Math.min(force, b.maxK * (res.head ? 1.7 : 1));
          _imp.copy(_dir).multiplyScalar(force);
          _imp.y += force * b.up * (res.head ? 1.25 : 1);

          if (victim.isRemote) {
            // another player's pawn: report the hit, their client applies it
            SKY.Net.sendHit(victim.netId, [+_imp.x.toFixed(2), +_imp.y.toFixed(2), +_imp.z.toFixed(2)], res.head);
          } else {
            victim.applyKnockback(_imp, b.owner);
            if (res.head) victim.enterRagdoll(victim.grounded ? 'head' : 'air', _imp);
            else if (wasAirborne && force > SKY.TUNING.ragdoll.minAirForce) victim.enterRagdoll('air', _imp);
          }
          if (res.head) {
            SKY.Effects.headshotBurst(point.clone());
            SKY.Effects.muzzleLight(point);              // impact flash
            SKY.SFX.headshot();
            if (b.owner && b.owner.isLocal) { SKY.HUD.hitmark(3, true); SKY.Effects.shake(0.5); }
            if (Math.random() < 0.35) {
              SKY.Effects.floatText(point.clone().add(new THREE.Vector3(0, 0.6, 0)), 'BONK!', '#ff6a6a');
            }
          } else {
            SKY.Effects.hitBurst(point.clone(), b.tier, b.color);
            SKY.Effects.impactSpark(point.clone(), _dir.clone().negate());  // backsplash
            SKY.Effects.muzzleLight(point);              // impact flash
            SKY.SFX.hit(b.tier / 3);
            if (b.owner && b.owner.isLocal) {
              SKY.HUD.hitmark(b.tier);
              SKY.Effects.shake(SKY.TUNING.camera.shakeHitDealt);
            }
          }
          if (victim.isLocal) SKY.Effects.shake(SKY.TUNING.camera.shakeHitTaken);
        } else if (res.pawn) {
          // remote-owned bullet: cosmetic impact only (their sim decides)
          SKY.Effects.hitBurst(point.clone(), 0, b.color);
        } else {
          SKY.Effects.impactSpark(point, res.world.normal);
        }
        removeBullet(i);
        continue;
      }

      // streak visual: bright head + tapered glow ribbon behind
      SKY.Effects.poseTracer(b.vis, b.pos, _dir, Math.min(2.2, segLen * 6 + 0.5));

      if (b.life <= 0 || b.pos.y < SKY.World.killY - 6) removeBullet(i);
    }
  }

  function clear() { for (let i = bullets.length - 1; i >= 0; i--) removeBullet(i); }

  /* radial knock helper (lobber shells) */
  function blastAt(center, radius, force, up, owner) {
    const mid = new THREE.Vector3();
    for (const p of SKY.Game.pawns) {
      if (!p.alive) continue;
      p.midPos(mid);
      const d = mid.distanceTo(center);
      if (d > radius) continue;
      const k = 1 - (d / radius) * 0.6;
      _imp.copy(mid).sub(center);
      if (_imp.lengthSq() < 0.01) _imp.set(0, 1, 0);
      _imp.normalize().multiplyScalar(force * k);
      _imp.y += up * k;
      if (p.isRemote) {
        SKY.Net.sendHit(p.netId, [+_imp.x.toFixed(2), +_imp.y.toFixed(2), +_imp.z.toFixed(2)], false);
      } else {
        const wasAir = !p.grounded;
        p.applyKnockback(_imp, owner === p ? null : owner);
        if (wasAir && force * k > SKY.TUNING.ragdoll.minAirForce) p.enterRagdoll('air', _imp);
      }
    }
  }

  function tryFireAirCannon(pawn, pawns) {
    const C = SKY.TUNING.cannon;
    if (pawn.acCd > 0 || !pawn.alive || pawn.tauntT > 0 || pawn.ragdoll) return false;
    if (SKY.Game.roundTime < 0.75) return false;
    pawn.acCd = C.cooldown * pawn.mods.cdMult;

    SKY.U.dirFromYawPitch(pawn.yaw, pawn.pitch, _dir);
    pawn.eyePos(_eye);
    const cosHalf = Math.cos((C.coneDeg * Math.PI / 180) / 2);

    for (const p of pawns) {
      if (p === pawn || !p.alive) continue;
      p.midPos(_a);
      _b.copy(_a).sub(_eye);
      const dist = _b.length();
      if (dist > C.range || dist < 0.01) continue;
      _b.multiplyScalar(1 / dist);
      if (_b.dot(_dir) < cosHalf) continue;
      if (!SKY.World.los(_eye, _a)) continue;

      let force = C.baseKnockback + pawn.speed3() * C.speedMult;
      force *= 1 - 0.5 * (dist / C.range);
      _imp.copy(_b).multiplyScalar(force);
      _imp.y += force * C.upFactor;
      const wasAirborne = !p.grounded;
      if (p.isRemote) {
        SKY.Net.sendHit(p.netId, [+_imp.x.toFixed(2), +_imp.y.toFixed(2), +_imp.z.toFixed(2)], false);
      } else {
        p.applyKnockback(_imp, pawn);
        if (wasAirborne && force > SKY.TUNING.ragdoll.minAirForce) p.enterRagdoll('air', _imp);
      }
      SKY.Effects.hitBurst(_a.clone(), 2, '#bfe9ff');
      if (p.isLocal) SKY.Effects.shake(SKY.TUNING.camera.shakeHitTaken);
    }

    pawn.vel.addScaledVector(_dir, -C.selfRecoil);
    if (pawn.vel.y > 1) pawn.grounded = false;
    SKY.Effects.cannonBlast(_eye.clone().addScaledVector(_dir, 1.2), _dir.clone());
    SKY.SFX.airCannon();
    if (pawn.isLocal) { SKY.Effects.shake(0.8); SKY.HUD.hitmark(1); }
    return true;
  }

  /* visual-only bullets fired by a remote player (their sim owns the hits) */
  function spawnRemote(pawn, m) {
    const W = SKY.TUNING.weapons[m.w] || SKY.TUNING.weapons.pistol;
    const ori = new THREE.Vector3(m.ori[0], m.ori[1], m.ori[2]);
    for (const d of m.dirs) {
      bullets.push({
        pos: ori.clone(), prev: ori.clone(),
        vel: new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(W.projSpeed),
        force: m.force, tier: m.tier, color: TIERS[m.tier].color,
        up: W.upFactor, headMult: W.headshotMult, maxK: W.maxKnockback,
        gravity: W.projGravity || 0,
        owner: pawn, auth: false,
        life: W.range / W.projSpeed + 0.15,
        vis: makeBulletVisual(0xffe2a8, ori),
      });
    }
    SKY.Effects.muzzle(ori, W.color, false, W.kick);
    SKY.SFX.fire(m.tier / 3, W.kick * 0.6);
  }

  return {
    TIERS, computePush, defOf, tryFirePrimary, tryFireAirCannon, tryReload,
    tick, clear, spawnRemote,
    init(sc) { scene = sc; },
  };
})();
