/* =============================================================================
 * SKY PUSH — match history ("demos", CSGO style)
 * Every finished OFFLINE round archives its replay buffer (the last ~30s of
 * frames + effects) together with match metadata: map, mode, roster, winner,
 * KO counts. The menu's MATCHES tab lists them; WATCH re-opens the round in
 * the replay editor straight from the menu.
 * Storage: in-memory for the session + IndexedDB so history survives reloads
 * (works from file:// in Chromium; failures degrade to session-only silently).
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Demos = (function () {
  const MAX = 10;          // most recent rounds kept
  const DB = 'skypush-demos', STORE = 'demos';
  let mem = [];            // newest first
  let db = null;

  function openDb(then) {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = (e) => { db = e.target.result; then && then(); };
      req.onerror = () => { then && then(); };
    } catch (err) { then && then(); }
  }

  function loadAll() {
    if (!db) return;
    try {
      const st = db.transaction(STORE, 'readonly').objectStore(STORE);
      st.getAll().onsuccess = (e) => {
        const rows = e.target.result || [];
        rows.sort((a, b) => b.ts - a.ts);
        // session memory wins on id collision (shouldn't happen)
        const have = new Set(mem.map(r => r.id));
        for (const r of rows) if (!have.has(r.id)) mem.push(r);
        mem.sort((a, b) => b.ts - a.ts);
        mem.length = Math.min(mem.length, MAX);
      };
    } catch (err) { /* session-only */ }
  }

  function persist(rec) {
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      st.put(rec);
      st.getAllKeys().onsuccess = (e) => {
        const keys = e.target.result || [];
        if (keys.length <= MAX) return;
        // ids embed the timestamp — oldest first when sorted
        keys.sort();
        for (let i = 0; i < keys.length - MAX; i++) st.delete(keys[i]);
      };
    } catch (err) { /* session-only */ }
  }

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  const api = {
    init() { openDb(loadAll); },
    list() { return mem; },

    /* called when a round ends — offline AND online (each peer records its
       own local view of the round, so online demos work with zero netcode) */
    archiveRound(winner) {
      const snap = SKY.Replay.archive();
      if (!snap) return;
      const G = SKY.Game;
      const rec = {
        id: 'd' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        ts: Date.now(),
        map: SKY.Map.currentId,
        mode: G.mode,
        roundNum: G.roundNum,
        winner: winner ? winner.name : null,
        players: G.pawns.map(p => ({
          name: p.name, color: p.color, kos: p.koCount, deaths: p.deaths,
          me: !!p.isLocal, bot: !!p.isBot,
        })),
        roster: snap.roster,
        duration: snap.duration,
        frames: snap.frames,
        events: snap.events,
      };
      mem.unshift(rec);
      mem.length = Math.min(mem.length, MAX);
      persist(rec);
    },

    /* fill the menu's MATCHES panel */
    renderPanel() {
      const list = document.getElementById('demo-list');
      if (!list) return;
      if (!mem.length) {
        list.innerHTML = '<div class="srv-empty">No matches recorded yet — play an offline round, then come back.</div>';
        return;
      }
      const MODES = { lbs: 'Last Standing', crown: 'Crown Rush', bomb: 'Bomb' };
      list.innerHTML = '';
      for (const rec of mem) {
        const row = document.createElement('div');
        row.className = 'demo-row';
        const names = rec.players.map(p =>
          `<span class="demo-name${p.me ? ' me' : ''}"${p.me ? '' : ` style="color:${p.color}"`}>${p.name}<small>${p.kos}</small></span>`).join('');
        row.innerHTML = `
          <div class="demo-head">
            <b>${(SKY.Map.MAPS[rec.map] || { name: rec.map }).name}</b>
            <span class="demo-meta">${MODES[rec.mode] || rec.mode} · R${rec.roundNum} · ${ago(rec.ts)}</span>
          </div>
          <div class="demo-sub">${rec.winner ? '🏆 ' + rec.winner : 'no winner'} · ${Math.round(rec.duration)}s clip</div>
          <div class="demo-players">${names}</div>`;
        const btn = document.createElement('button');
        btn.className = 'sel-btn';
        btn.textContent = 'Watch';
        btn.onclick = () => { SKY.SFX.init && SKY.SFX.init(); SKY.Replay.openArchive(rec); };
        row.appendChild(btn);
        list.appendChild(row);
      }
    },
  };

  return api;
})();
