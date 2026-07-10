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

  const api = {
    botCount: 3,
    mapSel: 'sky',
    modeSel: 'spark',
    roundsSel: 2, livesSel: 3, crownSel: 25, sparkSel: 40,
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
        ammo: $('ammo'), ammoMax: $('ammo-max'), scope: $('scope'),
        slot1: $('slot-1'), slot2: $('slot-2'),
        nades: $('nades'), sparks: $('sparks'), sparkNum: $('spark-num'),
        sparkFill: $('spark-fill'), lvTimer: $('lv-timer'),
        cd: { pb: $('cd-pb'), ac: $('cd-ac'), gr: $('cd-gr'), ab: $('cd-ab') },
      };
      el.chLines = el.crosshair.querySelectorAll('.l');

      const bindSel = (cls, attr, set) => {
        document.querySelectorAll('.' + cls).forEach(b => {
          b.addEventListener('click', () => {
            document.querySelectorAll('.' + cls).forEach(x => x.classList.remove('sel'));
            b.classList.add('sel');
            set(b.dataset[attr]);
          });
        });
      };
      bindSel('bot-btn', 'n', v => { api.botCount = parseInt(v, 10); });
      // map row is DELEGATED (custom maps get added dynamically)
      $('map-row').addEventListener('click', (e) => {
        const b = e.target.closest('.map-btn');
        if (!b) return;
        $('map-row').querySelectorAll('.map-btn').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        api.mapSel = b.dataset.m;
        SKY.Game.previewMap(b.dataset.m);
      });
      bindSel('mode-btn', 'm', v => {
        api.modeSel = v;
        $('crown-row').classList.toggle('hidden', v !== 'crown');
        $('spark-row').classList.toggle('hidden', v !== 'spark');
        $('rl-row').classList.toggle('hidden', v === 'spark');
      });
      // PLAY hub sub-tabs: vs bots ↔ online
      document.querySelectorAll('.play-sub').forEach(b => {
        b.addEventListener('click', () => api.playSub(b.dataset.v));
      });
      SKY.MapData.onListChange = () => api.refreshCustomMaps();
      api.refreshCustomMaps();
      bindSel('rounds-btn', 'v', v => { api.roundsSel = parseInt(v, 10); });
      bindSel('lives-btn', 'v', v => { api.livesSel = parseInt(v, 10); });
      bindSel('crown-btn', 'v', v => { api.crownSel = parseInt(v, 10); });
      bindSel('spark-btn', 'v', v => { api.sparkSel = parseInt(v, 10); });

      $('play-btn').addEventListener('click', () => api.onPlay && api.onPlay());
      $('resume-btn').addEventListener('click', () => api.onResume && api.onResume());
      $('quit-btn').addEventListener('click', () => api.onQuit && api.onQuit());
      $('open-settings').addEventListener('click', () => SKY.Settings.open());
      $('pause-settings').addEventListener('click', () => SKY.Settings.open());
    },

    /* custom maps (editor drafts / deployed / net) appear as extra buttons */
    refreshCustomMaps() {
      for (const rowId of ['map-row', 'lmap-row']) {
        const row = $(rowId);
        if (!row) continue;
        row.querySelectorAll('.custom-map').forEach(b => b.remove());
        for (const d of SKY.MapData.list()) {
          const b = document.createElement('button');
          b.className = 'sel-btn custom-map ' + (rowId === 'map-row' ? 'map-btn' : 'lmap-btn');
          b.dataset.m = d.id;
          b.textContent = d.name;
          row.appendChild(b);
        }
      }
    },

    /* PLAY hub sub-tab switch (Net calls this with 'online' when a lobby opens) */
    playSub(v) {
      document.querySelectorAll('.play-sub').forEach(b =>
        b.classList.toggle('sel', b.dataset.v === v));
      $('play-bots').classList.toggle('hidden', v !== 'bots');
      $('play-online').classList.toggle('hidden', v !== 'online');
      if (v === 'online') SKY.Net.enterOnline();
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
      setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 4500);
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

    /* -------- death reward cards: click OR 1/2/3, unlimited time -------- */
    showLoot(choices, onPick) {
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

      // grenade counter
      if (p.nades && p.nades.count > 0) {
        el.nades.classList.remove('hidden');
        setText(el.nades, SKY.TUNING.grenades[p.nades.type].label.split(' ')[0] + ' · ' + p.nades.count);
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
      // alive dots: one per player, dimmed when down/eliminated
      setHTML(el.dots, G.pawns.map(q =>
        `<span class="pdot${q.eliminated ? ' out' : q.alive ? '' : ' dead'}" style="background:${q.color};color:${q.color}"></span>`).join(''));
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
      if (G.mode === 'crown') {
        el.lives.classList.add('hidden');
        el.alive.classList.add('hidden');
        el.crownStatus.classList.remove('hidden');
        el.sparks.classList.add('hidden');
        const C = SKY.TUNING.crown;
        setText(el.crownStatus, G.crownHolder
          ? 'Crown · ' + G.crownHolder.name + ' ' + Math.floor(G.crownHolder.crownTime) + '/' + C.holdToWin
          : 'Crown · free');
      } else if (G.mode !== 'spark') {
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

      if (G.mode !== 'spark') {
        const t = Math.max(0, G.roundTime);
        setText(el.timer, Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0'));
      }

      // ammo + weapon chip (bar shows reload progress while reloading)
      const wDef = SKY.Weapons.defOf(p);
      if (lastWeapon !== p.weapon) {
        lastWeapon = p.weapon;
        el.cd.pb.querySelector('.n').textContent = wDef.short || wDef.label;
      }
      setText(el.ammo, p.reloadT > 0 ? '··' : String(p.ammo));
      setText(el.ammoMax, '/' + wDef.mag);
      const ac = p.reloadT > 0 ? '#ff9a3d' : (p.ammo === 0 ? '#ff5a4a' : '#fff');
      if (el.ammo._c !== ac) { el.ammo._c = ac; el.ammo.style.color = ac; }
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
        G.mode === 'spark' ? ((b.sparks || 0) - (a.sparks || 0)) || (b.koCount - a.koCount)
        : (b.roundWins - a.roundWins) || (b.lives - a.lives) || (b.koCount - a.koCount));
      el.sbBody.innerHTML = rows.map(p => {
        const cls = (p.isLocal ? 'me' : '') + (p.eliminated ? ' out' : '');
        const status = p.eliminated ? 'Out' : (p.alive ? 'Alive' : 'Respawning');
        const lives = G.mode === 'spark' ? '✦' + (p.sparks || 0)
          : G.mode === 'crown' ? Math.floor(p.crownTime) + 's'
          : '♥'.repeat(Math.max(0, p.lives));
        const ping = p.isBot ? 'bot'
          : !online ? '—'
          : p.netId === 'host' ? 'host'
          : (SKY.Net.pings[p.netId] !== undefined ? SKY.Net.pings[p.netId] + 'ms' : '…');
        return `<tr class="${cls}"><td>${p.name}</td><td>${'★'.repeat(p.roundWins)}</td>` +
               `<td>${lives}</td><td>${p.koCount}</td><td>${ping}</td><td>${status}</td></tr>`;
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

  /* one weapon slot: side icon if we can render one, text fallback otherwise */
  function setSlotVisual(slotEl, weaponId) {
    const img = slotEl.querySelector('.si');
    const sn = slotEl.querySelector('.sn');
    const icon = weaponId ? SKY.Effects.weaponSideIcon(weaponId) : null;
    if (icon) {
      if (img.src !== icon) img.src = icon;
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
