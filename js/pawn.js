/* =============================================================================
 * SKY PUSH — Pawn: the shared physics body for the player AND bots.
 * Both are driven through the same `cmd` struct (move axes, jump, crouch, aim),
 * which is exactly the shape a networked player's input packet would take —
 * so real netcode can slot in later without touching movement code.
 *
 * Movement model: Quake/Source style —
 *   ground: friction then accelerate toward wishdir
 *   air:    airAccelerate (strafe gains) + CPM-style mouse turn (W-steering)
 *   bhop:   jumping on the landing tick skips friction -> momentum is kept
 *
 * Death rewards can modify a pawn via `mods` (multipliers) and `abilities`
 * (double jump, dash) — see loot.js.
 * ============================================================================= */
window.SKY = window.SKY || {};

(function () {
  const _wish = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _rayO = new THREE.Vector3();

  class Pawn {
    constructor(opts) {
      const T = SKY.TUNING.move;
      this.name = opts.name;
      this.color = opts.color;
      this.isLocal = !!opts.isLocal;

      this.pos = new THREE.Vector3();      // feet position
      this.vel = new THREE.Vector3();
      this.yaw = 0; this.pitch = 0;
      this.radius = T.radius;
      this.height = T.standHeight;
      this.eyeHeight = T.eyeStand;

      this.grounded = false;
      this.groundNormal = new THREE.Vector3(0, 1, 0);
      this.groundSolid = null;
      this._groundedPrev = false;

      this.sliding = false; this.slideT = 0; this.slideCd = 0;
      this.crouching = false;
      this.jumpBufferT = 0; this.coyoteT = 0; this.timeSinceJump = 10;
      this.padLockT = 0;

      // weapon & loadout state (bots share all of this — same rules for everyone)
      this.weapon = 'pistol';
      this.pbCd = 0; this.acCd = 0; this.grappleCd = 0; this.grapple = null;
      this.mods = {                       // multipliers from death-reward powerups
        speedMult: 1, jumpMult: 1, cdMult: 1,
        knockResist: 1, grappleRangeMult: 1, grappleCdMult: 1,
        magMult: 1, gravMult: 1, powerMult: 1,
      };
      this.abilities = { doubleJump: false, dash: false, pound: false };
      this.owned = new Set();             // powerup/ability ids already taken
      this.airJumps = 0; this.dashCd = 0;
      this.airGrapples = 1;               // hooks left this airtime (grapple.js)
      this.hookLockT = 0;                 // heavy knock jams the hook briefly
      this.pounding = false; this._crouchWas = false;

      // grenades (G)
      this.nades = { ...SKY.TUNING.nadeStart };

      // SPARK RUSH: banked sparks + claimed level-ups; deaths scatter the
      // drop where you LAST STOOD, not into the void you fell into
      this.sparks = 0;
      this.sparkLevel = 0;
      this.lastGroundPos = new THREE.Vector3();

      // online: bumped by the host each respawn, echoed by the client in its
      // state stream — lets the host drop stale pre-respawn snapshots
      this.respawnSeq = 0;

      // taunt (T)
      this.tauntT = 0;

      // ammo & aiming
      this.ammo = SKY.TUNING.weapons.pistol.mag;
      this.reloadT = 0;
      this.zoomed = false;

      // two-slot inventory: 1 = picked-up weapon, 2 = the trusty pistol
      this.slots = { 1: null, 2: 'pistol' };
      this.slotAmmo = { 1: 0, 2: SKY.TUNING.weapons.pistol.mag };
      this.activeSlot = 2;
      this.drawT = 0;                     // weapon-draw lockout after a switch

      // ragdoll: null | { mode:'head'|'air', t } — control is locked while set
      this.ragdoll = null;
      this.ragdollImpulse = new THREE.Vector3();

      // match state
      this.lives = SKY.TUNING.game.lives;
      this.alive = true; this.eliminated = false; this.deadT = 0;
      this.koCount = 0; this.deaths = 0;
      this.roundWins = 0;                    // rounds won this match
      this.crownTime = 0;                    // Crown Rush score (seconds held)
      this.lastHitBy = null; this.lastHitT = -99;
      this.fellScreamed = false;

      this.tumbleVel = new THREE.Vector3();  // funny mid-air spin after big hits
      this._landSquash = 0;

      this.cmd = { mx: 0, mz: 0, jumpHeld: false, jumpPressed: false, crouch: false, grappleHeld: false, yaw: 0, pitch: 0 };
    }

    speedH() { return Math.hypot(this.vel.x, this.vel.z); }
    speed3() { return this.vel.length(); }
    eyePos(out) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); }
    midPos(out) { return out.set(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z); }

    /* =================== physics tick =================== */
    tick(dt) {
      const T = SKY.TUNING.move;
      const cmd = this.cmd;

      // timers
      this.pbCd = Math.max(0, this.pbCd - dt);
      this.acCd = Math.max(0, this.acCd - dt);
      this.grappleCd = Math.max(0, this.grappleCd - dt);
      this.hookLockT = Math.max(0, this.hookLockT - dt);
      this.slideCd = Math.max(0, this.slideCd - dt);
      this.padLockT = Math.max(0, this.padLockT - dt);
      this.dashCd = Math.max(0, this.dashCd - dt);
      this.tauntT = Math.max(0, this.tauntT - dt);
      this.drawT = Math.max(0, this.drawT - dt);
      this.timeSinceJump += dt;

      // reload completes
      if (this.reloadT > 0) {
        this.reloadT -= dt;
        if (this.reloadT <= 0) {
          this.ammo = Math.round(SKY.Weapons.defOf(this).mag * this.mods.magMult);
          if (this.isLocal) SKY.SFX.reloadDone();
        }
      }

      this.yaw = cmd.yaw; this.pitch = cmd.pitch;

      // ---- ragdoll: no control until we recover ----
      if (this.ragdoll) {
        const R = SKY.TUNING.ragdoll;
        this.ragdoll.t -= dt;
        cmd.mx = 0; cmd.mz = 0; cmd.jumpPressed = false;
        this.sliding = false; this.crouching = false;
        this.height = SKY.TUNING.move.crouchHeight;
        this.eyeHeight = SKY.U.damp(this.eyeHeight, 0.6, 10, dt);
        // physics: gravity + friction, no steering
        if (this.grounded) {
          this._friction(dt, SKY.TUNING.move.friction * 0.55);
          this.vel.y = -SKY.TUNING.move.groundStick;
        } else {
          this.vel.y -= SKY.TUNING.move.gravity * dt;
        }
        const prevG = this._groundedPrev;
        this.pos.addScaledVector(this.vel, dt);
        const res = SKY.World.resolvePawn(this.pos, this.vel, this.radius, this.height);
        this.grounded = res.grounded;
        this._groundedPrev = this.grounded;
        // recovery rules
        if (this.ragdoll.mode === 'head') {
          if (this.grounded && this.ragdoll.t <= 0) this.exitRagdoll();
        } else {
          if (this.grounded) this.exitRagdoll();
          else if (this.vel.y < 0) {
            _rayO.set(this.pos.x, this.pos.y + 0.2, this.pos.z);
            const hit = SKY.World.raycast(_rayO, _down, R.recoverHeight + 0.2);
            if (hit) this.exitRagdoll();
          }
          if (this.ragdoll && this.ragdoll.t < -4) this.exitRagdoll();  // safety
        }
        if (this.grounded && this.groundSolid && this.groundSolid.isMover) {
          this.pos.add(this.groundSolid.delta);
        }
        return;
      }

      // wish direction (world space, horizontal)
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      _wish.set(0, 0, 0).addScaledVector(_fwd, cmd.mz).addScaledVector(_right, cmd.mx);
      const wishLen = _wish.length();
      if (wishLen > 1e-4) _wish.multiplyScalar(1 / wishLen);

      // jump buffering / coyote time / auto-bhop
      if (cmd.jumpPressed) this.jumpBufferT = T.jumpBufferTime;
      else this.jumpBufferT = Math.max(0, this.jumpBufferT - dt);
      const wantJump = this.jumpBufferT > 0 || (T.autoBhop && cmd.jumpHeld);
      this.coyoteT = this.grounded ? T.coyoteTime : Math.max(0, this.coyoteT - dt);
      if (this.grounded) {
        this.airJumps = 1;
        this.airGrapples = SKY.TUNING.grapple.airHooks;   // landing refills hooks
        this.hookLockT = 0;                               // ...and un-jams them
      }

      // ---- slide state ----
      if (!this.sliding && cmd.crouch && this.grounded && this.slideCd <= 0 && this.speedH() > T.slideMinSpeed) {
        this.sliding = true;
        this.slideT = T.slideDuration;
        const hs = this.speedH();
        if (hs > 0.1) {  // one-time boost along current motion
          this.vel.x += (this.vel.x / hs) * T.slideBoost;
          this.vel.z += (this.vel.z / hs) * T.slideBoost;
        }
        SKY.SFX.slideStart();
      }
      if (this.sliding) {
        this.slideT -= dt;
        if (!cmd.crouch || this.slideT <= 0 || !this.grounded) {
          this.sliding = false;
          this.slideCd = T.slideCooldown;
        }
      }
      this.crouching = cmd.crouch && !this.sliding;
      this.height = (this.crouching || this.sliding) ? T.crouchHeight : T.standHeight;
      const eyeTarget = (this.crouching || this.sliding) ? T.eyeCrouch : T.eyeStand;
      this.eyeHeight = SKY.U.damp(this.eyeHeight, eyeTarget, 14, dt);

      // ---- jump (on the landing tick this SKIPS friction -> bhop keeps speed) ----
      if (wantJump && (this.grounded || this.coyoteT > 0)) {
        this.vel.y = T.jumpForce * this.mods.jumpMult;
        this.grounded = false;
        this.coyoteT = 0; this.jumpBufferT = 0; this.timeSinceJump = 0;
        if (this.sliding) { this.sliding = false; this.slideCd = T.slideCooldown * 0.5; }
        SKY.SFX.jump();
      } else if (cmd.jumpPressed && !this.grounded && this.coyoteT <= 0 &&
                 this.abilities.doubleJump && this.airJumps > 0) {
        // DOUBLE JUMP: the second jump is HIGHER than the first
        this.airJumps--;
        this.vel.y = Math.max(this.vel.y,
          T.jumpForce * SKY.TUNING.abilities.doubleJumpMult * this.mods.jumpMult);
        this.timeSinceJump = 0;
        SKY.Effects.ring(new THREE.Vector3(this.pos.x, this.pos.y + 0.1, this.pos.z), '#ffffff', 2, 0.3);
        SKY.SFX.jump();
      }

      // ---- accelerate ----
      const maxRun = T.walkSpeed * this.mods.speedMult * (this.zoomed ? 0.55 : 1);
      if (this.grounded) {
        this._friction(dt, this.sliding ? T.slideFriction : T.friction);
        if (this.sliding) {
          this._slideSteer(_wish, wishLen, dt);
          // downhill pull: sliding on ramps builds speed
          const n = this.groundNormal;
          this.vel.x += n.x * n.y * T.slideSlopePull * dt;
          this.vel.z += n.z * n.y * T.slideSlopePull * dt;
        } else if (wishLen > 1e-4) {
          const maxs = this.crouching ? maxRun * T.crouchSpeedMult : maxRun;
          this._accelerate(_wish, maxs, T.groundAccel, dt);
        }
        // NO downward stick velocity: pressing into a ramp made the solver
        // push back out along the slope normal every tick = constant
        // downhill creep (and ate speed running up). The ground-snap
        // raycast below keeps contact on ramps/crests instead.
        this.vel.y = 0;
      } else {
        // GROUND POUND: crouch pressed mid-air, high enough -> slam
        const A = SKY.TUNING.abilities;
        if (this.abilities.pound && !this.pounding && cmd.crouch && !this._crouchWas) {
          _rayO.set(this.pos.x, this.pos.y + 0.2, this.pos.z);
          const below = SKY.World.raycast(_rayO, _down, A.poundMinAir + 0.2);
          if (!below) {
            this.pounding = true;
            this.vel.x *= 0.2; this.vel.z *= 0.2;
            this.vel.y = -A.poundSpeed;
            SKY.SFX.dash();
          }
        }
        if (wishLen > 1e-4 && !this.pounding) {
          if (T.airForwardAccel > 0) this._accelerate(_wish, maxRun, T.airForwardAccel, dt); // party steering
          this._accelerate(_wish, T.airMaxWishSpeed, T.airAccel, dt);  // strafe gains
          if (cmd.mx === 0 && cmd.mz !== 0) this._airControl(_wish, dt); // W-steering
        }
        this.vel.y -= T.gravity * this.mods.gravMult * dt;
        if (this.vel.y < -T.maxFallSpeed) this.vel.y = -T.maxFallSpeed;
      }
      this._crouchWas = cmd.crouch;

      // ---- roof air vents: ride the updraft column (SKY.World.vents) ----
      for (const v of SKY.World.vents) {
        const vdx = this.pos.x - v.x, vdz = this.pos.z - v.z;
        if (vdx * vdx + vdz * vdz > v.radius * v.radius) continue;
        const vh = this.pos.y - v.y;
        if (vh < -1 || vh > v.height) continue;
        const vk = 1 - Math.max(0, vh) / v.height;    // strongest at the grate
        this.vel.y += v.force * (0.35 + 0.65 * vk) * dt;
        if (this.vel.y > 0.5) this.grounded = false;
        const cap = v.force * 0.62;                   // terminal rise speed
        if (this.vel.y > cap) this.vel.y = cap;
      }

      // ---- bhop soft cap (gentle drag above the cap, no hard wall) ----
      const hs = this.speedH();
      if (hs > T.bhopSoftCap) {
        const over = hs - T.bhopSoftCap;
        const drop = Math.min(over * T.bhopSoftCapDrag * dt, over);
        const k = (hs - drop) / hs;
        this.vel.x *= k; this.vel.z *= k;
      }

      // ---- integrate & collide ----
      const prevGrounded = this._groundedPrev;
      const velYBefore = this.vel.y;
      this.pos.addScaledVector(this.vel, dt);
      const res = SKY.World.resolvePawn(this.pos, this.vel, this.radius, this.height);
      this.grounded = res.grounded;
      if (res.grounded) { this.groundNormal.copy(res.groundNormal); this.groundSolid = res.groundSolid; }
      else this.groundSolid = null;

      // ground snap: stay glued when running down ramps / over crests (not right after jumping)
      if (!this.grounded && prevGrounded && this.timeSinceJump > 0.15 && this.vel.y <= 1) {
        _rayO.set(this.pos.x, this.pos.y + 0.3, this.pos.z);
        const hit = SKY.World.raycast(_rayO, _down, 0.75);
        if (hit && hit.normal.y > 0.72) {
          this.pos.y = hit.point.y;
          this.grounded = true;
          this.groundNormal.copy(hit.normal);
          this.groundSolid = hit.solid;
          if (this.vel.y > 0) this.vel.y = 0;
        }
      }
      this._groundedPrev = this.grounded;
      if (this.grounded) this.lastGroundPos.set(this.pos.x, this.pos.y, this.pos.z);

      // landing feedback
      if (!prevGrounded && this.grounded) {
        const impact = SKY.U.clamp((-velYBefore - 4) / 14, 0, 1);
        if (impact > 0.05) SKY.SFX.land(this.isLocal ? impact : impact * 0.4);
        this._landSquash = Math.max(this._landSquash, impact);
        this.fellScreamed = false;
        this.tumbleVel.set(0, 0, 0);
        if (this.pounding) this._poundLand();
      }

      // ride moving platforms
      if (this.grounded && this.groundSolid && this.groundSolid.isMover) {
        this.pos.add(this.groundSolid.delta);
      }

      cmd.jumpPressed = false;
    }

    /* enter the cinematic ragdoll (headshots, airborne hits) */
    enterRagdoll(mode, impulse) {
      if (this.ragdoll) { this.ragdoll.mode = mode === 'head' ? 'head' : this.ragdoll.mode; return; }
      if (SKY.Game) SKY.Game.ragdollCount = (SKY.Game.ragdollCount || 0) + 1;
      this.ragdoll = { mode, t: mode === 'head' ? SKY.TUNING.ragdoll.headshotTime : 0 };
      this.ragdollImpulse.copy(impulse || this.vel);
      this.sliding = false;
      this.zoomed = false;
      if (this.grapple) this.grapple = null;
      if (this.isLocal) {
        SKY.Effects.shake(1.2);
        if (mode === 'head') SKY.HUD.damage(this.ragdollImpulse, true);
      }
    }

    exitRagdoll() {
      this.ragdoll = null;
      this.tumbleVel.set(0, 0, 0);
      this.yaw = this.cmd.yaw;   // wake up facing where the player is looking
    }

    /* =================== weapon slots =================== */
    /* a new weapon always lands in slot 1 and gets drawn immediately */
    giveWeapon(id) {
      if (!SKY.TUNING.weapons[id]) return;
      this.slots[1] = id;
      this.slotAmmo[1] = Math.round(SKY.TUNING.weapons[id].mag * this.mods.magMult);
      this.switchSlot(1, true);
    }

    switchSlot(n, force) {
      if (!this.slots[n]) return false;
      if (this.activeSlot === n && !force) return false;
      // force = weapon granted (loot picks happen while DEAD, waiting to respawn)
      if (!force && (!this.alive || this.ragdoll)) return false;
      // remember what's left — but NOT on a same-slot force switch (that's a
      // weapon grant: giveWeapon just loaded the fresh mag, don't clobber it
      // with the OLD gun's ammo)
      if (this.activeSlot !== n) this.slotAmmo[this.activeSlot] = this.ammo;
      this.activeSlot = n;
      this.weapon = this.slots[n];
      this.ammo = this.slotAmmo[n];
      this.reloadT = 0;
      this.zoomed = false;
      this.drawT = 0.22;                            // matches the draw anim
      if (this.isLocal) SKY.SFX.grapMiss();         // soft holster click
      return true;
    }

    /* TAUNT (T): pure disrespect. Can't fire while taunting. */
    tryTaunt() {
      if (!this.alive || !this.grounded || this.tauntT > 0 || this.ragdoll) return false;
      this.tauntT = 1.25;
      if (this.avatar) this.avatar.playEmote();
      SKY.SFX.taunt();
      return true;
    }

    /* GROUND POUND landing shockwave */
    _poundLand() {
      this.pounding = false;
      const A = SKY.TUNING.abilities;
      const imp = new THREE.Vector3();
      const mid = new THREE.Vector3();
      for (const p of SKY.Game.pawns) {
        if (p === this || !p.alive) continue;
        p.midPos(mid);
        const dx = mid.x - this.pos.x, dz = mid.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > A.poundRadius || Math.abs(mid.y - this.pos.y) > 3) continue;
        const k = 1 - (d / A.poundRadius) * 0.5;
        imp.set((d > 0.01 ? dx / d : 1) * A.poundForce * k, A.poundUp * k, (d > 0.01 ? dz / d : 0) * A.poundForce * k);
        if (p.isRemote) {
          SKY.Net.sendHit(p.netId, [+imp.x.toFixed(2), +imp.y.toFixed(2), +imp.z.toFixed(2)], false);
        } else {
          p.applyKnockback(imp, this);
        }
      }
      this.vel.y = 4;
      SKY.Effects.ring(new THREE.Vector3(this.pos.x, this.pos.y + 0.15, this.pos.z), '#ffffff', A.poundRadius * 1.6, 0.4);
      SKY.Effects.burst(this.pos, { count: 16, speed: 6, color: '#cfd8e8', life: 0.5 });
      SKY.SFX.rumble();
      if (this.isLocal) SKY.Effects.shake(1);
    }

    /* AIR DASH (death-reward ability, F key) */
    tryDash() {
      const A = SKY.TUNING.abilities;
      if (!this.abilities.dash || this.dashCd > 0 || !this.alive) return false;
      this.dashCd = A.dashCooldown;
      const dx = -Math.sin(this.yaw), dz = -Math.cos(this.yaw);
      const spd = Math.max(this.speedH() + A.dashBoost, A.dashSpeed);
      this.vel.x = dx * spd;
      this.vel.z = dz * spd;
      this.vel.y = Math.max(this.vel.y, 2.5);
      this.grounded = false;
      SKY.SFX.dash();
      if (this.isLocal) SKY.Effects.shake(0.4);
      return true;
    }

    /* Quake ground/air accelerate: only adds speed toward wishdir up to wishspeed */
    _accelerate(wish, wishspeed, accel, dt) {
      const cur = this.vel.x * wish.x + this.vel.z * wish.z;
      const add = wishspeed - cur;
      if (add <= 0) return;
      const acc = Math.min(accel * wishspeed * dt, add);
      this.vel.x += acc * wish.x;
      this.vel.z += acc * wish.z;
    }

    /* Quake friction with stopspeed for crisp low-speed stops */
    _friction(dt, friction) {
      const spd = this.speedH();
      if (spd < 0.01) { this.vel.x = 0; this.vel.z = 0; return; }
      const control = Math.max(spd, SKY.TUNING.move.stopSpeed);
      const ns = Math.max(spd - control * friction * dt, 0);
      const k = ns / spd;
      this.vel.x *= k; this.vel.z *= k;
    }

    /* CPM-style air control: holding only W/S lets the mouse steer velocity */
    _airControl(wish, dt) {
      const spd = this.speedH();
      if (spd < 0.6) return;
      const ix = this.vel.x / spd, iz = this.vel.z / spd;
      const dot = ix * wish.x + iz * wish.z;
      if (dot <= 0) return;
      const k = 32 * SKY.TUNING.move.airControlTurn * dot * dot * dt;
      let nx = ix * spd + wish.x * k;
      let nz = iz * spd + wish.z * k;
      const len = Math.hypot(nx, nz);
      if (len > 1e-6) { this.vel.x = (nx / len) * spd; this.vel.z = (nz / len) * spd; }
    }

    /* limited steering while sliding */
    _slideSteer(wish, wishLen, dt) {
      if (wishLen < 1e-4) return;
      const spd = this.speedH();
      if (spd < 0.5) return;
      const ix = this.vel.x / spd, iz = this.vel.z / spd;
      const dot = SKY.U.clamp(ix * wish.x + iz * wish.z, -1, 1);
      const ang = Math.acos(dot);
      if (ang < 1e-3) return;
      const t = Math.min(1, (SKY.TUNING.move.slideSteer * dt) / ang);
      let nx = ix * (1 - t) + wish.x * t;
      let nz = iz * (1 - t) + wish.z * t;
      const len = Math.hypot(nx, nz);
      if (len > 1e-6) { this.vel.x = (nx / len) * spd; this.vel.z = (nz / len) * spd; }
    }

    /* =================== knockback =================== */
    applyKnockback(impulse, byPawn) {
      const r = this.mods.knockResist;   // Heavyweight powerup reduces this
      this.vel.addScaledVector(impulse, r);
      const m = impulse.length() * r;
      // light/medium hits refresh the air-hook — you can TRY to save yourself.
      // HEAVY hits JAM it instead: a clean yeet shouldn't be hooked back from.
      const GR = SKY.TUNING.grapple;
      if (m > GR.heavyKnock) {
        this.hookLockT = Math.max(this.hookLockT,
          SKY.U.clamp((m - GR.heavyKnock) * GR.heavyLockScale, GR.heavyLockMin, GR.heavyLockMax));
      } else {
        this.airGrapples = Math.max(this.airGrapples, GR.airHooks);
      }
      // incoming-damage feedback for the local player (flash + direction arc)
      if (this.isLocal && m > 2.5) SKY.HUD.damage(impulse, false);
      // Standing is NOT a defensive stance: grounded victims pop AIRBORNE so
      // friction can't eat the push — standing/running victims take the same
      // effective hit as airborne ones. Tuned in TUNING.knock.groundPop.
      const GP = SKY.TUNING.knock.groundPop;
      if (this.grounded && m > GP.minForce) {
        this.grounded = false;
        this.vel.y = Math.max(this.vel.y, Math.min(GP.max, GP.base + m * GP.scale));
      } else if (impulse.y > 0.01) {
        this.grounded = false;
        if (m > 10) this.vel.y = Math.max(this.vel.y, SKY.TUNING.knock.victimMinUpVel);
      }
      if (m > 14) {  // comedy tumble on big launches
        this.tumbleVel.set(SKY.U.rand(-8, 8), SKY.U.rand(-4, 4), SKY.U.rand(-8, 8));
      }
      if (byPawn) {
        this.lastHitBy = byPawn; this.lastHitT = SKY.Game ? SKY.Game.time : 0;
        if (byPawn !== this) {   // recent-hitters ring: deathmatch assists
          this.recentHits = this.recentHits || [];
          this.recentHits.push({ by: byPawn, t: this.lastHitT });
          if (this.recentHits.length > 6) this.recentHits.shift();
        }
      }
    }

    teleport(pos, yaw) {
      this.pos.copy(pos);
      this.lastGroundPos.copy(pos);
      this.vel.set(0, 0, 0);
      this.yaw = yaw; this.cmd.yaw = yaw;
      this.facingYaw = yaw; this.facingVel = 0;
      this.sliding = false; this.slideT = 0;
      this.tumbleVel.set(0, 0, 0);
      this.fellScreamed = false;
      this.padLockT = 0;
      this.airJumps = 1;
      this.airGrapples = SKY.TUNING.grapple.airHooks;
      this.hookLockT = 0;
      this.ragdoll = null;
      this.pounding = false;
      this.reloadT = 0; this.drawT = 0;
      // respawn refills BOTH slots
      this.slotAmmo[2] = Math.round(SKY.TUNING.weapons.pistol.mag * this.mods.magMult);
      if (this.slots[1]) this.slotAmmo[1] = Math.round(SKY.TUNING.weapons[this.slots[1]].mag * this.mods.magMult);
      this.ammo = this.slotAmmo[this.activeSlot];
      this.nades = { ...SKY.TUNING.nadeStart };
      if (this.grapple) { this.grapple = null; }
      if (this.isLocal) { SKY.Input.yaw = yaw; SKY.Input.pitch = 0; }
    }

    /* =================== avatar (see characters.js) =================== */
    buildVisual(scene) {
      this.avatar = SKY.Characters.create(this, scene);
    }

    visualTick(dt) {
      if (this.avatar) this.avatar.update(dt);
    }

    dispose() {
      if (this.avatar) this.avatar.dispose();
      SKY.Grapple.disposeRope(this);
    }
  }

  SKY.Pawn = Pawn;
})();
