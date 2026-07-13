/* =============================================================================
 * SKY PUSH — proximity voice chat (WebRTC audio mesh)
 * Hold V to talk. Voices come out of the SPEAKER'S CHARACTER in 3D — close
 * players are loud, far ones fade out (Web Audio panner per peer). In the
 * lobby (no bodies yet) voice is flat/non-positional.
 *
 * Topology: audio is a full mesh (peer<->peer RTCPeerConnections), but the
 * SIGNALING rides the existing data star — 'vsig' messages relayed by the
 * host. That works even when players joined through different lobby servers,
 * and reuses the same ICE/TURN config the game connection already proved.
 * The lexicographically SMALLER roster id makes the offer, the other answers.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Voice = (function () {
  const peers = new Map();   // otherId -> {pc, tx, audio:{el,src,gain,panner}, candQ, talking}
  let mic = null, micTrack = null, micPending = false, micBlocked = false;
  let talking = false;
  const _fwd = new THREE.Vector3();

  function vol() { return SKY.Settings ? (SKY.Settings.data.voiceVol ?? 1) : 1; }
  function actx() { return SKY.SFX && SKY.SFX.context ? SKY.SFX.context() : null; }
  function myId() { return SKY.Net.myId; }

  /* ---------------- mic (lazy: first V press asks permission) ------------- */
  function requestMic() {
    if (mic || micPending || micBlocked) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { micBlocked = true; return; }
    micPending = true;
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then((stream) => {
      micPending = false;
      mic = stream;
      micTrack = stream.getAudioTracks()[0];
      micTrack.enabled = talking;
      for (const P of peers.values()) attachMic(P);
      // the first V press races the permission grant — the pill only toggles
      // on talk transitions, so re-evaluate it now that the mic exists
      pill(talking);
    }).catch(() => {
      micPending = false;
      micBlocked = true;
      if (SKY.HUD && SKY.HUD.subMsg) SKY.HUD.subMsg('Mic blocked — allow the microphone to use voice chat', 3.5);
    });
  }

  function attachMic(P) {
    if (!micTrack || !P.tx) return;
    try { P.tx.sender.replaceTrack(micTrack); } catch (e) {}
  }

  // RTCSessionDescription flattened for the wire (see BinaryPack note below)
  function sdpJson(pc) {
    const d = pc.localDescription;
    return { type: d.type, sdp: d.sdp };
  }

  /* ---------------- peer connections ---------------- */
  function ensurePeer(id) {
    let P = peers.get(id);
    if (P) return P;
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: SKY.Net.iceServers });
    } catch (e) { return null; }
    P = { pc, tx: null, audio: null, candQ: [], talking: false, dead: false };
    peers.set(id, P);
    // ONLY the offerer pre-creates its transceiver. The answerer must adopt
    // the one the OFFER creates (see onSignal) — a pre-added addTransceiver
    // is never matched to a remote m-line (JSEP), so answering through it
    // would negotiate recvonly and our mic would never reach the other side.
    if (String(myId()) < String(id)) {
      P.tx = pc.addTransceiver('audio', { direction: 'sendrecv' });
      attachMic(P);
    }
    // PLAIN objects only: the data star packs messages with BinaryPack, which
    // silently drops host objects like RTCIceCandidate (no own enumerable
    // props — only JSON.stringify knows their toJSON)
    pc.onicecandidate = (e) => { if (e.candidate) SKY.Net.sendVSig(id, { c: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      wireRemote(P, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        // drop it; the next roster sync (or the retry below) rebuilds
        dropPeer(id);
        if (pc.connectionState === 'failed' && SKY.Net.online) {
          setTimeout(() => { if (SKY.Net.online) syncPeers(); }, 2500);
        }
      }
    };
    // smaller id makes the offer (deterministic on both ends)
    if (String(myId()) < String(id)) {
      pc.createOffer().then(o => pc.setLocalDescription(o))
        .then(() => SKY.Net.sendVSig(id, { sdp: sdpJson(pc) }))
        .catch(() => {});
    }
    return P;
  }

  /* remote audio: WebRTC streams need a live <audio> element in Chrome or the
     WebAudio graph never receives samples — keep it muted, the graph outputs */
  function wireRemote(P, stream) {
    if (P.audio) return;
    const c = actx();
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    el.play().catch(() => {});
    if (!c) { el.muted = false; P.audio = { el }; return; }   // no ctx: raw playback
    const src = c.createMediaStreamSource(stream);
    const gain = c.createGain();
    gain.gain.value = vol();
    const panner = c.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 4;      // full volume inside ~4m
    panner.maxDistance = 70;
    panner.rolloffFactor = 1.7;  // fades hard past ~20m
    src.connect(gain);
    gain.connect(panner);
    panner.connect(c.destination);
    P.audio = { el, src, gain, panner };
  }

  function dropPeer(id) {
    const P = peers.get(id);
    if (!P) return;
    peers.delete(id);
    P.dead = true;
    try { P.pc.close(); } catch (e) {}
    if (P.audio) {
      try { P.audio.el.srcObject = null; } catch (e) {}
      try { P.audio.src && P.audio.src.disconnect(); } catch (e) {}
      try { P.audio.panner && P.audio.panner.disconnect(); } catch (e) {}
    }
    setTalkClass(id, false);
  }

  /* signaling relayed through the host's data star */
  function onSignal(from, d) {
    if (!SKY.Net.online) return;
    const P = ensurePeer(from);
    if (!P) return;
    const pc = P.pc;
    if (d.sdp) {
      const desc = d.sdp;
      pc.setRemoteDescription(desc).then(() => {
        for (const c of P.candQ.splice(0)) pc.addIceCandidate(c).catch(() => {});
        if (desc.type === 'offer') {
          // adopt the transceiver the offer created + answer sendrecv, so the
          // mic can stream (replaceTrack) without any renegotiation later
          if (!P.tx) {
            P.tx = pc.getTransceivers()[0] || null;
            if (P.tx) { try { P.tx.direction = 'sendrecv'; } catch (e) {} }
            attachMic(P);
          }
          return pc.createAnswer().then(a => pc.setLocalDescription(a))
            .then(() => SKY.Net.sendVSig(from, { sdp: sdpJson(pc) }));
        }
      }).catch(() => {});
    } else if (d.c) {
      if (pc.remoteDescription) pc.addIceCandidate(d.c).catch(() => {});
      else P.candQ.push(d.c);
    }
  }

  /* roster changed: connect to new humans, drop leavers */
  function syncPeers() {
    if (!SKY.Net.online) { stop(); return; }
    const want = new Set(SKY.Net.roster.filter(r => !r.bot && r.id !== myId()).map(r => r.id));
    for (const id of [...peers.keys()]) if (!want.has(id)) dropPeer(id);
    for (const id of want) ensurePeer(id);
  }

  function stop() {
    for (const id of [...peers.keys()]) dropPeer(id);
    if (mic) { for (const t of mic.getTracks()) { try { t.stop(); } catch (e) {} } }
    mic = null; micTrack = null; micPending = false; micBlocked = false;
    if (talking) { talking = false; pill(false); }
  }

  /* ---------------- talk indicators ---------------- */
  function pill(on) {
    const el = document.getElementById('voice-pill');
    if (el) el.classList.toggle('hidden', !on);
  }
  function setTalkClass(id, on) {
    const row = document.getElementById('lobp-' + id);
    if (row) row.classList.toggle('talking', on);
    const pawn = SKY.Game.pawns.find(p => p.netId === id);
    if (pawn) pawn._talking = on;
  }
  function setTalking(id, on) {
    const P = peers.get(id);
    if (P) P.talking = !!on;
    setTalkClass(id, !!on);
  }

  /* ---------------- per-frame ---------------- */
  function tick(camera) {
    if (!SKY.Net.online) return;
    // push-to-talk (works in the lobby AND in game; suspended while typing)
    const want = !!(SKY.Input.action && SKY.Input.action('voice')) && !SKY.Input.typing;
    if (want && !mic) requestMic();
    if (want !== talking) {
      talking = want;
      if (micTrack) micTrack.enabled = talking;
      pill(talking && !!micTrack);
      SKY.Net.sendTalk(talking);
      const me = SKY.Game.player;
      if (me) me._talking = talking;
      const meRow = document.getElementById('lobp-' + myId());
      if (meRow) meRow.classList.toggle('talking', talking);
    }

    const c = actx();
    if (!c || !camera) return;
    const inGame = SKY.Game.state !== 'menu';
    // listener = the camera (proximity is judged from where you LOOK from)
    const L = c.listener;
    const cp = camera.position;
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    try {
      L.setPosition(cp.x, cp.y, cp.z);
      L.setOrientation(_fwd.x, _fwd.y, _fwd.z, 0, 1, 0);
    } catch (e) { /* very old listener API — flat voice still works */ }

    for (const [id, P] of peers) {
      if (!P.audio || !P.audio.panner) continue;
      P.audio.gain.gain.value = vol();
      const pawn = inGame ? SKY.Game.pawns.find(p => p.netId === id && !p.left) : null;
      try {
        if (pawn) {
          // voice comes out of the speaking character's head
          P.audio.panner.setPosition(pawn.pos.x, pawn.pos.y + pawn.height * 0.9, pawn.pos.z);
        } else {
          // lobby / spectating a leaver: sit ON the listener = flat volume
          P.audio.panner.setPosition(cp.x, cp.y, cp.z);
        }
      } catch (e) {}
    }
  }

  return { syncPeers, onSignal, setTalking, stop, tick,
    get talking() { return talking; },
    peerCount() { return peers.size; },
    /* test hook: [{id, state, wired, talking}] */
    _debug() {
      return [...peers].map(([id, P]) => ({ id,
        state: P.pc.connectionState, ice: P.pc.iceConnectionState,
        wired: !!(P.audio && P.audio.panner), talking: P.talking }));
    } };
})();
