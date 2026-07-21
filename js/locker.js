/* =============================================================================
 * SKY PUSH — LOCKER: character select + weapon paint jobs + coin store,
 * plus the live 3D character preview beside the main menu (CS:GO style).
 * All meta/cosmetic; data lives in SKY.Profile.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Locker = (function () {
  const $ = (id) => document.getElementById(id);
  let panel = null;
  let selWeapon = 'pistol';
  let selSkin = null;       // finish id open in the detail view (null = browsing)
  let showWeapon = null;    // browse-grid showcase gun (null = lobby weapon)
  let lkTab = 'weapons';    // weapons | char | style | emotes
  let selEmoteSlot = 0;     // which T-wheel slot the next emote click fills
  const charThumbs = {};    // charId -> dataURL

  /* skin-first shop copy: the card sells the FANTASY, mythics list their FX */
  const SKIN_DESC = {
    obsidian: 'murdered-out matte black',
    arctic: 'clean polar white',
    jungle: 'deep od-green field paint',
    rosegold: 'soft metallic rose gold',
    fade: 'three-color chrome fade along the body',
    bloodmoon: 'obsidian body, molten crimson eclipse cracks · BLOOD RING HALO · CRIMSON TRACERS · TOSS RELOAD',
    carbonviper: 'woven carbon fiber, serpent-red weave',
    sakura: 'hanami lacquer with gold-leaf flecks',
    gilded: 'baroque gold filigree over dark gunmetal',
    toxic: 'it drips. it glows. it bubbles.',
    cybergrid: 'live circuitry with a traveling scanline',
    frostbite: 'glacier-core ice with a cold shimmer',
    aurora: 'polar lights flowing over midnight ice',
    dragonfire: 'molten scales · rising embers · FLAME TRACERS',
    nebula: 'a galaxy in your hands · star halo · VIOLET TRACERS',
    voidwalker: 'abyssal smoke · orbiting shards · VOID TRACERS',
    tempest: 'living lightning strikes the body · STORM TRACERS',
    phoenix: 'flame plumage · wing stream · FIRE TRACERS · SPIN RELOAD',
    midas: 'liquid gold · golden drip · GILDED TRACERS · SPIN RELOAD',
  };
  // mythic = molten red-gold (the old purple hid against dark panels and
  // read LESS premium than the magenta PREMIUM tier right under it)
  const TIER_CHIP = {
    std: ['PAINT', '#8a9cb8'],
    anim: ['ANIMATED', '#40c8ff'],
    epic: ['PREMIUM', '#d92cff'],
    mythic: ['MYTHIC', '#ff5a2e'],
  };

  const WEAPON_ROW = ['pistol', 'blaster', 'scatter', 'smg', 'burst', 'bouncer',
    'piston', 'longshot', 'magnum', 'mega', 'lobber', 'boomstick', 'quad',
    'minigun', 'flamer', 'hookgun', 'cannon'];
  /* kinds that aren't TUNING.weapons entries still get locker cards */
  const EXTRA_DEFS = {
    hookgun: { short: 'HOOK', label: 'GRAPPLE HOOK', color: '#d8c49a' },
    cannon: { short: 'CANNON', label: 'AIR CANNON', color: '#8fd4ff' },
  };

  /* ---------------- character thumbnails (posed, cached) ---------------- */
  let thumbRig = null;
  function charThumb(id) {
    if (charThumbs[id]) return charThumbs[id];
    if (!SKY.GFX || !SKY.GFX.charReady()) return null;
    try {
      if (!thumbRig) {
        const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        r.setSize(150, 190); r.setPixelRatio(1);
        r.outputEncoding = THREE.sRGBEncoding;
        const sc = new THREE.Scene();
        sc.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.05));
        const key = new THREE.DirectionalLight(0xfff2d8, 1.2);
        key.position.set(1.6, 2.4, 2);
        sc.add(key);
        thumbRig = { r, sc, cam: new THREE.PerspectiveCamera(30, 150 / 190, 0.01, 30) };
      }
      const inst = SKY.GFX.charInstance(0, id);
      if (!inst) return null;
      // pose mid-Idle so it isn't a T-pose
      const clip = inst.clips.find(c => c.name === 'Idle');
      if (clip) {
        const mx = new THREE.AnimationMixer(inst.root);
        mx.clipAction(clip).play();
        mx.update(0.6);
      }
      const grp = new THREE.Group();
      grp.add(inst.root);
      grp.rotation.y = 0.35;             // characters face +Z natively; slight 3/4
      thumbRig.sc.add(grp);
      thumbRig.cam.position.set(0, inst.height * 0.62, inst.height * 2.3);
      thumbRig.cam.lookAt(0, inst.height * 0.5, 0);
      thumbRig.r.render(thumbRig.sc, thumbRig.cam);
      const url = thumbRig.r.domElement.toDataURL();
      thumbRig.sc.remove(grp);
      charThumbs[id] = url;
      return url;
    } catch (e) { return null; }
  }

  /* ---------------- live menu preview (your character, idling) ---------------- */
  const pv = { renderer: null, scene: null, cam: null, mixer: null, grp: null, key: null, spin: 0 };
  function ensurePreview() {
    if (pv.renderer) return true;
    const canvas = $('menu-char');
    if (!canvas || !window.THREE) return false;
    try {
      pv.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      pv.renderer.setSize(canvas.clientWidth || 300, canvas.clientHeight || 430, false);
      pv.renderer.outputEncoding = THREE.sRGBEncoding;
      pv.scene = new THREE.Scene();
      pv.scene.add(new THREE.HemisphereLight(0xffffff, 0x505866, 1.0));
      const key = new THREE.DirectionalLight(0xfff2d8, 1.25);
      key.position.set(1.6, 2.6, 2);
      pv.scene.add(key);
      pv.cam = new THREE.PerspectiveCamera(28, (canvas.clientWidth || 300) / (canvas.clientHeight || 430), 0.01, 30);
      return true;
    } catch (e) { return false; }
  }

  function previewCharKey() {
    const pick = SKY.Profile.data.char;
    if (pick) return pick;
    // "random" slot: preview what the current nickname would roll
    const name = (SKY.Settings.data.nickname || 'YOU');
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    const cast = SKY.Profile.CHARS;
    return cast[Math.abs(h) % cast.length].id;
  }

  function rebuildPreview() {
    if (!ensurePreview() || !SKY.GFX || !SKY.GFX.charReady()) return;
    if (pv.grp) { pv.scene.remove(pv.grp); pv.grp = null; pv.mixer = null; }
    const key = previewCharKey();
    const inst = SKY.GFX.charInstance(0, key);
    if (!inst) return;
    pv.key = key;
    // mirror the in-game look: outfit pick (or gold player color) + skin pick
    const P = SKY.Profile;
    const col = new THREE.Color(P.data.outfit || '#ffd34d').convertSRGBToLinear();
    const name = (SKY.Settings.data.nickname || 'YOU');
    let hh = 0;
    for (let i = 0; i < name.length; i++) hh = (hh * 31 + name.charCodeAt(i)) | 0;
    const SK = SKY.Characters.SKINS;
    const skinCol = new THREE.Color(P.data.skin !== null && P.data.skin !== undefined
      ? SK[P.data.skin % SK.length] : SK[Math.abs(hh) % SK.length]).convertSRGBToLinear();
    inst.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const n = m.name || '';
        if (n === inst.tint) {
          m.color.copy(col).multiplyScalar(0.92);
          m.emissive = col.clone().multiplyScalar(0.1);
        } else if (n === 'Skin') {
          m.color.copy(skinCol);
        }
      }
    });
    pv.grp = new THREE.Group();
    pv.grp.add(inst.root);           // characters face +Z natively = at the camera
    pv.scene.add(pv.grp);
    pv.cam.position.set(0, inst.height * 0.62, inst.height * 2.9);
    pv.cam.lookAt(0, inst.height * 0.48, 0);
    pv.mixer = new THREE.AnimationMixer(inst.root);
    const idle = inst.clips.find(c => c.name === 'Idle');
    if (idle) pv.mixer.clipAction(idle).play();
    const label = $('menu-char-name');
    if (label) {
      const def = SKY.Profile.charDef(key);
      label.textContent = (SKY.Profile.data.char ? '' : '? ') + (def ? def.name : key);
    }
  }

  function tickPreview(dt) {
    const wrap = $('menu-char-wrap');
    if (!wrap) return;
    // hidden in the LOBBY stages too — the real character lineup takes over
    // (both the online lobby and the VS BOTS lobby)
    const lobbyUp = (document.getElementById('mp-lobby') &&
      !document.getElementById('mp-lobby').classList.contains('hidden')) ||
      (SKY.HUD && SKY.HUD._botsLobby);
    const inMenu = SKY.Game && SKY.Game.state === 'menu' && !lobbyUp &&
      !(SKY.Editor && SKY.Editor.active) && !(SKY.Replay && SKY.Replay.active);
    wrap.classList.toggle('hidden', !inMenu);
    if (!inMenu || !pv.renderer) return;
    if (!pv.grp && SKY.GFX && SKY.GFX.charReady()) rebuildPreview();
    if (!pv.grp) return;
    if (pv.mixer) pv.mixer.update(dt);
    pv.spin += dt * 0.35;
    pv.grp.rotation.y = Math.sin(pv.spin) * 0.55;
    pv.renderer.render(pv.scene, pv.cam);
  }

  /* ---------------- panel ---------------- */
  function coinsChip() {
    return `<div class="lk-coins">⬡ <b>${SKY.Profile.coins().toLocaleString()}</b></div>`;
  }

  function renderPanel() {
    panel = $('panel-locker');
    if (!panel) return;
    const P = SKY.Profile;
    const ready = SKY.GFX && SKY.GFX.charReady();

    const tabs = `<div class="lk-tabs">
      ${[['weapons', 'Weapons'], ['char', 'Character'], ['style', 'Colors'], ['emotes', 'Emotes']].map(([id, label]) =>
        `<button class="lk-tab ${lkTab === id ? 'sel' : ''}" data-tab="${id}">${label}</button>`).join('')}
    </div>`;

    let body = '';
    if (lkTab === 'emotes') {
      // ---------- EMOTES: the T-wheel + your collection ----------
      const RARC = { common: '#9fb2c8', rare: '#40c8ff', epic: '#ff5db1',
        legendary: '#ffa733', mythic: '#ff5a2e' };
      const wheel = P.data.emoteWheel || [];
      const slots = wheel.map((id, i) => {
        const d = id && P.emoteDef(id);
        return `<div class="lk-eslot ${i === selEmoteSlot ? 'sel' : ''}" data-eslot="${i}">
          <span class="lk-esl-n">${i + 1}</span>
          <span class="lk-esl-name" ${d ? `style="color:${RARC[d.rarity]}"` : ''}>
            ${d ? d.name : 'EMPTY'}</span>
          ${id ? '<span class="lk-esl-x" data-eclear="' + i + '">×</span>' : ''}
        </div>`;
      }).join('');
      const cards = P.EMOTES.slice().sort((a, b) => a.price - b.price).map((em) => {
        const owned = P.ownsEmote(em.id);
        const slotIdx = wheel.indexOf(em.id);
        return `<div class="lk-card lk-emote ${owned ? 'owned' : 'locked'}" data-emote="${em.id}"
            style="--tierc:${RARC[em.rarity]}">
          <span class="lk-schip lk-schip-corner" style="background:${RARC[em.rarity]}">${em.rarity.toUpperCase()}</span>
          <div class="lk-ename">${em.name}</div>
          <div class="lk-edesc">${em.desc}</div>
          <div class="lk-tag">${slotIdx >= 0 ? 'ON WHEEL · ' + (slotIdx + 1)
            : owned ? 'OWNED — CLICK TO SLOT' : '⬡ ' + em.price}</div>
        </div>`;
      }).join('');
      body = `
        <h4 class="lk-h">EMOTE WHEEL <small>hold T in a match — pick the slot, then click an emote below</small></h4>
        <div class="lk-eslots">${slots}</div>
        <h4 class="lk-h">YOUR EMOTES <small>tap T = slot 1 · dances and disrespect sold in the STORE</small></h4>
        <div class="lk-grid lk-egrid">${cards}</div>`;
    } else if (lkTab === 'char') {
      const charCards = P.CHARS.map((c) => {
        const owned = P.ownsChar(c.id);
        const equipped = P.data.char === c.id;
        const img = ready ? charThumb(c.id) : null;
        return `<div class="lk-card ${equipped ? 'equipped' : ''} ${owned ? 'owned' : 'locked'}" data-char="${c.id}">
          ${img ? `<img src="${img}" draggable="false">` : '<div class="lk-ph"></div>'}
          <div class="lk-name">${c.name}</div>
          <div class="lk-tag">${equipped ? 'EQUIPPED' : owned ? 'OWNED' : '⬡ ' + c.price}</div>
        </div>`;
      }).join('');
      const randomCard = `<div class="lk-card ${P.data.char === null ? 'equipped' : 'owned'}" data-char="__random">
        <div class="lk-ph lk-rand">?</div>
        <div class="lk-name">SURPRISE ME</div>
        <div class="lk-tag">${P.data.char === null ? 'EQUIPPED' : 'FREE'}</div>
      </div>`;
      body = `${ready ? '' : '<div class="lk-note">character previews load with the asset pack…</div>'}
        <div class="lk-grid">${randomCard}${charCards}</div>`;
    } else if (lkTab === 'style') {
      body = `
        <h4 class="lk-h">SKIN TONE</h4>
        <div class="lk-dots">
          <span class="lk-dot lk-auto ${P.data.skin === null ? 'sel' : ''}" data-skin="auto">A</span>
          ${SKY.Characters.SKINS.map((c, i) =>
            `<span class="lk-dot ${P.data.skin === i ? 'sel' : ''}" data-skin="${i}" style="background:${c}"></span>`).join('')}
        </div>
        <h4 class="lk-h">OUTFIT COLOR <small>A = your player color</small></h4>
        <div class="lk-dots">
          <span class="lk-dot lk-auto ${P.data.outfit === null ? 'sel' : ''}" data-outfit="auto">A</span>
          ${P.OUTFIT_COLORS.map((c) =>
            `<span class="lk-dot ${P.data.outfit === c ? 'sel' : ''}" data-outfit="${c}" style="background:${c}"></span>`).join('')}
        </div>`;
    } else if (selSkin) {
      // ---------- SKIN DETAIL: big preview + pick the gun to wear it ----------
      const f = P.finishDef(selSkin);
      const [chipTxt, chipCol] = TIER_CHIP[f.tier || 'std'];
      const owned = P.ownsFinish(selWeapon, f.id);
      const equipped = P.finishFor(selWeapon) === f.id;
      const held = (P.data.wpn || 'pistol') === selWeapon;
      const strip = WEAPON_ROW.map((k) => {
        const W = SKY.TUNING.weapons[k] || EXTRA_DEFS[k] || { short: k.toUpperCase() };
        const img = SKY.Effects.weaponThumb(k, f.id);
        const own = P.ownsFinish(k, f.id);
        const cur = P.finishFor(k);
        const eq = cur === f.id;
        // status line: wearing THIS skin / wearing another / bare
        let st = '<span class="lk-wst lk-mute">stock</span>';
        if (eq) st = '<span class="lk-wst lk-this">THIS SKIN</span>';
        else if (cur !== 'stock') {
          const other = P.finishDef(cur);
          st = `<span class="lk-wst" style="color:${(TIER_CHIP[other.tier || 'std'] || [])[1]}">${other.name}</span>`;
        }
        return `<div class="lk-wthumb ${k === selWeapon ? 'sel' : ''}" data-w="${k}"
          title="${(SKY.TUNING.weapons[k] || EXTRA_DEFS[k] || {}).label || k}">
          ${img ? `<img src="${img}" draggable="false">` : ''}
          ${eq ? '<span class="lk-weq">✓</span>' : own ? '<span class="lk-weq lk-wown">●</span>' : ''}
          <div class="lk-wname">${W.short}</div>
          ${st}
        </div>`;
      }).join('');
      const WSel = SKY.TUNING.weapons[selWeapon] || EXTRA_DEFS[selWeapon] || { label: selWeapon };
      body = `
        <button class="lk-back" id="lk-back">← ALL SKINS</button>
        <div class="lk-detail${f.mythic ? ' lk-mythic' : ''}">
          <div class="lk-dbig" id="lk-dbig"><div class="lk-inshint">drag to spin — live FX</div></div>
          <div class="lk-dinfo">
            <span class="lk-schip" style="background:${chipCol}">${chipTxt}</span>
            <h2>${f.name}</h2>
            <div class="lk-ddesc">${SKIN_DESC[f.id] || ''}</div>
            <div class="lk-dwpn">on: <b>${(WSel.label || selWeapon).toUpperCase()}</b></div>
            <div class="lk-dbtns">
              ${equipped
                ? '<button class="lk-buy lk-eqd" data-act="unequip">EQUIPPED — TAP TO REMOVE</button>'
                : owned
                ? '<button class="lk-buy" data-act="equip">EQUIP</button>'
                : `<button class="lk-buy" data-act="buy">BUY — ⬡ ${f.price}</button>`}
              ${selWeapon === 'hookgun' || selWeapon === 'cannon' ? '' :
                `<button class="lk-wbtn${held ? ' sel' : ''}" id="lk-hold">
                  ${held ? 'HELD IN LOBBY' : 'HOLD IN LOBBY'}</button>`}
            </div>
          </div>
        </div>
        <h4 class="lk-h">PICK YOUR GUN <small>✓ equipped · ● owned — each gun wears it its own way</small></h4>
        <div class="lk-wstrip">${strip}</div>`;
    } else {
      // ---------- SKIN BROWSER: the skin is the product, the gun comes after ----------
      const show = showWeapon || P.data.wpn || 'pistol';   // showcase gun for every card
      // YOUR LOADOUT: which gun wears what, at a glance — click one to
      // showcase the whole grid on it
      const loadout = WEAPON_ROW.map((k) => {
        const W = SKY.TUNING.weapons[k] || EXTRA_DEFS[k] || { short: k.toUpperCase() };
        const cur = P.finishFor(k);
        const curDef = cur === 'stock' ? null : P.finishDef(cur);
        const img = SKY.Effects.weaponThumb(k, cur === 'stock' ? undefined : cur);
        return `<div class="lk-wthumb lk-lo ${k === show ? 'sel' : ''}" data-show="${k}"
          title="${W.label || k} — click to showcase the skins below on it">
          ${img ? `<img src="${img}" draggable="false">` : ''}
          <div class="lk-wname">${W.short}</div>
          ${curDef
            ? `<span class="lk-wst" style="color:${(TIER_CHIP[curDef.tier || 'std'] || [])[1]}">${curDef.name}</span>`
            : '<span class="lk-wst lk-mute">stock</span>'}
        </div>`;
      }).join('');
      // (the FEATURED hero moved to the STORE — the locker is your wardrobe)
      const skins = P.FINISHES.filter(x => x.id !== 'stock')
        .slice().sort((a, b) => b.price - a.price);
      const cards = skins.map((f) => {
        const img = SKY.Effects.weaponThumb(show, f.id);
        const ownedN = WEAPON_ROW.filter(k => P.ownsFinish(k, f.id)).length;
        const [chipTxt, chipCol] = TIER_CHIP[f.tier || 'std'];
        return `<div class="lk-card lk-fin lk-skin${f.mythic ? ' lk-mythic' : ''}" data-sk="${f.id}"
            style="--tierc:${chipCol}">
          <span class="lk-schip lk-schip-corner" style="background:${chipCol}">${chipTxt}</span>
          ${img ? `<img src="${img}" draggable="false">` : '<div class="lk-ph"></div>'}
          <div class="lk-name">${f.name}</div>
          <div class="lk-tag">${ownedN ? `OWNED · ${ownedN} GUN${ownedN > 1 ? 'S' : ''}` : '⬡ ' + f.price}</div>
        </div>`;
      }).join('');
      body = `
        <h4 class="lk-h">YOUR LOADOUT <small>what each gun wears — click one to preview the skins on it</small></h4>
        <div class="lk-wstrip lk-lorow">${loadout}</div>
        <h4 class="lk-h">YOUR SKINS <small>everything you own — greyed cards are still in the STORE</small></h4>
        <div class="lk-grid lk-sgrid">${cards}</div>`;
    }

    panel.innerHTML = `
      <div class="lk-head"><h3>LOCKER</h3>
        <div style="display:flex;align-items:center;gap:10px">
          <button class="lk-wbtn" id="lk-dev" title="testing only">+1000 ⬡ dev</button>
          ${coinsChip()}
        </div></div>
      ${tabs}
      ${body}
      <div class="lk-note">earn ⬡ by finishing matches — KOs and wins pay extra</div>`;

    // detail view: mount the persistent live-inspect canvas
    if (lkTab === 'weapons' && selSkin) {
      const mount = panel.querySelector('#lk-dbig');
      if (mount && ensureInspectRig()) {
        buildInspect(selWeapon, selSkin);
        mount.insertBefore(ins.canvas, mount.firstChild);
      }
    }

    panel.onclick = (e) => {
      const tab = e.target.closest('.lk-tab');
      if (tab) { lkTab = tab.dataset.tab; selSkin = null; renderPanel(); return; }
      if (e.target.id === 'lk-dev') {
        SKY.Profile.addCoins(1000);
        SKY.SFX.init(); SKY.SFX.cash();
        return;
      }
      if (e.target.id === 'lk-back') { selSkin = null; renderPanel(); return; }
      if (e.target.id === 'lk-hold') {
        // this weapon is what your character shows off in lobby lineups
        SKY.Profile.setLobbyWeapon(selWeapon);
        renderPanel();
        if (SKY.HUD && SKY.HUD._botsLobby) SKY.HUD.botsLobby(true);   // live refresh
        return;
      }
      // detail view: BUY / EQUIP / UNEQUIP the open skin on the selected gun
      const act = e.target.closest('[data-act]');
      if (act && selSkin) {
        const a = act.dataset.act;
        if (a === 'unequip') { P.equipFinish(selWeapon, 'stock'); }
        else if (a === 'equip') { P.equipFinish(selWeapon, selSkin); }
        else if (P.purchasesLocked && P.purchasesLocked()) { needAccount(); return; }
        else if (P.buyFinish(selWeapon, selSkin)) {
          P.equipFinish(selWeapon, selSkin);
          SKY.SFX.init(); SKY.SFX.cash();
        } else { flashPoor(act.closest('.lk-detail') || act); return; }
        renderPanel();
        return;
      }
      const skinDot = e.target.closest('[data-skin]');
      if (skinDot) {
        const v = skinDot.dataset.skin;
        SKY.Profile.setSkin(v === 'auto' ? null : parseInt(v, 10));
        renderPanel(); rebuildPreview();
        return;
      }
      const outfitDot = e.target.closest('[data-outfit]');
      if (outfitDot) {
        const v = outfitDot.dataset.outfit;
        SKY.Profile.setOutfit(v === 'auto' ? null : v);
        renderPanel(); rebuildPreview();
        return;
      }
      const eClear = e.target.closest('[data-eclear]');
      if (eClear) {
        P.setEmoteSlot(+eClear.dataset.eclear, null);
        renderPanel();
        return;
      }
      const eSlot = e.target.closest('[data-eslot]');
      if (eSlot) { selEmoteSlot = +eSlot.dataset.eslot; renderPanel(); return; }
      const eCard = e.target.closest('[data-emote]');
      if (eCard) {
        const id = eCard.dataset.emote;
        if (P.ownsEmote(id)) { P.setEmoteSlot(selEmoteSlot, id); }
        else if (P.purchasesLocked && P.purchasesLocked()) { needAccount(); return; }
        else if (P.buyEmote(id)) { P.setEmoteSlot(selEmoteSlot, id); SKY.SFX.init(); SKY.SFX.pick(); }
        else { flashPoor(eCard); return; }
        // auto-advance to the next empty slot — slotting a set feels fast
        const wl = P.data.emoteWheel;
        for (let i = 0; i < 6; i++) {
          const j = (selEmoteSlot + 1 + i) % 6;
          if (!wl[j]) { selEmoteSlot = j; break; }
        }
        renderPanel();
        return;
      }
      const cCard = e.target.closest('[data-char]');
      const skCard = e.target.closest('[data-sk]');
      const loBtn = e.target.closest('[data-show]');
      if (loBtn) { showWeapon = loBtn.dataset.show; selWeapon = showWeapon; renderPanel(); return; }
      const wBtn = e.target.closest('.lk-wthumb[data-w]');
      if (wBtn) { selWeapon = wBtn.dataset.w; renderPanel(); return; }
      if (skCard) {                       // open the skin's detail page
        selSkin = skCard.dataset.sk;
        if (!WEAPON_ROW.includes(selWeapon)) selWeapon = 'pistol';
        renderPanel();
        return;
      }
      if (cCard) {
        const id = cCard.dataset.char;
        if (id === '__random') { P.equipChar(null); }
        else if (P.ownsChar(id)) { P.equipChar(id); }
        else if (P.purchasesLocked && P.purchasesLocked()) { needAccount(); return; }
        else if (P.buyChar(id)) { P.equipChar(id); SKY.SFX.init(); SKY.SFX.pick(); }
        else { flashPoor(cCard); return; }
        renderPanel(); rebuildPreview();
        return;
      }
    };
  }

  /* ---------------- live 3D skin inspect (detail page) ----------------
     One persistent canvas+renderer, re-parented into each render of the
     detail view. The real buildWeaponMesh output spins here, so glow anims,
     lightning arcs, embers — everything the skin does in-game — runs live. */
  const ins = { renderer: null, canvas: null, scene: null, cam: null,
    grp: null, key: '', drag: null, yaw: 0.6, pitch: 0.18, auto: true };
  function ensureInspectRig() {
    if (ins.renderer) return true;
    try {
      ins.canvas = document.createElement('canvas');
      ins.canvas.id = 'lk-inspect';
      ins.renderer = new THREE.WebGLRenderer({ canvas: ins.canvas, antialias: true, alpha: true });
      ins.renderer.setSize(340, 190);
      ins.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      ins.renderer.outputEncoding = THREE.sRGBEncoding;
      ins.scene = new THREE.Scene();
      ins.scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x3a4150, 1.1));
      const key = new THREE.DirectionalLight(0xffffff, 1.4);
      key.position.set(1.4, 1.9, 1.2);
      ins.scene.add(key);
      ins.cam = new THREE.PerspectiveCamera(26, 340 / 190, 0.01, 10);
      // drag to rotate; let go and it drifts on its own again
      ins.canvas.style.cssText = 'cursor:grab; touch-action:none;';
      ins.canvas.addEventListener('pointerdown', (e) => {
        ins.drag = { x: e.clientX, y: e.clientY };
        ins.auto = false;
        ins.canvas.setPointerCapture(e.pointerId);
        ins.canvas.style.cursor = 'grabbing';
      });
      ins.canvas.addEventListener('pointermove', (e) => {
        if (!ins.drag) return;
        ins.yaw += (e.clientX - ins.drag.x) * 0.012;
        ins.pitch = SKY.U.clamp(ins.pitch + (e.clientY - ins.drag.y) * 0.008, -1.2, 1.2);
        ins.drag = { x: e.clientX, y: e.clientY };
      });
      const drop = () => { ins.drag = null; ins.auto = true; ins.canvas.style.cursor = 'grab'; };
      ins.canvas.addEventListener('pointerup', drop);
      ins.canvas.addEventListener('pointercancel', drop);
      return true;
    } catch (e) { return false; }
  }
  function buildInspect(kind, skin) {
    const k = kind + ':' + skin;
    if (ins.key === k && ins.grp) return;
    ins.key = k;
    if (ins.grp) { ins.scene.remove(ins.grp); ins.grp = null; }
    const mesh = SKY.Effects.buildWeaponMesh(kind, skin);
    const box = new THREE.Box3().setFromObject(mesh);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    mesh.position.sub(c);
    ins.grp = new THREE.Group();
    ins.grp.add(mesh);
    ins.scene.add(ins.grp);
    ins.cam.position.set(0, 0.04, Math.max(0.2, size) * 1.35);
    ins.cam.lookAt(0, 0, 0);
  }
  function tickInspect(dt) {
    if (!ins.renderer || !ins.grp || !selSkin) return;
    if (!ins.canvas.isConnected) return;            // detail view closed
    if (ins.auto) ins.yaw += dt * 0.55;
    ins.grp.rotation.set(ins.pitch, ins.yaw, 0);
    ins.renderer.render(ins.scene, ins.cam);
  }

  /* purchases need an account (only once the account system is configured) */
  function needAccount() {
    SKY.SFX.init(); SKY.SFX.dry();
    if (SKY.AccountUI) SKY.AccountUI.openModal('up');
  }

  function flashPoor(el) {
    el.classList.remove('lk-poor');
    void el.offsetWidth;         // restart the animation
    el.classList.add('lk-poor');
    SKY.SFX.init(); SKY.SFX.dry();
  }

  return {
    renderPanel,
    tick(dt) { tickPreview(dt); tickInspect(dt); },
    refreshPreview() { rebuildPreview(); },
    skinDesc(id) { return SKIN_DESC[id] || ''; },
    /* store deep-link: jump straight to the emote wheel */
    openEmotes() {
      lkTab = 'emotes';
      selSkin = null;
      const tab = document.getElementById('tab-locker');
      if (tab) tab.click();
      renderPanel();
    },
    /* store deep-link: jump straight to a skin's detail page */
    openSkin(id) {
      lkTab = 'weapons';
      selSkin = id;
      if (!WEAPON_ROW.includes(selWeapon)) selWeapon = SKY.Profile.data.wpn || 'pistol';
      const tab = document.getElementById('tab-locker');
      if (tab) tab.click();       // selectTab shows the panel + renders...
      renderPanel();              // ...then the detail state wins
    },
    init() {
      const refreshCoins = () => {
        const chip = document.querySelector('.lk-coins b');
        if (chip) chip.textContent = SKY.Profile.coins().toLocaleString();
        const rail = $('rail-coins-n');
        if (rail) rail.textContent = SKY.Profile.coins().toLocaleString();
      };
      SKY.Profile.onChange = refreshCoins;
      refreshCoins();
    },
  };
})();
