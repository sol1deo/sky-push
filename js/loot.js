/* =============================================================================
 * SKY PUSH — death rewards
 * Die -> pick 1 of 3 (keys 1/2/3): weapons, powerups, or abilities.
 * The more you've died this round, the better the odds of rare/epic stuff
 * (comeback mechanic). Bots roll & auto-pick too, so it stays fair.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Loot = (function () {
  const RARITY = {
    common: { label: 'COMMON', color: '#9fb2c8' },
    rare:   { label: 'RARE',   color: '#40c8ff' },
    epic:   { label: 'EPIC',   color: '#ff5db1' },
  };

  const KIND_LABELS = { weapon: 'Weapon', power: 'Powerup', ability: 'Ability', nade: 'Grenades' };

  /* clean line-art glyphs (no emoji) — colored via CSS currentColor */
  const svg = (inner, fill) =>
    `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const GLYPHS = {
    speed:      svg('<path d="M4 6l6 6-6 6"/><path d="M12 6l6 6-6 6"/>'),
    quickhands: svg('<path d="M13 2L5 14h6l-2 8 8-12h-6l2-8z"/>', true),
    bigmags:    svg('<rect x="8" y="3" width="8" height="13" rx="1.5"/><path d="M8 19.5h8"/>'),
    longarm:    svg('<path d="M12 4v9a4 4 0 1 0 8 0"/><circle cx="12" cy="3.4" r="1.4"/>'),
    moonboots:  svg('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>'),
    feather:    svg('<path d="M20 4c-6 0-11 5-12 12l-4 4"/><path d="M8 16c6 1 11-4 12-12"/>'),
    heavyweight:svg('<path d="M9 8a3 3 0 1 1 6 0"/><rect x="5" y="8" width="14" height="11" rx="3"/>'),
    titan:      svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3.5M12 18v3.5M2.5 12H6M18 12h3.5"/>'),
    doublejump: svg('<path d="M6 13.5l6-6 6 6"/><path d="M6 20l6-6 6 6"/>'),
    dash:       svg('<path d="M5 12h12M13 6l6 6-6 6"/><path d="M3 6h5M3 18h5"/>'),
    pound:      svg('<path d="M12 3v11M6.5 9l5.5 5.5L17.5 9"/><path d="M4 20.5h16"/>'),
    he:         svg('<circle cx="12" cy="13.5" r="7"/><path d="M12 6.5V3.5M9 3.5h6"/>'),
    molly:      svg('<path d="M12 2.5c3 4 7 6 7 11a7 7 0 1 1-14 0c0-3 1.7-5 3-7 1 2 2.2 3 4 3-1.2-2.8-1.2-5 0-7z"/>', true),
    vortex:     svg('<path d="M21 12a9 9 0 1 1-9-9"/><path d="M16.5 12a4.5 4.5 0 1 1-4.5-4.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>'),
  };

  /* ------------------- the item pool ------------------- */
  const ITEMS = [
    // --- weapons (replace your LMB weapon; pistol is the starter) ---
    { id: 'blaster',  kind: 'weapon', rarity: 'common' },
    { id: 'scatter',  kind: 'weapon', rarity: 'common' },
    { id: 'smg',      kind: 'weapon', rarity: 'common' },
    { id: 'longshot', kind: 'weapon', rarity: 'rare'   },
    { id: 'magnum',   kind: 'weapon', rarity: 'rare'   },
    { id: 'mega',     kind: 'weapon', rarity: 'epic'   },
    { id: 'lobber',   kind: 'weapon', rarity: 'epic'   },

    // --- grenade packs (set your G-slot) ---
    { id: 'nades_he', kind: 'nade', rarity: 'common', nade: 'he', count: 3 },
    { id: 'nades_molly', kind: 'nade', rarity: 'rare', nade: 'molly', count: 3 },
    { id: 'nades_vortex', kind: 'nade', rarity: 'rare', nade: 'vortex', count: 3 },

    // --- powerups (passive, stack with each other, no duplicates) ---
    { id: 'speed', kind: 'power', rarity: 'common', icon: '🏃', name: 'SPEED DEMON',
      desc: '+16% run speed.',
      apply: (p) => { p.mods.speedMult *= 1.16; } },
    { id: 'quickhands', kind: 'power', rarity: 'common', icon: '⚡', name: 'QUICK HANDS',
      desc: '-30% weapon cooldowns.',
      apply: (p) => { p.mods.cdMult *= 0.7; } },
    { id: 'bigmags', kind: 'power', rarity: 'common', icon: '📦', name: 'BIG MAGS',
      desc: '+50% magazine size.',
      apply: (p) => { p.mods.magMult *= 1.5; } },
    { id: 'longarm', kind: 'power', rarity: 'common', icon: '🪝', name: 'LONG ARM',
      desc: 'Grapple: +50% range, -40% cooldown.',
      apply: (p) => { p.mods.grappleRangeMult *= 1.5; p.mods.grappleCdMult *= 0.6; } },
    { id: 'moonboots', kind: 'power', rarity: 'rare', icon: '🌙', name: 'MOON BOOTS',
      desc: '+18% jump force.',
      apply: (p) => { p.mods.jumpMult *= 1.18; } },
    { id: 'feather', kind: 'power', rarity: 'rare', icon: '🪶', name: 'FEATHERWEIGHT',
      desc: '-18% gravity. Floaty airtime.',
      apply: (p) => { p.mods.gravMult *= 0.82; } },
    { id: 'heavyweight', kind: 'power', rarity: 'rare', icon: '🐘', name: 'HEAVYWEIGHT',
      desc: 'Take 28% less knockback.',
      apply: (p) => { p.mods.knockResist *= 0.72; } },
    { id: 'titan', kind: 'power', rarity: 'epic', icon: '🦾', name: 'TITAN GRIP',
      desc: 'Your shots push 30% harder.',
      apply: (p) => { p.mods.powerMult *= 1.3; } },

    // --- abilities (new moves) ---
    { id: 'doublejump', kind: 'ability', rarity: 'epic', icon: '🕊️', name: 'DOUBLE JUMP',
      desc: 'SPACE mid-air — the second jump is HIGHER.',
      apply: (p) => { p.abilities.doubleJump = true; } },
    { id: 'dash', kind: 'ability', rarity: 'epic', icon: '💨', name: 'AIR DASH',
      desc: 'Press F: burst toward where you look.',
      apply: (p) => { p.abilities.dash = true; } },
    { id: 'pound', kind: 'ability', rarity: 'epic', icon: '⬇️', name: 'GROUND POUND',
      desc: 'Crouch mid-air: slam down, shockwave on impact.',
      apply: (p) => { p.abilities.pound = true; } },
  ];

  /* card contents: weapons get a real 3D render, everything else a glyph */
  function describe(item) {
    const kind = KIND_LABELS[item.kind];
    if (item.kind === 'weapon') {
      const w = SKY.TUNING.weapons[item.id];
      return { img: SKY.Effects.weaponThumb(item.id), glyph: GLYPHS.dash,
        name: w.label, desc: w.desc, color: w.color, kind };
    }
    if (item.kind === 'nade') {
      const n = SKY.TUNING.grenades[item.nade];
      return { glyph: GLYPHS[item.nade], name: n.label + ' ×' + item.count, color: n.color, kind,
        desc: item.nade === 'he' ? 'Classic boom. Cook it, lob it.'
            : item.nade === 'molly' ? 'Burning pool — stand in it and fly.'
            : 'Sucks everyone in, then POPS.' };
    }
    return { glyph: GLYPHS[item.id], name: item.name, desc: item.desc,
      color: RARITY[item.rarity].color, kind };
  }

  /* which items may be offered to this pawn right now */
  function candidates(pawn) {
    return ITEMS.filter(it => {
      if (it.kind === 'weapon') return it.id !== pawn.weapon;
      return !pawn.owned.has(it.id);
    });
  }

  /* roll 3 distinct choices, rarity-weighted by pawn.deaths */
  function roll(pawn) {
    const table = SKY.TUNING.loot.weightsByDeath;
    const w = table[Math.min(Math.max(pawn.deaths, 1), table.length) - 1];
    const weightOf = { common: w[0], rare: w[1], epic: w[2] };
    const pool = candidates(pawn);
    const picks = [];
    for (let n = 0; n < 3 && pool.length; n++) {
      let total = 0;
      for (const it of pool) total += weightOf[it.rarity];
      let r = Math.random() * total;
      let chosen = pool[pool.length - 1];
      for (const it of pool) { r -= weightOf[it.rarity]; if (r <= 0) { chosen = it; break; } }
      picks.push(chosen);
      pool.splice(pool.indexOf(chosen), 1);
    }
    return picks;
  }

  function apply(pawn, item) {
    if (!item) return;
    if (item.kind === 'weapon') {
      pawn.giveWeapon(item.id);      // slot 1, drawn immediately
    } else if (item.kind === 'nade') {
      pawn.nades = { type: item.nade, count: item.count };
    } else {
      pawn.owned.add(item.id);
      item.apply(pawn);
    }
    if (pawn.isLocal) {
      const d = describe(item);
      SKY.HUD.killFeed('Picked up <b>' + d.name + '</b>');
      SKY.SFX.pick();
    }
  }

  /* bots: roll and auto-pick (weapons preferred slightly, else random) */
  function autoPick(pawn) {
    const picks = roll(pawn);
    if (!picks.length) return;
    apply(pawn, SKY.U.pick(picks));
  }

  return { RARITY, ITEMS, describe, roll, apply, autoPick };
})();
