/* =============================================================================
 * SKY PUSH — HUD (plain DOM, no framework)
 * Sticker-booth style: tilted outlined panels, Titan One display font.
 * Power tier lives IN the crosshair (color + scale), not in a text label.
 * Death rewards: clickable cards (cursor released) or keys 1/2/3.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.HUD = (function () {
  const $ = (id) => document.getElementById(id);
  let el = {};
  let hitT = 0, centerT = 0, subT = 0, sbRefreshT = 0;
  let dmgT = 0, dmgMax = 1;
  let lastTier = -1, lastWeapon = '';
  let lootKeyHandler = null;
  let chatOpen = false;
  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---- themed dropdowns: the native <select> stays (all .value/.disabled/
     change wiring intact) but is hidden behind a styled trigger. The popup is
     PORTALED to <body> with fixed positioning so scroll containers and card
     edges can never clip it. ---- */
  let ddPop = null, ddOwner = null;   // one shared popup for all dropdowns
  function ddClose() {
    if (ddPop) ddPop.classList.add('hidden');
    ddOwner = null;
  }
  function dressSelect(sel) {
    if (sel._dressed) return;
    sel._dressed = true;
    const wrap = document.createElement('div');
    wrap.className = 'dd';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    const trig = document.createElement('button');
    trig.type = 'button';
    trig.className = 'dd-trig';
    wrap.appendChild(trig);
    if (!ddPop) {
      ddPop = document.createElement('div');
      ddPop.className = 'dd-pop hidden';
      document.body.appendChild(ddPop);
      ddPop.addEventListener('click', (e) => {
        const o = e.target.closest('.dd-opt');
        if (!o || !ddOwner) return;
        ddOwner.value = o.dataset.v;
        ddOwner.dispatchEvent(new Event('change', { bubbles: true }));
        ddClose();
      });
    }
    const optHtml = (o) =>
      `<div class="dd-opt${o.value === sel.value ? ' sel' : ''}" data-v="${o.value}">${o.textContent}</div>`;
    const sync = () => {
      const o = sel.selectedOptions[0];
      trig.textContent = o ? o.textContent : '—';
      wrap.classList.toggle('locked', sel.disabled);
    };
    trig.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sel.disabled) return;
      if (ddOwner === sel) { ddClose(); return; }
      let h = '';
      for (const node of sel.children) {
        if (node.tagName === 'OPTGROUP') {
          h += `<div class="dd-group">${node.label}</div>`;
          for (const o of node.children) h += optHtml(o);
        } else h += optHtml(node);
      }
      ddPop.innerHTML = h;
      // fixed-position under the trigger; flip up if the bottom would clip
      const r = trig.getBoundingClientRect();
      ddPop.style.left = r.left + 'px';
      ddPop.style.width = Math.max(r.width, 170) + 'px';
      ddPop.classList.remove('hidden');
      const ph = Math.min(ddPop.scrollHeight, 290);
      if (r.bottom + ph + 10 > window.innerHeight && r.top - ph - 10 > 0) {
        ddPop.style.top = (r.top - ph - 6) + 'px';
      } else {
        ddPop.style.top = (r.bottom + 5) + 'px';
      }
      ddOwner = sel;
    });
    sel.addEventListener('change', sync);
    sel._ddSync = sync;
    sync();
  }
  window.addEventListener('click', ddClose);
  window.addEventListener('resize', ddClose);
  window.addEventListener('wheel', (e) => {
    // scrolling INSIDE the popup scrolls the options — don't close it
    if (e.target.closest && e.target.closest('.dd-pop')) return;
    ddClose();
  }, { passive: true });

  const api = {
    botCount: 3,
    mapSel: 'sky',
    modeSel: 'dm',
    roundsSel: 2, livesSel: 3, crownSel: 25, sparkSel: 40, dmSel: 10, timeSel: 0,
    onPlay: null, onResume: null, onQuit: null,

    init() {
      el = {
        hud: $('hud'), menu: $('menu'), pause: $('pause-ov'),
        roundLabel: $('round-label'), timer: $('round-timer'), alive: $('alive-count'),
        pips: $('round-pips'), dots: $('alive-dots'),
        crownStatus: $('crown-status'), feed: $('killfeed'),
        lives: $('lives'), speedNum: $('speed-num'), speedFill: $('speed-bar-fill'),
        center: $('center-msg'), sub: $('sub-msg'),
        respawn: $('respawn-ov'), sb: $('scoreboard'), sbBody: $('sb-body'),
        hitmark: $('hitmark'), crosshair: $('crosshair'),
        dmgFlash: $('dmg-flash'), dmgDir: $('dmg-dir'),
        loot: $('loot-ov'), lootCards: $('loot-cards'),
        ammo: $('ammo'), ammoMax: $('ammo-max'), scope: $('scope'), ring: $('ring'),
        slot1: $('slot-1'), slot2: $('slot-2'),
        nades: $('nades'), sparks: $('sparks'), sparkNum: $('spark-num'),
        sparkFill: $('spark-fill'), lvTimer: $('lv-timer'),
        rb: $('round-banner'), rbName: $('rb-name'), rbStars: $('rb-stars'),
        rbTime: $('rb-time'), rbExtra: $('rb-extra'),
        dmBonus: $('dm-bonus'), dmbIcon: $('dmb-icon'), dmbName: $('dmb-name'),
        dmbTime: $('dmb-time'), loadout: $('loadout-ov'), loadoutGrid: $('loadout-grid'),
        cd: { pb: $('cd-pb'), ac: $('cd-ac'), gr: $('cd-gr'), ab: $('cd-ab') },
      };
      el.chLines = el.crosshair.querySelectorAll('.l');

      // vs-bots match setup — proper dropdowns instead of the pill wall
      const MODE_HINTS = {
        dm: 'One timed round: KOs score points, assists pay less, the rotating bonus weapon pays extra. Pick your loadout with B.',
        lbs: 'Limited lives, first to the round target wins the match. Fall off = lose a life.',
        crown: 'Grab the crown and HOLD it — total hold time wins. Dying drops it where the crown home is.',
        it: 'One SEEKER hunts with a point-blank tag cannon that sends you FLYING. Runners get only hook + air cannon — dodge, hide, survive the clock.',
      };
      const wireSel = (id, set) => {
        const el = $(id);
        el.addEventListener('change', () => set(el.value));
        return el;
      };
      wireSel('bots-select', v => { api.botCount = parseInt(v, 10); });
      wireSel('map-select', v => { api.mapSel = v; SKY.Game.previewMap(v); });
      const modeRows = (v) => {
        document.querySelectorAll('.r-dm').forEach(e => e.classList.toggle('hidden', v !== 'dm'));
        document.querySelectorAll('.r-rl').forEach(e => e.classList.toggle('hidden', v === 'dm'));
        document.querySelectorAll('.r-crown').forEach(e => e.classList.toggle('hidden', v !== 'crown'));
        const hint = $('mode-hint');
        if (hint) hint.textContent = MODE_HINTS[v] || '';
      };
      wireSel('mode-select', v => { api.modeSel = v; modeRows(v); });
      wireSel('dm-select', v => { api.dmSel = +v; });
      wireSel('time-select', v => { api.timeSel = parseInt(v, 10); });
      wireSel('rounds-select', v => { api.roundsSel = parseInt(v, 10); });
      wireSel('lives-select', v => { api.livesSel = parseInt(v, 10); });
      wireSel('crown-select', v => { api.crownSel = parseInt(v, 10); });
      $('mode-select').value = api.modeSel;
      modeRows(api.modeSel);
      // PLAY hub: secondary chips toggle the drawer (vs bots / lobby browser)
      document.querySelectorAll('.play-sub').forEach(b => {
        b.addEventListener('click', () =>
          api.playSub(b.classList.contains('sel') ? '' : b.dataset.v));
      });
      $('drawer-close').addEventListener('click', () => api.playSub(''));
      // the hero button: ZERO-friction online — auto guest name, quick join
      $('quick-play').addEventListener('click', () => {
        SKY.SFX.init();
        api.playSub('online');
        SKY.Net.quickPlay();
      });
      $('nav-nick').addEventListener('click', () => SKY.Net.renameNick());
      // soft UI tick on any interactive menu element (400 pack select_*)
      document.addEventListener('click', (e) => {
        if (!e.target.closest) return;
        if (e.target.closest('button, .dd, .dd-pop, .play-sub, .tab, .lk-tab, ' +
            '.mode-card, .loot-card, input[type=checkbox], .seg-btn, .nav-item')) {
          SKY.SFX.ui();
        }
      }, true);
      api.refreshNick();
      SKY.MapData.onListChange = () => api.refreshCustomMaps();
      api.refreshCustomMaps();
      api.dressSelects('#menu');   // themed dropdowns over every menu select

      // add-friend from the match-end table (in-game friending)
      const meT = $('me-table');
      if (meT) meT.addEventListener('click', (e) => {
        const b = e.target.closest('[data-addfr]');
        if (!b || !SKY.Account) return;
        b.disabled = true;
        SKY.Account.addFriendByUsername(b.dataset.addfr).then((r) => {
          b.textContent = r.error ? '✕' : '✓';
          b.title = r.error || 'request sent';
        });
      });
      $('play-btn').addEventListener('click', () => api.onPlay && api.onPlay());
      $('resume-btn').addEventListener('click', () => api.onResume && api.onResume());
      $('quit-btn').addEventListener('click', () => api.onQuit && api.onQuit());
      $('open-settings').addEventListener('click', () => SKY.Settings.open());
      $('pause-settings').addEventListener('click', () => SKY.Settings.open());

      // ENTER = chat (online only). Opens over the lobby AND mid-match; the
      // input owns the keyboard while it's up (Input.setTyping suspends game
      // keys), ESC cancels, Enter sends.
      window.addEventListener('keydown', (e) => {
        if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Escape') return;
        if (chatOpen) {
          e.preventDefault();
          e.stopPropagation();
          api.chatClose(e.code !== 'Escape');
          return;
        }
        if (e.code === 'Escape') return;
        if (!SKY.Net.online) return;
        // never steal Enter from real inputs (nickname modal, editor fields…)
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
        if (SKY.Replay.active || (SKY.Editor && SKY.Editor.active)) return;
        const inLobby = SKY.Game.state === 'menu' && !$('mp-lobby').classList.contains('hidden');
        const inMatch = SKY.Game.state !== 'menu';
        if (!inLobby && !inMatch) return;
        e.preventDefault();
        api.chatOpen();
      }, true);
      $('chat-input').addEventListener('keydown', (e) => e.stopPropagation());
    },

    /* map dropdowns: built-ins + an optgroup of custom maps (editor drafts /
       deployed / net-received). Selection survives the rebuild. */
    refreshCustomMaps() {
      const BUILTIN = [['sky', 'Sky Arena'], ['yacht', 'Yacht'], ['convoy', 'Convoy'],
        ['foundry', 'Foundry'], ['rooftop', 'Rooftops'], ['temple', 'Temple'],
        ['terminal', 'Terminal']];
      const opts = (current) => {
        let h = BUILTIN.map(([id, name]) =>
          `<option value="${id}"${id === current ? ' selected' : ''}>${name}</option>`).join('');
        const customs = SKY.MapData.list();
        if (customs.length) {
          h += '<optgroup label="Your maps">' + customs.map(d =>
            `<option value="${d.id}"${d.id === current ? ' selected' : ''}>${d.name}</option>`).join('') +
            '</optgroup>';
        }
        return h;
      };
      const ms = $('map-select');
      if (ms) ms.innerHTML = opts(api.mapSel);
      const ls = $('lmap-select');
      if (ls) ls.innerHTML = opts(SKY.Net && SKY.Net.online ? SKY.Net.settings.map : api.mapSel);
      api.syncSelects();
    },

    /* PLAY hub state: '' = hero landing, 'bots'/'online' = drawer,
       'lobby' = fullscreen lobby stage (Net drives that one) */
    playSub(v) {
      document.querySelectorAll('.play-sub').forEach(b =>
        b.classList.toggle('sel', b.dataset.v === v));
      const lobby = v === 'lobby';
      $('play-drawer').classList.toggle('hidden', lobby || !v);
      $('play-bots').classList.toggle('hidden', v !== 'bots');
      $('play-online').classList.toggle('hidden', v !== 'online');
      $('play-hero').classList.toggle('hidden', lobby);
      $('play-actions').classList.toggle('hidden', lobby);
      const mc = $('menu-char-wrap');
      if (mc) mc.classList.toggle('hidden', lobby);   // real characters take over
      if (v === 'online') SKY.Net.enterOnline();
    },

    /* top-bar nickname chip mirrors the saved (or guest) name */
    refreshNick() {
      const el = $('nav-nick');
      if (el) el.textContent = (SKY.Settings.data.nickname || '').trim() || 'pick a name';
    },

    /* themed-dropdown helpers (settings panel dresses its own on rebuild) */
    dressSelects(rootSel) {
      document.querySelectorAll(rootSel + ' select').forEach(dressSelect);
    },
    syncSelects() {
      document.querySelectorAll('select').forEach(s => { if (s._ddSync) s._ddSync(); });
    },

    showMenu() { el.menu.classList.remove('hidden'); el.hud.classList.add('hidden'); api.relockHint(false); },
    hideMenu() { el.menu.classList.add('hidden'); el.hud.classList.remove('hidden'); },
    setPause(on) {
      el.pause.classList.toggle('hidden', !on);
      if (on) {
        // online it's an in-match MENU (the game keeps running), not a pause
        const online = SKY.Net.online;
        $('pause-title').textContent = online ? 'Menu' : 'Paused';
        $('pause-hint').classList.toggle('hidden', !online);
        $('resume-btn').textContent = online ? 'Back to game' : 'Resume';
        api.relockHint(false);
      }
    },
    relockHint(on) {
      const h = $('relock-hint');
      if (h) h.classList.toggle('hidden', !on);
    },
    /* hide crosshair/ammo/chips/speedo while dead, eliminated or in menus */
    combat(on) { el.hud.classList.toggle('spectating', !on); },

    centerMsg(text, dur, px) {
      el.center.textContent = text;
      el.center.style.fontSize = (px || 86) + 'px';
      el.center.style.opacity = 1;
      // retrigger the punch-in animation
      el.center.classList.remove('punch');
      void el.center.offsetWidth;
      el.center.classList.add('punch');
      centerT = dur;
    },
    subMsg(text, dur) {
      el.sub.textContent = text;
      el.sub.style.opacity = 1;
      el.sub.classList.remove('punch');
      void el.sub.offsetWidth;
      el.sub.classList.add('punch');
      subT = dur;
    },

    killFeed(html) {
      const d = document.createElement('div');
      d.className = 'feed-item';
      d.innerHTML = html;
      el.feed.appendChild(d);
      while (el.feed.children.length > 6) el.feed.removeChild(el.feed.firstChild);
      setTimeout(() => { if (d.parentNode) d.classList.add('fading'); }, 5600);
      setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 6100);
    },

    /* -------- pickup toast: what you just grabbed, front and center --------
       (pickups used to announce themselves in the killfeed, where nobody
       looks — now it's a sticker right above the weapon bar) */
    pickupToast(item) {
      const t = $('pickup-toast');
      if (!t) return;
      const d = SKY.Loot.describe(item);
      const r = SKY.Loot.RARITY[item.rarity] || { label: '', color: '#c6cdd9' };
      t.innerHTML =
        `<span class="pt-ico" style="color:${d.color || r.color}">${d.glyph || ''}</span>
         <span class="pt-tx"><b style="color:${r.color}">${d.name}</b><small>${d.desc || ''}</small></span>`;
      t.classList.remove('hidden', 'punch');
      void t.offsetWidth;
      t.classList.add('punch');
      clearTimeout(t._hideT);
      t._hideT = setTimeout(() => t.classList.add('hidden'), 2800);
    },

    /* -------- text chat (Enter) — online lobby + in-game -------- */
    chatTyping() { return chatOpen; },
    chatAdd(name, color, text) {
      const log = $('chat-log');
      if (!log) return;
      const d = document.createElement('div');
      d.className = 'chat-msg';
      d.innerHTML = `<b style="color:${color || '#ffd34d'}">${esc(name)}</b> ${esc(text)}`;
      log.appendChild(d);
      while (log.children.length > 14) log.removeChild(log.firstChild);
      setTimeout(() => d.classList.add('old'), 8000);
    },
    chatOpen() {
      if (chatOpen || !SKY.Net.online) return;
      chatOpen = true;
      SKY.Input.setTyping(true);
      $('chat').classList.add('open');
      $('chat-entry').classList.remove('hidden');
      const inp = $('chat-input');
      inp.value = '';
      inp.focus();
    },
    chatClose(sendIt) {
      if (!chatOpen) return;
      const inp = $('chat-input');
      const text = inp.value;
      chatOpen = false;
      SKY.Input.setTyping(false);
      $('chat').classList.remove('open');
      $('chat-entry').classList.add('hidden');
      inp.blur();
      if (sendIt && text.trim()) {
        SKY.Net.sendChat(text);
        // your own line shows immediately (the host relays to everyone else)
        const me = SKY.Net.roster.find(r => r.id === SKY.Net.myId);
        api.chatAdd(me ? me.name : 'you', me ? me.color : '#ffd34d', text.trim().slice(0, 120));
      }
    },

    /* CS:GO-style round-won banner: winner + stars up top while the arena
       stays live; countdown is refreshed each tick via roundBannerTime.
       roundBanner(null) hides it. */
    roundBanner(name, color, stars, secs, extra) {
      if (name === null || name === undefined) { el.rb.classList.add('hidden'); return; }
      el.rbName.textContent = name;
      el.rbName.style.color = color || '';
      el.rbStars.textContent = stars || '';
      el.rbStars.classList.toggle('hidden', !stars);
      el.rbExtra.textContent = extra || '';
      el.rb.classList.remove('hidden');
      // retrigger the pop-in
      el.rb.classList.remove('punch'); void el.rb.offsetWidth;
      el.rb.classList.add('punch');
      api.roundBannerTime(secs);
    },
    roundBannerTime(secs) {
      if (!el.rb || el.rb.classList.contains('hidden')) return;
      setText(el.rbTime, 'next round in ' + Math.max(0, secs || 0).toFixed(1) + 's');
    },

    hitmark(tier, head) {
      hitT = 0.25 + tier * 0.06;
      el.hitmark.style.opacity = 1;
      const s = 1 + tier * 0.25;
      el.hitmark.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${s})`;
      el.hitmark.querySelectorAll('.l').forEach(l => { l.style.background = head ? '#ff5a4a' : '#ffffff'; });
    },

    /* incoming damage: red flash scaled by force + an arc toward the shooter.
       Headshots flash harder and the arc goes white. */
    damage(impulse, head) {
      if (!el.dmgFlash) return;
      const k = SKY.U.clamp01(impulse.length() / 22);
      dmgT = Math.max(dmgT, 0.22 + k * 0.4 + (head ? 0.25 : 0));
      dmgMax = dmgT;
      el.dmgFlash.classList.toggle('head', !!head);
      // the shot came from the opposite of the push direction
      const src = Math.atan2(-impulse.x, -impulse.z);
      const rel = SKY.U.angDelta(SKY.Input.yaw, src);
      const arc = document.createElement('div');
      arc.className = 'dmg-arc' + (head ? ' head' : '');
      arc.style.transform = `rotate(${(-rel * 180 / Math.PI).toFixed(1)}deg)`;
      el.dmgDir.appendChild(arc);
      while (el.dmgDir.children.length > 4) el.dmgDir.removeChild(el.dmgDir.firstChild);
      setTimeout(() => { if (arc.parentNode) arc.parentNode.removeChild(arc); }, 850);
    },

    scope(on) {
      el.scope.classList.toggle('hidden', !on);
      el.crosshair.classList.toggle('hidden', on);
    },

    showRespawn(text) {
      if (!text) el.respawn.classList.add('hidden');
      else { el.respawn.classList.remove('hidden'); el.respawn.textContent = text; }
    },

    /* -------- death reward cards: click OR 1/2/3 (or skip) -------- */
    showLoot(choices, onPick, onSkip) {
      api.showRespawn(null);   // the cards own the screen — no pill underneath
      el.loot.querySelector('.loot-title').textContent = 'Choose a reward';
      el.loot.querySelector('.loot-sub').textContent = 'click · or press 1 / 2 / 3';
      el.lootCards.innerHTML = choices.map((it, i) => {
        const d = SKY.Loot.describe(it);
        const r = SKY.Loot.RARITY[it.rarity];
        const vis = d.img
          ? `<img src="${d.img}" alt="">`
          : `<span style="color:${d.color}">${d.glyph || ''}</span>`;
        return `<div class="loot-card r-${it.rarity}" data-i="${i}">
          <div class="keycap">${i + 1}</div>
          <div class="loot-kind">${d.kind}</div>
          <div class="loot-vis">${vis}</div>
          <div class="loot-name">${d.name}</div>
          <div class="loot-rarity" style="color:${r.color}">${r.label}</div>
          <div class="loot-desc">${d.desc}</div>
        </div>`;
      }).join('');
      el.loot.classList.remove('hidden');
      el.lootCards.querySelectorAll('.loot-card').forEach(card => {
        card.addEventListener('click', () => onPick(parseInt(card.dataset.i, 10)));
      });
      // SKIP: respawn without taking anything
      const oldSkip = el.loot.querySelector('#loot-skip');
      if (oldSkip) oldSkip.remove();
      const skip = document.createElement('button');
      skip.className = 'btn small';
      skip.id = 'loot-skip';
      skip.textContent = 'Skip — no reward';
      skip.addEventListener('click', () => (onSkip || (() => SKY.Game.skipLoot()))());
      el.loot.appendChild(skip);
      // key picks handled here (inside the event = valid user gesture for
      // re-locking the pointer afterwards)
      lootKeyHandler = (e) => {
        const m = e.code.match(/^Digit([123])$/);
        if (m) onPick(parseInt(m[1], 10) - 1);
      };
      window.addEventListener('keydown', lootKeyHandler);
    },

    hideLoot(pickedIndex) {
      if (lootKeyHandler) { window.removeEventListener('keydown', lootKeyHandler); lootKeyHandler = null; }
      if (pickedIndex === undefined || pickedIndex === null) {
        el.loot.classList.add('hidden');
        return;
      }
      const cards = el.lootCards.querySelectorAll('.loot-card');
      cards.forEach((c, i) => c.classList.add(i === pickedIndex ? 'picked' : 'dismissed'));
      setTimeout(() => { el.loot.classList.add('hidden'); el.lootCards.innerHTML = ''; }, 420);
    },

    scoreboard(show) { el.sb.classList.toggle('hidden', !show); },

    /* spectate pill (eliminated players riding someone else's run) */
    spectate(tgt, orbit) {
      const elx = $('spec-ov');
      if (!elx) return;
      if (!tgt) {
        if (!elx.classList.contains('hidden')) elx.classList.add('hidden');
        elx._k = '';
        return;
      }
      const k = tgt.name + (orbit ? 1 : 0);
      if (elx._k !== k) {
        elx._k = k;
        elx.innerHTML = `<small>SPECTATING</small> <b style="color:${tgt.color}">${tgt.name}</b>
          <span>LMB next · RMB prev · SPACE ${orbit ? 'follow' : 'orbit'}</span>`;
        elx.classList.remove('hidden');
      }
    },

    /* -------- end-of-match screen: winner, podium stats, the table -------- */
    showMatchEnd(winner, payout) {
      const G = SKY.Game;
      const ov = $('match-ov');
      if (!ov) return;
      const rows = [...G.pawns].sort((a, b) =>
        ((b.mk || 0) - (a.mk || 0)) || ((a.md || 0) - (b.md || 0)));
      const kd = (p) => ((p.mk || 0) / Math.max(1, p.md || 0)).toFixed(1);
      const top = (fn, label, unit) => {
        const best = rows.slice().sort((a, b) => fn(b) - fn(a))[0];
        return best && fn(best) > 0
          ? `<div class="me-chip"><small>${label}</small><b style="color:${best.color}">${best.name}</b><span>${fn(best)}${unit || ''}</span></div>`
          : '';
      };
      const me = G.player;
      $('me-winner').innerHTML = winner
        ? `<b style="color:${winner.color}">${winner.name}</b> WINS THE MATCH`
        : 'MATCH OVER';
      $('me-podium').innerHTML =
        top(p => p.mk || 0, 'Most KOs', '') +
        top(p => +kd(p), 'Best K/D', '') +
        top(p => p.ma || 0, 'Most assists', '');
      const canFr = (p) => p.acct && !p.isLocal && SKY.Account && SKY.Account.isLoggedIn() &&
        !SKY.Account.friends().some(f => String(f.username) === String(p.name));
      $('me-table').innerHTML =
        `<tr><th></th><th>K</th><th>D</th><th>A</th><th>K/D</th></tr>` +
        rows.map(p => `<tr class="${p.isLocal ? 'me' : ''}${p === winner ? ' win' : ''}">
          <td style="color:${p.color}">${SKY.U.avatarHtml(p.av, p.color, p.name)} ${p.name}${p === winner ? ' 👑' : ''}
            ${canFr(p) ? `<button class="fr-btn" data-addfr="${p.name}">+</button>` : ''}</td>
          <td>${p.mk || 0}</td><td>${p.md || 0}</td><td>${p.ma || 0}</td><td>${kd(p)}</td>
        </tr>`).join('');
      $('me-mystats').innerHTML = me
        ? `<small>YOUR MATCH</small>
           <div><b>${me.mk || 0}</b><span>knockouts</span></div>
           <div><b>${me.md || 0}</b><span>knocked out</span></div>
           <div><b>${me.ma || 0}</b><span>assists</span></div>
           <div><b>${kd(me)}</b><span>k/d</span></div>` +
          (payout ? `<div><b>+${payout}</b><span>⬡ earned</span></div>` : '')
        : '';
      ov.classList.remove('hidden');
    },
    hideMatchEnd() {
      const ov = $('match-ov');
      if (ov) ov.classList.add('hidden');
    },

    /* -------- DEATHMATCH loadout picker (B) -------- */
    showLoadout(weapons, current, onPick) {
      const G = SKY.Game;
      el.loadoutGrid.innerHTML = '';
      for (const k of weapons) {
        const W = SKY.TUNING.weapons[k] || {};
        const card = document.createElement('div');
        const isBonus = G.dmBonusWeapon === k;
        card.className = 'lo-card' + (current === k ? ' on' : '') + (isBonus ? ' bonus' : '');
        const rar = RARITY_GLOW[W.rarity] || '#c6cdd9';
        const src = SKY.Effects.weaponWireIcon(k, rar);
        card.innerHTML = (src ? `<img src="${src}" alt="">` : '') +
          `<b>${(W.short || W.label || k).toUpperCase()}</b>` +
          `<small>${isBonus ? 'BONUS +' + SKY.TUNING.dm.bonusPts + ' PTS' : (W.rarity || '')}</small>`;
        card.onclick = () => onPick(k);
        el.loadoutGrid.appendChild(card);
      }
      el.loadout.classList.remove('hidden');
    },
    hideLoadout() { if (el && el.loadout) el.loadout.classList.add('hidden'); },

    /* -------- SPARK RUSH level-up: same cards, but LIVE --------
     * No pause, no cursor: the row docks low, keys 1/2/3 pick, a thin bar
     * counts down to an auto-pick. Clicking is pointless (pointer stays
     * locked) so cards aren't clickable here. */
    showLevelUp(choices, level) {
      api.showLoot(choices, (i) => SKY.Game.pickLoot(i));
      el.loot.querySelector('.loot-title').textContent = 'LEVEL ' + level;
      el.loot.querySelector('.loot-sub').textContent = '1 / 2 / 3 — auto-picks when the bar runs out';
      el.loot.classList.add('quick');
      el.lvTimer.classList.remove('hidden');
      api.subMsg('LEVEL UP — pick with 1 / 2 / 3', 2.2);
    },
    levelUpTimer(frac) {
      if (!el.lvTimer._fill) el.lvTimer._fill = el.lvTimer.querySelector('div');
      setW(el.lvTimer._fill, SKY.U.clamp01(frac) * 100);
    },
    hideLevelUp(pickedIndex) {
      el.lvTimer.classList.add('hidden');
      api.hideLoot(pickedIndex);
      setTimeout(() => el.loot.classList.remove('quick'), 430);
    },

    /* called every render frame */
    update(dt) {
      const G = SKY.Game;
      if (centerT > 0) { centerT -= dt; if (centerT <= 0) el.center.style.opacity = 0; }
      if (subT > 0) { subT -= dt; if (subT <= 0) el.sub.style.opacity = 0; }
      if (hitT > 0) { hitT -= dt; if (hitT <= 0) el.hitmark.style.opacity = 0; }
      if (dmgT > 0) {
        dmgT -= dt;
        el.dmgFlash.style.opacity = Math.max(0, dmgT / Math.max(0.001, dmgMax)) * 0.95;
      }

      const p = G.player;
      if (!p || G.state === 'menu') return;

      // oxygen bar: shows while the head is under (or lungs not yet refilled)
      const o2 = $('o2');
      if (o2) {
        const show = p.alive && (p._headUnder || (p.oxygen !== undefined && p.oxygen < 0.999));
        o2.classList.toggle('hidden', !show);
        if (show) {
          const f = $('o2-fill');
          if (f) f.style.width = Math.round(SKY.U.clamp01(p.oxygen) * 100) + '%';
          o2.classList.toggle('low', p.oxygen < 0.35);
        }
      }

      const spd = p.speedH();
      const push = SKY.Weapons.computePush(p);
      setHTML(el.speedNum, spd.toFixed(1) + ' <small>m/s</small>');
      if (el.speedNum._c !== push.color) {
        el.speedNum._c = push.color;
        el.speedNum.style.color = push.color;
      }
      setW(el.speedFill, SKY.U.clamp01(spd / 24) * 100);

      if (push.tier !== lastTier) {
        lastTier = push.tier;
        el.chLines.forEach(l => { l.style.background = push.color; });
        el.crosshair.style.transform = `translate(-50%,-50%) scale(${1 + push.tier * 0.14})`;
      }

      // weapon slots (1 = pickup, 2 = pistol) — side-profile weapon icons
      if (p.slots) {
        const w1 = p.slots[1];
        const key = (w1 || '') + '|' + p.activeSlot;
        if (el.slot1._k !== key) {
          el.slot1._k = key;
          setSlotVisual(el.slot1, w1);
          setSlotVisual(el.slot2, 'pistol');
          el.slot1.classList.toggle('empty', !w1);
          el.slot1.classList.toggle('on', p.activeSlot === 1);
          el.slot2.classList.toggle('on', p.activeSlot === 2);
        }
      }

      // grenade chip: outline icon in a small box beside the weapon slots
      if (p.nades && p.nades.count > 0) {
        el.nades.classList.remove('hidden');
        const N = SKY.TUNING.grenades[p.nades.type];
        const nsrc = SKY.Effects.nadeWireIcon(p.nades.type, N.color);
        setHTML(el.nades,
          `<b>G</b>` +
          (nsrc ? `<img class="ni" src="${nsrc}" alt="">`
                : `<i class="nade-pip" style="background:${N.color};box-shadow:0 0 6px ${N.color}"></i>`) +
          `<span class="nc">×${p.nades.count}</span>`);
      } else el.nades.classList.add('hidden');

      // mode-specific readouts
      setText(el.roundLabel, G.mode === 'spark' ? 'SPARK' : 'R' + G.roundNum);
      // round pips: local player's round wins toward the match (not in spark)
      let pipsHtml = '';
      if (G.mode !== 'spark') {
        for (let i = 0; i < SKY.TUNING.game.roundsToWin; i++) {
          pipsHtml += `<span class="pip${i < p.roundWins ? ' on' : ''}"></span>`;
        }
      }
      setHTML(el.pips, pipsHtml);
      // player icons up top (profile avatars; colored-initial discs for
      // guests/bots) — dimmed when down, ghosted when eliminated
      setHTML(el.dots, G.pawns.filter(q => !q.left).map(q =>
        SKY.U.avatarHtml(q.av, q.color, q.name,
          (q.eliminated ? 'out' : q.alive ? '' : 'dead') +
          (q._talking ? ' spk' : ''))).join(''));
      if (G.mode === 'spark') {
        el.lives.classList.add('hidden');
        el.crownStatus.classList.add('hidden');
        el.alive.classList.remove('hidden');
        const C = SKY.TUNING.spark;
        const lead = G.crownHolder;
        setText(el.alive, lead ? (lead.isLocal ? 'You lead' : lead.name + ' leads · ' + lead.sparks) : 'No leader yet');
        el.sparks.classList.remove('hidden');
        setHTML(el.sparkNum, '✦ ' + (p.sparks || 0) + ' <small>/ ' + C.target + '</small>');
        const next = C.levels[p.sparkLevel];
        setW(el.sparkFill, next === undefined ? 100
          : 100 * SKY.U.clamp01((p.sparks || 0) / next));
        // count DOWN to the buzzer
        const left = Math.max(0, C.timeLimit - G.roundTime);
        setText(el.timer, Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0'));
        const tc = left <= C.frenzyAt ? 'var(--danger)' : '';
        if (el.timer._c !== tc) { el.timer._c = tc; el.timer.style.color = tc; }
      } else {
        el.sparks.classList.add('hidden');
      }
      if (G.mode === 'it') {
        el.lives.classList.add('hidden');
        el.sparks.classList.add('hidden');
        el.crownStatus.classList.remove('hidden');
        el.alive.classList.remove('hidden');
        const seeker = G.pawns.find(q => q.isSeeker);
        const hideLeft = SKY.TUNING.it.hideTime - G.roundTime;
        setText(el.crownStatus, seeker
          ? (hideLeft > 0 ? '👹 ' + seeker.name + ' in ' + Math.ceil(hideLeft)
             : '👹 ' + seeker.name)
          : 'IT');
        setText(el.alive,
          G.pawns.filter(q => !q.isSeeker && !q.eliminated).length + ' runners');
      } else if (G.mode === 'crown') {
        el.lives.classList.add('hidden');
        el.alive.classList.add('hidden');
        el.crownStatus.classList.remove('hidden');
        el.sparks.classList.add('hidden');
        const C = SKY.TUNING.crown;
        setText(el.crownStatus, G.crownHolder
          ? 'Crown · ' + G.crownHolder.name + ' ' + Math.floor(G.crownHolder.crownTime) + '/' + C.holdToWin
          : 'Crown · free');
      } else if (G.mode !== 'spark' && G.mode !== 'dm') {
        el.crownStatus.classList.add('hidden');
        el.lives.classList.remove('hidden');
        el.alive.classList.remove('hidden');
        let hearts = '';
        for (let i = 0; i < SKY.TUNING.game.lives; i++) {
          hearts += i < p.lives ? '♥' : '<span class="lost">♥</span>';
        }
        setHTML(el.lives, hearts);
        setText(el.alive, G.pawns.filter(q => !q.eliminated).length + ' left');
      }

      // DEATHMATCH: points + leader + buzzer countdown + the bonus weapon
      if (G.mode === 'dm') {
        const C = SKY.TUNING.dm;
        el.lives.classList.add('hidden');
        el.crownStatus.classList.add('hidden');
        el.alive.classList.remove('hidden');
        const lead = G.crownHolder;
        setText(el.alive, lead ? (lead.isLocal ? 'You lead' : lead.name + ' leads · ' + lead.sparks) : 'No leader yet');
        el.sparks.classList.remove('hidden');
        setHTML(el.sparkNum, '★ ' + (p.sparks || 0) + ' <small>PTS</small>');
        setW(el.sparkFill, 0);
        const left = Math.max(0, C.timeLimit - G.roundTime);
        setText(el.timer, Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0'));
        const tc = left <= 60 ? 'var(--danger)' : '';
        if (el.timer._c !== tc) { el.timer._c = tc; el.timer.style.color = tc; }
        el.dmBonus.classList.remove('hidden');
        const bw = G.dmBonusWeapon;
        if (bw && el.dmBonus._w !== bw) {
          el.dmBonus._w = bw;
          setText(el.dmbName, bw.toUpperCase());
          const src = SKY.Effects.weaponWireIcon(bw, '#ffd34d');
          if (src) el.dmbIcon.src = src;
        }
        const bleft = Math.max(0, SKY.TUNING.dm.bonusEvery - (G.roundTime % SKY.TUNING.dm.bonusEvery));
        setText(el.dmbTime, '0:' + String(Math.floor(bleft)).padStart(2, '0'));
      } else {
        el.dmBonus.classList.add('hidden');
      }

      if (G.mode !== 'spark' && G.mode !== 'dm') {
        // with a round limit set the clock counts DOWN and goes red late
        const lim = SKY.TUNING.game.timeLimit || 0;
        const t = lim > 0 ? Math.max(0, lim - G.roundTime) : Math.max(0, G.roundTime);
        setText(el.timer, Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0'));
        const tc = lim > 0 && t <= 30 ? 'var(--danger)' : '';
        if (el.timer._c !== tc) { el.timer._c = tc; el.timer.style.color = tc; }
      }

      // ammo + weapon chip (bar shows reload progress while reloading);
      // bare hands (IT runners) show no ammo at all
      const wDef = SKY.Weapons.defOf(p);
      if (lastWeapon !== p.weapon) {
        lastWeapon = p.weapon;
        el.cd.pb.querySelector('.n').textContent =
          p.weapon ? (wDef.short || wDef.label) : '—';
      }
      setText(el.ammo, p.weapon ? String(p.ammo) : '');
      setText(el.ammoMax, p.weapon ? '/' + wDef.mag : '');
      const ac = p.reloadT > 0 ? '#ff9a3d' : (p.ammo === 0 ? '#ff5a4a' : '#fff');
      if (el.ammo._c !== ac) { el.ammo._c = ac; el.ammo.style.color = ac; }
      // crosshair ring: reload progress, or the piston's charge meter
      if (el.ring) {
        const chT = p.chargeT || 0;
        if (p.reloadT > 0) {
          const frac = 1 - p.reloadT / (wDef.reloadTime * p.mods.cdMult);
          el.ring.style.display = 'block';
          el.ring.style.width = el.ring.style.height = '46px';
          el.ring.style.background =
            `conic-gradient(#ff9a3d ${Math.round(frac * 360)}deg, rgba(255,255,255,.13) 0)`;
        } else if (chT > 0 && wDef.charge) {
          const t01 = Math.min(1, chT / wDef.charge);
          const col = t01 >= 1 ? '#ff5a4a' : '#ffd34d';
          const s = Math.round(46 + t01 * 12 + (t01 >= 1 ? Math.sin(performance.now() * 0.02) * 3 : 0));
          el.ring.style.display = 'block';
          el.ring.style.width = el.ring.style.height = s + 'px';
          el.ring.style.background =
            `conic-gradient(${col} ${Math.round(t01 * 360)}deg, rgba(255,255,255,.13) 0)`;
        } else if (el.ring.style.display !== 'none') {
          el.ring.style.display = 'none';
        }
      }
      if (p.reloadT > 0) setCd(el.cd.pb, p.reloadT, wDef.reloadTime * p.mods.cdMult);
      else setCd(el.cd.pb, p.pbCd, wDef.cooldown * p.mods.cdMult);
      setCd(el.cd.ac, p.acCd, SKY.TUNING.cannon.cooldown * p.mods.cdMult);
      setCd(el.cd.gr, p.grapple ? 1 : p.grappleCd, SKY.TUNING.grapple.cooldown * p.mods.grappleCdMult);
      el.cd.ab.classList.toggle('hidden', !p.abilities.dash);
      if (p.abilities.dash) setCd(el.cd.ab, p.dashCd, SKY.TUNING.abilities.dashCooldown);

      sbRefreshT -= dt;
      if (!el.sb.classList.contains('hidden') && sbRefreshT <= 0) {
        sbRefreshT = 0.25;
        api.refreshScoreboard();
      }
    },

    refreshScoreboard() {
      const G = SKY.Game;
      const online = SKY.Net.online;
      const rows = [...G.pawns].sort((a, b) =>
        (G.mode === 'spark' || G.mode === 'dm')
          ? ((b.sparks || 0) - (a.sparks || 0)) || (b.koCount - a.koCount)
          : (b.roundWins - a.roundWins) || ((b.mk || 0) - (a.mk || 0)));
      el.sbBody.innerHTML = rows.map(p => {
        const cls = (p.isLocal ? 'me' : '') + (p.eliminated ? ' out' : '');
        const status = p.left ? 'LEFT'
          : p.eliminated ? 'OUT'
          : (G.mode === 'it' && p.isSeeker) ? '👹 SEEKER'
          : (p.alive ? '' : 'respawning');
        const score = G.mode === 'spark' ? '✦' + (p.sparks || 0)
          : G.mode === 'dm' ? '★' + (p.sparks || 0)
          : G.mode === 'crown' ? Math.floor(p.crownTime) + 's'
          : G.mode === 'it' ? ''
          : '♥'.repeat(Math.max(0, p.lives));
        const kd = ((p.mk || 0) / Math.max(1, p.md || 0)).toFixed(1);
        const ping = p.isBot ? 'bot'
          : !online ? '—'
          : p.netId === 'host' ? 'host'
          : (SKY.Net.pings[p.netId] !== undefined ? SKY.Net.pings[p.netId] + 'ms' : '…');
        return `<tr class="${cls}">
          <td class="sb-name" style="color:${p.color}">${SKY.U.avatarHtml(p.av, p.color, p.name)}${p.name}${p.isLocal ? ' <i>you</i>' : ''}</td>
          <td>${'★'.repeat(p.roundWins)}</td>
          <td>${score}</td>
          <td>${p.mk || 0}</td><td>${p.md || 0}</td><td>${p.ma || 0}</td><td>${kd}</td>
          <td>${ping}</td><td class="sb-status">${status}</td></tr>`;
      }).join('');
    },
  };

  function setCd(chip, cd, max) {
    const f = 1 - SKY.U.clamp01(cd / max);
    if (!chip._fill) chip._fill = chip.querySelector('.fill');
    setW(chip._fill, f * 100);
    if (chip._cooling !== (f < 1)) {
      chip._cooling = f < 1;
      chip.classList.toggle('cooling', f < 1);
    }
  }

  /* one weapon slot: minimalist rarity-tinted wireframe (CS:GO style),
     text fallback otherwise */
  const RARITY_GLOW = { starter: '#c6cdd9', common: '#c6cdd9', rare: '#40c8ff', epic: '#ff5db1' };
  function setSlotVisual(slotEl, weaponId) {
    const img = slotEl.querySelector('.si');
    const sn = slotEl.querySelector('.sn');
    const rar = weaponId ? RARITY_GLOW[SKY.TUNING.weapons[weaponId].rarity] || '#c6cdd9' : null;
    const icon = weaponId ? SKY.Effects.weaponWireIcon(weaponId, rar) : null;
    if (icon) {
      if (img.src !== icon) {
        img.src = icon;
        // soft rarity glow around the wireframe
        img.style.filter = `drop-shadow(0 0 5px ${rar}66)`;
      }
      img.classList.remove('hidden');
      sn.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      sn.classList.remove('hidden');
      sn.textContent = weaponId ? (SKY.TUNING.weapons[weaponId].short || weaponId) : '—';
    }
  }

  /* DOM writes are surprisingly expensive at 100+ fps — every helper below
     skips the write when the value hasn't actually changed */
  function setText(elm, s) { if (elm._t !== s) { elm._t = s; elm.textContent = s; } }
  function setHTML(elm, s) { if (elm._t !== s) { elm._t = s; elm.innerHTML = s; } }
  function setW(elm, pct) {
    const v = Math.round(pct * 2) / 2;
    if (elm._w !== v) { elm._w = v; elm.style.width = v + '%'; }
  }

  return api;
})();
