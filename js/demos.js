/* =============================================================================
 * SKY PUSH — match history ("demos", CSGO style)
 * Every finished match archives its FULL replay buffer (every round, start to
 * end: frames + effects + round marks) together with match metadata: map,
 * mode, roster, winner, KO counts. The menu's MATCHES tab lists them; WATCH
 * re-opens the match in the replay editor straight from the menu.
 * The 10 newest UNSAVED matches are kept — older ones auto-delete. SAVE pins
 * a match permanently (never pruned) until un-saved.
 * Storage: in-memory for the session + IndexedDB so history survives reloads
 * (works from file:// in Chromium; failures degrade to session-only silently).
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Demos = (function () {
  const MAX = 10;          // most recent UNSAVED matches kept (saved = forever)
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
        pruneMem();
      };
    } catch (err) { /* session-only */ }
  }

  /* keep every SAVED match + the MAX newest unsaved ones */
  function pruneMem() {
    let unsaved = 0;
    mem = mem.filter((r) => {
      if (r.saved) return true;
      unsaved++;
      if (unsaved <= MAX) return true;
      dbDelete(r.id);
      return false;
    });
  }

  function dbDelete(id) {
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); }
    catch (err) { /* session-only */ }
  }

  function persist(rec) {
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec); }
    catch (err) { /* session-only */ }
  }

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  function fmtDur(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
    return m ? m + 'm ' + (s < 10 ? '0' : '') + s + 's' : s + 's';
  }

  const api = {
    init() { openDb(loadAll); },
    list() { return mem; },
    /* re-persist a record whose contents changed (e.g. saved clip projects) */
    persistRec(rec) { persist(rec); },

    /* called ONCE when a match ends (or is abandoned) — the recording holds
       every round. Offline AND online (each peer records its local view). */
    archiveMatch(winner) {
      const snap = SKY.Replay.archive();
      if (!snap) return;
      const G = SKY.Game;
      const rec = {
        id: 'd' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        ts: Date.now(),
        saved: false,
        map: SKY.Map.currentId,
        mode: G.mode,
        rounds: G.roundNum,
        winner: winner ? winner.name : null,
        players: G.pawns.map(p => ({
          name: p.name, color: p.color, kos: p.mk || 0, deaths: p.md || 0,
          me: !!p.isLocal, bot: !!p.isBot,
        })),
        roster: snap.roster,
        duration: snap.duration,
        marks: snap.marks,
        frames: snap.frames,
        events: snap.events,
      };
      mem.unshift(rec);
      pruneMem();
      persist(rec);
    },

    /* fill the menu's MATCHES panel */
    renderPanel() {
      const list = document.getElementById('demo-list');
      if (!list) return;
      if (!mem.length) {
        list.innerHTML = '<div class="srv-empty">No matches recorded yet — play a match, then come back.</div>';
        return;
      }
      const MODES = { dm: 'Deathmatch', lbs: 'Last Standing', crown: 'Crown Rush',
                      it: 'IT', spark: 'Spark Rush', bomb: 'Bomb (retired)' };
      list.innerHTML = '';
      for (const rec of mem) {
        const row = document.createElement('div');
        row.className = 'demo-row';
        const names = rec.players.map(p =>
          `<span class="demo-name${p.me ? ' me' : ''}"${p.me ? '' : ` style="color:${p.color}"`}>${p.name}<small>${p.kos}</small></span>`).join('');
        const nr = rec.rounds || rec.roundNum || 1;
        row.innerHTML = `
          <div class="demo-head">
            <b>${(SKY.Map.MAPS[rec.map] || { name: rec.map }).name}</b>
            <span class="demo-meta">${MODES[rec.mode] || rec.mode} · ${nr} round${nr > 1 ? 's' : ''} · ${ago(rec.ts)}</span>
          </div>
          <div class="demo-sub">${rec.winner ? '🏆 ' + rec.winner : 'no winner'} · full match · ${fmtDur(rec.duration)}</div>
          <div class="demo-players">${names}</div>`;
        const btns = document.createElement('div');
        btns.className = 'demo-btns';
        const watch = document.createElement('button');
        watch.className = 'sel-btn';
        watch.textContent = 'Watch';
        watch.onclick = () => { SKY.SFX.init && SKY.SFX.init(); SKY.Replay.openArchive(rec); };
        const save = document.createElement('button');
        save.className = 'sel-btn demo-save' + (rec.saved ? ' saved' : '');
        save.textContent = rec.saved ? '★ Saved' : '☆ Save';
        save.title = rec.saved ? 'Saved forever — click to unpin' : 'Keep this match forever';
        save.onclick = () => {
          rec.saved = !rec.saved;
          persist(rec);
          pruneMem();
          api.renderPanel();
        };
        btns.appendChild(watch);
        btns.appendChild(save);
        row.appendChild(btns);
        list.appendChild(row);
      }
    },
  };

  return api;
})();
