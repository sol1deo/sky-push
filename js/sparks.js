/* =============================================================================
 * SKY PUSH — spark orbs (the SPARK RUSH economy)
 * KOs burst into golden orbs; ambient orbs trickle in at item points. Run
 * near one to hoover it up — your magnet radius GROWS with your speed
 * (momentum is power, even for looting). The host mints and arbitrates
 * ('skspawn' / 'sktake'); orb ring positions derive deterministically from
 * the orb id, so a spawn message is just {id, n, pos}.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Sparks = (function () {
  const GOLD = '#ffd34d';
  let scene = null;
  const orbs = [];          // { id, home, pos, born, grp, spin }
  let idSeq = 1;
  let trickleT = 4;
  const _v = new THREE.Vector3();

  function buildVisual() {
    const grp = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.22),
      new THREE.MeshLambertMaterial({ color: GOLD, emissive: 0xb8860b }));
    core.position.y = 0.55;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SKY.U.blobTexture(), color: GOLD, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.set(1.5, 1.5, 1);
    glow.position.y = 0.55;
    grp.add(core, glow);
    scene.add(grp);
    return grp;
  }

  /* deterministic scatter: same id -> same offset on every client */
  function restPos(id, center, n) {
    if (n <= 1) return center.clone();
    const a = id * 2.399963;                       // golden angle walk
    const r = 1.0 + ((id * 37) % 100) / 100 * 1.5;
    return new THREE.Vector3(
      center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r);
  }

  function spawnOne(id, center, n) {
    const o = {
      id,
      mintAt: center.clone(),
      home: restPos(id, center, n),
      pos: center.clone(),
      born: 0,
      grp: buildVisual(),
      spin: (id % 20) * 0.33,
    };
    o.grp.position.copy(o.pos);
    orbs.push(o);
  }

  /* a ring of n orbs bursting out of `center` (KO piñata / ambient n=1) */
  function spawnRing(id0, n, center) {
    for (let i = 0; i < n; i++) spawnOne(id0 + i, center, n);
    SKY.Effects.burst(center.clone().add(_v.set(0, 0.6, 0)),
      { count: 10, speed: 5, color: GOLD, life: 0.4, size: 0.5 });
  }

  function removeOrb(o) {
    scene.remove(o.grp);
    orbs.splice(orbs.indexOf(o), 1);
  }

  function collectFx(o, pawn) {
    _v.set(o.pos.x, o.pos.y + 0.6, o.pos.z);
    SKY.Effects.burst(_v, { count: 6, speed: 4, color: GOLD, life: 0.3, size: 0.4 });
    if (pawn && pawn.isLocal) SKY.SFX.pick();
  }

  /* host arbitration: whoever's magnet covers an orb banks it */
  function hostCollect() {
    const C = SKY.TUNING.spark;
    const taken = new Map();     // pawn -> [ids]
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i];
      if (o.born < 0.35) continue;               // let the pop-out read
      let best = null, bestD = 1e9;
      for (const p of SKY.Game.pawns) {
        if (!p.alive || p.ragdoll) continue;
        const magnet = C.magnetBase + p.speedH() * C.magnetSpeed;
        p.midPos(_v);
        const d = _v.distanceTo(o.pos);
        if (d < magnet && d < bestD) { best = p; bestD = d; }
      }
      if (best) {
        if (!taken.has(best)) taken.set(best, []);
        taken.get(best).push(o.id);
        collectFx(o, best);
        removeOrb(o);
      }
    }
    for (const [pawn, ids] of taken) {
      pawn.sparks = (pawn.sparks || 0) + ids.length;
      if (SKY.Net.online && SKY.Net.role === 'host') SKY.Net.sendSparkTake(ids, pawn.netId);
    }
  }

  return {
    init(sc) { scene = sc; },
    count() { return orbs.length; },

    /* nearest orb position within sniffing range (bot brains) */
    nearest(pos) {
      let best = null, bestD = 45;
      for (const o of orbs) {
        const d = o.pos.distanceTo(pos);
        if (d < bestD) { bestD = d; best = o; }
      }
      return best ? best.pos : null;
    },

    /* host mints a KO burst / drop at `pos`; replicates to clients */
    mint(n, pos) {
      if (n <= 0) return;
      const id0 = idSeq;
      idSeq += n;
      spawnRing(id0, n, pos);
      if (SKY.Net.online && SKY.Net.role === 'host') {
        SKY.Net.sendSparkSpawn({ id: id0, n, pos: [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)] });
      }
    },

    /* replicated on clients */
    spawnRemote(id0, n, posArr) {
      spawnRing(id0, n, new THREE.Vector3(posArr[0], posArr[1], posArr[2]));
    },
    takeRemote(ids, byNetId) {
      const pawn = SKY.Game.pawns.find(p => p.netId === byNetId);
      for (const id of ids) {
        const o = orbs.find(x => x.id === id);
        if (!o) continue;
        collectFx(o, pawn);
        removeOrb(o);
      }
      if (pawn) pawn.sparks = (pawn.sparks || 0) + ids.length;
    },

    /* fixed tick — authority spawns ambient orbs and arbitrates pickups */
    tick(dt) {
      for (const o of orbs) o.born += dt;
      if (!SKY.Net.authority) return;
      const C = SKY.TUNING.spark;
      trickleT -= dt;
      if (trickleT <= 0) {
        trickleT = C.trickleEvery;
        const ambient = orbs.length;
        if (ambient < C.maxAmbient) {
          const pts = SKY.World.itemPoints.length ? SKY.World.itemPoints
            : SKY.World.roamPoints.filter(rp =>
                !SKY.World.spawnPoints.some(s => s.pos.distanceTo(rp) < 4));
          if (pts.length) this.mint(1, SKY.U.pick(pts));
        }
      }
      hostCollect();
    },

    /* per render frame: pop-out ease from the mint point, then bob + spin */
    visualTick(rdt) {
      for (const o of orbs) {
        o.spin += rdt * 2.2;
        const k = SKY.U.clamp01(o.born / 0.45);
        const ease = 1 - (1 - k) * (1 - k);
        o.pos.lerpVectors(o.mintAt, o.home, ease);
        o.grp.position.set(o.pos.x,
          o.pos.y + Math.sin(o.spin) * 0.09 + (1 - ease) * 0.6, o.pos.z);
        o.grp.rotation.y = o.spin;
      }
    },

    clear() {
      for (let i = orbs.length - 1; i >= 0; i--) removeOrb(orbs[i]);
      idSeq = 1;
      trickleT = 4;
    },
  };
})();
