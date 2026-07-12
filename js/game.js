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
    ['Gustav', '#c39bff'], ['Peanut', '#ff9a3d'], ['Noodle', '#ff6a6a'],
    ['Biscuit', '#ffe066'], ['Squish', '#6affd8'], ['Turnip', '#b8ff6a'],
  ];
  // deathmatch: pickable loadout weapons + the bonus-weapon rotation order
  const DM_WEAPONS = ['blaster', 'scatter', 'smg', 'burst', 'longshot', 'magnum',
    'bouncer', 'piston', 'mega', 'lobber', 'boomstick', 'quad'];
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
    loadoutOpen: false,          // DEATHMATCH weapon menu (B)
    dmLoadout: null,             // the weapon you spawn with in dm
    dmBonusWeapon: null,         // rotating bonus weapon (extra points)
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
        SKY.SFX.music('game');
        api.startMatch(SKY.HUD.botCount, SKY.HUD.mapSel, SKY.HUD.modeSel, {
          rounds: SKY.HUD.roundsSel, lives: SKY.HUD.livesSel, crown: SKY.HUD.crownSel,
          sparks: SKY.HUD.sparkSel, dmMin: SKY.HUD.dmSel,
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
          if (api.loadoutOpen) return;           // DM loadout menu owns it too
          if (SKY.Net.online) {
            // ONLINE never pauses. ESC while ALIVE opens the in-match menu
            // (quit/settings — the game keeps running behind it); everything
            // else — alt-tab, dying, waiting to respawn — only shows the
            // small "click to play" hint. No surprise menus.
            if (document.hasFocus() && api.player && api.player.alive) SKY.HUD.setPause(true);
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
      if (rules.rounds) SKY.TUNING.game.roundsToWin = rules.rounds;
      if (mode === 'spark' || mode === 'dm') SKY.TUNING.game.roundsToWin = 1; // one long round
      if (rules.lives) SKY.TUNING.game.lives = rules.lives;
      if (rules.crown) SKY.TUNING.crown.holdToWin = rules.crown;
      if (rules.sparks) SKY.TUNING.spark.target = rules.sparks;
      if (rules.dmMin) SKY.TUNING.dm.timeLimit = rules.dmMin * 60;
    },

    /* ---------------- match / round setup ---------------- */
    startMatch(nBots, mapId, mode, rules) {
      SKY.Attract.stop();
      for (const p of api.pawns) p.dispose();
      api.pawns = []; api.bots = [];
      SKY.Weapons.clear(); SKY.Grenades.clear();
      api.mode = mode || 'lbs';
      this.applyRules(rules, api.mode);
      SKY.Map.load(scene, mapId || 'sky');

      const myName = (SKY.Settings.data.nickname || '').trim() || 'YOU';
      api.player = new SKY.Pawn({ name: myName, color: '#ffd34d', isLocal: true });
      api.player.buildVisual(scene);
      api.pawns.push(api.player);
      for (let i = 0; i < SKY.U.clamp(nBots, 1, 9); i++) {
        const p = new SKY.Pawn({ name: BOT_ROSTER[i % BOT_ROSTER.length][0], color: BOT_ROSTER[i % BOT_ROSTER.length][1] });
        p.isBot = true;
        p.buildVisual(scene);
        api.pawns.push(p);
        api.bots.push(new SKY.Bot(p));
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
      cfg.roster.forEach((r) => {
        const isLocal = r.id === cfg.myId;
        const p = new SKY.Pawn({ name: r.name, color: r.color, isLocal });
        p.netId = r.id;
        p.cos = r.cos || null;   // synced cosmetics: {char, fin:{kind:finishId}}
        p.isBot = !!r.bot;
        p.isRemote = !isLocal && !(amHost && r.bot);   // host simulates bots
        p.buildVisual(scene);
        api.pawns.push(p);
        if (isLocal) api.player = p;
        if (amHost && r.bot) api.bots.push(new SKY.Bot(p));
      });
      this._finishMatchSetup();
    },

    _finishMatchSetup() {
      if (crownMesh) { scene.remove(crownMesh); crownMesh = null; }
      if (api.mode === 'crown' || api.mode === 'spark') crownMesh = buildCrownMesh();
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
      SKY.Replay.wipe();                          // fresh clip buffer per round
      SKY.Pickups.clear();
      SKY.Sparks.clear();
      api.sparkFrenzy = false; api.lootT = undefined;
      SKY.Map.resetRound();                       // rebuild if overtime crumbled it
      api.overtime = false;
      api.roundNum++;
      const spawns = SKY.World.spawnPoints;
      api.pawns.forEach((p, i) => {
        p.lives = SKY.TUNING.game.lives;
        p.eliminated = false; p.alive = true; p.deadT = 0; p.koCount = 0;
        p.crownTime = 0;
        p.lastHitBy = null; p.lastHitT = -99;
        p.recentHits = []; p.dmStreak = 0;
        SKY.Grapple.release(p); p.grappleCd = 0; p.pbCd = 0; p.acCd = 0; p.dashCd = 0;
        p.tauntT = 0; p.zoomed = false;
        p.weapon = 'pistol'; p.deaths = 0;
        p.sparks = 0; p.sparkLevel = 0;
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
      SKY.HUD.roundBanner(null);
      SKY.Effects.ensureWeapon('pistol');
      api.crownHolder = null;
      api._crownFree.copy(SKY.World.crownHome || CENTER);
      api.winner = null;
      api.roundTime = 0;
      api.state = 'countdown';
      SKY.SFX.music('game');   // idempotent across rounds; covers net clients too
      api.countdownT = SKY.TUNING.game.countdown + 0.99;
      lastCdNum = -1;
      SKY.HUD.showRespawn(null);
      SKY.HUD.subMsg(api.mode === 'spark'
        ? 'First to ' + SKY.TUNING.spark.target + ' sparks — KOs drop the goods'
        : api.mode === 'dm'
        ? 'DEATHMATCH — most points in ' + Math.round(SKY.TUNING.dm.timeLimit / 60) +
          ' min wins · ' + SKY.Settings.bindName(SKY.Settings.data.binds.loadout) + ' — pick your weapon'
        : 'Round ' + api.roundNum + ' — first to ' + SKY.TUNING.game.roundsToWin + ' wins', 2.5);
      // DEATHMATCH loadouts: your pick sticks; bots grab something random
      api.dmBonusWeapon = null;
      if (api.mode === 'dm') {
        for (const p of api.pawns) {
          if (p.isRemote) continue;
          if (p.isLocal) { if (api.dmLoadout) p.giveWeapon(api.dmLoadout); }
          else p.giveWeapon(SKY.U.pick(DM_WEAPONS));
        }
      }
      // returning from an unlocked state (e.g. reward picker was open):
      // offline re-pauses; online NEVER pops a menu — just a click-to-play hint
      if (!fromMenu && !SKY.Input.locked) {
        if (!SKY.Net.online) {
          api.paused = true;
          SKY.HUD.setPause(true);
        } else {
          SKY.HUD.relockHint(true);
        }
      }
    },

    /* ---------------- SPARK RUSH ----------------
     * One long round. KOs burst into spark orbs; hoover them to score AND
     * level up live (pick 1 of 3 without pausing). Dying scatters part of
     * your bank where you last stood. First to the target — or richest at
     * the buzzer — wins. The leader wears the crown so everyone knows who
     * to hunt.
     * -------------------------------------------- */
    tickSpark(dt) {
      const C = SKY.TUNING.spark;
      SKY.Sparks.tick(dt);

      // the crown marks the leader (display only — can't be grabbed)
      let leader = null;
      for (const p of api.pawns) {
        if ((p.sparks || 0) > (leader ? leader.sparks : 0)) leader = p;
      }
      api.crownHolder = leader && leader.sparks > 0 ? leader : null;

      // level-ups: MY pawn crossing a threshold deals 3 live cards
      const me = api.player;
      if (me) {
        while (me.sparkLevel < C.levels.length && (me.sparks || 0) >= C.levels[me.sparkLevel]) {
          me.sparkLevel++;
          api.lootChoices = SKY.Loot.roll(me, me.sparkLevel);
          api.lootOpen = false;                   // no cursor — keys 1/2/3 only
          api.lootT = C.pickTime;
          SKY.HUD.showLevelUp(api.lootChoices, me.sparkLevel);
          SKY.SFX.crown();
        }
      }
      if (api.lootChoices && api.lootT !== undefined) {
        api.lootT -= dt;
        SKY.HUD.levelUpTimer(api.lootT / C.pickTime);
        if (api.lootT <= 0) this.pickLoot((Math.random() * api.lootChoices.length) | 0);
      }

      // host-simulated bots level up too (auto-pick)
      if (SKY.Net.authority) {
        for (const p of api.pawns) {
          if (p.isLocal || p.isRemote) continue;
          while (p.sparkLevel < C.levels.length && (p.sparks || 0) >= C.levels[p.sparkLevel]) {
            p.sparkLevel++;
            SKY.Loot.autoPick(p, p.sparkLevel);
          }
        }
      }

      if (!SKY.Net.authority) return;

      // frenzy: the final stretch mints double
      if (!api.sparkFrenzy && C.timeLimit - api.roundTime <= C.frenzyAt) {
        api.sparkFrenzy = true;
        SKY.HUD.centerMsg('FRENZY — double sparks', 2.2, 40);
        SKY.SFX.overtime();
      }
      // win: banked the target, or richest at the buzzer
      const rich = api.pawns.slice().sort((x, y) => (y.sparks || 0) - (x.sparks || 0))[0];
      if (rich && (rich.sparks || 0) >= C.target) return this.endRound(rich);
      if (api.roundTime >= C.timeLimit) return this.endRound(rich && rich.sparks > 0 ? rich : null);
    },

    toMenu() {
      if (SKY.Replay.active) SKY.Replay.close();
      SKY.Replay.wipe();
      SKY.Pickups.clear();
      SKY.Sparks.clear();
      for (const p of api.pawns) p.dispose();
      api.pawns = []; api.bots = []; api.player = null;
      SKY.Weapons.clear();
      if (crownMesh) { scene.remove(crownMesh); crownMesh = null; }
      api.state = 'menu';
      api.paused = false;
      api.lootChoices = null; api.lootOpen = false;
      api.loadoutOpen = false;
      SKY.HUD.hideLoot();
      SKY.HUD.hideLoadout();
      SKY.HUD.roundBanner(null);
      SKY.HUD.setPause(false);
      SKY.HUD.showMenu();
      SKY.SFX.music('menu');
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
      else if (SKY.Net.online && api.mode === 'spark') SKY.Net.sendLevelPick(item);
      api.lootChoices = null;
      api.lootOpen = false;
      api.lootT = undefined;
      if (api.mode === 'spark') SKY.HUD.hideLevelUp(i);
      else { SKY.HUD.hideLoot(i); SKY.Input.requestLock(); }
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
        const skip = SKY.Input.consumePressed('Enter');
        if (api.state === 'matchend') {
          // match over: frozen arena + orbit cam, then back to the menu
          SKY.Weapons.tick(dt, api.pawns);
          for (const p of api.pawns) p.visualTick(dt);
          if (!SKY.Net.authority) return;           // clients wait for the host
          if (api.restartT <= 0 || skip) {
            if (SKY.Net.online) { api.toMenu(); SKY.Net.hostToLobby(); }
            else api.toMenu();
          }
          return;
        }
        // ROUND end is CS:GO style: a banner counts down up top while the
        // arena stays fully live below — survivors keep running around.
        SKY.HUD.roundBannerTime(api.restartT);
        if (SKY.Net.authority && (api.restartT <= 0 || skip)) {
          if (SKY.Net.online) SKY.Net.hostNewRound();
          api.startRound();
          return;
        }
        // no return: fall through into the live simulation below
      }

      /* ================= state: playing (and live roundend) ================= */
      if (api.state === 'playing') api.roundTime += dt;   // clock freezes at round end
      if (api.mode === 'spark' && api.state === 'playing') this.tickSpark(dt);
      if (api.mode === 'dm' && api.state === 'playing') this.tickDm(dt);

      // OVERTIME: arena starts working against you (host decides; not in spark)
      if (SKY.Net.authority && api.state === 'playing' &&
          api.mode !== 'spark' && !api.overtime &&
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
          // during the round-end banner falls don't score — just respawn
          if (p.alive && p.pos.y < SKY.World.killY) {
            if (api.state === 'playing') this.handleKO(p);
            else this.respawn(p);
            continue;
          }
          if (!p.alive && !p.eliminated) {
            p.deadT -= dt;
            // spark mode never blocks respawns on card picks (they're live)
            const waiting = api.mode !== 'spark' &&
                            ((p.isLocal && api.lootChoices) ||
                             (SKY.Net.online && p.isRemote && SKY.Net.hostWaitingLoot(p)));
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
      if (api.mode === 'lbs' && SKY.Net.authority && api.state === 'playing') this.checkWin();
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

    /* ---------------- DEATHMATCH ----------------
     * One timed round. KOs = points, assists = fewer points, KOs with the
     * ROTATING bonus weapon = extra (deterministic rotation from the shared
     * round clock — no net messages needed). Leader wears the crown.
     * -------------------------------------------- */
    tickDm(dt) {
      const C = SKY.TUNING.dm;
      // rotating bonus weapon (fixed order, driven by the synced clock)
      const w = DM_WEAPONS[Math.floor(api.roundTime / C.bonusEvery) % DM_WEAPONS.length];
      if (w !== api.dmBonusWeapon) {
        const announce = api.dmBonusWeapon !== null;
        api.dmBonusWeapon = w;
        if (announce) {
          SKY.HUD.subMsg('Bonus weapon: ' + w.toUpperCase() + ' (+' + C.bonusPts + ' per KO)', 2.5);
          SKY.SFX.crown();
        }
      }
      // the crown marks the point leader
      let leader = null;
      for (const p of api.pawns) {
        if ((p.sparks || 0) > (leader ? leader.sparks : 0)) leader = p;
      }
      api.crownHolder = leader && leader.sparks > 0 ? leader : null;
      // buzzer: most points wins the match
      if (SKY.Net.authority && api.roundTime >= C.timeLimit) {
        const rich = api.pawns.slice().sort((x, y) => (y.sparks || 0) - (x.sparks || 0))[0];
        this.endRound(rich && (rich.sparks || 0) > 0 ? rich : null);
      }
    },

    /* loadout menu (B in deathmatch): pick any weapon, keep it every spawn */
    pickLoadout(kind) {
      api.dmLoadout = kind;
      api.loadoutOpen = false;
      SKY.HUD.hideLoadout();
      if (api.player && api.player.alive) api.player.giveWeapon(kind);
      SKY.Input.requestLock();
    },
    toggleLoadout() {
      if (api.mode !== 'dm' || !api.player) return;
      if (api.loadoutOpen) {
        api.loadoutOpen = false;
        SKY.HUD.hideLoadout();
        SKY.Input.requestLock();
      } else {
        api.loadoutOpen = true;
        SKY.HUD.showLoadout(DM_WEAPONS, api.dmLoadout, (k) => api.pickLoadout(k));
        if (document.pointerLockElement) document.exitPointerLock();
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
      // (blocked while reward / level-up cards own the number keys)
      if (!api.lootChoices) {
        if (In.consumePressed('Digit1')) p.switchSlot(1);
        if (In.consumePressed('Digit2')) p.switchSlot(2);
        const wd = In.takeWheel();
        if (wd) p.switchSlot(p.activeSlot === 1 ? 2 : 1);
      }

      p.zoomed = In.action('aim') && !p.ragdoll && !p.grapple;

      const Wd = SKY.Weapons.defOf(p);
      if (Wd.charge) {
        // piston-style: hold to compress, release to launch
        if (In.action('fire')) SKY.Weapons.chargeTick(p, 1 / 120);
        else if (p.chargeT > 0) SKY.Weapons.releaseCharge(p);
      } else if (Wd.auto ? In.action('fire') : In.actionPressed('fire')) {
        SKY.Weapons.tryFirePrimary(p);
      }
      if (In.actionPressed('cannon')) SKY.Weapons.tryFireAirCannon(p, api.pawns);
      if (In.actionPressed('grapple')) {
        // next to a door and facing it, the key is USE; otherwise grapple
        if (!SKY.Map.tryInteract(p)) SKY.Grapple.tryFire(p);
      }
      if (In.actionPressed('grenade')) SKY.Grenades.throwNade(p);
      if (In.actionPressed('loadout')) this.toggleLoadout();
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
      if (!pawn.alive) return;   // can't die twice without a respawn between
      pawn.deaths++;
      if (api.mode !== 'crown' && api.mode !== 'spark' && api.mode !== 'dm') pawn.lives--;
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

      if (api.mode === 'dm') {
        const C = SKY.TUNING.dm;
        if (killer) {
          let pts = C.koPts;
          if (killer.weapon === api.dmBonusWeapon) {
            pts += C.bonusPts;
            SKY.HUD.killFeed('<b>' + killer.name + '</b> bonus weapon +' + C.bonusPts);
          }
          killer.dmStreak = (killer.dmStreak || 0) + 1;
          if (killer.dmStreak % C.streakEvery === 0) {
            pts += C.streakPts;
            SKY.HUD.killFeed('<b>' + killer.name + '</b> is on a ' + killer.dmStreak + '-streak +' + C.streakPts);
          }
          killer.sparks = (killer.sparks || 0) + pts;
          // assist: the most recent OTHER hitter inside the credit window
          const rh = pawn.recentHits || [];
          for (let i = rh.length - 1; i >= 0; i--) {
            const h = rh[i];
            if (h.by === killer || h.by.eliminated) continue;
            if (api.time - h.t > G.koCreditWindow) break;
            h.by.sparks = (h.by.sparks || 0) + C.assistPts;
            SKY.HUD.killFeed('<b>' + h.by.name + '</b> assist +' + C.assistPts);
            break;
          }
        }
        pawn.dmStreak = 0;
        if (pawn.recentHits) pawn.recentHits.length = 0;
        pawn.deadT = C.respawnDelay;
        if (pawn.isLocal) SKY.HUD.showRespawn('Respawning…');
        if (SKY.Net.online && SKY.Net.role === 'host') SKY.Net.hostKo(pawn, line, killer);
        return;
      }
      if (api.mode === 'spark') {
        // the piñata moment: part of the bank + a KO bonus scatters where
        // the victim last stood — chase the gold, mind the ledge
        const C = SKY.TUNING.spark;
        pawn.deadT = C.respawnDelay;
        const drop = Math.floor((pawn.sparks || 0) * C.dropFrac);
        pawn.sparks = (pawn.sparks || 0) - drop;
        const mint = Math.min(14, drop + C.koMint * (api.sparkFrenzy ? 2 : 1));
        const at = pawn.lastGroundPos || SKY.World.roamPoints[0] || pawn.pos;
        SKY.Sparks.mint(mint, at);
        if (pawn.isLocal) SKY.HUD.showRespawn('Respawning…');
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
        SKY.HUD.roundBanner(null);
        // LOCKER coins: participation + KOs + win bonus (local, cosmetic-only)
        let payline = '';
        if (api.player && SKY.Profile) {
          const payout = SKY.Profile.matchReward(winner === api.player, api.player.koCount || 0);
          payline = ' · +' + payout + ' ⬡';
        }
        SKY.HUD.centerMsg(name + ' wins the match', 8, 40);
        SKY.HUD.subMsg('Enter — back to menu' + rp + payline, 8);
      } else {
        // CS:GO-style banner up top; the arena stays live underneath
        const stars = winner
          ? '★'.repeat(winner.roundWins) + '☆'.repeat(Math.max(0, SKY.TUNING.game.roundsToWin - winner.roundWins))
          : '';
        const extra = (SKY.Net.authority ? ' · Enter to skip' : '') + rp;
        SKY.HUD.roundBanner(name, winner ? winner.color : '', stars,
          SKY.TUNING.game.roundRestartDelay, extra);
      }
      SKY.SFX.win();
      SKY.Effects.celebrate(CENTER);
      SKY.HUD.showRespawn(null);
      api.lootChoices = null; api.lootOpen = false;
      api.loadoutOpen = false;
      SKY.HUD.hideLoot();
      SKY.HUD.hideLoadout();
    },

    /* ---------------- per-render-frame: camera, HUD, audio ---------------- */
    renderTick(rdt) {
      const C = SKY.TUNING.camera;
      SKY.Map.tick(rdt, api.time);
      SKY.Effects.tick(rdt);
      SKY.Pickups.visualTick(rdt);
      SKY.Sparks.visualTick(rdt);
      SKY.Attract.tick(rdt);    // slow-mo menu show (self-gates on state)

      // crown prop (crown rush: the objective; spark rush: marks the leader)
      if (crownMesh && (api.mode === 'crown' || api.mode === 'spark' || api.mode === 'dm')) {
        crownSpin += rdt * 2;
        const cp = api.crownPos();
        crownMesh.position.set(cp.x, cp.y + Math.sin(crownSpin * 1.4) * 0.12, cp.z);
        crownMesh.rotation.y = crownSpin;
        crownMesh.visible = (api.state === 'playing' || api.state === 'countdown') &&
          (api.mode !== 'spark' || !!api.crownHolder);
      }

      const p = api.player;
      // roundend is NOT spectating anymore: the banner plays over live gameplay
      const spectating = !p || api.state === 'menu' ||
                         api.state === 'matchend' || (p && p.eliminated);

      if (spectating) {
        // the LOBBY stage owns the camera while a lineup is up
        if (!(SKY.Attract.lobbyCam && SKY.Attract.lobbyCam(camera, rdt))) {
          orbitA += rdt * 0.12;
          // menus orbit closer/lower so the attract-mode cast reads well
          const rad = api.state === 'menu' ? 26 : 34;
          const hgt = api.state === 'menu' ? 9 : 14;
          camera.position.set(Math.cos(orbitA) * rad, hgt, Math.sin(orbitA) * rad);
          camera.lookAt(CENTER);
          camera.fov = SKY.U.damp(camera.fov, 70, 4, rdt);
        }
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
      SKY.Effects.speedLines(rdt, combat ? p.speed3() : 0, !combat || p.grounded);
      SKY.Effects.setViewmodelVisible(combat);
      if (!combat) SKY.Effects.setHands(false);
      SKY.HUD.combat(combat);
      if (!combat) { SKY.Input.sensMult = 1; SKY.HUD.scope(false); }

      if (p && p.alive && (api.state === 'playing' || api.state === 'roundend') && !api.paused) {
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
