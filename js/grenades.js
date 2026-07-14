/* =============================================================================
 * SKY PUSH — grenades (G to throw)
 *   HE      timed blast, radial knockback
 *   MOLLY   ignites on the ground into a fire pool that repeatedly launches
 *           anyone standing in it
 *   VORTEX  pulls every nearby player toward its center for a few seconds
 * Same authority rule as bullets: the thrower's sim owns the knockbacks;
 * remote victims are reported via SKY.Net.sendHit.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Grenades = (function () {
  let scene = null;
  const nades = [];      // in flight / cooking
  const pools = [];      // molly fire pools
  const vortices = [];
  const _dir = new THREE.Vector3();
  const _eye = new THREE.Vector3();
  const _imp = new THREE.Vector3();
  const _v = new THREE.Vector3();

  function makeNadeMesh(type) {
    // per-type silhouette (pineapple / canister / gyro orb) — shared with
    // the HUD icon and map pickups so the projectile reads instantly
    const g = SKY.Effects.buildNadeMesh(type);
    scene.add(g);
    return g;
  }

  function throwNade(pawn, netData) {
    let type, ori, vel;
    if (netData) {   // remote throw (visual + remote-owned authority rules)
      type = netData.type;
      ori = new THREE.Vector3(netData.ori[0], netData.ori[1], netData.ori[2]);
      vel = new THREE.Vector3(netData.vel[0], netData.vel[1], netData.vel[2]);
    } else {
      if (!pawn.alive || pawn.ragdoll || pawn.tauntT > 0) return false;
      if (SKY.Game.roundTime < 0.75) return false;   // no spawn/freeze cheese
      if (!pawn.nades || pawn.nades.count <= 0) { if (pawn.isLocal) SKY.SFX.dry(); return false; }
      type = pawn.nades.type;
      pawn.nades.count--;
      SKY.U.dirFromYawPitch(pawn.yaw, pawn.pitch, _dir);
      pawn.eyePos(_eye);
      ori = _eye.clone().addScaledVector(_dir, 0.5);
      const N = SKY.TUNING.grenades[type];
      vel = _dir.clone().multiplyScalar(N.throwSpeed).addScaledVector(pawn.vel, 0.4);
      vel.y += 3.5;
      if (SKY.Net.online && (pawn.isLocal || (SKY.Net.role === 'host' && pawn.isBot))) {
        SKY.Net.sendNade({
          id: pawn.netId, type,
          ori: [+ori.x.toFixed(2), +ori.y.toFixed(2), +ori.z.toFixed(2)],
          vel: [+vel.x.toFixed(2), +vel.y.toFixed(2), +vel.z.toFixed(2)],
        });
      }
    }
    const N = SKY.TUNING.grenades[type];
    const auth = !SKY.Net.online || !netData;
    nades.push({
      type, pos: ori, vel, owner: pawn, auth, trailT: 0,
      fuse: N.fuse + (type === 'molly' ? 3 : 0),   // molly mostly ignites on impact
      mesh: makeNadeMesh(type), resting: false,
    });
    if (pawn.isLocal) SKY.SFX.grapMiss();   // soft toss click
    return true;
  }

  /* knock everyone in a sphere (thrower-authoritative) */
  function blastKnock(center, radius, force, up, owner, auth) {
    let victims = 0;
    for (const p of SKY.Game.pawns) {
      if (!p.alive) continue;
      p.midPos(_v);
      const d = _v.distanceTo(center);
      if (d > radius) continue;
      const k = 1 - (d / radius) * 0.6;
      _imp.copy(_v).sub(center);
      if (_imp.lengthSq() < 0.01) _imp.set(0, 1, 0);
      _imp.normalize().multiplyScalar(force * k);
      _imp.y += up * k;
      if (!auth) continue;
      if (p !== owner) victims++;
      if (p.isRemote) {
        SKY.Net.sendHit(p.netId, [+_imp.x.toFixed(2), +_imp.y.toFixed(2), +_imp.z.toFixed(2)], false);
      } else {
        const wasAir = !p.grounded;
        p.applyKnockback(_imp, owner);
        if (force * k > SKY.TUNING.ragdoll.minAirForce && (wasAir || force * k > 14)) {
          p.enterRagdoll('air', _imp);
        }
      }
    }
    // the thrower gets a real hit confirm (same as blast weapons)
    if (victims > 0 && owner && owner.isLocal) {
      SKY.HUD.hitmark(2);
      SKY.Effects.shake(SKY.TUNING.camera.shakeHitDealt * 1.4);
      SKY.SFX.hit(0.8);
    }
  }

  function tick(dt, pawns) {
    // ----- flying grenades -----
    for (let i = nades.length - 1; i >= 0; i--) {
      const n = nades[i];
      const N = SKY.TUNING.grenades[n.type];
      n.fuse -= dt;
      if (!n.resting) {
        // underwater: thick drag + slow sink instead of a clean arc
        if (SKY.World.waterAt && SKY.World.waterAt(n.pos.x, n.pos.y, n.pos.z)) {
          n.vel.multiplyScalar(1 / (1 + 2.8 * dt));
          n.vel.y -= 4.5 * dt;
        } else n.vel.y -= 20 * dt;
        _v.copy(n.vel).multiplyScalar(dt);
        const len = _v.length();
        if (len > 1e-6) {
          _dir.copy(_v).multiplyScalar(1 / len);
          const hit = SKY.World.raycast(n.pos, _dir, len + 0.13);
          if (hit) {
            n.pos.copy(hit.point).addScaledVector(hit.normal, 0.14);
            if (n.type === 'molly' && hit.normal.y > 0.4) {
              igniteMolly(n, i);
              continue;
            }
            // one soft bounce, then rest
            if (!n.bounced) {
              n.bounced = true;
              const vn = n.vel.dot(hit.normal);
              n.vel.addScaledVector(hit.normal, -1.6 * vn).multiplyScalar(0.35);
            } else {
              n.resting = true;
              n.vel.set(0, 0, 0);
            }
          } else {
            n.pos.add(_v);
          }
        }
        n.mesh.position.copy(n.pos);
        n.mesh.rotation.x += dt * 8;
        // colored smoke trail so you can READ what's flying at you
        n.trailT -= dt;
        if (n.trailT <= 0) {
          n.trailT = 0.045;
          SKY.Effects.trailPuff(n.pos.clone(), '#' + new THREE.Color(N.color).getHexString());
        }
      }
      if (n.fuse <= 0) {
        if (n.type === 'he') {
          blastKnock(n.pos, N.radius, N.force, N.up, n.owner, n.auth);
          SKY.Effects.blastBoom(n.pos.clone(), N.radius * 0.8);
          const me = SKY.Game.player;
          const dMe = me && me.alive ? me.pos.distanceTo(n.pos) : 60;
          SKY.SFX.boom(Math.min(dMe, 40));
          if (dMe < N.radius + 4) SKY.Effects.shake(1.4);
          if (dMe < N.radius + 1) SKY.SFX.earRing(1 - dMe / (N.radius + 2));
        } else if (n.type === 'vortex') {
          vortices.push({ pos: n.pos.clone(), t: N.duration, owner: n.owner, auth: n.auth });
          SKY.Effects.ring(n.pos.clone(), '#a48aff', 4, 0.5);
          SKY.SFX.grapple();
        } else if (n.type === 'molly') {
          igniteMolly(n, i);
          continue;
        }
        removeNade(i);
      }
    }

    // ----- molly pools -----
    for (let i = pools.length - 1; i >= 0; i--) {
      const pl = pools[i];
      const N = SKY.TUNING.grenades.molly;
      pl.t -= dt;
      pl.tickT -= dt;
      // actual FIRE: several flame tongues per frame across the pool (denser
      // near the center), plus a flickering ground glow + real light
      for (let f = 0; f < 4; f++) {
        if (Math.random() > dt * 55) continue;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * N.radius * 0.9;
        SKY.Effects.flame(_v.set(pl.pos.x + Math.cos(a) * r, pl.pos.y + 0.08, pl.pos.z + Math.sin(a) * r),
          SKY.U.rand(0.85, 1.3));
      }
      const flick = 0.75 + Math.random() * 0.5;
      if (pl.glow) pl.glow.material.opacity = 0.24 * flick * Math.min(1, pl.t);
      if (pl.light) pl.light.intensity = 2.1 * flick * Math.min(1, pl.t + 0.3);
      if (pl.tickT <= 0) {
        pl.tickT = 0.3;
        for (const p of SKY.Game.pawns) {
          if (!p.alive) continue;
          const dx = p.pos.x - pl.pos.x, dz = p.pos.z - pl.pos.z;
          if (dx * dx + dz * dz > N.radius * N.radius) continue;
          if (Math.abs(p.pos.y - pl.pos.y) > 2) continue;
          _imp.set(dx, 0, dz);
          if (_imp.lengthSq() < 0.01) _imp.set(1, 0, 0);
          _imp.normalize().multiplyScalar(N.tickForce * 0.6);
          _imp.y = N.tickForce;
          if (!pl.auth) continue;
          if (p.isRemote) SKY.Net.sendHit(p.netId, [+_imp.x.toFixed(2), +_imp.y.toFixed(2), +_imp.z.toFixed(2)], false);
          else p.applyKnockback(_imp, pl.owner);
          // fire-tick confirm for the thrower (light — this repeats at 3Hz)
          if (p !== pl.owner && pl.owner && pl.owner.isLocal) SKY.HUD.hitmark(1);
          // flame column under whoever just got juggled
          _imp.set(p.pos.x, p.pos.y + 0.3, p.pos.z);
          for (let f = 0; f < 3; f++) SKY.Effects.flame(_imp, 1.4);
        }
      }
      if (pl.t <= 0) removePool(i);
    }

    // ----- vortices -----
    for (let i = vortices.length - 1; i >= 0; i--) {
      const vx = vortices[i];
      const N = SKY.TUNING.grenades.vortex;
      vx.t -= dt;
      // orbiting streaks — the cloud visibly ROTATES toward the center
      for (let s = 0; s < 3; s++) {
        if (Math.random() > dt * 55) continue;
        const a = Math.random() * Math.PI * 2, rr = N.radius * SKY.U.rand(0.35, 0.95);
        SKY.Effects.swirl(_v.set(vx.pos.x + Math.cos(a) * rr, vx.pos.y + SKY.U.rand(-1.2, 1.6),
          vx.pos.z + Math.sin(a) * rr), vx.pos, SKY.U.rand(5, 9));
      }
      if (Math.random() < dt * 2.5) SKY.Effects.ring(vx.pos.clone(), '#a48aff', N.radius * 0.9, 0.55);
      // every client pulls its OWN pawns (remote pawns are pulled by their
      // own sim, since all clients spawn the same vortex) — this is what
      // makes the vortex actually grab other players online
      for (const p of SKY.Game.pawns) {
        if (!p.alive || p.isRemote) continue;
        p.midPos(_v);
        const d = _v.distanceTo(vx.pos);
        if (d > N.radius || d < 0.4) continue;
        _imp.copy(vx.pos).sub(_v).normalize().multiplyScalar(N.pull * dt);
        p.vel.add(_imp);
        if (p.grounded && d > 1.5) { p.grounded = false; p.vel.y = Math.max(p.vel.y, 1.5); }
      }
      if (vx.t <= 0) {
        // FINALE: pop everyone it gathered
        blastKnock(vx.pos, N.radius * 0.6, N.popForce, N.popUp, vx.owner, vx.auth);
        SKY.Effects.burst(vx.pos, { count: 26, speed: 10, color: '#a48aff', life: 0.6, size: 0.8 });
        SKY.Effects.ring(vx.pos.clone(), '#a48aff', N.radius, 0.5);
        SKY.Effects.muzzleLight(vx.pos);
        SKY.SFX.boom();
        vortices.splice(i, 1);
      }
    }
  }

  function igniteMolly(n, i) {
    const N = SKY.TUNING.grenades.molly;
    // find the actual surface (the resting nade floats ~0.14 above it)
    const gh = SKY.World.raycast(_v.set(n.pos.x, n.pos.y + 0.2, n.pos.z), _imp.set(0, -1, 0), 3);
    const groundY = gh ? gh.point.y : n.pos.y - 0.14;
    // flickering ground glow disc + a real orange light over the pool
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(N.radius, 24),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ff6a26').convertSRGBToLinear(),
        transparent: true, opacity: 0.24, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(n.pos.x, groundY + 0.05, n.pos.z);
    const light = new THREE.PointLight(0xff7a30, 2.1, N.radius * 4.5, 2);
    light.position.set(n.pos.x, groundY + 1.2, n.pos.z);
    scene.add(glow, light);
    pools.push({ pos: n.pos.clone(), t: N.duration, tickT: 0, owner: n.owner, auth: n.auth,
      glow, light });
    SKY.Effects.ring(n.pos.clone(), '#ff7a3a', N.radius * 1.6, 0.5);
    // the pool chars the ground under it (outlives the fire a little)
    if (gh && SKY.Effects.scorch) {
      SKY.Effects.scorch(gh.point, gh.normal, N.radius * 1.15, N.duration + 7);
    }
    SKY.SFX.rumble();
    removeNade(i);
  }

  function removePool(i) {
    const pl = pools[i];
    if (pl.glow) scene.remove(pl.glow);
    if (pl.light) scene.remove(pl.light);
    pools.splice(i, 1);
  }

  function removeNade(i) {
    scene.remove(nades[i].mesh);
    nades.splice(i, 1);
  }

  function clear() {
    for (let i = nades.length - 1; i >= 0; i--) removeNade(i);
    for (let i = pools.length - 1; i >= 0; i--) removePool(i);
    vortices.length = 0;
  }

  return {
    throwNade, tick, clear,
    spawnRemote(pawn, data) { throwNade(pawn, data); },
    init(sc) { scene = sc; },
  };
})();
