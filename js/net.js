/* =============================================================================
 * SKY PUSH — multiplayer (PeerJS / WebRTC, serverless)
 * Star topology: the HOST is authoritative for rules (lives, KOs, respawns,
 * rounds, crown, overtime, map events, loot) and relays state. Every client
 * simulates its OWN movement + bullets and streams position @20 Hz; remote
 * pawns are interpolated. Shooters report hits; the host arbitrates.
 *
 * Lobbies:
 *   private  -> random 4-letter code (peer id "skypush-priv-XXXX")
 *   public   -> claims a well-known slot "skypush-pub-1..6"
 *   quick    -> probes the public slots in order, joins the first that
 *               answers, or hosts a fresh public lobby if none exist.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Net = (function () {
  const PREFIX = 'skypush';
  const PUB_SLOTS = 6;
  const COLORS = ['#ffd34d', '#ff5db1', '#40c8ff', '#7dff9e', '#c39bff', '#ff9a3d'];
  const MAX_PLAYERS = 6;

  const api = {
    online: false,
    role: null,            // 'host' | 'client'
    myId: null,
    code: null,
    isPublic: false,
    roster: [],            // [{id, name, color, bot}]
    settings: { map: 'sky', mode: 'lbs', fillBots: true, rounds: 2, lives: 3, crown: 25 },
    inGame: false,
  };

  let peer = null;
  const conns = new Map();   // host: peerId -> conn
  let hostConn = null;       // client: conn to host
  let sendTimer = null;
  let pingTimer = null;
  const lastStates = new Map();  // host: peerId -> state array
  const pendingLoot = new Map(); // host: pawnId -> true (waiting for pick)
  const pings = {};              // id -> ms (host-collected, broadcast to all)
  const _v = new THREE.Vector3();

  const $ = (id) => document.getElementById(id);
  function status(msg) { const el = $('mp-status'); if (el) el.textContent = msg || ''; }

  function randCode(n) {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }

  function nickname() {
    return (SKY.Settings.data.nickname || '').trim() || 'BEAN-' + randCode(3);
  }

  function destroyPeer() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (peer) { const old = peer; peer = null; try { old.destroy(); } catch (e) {} }
    conns.clear(); hostConn = null;
    lastStates.clear(); pendingLoot.clear();
    for (const k of Object.keys(pings)) delete pings[k];
    api.online = false; api.role = null; api.code = null; api.roster = [];
    api.inGame = false;
  }

  /* PeerJS drops its signaling socket now and then ('network'); reconnect
     quietly instead of surfacing an error — data channels keep working. */
  function attachRecovery(p) {
    p.on('disconnected', () => {
      if (peer !== p) return;
      try { p.reconnect(); } catch (e) {}
    });
  }

  /* ===================== hosting ===================== */
  function host(isPublic, slot, forcedCode) {
    destroyPeer();
    const code = forcedCode ? 'priv-' + forcedCode
      : isPublic ? 'pub-' + (slot || 1) : 'priv-' + randCode(4);
    status('Creating lobby…');
    const p = peer = new Peer(PREFIX + '-' + code);
    attachRecovery(p);
    p.on('open', () => {
      if (peer !== p) return;
      api.online = true; api.role = 'host'; api.code = code; api.isPublic = isPublic;
      api.myId = 'host';
      api.roster = [{ id: 'host', name: nickname(), color: COLORS[0] }];
      pings.host = 0;
      showLobby();
      status('');
      startStream();
      startPing();
    });
    p.on('error', (err) => {
      if (peer !== p) return;                    // stale peer, ignore
      if (err.type === 'network') {              // signaling blip — recover
        try { p.reconnect(); } catch (e) {}
        return;
      }
      if (err.type === 'unavailable-id' && isPublic && (slot || 1) < PUB_SLOTS) {
        host(true, (slot || 1) + 1);            // slot taken, try the next
      } else if (err.type === 'unavailable-id') {
        host(isPublic, 1);                       // regenerate private code
      } else if (err.type !== 'peer-unavailable') {
        status('Connection error: ' + err.type);
        destroyPeer();
      }
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => { /* wait for hello */ });
      conn.on('data', (m) => onHostMessage(conn, m));
      conn.on('close', () => dropClient(conn));
      conn.on('error', () => dropClient(conn));
    });
  }

  function dropClient(conn) {
    const id = conn.__id;
    if (!id || !conns.has(id)) return;
    conns.delete(id);
    lastStates.delete(id);
    api.roster = api.roster.filter(r => r.id !== id);
    broadcast({ t: 'roster', roster: api.roster });
    renderLobby();
    if (api.inGame) {
      const pawn = SKY.Game.pawns.find(p => p.netId === id);
      if (pawn) { pawn.eliminated = true; pawn.alive = false; }
      SKY.HUD.killFeed('<b>' + (conn.__name || 'player') + '</b> disconnected');
      broadcast({ t: 'gone', id });
    }
  }

  function onHostMessage(conn, m) {
    switch (m.t) {
      case 'hello': {
        if (api.roster.filter(r => !r.bot).length >= MAX_PLAYERS || api.inGame) {
          conn.send({ t: 'full' });
          setTimeout(() => conn.close(), 300);
          return;
        }
        const id = 'p' + randCode(4);
        conn.__id = id; conn.__name = m.name;
        conns.set(id, conn);
        api.roster.push({ id, name: m.name, color: COLORS[api.roster.length % COLORS.length] });
        conn.send({ t: 'welcome', you: id, roster: api.roster, settings: api.settings });
        broadcast({ t: 'roster', roster: api.roster }, id);
        renderLobby();
        break;
      }
      case 'state': lastStates.set(conn.__id, m.s); break;
      case 'pong': pings[conn.__id] = Math.round(performance.now() - m.ts); break;
      case 'hit': routeHit(m); break;
      case 'fire': broadcast(m, conn.__id); onFire(m); break;
      case 'nade': broadcast(m, conn.__id); onNade(m); break;
      case 'taunt': broadcast(m, conn.__id); onTaunt(m); break;
      case 'query':   // server-browser probe
        conn.send({
          t: 'info',
          players: api.roster.filter(r => !r.bot).length,
          cap: MAX_PLAYERS,
          map: api.settings.map, mode: api.settings.mode,
          inGame: api.inGame,
        });
        setTimeout(() => { try { conn.close(); } catch (e) {} }, 800);
        break;
      case 'buy': {   // bomb-mode purchase (host validates)
        const pawn = SKY.Game.pawns.find(p => p.netId === conn.__id);
        if (!pawn || SKY.Game.mode !== 'bomb' || !SKY.Game.bomb || SKY.Game.bomb.phase !== 'freeze') break;
        const isNade = !!SKY.TUNING.grenades[m.id];
        const price = isNade ? SKY.TUNING.grenades[m.id].price : SKY.TUNING.prices[m.id];
        if (price === undefined || pawn.money < price) break;
        pawn.money -= price;
        if (isNade) pawn.nades = { type: m.id, count: (pawn.nades && pawn.nades.type === m.id ? pawn.nades.count : 0) + 2 };
        else { pawn.weapon = m.id; pawn.ammo = SKY.TUNING.weapons[m.id].mag; }
        conn.send({ t: 'bought', id: m.id, isNade, money: pawn.money });
        break;
      }
      case 'pick': {
        const pawn = SKY.Game.pawns.find(p => p.netId === m.id);
        if (pawn && pendingLoot.has(m.id)) {
          pendingLoot.delete(m.id);
          const item = SKY.Loot.ITEMS.find(it => it.id === m.item);
          if (item) SKY.Loot.apply(pawn, item);
          broadcast({ t: 'loadout', id: m.id, item: m.item }, conn.__id);
        }
        break;
      }
    }
  }

  /* ===================== joining ===================== */
  function join(code, onFail) {
    destroyPeer();
    status('Joining ' + code + '…');
    const p = peer = new Peer();   // anonymous id
    attachRecovery(p);
    let opened = false;
    p.on('open', () => {
      if (peer !== p) return;
      const conn = p.connect(PREFIX + '-' + code, { reliable: true });
      const fail = (why) => { if (!opened) { destroyPeer(); onFail ? onFail(why) : status(why); } };
      const timeout = setTimeout(() => fail('No lobby found for that code.'), 4500);
      conn.on('open', () => {
        conn.send({ t: 'hello', name: nickname() });
      });
      conn.on('data', (m) => {
        if (m.t === 'welcome') {
          clearTimeout(timeout);
          opened = true;
          hostConn = conn;
          api.online = true; api.role = 'client'; api.code = code;
          api.myId = m.you;
          api.roster = m.roster;
          api.settings = m.settings;
          SKY.Game.previewMap(api.settings.map);
          showLobby();
          status('');
          startStream();
          startPing();
        } else if (m.t === 'full') {
          clearTimeout(timeout);
          fail('That lobby is full or already playing.');
        } else {
          onClientMessage(m);
        }
      });
      conn.on('close', () => { if (opened) leaveWithMessage('Host left the game.'); else fail('No lobby found for that code.'); });
      conn.on('error', () => fail('Could not reach that lobby.'));
    });
    p.on('error', (err) => {
      if (peer !== p) return;                    // stale peer, ignore
      if (err.type === 'network') { try { p.reconnect(); } catch (e) {} return; }
      if (err.type === 'peer-unavailable') { if (!opened) { destroyPeer(); onFail ? onFail('none') : status('No lobby found for that code.'); } }
      else if (!opened) { destroyPeer(); onFail ? onFail(err.type) : status('Connection error: ' + err.type); }
    });
  }

  function quickJoin(slot) {
    slot = slot || 1;
    if (slot > PUB_SLOTS) { status('No public lobbies — creating one!'); host(true, 1); return; }
    status('Searching public lobbies… (' + slot + '/' + PUB_SLOTS + ')');
    join('pub-' + slot, () => quickJoin(slot + 1));
  }

  function leaveWithMessage(msg) {
    destroyPeer();
    SKY.Game.toMenu();
    showOnlineHome();
    status(msg || '');
  }

  /* ===================== client messages ===================== */
  function onClientMessage(m) {
    const G = SKY.Game;
    switch (m.t) {
      case 'ping': if (hostConn && hostConn.open) hostConn.send({ t: 'pong', ts: m.ts }); break;
      case 'roster': api.roster = m.roster; renderLobby(); break;
      case 'settings':
        api.settings = m.settings;
        SKY.Game.previewMap(api.settings.map);
        renderLobby();
        break;
      case 'start': startGameLocal(m); break;
      case 'states': applyStates(m); break;
      case 'fire': onFire(m); break;
      case 'nade': onNade(m); break;
      case 'taunt': onTaunt(m); break;
      case 'bought': {   // my bomb-mode purchase confirmed
        const p = G.player;
        if (!p) break;
        p.money = m.money;
        if (m.isNade) p.nades = { type: m.id, count: (p.nades && p.nades.type === m.id ? p.nades.count : 0) + 2 };
        else { p.weapon = m.id; p.ammo = SKY.TUNING.weapons[m.id].mag; p.reloadT = 0; }
        SKY.SFX.cash();
        if (SKY.HUD.refreshBuyMenu) SKY.HUD.refreshBuyMenu();
        break;
      }
      case 'bround': {
        SKY.Demos.archiveRound({ name: m.team === 'atk' ? 'Attackers' : 'Defenders' });
        G.bombScore = m.score;
        if (G.bomb) { G.bomb.phase = 'post'; G.bomb.t = 4; }
        if (G.player) G.player.money = m.myMoney !== undefined ? m.myMoney : G.player.money;
        SKY.HUD.centerMsg(m.team === 'atk' ? 'Attackers win' : 'Defenders win', 3, 36);
        SKY.HUD.subMsg(m.reason + ' · ATK ' + m.score.atk + ' — ' + m.score.def + ' DEF', 4);
        SKY.SFX.win();
        break;
      }
      case 'hitApply': {
        const me = G.player;
        if (me && me.alive) {
          _v.set(m.imp[0], m.imp[1], m.imp[2]);
          me.applyKnockback(_v, null);
          if (m.head) me.enterRagdoll(me.grounded ? 'head' : 'air', _v);
          else if (!me.grounded && _v.length() > SKY.TUNING.ragdoll.minAirForce) me.enterRagdoll('air', _v);
          SKY.Effects.shake(SKY.TUNING.camera.shakeHitTaken);
        }
        break;
      }
      case 'ko': {
        const pawn = G.pawns.find(p => p.netId === m.id);
        if (!pawn) break;
        pawn.alive = false;
        pawn.lives = m.lives;
        pawn.eliminated = !!m.elim;
        if (m.killer) {
          const k = G.pawns.find(p => p.netId === m.killer);
          if (k) k.koCount = m.killerKos;
        }
        SKY.HUD.killFeed(m.line);
        SKY.SFX.ko(pawn.isLocal);
        if (pawn.isLocal) {
          if (m.elim) SKY.HUD.showRespawn('☠ ELIMINATED — spectating the chaos');
          else SKY.HUD.showRespawn('💀 YEETED! Pick a reward…');
        }
        break;
      }
      case 'loot': {
        const items = m.choices.map(id => SKY.Loot.ITEMS.find(it => it.id === id)).filter(Boolean);
        G.lootChoices = items;
        G.lootOpen = true;
        SKY.HUD.showLoot(items, (i) => {
          const item = items[i];
          if (!item) return;
          SKY.Loot.apply(G.player, item);
          send({ t: 'pick', id: api.myId, item: item.id });
          G.lootChoices = null; G.lootOpen = false;
          SKY.HUD.hideLoot(i);
          SKY.Input.requestLock();
        });
        if (document.pointerLockElement) document.exitPointerLock();
        break;
      }
      case 'loadout': {
        const pawn = G.pawns.find(p => p.netId === m.id);
        const item = SKY.Loot.ITEMS.find(it => it.id === m.item);
        if (pawn && item) SKY.Loot.apply(pawn, item);
        break;
      }
      case 'respawn': {
        const pawn = G.pawns.find(p => p.netId === m.id);
        if (!pawn) break;
        pawn.teleport(_v.set(m.pos[0], m.pos[1], m.pos[2]), m.yaw);
        pawn.alive = true;
        SKY.Effects.respawnBeam(_v, pawn.color);
        if (pawn.isLocal) SKY.HUD.showRespawn(null);
        break;
      }
      case 'overtime':
        G.overtime = true;
        SKY.Map.startOvertime();
        SKY.HUD.centerMsg('OVERTIME!', 2.2, 64);
        SKY.HUD.subMsg(SKY.Map.overtimeMsg(), 3);
        SKY.SFX.overtime();
        break;
      case 'mapevent': SKY.Map.execEvent(m.params); break;
      case 'roundend': {
        const w = G.pawns.find(p => p.netId === m.winner);
        if (w) w.roundWins = m.wins;
        G.netRoundEnd(w, m.champion);
        break;
      }
      case 'newround': G.startRound(); break;
      case 'tolobby': G.toMenu(); showLobby(); break;
      case 'gone': {
        const pawn = G.pawns.find(p => p.netId === m.id);
        if (pawn) { pawn.eliminated = true; pawn.alive = false; }
        break;
      }
    }
  }

  /* ===================== shared events ===================== */
  function onFire(m) {
    const pawn = SKY.Game.pawns.find(p => p.netId === m.id);
    if (pawn) SKY.Weapons.spawnRemote(pawn, m);
  }
  function onNade(m) {
    const pawn = SKY.Game.pawns.find(p => p.netId === m.id);
    if (pawn) SKY.Grenades.spawnRemote(pawn, m);
  }
  function onTaunt(m) {
    const pawn = SKY.Game.pawns.find(p => p.netId === m.id);
    if (pawn && pawn.avatar) { pawn.tauntT = 1.25; pawn.avatar.playEmote(); }
  }
  function routeHit(m) {
    // host: record credit, then apply locally or forward to the victim's client
    const G = SKY.Game;
    const victim = G.pawns.find(p => p.netId === m.victim);
    const shooter = G.pawns.find(p => p.netId === m.by);
    if (!victim || !victim.alive) return;
    victim.lastHitBy = shooter || null;
    victim.lastHitT = G.time;
    if (!victim.isRemote) {
      _v.set(m.imp[0], m.imp[1], m.imp[2]);
      victim.applyKnockback(_v, shooter);
      if (m.head) victim.enterRagdoll(victim.grounded ? 'head' : 'air', _v);
      else if (!victim.grounded && _v.length() > SKY.TUNING.ragdoll.minAirForce) victim.enterRagdoll('air', _v);
    } else {
      const conn = conns.get(m.victim);
      if (conn) conn.send({ t: 'hitApply', imp: m.imp, head: m.head, by: m.by });
    }
  }

  /* ===================== game start ===================== */
  function buildRoster() {
    const roster = api.roster.filter(r => !r.bot);
    if (api.settings.fillBots) {
      const names = ['Bloop', 'Zippy', 'Wobble', 'Gustav', 'Peanut', 'Momo', 'Taco'];
      const target = api.settings.mode === 'bomb' ? SKY.TUNING.bomb.teamSize * 2 : 4;
      let n = 0;
      while (roster.length < target && n < names.length) {
        roster.push({ id: 'bot' + n, name: names[n], color: COLORS[roster.length % COLORS.length], bot: true });
        n++;
      }
    }
    return roster;
  }

  function hostStart() {
    const roster = buildRoster();
    api.roster = roster;
    api.inGame = true;
    const rules = { rounds: api.settings.rounds, lives: api.settings.lives, crown: api.settings.crown };
    broadcast({ t: 'start', roster, map: api.settings.map, mode: api.settings.mode, rules });
    startGameLocal({ roster, map: api.settings.map, mode: api.settings.mode, rules });
  }

  function startGameLocal(m) {
    api.roster = m.roster;
    api.inGame = true;
    hideLobby();
    SKY.Game.applyRules(m.rules, m.mode);   // host-picked match rules
    SKY.Game.startMatchNet({ roster: m.roster, mapId: m.map, mode: m.mode, myId: api.myId });
    SKY.Input.requestLock();
  }

  /* ===================== state streaming ===================== */
  function packPawn(p) {
    let flags = 0;
    if (p.grounded) flags |= 1;
    if (p.sliding) flags |= 2;
    if (p.ragdoll) flags |= 4;
    if (p.crouching) flags |= 8;
    if (p.alive) flags |= 16;
    if (p._acting) flags |= 32;   // bomb-mode plant/defuse hold
    return [p.netId,
      +p.pos.x.toFixed(2), +p.pos.y.toFixed(2), +p.pos.z.toFixed(2),
      +p.vel.x.toFixed(2), +p.vel.y.toFixed(2), +p.vel.z.toFixed(2),
      +p.yaw.toFixed(3), +p.pitch.toFixed(3), flags, p.weapon];
  }

  function startPing() {
    if (pingTimer) clearInterval(pingTimer);
    if (api.role !== 'host') return;
    pingTimer = setInterval(() => {
      broadcast({ t: 'ping', ts: performance.now() });
    }, 2000);
  }

  function startStream() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = setInterval(() => {
      if (!api.online || !api.inGame) return;
      const G = SKY.Game;
      if (api.role === 'client') {
        if (G.player && hostConn && hostConn.open) {
          hostConn.send({ t: 'state', s: packPawn(G.player) });
        }
      } else {
        // host: own pawn + bots + relayed client states
        const list = [];
        for (const p of G.pawns) {
          if (!p.isRemote) list.push(packPawn(p));
          else if (lastStates.has(p.netId)) list.push(lastStates.get(p.netId));
        }
        broadcast({
          t: 'states', list, pings,
          rt: +G.roundTime.toFixed(2), gt: +G.time.toFixed(2),
          crown: G.crownHolder ? [G.crownHolder.netId, +G.crownHolder.crownTime.toFixed(1)] : null,
          bomb: (G.mode === 'bomb' && G.bomb) ? {
            ph: G.bomb.phase, t: +G.bomb.t.toFixed(1),
            planted: G.bomb.planted, timer: +G.bomb.timer.toFixed(1),
            carrier: G.bomb.carrier ? G.bomb.carrier.netId : null,
            pos: G.bomb.pos ? [+G.bomb.pos.x.toFixed(1), +G.bomb.pos.y.toFixed(1), +G.bomb.pos.z.toFixed(1)] : null,
            prog: +G.bomb.prog.toFixed(2), dprog: +G.bomb.dprog.toFixed(2),
            score: G.bombScore,
          } : null,
        });
        // host applies client states to its own copies immediately
        applyStates({ list, rt: G.roundTime, gt: G.time, crown: null, hostSelf: true });
      }
    }, 50);
  }

  function applyStates(m) {
    const G = SKY.Game;
    for (const s of m.list) {
      const pawn = G.pawns.find(p => p.netId === s[0]);
      if (!pawn || !pawn.isRemote) continue;
      pawn.netTarget = {
        x: s[1], y: s[2], z: s[3], vx: s[4], vy: s[5], vz: s[6],
        yaw: s[7], pitch: s[8], flags: s[9], weapon: s[10], age: 0,
      };
    }
    if (api.role === 'client' && !m.hostSelf) {
      if (m.pings) Object.assign(pings, m.pings);
      if (m.bomb && G.mode === 'bomb') {
        if (!G.bomb) G.bomb = { prog: 0, dprog: 0, beepT: 0 };
        G.bomb.phase = m.bomb.ph; G.bomb.t = m.bomb.t;
        G.bomb.planted = m.bomb.planted; G.bomb.timer = m.bomb.timer;
        G.bomb.carrier = m.bomb.carrier ? G.pawns.find(p => p.netId === m.bomb.carrier) : null;
        G.bomb.pos = m.bomb.pos ? new THREE.Vector3(m.bomb.pos[0], m.bomb.pos[1], m.bomb.pos[2]) : null;
        G.bomb.prog = m.bomb.prog; G.bomb.dprog = m.bomb.dprog;
        G.bombScore = m.bomb.score;
      }
      G.roundTime = m.rt;
      G.time += (m.gt - G.time) * 0.1;   // ease clocks together (movers sync)
      if (m.crown) {
        const holder = G.pawns.find(p => p.netId === m.crown[0]);
        G.crownHolder = holder || null;
        if (holder) holder.crownTime = m.crown[1];
      } else G.crownHolder = null;
    }
  }

  /* interpolate a remote pawn toward its latest snapshot (call at tick rate) */
  function lerpPawn(p, dt) {
    const t = p.netTarget;
    if (!t) return;
    t.age += dt;
    _v.set(t.x + t.vx * t.age, t.y + t.vy * t.age, t.z + t.vz * t.age);
    if (p.pos.distanceTo(_v) > 5) p.pos.copy(_v);
    else p.pos.lerp(_v, Math.min(1, 14 * dt));
    p.vel.set(t.vx, t.vy, t.vz);
    p.yaw += SKY.U.angDelta(p.yaw, t.yaw) * Math.min(1, 14 * dt);
    p.pitch = t.pitch;
    p.cmd.yaw = p.yaw;
    p.grounded = !!(t.flags & 1);
    p.sliding = !!(t.flags & 2);
    p.crouching = !!(t.flags & 8);
    p.height = (p.crouching || p.sliding) ? SKY.TUNING.move.crouchHeight : SKY.TUNING.move.standHeight;
    p.weapon = t.weapon;
    p._acting = !!(t.flags & 32);
    const rag = !!(t.flags & 4);
    if (rag && !p.ragdoll) p.ragdoll = { mode: 'air', t: 0 };
    else if (!rag && p.ragdoll) p.ragdoll = null;
  }

  /* ===================== send helpers ===================== */
  function send(msg) {
    if (api.role === 'client') { if (hostConn && hostConn.open) hostConn.send(msg); }
    else broadcast(msg);
  }
  function broadcast(msg, exceptId) {
    for (const [id, c] of conns) {
      if (id !== exceptId && c.open) c.send(msg);
    }
  }

  /* ===================== lobby / online UI ===================== */
  function showOnlineHome() {
    $('mp-home').classList.remove('hidden');
    $('mp-lobby').classList.add('hidden');
  }
  function showLobby() {
    $('menu').classList.remove('hidden');
    selectTab('tab-online');
    $('mp-home').classList.add('hidden');
    $('mp-lobby').classList.remove('hidden');
    renderLobby();
  }
  function hideLobby() { /* game start hides the whole menu via Game */ }

  function renderLobby() {
    if (!api.online) return;
    $('lobby-code').textContent = api.code.replace('priv-', '').replace('pub-', 'PUBLIC ');
    $('lobby-type').textContent = api.isPublic || api.code.startsWith('pub') ? 'public lobby' : 'private — share the code';
    $('lobby-players').innerHTML = api.roster.filter(r => !r.bot).map(r =>
      `<div class="lob-player" style="border-color:${r.color}">
        <span style="color:${r.color}">●</span> ${r.name}${r.id === 'host' ? ' (host)' : ''}${r.id === api.myId ? ' (you)' : ''}
      </div>`).join('');
    const isHost = api.role === 'host';
    document.querySelectorAll('#mp-lobby .lmap-btn, #mp-lobby .lmode-btn, #mp-lobby .lrounds-btn, ' +
      '#mp-lobby .llives-btn, #mp-lobby .lcrown-btn, #lobby-bots, #lobby-start')
      .forEach(el => { el.disabled = !isHost; el.classList.toggle('locked', !isHost); });
    document.querySelectorAll('#mp-lobby .lmap-btn').forEach(b =>
      b.classList.toggle('sel', b.dataset.m === api.settings.map));
    document.querySelectorAll('#mp-lobby .lmode-btn').forEach(b =>
      b.classList.toggle('sel', b.dataset.m === api.settings.mode));
    document.querySelectorAll('#mp-lobby .lrounds-btn').forEach(b =>
      b.classList.toggle('sel', +b.dataset.v === (api.settings.rounds || 2)));
    document.querySelectorAll('#mp-lobby .llives-btn').forEach(b =>
      b.classList.toggle('sel', +b.dataset.v === (api.settings.lives || 3)));
    document.querySelectorAll('#mp-lobby .lcrown-btn').forEach(b =>
      b.classList.toggle('sel', +b.dataset.v === (api.settings.crown || 25)));
    $('lobby-bots').checked = api.settings.fillBots;
    $('lobby-start').textContent = isHost ? 'START GAME' : 'waiting for host…';
  }

  function hostSetSettings(patch) {
    Object.assign(api.settings, patch);
    broadcast({ t: 'settings', settings: api.settings });
    SKY.Game.previewMap(api.settings.map);
    renderLobby();
  }

  function ensureNickname(then) {
    if ((SKY.Settings.data.nickname || '').trim()) { then(); return; }
    const modal = $('nick-modal');
    modal.classList.remove('hidden');
    const input = $('nick-input');
    input.value = '';
    input.focus();
    $('nick-ok').onclick = () => {
      const v = input.value.trim().slice(0, 14);
      if (!v) return;
      SKY.Settings.data.nickname = v;
      SKY.Settings.save();
      modal.classList.add('hidden');
      $('mp-nick').textContent = v;
      then();
    };
  }

  function selectTab(id) {
    for (const t of ['tab-offline', 'tab-online', 'tab-servers', 'tab-matches']) {
      $(t).classList.toggle('sel', t === id);
    }
    $('panel-offline').classList.toggle('hidden', id !== 'tab-offline');
    $('panel-online').classList.toggle('hidden', id !== 'tab-online');
    $('panel-servers').classList.toggle('hidden', id !== 'tab-servers');
    $('panel-matches').classList.toggle('hidden', id !== 'tab-matches');
  }

  function refreshServers() {
    const list = $('srv-list');
    list.innerHTML = '<div class="srv-empty">Scanning public slots…</div>';
    let any = false;
    api._browsing = true;
    SKY.Net.browse((info) => {
      if (!any) { list.innerHTML = ''; any = true; }
      const row = document.createElement('div');
      row.className = 'srv-row';
      row.innerHTML = `<b>${info.code.replace('pub-', 'PUBLIC ')}</b>
        <span class="srv-meta">${info.map} · ${info.mode} · ${info.players}/${info.cap}${info.inGame ? ' · in game' : ''}</span>`;
      const btn = document.createElement('button');
      btn.className = 'sel-btn';
      btn.textContent = info.inGame || info.players >= info.cap ? 'Full' : 'Join';
      if (!info.inGame && info.players < info.cap) {
        btn.onclick = () => ensureNickname(() => { selectTab('tab-online'); join(info.code); });
      } else btn.classList.add('locked');
      row.appendChild(btn);
      list.appendChild(row);
    }, (results) => {
      api._browsing = false;
      if (!results.length) list.innerHTML = '<div class="srv-empty">No public lobbies right now — create one from the Online tab.</div>';
    });
  }

  function initUI() {
    // rail navigation
    $('tab-offline').onclick = () => { if (!api.online) selectTab('tab-offline'); };
    $('tab-online').onclick = () => {
      selectTab('tab-online');
      $('mp-nick').textContent = SKY.Settings.data.nickname || '(pick a nickname)';
      ensureNickname(() => {});
    };
    $('tab-servers').onclick = () => {
      if (api.online) return;
      selectTab('tab-servers');
      if (!api._browsing) refreshServers();
    };
    $('tab-matches').onclick = () => {
      if (api.online) return;
      selectTab('tab-matches');
      SKY.Demos.renderPanel();
    };
    $('srv-refresh').onclick = () => { if (!api._browsing) refreshServers(); };
    $('mp-nick').onclick = () => {
      SKY.Settings.data.nickname = '';
      ensureNickname(() => {});
    };
    $('mp-quick').onclick = () => ensureNickname(() => quickJoin(1));
    $('mp-host-pub').onclick = () => ensureNickname(() => host(true, 1));
    $('mp-host-priv').onclick = () => ensureNickname(() => host(false));
    $('mp-join').onclick = () => ensureNickname(() => {
      const code = $('mp-code').value.trim().toUpperCase();
      if (code) join('priv-' + code);
    });
    $('lobby-leave').onclick = () => leaveWithMessage('');
    $('lobby-start').onclick = () => { if (api.role === 'host' && api.inGame === false) hostStart(); };
    $('lobby-code').onclick = () => {
      try { navigator.clipboard.writeText($('lobby-code').textContent); status('Code copied!'); } catch (e) {}
    };
    $('lobby-bots').onchange = (e) => { if (api.role === 'host') hostSetSettings({ fillBots: e.target.checked }); };
    document.querySelectorAll('#mp-lobby .lmap-btn').forEach(b => {
      b.onclick = () => { if (api.role === 'host') hostSetSettings({ map: b.dataset.m }); };
    });
    document.querySelectorAll('#mp-lobby .lrounds-btn').forEach(b => {
      b.onclick = () => { if (api.role === 'host') hostSetSettings({ rounds: +b.dataset.v }); };
    });
    document.querySelectorAll('#mp-lobby .llives-btn').forEach(b => {
      b.onclick = () => { if (api.role === 'host') hostSetSettings({ lives: +b.dataset.v }); };
    });
    document.querySelectorAll('#mp-lobby .lcrown-btn').forEach(b => {
      b.onclick = () => { if (api.role === 'host') hostSetSettings({ crown: +b.dataset.v }); };
    });
    document.querySelectorAll('#mp-lobby .lmode-btn').forEach(b => {
      b.onclick = () => { if (api.role === 'host') hostSetSettings({ mode: b.dataset.m }); };
    });
  }

  return {
    get online() { return api.online; },
    get role() { return api.role; },
    get myId() { return api.myId; },
    get inGame() { return api.inGame; },
    get authority() { return !api.online || api.role === 'host'; },

    get roster() { return api.roster; },
    get pings() { return pings; },
    init() { initUI(); },
    lerpPawn,
    send, broadcast,
    /* test hooks */
    _host: host, _join: join, _start: hostStart,

    /* hooks used by game/weapons */
    sendFire(data) { if (api.online) send({ t: 'fire', ...data }); },
    sendNade(data) { if (api.online) send({ t: 'nade', ...data }); },
    sendBuy(id) { if (api.online && api.role === 'client') send({ t: 'buy', id }); },
    hostBombRound(team, reason, score) {
      for (const [id, c] of conns) {
        const pawn = SKY.Game.pawns.find(p => p.netId === id);
        c.send({ t: 'bround', team, reason, score, myMoney: pawn ? pawn.money : 0 });
      }
    },

    /* ---------- server browser: probe the public slots ---------- */
    browse(onRow, onDone) {
      let slot = 1;
      const results = [];
      const next = () => {
        if (slot > PUB_SLOTS) { onDone(results); return; }
        const code = 'pub-' + slot;
        const probe = new Peer();
        let finished = false;
        const finish = (info) => {
          if (finished) return;
          finished = true;
          try { probe.destroy(); } catch (e) {}
          if (info) { results.push(info); onRow(info); }
          slot++;
          next();
        };
        const to = setTimeout(() => finish(null), 2600);
        probe.on('open', () => {
          const c = probe.connect(PREFIX + '-' + code, { reliable: true });
          c.on('open', () => c.send({ t: 'query' }));
          c.on('data', (m) => {
            if (m.t === 'info') { clearTimeout(to); finish({ code, ...m }); }
          });
          c.on('error', () => { clearTimeout(to); finish(null); });
        });
        probe.on('error', () => { clearTimeout(to); finish(null); });
      };
      next();
    },
    sendHit(victimId, imp, head) {
      if (!api.online) return;
      const m = { t: 'hit', victim: victimId, by: api.myId, imp, head };
      if (api.role === 'host') routeHit(m);
      else send(m);
    },
    sendTaunt() { if (api.online) send({ t: 'taunt', id: api.myId }); },
    sendMapEvent(params) { if (api.role === 'host') broadcast({ t: 'mapevent', params }); },
    hostKo(pawn, line, killer) {
      broadcast({
        t: 'ko', id: pawn.netId, lives: pawn.lives, elim: pawn.eliminated, line,
        killer: killer ? killer.netId : null, killerKos: killer ? killer.koCount : 0,
      });
      if (pawn.isRemote && !pawn.eliminated) {
        const choices = SKY.Loot.roll(pawn).map(it => it.id);
        pendingLoot.set(pawn.netId, true);
        const conn = conns.get(pawn.netId);
        if (conn) conn.send({ t: 'loot', choices });
      }
    },
    hostWaitingLoot(pawn) { return pendingLoot.has(pawn.netId); },
    hostRespawn(pawn, pos, yaw) {
      broadcast({ t: 'respawn', id: pawn.netId, pos: [pos.x, pos.y, pos.z], yaw });
    },
    hostRoundEnd(winner, champion) {
      broadcast({ t: 'roundend', winner: winner ? winner.netId : null,
        wins: winner ? winner.roundWins : 0, champion });
    },
    hostNewRound() { broadcast({ t: 'newround' }); },
    hostOvertime() { broadcast({ t: 'overtime' }); },
    hostToLobby() { api.inGame = false; broadcast({ t: 'tolobby' }); showLobby(); },
    hostLoadoutFromLocalPick(item) {
      // host picked their own reward: mirror to clients
      broadcast({ t: 'loadout', id: 'host', item: item.id });
    },
    leave() { leaveWithMessage(''); },
  };
})();
