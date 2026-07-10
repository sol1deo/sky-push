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

  function makeNadeMesh(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8),
      new THREE.MeshLambertMaterial({ color: 0x2c3140 }));
    const band = new THREE.Mesh(new THREE.SphereGeometry(0.135, 8, 4, 0, Math.PI * 2, 1.1, 0.5),
      new THREE.MeshBasicMaterial({ color }));
    g.add(body, band);
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
      mesh: makeNadeMesh(N.color), resting: false,
    });
    SKY.SFX.grapMiss();   // soft toss click
    return true;
  }

  /* knock everyone in a sphere (thrower-authoritative) */
  function blastKnock(center, radius, force, up, owner, auth) {
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
  }

  function tick(dt, pawns) {
    // ----- flying grenades -----
    for (let i = nades.length - 1; i >= 0; i--) {
      const n = nades[i];
      const N = SKY.TUNING.grenades[n.type];
      n.fuse -= dt;
      if (!n.resting) {
        n.vel.y -= 20 * dt;
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
          SKY.Effects.burst(n.pos, { count: 30, speed: 11, color: '#ffb06a', life: 0.7, size: 0.85 });
          SKY.Effects.burst(n.pos, { count: 6, speed: 3, color: '#ffffff', life: 0.18, size: 1.4, gravity: 0 });
          SKY.Effects.ring(n.pos.clone(), '#ffb06a', N.radius * 1.5, 0.45);
          SKY.Effects.muzzleLight(n.pos);
          SKY.SFX.boom();
          if (SKY.Game.player && SKY.Game.player.pos.distanceTo(n.pos) < N.radius + 4) SKY.Effects.shake(1.4);
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
      if (Math.random() < dt * 30) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * N.radius;
        SKY.Effects.burst(_v.set(pl.pos.x + Math.cos(a) * r, pl.pos.y + 0.1, pl.pos.z + Math.sin(a) * r),
          { count: 1, speed: 1.5, color: '#ff7a3a', gravity: -6, life: 0.5, size: 0.55 });
      }
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
          // flame column under whoever just got juggled
          _imp.set(p.pos.x, p.pos.y + 0.3, p.pos.z);
          SKY.Effects.burst(_imp, { count: 9, speed: 5, color: '#ff8a3a', gravity: -4, life: 0.5, size: 0.75 });
        }
      }
      if (pl.t <= 0) pools.splice(i, 1);
    }

    // ----- vortices -----
    for (let i = vortices.length - 1; i >= 0; i--) {
      const vx = vortices[i];
      const N = SKY.TUNING.grenades.vortex;
      vx.t -= dt;
      if (Math.random() < dt * 40) {
        const a = Math.random() * Math.PI * 2;
        SKY.Effects.burst(_v.set(vx.pos.x + Math.cos(a) * N.radius * 0.8, vx.pos.y + SKY.U.rand(-1, 2), vx.pos.z + Math.sin(a) * N.radius * 0.8),
          { count: 1, speed: 0.5, color: '#a48aff', gravity: 0, life: 0.4, size: 0.4 });
      }
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
    pools.push({ pos: n.pos.clone(), t: N.duration, tickT: 0, owner: n.owner, auth: n.auth });
    SKY.Effects.ring(n.pos.clone(), '#ff7a3a', N.radius * 1.6, 0.5);
    SKY.SFX.rumble();
    removeNade(i);
  }

  function removeNade(i) {
    scene.remove(nades[i].mesh);
    nades.splice(i, 1);
  }

  function clear() {
    for (let i = nades.length - 1; i >= 0; i--) removeNade(i);
    pools.length = 0; vortices.length = 0;
  }

  return {
    throwNade, tick, clear,
    spawnRemote(pawn, data) { throwNade(pawn, data); },
    init(sc) { scene = sc; },
  };
})();
