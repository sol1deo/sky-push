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
  let lastTier = -1, lastWeapon = '';
  let lootKeyHandler = null, buyKeyHandler = null;

  const api = {
    botCount: 3,
    mapSel: 'sky',
    modeSel: 'lbs',
    roundsSel: 2, livesSel: 3, crownSel: 25,
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
        loot: $('loot-ov'), lootCards: $('loot-cards'),
        ammo: $('ammo'), ammoMax: $('ammo-max'), scope: $('scope'),
        nades: $('nades'), money: $('money'), actbar: $('actbar'), actfill: $('actfill'),
        actlabel: $('actlabel'), buy: $('buy-ov'), buyBody: $('buy-body'), buyMoney: $('buy-money'),
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
      bindSel('map-btn', 'm', v => { api.mapSel = v; SKY.Game.previewMap(v); });
      bindSel('mode-btn', 'm', v => { api.modeSel = v; });
      bindSel('rounds-btn', 'v', v => { api.roundsSel = parseInt(v, 10); });
      bindSel('lives-btn', 'v', v => { api.livesSel = parseInt(v, 10); });
      bindSel('crown-btn', 'v', v => { api.crownSel = parseInt(v, 10); });

      $('play-btn').addEventListener('click', () => api.onPlay && api.onPlay());
      $('resume-btn').addEventListener('click', () => api.onResume && api.onResume());
      $('quit-btn').addEventListener('click', () => api.onQuit && api.onQuit());
      $('open-settings').addEventListener('click', () => SKY.Settings.open());
      $('pause-settings').addEventListener('click', () => SKY.Settings.open());
    },

    showMenu() { el.menu.classList.remove('hidden'); el.hud.classList.add('hidden'); },
    hideMenu() { el.menu.classList.add('hidden'); el.hud.classList.remove('hidden'); },
    setPause(on) { el.pause.classList.toggle('hidden', !on); },
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

    /* -------- bomb-mode buy menu (keys buy, B toggles during freeze) -------- */
    _buyOpen: false,
    _buyItems: [],
    buyMenu(on) {
      if (on === 'toggle') on = !api._buyOpen;
      api._buyOpen = !!on;
      el.buy.classList.toggle('hidden', !on);
      if (on) {
        api.refreshBuyMenu();
        if (!buyKeyHandler) {
          buyKeyHandler = (e) => {
            const m = e.code.match(/^Digit(\d)$/);
            if (m) api.buyKey(+m[1]);
          };
          window.addEventListener('keydown', buyKeyHandler);
        }
      } else if (buyKeyHandler) {
        window.removeEventListener('keydown', buyKeyHandler);
        buyKeyHandler = null;
      }
    },
    refreshBuyMenu() {
      const p = SKY.Game.player;
      if (!p) return;
      const P = SKY.TUNING.prices;
      const N = SKY.TUNING.grenades;
      api._buyItems = ['smg', 'scatter', 'blaster', 'magnum', 'lobber', 'longshot', 'mega',
                       'he', 'molly', 'vortex'];
      el.buyMoney.textContent = '$' + p.money;
      el.buyBody.innerHTML = api._buyItems.map((id, i) => {
        const isNade = !!N[id];
        const price = isNade ? N[id].price : P[id];
        const label = isNade ? N[id].label + ' ×2' : SKY.TUNING.weapons[id].label;
        const owned = !isNade && p.weapon === id;
        const afford = p.money >= price;
        return `<div class="buy-row ${owned ? 'owned' : ''} ${afford ? '' : 'poor'}" data-id="${id}">
          <span class="keycap">${(i + 1) % 10}</span>
          <span class="buy-name">${label}</span>
          <span class="buy-price">${owned ? 'owned' : '$' + price}</span>
        </div>`;
      }).join('');
      el.buyBody.querySelectorAll('.buy-row').forEach(row => {
        row.onclick = () => SKY.Game.buy(row.dataset.id);
      });
    },
    buyKey(digit) {   // 1..9, 0 = 10th
      const idx = digit === 0 ? 9 : digit - 1;
      if (api._buyOpen && api._buyItems[idx]) SKY.Game.buy(api._buyItems[idx]);
    },

    /* called every render frame */
    update(dt) {
      const G = SKY.Game;
      if (centerT > 0) { centerT -= dt; if (centerT <= 0) el.center.style.opacity = 0; }
      if (subT > 0) { subT -= dt; if (subT <= 0) el.sub.style.opacity = 0; }
      if (hitT > 0) { hitT -= dt; if (hitT <= 0) el.hitmark.style.opacity = 0; }

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

      // grenade counter
      if (p.nades && p.nades.count > 0) {
        el.nades.classList.remove('hidden');
        setText(el.nades, SKY.TUNING.grenades[p.nades.type].label.split(' ')[0] + ' · ' + p.nades.count);
      } else el.nades.classList.add('hidden');

      // mode-specific readouts
      setText(el.roundLabel, 'R' + G.roundNum);
      // round pips: local player's round wins toward the match
      const RT = G.mode === 'bomb' ? SKY.TUNING.bomb.roundsToWin : SKY.TUNING.game.roundsToWin;
      const wins = G.mode === 'bomb'
        ? (G.bombScore ? (p.team === 'atk' ? G.bombScore.atk : G.bombScore.def) : 0)
        : p.roundWins;
      let pipsHtml = '';
      for (let i = 0; i < RT; i++) pipsHtml += `<span class="pip${i < wins ? ' on' : ''}"></span>`;
      setHTML(el.pips, pipsHtml);
      // alive dots: one per player, dimmed when down/eliminated
      setHTML(el.dots, G.pawns.map(q =>
        `<span class="pdot${q.eliminated ? ' out' : q.alive ? '' : ' dead'}" style="background:${q.color};color:${q.color}"></span>`).join(''));
      if (G.mode === 'bomb' && G.bomb) {
        const B = G.bomb, C = SKY.TUNING.bomb;
        el.lives.classList.add('hidden');
        el.crownStatus.classList.add('hidden');
        el.alive.classList.remove('hidden');
        setText(el.alive, 'ATK ' + (G.bombScore ? G.bombScore.atk : 0) + ' — ' +
          (G.bombScore ? G.bombScore.def : 0) + ' DEF');
        el.money.classList.remove('hidden');
        setText(el.money, '$' + p.money);
        const t = B.phase === 'freeze' ? B.t : B.planted ? B.timer : B.t;
        setText(el.timer, (B.phase === 'freeze' ? 'BUY ' : '') +
          Math.floor(Math.max(0, t) / 60) + ':' + String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0'));
        const tc = B.planted ? 'var(--danger)' : '';
        if (el.timer._c !== tc) { el.timer._c = tc; el.timer.style.color = tc; }
        // plant / defuse progress
        if (B.prog > 0.05 || B.dprog > 0.05) {
          el.actbar.classList.remove('hidden');
          const planting = B.prog > 0.05;
          setText(el.actlabel, planting ? 'Planting' : 'Defusing');
          setW(el.actfill, 100 * (planting ? B.prog / C.plantTime : B.dprog / C.defuseTime));
        } else el.actbar.classList.add('hidden');
        // carrier hint
        if (B.carrier === p && !B.planted) {
          el.respawn.classList.remove('hidden');
          el.respawn.textContent = 'You carry the bomb — hold ' +
            SKY.Settings.bindName(SKY.Settings.data.binds.interact) + ' on a site';
        } else if (p.alive && el.respawn.textContent.startsWith('You carry')) {
          el.respawn.classList.add('hidden');
        }
        sbRefreshT -= dt;
        if (!el.sb.classList.contains('hidden') && sbRefreshT <= 0) { sbRefreshT = 0.25; api.refreshScoreboard(); }
        // ammo/chips still below
        const wDefB = SKY.Weapons.defOf(p);
        if (lastWeapon !== p.weapon) {
          lastWeapon = p.weapon;
          el.cd.pb.querySelector('.n').textContent = wDefB.short || wDefB.label;
        }
        setText(el.ammo, p.reloadT > 0 ? '··' : String(p.ammo));
        setText(el.ammoMax, '/' + Math.round(wDefB.mag * p.mods.magMult));
        if (p.reloadT > 0) setCd(el.cd.pb, p.reloadT, wDefB.reloadTime * p.mods.cdMult);
        else setCd(el.cd.pb, p.pbCd, wDefB.cooldown * p.mods.cdMult);
        setCd(el.cd.ac, p.acCd, SKY.TUNING.cannon.cooldown * p.mods.cdMult);
        setCd(el.cd.gr, p.grapple ? 1 : p.grappleCd, SKY.TUNING.grapple.cooldown * p.mods.grappleCdMult);
        return;
      }
      el.money.classList.add('hidden');
      if (G.mode === 'crown') {
        el.lives.classList.add('hidden');
        el.alive.classList.add('hidden');
        el.crownStatus.classList.remove('hidden');
        const C = SKY.TUNING.crown;
        setText(el.crownStatus, G.crownHolder
          ? 'Crown · ' + G.crownHolder.name + ' ' + Math.floor(G.crownHolder.crownTime) + '/' + C.holdToWin
          : 'Crown · free');
      } else {
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

      const t = Math.max(0, G.roundTime);
      setText(el.timer, Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0'));

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
        (b.roundWins - a.roundWins) || (b.lives - a.lives) || (b.koCount - a.koCount));
      el.sbBody.innerHTML = rows.map(p => {
        const cls = (p.isLocal ? 'me' : '') + (p.eliminated ? ' out' : '');
        const status = p.eliminated ? 'Out' : (p.alive ? 'Alive' : 'Respawning');
        const lives = G.mode === 'crown'
          ? Math.floor(p.crownTime) + 's'
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
