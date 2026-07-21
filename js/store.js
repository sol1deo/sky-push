/* =============================================================================
 * SKY PUSH — the STORE, kept TIGHT: coin packs first (the reason the page
 * exists), the newest premium drop, three rotating featured skins, tracer
 * effects with LIVE animated previews, and KO sounds you can audition.
 * Nothing that duplicates the LOCKER — skins/characters live there, and the
 * featured/drop cards deep-link straight into the locker's detail page.
 * Checkout is pluggable: drop a payment link into CHECKOUT and the BUY
 * buttons open it; while a pack has no link the button remembers interest.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Store = (function () {
  /* paste real payment links here when the merchant account is live */
  const CHECKOUT = {
    handful: '',
    stash: '',
    chest: '',
    vault: '',
  };

  const PACKS = [
    { id: 'handful', name: 'HANDFUL OF COINS', coins: 500, price: '$1.99',
      art: 'assets/store/pack1.jpg', bonus: 0 },
    { id: 'stash', name: 'COIN STASH', coins: 1200, price: '$4.99',
      art: 'assets/store/pack2.jpg', bonus: 20 },
    { id: 'chest', name: 'TREASURE CHEST', coins: 2800, price: '$9.99',
      art: 'assets/store/pack3.jpg', bonus: 40, tag: 'MOST POPULAR' },
    { id: 'vault', name: 'ROYAL VAULT', coins: 6500, price: '$19.99',
      art: 'assets/store/pack4.jpg', bonus: 62, tag: 'BEST VALUE' },
  ];

  const NEW_DROP = 'bloodmoon';          // the latest collection banner
  const TIER_CHIP = {
    std: ['PAINT', '#8a9cb8'],
    anim: ['ANIMATED', '#40c8ff'],
    epic: ['PREMIUM', '#d92cff'],
    mythic: ['MYTHIC', '#ff5a2e'],
  };

  function fmtCoins(n) { return n.toLocaleString('en-US'); }
  function day() { return Math.floor(Date.now() / 864e5); }

  function needAccount() {
    SKY.SFX.init(); SKY.SFX.dry();
    if (SKY.AccountUI) SKY.AccountUI.openModal('up');
  }
  function flashPoor(el) {
    if (!el) return;
    el.classList.remove('lk-poor');
    void el.offsetWidth;
    el.classList.add('lk-poor');
    SKY.SFX.init(); SKY.SFX.dry();
  }

  /* daily featured trio: a mythic (unowned first), an epic, a paint */
  function featuredPicks() {
    const P = SKY.Profile;
    const skins = P.FINISHES.filter(f => f.id !== 'stock' && f.id !== NEW_DROP);
    const anyOwned = (f) => (P.data.ownedFinishes || []).some(
      (o) => o === f.id || o.endsWith(':' + f.id));
    const pick = (list, salt) => list.length
      ? list[(day() + salt) % list.length] : null;
    const mythics = skins.filter(f => f.mythic);
    const hero = pick(mythics.filter(f => !anyOwned(f)), 0) || pick(mythics, 0);
    return [hero,
      pick(skins.filter(f => f.tier === 'epic'), 1),
      pick(skins.filter(f => f.tier === 'std'), 2)].filter(Boolean);
  }

  function renderPanel() {
    const panel = document.getElementById('panel-store');
    if (!panel) return;
    const P = SKY.Profile;
    const show = P.data.wpn || 'pistol';
    const notified = JSON.parse(localStorage.getItem('skypush-store-notify') || '[]');

    /* ---- COIN PACKS (front and center — this page's job) ---- */
    const packCards = PACKS.map((p) => {
      const url = CHECKOUT[p.id];
      const wants = notified.includes(p.id);
      return `<div class="st-card${p.tag ? ' st-hot' : ''}" data-pack="${p.id}">
        ${p.tag ? `<div class="st-ribbon">${p.tag}</div>` : ''}
        <div class="st-art"><img src="${p.art}" draggable="false" alt=""></div>
        <div class="st-coins">⬡ ${fmtCoins(p.coins)}</div>
        ${p.bonus ? `<div class="st-bonus">+${p.bonus}% BONUS</div>` : '<div class="st-bonus st-mute">STARTER PACK</div>'}
        <div class="st-name">${p.name}</div>
        <button class="st-buy${url ? '' : ' st-soon'}" data-buy="${p.id}">
          ${url ? p.price : wants ? '✓ ON THE LIST' : p.price}
        </button>
      </div>`;
    }).join('');

    /* ---- NEW DROP banner ---- */
    const nd = P.finishDef(NEW_DROP);
    const ndImg = SKY.Effects.weaponThumb(show, NEW_DROP);
    const dropHtml = nd && nd.id === NEW_DROP ? `
      <div class="st-drop lk-mythic" data-open-skin="${nd.id}">
        <div class="st-droptag">NEW COLLECTION</div>
        <div class="st-dropart">${ndImg ? `<img src="${ndImg}" draggable="false">` : ''}</div>
        <div class="st-dropinfo">
          <h2>${nd.name}</h2>
          <div class="lk-ddesc">${(SKY.Locker && SKY.Locker.skinDesc(nd.id)) || ''}</div>
          <div class="lk-featrow">
            <span class="lk-schip" style="background:${TIER_CHIP.mythic[1]}">MYTHIC</span>
            <span class="lk-featprice">⬡ ${fmtCoins(nd.price)}</span>
            <button class="lk-buy">OPEN IN LOCKER</button>
          </div>
        </div>
      </div>` : '';

    /* ---- FEATURED TODAY: three cards, rotate daily ---- */
    const featHtml = featuredPicks().map((f) => {
      const img = SKY.Effects.weaponThumb(show, f.id);
      const [chipTxt, chipCol] = TIER_CHIP[f.tier || 'std'];
      return `<div class="lk-card lk-skin st-skin${f.mythic ? ' lk-mythic' : ''}"
          data-open-skin="${f.id}" style="--tierc:${chipCol}">
        <span class="lk-schip lk-schip-corner" style="background:${chipCol}">${chipTxt}</span>
        ${img ? `<img src="${img}" draggable="false">` : '<div class="lk-ph"></div>'}
        <div class="lk-name">${f.name}</div>
        <div class="lk-tag">⬡ ${fmtCoins(f.price)}</div>
      </div>`;
    }).join('');

    /* ---- TRACER EFFECTS: live animated lane previews ---- */
    const fxCards = P.TRACERS.map((t) => {
      const owned = P.ownsFx(t.id);
      const eq = P.data.fxTracer === t.id;
      return `<div class="st-fx2${eq ? ' st-eq' : ''}" data-fx="${t.id}" style="--fxc:${t.color}">
        <div class="st-lane">
          <i></i><i style="animation-delay:.75s"></i>
          <b style="animation-delay:.12s; top:38%"></b>
          <b style="animation-delay:.32s; top:60%"></b>
          <b style="animation-delay:.55s; top:48%"></b>
          <b style="animation-delay:.87s; top:42%"></b>
          <b style="animation-delay:1.1s; top:58%"></b>
        </div>
        <div class="st-fxmeta">
          <div class="st-fxinfo"><b>${t.name}</b><small>${t.desc}</small></div>
          <button class="lk-buy st-act" data-fx-act="${t.id}">
            ${eq ? 'ON — TAP OFF' : owned ? 'EQUIP' : '⬡ ' + fmtCoins(t.price)}
          </button>
        </div>
      </div>`;
    }).join('');

    /* ---- KO SOUNDS: audition first, then flex on your victims ---- */
    const eqBars = [14, 26, 20, 32, 16, 28, 12, 24, 18, 30, 15, 22];
    const sndCards = P.KO_SOUNDS.map((s) => {
      const owned = P.ownsSnd(s.id);
      const eq = P.data.koSnd === s.id;
      return `<div class="st-snd2${eq ? ' st-eq' : ''}" data-snd="${s.id}">
        <div class="st-sndtop">
          <button class="st-play" data-snd-play="${s.id}" title="hear it">▶</button>
          <div class="st-eqz">${eqBars.map((h, i) =>
            `<i style="height:${h}px; animation-delay:${(i * 0.09).toFixed(2)}s"></i>`).join('')}</div>
        </div>
        <div class="st-fxinfo"><b>${s.name}</b><small>${s.desc}</small></div>
        <button class="lk-buy st-act" data-snd-act="${s.id}">
          ${eq ? 'ON — TAP OFF' : owned ? 'EQUIP' : '⬡ ' + fmtCoins(s.price)}
        </button>
      </div>`;
    }).join('');

    /* ---- EMOTES: dances + disrespect, played on the T wheel ---- */
    const RARC = { common: '#9fb2c8', rare: '#40c8ff', epic: '#ff5db1',
      legendary: '#ffa733', mythic: '#ff5a2e' };
    const emoteCards = P.EMOTES.filter(em => em.price > 0)
      .slice().sort((a, b) => a.price - b.price).map((em) => {
      const owned = P.ownsEmote(em.id);
      return `<div class="st-emote${em.rarity === 'mythic' ? ' st-myth' : ''}"
          style="--tierc:${RARC[em.rarity]}">
        <span class="st-echip" style="background:${RARC[em.rarity]}">${em.rarity.toUpperCase()}</span>
        <div class="st-fxinfo"><b>${em.name}</b><small>${em.desc}</small></div>
        <button class="lk-buy st-act" data-emote-act="${em.id}">
          ${owned ? 'OWNED — SLOT IN LOCKER' : '⬡ ' + fmtCoins(em.price)}
        </button>
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="st-head">
        <div><h3>STORE</h3></div>
        <div class="st-balance">BALANCE <b>⬡ ${fmtCoins(P.coins())}</b></div>
      </div>
      <div class="st-grid">${packCards}</div>
      ${dropHtml}
      <h4 class="lk-h">FEATURED TODAY <small>rotates daily — tap to try it on in the locker</small></h4>
      <div class="st-featrow">${featHtml}</div>
      <h4 class="lk-h">EMOTES <small>dances + disrespect — hold T in a match to play them</small></h4>
      <div class="st-fxgrid">${emoteCards}</div>
      <h4 class="lk-h">TRACER EFFECTS <small>your bullets wear these on every weapon</small></h4>
      <div class="st-fxgrid">${fxCards}</div>
      <h4 class="lk-h">KO SOUNDS <small>the noise your victims make — ▶ to audition</small></h4>
      <div class="st-sndgrid">${sndCards}</div>
      <div class="st-note">coin packs open a secure checkout — payments are still being switched
        on, hit a pack to get on the launch list. Skins & characters live in the LOCKER.</div>`;

    panel.onclick = (e) => {
      const P2 = SKY.Profile;
      const open = e.target.closest('[data-open-skin]');
      if (open) {
        if (SKY.Locker && SKY.Locker.openSkin) SKY.Locker.openSkin(open.dataset.openSkin);
        return;
      }
      const play = e.target.closest('[data-snd-play]');
      if (play) {
        SKY.SFX.init();
        SKY.SFX.koVoice(play.dataset.sndPlay, 0);
        const card = play.closest('.st-snd2');
        if (card) {
          card.classList.add('st-playing');
          setTimeout(() => card.classList.remove('st-playing'), 1400);
        }
        return;
      }
      const fxa = e.target.closest('[data-fx-act]');
      if (fxa) {
        const id = fxa.dataset.fxAct;
        if (P2.data.fxTracer === id) { P2.equipFx(null); }
        else if (P2.ownsFx(id)) { P2.equipFx(id); SKY.SFX.init(); SKY.SFX.pick(); }
        else if (P2.purchasesLocked()) { needAccount(); return; }
        else if (P2.buyFx(id)) { P2.equipFx(id); SKY.SFX.init(); SKY.SFX.cash(); }
        else { flashPoor(fxa.closest('.st-fx2')); return; }
        renderPanel();
        return;
      }
      const ema = e.target.closest('[data-emote-act]');
      if (ema) {
        const id = ema.dataset.emoteAct;
        if (P2.ownsEmote(id)) {
          // owned: jump to the locker's emote wheel to slot it
          if (SKY.Locker && SKY.Locker.openEmotes) SKY.Locker.openEmotes();
          return;
        }
        if (P2.purchasesLocked()) { needAccount(); return; }
        if (P2.buyEmote(id)) { SKY.SFX.init(); SKY.SFX.cash(); }
        else { flashPoor(ema.closest('.st-emote')); return; }
        renderPanel();
        return;
      }
      const sna = e.target.closest('[data-snd-act]');
      if (sna) {
        const id = sna.dataset.sndAct;
        if (P2.data.koSnd === id) { P2.equipSnd(null); }
        else if (P2.ownsSnd(id)) { P2.equipSnd(id); SKY.SFX.init(); SKY.SFX.koVoice(id, 0); }
        else if (P2.purchasesLocked()) { needAccount(); return; }
        else if (P2.buySnd(id)) {
          P2.equipSnd(id);
          SKY.SFX.init(); SKY.SFX.cash();
          setTimeout(() => SKY.SFX.koVoice(id, 0), 300);
        } else { flashPoor(sna.closest('.st-snd2')); return; }
        renderPanel();
        return;
      }
      const b = e.target.closest('[data-buy]');
      if (!b) return;
      const id = b.dataset.buy;
      const url = CHECKOUT[id];
      if (url) {
        window.open(url, '_blank', 'noopener');
        return;
      }
      const list = JSON.parse(localStorage.getItem('skypush-store-notify') || '[]');
      if (!list.includes(id)) {
        list.push(id);
        localStorage.setItem('skypush-store-notify', JSON.stringify(list));
      }
      if (SKY.SFX) { SKY.SFX.init(); SKY.SFX.cash(); }
      b.textContent = '✓ ON THE LIST';
      b.classList.add('st-listed');
    };
  }

  return { renderPanel, PACKS, CHECKOUT };
})();
