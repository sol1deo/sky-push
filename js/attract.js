/* =============================================================================
 * SKY PUSH — attract mode
 * The menu background isn't a still: a small cast of dummies plays the game
 * behind it in slow motion — jogging between roam points, hopping, trading
 * tracer fire, ragdolling and getting back up. Visual-only: no Pawn physics,
 * no netcode, no audio. The Avatar class in characters.js does the acting;
 * this file just puppets pawn-shaped stubs and owns its (slow-mo) tracers.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Attract = (function () {
  const SLOWMO = 0.38;              // the whole show runs at roughly 1/3 speed
  const SHOT_SPEED = 34;            // tracer flight speed IN slow-mo time
  const CAST = [
    ['Bloop', '#ff9a5a'], ['Zippy', '#5ab4ff'], ['Wobble', '#7ae87a'],
    ['Peanut', '#ffd34d'], ['Momo', '#c58aff'],
  ];
  const GUNS = ['pistol', 'smg', 'scatter', 'blaster', 'magnum'];
  let scene = null;
  let actors = [];
  let shots = [];                   // in-flight darts { vis, start, dir, t, range, victim }
  let pool = [];                    // parked tracer visuals
  let lobbyRoster = null;           // non-null = LOBBY STAGE mode (character lineup)
  let lobbyActors = [];
  const lobbyCamPos = new THREE.Vector3();
  const lobbyLook = new THREE.Vector3();
  let lobbyCamOk = false;
  const _v = new THREE.Vector3();
  const _from = new THREE.Vector3();
  const _dir = new THREE.Vector3();

  function makeActor(cast, i, pts) {
    const a = {
      /* everything characters.js reads off a pawn */
      name: cast[0], color: cast[1], isLocal: false, alive: true,
      weapon: GUNS[i % GUNS.length],
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      yaw: 0, pitch: 0, height: SKY.TUNING.move.standHeight,
      grounded: true, sliding: false, ragdoll: null,
      tumbleVel: new THREE.Vector3(), fellScreamed: false,
      ragdollImpulse: new THREE.Vector3(),
      speedH() { return Math.hypot(this.vel.x, this.vel.z); },
      /* director state */
      wp: null, groundY: 0, airOff: 0, vy: 0,
      jumpT: SKY.U.rand(1, 4), shootT: SKY.U.rand(0.8, 3),
      burst: 0, fireT: 0, target: null, ragT: 0, emoteT: SKY.U.rand(5, 16),
    };
    const p0 = pts[(i * 3 + 1) % pts.length];
    a.pos.copy(p0);
    a.groundY = p0.y;
    a.yaw = SKY.U.rand(-Math.PI, Math.PI);
    a.avatar = SKY.Characters.create(a, scene);
    return a;
  }

  function start() {
    const pts = SKY.World.roamPoints;
    if (!pts || pts.length < 2) return;
    actors = CAST.map((c, i) => makeActor(c, i, pts));
  }

  function stop() {
    for (const a of actors) a.avatar.dispose();
    actors = [];
    for (const s of shots) if (s.vis.g.parent) s.vis.g.parent.remove(s.vis.g);
    for (const vis of pool) if (vis.g.parent) vis.g.parent.remove(vis.g);
    shots = [];
    pool = [];
    lobbyStop();     // roster is kept — the lineup rebuilds on the next menu frame
  }

  /* ==================== LOBBY STAGE ====================
   * Fortnite-style: the lobby's actual characters stand in a lineup on the
   * map preview, facing a FIXED cinematic camera. Names float above heads
   * via the avatars' own nameSpr. */
  function lobbyStop() {
    for (const a of lobbyActors) a.avatar.dispose();
    lobbyActors = [];
    lobbyCamOk = false;
  }

  function buildLobby() {
    lobbyStop();
    if (!lobbyRoster || !lobbyRoster.length) return;
    const n = lobbyRoster.length;
    let midY = 0;
    for (let i = 0; i < n; i++) {
      const r = lobbyRoster[i];
      const a = {
        name: r.name, color: r.color, cos: r.cos || null, isLocal: false, alive: true,
        weapon: 'pistol', pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        yaw: Math.PI, pitch: 0, height: SKY.TUNING.move.standHeight,
        grounded: true, sliding: false, ragdoll: null,
        tumbleVel: new THREE.Vector3(), fellScreamed: false,
        emoteT: SKY.U.rand(4, 15),
        speedH() { return 0; },
      };
      // stage the line near the map's center, dropped onto real ground
      const x = (i - (n - 1) / 2) * 1.8;
      _from.set(x, 30, -1 - Math.abs(x) * 0.24);   // gentle arc, wings behind
      const hit = SKY.World.raycast(_from, _dir.set(0, -1, 0), 60);
      a.pos.set(_from.x, hit ? 30 - hit.t : 0, _from.z);
      if (i === Math.floor((n - 1) / 2)) midY = a.pos.y;
      a.avatar = SKY.Characters.create(a, scene);
      lobbyActors.push(a);
    }
    // fixed camera in front of the line, a touch above eye height
    lobbyCamPos.set(0, midY + 2.3, 6.6);
    lobbyLook.set(0, midY + 1.1, -1);
    lobbyCamOk = true;
  }

  function tickLobby(rdt) {
    if (!lobbyActors.length) { buildLobby(); if (!lobbyActors.length) return; }
    for (const a of lobbyActors) {
      a.emoteT -= rdt;
      if (a.emoteT <= 0) { a.avatar.playEmote(); a.emoteT = SKY.U.rand(9, 22); }
      a.avatar.update(rdt);
    }
  }

  function ragdollActor(v, dir) {
    v.ragdoll = { mode: 'air', t: 0 };
    v.ragT = SKY.U.rand(1.6, 2.8);
    v.ragdollImpulse.copy(dir).multiplyScalar(SKY.U.rand(9, 18));
    v.ragdollImpulse.y += SKY.U.rand(2, 6);
    v.vel.set(dir.x * 4, 2, dir.z * 4);
  }

  function fireShot(a) {
    const t = a.target;
    if (!t || t.ragdoll) { a.burst = 0; return; }
    if (!a.avatar.gunTipWorld(_from)) _from.set(a.pos.x, a.pos.y + 1.35, a.pos.z);
    _v.set(t.pos.x + SKY.U.rand(-0.5, 0.5),
           t.pos.y + 1.1 + SKY.U.rand(-0.3, 0.4),
           t.pos.z + SKY.U.rand(-0.5, 0.5));
    _dir.copy(_v).sub(_from);
    const dist = _dir.length() || 1;
    _dir.multiplyScalar(1 / dist);
    const vis = pool.pop() || SKY.Effects.makeTracer();
    vis.g.visible = true;
    SKY.Effects.resetTracer(vis, _from);
    shots.push({ vis, start: _from.clone(), dir: _dir.clone(), t: 0, range: dist, victim: t });
    SKY.Effects.muzzleLight(_from);
  }

  function tickShots(dt) {
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      s.t += dt;
      const trav = s.t * SHOT_SPEED;
      if (trav >= s.range) {
        _v.copy(s.start).addScaledVector(s.dir, s.range);
        SKY.Effects.burst(_v, { count: 8, speed: 4, color: '#ffe2a8', life: 0.35, size: 0.4 });
        if (s.victim && !s.victim.ragdoll && Math.random() < 0.4) ragdollActor(s.victim, s.dir);
        s.vis.g.visible = false;
        pool.push(s.vis);
        shots.splice(i, 1);
        continue;
      }
      _v.copy(s.start).addScaledVector(s.dir, trav);
      SKY.Effects.poseTracer(s.vis, _v, s.dir, Math.min(2.4, trav));
    }
  }

  function tickActor(a, dt, pts) {
    if (a.ragdoll) {
      a.ragT -= dt;
      // a mid-air victim sinks to the deck so the ragdoll drapes there
      a.airOff = Math.max(0, a.airOff - 8 * dt);
      a.pos.y = a.groundY + a.airOff;
      if (a.ragT <= 0) { a.ragdoll = null; a.wp = null; a.vel.set(0, 0, 0); }
      a.avatar.update(dt);
      return;
    }

    // wander: prefer NEARBY roam points so nobody moonwalks across a chasm
    if (!a.wp || Math.hypot(a.wp.x - a.pos.x, a.wp.z - a.pos.z) < 1.4) {
      const near = pts.slice().sort((p, q) =>
        p.distanceToSquared(a.pos) - q.distanceToSquared(a.pos)).slice(1, 7);
      a.wp = SKY.U.pick(near) || SKY.U.pick(pts);
    }
    const dx = a.wp.x - a.pos.x, dz = a.wp.z - a.pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    const spd = 6.4;
    a.vel.x = dx / dl * spd;
    a.vel.z = dz / dl * spd;
    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;
    a.groundY = SKY.U.damp(a.groundY, a.wp.y, 3.5, dt);

    // face the run — or the poor soul being shot at (forward is -sin,-cos)
    const wantYaw = (a.burst > 0 && a.target)
      ? Math.atan2(-(a.target.pos.x - a.pos.x), -(a.target.pos.z - a.pos.z))
      : Math.atan2(-dx, -dz);
    a.yaw += SKY.U.angDelta(a.yaw, wantYaw) * Math.min(1, 7 * dt);

    // the occasional hop
    a.jumpT -= dt;
    if (a.jumpT <= 0 && a.grounded) {
      a.vy = 9.5; a.grounded = false;
      a.jumpT = SKY.U.rand(2.5, 7);
    }
    if (!a.grounded) {
      a.vy -= 24 * dt;
      a.airOff += a.vy * dt;
      if (a.airOff <= 0 && a.vy < 0) { a.airOff = 0; a.vy = 0; a.grounded = true; }
    }
    a.vel.y = a.vy;
    a.pos.y = a.groundY + a.airOff;

    // run-and-gun bursts at a random co-star
    if (a.burst > 0 && a.target && !a.target.ragdoll) {
      const dy = (a.target.pos.y + 1.2) - (a.pos.y + 1.4);
      const dh = Math.hypot(a.target.pos.x - a.pos.x, a.target.pos.z - a.pos.z) || 1;
      a.pitch = SKY.U.damp(a.pitch, SKY.U.clamp(Math.atan2(dy, dh), -0.7, 0.7), 8, dt);
      a.fireT -= dt;
      if (a.fireT <= 0) { fireShot(a); a.burst--; a.fireT = 0.16; }
    } else {
      a.burst = 0;
      a.pitch = SKY.U.damp(a.pitch, 0, 6, dt);
      a.shootT -= dt;
      if (a.shootT <= 0) {
        const foes = actors.filter(o => o !== a && !o.ragdoll);
        if (foes.length) {
          a.target = SKY.U.pick(foes);
          a.burst = 2 + (Math.random() * 4 | 0);
          a.fireT = 0;
        }
        a.shootT = SKY.U.rand(2.2, 5.5);
      }
    }

    // now and then, a wave at the camera
    a.emoteT -= dt;
    if (a.emoteT <= 0) { a.avatar.playEmote(); a.emoteT = SKY.U.rand(10, 25); }

    a.avatar.update(dt);
  }

  return {
    init(sc) { scene = sc; },

    /* called from Game.renderTick every frame; self-gates on menu state */
    tick(rdt) {
      const busy = SKY.Game.state !== 'menu' ||
        (SKY.Editor && SKY.Editor.active) || (SKY.Replay && SKY.Replay.active);
      if (busy) { if (actors.length || shots.length || lobbyActors.length) stop(); return; }
      if (lobbyRoster) {                 // lobby stage replaces the slow-mo show
        if (actors.length || shots.length) {
          for (const a of actors) a.avatar.dispose();
          actors = [];
          for (const s of shots) if (s.vis.g.parent) s.vis.g.parent.remove(s.vis.g);
          shots = [];
        }
        tickLobby(rdt);
        return;
      }
      if (!actors.length) start();
      if (!actors.length) return;
      const pts = SKY.World.roamPoints;
      if (!pts || pts.length < 2) { stop(); return; }
      const dt = rdt * SLOWMO;
      for (const a of actors) tickActor(a, dt, pts);
      tickShots(dt);
    },

    /* lobby stage on/off: pass the roster (rebuilds on every change), or null */
    lobby(roster) {
      lobbyRoster = roster && roster.length ? roster : null;
      lobbyStop();     // lineup lazily rebuilds in tick with fresh data
    },

    /* fixed cinematic camera while the lobby stage is up. Returns true when
       it drove the camera (Game.renderTick falls back to the orbit else). */
    lobbyCam(camera, rdt) {
      if (!lobbyRoster || !lobbyCamOk || SKY.Game.state !== 'menu') return false;
      const t = performance.now() * 0.00022;
      camera.position.set(
        lobbyCamPos.x + Math.sin(t) * 0.45,
        lobbyCamPos.y + Math.sin(t * 0.7) * 0.12,
        lobbyCamPos.z);
      camera.lookAt(lobbyLook);
      camera.fov = SKY.U.damp(camera.fov, 55, 6, rdt);
      return true;
    },

    /* map preview changed → recast on the new map next menu frame */
    reset() { stop(); },
    stop,
  };
})();
