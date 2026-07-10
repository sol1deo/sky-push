/* =============================================================================
 * SKY PUSH — map pickups
 * Weapons (and the odd powerup/ability) spawn around the arena on a timer —
 * so a player who never dies isn't stuck with the pistol. Spawn spots come
 * from the map's roam points (spread across every platform), away from
 * players. Walk over one to grab it.
 * Online: the host decides spawns/grabs and broadcasts them ('pkspawn' /
 * 'pktake'); clients only render.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Pickups = (function () {
  const CFG = {
    firstDelay: 6,      // first pickup this many seconds into the round
    interval: 11,       // spawn cadence after that
    maxActive: 3,
    radius: 1.5,        // grab distance
    weaponChance: 0.7,  // rest = powerups/abilities/nade packs
  };
  let scene = null;
  const active = [];    // { id, item, pos, grp, spin }
  let nextT = CFG.firstDelay;
  let idSeq = 1;
  let spawnedTotal = 0;
  const _v = new THREE.Vector3();

  function rollItem() {
    const weapons = SKY.Loot.ITEMS.filter(i => i.kind === 'weapon');
    const others = SKY.Loot.ITEMS.filter(i => i.kind !== 'weapon');
    return Math.random() < CFG.weaponChance ? SKY.U.pick(weapons) : SKY.U.pick(others);
  }

  function buildVisual(item) {
    const grp = new THREE.Group();
    const color = item.kind === 'weapon'
      ? SKY.TUNING.weapons[item.id].color
      : SKY.Loot.RARITY[item.rarity].color;
    if (item.kind === 'weapon') {
      const m = SKY.Effects.buildWeaponMesh(item.id);
      m.scale.setScalar(2.1);
      m.position.y = 1.05;
      grp.add(m);
    } else {
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.34),
        new THREE.MeshLambertMaterial({
          color, emissive: new THREE.Color(color).multiplyScalar(0.55),
        }));
      crystal.position.y = 1.05;
      grp.add(crystal);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SKY.U.blobTexture(), color, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.set(2.4, 2.4, 1);
    glow.position.y = 1.0;
    grp.add(glow);
    scene.add(grp);
    return grp;
  }

  /* place a pickup in the world (host decision or replicated from the net) */
  function spawnAt(id, itemId, pos) {
    const item = SKY.Loot.ITEMS.find(i => i.id === itemId);
    if (!item) return;
    active.push({
      id, item,
      pos: new THREE.Vector3(pos.x, pos.y, pos.z),
      grp: buildVisual(item),
      spin: Math.random() * Math.PI * 2,
    });
    spawnedTotal++;
    SKY.Effects.respawnBeam(new THREE.Vector3(pos.x, pos.y, pos.z),
      item.kind === 'weapon' ? '#ffd34d' : '#40c8ff');
  }

  function hostSpawn() {
    // custom maps can place explicit item spots (used as-is); otherwise use
    // roam points but NEVER ones sitting on player spawns — a weapon crate
    // on a spawn pad reads as "the spawn points are swapped"
    const explicit = SKY.World.itemPoints.length > 0;
    const pts = explicit ? SKY.World.itemPoints
      : SKY.World.roamPoints.filter(rp =>
          !SKY.World.spawnPoints.some(s => s.pos.distanceTo(rp) < 4));
    if (!pts.length) return;
    let pos = null;
    for (let tries = 0; tries < 8 && !pos; tries++) {
      const c = SKY.U.pick(pts);
      const nearPlayer = !explicit && SKY.Game.pawns.some(p => p.alive && p.pos.distanceTo(c) < 7);
      const nearPickup = active.some(pk => pk.pos.distanceTo(c) < 5);
      if (!nearPlayer && !nearPickup) pos = c;
    }
    if (!pos) return;
    const item = rollItem();
    const id = idSeq++;
    spawnAt(id, item.id, pos);
    if (SKY.Net.online) SKY.Net.sendPickupSpawn({
      id, item: item.id, pos: [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)],
    });
  }

  function removeVisual(pk) {
    scene.remove(pk.grp);
  }

  function grabFx(pk) {
    _v.set(pk.pos.x, pk.pos.y + 1, pk.pos.z);
    SKY.Effects.burst(_v, { count: 14, speed: 5, color: '#ffffff', life: 0.4, size: 0.5 });
    SKY.Effects.ring(_v.clone(), '#ffd34d', 2.4, 0.35);
  }

  function take(pk, pawn) {
    const i = active.indexOf(pk);
    if (i < 0) return;
    active.splice(i, 1);
    removeVisual(pk);
    grabFx(pk);
    if (pawn.isRemote) {
      // host arbitrates but the item is applied on the owner's client too
      SKY.Loot.apply(pawn, pk.item);
    } else {
      SKY.Loot.apply(pawn, pk.item);
    }
    if (SKY.Net.online && SKY.Net.role === 'host') {
      SKY.Net.sendPickupTake(pk.id, pawn.netId);
    }
  }

  /* replicated grab on clients */
  function takeRemote(id, pawnNetId) {
    const pk = active.find(p => p.id === id);
    if (!pk) return;
    const i = active.indexOf(pk);
    active.splice(i, 1);
    removeVisual(pk);
    grabFx(pk);
    const pawn = SKY.Game.pawns.find(p => p.netId === pawnNetId);
    if (pawn) SKY.Loot.apply(pawn, pk.item);
  }

  return {
    init(sc) { scene = sc; },
    spawnAt(id, itemId, posArr) {
      spawnAt(id, itemId, { x: posArr[0], y: posArr[1], z: posArr[2] });
    },
    takeRemote,
    count() { return active.length; },
    spawnedTotal() { return spawnedTotal; },

    /* fixed tick — only the authority spawns and arbitrates grabs */
    tick(dt) {
      if (!SKY.Net.authority) return;
      nextT -= dt;
      if (nextT <= 0) {
        nextT = CFG.interval;
        if (active.length < CFG.maxActive) hostSpawn();
      }
      for (let i = active.length - 1; i >= 0; i--) {
        const pk = active[i];
        for (const p of SKY.Game.pawns) {
          if (!p.alive || p.ragdoll) continue;
          p.midPos(_v);
          _v.y -= 0.6;
          if (_v.distanceTo(pk.pos) < CFG.radius) { take(pk, p); break; }
        }
      }
    },

    /* per render frame: idle spin + bob */
    visualTick(rdt) {
      for (const pk of active) {
        pk.spin += rdt * 1.6;
        pk.grp.position.set(pk.pos.x, pk.pos.y + Math.sin(pk.spin * 1.3) * 0.12, pk.pos.z);
        pk.grp.rotation.y = pk.spin;
      }
    },

    clear() {
      for (const pk of active) removeVisual(pk);
      active.length = 0;
      nextT = CFG.firstDelay;
    },
  };
})();
