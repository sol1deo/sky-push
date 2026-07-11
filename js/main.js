/* =============================================================================
 * SKY PUSH — bootstrap & main loop
 * Physics runs at a FIXED 120 Hz (accumulator) so movement/bhop feel is
 * identical on any monitor refresh rate. Rendering runs at display rate.
 * ============================================================================= */
(function () {
  const errBox = document.getElementById('error-overlay');
  function fatal(msg) {
    errBox.classList.remove('hidden');
    errBox.textContent += msg + '\n';
  }
  window.addEventListener('error', (e) =>
    fatal((e.message || 'error') + '  @' + String(e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => fatal('promise: ' + String(e.reason)));

  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true,
    powerPreference: 'high-performance',   // ask laptops for the discrete GPU
    stencil: false,                        // nothing uses the stencil buffer
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));   // perf
  renderer.setSize(window.innerWidth, window.innerHeight);
  // graphics settings hook (render scale / shadows — applies immediately)
  let lastShadows = null;
  SKY.applyGraphics = () => {
    const S = SKY.Settings.data;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * S.renderScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (S.shadows !== lastShadows) {
      lastShadows = S.shadows;
      renderer.shadowMap.enabled = S.shadows !== 'off';
      const size = S.shadows === 'low' ? 1024 : 2048;
      scene.traverse((o) => {
        if (o.isDirectionalLight) {
          o.castShadow = S.shadows !== 'off';
          if (o.shadow && o.shadow.mapSize.x !== size) {
            o.shadow.mapSize.set(size, size);
            if (o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; }
          }
        }
        if (o.isMesh && o.material) o.material.needsUpdate = true;
      });
    }
  };
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // cinematic color response
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // (soft PCF costs ~2x)
  // NOTE: no post-processing chain — the cinematic look comes from per-map
  // mood lighting (low warm sun, long shadows, gradient sky domes) which is
  // effectively free, unlike bloom which tanked performance.

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    SKY.TUNING.camera.baseFov, window.innerWidth / window.innerHeight, 0.08, 500);
  camera.rotation.order = 'YXZ';
  scene.add(camera);   // required: the viewmodel is parented to the camera

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  SKY.Settings.init();
  SKY.Input.init(canvas);
  SKY.GFX.init();          // real models/textures (async; https hosts only)
  // once the asset pack lands, rebuild the menu backdrop with the real look
  SKY.GFX.onReady = () => {
    if (SKY.Game && SKY.Game.state === 'menu' &&
        !(SKY.Editor && SKY.Editor.active) && !(SKY.Replay && SKY.Replay.active)) {
      SKY.Map.load(scene, (SKY.HUD && SKY.HUD.mapSel) || 'sky');
      SKY.Attract.reset();
    }
    SKY.Locker.refreshPreview();
    // the editor's ASSETS panel gains the built-in 'pack' folder once loaded
    if (SKY.Assets.onChange) SKY.Assets.onChange();
  };
  SKY.Characters.init();
  SKY.Map.load(scene, 'sky');
  SKY.Effects.init(scene, camera);
  SKY.Weapons.init(scene);
  SKY.Grenades.init(scene);
  SKY.Grapple.init(scene);
  SKY.Pickups.init(scene);
  SKY.Sparks.init(scene);
  SKY.HUD.init();
  SKY.MapData.init();
  SKY.Game.init(scene, camera);
  SKY.Replay.init(scene, camera);
  SKY.Demos.init();
  SKY.Editor.init(scene, camera);
  SKY.Net.init();
  SKY.Locker.init();

  const STEP = 1 / 120;
  let acc = 0;
  let last = performance.now();
  let booted = false;
  let fpsAcc = 0, fpsN = 0;
  const fpsEl = document.getElementById('fps');

  function loop(now) {
    requestAnimationFrame(loop);
    let rdt = (now - last) / 1000;
    last = now;
    if (rdt > 0.1) rdt = 0.1;       // tab-switch hitch guard

    let rendered = false;
    if (!window.__autodrive) {
      if (SKY.Editor.active) {
        SKY.Editor.frame(rdt);      // map editor owns the camera
      } else if (SKY.Replay.active) {
        SKY.Replay.frame(rdt);      // editor drives camera + effects itself
        rendered = SKY.Replay.render(renderer, scene, camera);   // DoF pass
      } else {
        acc += rdt;
        let steps = 0;
        while (acc >= STEP && steps < 6) {
          SKY.Game.tick(STEP);
          acc -= STEP;
          steps++;
        }
        if (steps === 6) acc = 0;   // spiral-of-death guard
        SKY.Game.renderTick(rdt);
      }
    }
    if (!rendered) renderer.render(scene, camera);
    SKY.Locker.tick(Math.min(rdt, 0.05));   // menu character preview

    // fps counter (updates twice a second)
    fpsAcc += rdt; fpsN++;
    if (fpsAcc >= 0.5) {
      if (fpsEl && SKY.Settings.data.showFps) fpsEl.textContent = Math.round(fpsN / fpsAcc) + ' FPS';
      fpsAcc = 0; fpsN = 0;
    }

    if (!booted) {
      booted = true;
      document.getElementById('boot-status').textContent = 'BOOT_OK';
    }
  }
  requestAnimationFrame(loop);

  /* ---------------------------------------------------------------------
   * Headless smoke test: open index.html?autotest — starts a match, drives
   * the player with synthetic input for ~9.5 game-seconds via setTimeout
   * (headless virtual time fast-forwards timers, not rAF), then writes a
   * JSON report into #boot-status. Harmless to ignore.
   * --------------------------------------------------------------------- */
  if (/autotest/.test(location.search)) {
    window.__autodrive = true;      // normal rAF loop only renders, we tick
    if (/noanim/.test(location.search)) {
      const st = document.createElement('style');
      st.textContent = '*{animation:none!important;transition:none!important}';
      document.head.appendChild(st);
    }
    const mapM = location.search.match(/map=(\w+)/);
    const modeM = location.search.match(/mode=(\w+)/);
    let testMap = mapM ? mapM[1] : 'sky';
    if (/edmap/.test(location.search)) {
      // play on a generated CUSTOM map (exercises the whole editor pipeline)
      const d = SKY.MapData.blank();
      d.id = 'edtest'; d.name = 'EDTEST';
      d.blocks.push({ p: [14, 0.5, 0], s: [6, 1, 6], r: [0, 0.4, 0], pal: 'amber',
        crumble: false, mover: { type: 'elevator', amp: 3, period: 5 } });
      d.pads.push({ p: [6, 0.1, 6], launch: [0, 15, 0] });
      d.items.push({ p: [-4, 0.1, -4] });
      SKY.MapData.register(d);
      testMap = 'edtest';
    }
    // wait (briefly) for the real asset pack so screenshots show final art
    const beginTest = () => {
      SKY.Game.startMatch(3, testMap, modeM ? modeM[1] : 'lbs');
      SKY.Input.locked = true;      // pretend pointer lock
    };
    if (SKY.GFX.canLoad && !SKY.GFX.ready) {
      let waited = 0;
      const gate = setInterval(() => {
        if (SKY.GFX.ready || (waited += 100) > 6000) { clearInterval(gate); beginTest(); }
      }, 100);
    } else beginTest();
    const m = location.search.match(/autotest=([\d.]+)/);
    const duration = m ? parseFloat(m[1]) : 9.5;
    let t = 0, fired = 0, done = false;
    const boot = document.getElementById('boot-status');
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));

    function drive() {
      if (t > 4.2 && t < 8.5) { key('keydown', 'KeyW'); key('keydown', 'Space'); }
      else { key('keyup', 'KeyW'); key('keyup', 'Space'); }
      if (t > 5) document.dispatchEvent(new MouseEvent('mousemove', { movementX: 4, movementY: 0 }));
      if (t > 5.5 && fired < 4 && t - 5.5 > fired * 0.9) {
        canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        fired++;
      }
      // pick the first reward card whenever one is open
      if (t > 5 && SKY.Game.lootChoices && !/nopick/.test(location.search)) {
        key('keydown', 'Digit1'); key('keyup', 'Digit1');
      }
    }

    function finalize() {
      const g = SKY.Game, p = g.player;
      // &tracers: line the bots up crossing the player's view, fire volleys,
      // freeze mid-flight (screenshots)
      if (/tracers/.test(location.search)) {
        const s0 = SKY.World.spawnPoints[0];
        p.alive = true; p.eliminated = false; p.ragdoll = null;
        p.teleport(s0.pos, s0.yaw);
        SKY.Input.yaw = s0.yaw; SKY.Input.pitch = 0.05;
        const fwd = new THREE.Vector3(-Math.sin(s0.yaw), 0, -Math.cos(s0.yaw));
        const side = new THREE.Vector3(Math.cos(s0.yaw), 0, -Math.sin(s0.yaw));
        g.pawns.forEach((q, i) => {
          if (q === p) return;
          q.alive = true; q.eliminated = false; q.ragdoll = null;
          const pos = s0.pos.clone().addScaledVector(fwd, 7 + i * 5).addScaledVector(side, -7);
          pos.y += 0.5 + i * 0.8;
          q.teleport(pos, s0.yaw + Math.PI / 2 + (i % 2 ? Math.PI : 0));
          q.cmd.yaw = q.yaw; q.cmd.pitch = q.pitch = 0.04;
          q.visualTick(0.016);   // pose the avatar NOW so the muzzle is right
        });
        const volley = () => {
          for (const q of g.pawns) {
            if (q === p) continue;
            q.pbCd = 0; q.reloadT = 0; q.ammo = 30;
            SKY.Weapons.tryFirePrimary(q);
          }
        };
        for (let v = 0; v < 3; v++) {
          volley();
          for (let i = 0; i < 14; i++) SKY.Weapons.tick(STEP, g.pawns);
        }
        SKY.Game.renderTick(0.05);
        renderer.render(scene, camera);
        boot.textContent = 'TRACERS';
        return;
      }
      // &hookvm: fire the grapple and freeze with the hook arm up (screenshots)
      if (/hookvm/.test(location.search)) {
        const s0 = SKY.World.spawnPoints[0];
        p.alive = true; p.ragdoll = null;
        p.teleport(s0.pos, s0.yaw);
        SKY.Input.yaw = s0.yaw; SKY.Input.pitch = -0.3;
        p.cmd.yaw = p.yaw = s0.yaw; p.cmd.pitch = p.pitch = -0.3;
        p.airGrapples = 1; p.grappleCd = 0; p.cmd.grappleHeld = true;
        SKY.Grapple.tryFire(p);
        for (let i = 0; i < 40; i++) SKY.Game.renderTick(1 / 60);
        renderer.render(scene, camera);
        boot.textContent = 'HOOKVM:' + !!p.grapple;
        return;
      }
      // &cards: pop the reward cards over the live HUD and stop (screenshots).
      // Delayed past hideLoot's 420ms dismiss timer from any earlier pick.
      if (/cards/.test(location.search)) {
        setTimeout(() => {
          SKY.HUD.combat(true);
          SKY.HUD.showLoot(SKY.Loot.roll(p), () => {});
          SKY.Game.renderTick(0.05);
          renderer.render(scene, camera);
          boot.textContent = 'CARDS';
        }, 600);
        return;
      }
      const vals = [p.vel.x, p.vel.y, p.vel.z];
      for (const q of g.pawns) vals.push(q.pos.x, q.pos.y, q.pos.z);
      // replay smoke: open the editor, scrub, run some frames, close
      let replayOk = false, dofOk = false;
      const replayFrames = SKY.Replay.frameCount();
      try {
        SKY.Replay.open();
        SKY.Replay.seek(0);
        for (let i = 0; i < 24; i++) SKY.Replay.frame(1 / 24);
        replayOk = SKY.Replay.active && replayFrames > 60;
        // DoF smoke: auto mode, one frame through the post pass, check
        // that no shader failed to compile/link
        const dofBtn = document.querySelector('#rp-dof [data-d="1"]');
        if (dofBtn) {
          dofBtn.click();
          SKY.Replay.frame(1 / 24);
          dofOk = SKY.Replay.render(renderer, scene, camera) === true &&
            !(renderer.info.programs || []).some(p => p.diagnostics);
          document.querySelector('#rp-dof [data-d="0"]').click();
        }
        SKY.Replay.close();
      } catch (err) {
        replayOk = 'THROW: ' + (err.message || String(err));
      }
      // capture the report fields BEFORE the demo smoke tears the match down
      const stateAtEnd = g.state;
      const livesAtEnd = g.pawns.map(q => q.lives).join(',');
      const kosAtEnd = g.pawns.reduce((s, q) => s + q.koCount, 0);
      const botsMovedAtEnd = g.pawns.slice(1).some(q =>
        q.speedH() > 0.5 || q.pos.distanceTo(SKY.World.spawnPoints[1].pos) > 2);
      const roundTimeAtEnd = +g.roundTime.toFixed(1);
      const posAtEnd = [+p.pos.x.toFixed(1), +p.pos.y.toFixed(1), +p.pos.z.toFixed(1)];
      const spdAtEnd = +p.speedH().toFixed(1);
      const bankAtEnd = g.pawns.map(q => q.sparks || 0).join(',');
      const orbsAtEnd = SKY.Sparks.count();
      // match-history smoke: end the round (archives the demo), go to the
      // menu, then watch the archived round from there (skipped under &rpui,
      // which needs the live buffers kept around)
      let demoOk = false;
      if (!/rpui/.test(location.search)) {
        try {
          SKY.Game.netRoundEnd(p, false);
          SKY.Game.toMenu();
          const rec = SKY.Demos.list()[0];
          if (rec && rec.frames.length > 60) {
            SKY.Replay.openArchive(rec);
            for (let i = 0; i < 12; i++) SKY.Replay.frame(1 / 24);
            demoOk = SKY.Replay.active;
            SKY.Replay.close();
            demoOk = demoOk && !SKY.Replay.active && SKY.Game.state === 'menu';
          }
        } catch (err) {
          demoOk = 'THROW: ' + (err.message || String(err));
        }
        // &matches: land on the menu's MATCHES tab (for screenshots)
        if (/matches/.test(location.search)) {
          document.getElementById('tab-matches').click();
          renderer.render(scene, camera);
        }
      }
      // &edui: leave the editor open with a fresh map (screenshots)
      if (/edui/.test(location.search)) {
        SKY.Editor.open(null);
        document.getElementById('ed-addblock').click();
        SKY.Editor.frame(0.05);
        renderer.render(scene, camera);
        boot.textContent = 'EDUI';
        return;
      }
      // map-editor smoke: open, add a block, save a draft, close
      let editorOk = false;
      if (!/rpui/.test(location.search)) {
        try {
          SKY.Editor.open(null);
          document.getElementById('ed-addblock').click();
          SKY.Editor.frame(0.05);
          renderer.render(scene, camera);
          document.getElementById('ed-save').click();
          editorOk = SKY.Editor.active === true;
          SKY.Editor.exit();
          editorOk = editorOk && !SKY.Editor.active;
        } catch (err) {
          editorOk = 'THROW: ' + (err.message || String(err));
        }
      }
      // &rpui: leave the editor open so a --screenshot shows its UI
      // (&dof additionally switches auto depth of field on)
      if (/rpui/.test(location.search)) {
        SKY.Replay.open();
        SKY.Replay.seek(SKY.Replay.duration / 2);
        const orbitBtn = document.querySelector('#rp-cams [data-c="orbit"]');
        if (orbitBtn) orbitBtn.click();
        if (/dof/.test(location.search)) {
          const b = document.querySelector('#rp-dof [data-d="1"]');
          if (b) b.click();
        }
        SKY.Replay.frame(0.05);
        if (!SKY.Replay.render(renderer, scene, camera)) renderer.render(scene, camera);
      }
      boot.textContent = 'TEST:' + JSON.stringify({
        state: stateAtEnd,
        roundTime: roundTimeAtEnd,
        playerPos: posAtEnd,
        playerSpeed: spdAtEnd,
        shotsFired: fired,
        lives: livesAtEnd,
        kos: kosAtEnd,
        ragdolls: g.ragdollCount || 0,
        botsMoved: botsMovedAtEnd,
        nan: vals.some(v => !isFinite(v)),
        pickupsSpawned: SKY.Pickups.spawnedTotal(),
        bank: bankAtEnd,
        orbs: orbsAtEnd,
        replayFrames, replayOk, dofOk, demoOk, editorOk,
      });
    }

    window.__netTestSkip = true;
    function step() {
      if (done) return;
      try {
      drive();
      for (let i = 0; i < 12; i++) SKY.Game.tick(STEP);   // 0.1s of physics
      SKY.Game.renderTick(0.1);
      renderer.render(scene, camera);
      } catch (err) {
        done = true;
        boot.textContent = 'THROW@' + t.toFixed(1) + ': ' + (err.stack || err.message || String(err));
        return;
      }
      t += 0.1;
      boot.textContent = 'T:' + t.toFixed(1);
      if (t > duration) { done = true; finalize(); return; }
      setTimeout(step, 1);
    }
    setTimeout(step, 50);
  }

  /* ---------------------------------------------------------------------
   * Multiplayer smoke test (REAL TIME — WebRTC can't run under virtual
   * time). Open two browsers:
   *   index.html?nethost=ABCD   and   index.html?netjoin=ABCD
   * The host starts the match once the second player arrives; both report
   * JSON into #boot-status continuously.
   * --------------------------------------------------------------------- */
  const netM = !window.__netTestSkip && location.search.match(/net(host|join)=([A-Za-z0-9]+)/);
  if (netM) {
    const role = netM[1], code = netM[2].toUpperCase();
    SKY.Settings.data.nickname = role === 'host' ? 'HOSTBOT' : 'JOINBOT';
    SKY.Input.locked = true;
    const boot = document.getElementById('boot-status');
    let started = false;
    setTimeout(() => {
      if (role === 'host') SKY.Net._host(false, 1, code);
      else SKY.Net._join('priv-' + code);
    }, role === 'host' ? 600 : 4500);
    setInterval(() => {
      const G = SKY.Game;
      if (role === 'host' && SKY.Net.online && !started &&
          SKY.Net.roster.filter(r => !r.bot).length >= 2) {
        started = true;
        setTimeout(() => SKY.Net._start(), 800);
      }
      if (G.state === 'playing' && G.player && G.player.alive) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        if (Math.random() < 0.3) {
          canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
          window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        }
      }
      const remote = G.pawns.find(p => p.isRemote && !p.isBot);
      if (remote && remote.ragdoll) window.__sawRemoteRag = true;
      boot.textContent = 'NET:' + JSON.stringify({
        role, state: G.state, online: SKY.Net.online,
        players: SKY.Net.roster.filter(r => !r.bot).length,
        pawns: G.pawns.length,
        remoteSeen: !!remote,
        remotePos: remote ? [+remote.pos.x.toFixed(1), +remote.pos.y.toFixed(1), +remote.pos.z.toFixed(1)] : null,
        remoteRag: !!window.__sawRemoteRag,
        kos: G.pawns.reduce((s, q) => s + q.koCount, 0),
        ping: SKY.Net.pings ? SKY.Net.pings[remote ? remote.netId : 'host'] : null,
        rt: G.roundTime ? +G.roundTime.toFixed(1) : 0,
      });
    }, 700);
  }
})();
