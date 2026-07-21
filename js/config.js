/* =============================================================================
 * SKY PUSH — TUNING (the whole game feel lives in this file)
 * =============================================================================
 * Every value here is safe to tweak and hot-reloads with a browser refresh.
 *
 * HOW TO TUNE MOVEMENT FEEL (quick guide):
 *   - Game feels sluggish        -> raise walkSpeed, groundAccel, lower friction
 *   - Bhop too hard to keep      -> raise jumpBufferTime, keep autoBhop true
 *   - Air strafing too weak      -> raise airAccel or airMaxWishSpeed
 *   - Turning mid-air feels stiff-> raise airControlTurn
 *   - Speed snowballs forever    -> lower bhopSoftCap / raise bhopSoftCapDrag
 *   - Slide feels pointless      -> raise slideBoost, lower slideFriction
 *
 * HOW TO TUNE KNOCKBACK FEEL (per weapon in `weapons` below):
 *   - Everything is a one-shot ring-out -> lower speedMult / maxKnockback
 *   - Camping is too safe               -> lower baseKnockback
 *   - Launches feel flat                -> raise upFactor (more vertical pop)
 *   - Movement skill not rewarded enough-> raise speedMult / airborneBonus
 * =============================================================================
 */
window.SKY = window.SKY || {};

