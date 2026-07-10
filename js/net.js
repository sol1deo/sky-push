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

  /* ---------------- ICE: STUN + optional TURN relay ----------------
   * STUN discovers your public address (enough when at least one side has
   * a friendly NAT). TURN relays the traffic when both NATs are strict —
   * which is COMMON between different countries/ISPs. There is no reliable
   * keyless public TURN anymore, so plug a free credentials endpoint in:
   *   1. create a free app at https://www.metered.ca (50 GB/mo TURN)
   *   2. set TURN_FETCH_URL to its credentials URL:
   *      https://<app>.metered.live/api/v1/turn/credentials?apiKey=<KEY>
   * (the key is meant to be public client-side; it only mints TURN creds)
   * Debug: add ?relay to the URL to FORCE all traffic through TURN. */
  // metered.ca app 'skypush' — this apiKey is PUBLIC by design (it can only
  // mint TURN credentials; usage is capped by the free tier)
  const TURN_FETCH_URL = 'https://skypush.metered.live/api/v1/turn/credentials?apiKey=23989c167668b6049fa285eca33ab8775b1e';
  // static fallback (same relay) in case the credentials fetch is unreachable
  const TURN_STATIC = [
    { urls: 'turn:global.relay.metered.ca:80', username: '7b0a19efbb68cceef88e741f', credential: 'D+BHVnDLTFPZittQ' },
    { urls: 'turn:global.relay.metered.ca:443', username: '7b0a19efbb68cceef88e741f', credential: 'D+BHVnDLTFPZittQ' },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: '7b0a19efbb68cceef88e741f', credential: 'D+BHVnDLTFPZittQ' },
  ];
  const STUN_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.sipnet.ru:3478' },   // reachable from inside Russia
  ];
  let iceServers = TURN_STATIC.concat(STUN_SERVERS);

  function fetchTurn() {
    if (!TURN_FETCH_URL) return;
    fetch(TURN_FETCH_URL)
      .then(r => r.json())
      .then(list => {
        if (Array.isArray(list) && list.length) iceServers = list.concat(STUN_SERVERS);
      })
      .catch(() => { /* relay stays off; STUN-only still works for easy NATs */ });
  }

  /* ---------------- signaling servers ----------------
   * The default PeerJS cloud (0.peerjs.com) sits behind Cloudflare, which is
   * blocked/throttled on some networks — a player then hangs forever on
   * "Creating lobby…". So lobbies are DUAL-HOMED: the host registers the same
   * code on every server below, joiners try them in order. Both players only
   * need ONE common reachable server. */
  const SIGNALS = [
    { name: 'main', opts: null },                                    // PeerJS cloud
    { name: 'backup', opts: { host: 'peerjs.92k.de', port: 443, secure: true } },
  ].filter((s, i, all) => {
    // ?sigonly=backup pretends the other servers don't exist (testing —
    // simulates a player whose network blocks the main cloud)
    const only = (location.search.match(/[?&]sigonly=(\w+)/) || [])[1];
    return !only || s.name === only;
  });

  function peerOpts(forceRelay, sigOpts) {
    return Object.assign({}, sigOpts || {}, {
      config: {
        iceServers,
        iceTransportPolicy: (forceRelay || /[?&]relay\b/.test(location.search)) ? 'relay' : 'all',
      },
    });
  }

  function hasTurn() {
    return iceServers.some(s => String(s.urls).indexOf('turn') === 0);
  }

  /* ---------------- connectivity self-test ----------------
   * Four independent checks so "it doesn't work" becomes actionable:
   *   SIG  — can we reach the lobby (signaling) server at all?
   *   STUN — does the network let us discover our public address?
   *   TURN — does the relay hand out relay candidates?
   *   LOOP — full in-stack P2P connection forced THROUGH the relay
   *          (if this passes on both machines, they can play together)
   * A VPN / privacy extension that disables WebRTC shows up as SIG ✓ with
   * everything else ✗. */
  function netTest(onUpdate) {
    const out = [];
    const line = (ok, label) => { out.push((ok ? '✓ ' : '✗ ') + label); onUpdate(out.join('\n') + '\n…'); };

    const sigTest = (sigIdx) => new Promise((res) => {
      let done = false;
      const p = new Peer(peerOpts(false, SIGNALS[sigIdx].opts));
      const fin = (ok) => { if (!done) { done = true; try { p.destroy(); } catch (e) {} res(ok); } };
      setTimeout(() => fin(false), 8000);
      p.on('open', () => fin(true));
      p.on('error', () => fin(false));
    });

    const iceTest = new Promise((res) => {
      let srflx = false, relay = false, done = false, pc = null;
      const fin = () => {
        if (done) return;
        done = true;
        try { pc.close(); } catch (e) {}
        res({ srflx, relay });
      };
      try { pc = new RTCPeerConnection({ iceServers }); } catch (e) { res({ srflx, relay }); return; }
      try {
        pc.createDataChannel('t');
        pc.onicecandidate = (e) => {
          if (!e.candidate) { fin(); return; }        // gathering complete
          if (/ typ srflx /.test(e.candidate.candidate)) srflx = true;
          if (/ typ relay /.test(e.candidate.candidate)) relay = true;
          if (srflx && relay) fin();                  // got everything we need
        };
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
      } catch (e) { /* WebRTC disabled */ }
      setTimeout(fin, 12000);
    });

    const loopTest = (sigIdx) => new Promise((res) => {
      let done = false;
      const id = PREFIX + '-nettest-' + randCode(6);
      const a = new Peer(id, peerOpts(true, SIGNALS[sigIdx].opts));   // relay-forced on purpose
      let b = null;
      const fin = (ok) => {
        if (done) return;
        done = true;
        try { a.destroy(); } catch (e) {}
        try { if (b) b.destroy(); } catch (e) {}
        res(ok);
      };
      setTimeout(() => fin(false), 16000);
      a.on('connection', (c) => c.on('data', () => c.send('pong')));
      a.on('error', () => fin(false));
      a.on('open', () => {
        b = new Peer(peerOpts(true, SIGNALS[sigIdx].opts));
        b.on('error', () => fin(false));
        b.on('open', () => {
          const c = b.connect(id, { reliable: true });
          c.on('open', () => c.send('ping'));
          c.on('data', () => fin(true));
          c.on('error', () => fin(false));
        });
      });
    });

    return (async () => {
      const sigs = [];
      for (let i = 0; i < SIGNALS.length; i++) {
        sigs[i] = await sigTest(i);
        line(sigs[i], 'Lobby server ' + (i + 1) + ' (' + SIGNALS[i].name + ')');
      }
      const anySig = sigs.indexOf(true);
      const ice = await iceTest;
      line(ice.srflx, 'Public address (STUN)');
      const loop = anySig >= 0 && await loopTest(anySig);
      // a successful relay-forced loop PROVES the relay works, even when the
      // candidate gather was too slow to list it
      const relay = ice.relay || loop;
      line(relay, 'Relay (TURN)');
      line(loop, 'P2P through the relay');
      const sum = 'SIG' + sigs.map(s => s ? '+' : '-').join('') +
        ' STUN' + (ice.srflx ? '+' : '-') +
        ' TURN' + (relay ? '+' : '-') + ' LOOP' + (loop ? '+' : '-');
      const verdict = loop
        ? 'ALL GOOD — this device can play with anyone whose test also passes.'
        : anySig < 0 ? 'No lobby server reachable — firewall/DNS blocks them (try a VPN).'
        : !ice.srflx && !relay ? 'WebRTC seems disabled — check VPN / browser privacy extensions.'
        : !relay ? 'Relay unreachable — metered.ca hosts may be blocked on this network.'
        : 'Relay reachable but the loop failed — run the test again.';
      out.push('', sum, verdict);
      onUpdate(out.join('\n'));
      return { sigs, srflx: ice.srflx, relay, loop, sum };
    })();
  }

  let peer = null;           // primary connection to signaling
  let peer2 = null;          // host only: twin registration on the backup server
  let sessionId = 0;         // bumped on destroyPeer — stale-callback guard
  const directPcs = [];      // DIRECT LINK RTCPeerConnections (manual signaling)
  let pendingDirect = null;  // host: invite awaiting the guest's reply
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
    sessionId++;
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (peer) { const old = peer; peer = null; try { old.destroy(); } catch (e) {} }
    if (peer2) { const old = peer2; peer2 = null; try { old.destroy(); } catch (e) {} }
    for (const pc of directPcs.splice(0)) { try { pc.close(); } catch (e) {} }
    pendingDirect = null;
    conns.clear(); hostConn = null;
    lastStates.clear(); pendingLoot.clear();
    for (const k of Object.keys(pings)) delete pings[k];
    api.online = false; api.role = null; api.code = null; api.roster = [];
    api.inGame = false;
  }

  /* PeerJS drops its signaling socket now and then ('network'); reconnect
     quietly instead of surfacing an error — data channels keep working. */
  function attachRecovery(p) {
    const sess = sessionId;
    p.on('disconnected', () => {
      if (sess !== sessionId) return;
      try { p.reconnect(); } catch (e) {}
    });
  }

  /* ===================== hosting =====================
   * The lobby code is registered on EVERY signaling server (dual-homed) so
   * a joiner only needs one server in common with us. The lobby opens as
   * soon as the first registration succeeds. */
  function host(isPublic, slot, forcedCode) {
    destroyPeer();
    const sess = sessionId;
    const code = forcedCode ? 'priv-' + forcedCode
      : isPublic ? 'pub-' + (slot || 1) : 'priv-' + randCode(4);
    status('Creating lobby…');
    let openedAny = false;
    let hardFails = 0;

    const mkHost = (sigIdx) => {
      const p = new Peer(PREFIX + '-' + code, peerOpts(false, SIGNALS[sigIdx].opts));
      attachRecovery(p);
      p.on('open', () => {
        if (sess !== sessionId || openedAny) return;
        openedAny = true;
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
        if (sess !== sessionId) return;            // stale peer, ignore
        if (err.type === 'network') {              // signaling blip — recover
          try { p.reconnect(); } catch (e) {}
          return;
        }
        if (err.type === 'unavailable-id') {
          // code taken: the PRIMARY server drives slot/code selection; a
          // collision that exists only on the backup is ignored
          if (sigIdx !== 0) return;
          if (isPublic && (slot || 1) < PUB_SLOTS) host(true, (slot || 1) + 1);
          else host(isPublic, 1);
          return;
        }
        if (err.type !== 'peer-unavailable') {
          hardFails++;
          if (hardFails >= SIGNALS.length && !openedAny) {
            status('Connection error: ' + err.type + ' — run NETWORK TEST below.');
            destroyPeer();
          }
        }
      });
      p.on('connection', (conn) => {
        if (sess !== sessionId) return;
        conn.on('open', () => { /* wait for hello */ });
        conn.on('data', (m) => onHostMessage(conn, m));
        conn.on('close', () => dropClient(conn));
        conn.on('error', () => dropClient(conn));
      });
      return p;
    };

    peer = mkHost(0);
    peer2 = SIGNALS.length > 1 ? mkHost(1) : null;

    // neither server answered: don't hang on "Creating lobby…" forever
    setTimeout(() => {
      if (sess !== sessionId || openedAny) return;
      status('Lobby servers unreachable — run NETWORK TEST below.');
      destroyPeer();
    }, 14000);
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

  /* ===================== joining =====================
   * The lobby may live on any signaling server (the host dual-homes it), and
   * a direct WebRTC link may need the TURN relay. So joining walks a strategy
   * queue: [main, backup] × [direct, relay-forced]. A 'peer-unavailable' on a
   * server means the lobby isn't registered there — its relay attempt is
   * skipped too. */
  function join(code, onFail) {
    destroyPeer();
    const sess = sessionId;
    const skipSig = new Set();
    const attempts = SIGNALS.map((s, i) => ({ sig: i, relay: false }))
      .concat(SIGNALS.map((s, i) => ({ sig: i, relay: true })));
    let ai = -1;
    const fail = (why) => {
      if (sess !== sessionId) return;
      destroyPeer();
      onFail ? onFail(why) : status(why);
    };

    const tryNext = (lastWhy) => {
      if (sess !== sessionId) return;
      ai++;
      while (ai < attempts.length &&
             (skipSig.has(attempts[ai].sig) || (attempts[ai].relay && !hasTurn()))) ai++;
      if (ai >= attempts.length) {
        fail(lastWhy || 'Could not connect — wrong code, or this network blocks P2P (run NETWORK TEST below).');
        return;
      }
      const at = attempts[ai];
      status('Joining ' + code + '… (' + SIGNALS[at.sig].name + ' server' +
        (at.relay ? ', relay' : '') + ')');

      // replace the previous attempt's peer WITHOUT ending the session
      if (peer) { const old = peer; peer = null; try { old.destroy(); } catch (e) {} }
      const p = peer = new Peer(peerOpts(at.relay, SIGNALS[at.sig].opts));
      attachRecovery(p);
      let finished = false, opened = false, sigOpen = false;
      const advance = (why) => {
        if (finished || sess !== sessionId) return;
        finished = true;
        tryNext(why);
      };
      const sigTimeout = setTimeout(() => {
        if (!sigOpen) { skipSig.add(at.sig); advance('Lobby server unreachable — run NETWORK TEST below.'); }
      }, 9000);

      p.on('open', () => {
        if (sess !== sessionId || finished) return;
        sigOpen = true;
        clearTimeout(sigTimeout);
        const conn = p.connect(PREFIX + '-' + code, { reliable: true });
        const connTimeout = setTimeout(() => advance(), at.relay ? 16000 : 12000);
        conn.on('open', () => {
          if (sess !== sessionId) return;
          status('Connected — entering lobby…');
          conn.send({ t: 'hello', name: nickname() });
        });
        conn.on('data', (m) => {
          if (sess !== sessionId) return;
          if (m.t === 'welcome') {
            clearTimeout(connTimeout);
            opened = true; finished = true;
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
            clearTimeout(connTimeout);
            finished = true;
            fail('That lobby is full or already playing.');
          } else {
            onClientMessage(m);
          }
        });
        conn.on('close', () => {
          if (opened) { leaveWithMessage('Host left the game.'); return; }
          clearTimeout(connTimeout);
          advance();
        });
        conn.on('error', () => { if (!opened) { clearTimeout(connTimeout); advance(); } });
      });
      p.on('error', (err) => {
        if (sess !== sessionId || finished) return;
        if (err.type === 'network') { try { p.reconnect(); } catch (e) {} return; }
        clearTimeout(sigTimeout);
        if (err.type === 'peer-unavailable') {
          skipSig.add(at.sig);                    // lobby isn't on this server
          advance('No lobby found for that code.');
        } else {
          advance('Connection error: ' + err.type);
        }
      });
    };
    tryNext();
  }

  function quickJoin(slot) {
    slot = slot || 1;
    if (slot > PUB_SLOTS) { status('No public lobbies — creating one!'); host(true, 1); return; }
    status('Searching public lobbies… (' + slot + '/' + PUB_SLOTS + ')');
    join('pub-' + slot, () => quickJoin(slot + 1));
  }

  /* ===================== DIRECT LINK (serverless manual signaling) =====
   * For networks where every lobby server is blocked (state firewalls etc.):
   * the WebRTC offer/answer is carried BY THE PLAYERS THEMSELVES through any
   * chat app. The chat IS the signaling channel — zero blockable
   * infrastructure. Gameplay afterwards is the usual P2P (+TURN if usable).
   * A raw RTCDataChannel is wrapped to look like a PeerJS DataConnection so
   * the rest of this file doesn't know the difference. */

  function wrapChannel(pc, ch) {
    const handlers = {};
    const conn = {
      peer: 'direct',
      open: false,
      send(m) { try { ch.send(JSON.stringify(m)); } catch (e) {} },
      close() { try { ch.close(); } catch (e) {} try { pc.close(); } catch (e) {} },
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
      _emit(ev, arg) { (handlers[ev] || []).forEach(fn => { try { fn(arg); } catch (e) {} }); },
    };
    ch.onopen = () => { conn.open = true; conn._emit('open'); };
    ch.onmessage = (e) => { try { conn._emit('data', JSON.parse(e.data)); } catch (err) {} };
    ch.onclose = () => { const was = conn.open; conn.open = false; if (was) conn._emit('close'); };
    ch.onerror = () => conn._emit('error', { type: 'channel' });
    return conn;
  }

  /* compact codec: an SDP is 95% boilerplate — keep only the ICE credentials,
     the DTLS fingerprint and the useful candidates, rebuild the rest from a
     template on the other side. Codes shrink to ~600-900 chars = one Discord
     message. */
  function packDesc(desc) {
    const sdp = desc.sdp;
    const get = (re) => (sdp.match(re) || [])[1] || '';
    const pri = (l) => l.includes(' typ relay') ? 0 : l.includes(' typ srflx') ? 1 : 2;
    const cands = sdp.split(/\r?\n/)
      .filter(l => l.indexOf('a=candidate:') === 0)
      .map(l => l.slice(12))
      .filter(l => !l.includes('.local'))    // mDNS hostnames are useless remotely
      .filter(l => / udp /i.test(l))         // drop ice-tcp host candidates
      .sort((a, b) => pri(a) - pri(b))       // relay + srflx first…
      .slice(0, 7);                          // …and keep the code chat-sized
    return 'SKY1.' + btoa(JSON.stringify({
      o: desc.type === 'offer' ? 1 : 0,
      u: get(/a=ice-ufrag:(\S+)/), w: get(/a=ice-pwd:(\S+)/),
      f: get(/a=fingerprint:sha-256 ([A-Fa-f0-9:]+)/),
      s: get(/a=setup:(\w+)/) || (desc.type === 'offer' ? 'actpass' : 'active'),
      m: get(/a=mid:(\S+)/) || '0',
      c: cands,
    }));
  }
  function unpackDesc(str) {
    const t = String(str).replace(/\s+/g, '');
    if (t.indexOf('SKY1.') === 0) {
      const d = JSON.parse(atob(t.slice(5)));
      const sdp = [
        'v=0',
        'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE ' + d.m,
        'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        'a=ice-ufrag:' + d.u,
        'a=ice-pwd:' + d.w,
        'a=fingerprint:sha-256 ' + d.f,
        'a=setup:' + d.s,
        'a=mid:' + d.m,
        'a=sctp-port:5000',
        'a=max-message-size:262144',
      ].concat(d.c.map(c => 'a=candidate:' + c)).join('\r\n') + '\r\n';
      return { type: d.o ? 'offer' : 'answer', sdp };
    }
    // legacy full-JSON format
    return JSON.parse(decodeURIComponent(escape(atob(t))));
  }

  /* wait for ICE gathering, then hand out the compact code */
  function gatherLocal(pc) {
    return new Promise((res) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        res(packDesc(pc.localDescription));
      };
      if (pc.iceGatheringState === 'complete') { fin(); return; }
      setTimeout(fin, 5000);   // ship whatever candidates we have by then
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') fin();
      };
    });
  }

  /* become (or stay) a lobby host without needing any signaling server */
  function ensureHostState() {
    if (api.online && api.role === 'host') return;
    destroyPeer();
    api.online = true; api.role = 'host'; api.code = 'direct'; api.isPublic = false;
    api.myId = 'host';
    api.roster = [{ id: 'host', name: nickname(), color: COLORS[0] }];
    pings.host = 0;
    showLobby();
    status('');
    startStream();
    startPing();
  }

  /* host side: create an invite string for ONE guest */
  async function directHost(onInvite) {
    ensureHostState();
    const pc = new RTCPeerConnection({ iceServers });
    directPcs.push(pc);
    pendingDirect = pc;
    const ch = pc.createDataChannel('sky', { ordered: true });
    const conn = wrapChannel(pc, ch);
    conn.on('data', (m) => onHostMessage(conn, m));
    conn.on('close', () => dropClient(conn));
    await pc.setLocalDescription(await pc.createOffer());
    onInvite(await gatherLocal(pc));
  }

  /* host side: paste the guest's reply to finish the handshake */
  function directComplete(answerStr) {
    if (!pendingDirect) return false;
    try {
      pendingDirect.setRemoteDescription(unpackDesc(answerStr));
      pendingDirect = null;
      return true;
    } catch (e) { return false; }
  }

  /* guest side: paste the invite, produce the reply string */
  async function directJoin(offerStr, onAnswer) {
    const desc = unpackDesc(offerStr);          // throws on garbage — caller catches
    destroyPeer();
    const sess = sessionId;
    const pc = new RTCPeerConnection({ iceServers });
    directPcs.push(pc);
    pc.ondatachannel = (e) => {
      if (sess !== sessionId) return;
      const conn = wrapChannel(pc, e.channel);
      conn.on('open', () => {
        if (sess !== sessionId) return;
        status('Connected — entering lobby…');
        conn.send({ t: 'hello', name: nickname() });
      });
      conn.on('data', (m) => {
        if (sess !== sessionId) return;
        if (m.t === 'welcome') {
          hostConn = conn;
          api.online = true; api.role = 'client'; api.code = 'direct';
          api.myId = m.you;
          api.roster = m.roster;
          api.settings = m.settings;
          SKY.Game.previewMap(api.settings.map);
          showLobby();
          status('');
          startStream();
          startPing();
        } else if (m.t === 'full') {
          status('That lobby is full or already playing.');
          conn.close();
        } else {
          onClientMessage(m);
        }
      });
      conn.on('close', () => {
        if (sess !== sessionId) return;
        if (api.online && api.role === 'client') leaveWithMessage('Host left the game.');
      });
    };
    await pc.setRemoteDescription(desc);
    await pc.setLocalDescription(await pc.createAnswer());
    onAnswer(await gatherLocal(pc));
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
      case 'pkspawn': SKY.Pickups.spawnAt(m.id, m.item, m.pos); break;
      case 'pktake': SKY.Pickups.takeRemote(m.id, m.by); break;
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
    $('net-test-btn').onclick = () => {
      const out = $('net-test-out');
      out.classList.remove('hidden');
      out.textContent = 'Running (takes ~30 s)…';
      netTest((txt) => { out.textContent = txt; });
    };

    /* ----- direct connect: ONE box, paste-driven — the box recognises what
       was pasted (invite vs reply) and does the right thing automatically */
    const dlText = $('dl-text');
    const dlSay = (s) => { $('dl-step').textContent = s; };
    $('dl-invite').onclick = () => {
      ensureNickname(() => {
        dlSay('Creating code…');
        directHost((inv) => {
          dlText.value = inv;
          try { navigator.clipboard.writeText(inv); } catch (e) {}
          dlSay('Code copied — send it to your friend. When their reply comes, just paste it in the box.');
        });
      });
    };
    $('dl-copy').onclick = () => {
      try { navigator.clipboard.writeText(dlText.value); dlSay('Copied.'); } catch (e) {}
    };
    dlText.addEventListener('input', () => {
      const t = dlText.value.trim();
      if (t.indexOf('SKY1.') !== 0) return;
      let d;
      try { d = JSON.parse(atob(t.slice(5).replace(/\s+/g, ''))); } catch (e) { return; }  // partial paste
      if (d.o === 1) {
        // an INVITE was pasted → build the reply
        dlSay('Building your reply…');
        ensureNickname(() => {
          directJoin(t, (ans) => {
            dlText.value = ans;
            try { navigator.clipboard.writeText(ans); } catch (e) {}
            dlSay('Reply copied — send it back. You join automatically once they paste it (~15 s).');
          }).catch(() => dlSay('That code didn\'t work — ask for a fresh one.'));
        });
      } else if (d.o === 0) {
        // a REPLY was pasted → finish the handshake
        if (directComplete(t)) dlSay('Connecting… your friend appears in the lobby in a few seconds.');
        else dlSay('Press CREATE CODE first, then paste their reply.');
      }
    });
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
    netTest, directHost, directComplete, directJoin,
    init() {
      initUI();
      fetchTurn();
      // ?nettest — run the connectivity self-test headlessly (autotest hook)
      if (/[?&]nettest\b/.test(location.search)) {
        const boot = document.getElementById('boot-status');
        netTest((txt) => { boot.textContent = 'NETTEST: ' + txt.replace(/\n/g, ' | '); });
      }
    },
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

    /* ---------- server browser: probe the public slots ----------
     * Probes every slot on every signaling server (lobbies are dual-homed,
     * but a host may only have reached one). A server that never answers
     * once is skipped for its remaining slots. */
    browse(onRow, onDone) {
      let sig = 0, slot = 1;
      const results = [];
      const seen = new Set();
      const next = () => {
        if (slot > PUB_SLOTS) { sig++; slot = 1; }
        if (sig >= SIGNALS.length) { onDone(results); return; }
        const code = 'pub-' + slot;
        if (seen.has(code)) { slot++; next(); return; }
        const probe = new Peer(peerOpts(false, SIGNALS[sig].opts));
        let finished = false, sigOpened = false;
        const finish = (info) => {
          if (finished) return;
          finished = true;
          try { probe.destroy(); } catch (e) {}
          if (info) { seen.add(code); results.push(info); onRow(info); }
          if (!sigOpened) sig++;   // server unreachable — skip its other slots
          else slot++;
          next();
        };
        // empty slots fail fast (peer-unavailable); occupied ones may need
        // several seconds of ICE before the info comes back
        const to = setTimeout(() => finish(null), 6000);
        probe.on('open', () => {
          sigOpened = true;
          const c = probe.connect(PREFIX + '-' + code, { reliable: true });
          c.on('open', () => c.send({ t: 'query' }));
          c.on('data', (m) => {
            if (m.t === 'info') { clearTimeout(to); finish({ code, ...m }); }
          });
          c.on('error', () => { clearTimeout(to); finish(null); });
        });
        probe.on('error', (err) => {
          if (err && err.type === 'peer-unavailable') sigOpened = true;  // server answered: slot empty
          clearTimeout(to);
          finish(null);
        });
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
    sendPickupSpawn(d) { if (api.role === 'host') broadcast({ t: 'pkspawn', ...d }); },
    sendPickupTake(id, by) { if (api.role === 'host') broadcast({ t: 'pktake', id, by }); },
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
