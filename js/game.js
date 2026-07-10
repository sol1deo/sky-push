/* =============================================================================
 * SKY PUSH — game orchestration
 * Match = first to 2 round wins. Two modes:
 *   lbs   — Last Bean Standing: 3 lives, fall = -1, last one alive wins.
 *   crown — Crown Rush: infinite lives; hold the crown for 25s total to win.
 * OVERTIME kicks in late in a round (arena crumbles / traffic speeds up).
 * Death rewards: KO -> pick 1 of 3 (mouse or 1/2/3). Respawn waits for you.
 * States: menu -> countdown -> playing -> roundend -> countdown ... -> matchend
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Game = (function () {
  const _eye = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const CENTER = new THREE.Vector3(0, 2, 0);

  const BOT_ROSTER = [
    ['Bloop', '#ff5db1'], ['Zippy', '#40c8ff'], ['Wobble', '#7dff9e'],
    ['Gustav', '#c39bff'], ['Peanut', '#ff9a3d'],
  ];
  const KO_LINES = [
    '<b>{k}</b> YEETED {v} off the sky',
    '<b>{k}</b> launched {v} into next week',
    '<b>{k}</b> sent {v} to the shadow realm',
    '{v} took the express elevator (thanks <b>{k}</b>)',
  ];
  const FALL_LINES = [
    '{v} fell off all by themselves',
    '{v} forgot the floor ends',
    '{v} discovered gravity',
    '{v} went sightseeing (downward)',
  ];

  let scene = null, camera = null;
  let camRoll = 0, camFov = 0, orbitA = 0.6;
  let lastCdNum = -1;
  let crownMesh = null, crownSpin = 0;

  const api = {
    state: 'menu',
    paused: false,
    mode: 'lbs',
    time: 0, roundTime: 0, roundNum: 0,
    pawns: [], bots: [], player: null,
    countdownT: 0, restartT: 0, winner: null,
    overtime: false,
    lootChoices: null, lootOpen: false,
    crownHolder: null,

    crownPos() {
      if (api.crownHolder) {
        return _v.set(api.crownHolder.pos.x, api.crownHolder.pos.y + api.crownHolder.height + 0.5, api.crownHolder.pos.z);
      }
      return api._crownFree;
    },
    _crownFree: new THREE.Vector3(),

    init(sc, cam) {
      scene = sc; camera = cam;
      camFov = SKY.TUNING.camera.baseFov;
      SKY.Attract.init(sc);
      SKY.HUD.onPlay = () => {
        SKY.SFX.init();
        api.startMatch(SKY.HUD.botCount, SKY.HUD.mapSel, SKY.HUD.modeSel, {
          rounds: SKY.HUD.roundsSel, lives: SKY.HUD.livesSel, crown: SKY.HUD.crownSel,
        });
        SKY.Input.requestLock();
      };
      SKY.HUD.onResume = () => SKY.Input.requestLock();
      SKY.HUD.onQuit = () => {
        if (SKY.Net.online) SKY.Net.leave();
        else api.toMenu();
      };
      SKY.Input.onLockChange = (locked) => {
        if (SKY.Replay.active) return;          // the editor owns the cursor
        if (api.state !== 'playing' && api.state !== 'countdown') return;
        if (!locked) {
          if (api.lootOpen) return;              // reward picker owns the cursor
          if (SKY.Net.online) {
            // ONLINE never pauses. ESC (window still focused) opens the menu;
            // alt-tab shows only a small "click to play" hint — no menu in
            // your face when you tab back.
            if (document.hasFocus()) SKY.HUD.setPause(true);
            else SKY.HUD.relockHint(true);
            return;
          }
          api.paused = true; SKY.HUD.setPause(true);
        } else {
          api.paused = false;
          SKY.HUD.setPause(false);
          SKY.HUD.relockHint(false);
        }
      };
    },

    /* match rules chosen in the menu / lobby (rounds & points to win) */
    applyRules(rules, mode) {
      if (!rules) return;
      if (rules.rounds) {
        SKY.TUNING.game.roundsToWin = rules.rounds;
        if (mode === 'bomb') SKY.TUNING.bomb.roundsToWin = rules.rounds;
      }
      if (rules.lives) SKY.TUNING.game.lives = rules.lives;
      if (rules.crown) SKY.TUNING.crown.holdToWin = rules.crown;
    },

    /* ---------------- match / round setup ---------------- */
    startMatch(nBots, mapId, mode, rules) {
      SKY.Attract.stop();
      for (const p of api.pawns) p.dispose();
      api.pawns = []; api.bots = [];
      SKY.Weapons.clear(); SKY.Grenades.clear();
      api.mode = mode || 'lbs';
      this.applyRules(rules, api.mode);
      if (api.mode === 'bomb') mapId = 'terminal';   // the bomb map
      SKY.Map.load(scene, mapId || 'sky');

      const myName = (SKY.Settings.data.nickname || '').trim() || 'YOU';
      if (api.mode === 'bomb') {
        const TS = SKY.TUNING.bomb.teamSize;
        const AC = ['#ff9a5a', '#ff6a4a', '#ffb84a', '#e8543a', '#ff8a7a', '#d8742a'];
        const DC = ['#5ab4ff', '#4a86e8', '#6ad8e8', '#3a66c8', '#8ab4ff', '#2a9ad8'];
        const names = ['Bloop', 'Zippy', 'Wobble', 'Gustav', 'Peanut', 'Momo', 'Taco', 'Pickle'];
        let ni = 0;
        const mk = (name, color, team, isLocal) => {
          const p = new SKY.Pawn({ name, color, isLocal });
          p.team = team;
          p.isBot = !isLocal;
          p.money = SKY.TUNING.bomb.startMoney;
          p.buildVisual(scene);
          api.pawns.push(p);
          if (isLocal) api.player = p;
          else api.bots.push(new SKY.Bot(p));
        };
        mk(myName, AC[0], 'atk', true);
        for (let i = 1; i < TS; i++) mk(names[ni], AC[i], 'atk', false), ni++;
        for (let i = 0; i < TS; i++) mk(names[ni], DC[i], 'def', false), ni++;
        api.bombScore = { atk: 0, def: 0 };
      } else {
        api.player = new SKY.Pawn({ name: myName, color: '#ffd34d', isLocal: true });
        api.player.buildVisual(scene);
        api.pawns.push(api.player);
        for (let i = 0; i < SKY.U.clamp(nBots, 1, 5); i++) {
          const p = new SKY.Pawn({ name: BOT_ROSTER[i][0], color: BOT_ROSTER[i][1] });
          p.isBot = true;
          p.buildVisual(scene);
          api.pawns.push(p);
          api.bots.push(new SKY.Bot(p));
        }
      }
      this._finishMatchSetup();
    },

    /* online variant: pawns come from the lobby roster (host order) */
    startMatchNet(cfg) {
      SKY.Attract.stop();
      for (const p of api.pawns) p.dispose();
      api.pawns = []; api.bots = [];
      SKY.Weapons.clear();
      api.mode = cfg.mode || 'lbs';
      SKY.Map.load(scene, cfg.mapId || 'sky');

      const amHost = SKY.Net.role === 'host';
      const AC = ['#ff9a5a', '#ff6a4a', '#ffb84a', '#e8543a', '#ff8a7a', '#d8742a'];
      const DC = ['#5ab4ff', '#4a86e8', '#6ad8e8', '#3a66c8', '#8ab4ff', '#2a9ad8'];
      let ai = 0, di = 0;
      cfg.roster.forEach((r, idx) => {
        const isLocal = r.id === cfg.myId;
        const team = api.mode === 'bomb' ? (idx % 2 === 0 ? 'atk' : 'def') : null;
        const color = team ? (team === 'atk' ? AC[ai++ % AC.length] : DC[di++ % DC.length]) : r.color;
        const p = new SKY.Pawn({ name: r.name, color, isLocal });
        p.netId = r.id;
        p.isBot = !!r.bot;
        p.isRemote = !isLocal && !(amHost && r.bot);   // host simulates bots
        p.team = team;
        if (api.mode === 'bomb') p.money = SKY.TUNING.bomb.startMoney;
        p.buildVisual(scene);
        api.pawns.push(p);
        if (isLocal) api.player = p;
        if (amHost && r.bot) api.bots.push(new SKY.Bot(p));
      });
      if (api.mode === 'bomb') api.bombScore = { atk: 0, def: 0 };
      this._finishMatchSetup();
    },

    _finishMatchSetup() {
      if (crownMesh) { scene.remove(crownMesh); crownMesh = null; }
      if (api.mode === 'crown') crownMesh = buildCrownMesh();
      api.roundNum = 0;
      SKY.HUD.hideMenu();
      api.startRound(true);
    },

    /* live map preview behind the menu / lobby */
    previewMap(id) {
      if (api.state !== 'menu') return;
      SKY.Map.load(scene, id);
      SKY.Attract.reset();      // recast the menu show on the new map
    },

    startRound(fromMenu) {
      if (api.mode === 'bomb') { this.startBombRound(fromMenu); return; }
      SKY.Replay.wipe();                          // fresh clip buffer per round
      SKY.Pickups.clear();
      SKY.Map.resetRound();                       // rebuild if overtime crumbled it
      api.overtime = false;
      api.roundNum++;
      const spawns = SKY.World.spawnPoints;
      api.pawns.forEach((p, i) => {
        p.lives = SKY.TUNING.game.lives;
        p.eliminated = false; p.alive = true; p.deadT = 0; p.koCount = 0;
        p.crownTime = 0;
        p.lastHitBy = null; p.lastHitT = -99;
        SKY.Grapple.release(p); p.grappleCd = 0; p.pbCd = 0; p.acCd = 0; p.dashCd = 0;
        p.tauntT = 0; p.zoomed = false;
        p.weapon = 'pistol'; p.deaths = 0;
        p.slots = { 1: null, 2: 'pistol' };
        p.slotAmmo = { 1: 0, 2: SKY.TUNING.weapons.pistol.mag };
        p.activeSlot = 2; p.drawT = 0;
        p.mods = { speedMult: 1, jumpMult: 1, cdMult: 1, knockResist: 1,
                   grappleRangeMult: 1, grappleCdMult: 1, magMult: 1, gravMult: 1, powerMult: 1 };
        p.abilities = { doubleJump: false, dash: false, pound: false };
        p.owned.clear();
        const s = spawns[i % spawns.length];
        p.teleport(s.pos, s.yaw);
        p.visualTick(0.016);
      });
      api.lootChoices = null; api.lootOpen = false;
      SKY.HUD.hideLoot();
      SKY.Effects.ensureWeapon('pistol');
      api.crownHolder = null;
      api._crownFree.copy(SKY.World.crownHome || CENTER);
      api.winner = null;
      api.roundTime = 0;
      api.state = 'countdown';
      api.countdownT = SKY.TUNING.game.countdown + 0.99;
      lastCdNum = -1;
      SKY.HUD.showRespawn(null);
      SKY.HUD.subMsg('Round ' + api.roundNum + ' — first to ' + SKY.TUNING.game.roundsToWin + ' wins', 2.5);
      // returning from an unlocked state (e.g. reward picker was open):
      // offline re-pauses; online just shows the overlay (match keeps running)
      if (!fromMenu && !SKY.Input.locked) {
        if (!SKY.Net.online) api.paused = true;
        SKY.HUD.setPause(true);
      }
    },

    /* ---------------- BOMB mode ---------------- */
    startBombRound() {
      const C = SKY.TUNING.bomb;
      SKY.Replay.wipe();
      SKY.Pickups.clear();
      api.roundNum++;
      SKY.Weapons.clear(); SKY.Grenades.clear();
      const atkS = SKY.World.teamSpawns.atk, defS = SKY.World.teamSpawns.def;
      let ai = 0, di = 0;
      const atkAlive = [];
      for (const p of api.pawns) {
        p.alive = true; p.eliminated = false; p.deadT = 0;
        p.lastHitBy = null; p.lastHitT = -99;
        SKY.Grapple.release(p); p.grappleCd = 0; p.pbCd = 0; p.acCd = 0; p.dashCd = 0;
        p.tauntT = 0; p.zoomed = false;
        if (!p._survived) {
          p.weapon = 'pistol'; p.nades = { type: 'he', count: 0 };
          p.slots = { 1: null, 2: 'pistol' };
          p.slotAmmo = { 1: 0, 2: SKY.TUNING.weapons.pistol.mag };
          p.activeSlot = 2; p.drawT = 0;
        }
        const s = p.team === 'atk' ? atkS[ai++ % atkS.length] : defS[di++ % defS.length];
        p.teleport(s.pos, s.yaw);
        p.visualTick(0.016);
        if (p.team === 'atk') atkAlive.push(p);
      }
      api.bomb = {
        phase: 'freeze', t: C.freezeTime,
        planted: false, timer: 0, pos: null, drop: null,
        carrier: SKY.Net.authority ? SKY.U.pick(atkAlive) : null,
        prog: 0, dprog: 0, beepT: 0,
      };
      api.lootChoices = null; api.lootOpen = false;
      SKY.HUD.hideLoot();
      SKY.Effects.ensureWeapon(api.player ? api.player.weapon : 'pistol');
      api.winner = null;
      api.roundTime = 0;
      api.state = 'playing';
      SKY.HUD.showRespawn(null);
      SKY.HUD.centerMsg('Buy phase', 1.6, 30);
      SKY.HUD.subMsg('Round ' + api.roundNum + ' · ATK ' + api.bombScore.atk + ' — ' + api.bombScore.def + ' DEF', 3);
      if (SKY.HUD.buyMenu) SKY.HUD.buyMenu(true);
      // bots go shopping
      if (SKY.Net.authority) for (const p of api.pawns) if (p.isBot && !p.isRemote) this.botBuy(p);
      if (api.bomb.carrier && api.bomb.carrier.isLocal) SKY.HUD.subMsg('You carry the bomb — plant at A or B', 4);
    },

    botBuy(p) {
      const P = SKY.TUNING.prices;
      const pickW = p.money >= P.mega + 500 && Math.random() < 0.4 ? 'mega'
        : p.money >= P.longshot + 400 && Math.random() < 0.25 ? 'longshot'
        : p.money >= P.blaster + 400 ? 'blaster'
        : p.money >= P.magnum + 300 && Math.random() < 0.4 ? 'magnum'
        : p.money >= P.smg + 300 ? 'smg' : null;
      if (pickW) { p.money -= P[pickW]; p.weapon = pickW; p.ammo = SKY.TUNING.weapons[pickW].mag; }
      if (p.money >= 400) { p.money -= 300; p.nades = { type: 'he', count: 2 }; }
    },

    buy(id) {
      const p = api.player;
      if (api.mode !== 'bomb' || !api.bomb || api.bomb.phase !== 'freeze' || !p) return;
      if (SKY.Net.online && SKY.Net.role === 'client') { SKY.Net.sendBuy(id); return; }
      const isNade = !!SKY.TUNING.grenades[id];
      const price = isNade ? SKY.TUNING.grenades[id].price : SKY.TUNING.prices[id];
      if (price === undefined) return;
      if (p.money < price) { SKY.SFX.dry(); return; }
      p.money -= price;
      SKY.SFX.cash();
      if (isNade) {
        p.nades = { type: id, count: (p.nades && p.nades.type === id ? p.nades.count : 0) + 2 };
      } else {
        p.giveWeapon(id);
      }
      if (SKY.HUD.refreshBuyMenu) SKY.HUD.refreshBuyMenu();
    },

    tickBomb(dt) {
      const B = api.bomb, C = SKY.TUNING.bomb;
      if (!B || !SKY.Net.authority) return;
      const atkAlive = api.pawns.filter(p => p.team === 'atk' && p.alive);
      const defAlive = api.pawns.filter(p => p.team === 'def' && p.alive);

      if (B.phase === 'freeze') {
        B.t -= dt;
        if (B.t <= 0) {
          B.phase = 'live'; B.t = C.roundTime;
          SKY.HUD.centerMsg('GO', 0.8, 64);
          SKY.SFX.go();
          if (SKY.HUD.buyMenu) SKY.HUD.buyMenu(false);
        }
        return;
      }
      if (B.phase === 'post') {
        B.t -= dt;
        if (B.t <= 0) {
          if (api.bombScore.atk >= C.roundsToWin || api.bombScore.def >= C.roundsToWin) {
            api.state = 'matchend';
            api.restartT = 10;
            const t = api.bombScore.atk >= C.roundsToWin ? 'Attackers' : 'Defenders';
            SKY.HUD.centerMsg(t + ' win the match', 8, 36);
          } else {
            if (SKY.Net.online) SKY.Net.hostNewRound();
            this.startBombRound();
          }
        }
        return;
      }

      /* ---- live ---- */
      if (!B.planted) {
        B.t -= dt;
        if (B.t <= 0) return this.endBombRound('def', 'Time ran out');
      } else {
        B.timer -= dt;
        B.beepT -= dt;
        if (B.beepT <= 0) { SKY.SFX.beep(); B.beepT = Math.max(0.14, B.timer / 14); }
        if (B.timer <= 0) {
          // BOOM — yeet everything near the site
          const mid = new THREE.Vector3();
          for (const p of api.pawns) {
            if (!p.alive) continue;
            p.midPos(mid);
            const d = mid.distanceTo(B.pos);
            if (d > C.blastRadius) continue;
            const k = 1 - (d / C.blastRadius) * 0.5;
            const imp = mid.clone().sub(B.pos).normalize().multiplyScalar(C.blastForce * k);
            imp.y += 14 * k;
            if (p.isRemote) SKY.Net.sendHit(p.netId, [imp.x, imp.y, imp.z], false);
            else { p.applyKnockback(imp, null); p.enterRagdoll('air', imp); }
          }
          for (let i = 0; i < 4; i++) {
            SKY.Effects.burst(B.pos, { count: 24, speed: 10 + i * 4, color: i % 2 ? '#ffb06a' : '#ff6a3a', life: 0.8, size: 0.9 });
          }
          SKY.Effects.ring(B.pos.clone(), '#ffb06a', C.blastRadius * 1.6, 0.6);
          SKY.SFX.boom(); SKY.Effects.shake(2);
          return this.endBombRound('atk', 'The bomb detonated');
        }
      }

      // carrier died -> bomb resets to attacker spawn; nearest attacker picks up
      if (!B.planted) {
        if (B.carrier && !B.carrier.alive) {
          B.carrier = null;
          B.drop = new THREE.Vector3(0, 0.3, 24);
          SKY.HUD.killFeed('Bomb reset to attacker side');
        }
        if (!B.carrier && B.drop) {
          for (const p of atkAlive) {
            if (p.pos.distanceTo(B.drop) < 2.5) {
              B.carrier = p; B.drop = null;
              SKY.HUD.killFeed('<b>' + p.name + '</b> has the bomb');
              break;
            }
          }
        }
      }

      // planting
      if (!B.planted && B.carrier && B.carrier.alive && B.carrier.grounded) {
        const site = SKY.World.bombSites.find(s =>
          Math.hypot(B.carrier.pos.x - s.pos.x, B.carrier.pos.z - s.pos.z) < s.r);
        const holding = site && (B.carrier.isLocal
          ? SKY.Input.action('interact')
          : B.carrier.isRemote ? B.carrier._acting
          : !api.pawns.some(e => e.team === 'def' && e.alive && e.pos.distanceTo(B.carrier.pos) < 12));
        if (holding) {
          B.prog += dt;
          if (B.prog >= C.plantTime) {
            B.planted = true;
            B.pos = B.carrier.pos.clone().add(new THREE.Vector3(0, 0.2, 0));
            B.timer = C.bombTimer;
            B.carrier.money += C.plantMoney;
            B.carrier = null; B.prog = 0;
            SKY.HUD.killFeed('The bomb has been planted');
            SKY.HUD.subMsg('Bomb planted — ' + Math.round(C.bombTimer) + 's', 2.5);
            SKY.SFX.beep();
          }
        } else B.prog = Math.max(0, B.prog - dt * 2);
      } else if (!B.planted) B.prog = Math.max(0, B.prog - dt * 2);

      // defusing
      if (B.planted) {
        let defuser = null;
        for (const p of defAlive) {
          if (p.pos.distanceTo(B.pos) < 2.4 && p.grounded) { defuser = p; break; }
        }
        const holding = defuser && (defuser.isLocal
          ? SKY.Input.action('interact')
          : defuser.isRemote ? defuser._acting
          : !atkAlive.some(e => e.pos.distanceTo(defuser.pos) < 10));
        if (holding) {
          B.dprog += dt;
          if (B.dprog >= C.defuseTime) return this.endBombRound('def', 'Bomb defused');
        } else B.dprog = Math.max(0, B.dprog - dt * 2);
      }

      // team wipes (planted attackers-wipe still lets the bomb cook)
      if (!B.planted) {
        if (atkAlive.length === 0) return this.endBombRound('def', 'Attackers eliminated');
        if (defAlive.length === 0) return this.endBombRound('atk', 'Defenders eliminated');
      }
    },

    endBombRound(team, reason) {
      const B = api.bomb, C = SKY.TUNING.bomb;
      if (!B || B.phase === 'post') return;
      SKY.Demos.archiveRound({ name: team === 'atk' ? 'Attackers' : 'Defenders' });
      B.phase = 'post'; B.t = 4;
      api.bombScore[team]++;
      for (const p of api.pawns) {
        p.money = Math.min(16000, p.money + (p.team === team ? C.winMoney : C.lossMoney));
        p._survived = p.alive;
      }
      SKY.HUD.centerMsg(team === 'atk' ? 'Attackers win' : 'Defenders win', 3, 36);
      SKY.HUD.subMsg(reason + ' · ATK ' + api.bombScore.atk + ' — ' + api.bombScore.def + ' DEF', 4);
      SKY.SFX.win();
      if (SKY.Net.online) SKY.Net.hostBombRound(team, reason, api.bombScore);
    },

    toMenu() {
      if (SKY.Replay.active) SKY.Replay.close();
      SKY.Replay.wipe();
      SKY.Pickups.clear();
      for (const p of api.pawns) p.dispose();
      api.pawns = []; api.bots = []; api.player = null;
      SKY.Weapons.clear();
      if (crownMesh) { scene.remove(crownMesh); crownMesh = null; }
      api.state = 'menu';
      api.paused = false;
      api.lootChoices = null; api.lootOpen = false;
      SKY.HUD.hideLoot();
      SKY.HUD.setPause(false);
      SKY.HUD.showMenu();
      if (document.pointerLockElement) document.exitPointerLock();
      // leaving a map-editor TEST match drops you back into the editor
      if (SKY.Editor && SKY.Editor.pendingReturn) setTimeout(() => SKY.Editor.resume(), 0);
    },

    /* ---------------- reward picking ---------------- */
    pickLoot(i) {
      if (!api.lootChoices || !api.lootChoices[i]) return;
      const item = api.lootChoices[i];
      SKY.Loot.apply(api.player, item);
      if (SKY.Net.online && SKY.Net.role === 'host') SKY.Net.hostLoadoutFromLocalPick(item);
      api.lootChoices = null;
      api.lootOpen = false;
      SKY.HUD.hideLoot(i);
      SKY.Input.requestLock();
    },

    /* ---------------- fixed-rate physics tick ---------------- */
    tick(dt) {
      api.time += dt;
      SKY.World.update(dt, api.time);

      if (api.state === 'menu') return;

      // V — open the replay editor (mid-round pauses; round/match end too)
      if (SKY.Input.actionPressed('replay') &&
          (api.state === 'playing' || api.state === 'roundend' || api.state === 'matchend')) {
        SKY.Replay.open();
        return;
      }
      if (api.paused) return;

      if (api.state === 'countdown') {
        if (api.player) { api.player.cmd.yaw = SKY.Input.yaw; api.player.cmd.pitch = SKY.Input.pitch;
          api.player.yaw = SKY.Input.yaw; api.player.pitch = SKY.Input.pitch; }
        api.countdownT -= dt;
        const n = Math.ceil(api.countdownT);
        if (n !== lastCdNum && n > 0) { lastCdNum = n; SKY.HUD.centerMsg(String(n), 0.9, 64); SKY.SFX.countdown(); }
        if (api.countdownT <= 0) {
          api.state = 'playing';
          SKY.HUD.centerMsg('GO', 0.8, 64);
          SKY.SFX.go();
        }
        return;
      }

      if (api.state === 'roundend' || api.state === 'matchend') {
        api.restartT -= dt;
        SKY.Weapons.tick(dt, api.pawns);
        for (const p of api.pawns) p.visualTick(dt);
        const skip = SKY.Input.consumePressed('Enter');
        if (!SKY.Net.authority) return;             // clients wait for the host
        if (api.state === 'matchend') {
          if (api.restartT <= 0 || skip) {
            if (SKY.Net.online) { api.toMenu(); SKY.Net.hostToLobby(); }
            else api.toMenu();
          }
        } else if (api.restartT <= 0 || skip) {
          if (SKY.Net.online) SKY.Net.hostNewRound();
          api.startRound();
        }
        return;
      }

      /* ================= state: playing ================= */
      if (api.mode === 'bomb') {
        api.roundTime = (api.bomb && api.bomb.phase !== 'freeze') ? api.roundTime + dt : 0;
        this.tickBomb(dt);
      } else {
        api.roundTime += dt;
      }

      // OVERTIME: arena starts working against you (host decides; not in bomb)
      if (SKY.Net.authority && api.mode !== 'bomb' && !api.overtime &&
          api.roundTime > SKY.TUNING.game.overtimeStart) {
        api.overtime = true;
        SKY.Map.startOvertime();
        SKY.HUD.centerMsg('Overtime', 2.2, 40);
        SKY.HUD.subMsg(SKY.Map.overtimeMsg(), 3);
        SKY.SFX.overtime();
        if (SKY.Net.online) SKY.Net.hostOvertime();
      }

      // reward pick via number keys (mouse clicks handled by HUD)
      if (api.lootChoices) {
        for (let i = 0; i < api.lootChoices.length; i++) {
          if (SKY.Input.consumePressed('Digit' + (i + 1))) { api.pickLoot(i); break; }
        }
      }

      this.buildPlayerCmd();
      for (const b of api.bots) b.tick(dt, api.pawns, api.time);

      // bomb buy phase: everyone stands still
      if (api.mode === 'bomb' && api.bomb && api.bomb.phase === 'freeze') {
        for (const p of api.pawns) {
          p.cmd.mx = 0; p.cmd.mz = 0;
          p.cmd.jumpHeld = false; p.cmd.jumpPressed = false;
        }
      }

      for (const p of api.pawns) {
        if (!p.alive) continue;
        if (p.isRemote) { SKY.Net.lerpPawn(p, dt); continue; }
        p.tick(dt);
        const pad = SKY.World.checkPads(p);
        if (pad) {
          SKY.Effects.padRing(new THREE.Vector3(pad.x, pad.y, pad.z));
          SKY.SFX.pad();
        }
        SKY.Grapple.tick(dt, p);
        if (!p.grounded && p.vel.y < -10 && p.pos.y < SKY.World.killY + 12 && !p.fellScreamed) {
          p.fellScreamed = true;
          SKY.SFX.scream(p.isLocal);
        }
      }

      this.separatePawns();
      SKY.Weapons.tick(dt, api.pawns);
      SKY.Grenades.tick(dt, api.pawns);
      SKY.Pickups.tick(dt);
      if (SKY.Net.authority) this.tickCrown(dt);

      // kill plane + respawns (host authoritative online)
      if (SKY.Net.authority) {
        for (const p of api.pawns) {
          if (p.alive && p.pos.y < SKY.World.killY) this.handleKO(p);
          if (api.mode === 'bomb') continue;   // no respawns mid-round in bomb
          if (!p.alive && !p.eliminated) {
            p.deadT -= dt;
            const waiting = (p.isLocal && api.lootChoices) ||
                            (SKY.Net.online && p.isRemote && SKY.Net.hostWaitingLoot(p));
            if (p.isLocal) {
              SKY.HUD.showRespawn(waiting
                ? 'Pick a reward to respawn'
                : 'Respawning in ' + Math.max(0, p.deadT).toFixed(1));
            }
            if (p.deadT <= 0 && !waiting) this.respawn(p);
          }
        }
      }

      for (const p of api.pawns) p.visualTick(dt);
      SKY.Replay.record(dt);
      if (api.mode === 'lbs' && SKY.Net.authority) this.checkWin();
    },

    /* ---------------- Crown Rush ---------------- */
    tickCrown(dt) {
      if (api.mode !== 'crown' || api.state !== 'playing') return;
      const C = SKY.TUNING.crown;
      if (api.crownHolder) {
        if (!api.crownHolder.alive) {
          SKY.HUD.killFeed('<b>' + api.crownHolder.name + '</b> dropped the crown');
          api.crownHolder = null;
          api._crownFree.copy(SKY.World.crownHome || CENTER);
          SKY.Effects.respawnBeam(api._crownFree, '#ffd34d');
        } else {
          api.crownHolder.crownTime += dt;
          if (api.crownHolder.crownTime >= C.holdToWin) this.endRound(api.crownHolder);
        }
      } else {
        for (const p of api.pawns) {
          if (!p.alive) continue;
          p.midPos(_eye);
          if (_eye.distanceTo(api._crownFree) < C.pickupRadius + 0.6) {
            api.crownHolder = p;
            SKY.HUD.killFeed('<b>' + p.name + '</b> grabbed the crown');
            SKY.SFX.crown();
            break;
          }
        }
      }
    },

    buildPlayerCmd() {
      const p = api.player;
      if (!p) return;
      const c = p.cmd;
      c.yaw = SKY.Input.yaw; c.pitch = SKY.Input.pitch;
      if (!p.alive) return;
      const In = SKY.Input;
      c.mx = (In.action('right') ? 1 : 0) - (In.action('left') ? 1 : 0);
      c.mz = (In.action('forward') ? 1 : 0) - (In.action('back') ? 1 : 0);
      c.jumpHeld = In.action('jump');
      if (In.actionPressed('jump')) c.jumpPressed = true;
      c.crouch = In.action('crouch');
      c.grappleHeld = In.action('grapple');
      p._acting = In.action('interact');

      // weapon slots: 1 = pickup, 2 = pistol; wheel = quick swap.
      // (blocked while the reward cards or the buy menu own the number keys)
      if (!api.lootChoices && !SKY.HUD._buyOpen) {
        if (In.consumePressed('Digit1')) p.switchSlot(1);
        if (In.consumePressed('Digit2')) p.switchSlot(2);
        const wd = In.takeWheel();
        if (wd) p.switchSlot(p.activeSlot === 1 ? 2 : 1);
      }

      p.zoomed = In.action('aim') && !p.ragdoll && !p.grapple;

      const auto = SKY.Weapons.defOf(p).auto;
      if (auto ? In.action('fire') : In.actionPressed('fire')) SKY.Weapons.tryFirePrimary(p);
      if (In.actionPressed('cannon')) SKY.Weapons.tryFireAirCannon(p, api.pawns);
      if (In.actionPressed('grapple')) SKY.Grapple.tryFire(p);
      if (In.actionPressed('grenade')) SKY.Grenades.throwNade(p);
      if (In.actionPressed('buymenu') && api.mode === 'bomb' && api.bomb &&
          api.bomb.phase === 'freeze' && SKY.HUD.buyMenu) {
        SKY.HUD.buyMenu('toggle');
      }
      if (In.actionPressed('dash')) p.tryDash();
      if (In.actionPressed('taunt') && p.tryTaunt()) SKY.Net.sendTaunt();
      if (In.actionPressed('reload')) SKY.Weapons.tryReload(p);
      if (In.actionPressed('reset')) {
        const s = SKY.World.spawnPoints[0];
        p.teleport(s.pos, s.yaw);
      }
    },

    separatePawns() {
      const R = 0.85;
      for (let i = 0; i < api.pawns.length; i++) {
        const a = api.pawns[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < api.pawns.length; j++) {
          const b = api.pawns[j];
          if (!b.alive) continue;
          if (Math.abs(a.pos.y - b.pos.y) > 1.7) continue;
          let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          const d = Math.hypot(dx, dz);
          if (d > R) continue;
          if (d < 1e-4) { dx = 1; dz = 0; }
          else { dx /= d; dz /= d; }
          const push = (R - d) * 0.5;
          a.pos.x -= dx * push; a.pos.z -= dz * push;
          b.pos.x += dx * push; b.pos.z += dz * push;
        }
      }
    },

    /* ---------------- KOs, respawns, winning ---------------- */
    handleKO(pawn) {
      pawn.deaths++;
      if (api.mode !== 'crown' && api.mode !== 'bomb') pawn.lives--;
      pawn.alive = false;
      SKY.Grapple.release(pawn);
      SKY.Effects.koBurst(_v.set(pawn.pos.x, SKY.World.killY + 3, pawn.pos.z).clone(), pawn.color);

      const G = SKY.TUNING.game;
      const killer = (pawn.lastHitBy && !pawn.lastHitBy.eliminated &&
                      api.time - pawn.lastHitT < G.koCreditWindow) ? pawn.lastHitBy : null;
      if (killer) killer.koCount++;
      const line = killer
        ? SKY.U.pick(KO_LINES).replace('{k}', killer.name).replace('{v}', pawn.name)
        : SKY.U.pick(FALL_LINES).replace('{v}', pawn.name);
      SKY.HUD.killFeed(line);
      SKY.SFX.ko(pawn.isLocal || (killer && killer.isLocal));
      pawn.lastHitBy = null;

      // bots love rubbing it in
      if (killer && killer.isBot && killer.alive && killer.grounded && Math.random() < 0.45) {
        killer.tryTaunt();
      }

      if (api.mode === 'bomb') {
        // out for the round; killer earns
        pawn.eliminated = true;
        if (killer && killer.team !== pawn.team) {
          killer.money = Math.min(16000, killer.money + SKY.TUNING.bomb.killMoney);
          if (killer.isLocal) SKY.SFX.cash();
        }
        if (pawn.isLocal) SKY.HUD.showRespawn('Out for the round — spectating');
        if (SKY.Net.online && SKY.Net.role === 'host') SKY.Net.hostKo(pawn, line, killer);
        return;
      }
      if (api.mode === 'crown' || pawn.lives > 0) {
        pawn.deadT = G.respawnDelay;
        if (pawn.isLocal) {
          api.lootChoices = SKY.Loot.roll(pawn);
          api.lootOpen = true;
          SKY.HUD.showLoot(api.lootChoices, (i) => api.pickLoot(i));
          if (document.pointerLockElement) document.exitPointerLock();
        } else if (!pawn.isRemote) {
          SKY.Loot.autoPick(pawn);       // host-simulated bots
        }
      } else {
        pawn.eliminated = true;
        SKY.HUD.killFeed('<b>' + pawn.name + '</b> is eliminated');
        if (pawn.isLocal) SKY.HUD.showRespawn('Eliminated — spectating');
      }
      // online: tell everyone (and send loot choices to a remote victim)
      if (SKY.Net.online && SKY.Net.role === 'host') SKY.Net.hostKo(pawn, line, killer);
    },

    respawn(pawn) {
      let best = SKY.World.spawnPoints[0], bestScore = -1;
      for (const s of SKY.World.spawnPoints) {
        let minD = 999;
        for (const o of api.pawns) {
          if (o === pawn || !o.alive) continue;
          minD = Math.min(minD, s.pos.distanceTo(o.pos));
        }
        if (minD > bestScore) { bestScore = minD; best = s; }
      }
      pawn.teleport(best.pos, best.yaw);
      pawn.alive = true;
      pawn.grappleCd = 0; pawn.dashCd = 0; pawn.acCd = 0; pawn.pbCd = 0;
      SKY.Effects.respawnBeam(best.pos, pawn.color);
      if (pawn.isLocal) SKY.HUD.showRespawn(null);
      if (SKY.Net.online && SKY.Net.role === 'host') SKY.Net.hostRespawn(pawn, best.pos, best.yaw);
    },

    checkWin() {
      const left = api.pawns.filter(p => !p.eliminated);
      if (left.length > 1) return;
      this.endRound(left[0] || null);
    },

    endRound(winner) {
      if (winner) winner.roundWins++;
      const champion = winner && winner.roundWins >= SKY.TUNING.game.roundsToWin;
      if (SKY.Net.online && SKY.Net.role === 'host') SKY.Net.hostRoundEnd(winner, champion);
      this.netRoundEnd(winner, champion);
    },

    /* display/state part of a round ending (host computes, clients replay) */
    netRoundEnd(winner, champion) {
      SKY.Demos.archiveRound(winner);          // match history (offline only)
      api.winner = winner;
      api.state = champion ? 'matchend' : 'roundend';
      api.restartT = champion ? 12 : SKY.TUNING.game.roundRestartDelay;
      const name = winner ? winner.name : 'Nobody';
      const rp = SKY.Net.online ? ''
        : ' · ' + SKY.Settings.bindName(SKY.Settings.data.binds.replay) + ' — replay';
      if (champion) {
        SKY.HUD.centerMsg(name + ' wins the match', 8, 40);
        SKY.HUD.subMsg('Enter — back to menu' + rp, 8);
      } else {
        const stars = winner ? ' · ' + '★'.repeat(winner.roundWins) + '☆'.repeat(SKY.TUNING.game.roundsToWin - winner.roundWins) : '';
        SKY.HUD.centerMsg(name + ' wins the round' + stars, 4.5, 36);
        SKY.HUD.subMsg('Next round in ' + SKY.TUNING.game.roundRestartDelay + 's — Enter to skip' + rp, 4.5);
      }
      SKY.SFX.win();
      SKY.Effects.celebrate(CENTER);
      SKY.HUD.showRespawn(null);
      api.lootChoices = null; api.lootOpen = false;
      SKY.HUD.hideLoot();
    },

    /* ---------------- per-render-frame: camera, HUD, audio ---------------- */
    renderTick(rdt) {
      const C = SKY.TUNING.camera;
      SKY.Map.tick(rdt, api.time);
      SKY.Effects.tick(rdt);
      SKY.Pickups.visualTick(rdt);
      SKY.Attract.tick(rdt);    // slow-mo menu show (self-gates on state)

      // crown prop
      if (crownMesh && api.mode === 'crown') {
        crownSpin += rdt * 2;
        const cp = api.crownPos();
        crownMesh.position.set(cp.x, cp.y + Math.sin(crownSpin * 1.4) * 0.12, cp.z);
        crownMesh.rotation.y = crownSpin;
        crownMesh.visible = api.state === 'playing' || api.state === 'countdown';
      }

      const p = api.player;
      const spectating = !p || api.state === 'menu' || api.state === 'roundend' ||
                         api.state === 'matchend' || (p && p.eliminated);

      if (spectating) {
        orbitA += rdt * 0.12;
        // menus orbit closer/lower so the attract-mode cast reads well
        const rad = api.state === 'menu' ? 26 : 34;
        const hgt = api.state === 'menu' ? 9 : 14;
        camera.position.set(Math.cos(orbitA) * rad, hgt, Math.sin(orbitA) * rad);
        camera.lookAt(CENTER);
        camera.fov = SKY.U.damp(camera.fov, 70, 4, rdt);
        camera.updateProjectionMatrix();
      } else if (p.alive) {
        p.eyePos(_eye).add(SKY.Effects.shakeOffset);
        camera.position.copy(_eye);
        camera.rotation.set(SKY.Input.pitch, SKY.Input.yaw, camRoll, 'YXZ');
        let rollTarget = -p.cmd.mx * C.strafeLean + (p.sliding ? C.slideRoll : 0);
        if (p.ragdoll) rollTarget += Math.sin(api.time * 9) * 0.12;   // dazed wobble
        camRoll = SKY.U.damp(camRoll, rollTarget, 10, rdt);

        const wDef = SKY.Weapons.defOf(p);
        const spd = p.speedH();
        let target;
        if (p.zoomed && wDef.zoomFov) {
          target = wDef.zoomFov;
          SKY.Input.sensMult = SKY.TUNING.input.zoomSensMult * (wDef.scope ? 0.55 : 1);
        } else {
          const k = SKY.U.clamp01((spd - C.fovSpeedMin) / (C.fovSpeedMax - C.fovSpeedMin));
          target = C.baseFov + k * C.speedFovBoost + SKY.Effects.getFovKick();
          SKY.Input.sensMult = 1;
        }
        camFov = SKY.U.damp(camFov, target, p.zoomed ? 16 : 8, rdt);
        camera.fov = camFov;
        camera.updateProjectionMatrix();
        SKY.HUD.scope(!!(p.zoomed && wDef.scope));
        SKY.Effects.ensureWeapon(p.weapon);
        SKY.Effects.setHands(!!p.grapple);   // rope out = hook-gun arm up
        const reloadFrac = p.reloadT > 0
          ? 1 - p.reloadT / (wDef.reloadTime * p.mods.cdMult) : -1;
        SKY.Effects.viewmodelMotion(rdt, spd, p.grounded, p.vel.y, p.sliding, reloadFrac);
      }
      // no gun / crosshair / combat HUD while in menus, dead or spectating
      const combat = !spectating && !!p && p.alive;
      SKY.Effects.setViewmodelVisible(combat);
      if (!combat) SKY.Effects.setHands(false);
      SKY.HUD.combat(combat);
      if (!combat) { SKY.Input.sensMult = 1; SKY.HUD.scope(false); }

      if (p && p.alive && api.state === 'playing' && !api.paused) {
        SKY.SFX.setWind(SKY.U.clamp01((p.speed3() - 8) / 16));
        SKY.SFX.setSlide(p.sliding);
      } else {
        SKY.SFX.setWind(0);
        SKY.SFX.setSlide(false);
      }

      SKY.Grapple.updateVisuals(api.pawns, camera);
      SKY.HUD.scoreboard(api.state !== 'menu' && SKY.Input.action('scoreboard'));
      SKY.HUD.update(rdt);
    },
  };

  function buildCrownMesh() {
    const g = new THREE.Group();
    const gold = new THREE.MeshLambertMaterial({ color: 0xffd34d, emissive: 0x8f6a10 });
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.22, 10, 1, true), gold);
    band.material.side = THREE.DoubleSide;
    g.add(band);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 6), gold);
      spike.position.set(Math.cos(a) * 0.33, 0.22, Math.sin(a) * 0.33);
      g.add(spike);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SKY.U.blobTexture(), color: 0xffd34d, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7,
    }));
    glow.scale.set(1.6, 1.6, 1);
    g.add(glow);
    scene.add(g);
    return g;
  }

  return api;
})();
