/* SKY.Arms — first-person ARMS + weapon-interaction animation system.
 *
 * The viewmodel used to be a floating gun; this module gives it hands.
 * Mesh source: the player's EQUIPPED character (UACP rigged GLB) — the arm
 * triangles are extracted from the merged SkinnedMesh by skin-weight
 * (Shoulder/UpperArm/LowerArm/Fist bones), so first-person hands always
 * match the locker character, skin tone and outfit color.
 *
 * Animation: NOT baked clips — hand targets are authored as tiny keyframe
 * TIMELINES per weapon class (reload = mag-out / mag-in / bolt-rack, draw =
 * raise + ready gesture), solved onto the arm bones with a 2-bone analytic
 * IK every frame. The left hand physically travels to the gun's mag well,
 * which only code can know for procedural/skinned weapon meshes.
 *
 * Magazines: several Blaster-Kit GLBs carry a real `magazine` child node —
 * during a reload it is hidden on the gun, a copy rides the left fist, and
 * a third copy is DROPPED into the world with gravity. Guns without a mag
 * node get a procedural prop (pistol mag / shotgun shell / energy cell).
 */
SKY.Arms = (() => {
  let scene = null, camera = null;
  const VM_LAYER = 1;

  /* ---------------- tunables (public — poked live while tuning) -------- */
  const CFG = {
    scale: 0.46,                 // arm size vs a 1.9u body (post-normalize)
    lenMul: 2.1,                 // STRETCH the bone chain (longer, not fatter —
                                 // stock UACP arms can't reach the gun at all)
    // shoulder z -0.10: at -0.02 the anchor sat ON the camera plane and the
    // sleeve/arm cut got near-plane sliced — you saw inside the hollow arms.
    // y -0.5 = the user's armlab pass 3 (2026-07-20)
    shoulderR: [0.38, -0.5, -0.10],
    shoulderL: [-0.38, -0.5, -0.10],
    elbowHintR: [1.6, -1, -0.25],   // camera-space, normalized at use
    elbowHintL: [-1.6, -1, -0.25],
    elbowFollow: 0.65,           // elbow chases the hand's rotation (0..1)
    fistRotR: [-1.5708, 0, -0.6],   // knuckles up, fingers forward, rolled out
    fistRotL: [-1.5708, 0, 0.6],
    magGrip: [0, -0.03, 0.02],   // hand-mag offset in WORLD units (fist space)
    handDamp: 34,                // hand target chase speed
    joltScale: 1,                // global contact-jolt strength
  };

  /* ---------------- procedural sway (spring-damper inertia) ----------------
   * The whole viewmodel (gun + arms, via vm.root) hangs on underdamped
   * springs excited by look input, movement, landings, fire kick jolts and
   * the reload choreography itself — the weapon WAVES and settles instead
   * of being bolted to the camera. All params live-tunable in ?armlab. */
  /* defaults = the user's first ?armlab tuning pass (2026-07-19) */
  const SWAY = {
    freq: 3.4,        // spring stiffness (higher = tighter)
    zeta: 0.78,       // damping ratio (<1 overshoots = the wave)
    lookRot: 0.054,   // look speed -> rotation lag
    lookPos: 0.009,   // look speed -> position lag
    lookRoll: 0.02,   // look speed -> roll
    movePos: 0.024,   // strafe/vertical velocity -> position drift
    moveRoll: 0.012,  // strafe -> lean
    fallTilt: 0.065,  // vertical velocity -> muzzle tilt
    riseFloat: 0.014, // vertical velocity -> float down/up
    bobAmp: 0.012,    // run bob amplitude (scales with speed)
    bobFreq: 7.2,
    bobRoll: 3.4,     // how much bob leaks into roll
    landKick: 0.045,  // landing impact -> dip impulse
    animFeed: 4.6,    // reload/draw gun motion -> body sway excitation
    joltFeed: 1,      // contact jolts -> body sway excitation
    fireFeed: 1,      // fire impulse -> body sway excitation (heavy thump)
    maxRot: 0.17, maxPos: 0.055,
  };
  const swayState = {
    rx: { p: 0, v: 0 }, ry: { p: 0, v: 0 }, rz: { p: 0, v: 0 },
    px: { p: 0, v: 0 }, py: { p: 0, v: 0 }, pz: { p: 0, v: 0 },
  };
  /* ?armlab overrides persist here and load in EVERY session */
  const LAB_KEY = 'skypush-armlab';
  const RIG_OVR = {};
  try {
    const s = JSON.parse(localStorage.getItem(LAB_KEY) || '{}');
    if (s.CFG) Object.assign(CFG, s.CFG);
    if (s.SWAY) Object.assign(SWAY, s.SWAY);
    if (s.RIG) Object.assign(RIG_OVR, s.RIG);
    // migration: the pistol shrank (len 0.32→0.26, sockets rescaled) — a
    // stored override matching the OLD baked pose would misplace the hands
    const p0 = RIG_OVR.pistol;
    if (p0 && p0.grip && Math.abs(p0.grip[0] - 0.13) < 1e-6 &&
        Math.abs(p0.grip[1] + 0.135) < 1e-6) delete RIG_OVR.pistol;
    // migration: shoulders moved off the camera plane (z -0.02 → -0.10) —
    // stored CFG still carrying the untouched old default follows along
    if (CFG.shoulderR[2] === -0.02 && CFG.shoulderL[2] === -0.02) {
      CFG.shoulderR[2] = -0.10; CFG.shoulderL[2] = -0.10;
    }
  } catch (e) {}
  let bobPhase = 0;
  let slideBlend = 0;   // damped 0..1 — kills the run bob while sliding
  let landCd = 0;       // min gap between landing thumps (ramp flicker)
  const swayOut = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  function spring(s, target, dt) {
    const w = SWAY.freq * Math.PI * 2;
    // SUBSTEP the integration: in one explicit step the damping term
    // 2ζw·dt crosses 1 below ~35fps (shipped tuning) — velocity flips sign
    // every frame and the springs oscillate violently ("weird shakes" the
    // moment fps dips). Sub-8ms steps are unconditionally well-behaved.
    const n = dt > 0.008 ? Math.ceil(dt / 0.008) : 1;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      s.v += ((target - s.p) * w * w - 2 * SWAY.zeta * w * s.v) * h;
      s.p += s.v * h;
    }
    // one NaN would poison the whole viewmodel forever — never let it in
    if (!isFinite(s.p) || !isFinite(s.v)) { s.p = 0; s.v = 0; }
    // belt-and-braces: no state may ever leave sane viewmodel range
    if (s.p > 0.9) s.p = 0.9; else if (s.p < -0.9) s.p = -0.9;
    if (s.v > 40) s.v = 40; else if (s.v < -40) s.v = -40;
  }
  const clampS = (v, m) => v > m ? m : v < -m ? -m : v;
  /* ctx: {dx, dy (look pixels this frame), strafe, velY, grounded, speed,
     landed (impact speed, one frame)} — returns root pos/rot offsets */
  function swayTick(dt, ctx) {
    dt = Math.min(dt, 0.05);
    if (dt <= 0) return swayOut;
    const S = SWAY, st = swayState;
    const lvx = clampS(ctx.dx / dt, 4000, 4000) * 0.001;
    const lvy = clampS(ctx.dy / dt, 4000, 4000) * 0.001;
    spring(st.ry, clampS(-lvx * S.lookRot, S.maxRot), dt);
    spring(st.rx, clampS(lvy * S.lookRot * 0.8 + ctx.velY * S.fallTilt * 0.06, S.maxRot), dt);
    spring(st.rz, clampS(-ctx.strafe * S.moveRoll * 0.055 - lvx * S.lookRoll, S.maxRot), dt);
    spring(st.px, clampS(-ctx.strafe * S.movePos * 0.05 - lvx * S.lookPos, S.maxPos), dt);
    spring(st.py, clampS(-ctx.velY * S.riseFloat * 0.05, S.maxPos), dt);
    spring(st.pz, 0, dt);
    // land thump: threshold + cooldown — ramps/uneven ground flicker the
    // grounded flag and the repeated micro-impulses read as jitter
    landCd = Math.max(0, landCd - dt);
    if (ctx.landed > 0.12 && landCd <= 0) {
      st.py.v -= ctx.landed * S.landKick;
      st.rx.v += ctx.landed * S.landKick * 2.2;
      landCd = 0.22;
    }
    const sp = ctx.speed || 0;
    // sliding is not running — the footstep bob dies out. SLOW attack, fast
    // release: bhop chains flicker the slide state on every crouch-landing,
    // and a symmetric blend pumped the bob on/off (laggy, shaky jumps)
    const slTgt = ctx.sliding && ctx.grounded ? 1 : 0;
    slideBlend += (slTgt - slideBlend) *
      Math.min(1, (slTgt > slideBlend ? 3.5 : 12) * dt);
    if (ctx.grounded && sp > 1) {
      bobPhase += dt * S.bobFreq * (0.55 + sp * 0.055) * (1 - slideBlend * 0.7);
    }
    const amp = S.bobAmp * Math.min(1.9, sp / 7) * (ctx.grounded ? 1 : 0.22) *
      (1 - slideBlend * 0.88);
    swayOut.px = st.px.p + Math.cos(bobPhase) * amp * 0.8;
    swayOut.py = st.py.p + Math.sin(bobPhase * 2) * amp;
    swayOut.pz = st.pz.p;
    swayOut.rx = st.rx.p + Math.sin(bobPhase * 2 + 1.3) * amp * 0.8;
    swayOut.ry = st.ry.p;
    swayOut.rz = st.rz.p + Math.sin(bobPhase) * amp * S.bobRoll;
    return swayOut;
  }

  /* per-weapon rig: class + socket overrides. Sockets are WEAPON-LOCAL
     (guns are normalized: barrel -Z, bbox-centered, len = WEAPON_FIT.len).
     Defaults below are derived from len; only deviations are listed. */
  const CLS_OF = {
    pistol: 'pistol', blaster: 'rifle', mega: 'rifle', burst: 'rifle',
    bouncer: 'rifle', smg: 'rifle', scatter: 'shotgun', boomstick: 'shotgun',
    seeker: 'shotgun', longshot: 'sniper', magnum: 'revolver',
    lobber: 'launcher', quad: 'launcher', minigun: 'minigun',
    flamer: 'flamer', piston: 'cell', hookgun: 'hook', cannon: 'hook',
  };
  const LEN = {
    pistol: 0.26, blaster: 0.52, scatter: 0.50, seeker: 0.55, smg: 0.38,
    longshot: 0.72, magnum: 0.36, minigun: 0.64, flamer: 0.52, mega: 0.60,
    lobber: 0.46, hookgun: 0.38, burst: 0.54, boomstick: 0.50, bouncer: 0.40,
    quad: 0.36, piston: 0.46, cannon: 0.44,
  };
  const RIG = {};   // filled by rigOf(), overridable per gun

  /* per-weapon hand placements tuned in ?armlab by the user (first pass,
     2026-07-19) — shipped as defaults; live RIG_OVR still wins over these */
  const BAKED = {
    // blaster/pistol/magnum re-tuned in the user's armlab pass 3
    // (2026-07-20, post elbow-follow — poses lean on the arm coupling)
    blaster: { grip: [0.13, -0.08, 0.09], fore: [-0.005, -0.11, -0.295],
      gripRot: [0.02, 0.915, 0.32], foreRot: [1.33, 0.205, -0.765],
      bolt: [-0.1, 0.02, -0.08], boltRot: [1.255, -0.13, 0.055] },
    pistol: { grip: [0.075, -0.095, 0.125], fore: [-0.01, -0.085, 0.14],
      gripRot: [-0.13, 1.215, 0.02], foreRot: [-0.17, 0.095, -0.545],
      bolt: [-0.075, 0.03, 0.013], boltRot: [1.925, 0, 0] },
    mega: { grip: [0.28, -0.175, 0.095], fore: [0.35, -0.18, -0.35],
      gripRot: [-0.02, 0, 0], foreRot: [0.73, -1.665, -0.205] },
    magnum: { grip: [0.18, -0.065, -0.015], fore: [-0.11, -0.1, 0.0576],
      gripRot: [-0.17, 2.64, -1.405], foreRot: [2.49, 1.665, 0.55] },
    scatter: { grip: [0.205, -0.245, 0.14], fore: [0.05, -0.005, -0.095],
      gripRot: [0, 0, 0], foreRot: [0, 0, 0] },
    burst: { grip: [0.155, -0.13, 0.155], fore: [0.03, -0.015, -0.055],
      gripRot: [0, 0, 0], foreRot: [0, 0, 0] },
    longshot: { grip: [0.075, -0.235, 0.144], fore: [0.085, -0.105, -0.1584],
      gripRot: [-0.2, 0.02, 0.1], foreRot: [-0.095, 0.395, -0.205] },
    minigun: { grip: [0.3, -0.105, 0.1024], fore: [0.025, 0.135, -0.15],
      gripRot: [0, 0, 0], foreRot: [-0.13, 0.095, 0] },
  };

  function rigOf(kind) {
    if (RIG[kind]) return RIG[kind];
    const cls = CLS_OF[kind] || 'rifle';
    const L = LEN[kind] || 0.5;
    // grip near the back-underside, foregrip forward, mag well under-center
    const r = {
      cls, len: L,
      grip:  [0.0, -0.055, L * 0.16],
      fore:  [0.0, -0.035, -L * 0.26],
      mag:   [0.0, -0.075, -L * 0.03],
      bolt:  [0.03, 0.06, L * 0.05],   // ABOVE the receiver (0.035 sat inside)
      port:  [0.0, -0.045, -L * 0.12],
      // per-weapon recoil multipliers (armlab-tunable): gun-local rear,
      // gun-local back-slide, body-spring impulse
      kickRot: 1, kickZ: 1, kickBody: 1,
    };
    if (cls === 'hook') {
      // the grapple hook / Q-cannon left-hand hold (grip + gripRot only)
      r.grip = kind === 'cannon' ? [0, -0.05, 0.05] : [0, -0.05, 0.06];
      r.gripRot = [0, 0, 0];
    }
    if (cls === 'pistol' || cls === 'revolver') {
      r.grip = [0.012, -0.045, L * 0.24];
      r.gripRot = [-0.35, 0.05, 0.2];      // raked pistol-grip wrist
      // support hand cups the grip from the LEFT-below at a cant — both
      // fists on the same spot read as interpenetrating mitts
      r.fore = [-0.045, -0.068, L * 0.16];
      r.foreRot = [0.25, 0.45, 0.55];
      r.mag = [0, -0.08, L * 0.22];        // mag lives IN the grip
      r.bolt = [0, 0.03, L * 0.05];        // slide top
    }
    if (cls === 'sniper') {
      r.grip = [0, -0.06, L * 0.20];       // pistol-grip stock behind the mag
      r.gripRot = [-0.2, 0, 0.1];
      r.fore = [0, -0.045, -L * 0.22];
    }
    if (cls === 'minigun') { r.fore = [0, 0.0, -L * 0.18]; r.mag = [0, -0.12, L * 0.12]; }
    if (cls === 'flamer') { r.mag = [0, 0.11, L * 0.16]; }   // tank valve on top
    if (cls === 'launcher') { r.mag = [0, -0.02, -L * 0.30]; }  // breech at front
    // overrides go LAST or class branches clobber them (minigun fore bug)
    if (BAKED[kind]) Object.assign(r, BAKED[kind]);       // shipped hand-tune
    if (RIG_OVR[kind]) Object.assign(r, RIG_OVR[kind]);   // armlab overrides
    RIG[kind] = r;
    return r;
  }

  /* ---------------- timelines ----------------
   * key: { t, gun:[x,y,z,rx,ry,rz], lh:[socket,x,y,z], rh:[socket,x,y,z],
   *        mag:'on'|'hand'|'off', ev:'name' }
   * sockets: grip/fore/mag/bolt/port (weapon-local) or 'cam' (camera-local).
   * Channels hold; positions ease (smoothstep) between keys. Events fire
   * once when playback crosses their key time. */
  const TL = {
    /* beats, not poses: the tilt SPIKES around each hand action and relaxes
       between them (a held 45° rotation read as "stiff and bad"); events add
       spring jolts + the whole timeline gets low-amp wobble in update() */
    reload_rifle: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.08, gun: [0.01, -0.01, 0.01, 0.05, 0.05, -0.16], lh: ['mag', 0, -0.03, 0.02] },
      { t: 0.16, gun: [0.015, -0.012, 0.012, 0.07, 0.07, -0.24], lh: ['mag', 0, -0.005, 0] },
      { t: 0.22, lh: ['mag', 0.01, -0.07, 0.03], ev: 'magout', mag: 'hand' },
      { t: 0.34, gun: [0.01, -0.005, 0.005, 0.03, 0.03, -0.10], lh: ['mag', 0.05, -0.30, 0.15], ev: 'drop', mag: 'off' },
      { t: 0.46, gun: [0.008, -0.01, 0.008, 0.05, 0.05, -0.20], lh: ['mag', 0.02, -0.22, 0.10], mag: 'hand' },
      { t: 0.58, lh: ['mag', 0, -0.045, 0.01] },
      { t: 0.64, gun: [0.012, 0.01, 0.012, 0.02, 0.04, -0.16], lh: ['mag', 0, 0.005, 0], ev: 'magin', mag: 'on' },
      { t: 0.72, gun: [0.008, 0, 0.01, 0.03, -0.02, -0.06], lh: ['bolt', 0, 0.01, -0.02] },
      { t: 0.80, gun: [0.008, 0, 0.03, 0.09, -0.02, -0.04], lh: ['bolt', 0, 0.005, 0.10], ev: 'rack' },
      { t: 0.88, lh: ['fore', 0, 0, -0.02] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0] },
    ],
    reload_pistol: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.10, gun: [0.012, -0.01, 0.008, 0.09, 0.09, -0.20], lh: ['mag', 0, -0.04, 0.02] },
      { t: 0.18, gun: [0.015, -0.012, 0.01, 0.12, 0.11, -0.26], lh: ['mag', 0, -0.01, 0.01] },
      { t: 0.24, lh: ['mag', 0, -0.08, 0.03], ev: 'magout', mag: 'hand' },
      { t: 0.36, gun: [0.01, -0.005, 0.005, 0.06, 0.05, -0.10], lh: ['mag', 0.02, -0.28, 0.12], ev: 'drop', mag: 'off' },
      { t: 0.50, gun: [0.012, -0.01, 0.008, 0.09, 0.08, -0.20], lh: ['mag', 0.01, -0.20, 0.08], mag: 'hand' },
      { t: 0.62, lh: ['mag', 0, -0.05, 0.02] },
      { t: 0.68, gun: [0.01, 0.012, 0.008, 0.05, 0.05, -0.14], lh: ['mag', 0, 0.005, 0], ev: 'magin', mag: 'on' },
      { t: 0.78, gun: [0.008, 0, 0.008, 0.04, 0.02, -0.05], lh: ['bolt', 0, 0.015, -0.03] },
      { t: 0.86, gun: [0.008, 0, 0.025, 0.11, 0, -0.03], lh: ['bolt', 0, 0.015, 0.08], ev: 'rack' },
      { t: 0.94, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    reload_shotgun: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.10, gun: [0.01, -0.015, 0.01, 0.10, 0.06, -0.24], lh: ['port', 0, -0.18, 0.08], mag: 'hand' },
      { t: 0.22, lh: ['port', 0, -0.02, 0.01] },
      { t: 0.28, lh: ['port', 0, 0.005, 0], ev: 'shell' },
      { t: 0.38, gun: [0.008, -0.008, 0.006, 0.06, 0.04, -0.14], lh: ['port', 0, -0.16, 0.06] },
      { t: 0.50, gun: [0.01, -0.012, 0.008, 0.09, 0.05, -0.22], lh: ['port', 0, -0.02, 0.01] },
      { t: 0.56, lh: ['port', 0, 0.005, 0], ev: 'shell' },
      { t: 0.66, gun: [0.008, -0.008, 0.005, 0.05, 0.03, -0.10], lh: ['fore', 0, -0.01, 0.02], mag: 'off' },
      { t: 0.76, lh: ['fore', 0, 0, 0.11] },
      { t: 0.82, gun: [0.008, 0, 0.02, 0.08, 0.02, -0.06], lh: ['fore', 0, 0, -0.02], ev: 'rack' },
      { t: 0.90, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    reload_sniper: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.07, gun: [0.01, -0.01, 0.01, 0.06, 0.06, -0.20], lh: ['mag', 0, -0.03, 0.02] },
      { t: 0.14, lh: ['mag', 0, -0.005, 0] },
      { t: 0.20, lh: ['mag', 0.01, -0.07, 0.03], ev: 'magout', mag: 'hand' },
      { t: 0.30, gun: [0.008, -0.005, 0.005, 0.03, 0.03, -0.08], lh: ['mag', 0.04, -0.28, 0.14], ev: 'drop', mag: 'off' },
      { t: 0.42, gun: [0.008, -0.01, 0.008, 0.05, 0.05, -0.18], lh: ['mag', 0.02, -0.20, 0.10], mag: 'hand' },
      { t: 0.54, lh: ['mag', 0, -0.045, 0.01] },
      { t: 0.60, gun: [0.012, 0.008, 0.012, 0.02, 0.04, -0.14], lh: ['mag', 0, 0.005, 0], ev: 'magin', mag: 'on' },
      { t: 0.68, gun: [0.008, 0, 0.008, 0.03, -0.01, -0.05], lh: ['bolt', 0, 0.03, -0.02] },
      { t: 0.76, lh: ['bolt', 0, 0.05, 0.02] },
      { t: 0.83, gun: [0.01, 0.005, 0.03, 0.08, -0.01, -0.06], lh: ['bolt', 0, 0.045, 0.12], ev: 'rack' },
      { t: 0.90, lh: ['bolt', 0, 0.02, -0.01] },
      { t: 0.96, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    reload_revolver: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on', cyl: 0 },
      { t: 0.12, gun: [0.02, -0.01, 0.02, 0.20, 0.14, -0.40], lh: ['mag', 0.02, -0.02, 0], cyl: 0 },
      { t: 0.22, gun: [0.02, -0.01, 0.02, 0.22, 0.16, -0.44], cyl: 1, ev: 'magout' },
      { t: 0.34, gun: [0.03, 0.02, 0.03, 0.55, 0.18, -0.50], lh: ['mag', 0.03, -0.05, 0.03], ev: 'drop', cyl: 1 },
      { t: 0.48, gun: [0.02, -0.01, 0.02, 0.20, 0.14, -0.42], lh: ['mag', 0.02, -0.20, 0.10], mag: 'hand', cyl: 1 },
      { t: 0.62, lh: ['mag', 0.02, -0.02, 0.02], cyl: 1 },
      { t: 0.70, lh: ['mag', 0.02, -0.01, 0], ev: 'magin', mag: 'off', cyl: 1 },
      { t: 0.80, gun: [0.01, 0, 0.01, 0.10, 0.06, -0.16], lh: ['fore', 0, 0, 0], cyl: 0, ev: 'rack' },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0], cyl: 0 },
    ],
    reload_launcher: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.12, gun: [0.015, -0.02, 0.01, 0.22, 0.08, -0.16], lh: ['mag', 0, -0.20, 0.10], mag: 'hand' },
      { t: 0.28, lh: ['mag', 0, -0.03, 0.02] },
      { t: 0.40, lh: ['mag', 0, 0, -0.02], ev: 'magin' },
      { t: 0.50, lh: ['mag', 0, -0.02, -0.05], mag: 'off', ev: 'shell' },
      { t: 0.64, gun: [0.008, -0.008, 0.005, 0.08, 0.03, -0.06], lh: ['fore', 0, 0, 0.02] },
      { t: 0.78, gun: [0.008, 0, 0.015, 0.05, 0, -0.03], ev: 'rack', lh: ['fore', 0, 0, -0.01] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0] },
    ],
    reload_minigun: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.08, gun: [0.012, -0.015, 0.01, 0.08, 0.05, -0.18], lh: ['mag', 0, -0.04, 0.02] },
      { t: 0.18, lh: ['mag', 0, -0.005, 0] },
      { t: 0.24, lh: ['mag', 0.01, -0.08, 0.03], ev: 'magout', mag: 'hand' },
      { t: 0.38, gun: [0.008, -0.008, 0.005, 0.04, 0.02, -0.08], lh: ['mag', 0.05, -0.32, 0.15], ev: 'drop', mag: 'off' },
      { t: 0.52, gun: [0.01, -0.012, 0.008, 0.06, 0.04, -0.16], lh: ['mag', 0.02, -0.24, 0.11], mag: 'hand' },
      { t: 0.68, lh: ['mag', 0, -0.05, 0.01] },
      { t: 0.76, gun: [0.015, 0.01, 0.012, 0.03, 0.03, -0.14], lh: ['mag', 0, 0.005, 0], ev: 'magin', mag: 'on' },
      { t: 0.86, gun: [0.008, 0, 0.01, 0.02, -0.01, -0.05], lh: ['mag', 0, 0.04, -0.02], ev: 'rack' },
      { t: 0.94, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    reload_flamer: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.12, gun: [0.01, -0.012, 0.008, 0.06, 0.05, -0.18], lh: ['mag', 0, -0.04, 0.03] },
      { t: 0.24, lh: ['mag', 0, 0.01, 0] },
      { t: 0.31, lh: ['mag', 0.02, 0.03, 0.02], ev: 'magout' },
      { t: 0.42, lh: ['mag', -0.01, 0, 0.01] },
      { t: 0.52, lh: ['mag', 0.02, 0.03, 0.02], ev: 'rack' },
      { t: 0.64, lh: ['mag', 0, 0.01, 0] },
      { t: 0.72, gun: [0.008, 0, 0.008, 0.03, 0.03, -0.10], lh: ['mag', 0, -0.02, 0.04], ev: 'magin' },
      { t: 0.86, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    reload_cell: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.10, gun: [0.012, -0.01, 0.01, 0.07, 0.07, -0.22], lh: ['mag', 0, -0.03, 0.01] },
      { t: 0.18, lh: ['mag', 0, -0.005, 0] },
      { t: 0.24, lh: ['mag', 0.01, -0.07, 0.03], ev: 'magout', mag: 'hand' },
      { t: 0.38, gun: [0.008, -0.005, 0.005, 0.04, 0.04, -0.10], lh: ['mag', 0.03, -0.28, 0.12], ev: 'drop', mag: 'off' },
      { t: 0.52, gun: [0.01, -0.01, 0.008, 0.06, 0.06, -0.18], lh: ['mag', 0.01, -0.20, 0.08], mag: 'hand' },
      { t: 0.66, lh: ['mag', 0, -0.045, 0.005] },
      { t: 0.74, gun: [0.012, 0.008, 0.01, 0.03, 0.04, -0.15], lh: ['mag', 0, 0.005, 0], ev: 'magin', mag: 'on' },
      { t: 0.86, gun: [0.008, 0, 0.012, 0.03, -0.01, -0.05], lh: ['fore', 0, 0, 0], ev: 'rack' },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    /* mythic signature reloads — full arm choreography, not just gun spins.
       'toss' (BLOOD MOON): mag ripped out, gun FLIPPED into the air, caught
       right onto the fresh mag. 'spin': quick swap, then a barrel twirl. */
    reload_toss: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.08, gun: [0.01, -0.01, 0.005, 0.05, 0.04, -0.14], lh: ['mag', 0, -0.03, 0.02] },
      { t: 0.16, lh: ['mag', 0, -0.005, 0] },
      { t: 0.21, lh: ['mag', 0.01, -0.07, 0.03], ev: 'magout', mag: 'hand' },
      { t: 0.32, lh: ['mag', 0.05, -0.30, 0.15], ev: 'drop', mag: 'off' },
      { t: 0.40, gun: [0, -0.03, 0.01, 0.10, 0, 0], rh: ['grip', 0, 0, 0] },
      { t: 0.44, gun: [0, 0.02, 0, -0.6, 0, 0], rh: ['cam', 0.30, -0.34, -0.46] },
      { t: 0.58, gun: [0, 0.30, -0.04, -3.4, 0, 0.1] },
      { t: 0.70, gun: [0, 0.03, 0, -6.0, 0, 0], lh: ['cam', -0.02, -0.30, -0.44], mag: 'hand' },
      { t: 0.76, gun: [0, 0, 0, -6.283, 0, 0], rh: ['grip', 0, 0, 0], lh: ['mag', 0, 0.005, 0], ev: 'magin', mag: 'on' },
      { t: 0.85, gun: [0.008, 0, 0.02, -6.24, 0, -0.03], lh: ['bolt', 0, 0.01, 0.08], ev: 'rack' },
      { t: 0.93, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, -6.283, 0, 0] },
    ],
    reload_spin: [
      { t: 0.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0], mag: 'on' },
      { t: 0.07, gun: [0.01, -0.01, 0.008, 0.05, 0.05, -0.18], lh: ['mag', 0, -0.03, 0.02] },
      { t: 0.14, lh: ['mag', 0, -0.005, 0] },
      { t: 0.19, lh: ['mag', 0.01, -0.07, 0.03], ev: 'magout', mag: 'hand' },
      { t: 0.29, lh: ['mag', 0.05, -0.30, 0.14], ev: 'drop', mag: 'off' },
      { t: 0.40, gun: [0.008, -0.01, 0.008, 0.05, 0.05, -0.16], lh: ['mag', 0.02, -0.22, 0.10], mag: 'hand' },
      { t: 0.50, lh: ['mag', 0, -0.045, 0.01] },
      { t: 0.56, gun: [0.012, 0.01, 0.01, 0.02, 0.03, -0.12], lh: ['mag', 0, 0.005, 0], ev: 'magin', mag: 'on' },
      { t: 0.64, gun: [0.005, 0, 0.005, 0, 0, -0.4], rh: ['cam', 0.30, -0.32, -0.48], lh: ['cam', -0.06, -0.34, -0.40] },
      { t: 0.78, gun: [0, 0.01, 0, 0, 0, -4.4] },
      { t: 0.88, gun: [0, 0, 0, 0, 0, -6.283], rh: ['grip', 0, 0, 0], ev: 'rack' },
      { t: 0.95, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, -6.283] },
    ],
    /* draw: gun starts LOW + rotated (coming off the back), raise, then a
       class-flavored ready gesture. u runs over DRAW_DUR real seconds. */
    /* the left hand RIDES the gun up (on its foregrip) — starting it at a
       far-left 'cam' pose made it sweep across the whole screen */
    draw_rifle: [
      { t: 0.00, gun: [0.06, -0.30, 0.10, 0.9, -0.25, 0.20], lh: ['fore', 0, -0.02, 0.02] },
      { t: 0.42, gun: [0.01, -0.02, 0.02, 0.10, -0.02, 0.02], lh: ['fore', 0, -0.01, 0.01] },
      { t: 0.55, gun: [0, 0, 0, 0, 0, 0], lh: ['bolt', 0, 0.01, -0.01] },
      { t: 0.70, gun: [0.01, 0, 0.02, 0.08, -0.02, 0.06], lh: ['bolt', 0, 0.005, 0.09], ev: 'rack' },
      { t: 0.85, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    /* pistol: whipped up from the HIP with a wrist-roll overshoot — the old
       raise-and-rack was the rifle draw sped up, which read as weird at
       pistol tempo. The support hand RIDES the support socket the whole way
       up with the gun — the free 'cam' start pose materialised mid-screen
       (damp state carry-over from the holster made it drift in from
       nowhere). */
    draw_pistol: [
      { t: 0.00, gun: [0.05, -0.34, 0.06, 1.25, 0.15, 0.55], lh: ['fore', 0, -0.04, 0.02] },
      { t: 0.34, gun: [0.015, -0.07, 0.02, 0.32, 0.05, 0.24], lh: ['fore', 0, -0.02, 0.01] },
      { t: 0.52, gun: [0, 0.02, -0.004, -0.12, 0, -0.10], ev: 'rack' },
      { t: 0.68, gun: [0, -0.006, 0, 0.04, 0, 0.03], lh: ['fore', 0, -0.01, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0], lh: ['fore', 0, 0, 0] },
    ],
    draw_shotgun: [
      { t: 0.00, gun: [0.06, -0.30, 0.10, 0.9, -0.3, 0.25], lh: ['fore', 0, -0.02, 0.02] },
      { t: 0.42, gun: [0.01, -0.02, 0.02, 0.10, -0.03, 0.03], lh: ['fore', 0, -0.02, 0.02] },
      { t: 0.58, gun: [0.01, -0.01, 0.02, 0.14, -0.02, 0.04], lh: ['fore', 0, -0.01, 0.10], ev: 'rack' },
      { t: 0.75, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
    draw_revolver: [
      { t: 0.00, gun: [0.05, -0.26, 0.08, 0.8, 0.25, -0.2], lh: ['fore', 0, -0.02, 0.02] },
      { t: 0.45, gun: [0.01, -0.01, 0.01, 0.08, 0.03, -0.30] },
      { t: 0.62, gun: [0.01, 0.01, 0.01, 0.02, 0, 0.35], ev: 'rack' },
      { t: 0.80, lh: ['fore', 0, 0, 0] },
      { t: 1.00, gun: [0, 0, 0, 0, 0, 0] },
    ],
  };
  TL.draw_sniper = TL.draw_rifle;
  TL.draw_launcher = TL.draw_shotgun;
  TL.draw_minigun = TL.draw_rifle;
  TL.draw_flamer = TL.draw_shotgun;
  TL.draw_cell = TL.draw_rifle;
  TL.draw_hook = TL.draw_pistol;
  const DRAW_DUR = {
    pistol: 0.40, rifle: 0.52, shotgun: 0.55, sniper: 0.62, revolver: 0.48,
    launcher: 0.52, minigun: 0.68, flamer: 0.55, cell: 0.48, hook: 0.40,
  };

  /* ---------------- rig state ---------------- */
  const rig = {
    group: null,          // camera child holding everything
    inst: null,           // charInstance clone (bones live here, meshes hidden)
    key: null,            // cosmetics cache key
    arms: { R: null, L: null },   // per-side {anchor, sh, up, lo, fi, bind*}
    hand: { R: null, L: null },   // damped world targets {pos, quat, has}
    fail: false,
  };
  const anim = {
    draw: null,           // {t, dur, cls}
    lastU: -1,            // reload event edge detector
    lastDrawU: -1,
    magState: 'on',
    handMag: null,        // prop riding the left fist
    magNode: null,        // the gun's own magazine node (or proc prop)
    magProcKind: null,
    reloading: false,
    jrx: 0, jz: 0, jrz: 0,   // event jolt springs (decay in update)
    wt: 0, seed: 0,          // clock + per-reload variance
    po1: 0, po3: 0, po4: 0, po5: 0,   // prev gun-channel (sway excitation)
  };
  const drops = [];       // falling dropped mags in the world

  /* scratch */
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const vD = new THREE.Vector3(), vS = new THREE.Vector3(), vE = new THREE.Vector3();
  const vW = new THREE.Vector3(), vT = new THREE.Vector3(), vH = new THREE.Vector3();
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
  const qD = new THREE.Quaternion(), eA = new THREE.Euler(0, 0, 0, 'YXZ');
  const mA = new THREE.Matrix4();

  function init(sc, cam) { scene = sc; camera = cam; }

  /* ---------------- arm extraction ---------------- */
  function cosmeticsKey() {
    const P = SKY.Profile && SKY.Profile.data;
    if (!P) return 'x';
    return (P.char || '') + '|' + (P.skin === undefined ? '' : P.skin) + '|' + (P.outfit || '');
  }

  function vmParent() {
    return (SKY.Effects && SKY.Effects.vmRoot && SKY.Effects.vmRoot()) || camera;
  }
  function disposeRig() {
    if (rig.group) {
      if (rig.group.parent) rig.group.parent.remove(rig.group);
      rig.group.traverse((o) => { if (o.isMesh && o.geometry && o.userData.armGeo) o.geometry.dispose(); });
    }
    rig.group = null; rig.inst = null; rig.arms.R = rig.arms.L = null;
    rig.hand.R = rig.hand.L = null;
  }

  function buildRig() {
    const P = SKY.Profile ? SKY.Profile.data : {};
    const inst = SKY.GFX.charInstance(0, P.char);
    if (!inst) return false;

    const group = new THREE.Group();
    // normalize by character height (raw GLB units vary), then CFG.scale
    // sizes the arms relative to a ~1.9u body for viewmodel distances
    rig.norm = 1.9 / Math.max(0.01, inst.height || 1.9);
    group.scale.setScalar(CFG.scale * rig.norm);
    vmParent().add(group);      // under the vm root: shared sway/kick/hide
    group.add(inst.root);

    // recolor skin + outfit exactly like the third-person avatar
    const col = new THREE.Color(P.outfit || '#d8dee9').convertSRGBToLinear();
    const skinCol = new THREE.Color(
      SKY.Characters.SKINS[(P.skin || 0) % SKY.Characters.SKINS.length]).convertSRGBToLinear();
    inst.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        // DoubleSide: the arm cut edges are open — single-sided you could
        // SEE INSIDE the hollow arms at some angles
        m.side = THREE.DoubleSide;
        if (m.name === inst.tint) {
          m.color.copy(col).multiplyScalar(0.92);
          m.emissive = col.clone().multiplyScalar(0.1);
        } else if (m.name === 'Skin') m.color.copy(skinCol);
      }
    });

    // hide the full-body meshes; extracted arm meshes render instead
    const skinned = [];
    inst.root.traverse((o) => { if (o.isSkinnedMesh) { skinned.push(o); o.visible = false; } });
    if (!skinned.length) { group.parent.remove(group); return false; }

    const armRe = /Shoulder|UpperArm|LowerArm|Fist/;
    let extracted = 0;
    for (const sm of skinned) {
      const geo = sm.geometry;
      const idx = geo.index, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
      if (!idx || !si || !sw) continue;
      const bones = sm.skeleton.bones;
      const keep = bones.map((b) => armRe.test(b.name));
      // copy skin attrs into flat arrays (r147: interleaved GLTF attributes
      // have no getComponent — go through getX/getY/getZ/getW)
      const comp = (att, v, k) => k === 0 ? att.getX(v) : k === 1 ? att.getY(v)
        : k === 2 ? att.getZ(v) : att.getW(v);
      const nv = si.count;
      const siArr = new Uint16Array(nv * 4);
      const swArr = new Float32Array(nv * 4);
      const dom = new Uint8Array(nv);
      for (let v = 0; v < nv; v++) {
        let bw = -1, bj = 0;
        for (let k = 0; k < 4; k++) {
          const j = comp(si, v, k), w = comp(sw, v, k);
          siArr[v * 4 + k] = j; swArr[v * 4 + k] = w;
          if (w > bw) { bw = w; bj = j; }
        }
        dom[v] = keep[bj] ? 1 : 0;
      }
      const newIdx = [];
      for (let i = 0; i < idx.count; i += 3) {
        const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
        if (dom[a] && dom[b] && dom[c]) newIdx.push(a, b, c);
      }
      if (!newIdx.length) continue;
      // strip weights to non-arm joints so torso bind-pose bones can't drag
      // the cut edge (verts near the cut carry secondary torso weights)
      for (let v = 0; v < nv; v++) {
        if (!dom[v]) continue;
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          if (!keep[siArr[v * 4 + k]]) swArr[v * 4 + k] = 0;
          sum += swArr[v * 4 + k];
        }
        if (sum > 1e-4) for (let k = 0; k < 4; k++) swArr[v * 4 + k] /= sum;
      }
      const si2 = new THREE.BufferAttribute(siArr, 4);
      const sw2 = new THREE.BufferAttribute(swArr, 4);
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', geo.attributes.position);
      if (geo.attributes.normal) g2.setAttribute('normal', geo.attributes.normal);
      if (geo.attributes.uv) g2.setAttribute('uv', geo.attributes.uv);
      g2.setAttribute('skinIndex', si2);
      g2.setAttribute('skinWeight', sw2);
      g2.setIndex(newIdx);
      const mesh = new THREE.SkinnedMesh(g2, sm.material);
      mesh.userData.armGeo = true;
      mesh.frustumCulled = false;    // skinned bounds are wrong post-filter
      mesh.bind(sm.skeleton, sm.bindMatrix);
      group.add(mesh);
      extracted++;
    }
    if (!extracted) { group.parent.remove(group); return false; }

    // bone lookup (GLTFLoader may strip the '.' from names)
    const bone = (n) => inst.root.getObjectByName(n) || inst.root.getObjectByName(n.replace(/\./g, ''));
    for (const side of ['R', 'L']) {
      const sh = bone('Shoulder.' + side), up = bone('UpperArm.' + side);
      const lo = bone('LowerArm.' + side), fi = bone('Fist.' + side);
      if (!sh || !up || !lo || !fi) { group.parent.remove(group); return false; }
      // re-anchor the whole arm chain at a camera-space shoulder point;
      // skinning follows bone WORLD matrices, so reparenting is safe
      const anchor = new THREE.Object3D();
      anchor.position.fromArray(side === 'R' ? CFG.shoulderR : CFG.shoulderL);
      group.add(anchor);
      anchor.add(sh);
      sh.position.set(0, 0, 0);
      // stretch the chain: longer bone offsets = longer arms; the skinned
      // mesh stretches between joints without getting thicker
      lo.position.multiplyScalar(CFG.lenMul);
      fi.position.multiplyScalar(CFG.lenMul);
      // sleeve continuation: a tinted tube riding the upper-arm bone,
      // extending shoulder-ward past the cut so the arm never visibly ENDS
      // on screen no matter the pose
      let tintMat = null, skinMat = null;
      inst.root.traverse((o) => {
        if (!o.isMesh || !o.material || tintMat) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.name === inst.tint) tintMat = m;
          else if (m.name === 'Skin' && !skinMat) skinMat = m;
        }
      });
      const upLen = lo.position.length();
      const upDir = lo.position.clone().normalize();
      const tubeR = (inst.height || 1.9) * 0.052;
      // 1.3×upLen: long enough that the sleeve exits the frame even at high
      // FOV (with the FOV-scaled shoulders below), short enough to stay off
      // the near plane (1.5 reached the camera and got sliced open)
      const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(tubeR, tubeR * 0.9, upLen * 1.3, 8),
        tintMat || skinMat || new THREE.MeshLambertMaterial({ color: 0x666e7c }));
      tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upDir);
      tube.position.copy(upDir).multiplyScalar(-upLen * 0.38);
      tube.layers.set(VM_LAYER);
      up.add(tube);
      rig.arms[side] = {
        anchor, sh, up, lo, fi,
        baseLo: lo.position.clone(), baseFi: fi.position.clone(),
        bindSh: sh.quaternion.clone(), bindUp: up.quaternion.clone(),
        bindLo: lo.quaternion.clone(), bindFi: fi.quaternion.clone(),
      };
      rig.hand[side] = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), has: false };
    }
    group.traverse((o) => { o.layers.set(VM_LAYER); if (o.isMesh) o.castShadow = false; });
    rig.group = group;
    rig.inst = inst;
    rig.key = cosmeticsKey();
    return true;
  }

  function ensureRig() {
    if (rig.fail) return false;
    if (rig.group && rig.key === cosmeticsKey()) return true;
    disposeRig();
    if (!SKY.GFX || !SKY.GFX.charReady || !SKY.GFX.charReady()) return false;
    try {
      return buildRig();
    } catch (e) {
      // never let a bad extraction kill the render loop — fall back to
      // the classic floating-gun viewmodel
      console.warn('Arms rig failed', e);
      rig.failMsg = (e && (e.stack || e.message)) || String(e);
      disposeRig();
      rig.fail = true;
      return false;
    }
  }

  function refresh() { rig.key = null; rig.fail = false; }   // cosmetics changed

  /* re-apply CFG scale/shoulder anchors to a LIVE rig (tuning harness) */
  function applyCfg() {
    if (!rig.group) return;
    rig.group.scale.setScalar(CFG.scale * (rig.norm || 1));
    if (rig.arms.R) rig.arms.R.anchor.position.fromArray(CFG.shoulderR);
    if (rig.arms.L) rig.arms.L.anchor.position.fromArray(CFG.shoulderL);
  }

  /* ---------------- procedural props (mags / shells / cells) ---------- */
  function propMat(color) {
    return new THREE.MeshLambertMaterial({ color: new THREE.Color(color).convertSRGBToLinear() });
  }
  function buildMagProp(cls) {
    const g = new THREE.Group();
    let m;
    if (cls === 'shotgun') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 8), propMat('#c93a2e'));
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.012, 8), propMat('#d9a441'));
      cap.position.y = -0.028;
      g.add(m, cap);
    } else if (cls === 'cell') {
      m = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.07, 0.035), propMat('#233042'));
      const core = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.028, 0.038),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('#57d8ff').convertSRGBToLinear() }));
      g.add(m, core);
    } else if (cls === 'revolver') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 10), propMat('#d9a441'));
      g.add(m);
    } else if (cls === 'launcher') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.09, 10), propMat('#3a4c63'));
      m.rotation.x = Math.PI / 2;
      const tipm = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.035, 10), propMat('#c93a2e'));
      tipm.rotation.x = -Math.PI / 2; tipm.position.z = -0.06;
      g.add(m, tipm);
    } else {
      // generic boxy magazine (pistol & friends)
      m = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.085, 0.045), propMat('#2c3547'));
      m.rotation.x = 0.12;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.052), propMat('#1c2331'));
      base.position.y = -0.045;
      g.add(m, base);
    }
    return g;
  }

  /* find the gun's own detachable magazine (Blaster-Kit `magazine` node) or
     mount a procedural one at the rig's mag socket */
  const magBox = new THREE.Box3();
  function attachMagRefs(vm, r) {
    anim.magNode = null; anim.magProcKind = null; anim.magSocket = null;
    if (!vm.group) return;
    if (r.cls === 'flamer' || r.cls === 'hook') return;   // tank crank / no mag
    const node = vm.group.getObjectByName('magazine') || vm.group.getObjectByName('ammobox');
    if (node) {
      anim.magNode = node;
      // the REAL mag well: the magazine node's center in weapon-local space
      // beats any guessed socket
      vm.group.updateWorldMatrix(true, true);
      magBox.setFromObject(node);
      if (!magBox.isEmpty()) {
        magBox.getCenter(vA);
        anim.magSocket = vm.group.worldToLocal(vA).toArray();
      }
      return;
    }
    if (r.cls === 'revolver') { anim.magNode = vm.group.getObjectByName('cyl'); anim.magProcKind = 'revolver'; return; }
    anim.magProcKind = r.cls;
  }

  function handMagFor(vm, r) {
    if (anim.handMag) return anim.handMag;
    const fi = rig.arms.L && rig.arms.L.fi;
    if (!fi) return null;
    vvScaleOf(fi, vB);                       // fist world scale (rig+armature)
    const fs = Math.max(1e-4, vB.x);
    let prop = null;
    if (anim.magNode && !anim.magProcKind) {
      prop = anim.magNode.clone(true);
      prop.position.set(0, 0, 0); prop.rotation.set(0, 0, 0);
      // keep the clone at the SAME world size it has on the gun: local
      // scale = mag world scale / fist world scale
      vvScaleOf(anim.magNode, vA);
      prop.scale.copy(vA).multiplyScalar(1 / fs);
    } else {
      prop = buildMagProp(anim.magProcKind || r.cls);
      prop.scale.setScalar(1 / fs);
    }
    prop.traverse((o) => o.layers.set(VM_LAYER));
    // magGrip is authored in WORLD units — convert into fist-bone space
    prop.position.fromArray(CFG.magGrip).multiplyScalar(1 / fs);
    fi.add(prop);
    anim.handMag = prop;
    return prop;
  }
  function vvScaleOf(node, out) {
    node.updateWorldMatrix(true, false);
    mA.copy(node.matrixWorld);
    out.setFromMatrixScale(mA);
  }
  function killHandMag() {
    if (anim.handMag && anim.handMag.parent) anim.handMag.parent.remove(anim.handMag);
    anim.handMag = null;
  }

  /* dropped mag: falls away with gravity, fades fast. World-space, layer 0. */
  function dropMag(vm, r) {
    if (!scene) return;
    let src = anim.handMag;
    if (!src && anim.magNode && !anim.magProcKind) src = anim.magNode;
    const prop = src ? src.clone(true) : buildMagProp(anim.magProcKind || r.cls);
    prop.traverse((o) => o.layers.set(0));
    // spawn where the left fist is
    const fi = rig.arms.L && rig.arms.L.fi;
    if (fi) fi.getWorldPosition(vA); else camera.getWorldPosition(vA).add(vB.set(0.1, -0.4, -0.4));
    prop.position.copy(vA);
    camera.getWorldQuaternion(qA);
    prop.quaternion.copy(qA);
    vvScaleOf(src || prop, vB);
    prop.scale.copy(src ? vB : vB.setScalar(1));
    scene.add(prop);
    const vel = vC.set((Math.random() - 0.5) * 0.6, -0.8, -0.6).applyQuaternion(qA);
    drops.push({ obj: prop, vel: vel.clone(), spin: (Math.random() - 0.5) * 9, life: 1.1 });
  }
  function tickDrops(dt) {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.life -= dt;
      if (d.life <= 0) { scene.remove(d.obj); drops.splice(i, 1); continue; }
      d.vel.y -= 22 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.spin * dt;
    }
  }

  /* ---------------- timeline sampling ----------------
   * Catmull-Rom through the keys: per-segment smoothstep had ZERO velocity
   * at every key — the reload literally stopped 10+ times per cycle and
   * read as stutter. A spline flows through the keys in one continuous
   * motion with natural follow-through/overshoot. */
  function catmull(p0, p1, p2, p3, s) {
    const s2 = s * s, s3 = s2 * s;
    return 0.5 * ((2 * p1) + (-p0 + p2) * s +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
  }
  function chanKeys(keys, name) {
    const c = keys.__ck || (keys.__ck = {});
    if (!c[name]) {
      const list = [];
      for (const k of keys) if (k[name] !== undefined) list.push(k);
      c[name] = list;
    }
    return c[name];
  }
  const cv = (k, name, i) => { const v = k[name][i]; return v === undefined ? 0 : v; };
  function sampleChan(keys, u, name, out) {
    const ks = chanKeys(keys, name);
    if (!ks.length) return null;
    let i = -1;
    for (let j = 0; j < ks.length; j++) { if (ks[j].t <= u) i = j; else break; }
    if (i < 0) return copyArr(ks[0][name], out);
    if (i >= ks.length - 1) return copyArr(ks[ks.length - 1][name], out);
    const k1 = ks[i], k2 = ks[i + 1];
    const k0 = ks[Math.max(0, i - 1)], k3 = ks[Math.min(ks.length - 1, i + 2)];
    const s = (u - k1.t) / Math.max(1e-5, k2.t - k1.t);
    for (let c = 0; c < out.length; c++) {
      out[c] = catmull(cv(k0, name, c), cv(k1, name, c), cv(k2, name, c), cv(k3, name, c), s);
    }
    return out;
  }
  function copyArr(a, out) { for (let i = 0; i < out.length; i++) out[i] = a[i] !== undefined ? a[i] : 0; return out; }
  function sampleHand(keys, u, name) {
    // hand channels carry a socket id — spline within runs of the SAME
    // socket; a socket switch holds (the hand damp bridges the jump)
    const ks = chanKeys(keys, name);
    if (!ks.length) return null;
    let i = -1;
    for (let j = 0; j < ks.length; j++) { if (ks[j].t <= u) i = j; else break; }
    if (i < 0) return ks[0][name];
    if (i >= ks.length - 1) return ks[ks.length - 1][name];
    const k1 = ks[i], k2 = ks[i + 1];
    const a = k1[name], b = k2[name];
    if (a[0] !== b[0]) return a;
    const k0 = (i > 0 && ks[i - 1][name][0] === a[0]) ? ks[i - 1] : k1;
    const k3 = (i + 2 < ks.length && ks[i + 2][name][0] === a[0]) ? ks[i + 2] : k2;
    const s = (u - k1.t) / Math.max(1e-5, k2.t - k1.t);
    handSample[0] = a[0];
    for (let c = 1; c < 4; c++) {
      handSample[c] = catmull(k0[name][c] || 0, a[c] || 0, b[c] || 0, k3[name][c] || 0, s);
    }
    return handSample;
  }
  const handSample = ['grip', 0, 0, 0];
  function holdChan(keys, u, name, dflt) {
    let v = dflt;
    for (const k of keys) { if (k.t <= u && k[name] !== undefined) v = k[name]; }
    return v;
  }
  function fireEvents(keys, lastU, u, cb) {
    if (u < lastU) lastU = -1;   // timeline restarted
    for (const k of keys) if (k.ev && k.t > lastU && k.t <= u) cb(k.ev);
  }

  const gunOff = [0, 0, 0, 0, 0, 0];

  /* ---------------- IK ---------------- */
  function worldCorr(boneObj, qCorr) {
    // rotate a bone by a WORLD-space corrective: L' = P⁻¹·corr·P·L
    boneObj.parent.getWorldQuaternion(qB);
    qC.copy(qB).invert().multiply(qCorr).multiply(qB);
    boneObj.quaternion.premultiply(qC);
  }
  function solveArm(side, targetPos, targetQuat) {
    const A = rig.arms[side];
    if (!A) return;
    A.up.quaternion.copy(A.bindUp);
    A.lo.quaternion.copy(A.bindLo);
    A.fi.quaternion.copy(A.bindFi);
    A.lo.position.copy(A.baseLo);
    A.fi.position.copy(A.baseFi);
    A.anchor.updateWorldMatrix(true, true);
    A.up.getWorldPosition(vS);
    A.lo.getWorldPosition(vE);
    A.fi.getWorldPosition(vW);
    let L1 = vS.distanceTo(vE), L2 = vE.distanceTo(vW);
    vD.subVectors(targetPos, vS);
    let d = vD.length();
    // DYNAMIC REACH: a far socket (support hand under a long barrel) used to
    // clamp at full extension — the fist floated short of the gun, so armlab
    // placements on big rifles were physically impossible. Stretch the bone
    // chain just enough to reach (skinned mesh stretches between joints,
    // same trick as lenMul). s is continuous in d — no pop. Cap 2.3: the
    // baked mega foregrip is a cross-body left-hand reach needing ~2.1×.
    const s = Math.min(d / Math.max(1e-4, L1 + L2 - 0.004), 2.3);
    if (s > 1) {
      A.lo.position.multiplyScalar(s);
      A.fi.position.multiplyScalar(s);
      A.anchor.updateWorldMatrix(true, true);
      L1 *= s; L2 *= s;
    }
    d = Math.min(L1 + L2 - 0.004, Math.max(Math.abs(L1 - L2) + 0.01, d));
    if (vD.lengthSq() < 1e-8) vD.set(0, 0, -1); else vD.normalize();
    vT.copy(vS).addScaledVector(vD, d);
    // elbow via law of cosines + hint plane
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0.0001, L1 * L1 - a * a));
    camera.getWorldQuaternion(qA);
    vH.fromArray(side === 'R' ? CFG.elbowHintR : CFG.elbowHintL).applyQuaternion(qA);
    // the elbow FOLLOWS the hand: the forearm enters the wrist from the
    // fist's local -Y (bone axis), so a raked/rolled grip swings the whole
    // arm around instead of twisting the wrist against a fixed forearm
    // (hint-only elbows made rotated hands read as broken wrists)
    const ef = CFG.elbowFollow === undefined ? 0.65 : CFG.elbowFollow;
    if (ef > 0) {
      vC.set(0, -1, 0).applyQuaternion(targetQuat);
      vH.normalize().lerp(vC, ef);
      if (vH.lengthSq() < 1e-4) vH.copy(vC);
    }
    vH.addScaledVector(vD, -vH.dot(vD));
    if (vH.lengthSq() < 1e-6) vH.set(0, -1, 0).applyQuaternion(qA).addScaledVector(vD, -vD.dot(vH));
    vH.normalize();
    vE.copy(vS).addScaledVector(vD, a).addScaledVector(vH, h);
    // upper arm: aim the shoulder→elbow segment
    vA.subVectors(vE, vS).normalize();
    A.lo.getWorldPosition(vB).sub(vS).normalize();
    qD.setFromUnitVectors(vB, vA);
    worldCorr(A.up, qD);
    A.up.updateWorldMatrix(false, true);
    // forearm: aim elbow→wrist at the target
    A.lo.getWorldPosition(vB);
    A.fi.getWorldPosition(vC).sub(vB).normalize();
    vA.subVectors(vT, vB).normalize();
    qD.setFromUnitVectors(vC, vA);
    worldCorr(A.lo, qD);
    A.lo.updateWorldMatrix(false, true);
    // fist: absolute world orientation
    A.lo.getWorldQuaternion(qB);
    A.fi.quaternion.copy(qB.invert().multiply(targetQuat));
  }

  /* ---------------- per-frame ---------------- */
  const fistEulR = new THREE.Euler(0, 0, 0, 'YXZ');
  const tgtR = new THREE.Vector3(), tgtL = new THREE.Vector3();
  const quatR = new THREE.Quaternion(), quatL = new THREE.Quaternion();
  const qGunL = new THREE.Quaternion(), qRootW = new THREE.Quaternion();
  const wPos = new THREE.Vector3(), wQuat = new THREE.Quaternion();

  /* hand targets are tracked in the LOCAL SPACE of whatever the hand is
     holding (gun/hook/cannon, or the vm root for free 'cam' poses): any
     motion of that object — fire kick, contact jolts, wobble — transfers
     to the hand 1:1 and instantly, and camera turns can never induce lag.
     Damping only ever smooths timeline/socket transitions. */
  const mSpace = new THREE.Matrix4(), mOld = new THREE.Matrix4(), mInv = new THREE.Matrix4();
  const qSpace = new THREE.Quaternion(), qOld = new THREE.Quaternion();
  function spaceObj(vm, space) {
    return space === 'gun' ? vm.group : space === 'hook' ? vm.hook :
      space === 'cannon' ? vm.cannon : null;
  }
  function spaceMatrix(vm, space, out) {
    const o = spaceObj(vm, space);
    if (!o) return out.identity();
    o.updateMatrix();
    return out.copy(o.matrix);
  }
  function qSpaceOf(vm, space, out) {
    const o = spaceObj(vm, space);
    if (!o) return out.identity();
    return out.copy(o.quaternion);
  }
  function socketGun(r, s, out) {
    const base = (s[0] === 'mag' && anim.magSocket) ? anim.magSocket
      : (r[s[0]] || r.grip);
    return out.set(base[0] + s[1], base[1] + s[2], base[2] + s[3]);
  }

  /* spring jolts fired by timeline events — the "thud" that sells contact */
  const JOLTS = {
    magout: { rx: 0.09, z: 0.01, rz: -0.04 },
    magin: { rx: -0.15, z: 0.025, rz: 0.05 },
    rack: { rx: 0.11, z: 0.045, rz: 0.02 },
    shell: { rx: -0.07, z: 0.015, rz: 0.03 },
    drop: { rx: 0.03, z: 0, rz: -0.02 },
  };
  /* fire impulse -> body springs: the whole assembly (gun + arms) whips
     back/up and recovers on the spring wave. This is where heavy-gun IMPACT
     lives now that the gun-local kick is capped at the camera plane —
     velocity sells the punch, not sustained displacement. */
  function fireKick(f) {
    const s = f * (SWAY.fireFeed === undefined ? 1 : SWAY.fireFeed);
    swayState.rx.v += s * 0.9;
    swayState.pz.v += s * 0.4;
    swayState.py.v -= s * 0.16;
    swayState.rz.v += (Math.random() - 0.5) * s * 0.5;
  }
  function applyJolt(ev) {
    const j = JOLTS[ev];
    if (!j) return;
    const k = CFG.joltScale === undefined ? 1 : CFG.joltScale;
    anim.jrx += j.rx * k; anim.jz += j.z * k; anim.jrz += j.rz * k;
    // contacts also thump the whole assembly through the sway springs
    swayState.rx.v += j.rx * k * SWAY.joltFeed * 2.2;
    swayState.rz.v += j.rz * k * SWAY.joltFeed * 2.2;
    swayState.py.v -= Math.abs(j.rx) * k * SWAY.joltFeed * 0.5;
  }

  function startDraw(kind) {
    const cls = (CLS_OF[kind] || 'rifle');
    anim.draw = { t: 0, dur: DRAW_DUR[cls] || 0.5, cls };
    anim.lastDrawU = -1;
  }

  function playStage(ev) {
    const S = SKY.SFX;
    if (!S) return;
    if (ev === 'magout' && S.magOut) S.magOut();
    else if (ev === 'magin' && S.magIn) S.magIn();
    else if ((ev === 'rack' || ev === 'shell') && S.rack) S.rack();
  }

  function update(dt, vm, reloadFrac) {
    tickDrops(dt);
    if (!camera || !vm || !vm.group || !ensureRig()) return;
    rig.group.visible = !!vm.visible;
    if (!vm.visible) return;

    const kind = vm.kind;
    const r = rigOf(kind);
    // FOV compensation: at fov 90+ the frustum reaches further down and the
    // arm ends/cut showed at the bottom of the frame. The shoulders (and
    // the sleeve cut with them) ride lower and wider as fov grows — hands
    // are IK-glued to the gun sockets, so weapon placement is untouched.
    const fovK = Math.min(1.75,
      Math.tan((camera.fov || 75) * Math.PI / 360) / 0.7673);
    for (const side of ['R', 'L']) {
      const AS = rig.arms[side];
      if (!AS) continue;
      const c = side === 'R' ? CFG.shoulderR : CFG.shoulderL;
      AS.anchor.position.set(
        c[0] * (1 + (fovK - 1) * 0.35), c[1] * fovK, c[2]);
    }
    // re-resolve mag refs on weapon change AND on remounts of the same kind
    // (a locker skin equip rebuilds vm.group — old node refs go stale)
    if (anim.rigKind !== kind || anim.rigGroup !== vm.group) {
      anim.rigKind = kind; anim.rigGroup = vm.group;
      killHandMag(); attachMagRefs(vm, r); anim.magApplied = null;
    }

    /* -------- pick the active timeline -------- */
    let keys = null, u = 0, isReload = false;
    if (reloadFrac !== undefined && reloadFrac >= 0) {
      // mythic signature timelines (toss/spin) DISABLED — they'll be redone
      // from scratch once the default per-class sets are locked
      keys = TL['reload_' + r.cls] || TL.reload_rifle;
      u = Math.min(1, reloadFrac);
      isReload = true;
      anim.draw = null;
      if (anim.lastU === -1) {          // reload just started
        anim.seed = Math.random() * 20; // per-reload variance
        anim.wt = 0;
      }
    } else if (anim.draw) {
      anim.draw.t += dt;
      u = Math.min(1, anim.draw.t / anim.draw.dur);
      keys = TL['draw_' + anim.draw.cls] || TL.draw_rifle;
      if (u >= 1) anim.draw = null;
    }

    /* -------- reload bookkeeping (mag + events) -------- */
    if (isReload) {
      fireEvents(keys, anim.lastU, u, (ev) => {
        if (ev === 'drop') dropMag(vm, r);
        else playStage(ev);
        applyJolt(ev);
      });
      anim.lastU = u;
      const magWant = holdChan(keys, u, 'mag', 'on');
      if (magWant !== anim.magApplied) {
        anim.magApplied = magWant;
        if (anim.magNode && !anim.magProcKind) anim.magNode.visible = magWant === 'on';
        if (magWant === 'hand') handMagFor(vm, r);
        else killHandMag();
      }
      // revolver cylinder swing
      if (anim.magNode && r.cls === 'revolver') {
        anim.magNode.rotation.z = holdChan(keys, u, 'cyl', 0) * 0.85;
      }
    } else if (anim.lastU !== -1) {
      // reload ended or was cancelled — restore invariants
      anim.lastU = -1;
      anim.magApplied = null;
      if (anim.magNode) { anim.magNode.visible = true; if (r.cls === 'revolver') anim.magNode.rotation.z = 0; }
      killHandMag();
    } else if (anim.draw) {
      fireEvents(keys, anim.lastDrawU, u, (ev) => { playStage(ev); applyJolt(ev); });
      anim.lastDrawU = u;
    }

    /* -------- gun offset channel (mythic timelines own the gun too) ------ */
    if (keys) {
      sampleChan(keys, u, 'gun', gunOff);
      // pivot the choreography rotation about the PALM CONTACT (~6cm past
      // the wrist along the fist bone). Pivoting at the grip socket kept
      // the WRIST world-static (the fist bone origin IS the wrist), so the
      // forearm never swung with the gun and the receiver swept through it
      // — with the palm as the fixed point the wrist ORBITS it and the IK
      // arm follows every tilt
      eA.set(gunOff[3], gunOff[4], gunOff[5]);
      fistEulR.set(CFG.fistRotR[0], CFG.fistRotR[1], CFG.fistRotR[2]);
      qA.setFromEuler(fistEulR);
      if (r.gripRot) {
        qA.multiply(qB.setFromEuler(
          fistEulR.set(r.gripRot[0], r.gripRot[1], r.gripRot[2])));
      }
      vC.set(0, 0.06, 0).applyQuaternion(qA);   // wrist -> palm, bone axis
      vA.set(r.grip[0] + vC.x, r.grip[1] + vC.y, r.grip[2] + vC.z);
      vB.copy(vA).applyEuler(eA);
      vm.group.position.x += gunOff[0] + (vA.x - vB.x);
      vm.group.position.y += gunOff[1] + (vA.y - vB.y);
      vm.group.position.z += gunOff[2] + (vA.z - vB.z);
      vm.group.rotation.x += gunOff[3];
      vm.group.rotation.y += gunOff[4];
      vm.group.rotation.z += gunOff[5];
    }

    /* -------- contact jolts (gun-local thud + body-sway excitation) ------ */
    anim.jrx *= Math.exp(-11 * dt);
    anim.jz *= Math.exp(-11 * dt);
    anim.jrz *= Math.exp(-11 * dt);
    anim.wt += dt;
    const act = isReload ? 1 : (anim.draw ? 0.55 : 0);
    vm.group.rotation.x += anim.jrx * 0.5;
    vm.group.rotation.z += anim.jrz * 0.5;
    vm.group.position.z += anim.jz * 0.5;
    vm.group.position.y -= Math.abs(anim.jrx) * 0.03;
    /* the choreography itself excites the body springs — the assembly sways
       in reaction to every yank and slam instead of being bolted in place */
    if (keys) {
      swayState.rx.v += (gunOff[3] - anim.po3) * SWAY.animFeed;
      swayState.ry.v += (gunOff[4] - anim.po4) * SWAY.animFeed;
      swayState.rz.v += (gunOff[5] - anim.po5) * SWAY.animFeed;
      swayState.py.v += (gunOff[1] - anim.po1) * SWAY.animFeed * 0.6;
      anim.po1 = gunOff[1]; anim.po3 = gunOff[3]; anim.po4 = gunOff[4]; anim.po5 = gunOff[5];
    } else { anim.po1 = anim.po3 = anim.po4 = anim.po5 = 0; }

    /* -------- hand targets, each in its holder's space -------- */
    vm.group.updateMatrix();
    const rhKey = (keys ? sampleHand(keys, u, 'rh') : null) || ['grip', 0, 0, 0];
    const spaceR = rhKey[0] === 'cam' ? 'cam' : 'gun';
    if (spaceR === 'cam') tgtR.set(rhKey[1], rhKey[2], rhKey[3]);
    else socketGun(r, rhKey, tgtR);
    fistEulR.set(CFG.fistRotR[0], CFG.fistRotR[1], CFG.fistRotR[2]);
    quatR.setFromEuler(fistEulR);
    // per-class grip rake (a pistol grip is not a rifle grip)
    if (spaceR === 'gun' && r.gripRot) {
      quatR.multiply(qB.setFromEuler(eA.set(r.gripRot[0], r.gripRot[1], r.gripRot[2])));
    }

    // left hand: cannon > hook > timeline socket > class idle
    let lhKey = (keys ? sampleHand(keys, u, 'lh') : null) || ['fore', 0, 0, 0];
    let spaceL = 'gun', lhRot = null;
    if (vm.cannonT > 0 && vm.cannon && vm.cannon.visible) {
      spaceL = 'cannon';
      const rc = rigOf('cannon');
      tgtL.set(rc.grip[0], rc.grip[1], rc.grip[2]);
      lhRot = rc.gripRot;
    } else if (vm.hookBlend > 0.04 && vm.hook) {
      // grab EARLY (was 0.5): the hand leaves the gun as the hook starts
      // rising and rides it up — waiting for half-blend made the hand track
      // the holstering gun first, then slide across the screen to the hook
      spaceL = 'hook';
      const rk = rigOf('hookgun');
      tgtL.set(rk.grip[0], rk.grip[1], rk.grip[2]);
      lhRot = rk.gripRot;
    } else if (lhKey[0] === 'cam') {
      spaceL = 'cam';
      tgtL.set(lhKey[1], lhKey[2], lhKey[3]);
    } else {
      socketGun(r, lhKey, tgtL);
      // support-hand cant on the foregrip, bolt-grab pose on the bolt —
      // without boltRot the rack gesture reused the tuned foregrip cant
      if (lhKey[0] === 'fore') lhRot = r.foreRot;
      else if (lhKey[0] === 'bolt') lhRot = r.boltRot;
    }
    fistEulR.set(CFG.fistRotL[0], CFG.fistRotL[1], CFG.fistRotL[2]);
    quatL.setFromEuler(fistEulR);
    if (lhRot && (lhRot[0] || lhRot[1] || lhRot[2])) {
      quatL.multiply(qB.setFromEuler(eA.set(lhRot[0], lhRot[1], lhRot[2])));
    }

    /* -------- damp in holder space, solve in world -------- */
    camera.updateMatrixWorld(true);
    vm.root.getWorldQuaternion(qRootW);
    for (const side of ['R', 'L']) {
      const H = rig.hand[side];
      const space = side === 'R' ? spaceR : spaceL;
      const tgt = side === 'R' ? tgtR : tgtL;
      const tq = side === 'R' ? quatR : quatL;
      spaceMatrix(vm, space, mSpace);
      qSpaceOf(vm, space, qSpace);
      if (!H.has || H.space !== space) {
        if (H.has && H.space) {
          // carry the damped state into the new space so nothing pops
          spaceMatrix(vm, H.space, mOld);
          qSpaceOf(vm, H.space, qOld);
          vA.copy(H.pos).applyMatrix4(mOld);
          H.pos.copy(vA).applyMatrix4(mInv.copy(mSpace).invert());
          qC.copy(qOld).multiply(H.quat);
          H.quat.copy(qSpace).invert().multiply(qC);
        } else { H.pos.copy(tgt); H.quat.copy(tq); }
        H.space = space;
        H.has = true;
      }
      const k = 1 - Math.exp(-CFG.handDamp * dt);
      H.pos.lerp(tgt, k);
      H.quat.slerp(tq, k);
      // holder-local → root-local → world
      wPos.copy(H.pos).applyMatrix4(mSpace);
      vm.root.localToWorld(wPos);
      qSpaceOf(vm, space, qSpace);
      wQuat.copy(qRootW).multiply(qSpace).multiply(H.quat);
      solveArm(side, wPos, wQuat);
    }
  }

  return {
    init, update, refresh, startDraw, applyCfg, swayTick, fireKick,
    CFG, SWAY, RIG, RIG_OVR, TL, DRAW_DUR, CLS_OF, rigOf, LAB_KEY,
    _rig: rig, _anim: anim, _sway: swayState,   // for CDP + armlab tuning
  };
})();
