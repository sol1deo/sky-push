/* =============================================================================
 * SKY PUSH — the STORE: the commerce hub. Daily featured rotation, the newest
 * collection drop, every skin collection, characters, universal tracer FX,
 * KO sounds (with live preview) and the real-money coin packs. Skins deep-link
 * into the LOCKER's detail page (that's where per-gun buying/equipping lives);
 * everything else buys right here.
 * Checkout for coin packs is pluggable: drop a payment link into CHECKOUT and
 * the BUY buttons open it; while a pack has no link the button remembers
 * interest locally ("NOTIFY ME").
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

  /* daily featured picks: a mythic hero (unowned first) + an epic + a paint */
  function featuredPicks() {
    const P = SKY.Profile;
    const skins = P.FINISHES.filter(f => f.id !== 'stock');
    const anyOwned = (f) => (P.data.ownedFinishes || []).some(
      (o) => o === f.id || o.endsWith(':' + f.id));
    const pick = (list, salt) => list.length
      ? list[(day() + salt) % list.length] : null;
    const mythics = skins.filter(f => f.mythic);
    const hero = pick(mythics.filter(f => !anyOwned(f)), 0) || pick(mythics, 0);
    const epics = skins.filter(f => f.tier === 'epic' && f !== hero);
    const paints = skins.filter(f => f.tier === 'std' && f !== hero);
    return { hero, side1: pick(epics, 1), side2: pick(paints, 2) };
  }

  function skinCard(f, show, big) {
    const P = SKY.Profile;
    const img = SKY.Effects.weaponThumb(show, f.id);
    const [chipTxt, chipCol] = TIER_CHIP[f.tier || 'std'];
    const ownedN = (P.data.ownedFinishes || []).filter(
      (o) => o === f.id || o.endsWith(':' + f.id)).length;
    return `<div class="lk-card lk-skin st-skin${f.mythic ? ' lk-mythic' : ''}${big ? ' st-big' : ''}"
        data-open-skin="${f.id}" style="--tierc:${chipCol}">
      <span class="lk-schip lk-schip-corner" style="background:${chipCol}">${chipTxt}</span>
      ${img ? `<img src="${img}" draggable="false">` : '<div class="lk-ph"></div>'}
      <div class="lk-name">${f.name}</div>
      <div class="lk-tag">${ownedN ? 'OWNED' : '⬡ ' + fmtCoins(f.price)}</div>
    </div>`;
  }

  function renderPanel() {
    const panel = document.getElementById('panel-store');
    if (!panel) return;
    const P = SKY.Profile;
    const show = P.data.wpn || 'pistol';
    const notified = JSON.parse(localStorage.getItem('skypush-store-notify') || '[]');

    /* ---- FEATURED TODAY ---- */
    const fp = featuredPicks();
    const heroHtml = fp.hero ? (() => {
      const f = fp.hero;
      const img = SKY.Effects.weaponThumb(show, f.id);
      return `<div class="lk-feat lk-mythic st-hero" data-open-skin="${f.id}">
        <div class="lk-featart">${img ? `<img src="${img}" draggable="false">` : ''}</div>
        <div class="lk-featinfo">
          <div class="lk-featlbl">FEATURED TODAY</div>
          <h2>${f.name}</h2>
          <div class="lk-ddesc">${(SKY.Locker && SKY.Locker.skinDesc(f.id)) || ''}</div>
          <div class="lk-featrow">
            <span class="lk-schip" style="background:${TIER_CHIP.mythic[1]}">MYTHIC</span>
            <span class="lk-featprice">⬡ ${fmtCoins(f.price)}</span>
            <button class="lk-buy">VIEW IN LOCKER</button>
          </div>
        </div>
      </div>`;
    })() : '';
    const sideHtml = [fp.side1, fp.side2].filter(Boolean)
      .map((f) => skinCard(f, show)).join('');

    /* ---- NEW DROP ---- */
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
            <button class="lk-buy">VIEW IN LOCKER</button>
          </div>
        </div>
      </div>` : '';

    /* ---- ALL COLLECTIONS ---- */
    const allSkins = P.FINISHES.filter(f => f.id !== 'stock')
      .slice().sort((a, b) => b.price - a.price)
      .map((f) => skinCard(f, show)).join('');

    /* ---- TRACER FX ---- */
    const fxCards = P.TRACERS.map((t) => {
      const owned = P.ownsFx(t.id);
      const eq = P.data.fxTracer === t.id;
      return `<div class="st-fx${eq ? ' st-eq' : ''}" data-fx="${t.id}">
        <div class="st-fxdot" style="--fxc:${t.color}"></div>
        <div class="st-fxinfo">
          <b>${t.name}</b>
          <small>${t.desc}</small>
        </div>
        <button class="lk-buy st-act" data-fx-act="${t.id}">
          ${eq ? 'EQUIPPED — TAP OFF' : owned ? 'EQUIP' : '⬡ ' + fmtCoins(t.price)}
        </button>
      </div>`;
    }).join('');

    /* ---- KO SOUNDS ---- */
    const sndCards = P.KO_SOUNDS.map((s) => {
      const owned = P.ownsSnd(s.id);
      const eq = P.data.koSnd === s.id;
      return `<div class="st-fx st-snd${eq ? ' st-eq' : ''}" data-snd="${s.id}">
        <button class="st-play" data-snd-play="${s.id}" title="hear it">▶</button>
        <div class="st-fxinfo">
          <b>${s.name}</b>
          <small>${s.desc}</small>
        </div>
        <button class="lk-buy st-act" data-snd-act="${s.id}">
          ${eq ? 'EQUIPPED — TAP OFF' : owned ? 'EQUIP' : '⬡ ' + fmtCoins(s.price)}
        </button>
      </div>`;
    }).join('');

    /* ---- CHARACTERS ---- */
    const icons = window.SKY._charIcons || {};
    const charCards = P.CHARS.filter(c => c.price > 0).map((c) => {
      const owned = P.ownsChar(c.id);
      const eq = P.data.char === c.id;
      return `<div class="st-char${eq ? ' st-eq' : ''}" data-char-buy="${c.id}">
        ${icons[c.id] ? `<img src="${icons[c.id]}" draggable="false">`
          : `<div class="st-charph">${c.name[0]}</div>`}
        <b>${c.name}</b>
        <small>${eq ? 'EQUIPPED' : owned ? 'OWNED — TAP TO EQUIP' : '⬡ ' + fmtCoins(c.price)}</small>
      </div>`;
    }).join('');

    /* ---- COIN PACKS ---- */
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

    panel.innerHTML = `
      <div class="st-head">
        <div>
          <h3>STORE</h3>
          <div class="st-sub">daily featured · collections · effects · sounds · characters — ⬡ earned every match</div>
        </div>
        <div class="st-balance">BALANCE <b>⬡ ${fmtCoins(P.coins())}</b></div>
      </div>
      ${heroHtml}
      ${sideHtml ? `<div class="st-siderow">${sideHtml}</div>` : ''}
      ${dropHtml}
      <h4 class="lk-h">SKIN COLLECTIONS <small>tap one — pick which guns wear it in the locker</small></h4>
      <div class="lk-grid lk-sgrid">${allSkins}</div>
      <h4 class="lk-h">TRACER EFFECTS <small>your bullets shed these on EVERY weapon</small></h4>
      <div class="st-fxrow">${fxCards}</div>
      <h4 class="lk-h">KO SOUNDS <small>the noise your victims make — hit ▶ to hear it first</small></h4>
      <div class="st-fxrow">${sndCards}</div>
      <h4 class="lk-h">CHARACTERS</h4>
      <div class="st-charrow">${charCards}</div>
      <h4 class="lk-h">COIN PACKS <small>skip the grind</small></h4>
      <div class="st-grid">${packCards}</div>
      <div class="st-note">coin packs open a secure checkout — payments are still being
        switched on, hit a pack to get on the launch list.</div>`;

    panel.onclick = (e) => {
      const P2 = SKY.Profile;
      /* skins → locker detail (the per-gun buy/equip flow lives there) */
      const open = e.target.closest('[data-open-skin]');
      if (open) {
        if (SKY.Locker && SKY.Locker.openSkin) SKY.Locker.openSkin(open.dataset.openSkin);
        return;
      }
      /* KO sound PREVIEW — always free to listen */
      const play = e.target.closest('[data-snd-play]');
      if (play) {
        SKY.SFX.init();
        SKY.SFX.koVoice(play.dataset.sndPlay, 0);
        return;
      }
      /* tracer FX buy/equip/unequip */
      const fxa = e.target.closest('[data-fx-act]');
      if (fxa) {
        const id = fxa.dataset.fxAct;
        if (P2.data.fxTracer === id) { P2.equipFx(null); }
        else if (P2.ownsFx(id)) { P2.equipFx(id); SKY.SFX.init(); SKY.SFX.pick(); }
        else if (P2.purchasesLocked()) { needAccount(); return; }
        else if (P2.buyFx(id)) { P2.equipFx(id); SKY.SFX.init(); SKY.SFX.cash(); }
        else { flashPoor(fxa.closest('.st-fx')); return; }
        renderPanel();
        return;
      }
      /* KO sound buy/equip/unequip */
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
        } else { flashPoor(sna.closest('.st-fx')); return; }
        renderPanel();
        return;
      }
      /* characters buy/equip */
      const cb = e.target.closest('[data-char-buy]');
      if (cb) {
        const id = cb.dataset.charBuy;
        if (P2.ownsChar(id)) { P2.equipChar(id); }
        else if (P2.purchasesLocked()) { needAccount(); return; }
        else if (P2.buyChar(id)) { P2.equipChar(id); SKY.SFX.init(); SKY.SFX.cash(); }
        else { flashPoor(cb); return; }
        renderPanel();
        if (SKY.Locker && SKY.Locker.refreshPreview) SKY.Locker.refreshPreview();
        return;
      }
      /* coin packs */
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
