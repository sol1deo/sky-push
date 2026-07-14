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
  let spawners = null;  // dedicated per-point spawners on custom maps (host only)
  const _v = new THREE.Vector3();

  /* custom maps: every placed item point is a SPAWNER — a specific item (or
     a random roll) appears there and comes back `respawn` seconds after
     someone grabs it. Built lazily so the map is fully loaded first. */
  function buildSpawners() {
    spawners = SKY.World.itemPoints.map((pt, i) => ({
      pt,
      item: pt.item || '',                 // '' = re-roll a random item each time
      mix: pt.mix || null,                 // weighted rarity pool (item 'mix')
      respawn: (typeof pt.respawn === 'number' && pt.respawn > 0) ? pt.respawn : 20,
      t: CFG.firstDelay + i * 1.2,         // stagger the opening wave
      live: null,                          // active pickup id while spawned
    }));
  }

  /* what should this spawner produce?
     '' = any random · 'r:<rarity>' = random within a rarity ·
     'mix' = weighted rarity roll (sp.mix percentages) · else a specific id */
  function pickRarity(mix) {
    const order = ['common', 'rare', 'epic', 'legendary'];
    let total = 0;
    for (const r of order) total += Math.max(0, mix[r] || 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const r of order) {
      roll -= Math.max(0, mix[r] || 0);
      if (roll <= 0) return r;
    }
    return 'common';
  }
  function rollRarity(r) {
    const pool = SKY.Loot.ITEMS.filter(i => i.rarity === r);
    return pool.length ? SKY.U.pick(pool) : null;
  }
  function resolveSpawn(sp) {
    if (sp.item === 'mix') {
      const r = sp.mix && pickRarity(sp.mix);
      return r ? rollRarity(r) : rollItem();
    }
    if (sp.item && sp.item.startsWith('r:')) return rollRarity(sp.item.slice(2)) || rollItem();
    if (sp.item) return SKY.Loot.ITEMS.find(i => i.id === sp.item);
    return rollItem();
  }

  function spawnFixed(sp) {
    const item = resolveSpawn(sp);
    if (!item) { sp.t = 30; return; }      // stale id in an old map — retry, don't spin
    const id = idSeq++;
    sp.live = id;
    spawnAt(id, item.id, sp.pt);
    if (SKY.Net.online) SKY.Net.sendPickupSpawn({
      id, item: item.id,
      pos: [+sp.pt.x.toFixed(1), +sp.pt.y.toFixed(1), +sp.pt.z.toFixed(1)],
    });
  }

  function rollItem() {
    const weapons = SKY.Loot.ITEMS.filter(i => i.kind === 'weapon');
    const others = SKY.Loot.ITEMS.filter(i => i.kind !== 'weapon');
    return Math.random() < CFG.weaponChance ? SKY.U.pick(weapons) : SKY.U.pick(others);
  }

  /* deep saturated beacon colors — the shared rarity hues wash out to white
     under additive glow, so pickups use their own punchier set. Commons get
     the same treatment in plain WHITE (the old grey glow read as "no glow"
     and the item looked like it was just floating). */
  const BEACON = { starter: '#ffffff', common: '#ffffff', rare: '#1f7dff', epic: '#d92cff',
    legendary: '#ff9d1f' };

  /* powerups/abilities on the ground: the card's line-art glyph on a badge
     (dark disc + rarity ring) — reads as an ITEM, no floating text needed */
  const glyphTexCache = {};
  function glyphSprite(item, color) {
    let tex = glyphTexCache[item.id];
    if (!tex) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      tex = new THREE.CanvasTexture(cv);
      tex.encoding = THREE.sRGBEncoding;
      glyphTexCache[item.id] = tex;
      const g = cv.getContext('2d');
      const badge = () => {
        g.clearRect(0, 0, 128, 128);
        g.fillStyle = 'rgba(9,13,23,0.88)';
        g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.fill();
        g.strokeStyle = color; g.lineWidth = 6;
        g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke();
      };
      badge();
      tex.needsUpdate = true;
      const d = SKY.Loot.describe(item);
      if (d.glyph) {
        const svgTxt = d.glyph
          .replace('<svg ', '<svg width="128" height="128" ')
          .replace(/currentColor/g, d.color || color);
        const img = new Image();
        img.onload = () => {
          badge();
          g.drawImage(img, 28, 28, 72, 72);
          tex.needsUpdate = true;
        };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgTxt);
      }
    }
    return new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false }));
  }

  /* floating name tag — brought BACK for powerups/abilities (the badge alone
     read as "a black circle"); weapons + grenades stay label-free (their 3D
     models are self-explanatory) */
  const labelTexCache = {};
  function labelSprite(text, color) {
    const key = text + '|' + color;
    let entry = labelTexCache[key];
    if (!entry) {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 112;
      const g = cv.getContext('2d');
      let px = 52;
      g.font = `900 ${px}px "Titan One", Inter, sans-serif`;
      const w = g.measureText(text).width;
      if (w > 470) { px = Math.floor(px * 470 / w); g.font = `900 ${px}px "Titan One", Inter, sans-serif`; }
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = 11; g.strokeStyle = 'rgba(7,10,18,0.92)';
      g.strokeText(text, 256, 58);
      g.fillStyle = color;
      g.fillText(text, 256, 58);
      const tex = new THREE.CanvasTexture(cv);
      tex.encoding = THREE.sRGBEncoding;
      entry = labelTexCache[key] = { tex };
    }
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: entry.tex, transparent: true, depthWrite: false }));
    spr.scale.set(2.5, 0.55, 1);
    return spr;
  }

  function buildVisual(item) {
    const grp = new THREE.Group();
    const rcolor = BEACON[item.rarity] || '#ffffff';
    const strong = item.rarity === 'legendary' ? 1.2
      : item.rarity === 'epic' ? 1 : item.rarity === 'rare' ? 0.65 : 0.5;
    if (item.kind === 'weapon') {
      const m = SKY.Effects.buildWeaponMesh(item.id);
      m.scale.setScalar(2.1);
      m.position.y = 1.05;
      grp.add(m);
    } else if (item.kind === 'nade') {
      // the actual grenade model, big enough to read from across the arena
      const m = SKY.Effects.buildNadeMesh(item.nade);
      m.scale.setScalar(3.4);
      m.position.y = 1.05;
      grp.add(m);
    } else {
      const ic = glyphSprite(item, rcolor);
      ic.scale.set(1.05, 1.05, 1);
      ic.position.y = 1.1;
      grp.add(ic);
      // powerups need the name — an icon alone doesn't say what it does
      const lbl = labelSprite((SKY.Loot.describe(item).name || item.id).toUpperCase(), rcolor);
      lbl.position.y = 1.9;
      grp.add(lbl);
    }
    // NORMAL blending keeps the hue saturated (additive washed it to white)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SKY.U.blobTexture(), color: new THREE.Color(rcolor).convertSRGBToLinear(),
      transparent: true, opacity: 0.4 + 0.25 * strong, depthWrite: false,
    }));
    const gs = 1.9 + 1.0 * strong;
    glow.scale.set(gs, gs, 1);
    glow.position.y = 1.0;
    grp.add(glow);
    // every drop gets the light pillar (white for commons, hue for rare/epic)
    if (strong > 0.4) {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.17, 5, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(rcolor).convertSRGBToLinear(),
          transparent: true, opacity: 0.16 + 0.14 * strong,
          depthWrite: false, side: THREE.DoubleSide,
        }));
      beam.position.y = 2.9;
      grp.add(beam);
    }
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
      BEACON[item.rarity] || '#ffd34d');
  }

  function hostSpawn() {
    // maps without explicit item points: roam points, but NEVER ones sitting
    // on player spawns — a weapon crate on a spawn pad reads as "the spawn
    // points are swapped"
    const pts = SKY.World.roamPoints.filter(rp =>
      !SKY.World.spawnPoints.some(s => s.pos.distanceTo(rp) < 4));
    if (!pts.length) return;
    let pos = null;
    for (let tries = 0; tries < 8 && !pos; tries++) {
      const c = SKY.U.pick(pts);
      const nearPlayer = SKY.Game.pawns.some(p => p.alive && p.pos.distanceTo(c) < 7);
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
    // arm the point's respawn timer (host runs these; clients just render)
    if (spawners) {
      const sp = spawners.find(s => s.live === pk.id);
      if (sp) { sp.live = null; sp.t = sp.respawn; }
    }
    // host arbitrates but the item is applied on the owner's client too
    SKY.Loot.apply(pawn, pk.item);
    // walk-over grabs get the toast (card picks don't — the card WAS the info)
    if (pawn.isLocal) SKY.HUD.pickupToast(pk.item);
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
    if (pawn) {
      SKY.Loot.apply(pawn, pk.item);
      if (pawn.isLocal) SKY.HUD.pickupToast(pk.item);
    }
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
      if (SKY.Game.mode === 'it') return;   // tag has no weapon pickups
      if (spawners === null) buildSpawners();
      if (spawners.length) {
        // dedicated spawners: each point runs its own respawn clock
        for (const sp of spawners) {
          if (sp.live !== null) continue;
          sp.t -= dt;
          if (sp.t <= 0) spawnFixed(sp);
        }
      } else {
        nextT -= dt;
        if (nextT <= 0) {
          nextT = CFG.interval;
          if (active.length < CFG.maxActive) hostSpawn();
        }
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
      spawners = null;   // rebuilt from the (new) map's item points next tick
    },
  };
})();