SKY.TUNING = {

  input: {
    mouseSens: 0.0022,     // radians per pixel of mouse movement
    zoomSensMult: 0.45,    // sensitivity multiplier while aiming/scoped
    invertY: false,
    maxLookSpeed: 14000,   // px/sec cap on look input — spurious pointer-lock
                           // spikes get flattened; real flicks pass through
  },

  /* ------------------------------------------------------------------
   * MOVEMENT — Quake/Source-style controller (units: meters, seconds)
   * ------------------------------------------------------------------ */
  move: {
    walkSpeed:       9.0,   // max ground speed from plain WASD (m/s)
    crouchSpeedMult: 0.45,  // ground speed multiplier while crouch-walking
    groundAccel:     11.0,  // ground accel (Quake-style: time-to-top ~ 1/accel s)
    friction:        6.5,   // ground friction. Higher = stops faster
    stopSpeed:       2.6,   // below this speed friction bites harder (crisp stops)
    gravity:         24.0,  // arcade gravity, ~2.4x realistic = snappy jumps
    jumpForce:       8.6,   // initial jump velocity (jump height = j^2 / 2g ≈ 1.5m)
    jumpBufferTime:  0.15,  // press jump slightly before landing and it still counts
    coyoteTime:      0.10,  // can still jump this long after walking off an edge
    autoBhop:        true,  // hold SPACE to chain hops perfectly. false = strict timing
    groundStick:     2.0,   // small downward velocity while grounded (ramp contact)
    maxFallSpeed:    60.0,

    // --- air movement (this is where the skill ceiling lives) ---
    airForwardAccel: 2.2,   // direct mid-air steering, capped at walkSpeed. Lets hold-W+Space
                            // bhop reach run speed (party-friendly). Set 0 for hardcore Quake.
    airAccel:        70.0,  // how hard air-strafing accelerates you (Quake airaccelerate)
    airMaxWishSpeed: 1.0,   // classic 30-unit style cap: speed gain per strafe direction (m/s)
    airControlTurn:  5.0,   // CPM-style: holding only W lets you steer velocity with the mouse.
                            // W-only ON PURPOSE — applying it to A/D yanks velocity sideways
                            // and feels like braking (tried, reverted)
    bhopSoftCap:     20.0,  // above this horizontal speed, extra drag kicks in
    bhopSoftCapDrag: 2.4,   // strength of that drag (prevents infinite snowballing)

    // --- slide (default bind: Shift, rebindable in settings) ---
    slideMinSpeed:   6.8,   // must be at least this fast (and grounded) to start a slide
    slideBoost:      3.4,   // one-time speed boost when the slide starts
    slideDuration:   0.90,  // slide auto-ends after this long
    slideFriction:   0.55,  // friction during slide — low = long icy slides
    slideSteer:      2.1,   // rad/s of steering authority while sliding
    slideSlopePull:  30.0,  // downhill acceleration while sliding on ramps
    slideCooldown:   0.55,  // delay before you can slide again

    // --- body dimensions ---
    standHeight:  1.8,
    crouchHeight: 1.2,
    radius:       0.42,
    eyeStand:     1.62,
    eyeCrouch:    0.95,
  },

  /* ------------------------------------------------------------------
   * WEAPONS — fast PROJECTILE bullets (tracer darts with real travel time,
   * so shots are dodgeable at range but near-instant up close).
   * Still knockback-based; the core rule for every one of them:
   *   force = baseKnockback + shooterSpeed * speedMult
   *   ... * airborneBonus if the shooter was in the air
   *   ... * slideBonus    if the shooter was sliding
   *   ... * headshotMult  on a headshot (also triggers the ragdoll)
   * `projSpeed` = bullet velocity (the dodge-ability dial per gun).
   * `mag`/`reloadTime` = ammo. `auto` = hold LMB. `spreadDeg` vs
   * `zoomSpreadDeg` = hipfire vs aimed (RMB). You START with the pistol;
   * everything else comes from death rewards.
   * ------------------------------------------------------------------ */
  weapons: {
    pistol: {
      label: 'POP PISTOL', short: 'PISTOL', icon: '✨', rarity: 'starter', color: '#7dff9e',
      desc: 'Trusty starter sidearm. Fan the hammer.',
      cooldown: 0.22, auto: false, mag: 8, reloadTime: 1.1, range: 70,
      projSpeed: 46, projGravity: 2,
      pellets: 1, spreadDeg: 0.8, zoomSpreadDeg: 0.35, zoomFov: 68,
      baseKnockback: 4.6, speedMult: 0.6, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 2.2, upFactor: 0.3, maxKnockback: 28, selfRecoil: 0.35, kick: 0.7, kickPitch: 0.011,
    },
    blaster: {
      label: 'PUSH RIFLE', short: 'RIFLE', icon: '🔫', rarity: 'common', color: '#40c8ff',
      desc: 'Reliable full-auto shover.',
      cooldown: 0.16, auto: true, mag: 18, reloadTime: 1.5, range: 90,
      projSpeed: 58, projGravity: 1.5,
      pellets: 1, spreadDeg: 1.1, zoomSpreadDeg: 0.45, zoomFov: 62,
      baseKnockback: 3.4, speedMult: 0.46, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 2.0, upFactor: 0.3, maxKnockback: 26, selfRecoil: 0.25, kick: 0.55, kickPitch: 0.0075,
    },
    scatter: {
      label: 'SCATTER PUSHER', short: 'SCATTER', icon: '💥', rarity: 'rare', color: '#ffd34d',
      desc: 'Pellet wall. Recoil doubles as a jump.',
      cooldown: 0.95, auto: false, mag: 5, reloadTime: 1.9, range: 26,
      projSpeed: 36, projGravity: 5,
      pellets: 6, spreadDeg: 6.5, zoomSpreadDeg: 5, zoomFov: 74,
      baseKnockback: 2.5, speedMult: 0.28, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 1.5, upFactor: 0.32, maxKnockback: 15, selfRecoil: 4.5, kick: 1.6, kickPitch: 0.030,
    },
    longshot: {
      label: 'LONGSHOT', short: 'SNIPER', icon: '🎯', rarity: 'rare', color: '#ff5db1',
      desc: 'Scoped cannon. Near-instant bolt; no-scopes fly wild.',
      cooldown: 1.45, auto: false, mag: 4, reloadTime: 2.2, range: 200,
      projSpeed: 160, projGravity: 0,
      pellets: 1, spreadDeg: 5.5, zoomSpreadDeg: 0.03, zoomFov: 26, scope: true,
      baseKnockback: 17, speedMult: 1.4, airborneBonus: 1.35, slideBonus: 1.35,
      headshotMult: 1.9, upFactor: 0.3, maxKnockback: 52, selfRecoil: 2.6, kick: 2.2, kickPitch: 0.034,
    },
    mega: {
      label: 'MEGA RIFLE', short: 'MEGA', icon: '🌀', rarity: 'epic', color: '#c39bff',
      desc: 'The rifle, but angry. Faster, harder, meaner. Scoped.',
      cooldown: 0.12, auto: true, mag: 24, reloadTime: 1.6, range: 100,
      projSpeed: 68, projGravity: 1,
      // the model carries a scope — RMB uses it (milder zoom than the sniper)
      pellets: 1, spreadDeg: 0.9, zoomSpreadDeg: 0.25, zoomFov: 34, scope: true,
      baseKnockback: 4.3, speedMult: 0.6, airborneBonus: 1.35, slideBonus: 1.35,
      headshotMult: 2.0, upFactor: 0.32, maxKnockback: 31, selfRecoil: 0.3, kick: 0.6, kickPitch: 0.006,
    },
    smg: {
      label: 'RATTLER SMG', short: 'SMG', icon: '🔩', rarity: 'common', color: '#7dd8a8',
      desc: 'Hose of tiny pushes. Melts campers.',
      cooldown: 0.08, auto: true, mag: 30, reloadTime: 1.7, range: 55,
      projSpeed: 52, projGravity: 2,
      pellets: 1, spreadDeg: 1.8, zoomSpreadDeg: 1.0, zoomFov: 70,
      baseKnockback: 2.1, speedMult: 0.3, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 1.8, upFactor: 0.28, maxKnockback: 17, selfRecoil: 0.12, kick: 0.35, kickPitch: 0.005,
    },
    magnum: {
      label: 'IRON MAGNUM', short: 'MAGNUM', icon: '🔷', rarity: 'rare', color: '#8ab4ff',
      desc: 'Six chambers of raw shove. Slow but rude.',
      cooldown: 0.75, auto: false, mag: 6, reloadTime: 2.0, range: 110,
      projSpeed: 90, projGravity: 0.5,
      pellets: 1, spreadDeg: 0.4, zoomSpreadDeg: 0.15, zoomFov: 58,
      baseKnockback: 11.5, speedMult: 1.05, airborneBonus: 1.35, slideBonus: 1.35,
      headshotMult: 2.1, upFactor: 0.32, maxKnockback: 43, selfRecoil: 1.8, kick: 1.7, kickPitch: 0.024,
    },
    lobber: {
      label: 'LOBBER', short: 'LOBBER', icon: '🎈', rarity: 'epic', color: '#ffb85a',
      desc: 'Arcing blast shells. Area denial, area YEET.',
      cooldown: 1.3, auto: false, mag: 4, reloadTime: 2.4, range: 80,
      projSpeed: 26, projGravity: 14, blastRadius: 4, blastUp: 9,
      pellets: 1, spreadDeg: 0.5, zoomSpreadDeg: 0.3, zoomFov: 72,
      baseKnockback: 14, speedMult: 0.7, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 1.0, upFactor: 0.3, maxKnockback: 36, selfRecoil: 2.0, kick: 2.0, kickPitch: 0.024,
    },
    burst: {
      label: 'TRIPLET', short: 'TRIPLET', icon: '🎶', rarity: 'common', color: '#63e6b0',
      desc: 'Three quick pushes per squeeze.',
      cooldown: 0.46, auto: true, mag: 21, reloadTime: 1.6, range: 85,
      projSpeed: 60, projGravity: 1.5, burstCount: 3, burstDelay: 0.07,
      pellets: 1, spreadDeg: 1.2, zoomSpreadDeg: 0.5, zoomFov: 64,
      baseKnockback: 3.2, speedMult: 0.44, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 2.0, upFactor: 0.3, maxKnockback: 25, selfRecoil: 0.3, kick: 0.5, kickPitch: 0.008,
    },
    boomstick: {
      label: 'BOOMSTICK', short: 'BOOM', icon: '🧨', rarity: 'epic', color: '#9dff57',
      desc: 'Both barrels at once. The recoil is a travel plan.',
      cooldown: 1.1, auto: false, mag: 2, ammoPerShot: 2, reloadTime: 2.1, range: 22,
      projSpeed: 34, projGravity: 5,
      pellets: 10, spreadDeg: 9, zoomSpreadDeg: 7, zoomFov: 74,
      baseKnockback: 2.8, speedMult: 0.3, airborneBonus: 1.35, slideBonus: 1.35,
      headshotMult: 1.5, upFactor: 0.34, maxKnockback: 16, selfRecoil: 10.5, kick: 2.4, kickPitch: 0.05,
    },
    bouncer: {
      label: 'RICOCHET', short: 'RICO', icon: '🎾', rarity: 'rare', color: '#57e6e6',
      desc: 'Darts bounce off walls. Bank shots humiliate.',
      cooldown: 0.28, auto: true, mag: 12, reloadTime: 1.6, range: 110,
      projSpeed: 48, projGravity: 0.5, bounces: 3,
      pellets: 1, spreadDeg: 1.0, zoomSpreadDeg: 0.4, zoomFov: 66,
      baseKnockback: 4.4, speedMult: 0.55, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 2.0, upFactor: 0.3, maxKnockback: 27, selfRecoil: 0.4, kick: 0.7, kickPitch: 0.010,
    },
    quad: {
      label: 'POP QUAD', short: 'QUAD', icon: '🍇', rarity: 'epic', color: '#b3f04d',
      desc: 'Four mini-shells. A glorious carpet of boops.',
      cooldown: 1.2, auto: false, mag: 8, ammoPerShot: 4, reloadTime: 2.5, range: 70,
      projSpeed: 22, projGravity: 12, blastRadius: 2.6, blastUp: 6,
      pellets: 4, spreadDeg: 5, zoomSpreadDeg: 4, zoomFov: 72,
      baseKnockback: 7, speedMult: 0.5, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 1.0, upFactor: 0.3, maxKnockback: 26, selfRecoil: 3, kick: 2.3, kickPitch: 0.030,
    },
    // IT mode only — the seeker's tag gun. Point blank = you FLY, no matter
    // where it hits. Never appears in loot pools / lockers / DM lists.
    seeker: {
      label: 'TAG CANNON', short: 'TAG', icon: '👹', rarity: 'epic', color: '#ff4444',
      desc: 'One tag and they fly. Close range only.',
      // rangeGrace 0: pellets die EXACTLY at range — no cross-map tags
      // (the default +0.15s bullet grace was adding ~10m of reach)
      cooldown: 0.9, auto: false, mag: 999, reloadTime: 0.5, range: 6.5, rangeGrace: 0,
      projSpeed: 70, projGravity: 0,
      pellets: 5, spreadDeg: 7, zoomSpreadDeg: 5, zoomFov: 74,
      // strong enough to throw you OFF the platform, not into orbit
      baseKnockback: 28, speedMult: 0, airborneBonus: 1, slideBonus: 1,
      headshotMult: 1, upFactor: 0.42, maxKnockback: 44, selfRecoil: 0.5, kick: 1.8, kickPitch: 0.02,
    },
    piston: {
      label: 'PISTON CANNON', short: 'PISTON', icon: '🔩', rarity: 'common', color: '#ff8560',
      desc: 'Hold to compress. Release to launch someone — and yourself.',
      cooldown: 0.55, auto: false, mag: 5, reloadTime: 2.0, range: 90,
      // projGravity is the FULL-charge trajectory; releaseCharge lobs
      // low-charge shots (slow + heavy arc) and lasers full ones
      projSpeed: 50, projGravity: 0.4, charge: 1.1, chargeMult: 3.4,
      pellets: 1, spreadDeg: 0.6, zoomSpreadDeg: 0.3, zoomFov: 66,
      baseKnockback: 7, speedMult: 0.8, airborneBonus: 1.3, slideBonus: 1.3,
      headshotMult: 1.8, upFactor: 0.32, maxKnockback: 56, selfRecoil: 2.0, kick: 2.2, kickPitch: 0.030,
    },
    /* ------------- LEGENDARY tier: rare drops, big fantasy ------------- */
    minigun: {
      label: 'SHREDDER MINIGUN', short: 'MINIGUN', icon: '🌀', rarity: 'legendary', color: '#ffa733',
      desc: 'A wall of lead. Hold the line.',
      cooldown: 0.075, auto: true, mag: 60, reloadTime: 3.0, range: 55,
      projSpeed: 70, projGravity: 2,
      pellets: 1, spreadDeg: 1.8, zoomSpreadDeg: 1.4, zoomFov: 72,
      baseKnockback: 3.8, speedMult: 0.5, airborneBonus: 1.25, slideBonus: 1.25,
      headshotMult: 1.5, upFactor: 0.3, maxKnockback: 22, selfRecoil: 0.3, kick: 0.7, kickPitch: 0.006,
    },
    flamer: {
      label: 'DRAGON BREATH', short: 'FLAMER', icon: '🔥', rarity: 'legendary', color: '#ff6a26',
      desc: 'A cone of fire. Useless far away, monstrous up close.',
      cooldown: 0.055, auto: true, mag: 90, reloadTime: 2.6, range: 17, rangeGrace: 0,
      projSpeed: 22, projGravity: -1.2, flameJet: true,
      pellets: 1, spreadDeg: 5, zoomSpreadDeg: 4.5, zoomFov: 74,
      baseKnockback: 2.6, speedMult: 0.4, airborneBonus: 1.25, slideBonus: 1.25,
      headshotMult: 1.2, upFactor: 0.55, maxKnockback: 16, selfRecoil: 0.12, kick: 0.5, kickPitch: 0.003,
    },
  },

  /* ------------------------------------------------------------------
   * GRENADES — thrown with G. Everyone spawns with 2 HE per life; other
   * types come from level-up rewards (packs).
   * ------------------------------------------------------------------ */
  grenades: {
    // three DISTINCT roles: HE = raw boom, FIRE POOL = area denial that
    // juggles, VORTEX = gather everyone then POP them (combo tool)
    he:     { label: 'HE GRENADE', icon: '💣', color: '#ff8a4a', price: 300,
              fuse: 1.3, radius: 6, force: 24, up: 12, throwSpeed: 27 },
    molly:  { label: 'FIRE POOL', icon: '🔥', color: '#ff5a2a', price: 400,
              fuse: 0.4, duration: 6, radius: 4.2, tickForce: 13, throwSpeed: 24 },
    vortex: { label: 'VORTEX', icon: '🌀', color: '#a48aff', price: 500,
              fuse: 0.9, duration: 3.0, radius: 8, pull: 30, throwSpeed: 24,
              popForce: 15, popUp: 9 },   // finale blast flings everyone it gathered
  },
  nadeStart: { type: 'he', count: 2 },   // per life in party modes

  /* shared knockback + hit rules */
  knock: {
    victimMinUpVel: 4.0,   // strong hits always pop the victim at least this far up
    headRadius: 0.36,      // headshot hitbox — matches the big toon heads
    headBoneLift: 0.45,    // head-bone origin is at the neck; ball sits above it
                           // (tuned against the UACP rig with debug spheres)
    bodyRadius: 0.55,      // bullet-vs-body capsule radius
    // grounded victims get popped AIRBORNE by any real hit so ground friction
    // can't eat the push — a runner flies as far as a jumper.
    groundPop: {
      minForce: 2.5,       // hits weaker than this don't lift (pistol pokes still do at range)
      base: 3.2,           // lift velocity floor once it triggers
      scale: 0.4,          // + this much lift per unit of impulse
      max: 8.5,            // lift cap so point-blank sniper doesn't moonshot
    },
  },

  /* ------------------------------------------------------------------
   * RAGDOLL — the cinematic reaction system.
   *   headshot            -> full ragdoll on the spot, stand back up
   *   any hit while midair-> ragdoll until close to the ground, recover
   * (visual verlet puppet; the gameplay capsule keeps simulating)
   * ------------------------------------------------------------------ */
  ragdoll: {
    headshotTime: 1.35,    // seconds on the floor after a headshot
    recoverHeight: 1.6,    // airborne ragdolls recover this close to ground
    minAirForce: 6,        // airborne hits weaker than this don't ragdoll
    standupTime: 0.4,      // blend from ragdoll pose back to animation
    damping: 0.995,        // verlet velocity keep (lower = floppier stops)
    friction: 0.6,         // ground rub for ragdoll particles
  },

  /* ------------------------------------------------------------------
   * AIR CANNON — everyone's utility (Q). Short cone, huge close shove,
   * recoil pushes YOU backward (aim at the ground behind you = boost jump).
   * ------------------------------------------------------------------ */
  cannon: {
    cooldown:      2.4,
    fireDelay:     0.16,  // blast lands when the takeout anim hits its kick
    range:         6.5,
    coneDeg:       55,
    baseKnockback: 13.0,
    speedMult:     0.5,
    upFactor:      0.30,
    selfRecoil:    7.5,
  },

  /* ------------------------------------------------------------------
   * GRAPPLE — recovery tool (RMB, hold to reel). Tuned to actually save
   * you: decent range/duration, quick recharge, tap-release refunds most
   * of the cooldown.
   * ------------------------------------------------------------------ */
  grapple: {
    range:        26.0,   // max attach distance — a real limit, no cross-map ropes
                          // (Long Arm powerup extends it ×1.5)
    // HEAVY hits jam the hook: a clean big yeet (cannon, charged piston,
    // point-blank blast) should actually stick — no free hook-back. Light
    // and medium pokes still refill the air-hook like before.
    heavyKnock:     15.0,  // impulse magnitude that counts as heavy
    heavyLockScale: 0.22,  // lock seconds per impulse unit over the threshold
    heavyLockMin:   0.5,
    heavyLockMax:   2.4,
    reelSpeed:    5.5,    // m/s the rope winches in while held (slow = real swings)
    // MOMENTUM reel: a near-vertical rope barely winches — dead-hanging under
    // a ledge is not a free elevator. Swing speed restores the full rate, so
    // saves are about building an arc, not holding a button.
    hangReelMin:    0.15, // reel multiplier when dangling straight below the point
    swingSpeedFull: 12.0, // moving this fast reels at full rate at any angle
    pullAccel:    26.0,   // assist acceleration toward the point (×0.35 applied)
    maxDuration:  3.5,    // rope auto-releases after this long (was 6 — hang naps)
    breakDist:    1.4,    // rope releases when you get this close to the point
    cooldown:     1.2,    // brief regen — half the air-cannon's cooldown
    minCdFrac:    0.3,    // ...a quick tap only costs this fraction of it
    missCooldown: 0.12,   // short cooldown if you fire and hit nothing
    assistDeg:    6.0,    // aim assist: cone-search this many degrees around the
                          // crosshair when the exact ray misses (panic saves!)
    airHooks:     1,      // hooks per airtime — landing (or getting hit) refills
    // hooking a PLAYER reels THEM to YOU (hold to keep pulling)
    playerYank:      9.0,   // instant impulse toward you on attach
    playerYankUp:    4.5,   // instant lift on attach (pops them off the ground)
    playerPull:      46.0,  // sustained pull acceleration while the rope holds
    playerBreakDist: 2.0,   // rope releases when they reach you
    playerDuration:  1.6,   // max time you can drag someone per hook
  },

  /* ------------------------------------------------------------------
   * ABILITIES (from death rewards)
   * ------------------------------------------------------------------ */
  abilities: {
    dashCooldown: 4.0,    // Air Dash (F): horizontal burst toward where you look
    dashSpeed:    15.0,   // minimum speed after dashing
    dashBoost:    7.0,    // added on top of current speed if already faster
    doubleJumpMult: 1.2,  // second jump is HIGHER than the first (worth taking)
    poundSpeed:   30.0,   // Ground Pound: slam-down velocity
    poundRadius:  4.5,    // landing shockwave
    poundForce:   13.0,
    poundUp:      9.0,
    poundMinAir:  2.0,    // must be this high above ground to trigger
  },

  /* ------------------------------------------------------------------
   * SPARK RUSH — the flagship mode. KOs burst into spark orbs; hoover
   * them up to score AND level up (live pick-1-of-3, no pause). Dying
   * scatters part of your bank where you last stood. Momentum is power:
   * your pickup magnet grows with your speed.
   * ------------------------------------------------------------------ */
  spark: {
    target:      40,      // sparks banked = instant win
    timeLimit:   300,     // otherwise richest at the buzzer wins
    koMint:      3,       // orbs the arena mints per KO (on top of the drop)
    dropFrac:    0.3,     // share of the victim's bank that scatters
    trickleEvery: 6,      // ambient orb cadence (seconds)
    maxAmbient:  10,      // ambient orbs allowed on the map
    magnetBase:  2.4,     // pickup radius standing still
    magnetSpeed: 0.13,    // +radius per unit of horizontal speed
    levels:      [6, 14, 24, 36],  // banked-spark thresholds -> level-up pick
    pickTime:    7,       // seconds to choose before auto-pick
    frenzyAt:    60,      // final N seconds: KOs mint DOUBLE
    respawnDelay: 2.5,
  },

  /* ------------------------------------------------------------------
   * DEATHMATCH — one timed round, most points wins. KOs score, assists
   * score less, KOs with the ROTATING BONUS WEAPON score extra (CS:GO DM
   * style), and every N-KO streak pays a bonus. Pick any weapon with the
   * loadout menu (B) — it sticks through respawns. No loot cards.
   * ------------------------------------------------------------------ */
  dm: {
    timeLimit:    600,    // seconds (menu pills: 5/10/15 min)
    respawnDelay: 2.5,
    koPts:        2,      // throwing someone off
    assistPts:    1,      // most recent OTHER hitter inside the credit window
    bonusPts:     2,      // extra when the KO used the bonus weapon
    bonusEvery:   60,     // seconds each bonus weapon stays up
    streakEvery:  3,      // every N KOs without dying...
    streakPts:    1,      // ...pays this on top
  },

  /* ------------------------------------------------------------------
   * DEATH REWARDS — after each KO you pick 1 of 3 (keys 1/2/3).
   * Rarity odds shift with how many times you've died this round.
   * ------------------------------------------------------------------ */
  loot: {
    // [common, rare, epic] weights by death count (1st, 2nd, 3rd+ death)
    // columns: common / rare / epic / LEGENDARY (rows = deaths this round)
    weightsByDeath: [
      [80, 18, 2, 0.3],
      [50, 38, 12, 1],
      [25, 45, 30, 3],
    ],
  },

  /* ------------------------------------------------------------------
   * IT (tag) — one SEEKER hunts; everyone else runs with only hook +
   * cannon. Seeker's tag gun insta-yeets. Runners out = seeker wins;
   * survive the clock = runners win.
   * ------------------------------------------------------------------ */
  it: {
    hideTime:  8,      // seconds the seeker is frozen while runners scatter
    roundTime: 180,    // default round length when no rule is set
  },

  /* ------------------------------------------------------------------
   * CROWN RUSH mode — hold the crown to charge the win meter.
   * KOs don't cost lives here; dropping the crown is the punishment.
   * ------------------------------------------------------------------ */
  crown: {
    holdToWin:    25,    // seconds of total crown time to win the round
    pickupRadius: 1.6,
  },

  /* ------------------------------------------------------------------
   * GAME RULES
   * ------------------------------------------------------------------ */
  game: {
    lives:             3,
    timeLimit:         0,     // optional lbs/crown round cap in seconds (0 = off)
    respawnDelay:      2.5,
    killY:           -22.0,   // per-map override in map.js
    countdown:         3,
    roundRestartDelay: 5.0,
    koCreditWindow:    5.0,
    roundsToWin:       2,     // first to N round wins takes the match
    overtimeStart:     45,    // seconds until OVERTIME (arena crumbles / traffic speeds up)
  },

  /* ------------------------------------------------------------------
   * CAMERA & FEEDBACK
   * ------------------------------------------------------------------ */
  camera: {
    baseFov:       95,
    speedFovBoost: 14,
    fovSpeedMin:   9,
    fovSpeedMax:   24,
    strafeLean:    0.013,
    slideRoll:     0.05,
    shakeFire:     0.35,
    shakeHitTaken: 1.1,
    shakeHitDealt: 0.4,
  },

  /* ------------------------------------------------------------------
   * BOTS (stand-ins for networked players in this MVP)
   * ------------------------------------------------------------------ */
  bots: {
    turnSpeed:     3.6,
    aimErrorDeg:   6.0,
    aimLead:       0.7,
    fireRange:     26.0,
    fireAlignDeg:  9.0,
    fireChance:    1.4,
    cannonRange:   5.0,
    hopRate:       0.55,
    slideRate:     0.5,
    edgeLookahead: 2.3,
    thinkInterval: 0.16,
    retargetMin:   2.6,
    retargetMax:   5.5,
  },

  audio: {
    master:  0.8,     // was 0.55 — "the game makes sounds so much quieter by default"
    windMax: 0.16,
  },

  /* ------------------------------------------------------------------
   * REPLAY / MATCH EDITOR — ring buffer of the last N seconds (V key)
   * ------------------------------------------------------------------ */
  replay: {
    seconds: 720,         // ring cap — enough for a WHOLE match (all rounds)
  },
};
