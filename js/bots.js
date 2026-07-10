/* =============================================================================
 * SKY PUSH — bots (stand-ins for networked players in this MVP)
 * Bots drive a Pawn through the exact same cmd struct as the local player.
 * Survival brain, in priority order:
 *   1. PANIC — no ground below & falling: air-steer toward the nearest
 *      platform, grapple anything (including passing vehicles), spend dash.
 *   2. EDGE  — cliff ahead: leap it only when fast, otherwise turn to safety.
 *   3. FIGHT — chase/strafe/shoot the nearest visible enemy, parry incoming
 *      bolts, use the crown-holder as priority target in Crown Rush.
 *   4. ROAM  — wander between roam points (and moving vehicles on highway).
 * ============================================================================= */
window.SKY = window.SKY || {};

(function () {
  const _v = new THREE.Vector3();
  const _eye = new THREE.Vector3();
  const _mid = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);

  class Bot {
    constructor(pawn) {
      this.pawn = pawn;
      this.seed = Math.random() * 100;
      this.roamTarget = SKY.World.roamPoints.length
        ? SKY.U.pick(SKY.World.roamPoints).clone() : new THREE.Vector3();
      this.retargetT = 0;
      this.enemy = null;
      this.thinkT = Math.random() * 0.2;
      this.crouchT = 0;
      this.edgeDanger = false;
      this.noGroundBelow = false;
      this.safePoint = new THREE.Vector3();
      this.aimYaw = pawn.yaw;
      this.aimPitch = 0;
    }

    /* infrequent, more expensive decisions (raycasts etc.) */
    think(pawns) {
      const B = SKY.TUNING.bots;
      const p = this.pawn;
      p.eyePos(_eye);

      // is there ground under my feet (within 7m)?
      _v.set(p.pos.x, p.pos.y + 0.4, p.pos.z);
      this.noGroundBelow = !SKY.World.raycast(_v, _down, 7.5);

      // nearest safe point (static roam points + moving rides), for recovery
      this.safePoint.copy(this._nearestSafe());

      // enemy: crown holder first (Crown Rush), else nearest visible
      // (bomb mode: only the other team counts)
      this.enemy = null;
      const holder = SKY.Game.mode === 'crown' && SKY.Game.crownHolder;
      if (holder && holder !== p && holder.alive) {
        this.enemy = holder;
      } else {
        let bestD = B.fireRange * 1.3;
        for (const o of pawns) {
          if (o === p || !o.alive) continue;
          if (p.team && o.team === p.team) continue;
          const d = o.pos.distanceTo(p.pos);
          if (d < bestD && SKY.World.los(_eye, o.midPos(_mid))) {
            bestD = d; this.enemy = o;
          }
        }
      }

      // bomb mode: objective-driven targets
      if (SKY.Game.mode === 'bomb' && SKY.Game.bomb) {
        const bb = SKY.Game.bomb;
        const sites = SKY.World.bombSites;
        if (bb.phase === 'live' && sites.length) {
          if (p.team === 'atk') {
            if (bb.planted) this.roamTarget.copy(bb.pos);
            else if (bb.carrier === p) {
              if (!this.mySite || Math.random() < 0.02) this.mySite = SKY.U.pick(sites);
              this.roamTarget.copy(this.mySite.pos);
            } else if (!bb.carrier && bb.drop) this.roamTarget.copy(bb.drop);
            else if (bb.carrier) this.roamTarget.copy(bb.carrier.pos).x += SKY.U.rand(-4, 4);
          } else {
            if (bb.planted) this.roamTarget.copy(bb.pos);
            else {
              if (!this.mySite || this.retargetT <= 0) this.mySite = SKY.U.pick(sites);
              this.roamTarget.copy(this.mySite.pos).x += SKY.U.rand(-3, 3);
            }
          }
        }
        this.retargetT -= B.thinkInterval;
        if (this.retargetT <= 0) this.retargetT = SKY.U.rand(B.retargetMin, B.retargetMax);
        // still probe cliffs below
        this.edgeDanger = false;
        if (p.grounded && p.speedH() > 1) {
          const hs = p.speedH();
          _v.set(p.pos.x + (p.vel.x / hs) * B.edgeLookahead, p.pos.y + 0.5, p.pos.z + (p.vel.z / hs) * B.edgeLookahead);
          if (!SKY.World.raycast(_v, _down, 7)) this.edgeDanger = true;
        }
        return;
      }

      // roam retarget
      this.retargetT -= B.thinkInterval;
      const distToTarget = Math.hypot(this.roamTarget.x - p.pos.x, this.roamTarget.z - p.pos.z);
      if (this.retargetT <= 0 || distToTarget < 2) {
        this.retargetT = SKY.U.rand(B.retargetMin, B.retargetMax);
        const rides = SKY.World.rideSolids || [];
        if (SKY.Game.mode === 'crown' && !SKY.Game.crownHolder && Math.random() < 0.6) {
          this.roamTarget.copy(SKY.Game.crownPos());          // race for the crown!
        } else if (this.enemy && Math.random() < 0.45) {
          this.roamTarget.copy(this.enemy.pos);
        } else {
          // only board traffic that's actually close — chasing a truck across
          // the map is how bots used to speedrun losing all their lives
          let ride = null, rideD = 15;
          for (const r of rides) {
            const d = Math.hypot(r.c.x - p.pos.x, r.c.z - p.pos.z);
            if (d < rideD) { rideD = d; ride = r; }
          }
          if (ride && Math.random() < 0.6) {
            this.roamTarget.set(ride.c.x, ride.c.y + ride.h.y, ride.c.z);
          } else if (SKY.World.roamPoints.length) {
            this.roamTarget.copy(SKY.U.pick(SKY.World.roamPoints));
          }
        }
      }

      // cliff probe in the direction we're moving
      this.edgeDanger = false;
      if (p.grounded && p.speedH() > 1) {
        const hs = p.speedH();
        _v.set(p.pos.x + (p.vel.x / hs) * B.edgeLookahead, p.pos.y + 0.5, p.pos.z + (p.vel.z / hs) * B.edgeLookahead);
        if (!SKY.World.raycast(_v, _down, 7)) this.edgeDanger = true;
      }
    }

    _nearestSafe() {
      const p = this.pawn;
      let best = null, bestD = Infinity;
      for (const rp of SKY.World.roamPoints) {
        const d = Math.hypot(rp.x - p.pos.x, rp.z - p.pos.z);
        if (d < bestD) { bestD = d; best = rp; }
      }
      for (const s of (SKY.World.rideSolids || [])) {
        const d = Math.hypot(s.c.x - p.pos.x, s.c.z - p.pos.z);
        if (d < bestD) { bestD = d; best = s.c; }
      }
      return best || p.pos;
    }

    tick(dt, pawns, time) {
      const B = SKY.TUNING.bots;
      const p = this.pawn;
      if (!p.alive || p.ragdoll) return;   // ragdolling = stunned, no AI
      const cmd = p.cmd;
      cmd.mx = 0; cmd.mz = 0; cmd.jumpHeld = false;
      this.crouchT -= dt;
      cmd.crouch = this.crouchT > 0;

      this.thinkT -= dt;
      if (this.thinkT <= 0) { this.thinkT = B.thinkInterval; this.think(pawns); }

      const panicking = !p.grounded && this.noGroundBelow && p.vel.y < -2;

      /* ---- PANIC: recover or die ---- */
      if (panicking) {
        if (!p.grapple && p.grappleCd <= 0) this.tryRecoveryGrapple();
        if (p.abilities.dash && p.dashCd <= 0) {
          // dash toward safety
          _dir.copy(this.safePoint).sub(p.pos);
          this.aimYaw = Math.atan2(-_dir.x, -_dir.z);
          cmd.yaw = this.aimYaw; p.yaw = this.aimYaw;
          p.tryDash();
        }
      }
      cmd.grappleHeld = !!p.grapple && !p.grounded;

      /* ---- aiming (bullets travel now, so bots lead their targets) ---- */
      let wantYaw, wantPitch = 0;
      if (this.enemy && this.enemy.alive && !panicking) {
        this.enemy.midPos(_mid);
        const dist = _mid.distanceTo(p.pos);
        _mid.addScaledVector(this.enemy.vel, (dist / SKY.Weapons.defOf(p).projSpeed) * B.aimLead);
        p.eyePos(_eye);
        _dir.copy(_mid).sub(_eye);
        const hl = Math.hypot(_dir.x, _dir.z);
        wantYaw = Math.atan2(-_dir.x, -_dir.z);
        wantPitch = Math.atan2(_dir.y, hl);
        const err = B.aimErrorDeg * Math.PI / 180;
        wantYaw += Math.sin(time * 2.7 + this.seed) * err;
        wantPitch += Math.cos(time * 2.1 + this.seed) * err * 0.6;
      } else {
        const tgt = panicking ? this.safePoint : this.roamTarget;
        _dir.copy(tgt).sub(p.pos);
        wantYaw = Math.hypot(_dir.x, _dir.z) > 0.5 ? Math.atan2(-_dir.x, -_dir.z) : this.aimYaw;
      }
      const ts = B.turnSpeed * dt * (panicking ? 2.2 : 1);
      this.aimYaw += SKY.U.clamp(SKY.U.angDelta(this.aimYaw, wantYaw), -ts, ts);
      this.aimPitch = SKY.U.damp(this.aimPitch, SKY.U.clamp(wantPitch, -1.2, 1.2), 8, dt);
      cmd.yaw = this.aimYaw; cmd.pitch = this.aimPitch;

      /* ---- firing ---- */
      if (this.enemy && this.enemy.alive && !panicking) {
        const aligned = Math.abs(SKY.U.angDelta(this.aimYaw, wantYaw)) < B.fireAlignDeg * Math.PI / 180;
        const dist = this.enemy.pos.distanceTo(p.pos);
        if (aligned && dist < B.fireRange && p.pbCd <= 0 && Math.random() < B.fireChance * dt * 4) {
          SKY.Weapons.tryFirePrimary(p);
        }
        if (dist < B.cannonRange && p.acCd <= 0 && Math.random() < 1.5 * dt) {
          SKY.Weapons.tryFireAirCannon(p, pawns);
        }
        if (p.abilities.dash && p.dashCd <= 0 && dist > 10 && Math.random() < 0.4 * dt) {
          p.tryDash();
        }
      }

      /* ---- locomotion ---- */
      let tx, tz;
      if (panicking) {
        tx = this.safePoint.x; tz = this.safePoint.z;          // air-steer home!
      } else if (this.enemy && this.enemy.alive) {
        const dist = this.enemy.pos.distanceTo(p.pos);
        if (dist > 13) { tx = this.enemy.pos.x; tz = this.enemy.pos.z; }
        else if (dist < 4.5) { tx = p.pos.x * 2 - this.enemy.pos.x; tz = p.pos.z * 2 - this.enemy.pos.z; }
        else {
          const s = Math.sin(time * 0.7 + this.seed) > 0 ? 1 : -1;
          const ex = p.pos.x - this.enemy.pos.x, ez = p.pos.z - this.enemy.pos.z;
          tx = p.pos.x - ez * s; tz = p.pos.z + ex * s;
        }
      } else {
        tx = this.roamTarget.x; tz = this.roamTarget.z;
      }

      let mx = tx - p.pos.x, mz = tz - p.pos.z;
      const ml = Math.hypot(mx, mz);
      if (ml > 0.3) {
        mx /= ml; mz /= ml;
        if (this.edgeDanger && !panicking) {
          if (p.speedH() > 9) {
            cmd.jumpHeld = true; cmd.jumpPressed = true;       // commit to the gap
          } else {
            // hard turn to the nearest safe point, don't dribble off the edge
            mx = this.safePoint.x - p.pos.x; mz = this.safePoint.z - p.pos.z;
            const l2 = Math.hypot(mx, mz) || 1; mx /= l2; mz /= l2;
          }
        }
        const fx = -Math.sin(cmd.yaw), fz = -Math.cos(cmd.yaw);
        const rx = Math.cos(cmd.yaw), rz = -Math.sin(cmd.yaw);
        cmd.mz = SKY.U.clamp(mx * fx + mz * fz, -1, 1);
        cmd.mx = SKY.U.clamp(mx * rx + mz * rz, -1, 1);
      }

      // playful hops & power slides — never near an edge
      if (p.grounded && !this.edgeDanger && Math.random() < B.hopRate * dt) {
        cmd.jumpPressed = true; cmd.jumpHeld = true;
      }
      if (p.grounded && !this.edgeDanger && p.speedH() > 8 && this.crouchT <= 0 &&
          Math.random() < B.slideRate * dt) {
        this.crouchT = 0.6;
      }
    }

    tryRecoveryGrapple() {
      const p = this.pawn;
      const G = SKY.TUNING.grapple;
      p.eyePos(_eye);
      const range = G.range * p.mods.grappleRangeMult * 0.95;
      let best = null, bestD = range;
      for (const a of SKY.World.recoveryAnchors) {
        if (a.y < p.pos.y - 1.5) continue;
        const d = a.distanceTo(_eye);
        if (d < bestD) { best = a; bestD = d; }
      }
      // moving vehicles count as anchors too — grapple a passing truck!
      for (const s of (SKY.World.rideSolids || [])) {
        if (s.c.y < p.pos.y - 1.5) continue;
        const d = s.c.distanceTo(_eye);
        if (d < bestD) { best = s.c; bestD = d; }
      }
      if (!best) return;
      _dir.copy(best).sub(_eye);
      const hl = Math.hypot(_dir.x, _dir.z);
      this.aimYaw = Math.atan2(-_dir.x, -_dir.z);
      this.aimPitch = SKY.U.clamp(Math.atan2(_dir.y, hl), -1.2, 1.2);
      p.cmd.yaw = this.aimYaw; p.cmd.pitch = this.aimPitch;
      p.yaw = this.aimYaw; p.pitch = this.aimPitch;
      SKY.Grapple.tryFire(p);
    }
  }

  SKY.Bot = Bot;
})();
