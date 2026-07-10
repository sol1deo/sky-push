/* =============================================================================
 * SKY PUSH — input: keyboard, mouse look, pointer lock
 * - isDown(code): key currently held
 * - consumePressed(code): true exactly once per physical key press
 * - mouseDown(btn) / consumeClick(btn): same for mouse buttons (0=LMB, 2=RMB)
 * - yaw/pitch: accumulated look angles (radians)
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Input = (function () {
  const down = new Set();
  const pressed = new Set();
  const mouse = { 0: false, 1: false, 2: false };
  const clicked = new Set();

  let lockChangeT = 0;   // spurious-delta guard right after (un)locking
  let lastMoveT = 0;     // for the per-event look-speed clamp
  let emaDelta = 4;      // running average |delta| — outlier detector

  const api = {
    yaw: 0, pitch: 0,
    frameDX: 0, frameDY: 0,   // per-render-frame mouse delta (weapon sway)
    sensMult: 1,              // lowered while aiming/scoped
    wheel: 0,                 // accumulated scroll steps (weapon swap)
    locked: false,
    onLockChange: null,   // callback(locked)

    init(canvas) {
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Tab') e.preventDefault();          // Tab = scoreboard, not focus change
        if (e.code === 'Space') e.preventDefault();
        if (!down.has(e.code)) pressed.add(e.code);
        down.add(e.code);
      });
      window.addEventListener('keyup', (e) => down.delete(e.code));
      window.addEventListener('blur', () => { down.clear(); mouse[0] = mouse[1] = mouse[2] = false; });

      canvas.addEventListener('mousedown', (e) => { mouse[e.button] = true; clicked.add(e.button); });
      window.addEventListener('mouseup', (e) => { mouse[e.button] = false; });
      window.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('wheel', (e) => {
        if (api.locked && !(SKY.Replay && SKY.Replay.active)) api.wheel += Math.sign(e.deltaY);
      }, { passive: true });

      document.addEventListener('mousemove', (e) => {
        const now = performance.now();
        if (!api.locked) { lastMoveT = now; return; }
        if (now - lockChangeT < 80) { lastMoveT = now; return; }  // resync garbage
        let dx = e.movementX, dy = e.movementY;

        // --- spike rejection -------------------------------------------------
        // Chromium/Windows pointer lock sometimes delivers bogus or coalesced
        // deltas (single events OR short bursts) that instantly spin the view
        // 90-180°.
        // 1) hard outlier drop: a single event wildly above the recent average
        //    delta is a sensor glitch, not a flick — discard it entirely.
        const mag = Math.max(Math.abs(dx), Math.abs(dy));
        if (mag > Math.max(140, emaDelta * 14)) { lastMoveT = now; return; }
        emaDelta = emaDelta * 0.9 + mag * 0.1;
        // 2) look-speed clamp: everything else is capped to a believable flick
        //    speed for the time since the previous event — real aim passes
        //    through untouched, residual spikes get flattened.
        const dtm = Math.min(Math.max((now - lastMoveT) / 1000, 0.001), 0.05);
        lastMoveT = now;
        const maxD = Math.max(50, SKY.TUNING.input.maxLookSpeed * dtm);
        dx = SKY.U.clamp(dx, -maxD, maxD);
        dy = SKY.U.clamp(dy, -maxD, maxD);
        // ----------------------------------------------------------------------

        const s = SKY.TUNING.input.mouseSens * api.sensMult * (SKY.Settings ? SKY.Settings.data.sens : 1);
        const iy = SKY.TUNING.input.invertY ? -1 : 1;
        api.yaw -= dx * s;
        api.pitch -= dy * s * iy;
        api.pitch = SKY.U.clamp(api.pitch, -1.55, 1.55);
        api.frameDX += dx; api.frameDY += dy;
      });

      document.addEventListener('pointerlockchange', () => {
        api.locked = (document.pointerLockElement === canvas);
        lockChangeT = performance.now();
        if (api.onLockChange) api.onLockChange(api.locked);
      });
      api._canvas = canvas;
    },

    requestLock() {
      // unadjustedMovement = raw mouse input, no OS acceleration — the main
      // cure for Chromium's pointer-lock delta spikes. Falls back silently
      // where unsupported.
      try {
        const r = api._canvas.requestPointerLock({ unadjustedMovement: true });
        if (r && r.catch) {
          r.catch(() => {
            try {
              const r2 = api._canvas.requestPointerLock();
              if (r2 && r2.catch) r2.catch(() => { /* needs a trusted gesture; fine */ });
            } catch (e) { /* unsupported */ }
          });
        }
      } catch (e) {
        try {
          const r2 = api._canvas.requestPointerLock();
          if (r2 && r2.catch) r2.catch(() => {});
        } catch (e2) { /* headless / unsupported */ }
      }
    },

    isDown(code) { return down.has(code); },
    consumePressed(code) {
      if (pressed.has(code)) { pressed.delete(code); return true; }
      return false;
    },
    mouseDown(btn) { return !!mouse[btn]; },
    consumeClick(btn) {
      if (clicked.has(btn)) { clicked.delete(btn); return true; }
      return false;
    },
    clearEdges() { pressed.clear(); clicked.clear(); api.wheel = 0; },
    takeWheel() { const w = api.wheel; api.wheel = 0; return w; },
    takeFrameDelta() {
      const d = { dx: api.frameDX, dy: api.frameDY };
      api.frameDX = 0; api.frameDY = 0;
      return d;
    },

    /* ----- rebindable actions (see SKY.Settings.data.binds) ----- */
    action(name) {
      const b = SKY.Settings.data.binds[name];
      if (!b) return false;
      return b.startsWith('Mouse') ? api.mouseDown(+b.slice(5)) : api.isDown(b);
    },
    actionPressed(name) {
      const b = SKY.Settings.data.binds[name];
      if (!b) return false;
      return b.startsWith('Mouse') ? api.consumeClick(+b.slice(5)) : api.consumePressed(b);
    },
  };
  return api;
})();
