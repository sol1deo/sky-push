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
  const charThumbs = {};    // charId -> dataURL

  const WEAPON_ROW = ['pistol', 'blaster', 'scatter', 'smg', 'burst', 'bouncer',
    'piston', 'longshot', 'magnum', 'mega', 'lobber', 'boomstick', 'quad', 'hookgun'];

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
    // tint like in-game: the local player color is gold
    const col = new THREE.Color('#ffd34d');
    inst.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if ((m.name || '') === inst.tint) {
          m.color.copy(col).multiplyScalar(0.92);
          m.emissive = col.clone().multiplyScalar(0.1);
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
    const inMenu = SKY.Game && SKY.Game.state === 'menu' &&
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

    const wpnBtns = WEAPON_ROW.map((k) => {
      // the grapple hook is a tool, not a TUNING weapon — style it by hand
      const W = SKY.TUNING.weapons[k] || { short: 'HOOK', color: '#d8c49a' };
      return `<button class="lk-wbtn ${k === selWeapon ? 'sel' : ''}" data-w="${k}"
        style="--wc:${W.color}">${W.short}</button>`;
    }).join('');

    const finCards = P.FINISHES.map((f) => {
      const owned = P.ownsFinish(f.id);
      const equipped = P.finishFor(selWeapon) === f.id;
      const img = SKY.Effects.weaponThumb(selWeapon, f.id === 'stock' ? undefined : f.id);
      return `<div class="lk-card lk-fin ${equipped ? 'equipped' : ''} ${owned ? 'owned' : 'locked'}" data-fin="${f.id}">
        ${img ? `<img src="${img}" draggable="false">` : '<div class="lk-ph"></div>'}
        <div class="lk-name">${f.name}</div>
        <div class="lk-tag">${equipped ? 'EQUIPPED' : owned ? 'OWNED' : '⬡ ' + f.price}</div>
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="lk-head"><h3>LOCKER</h3>${coinsChip()}</div>
      ${ready ? '' : '<div class="lk-note">character previews load with the asset pack…</div>'}
      <h4 class="lk-h">CHARACTER</h4>
      <div class="lk-grid">${randomCard}${charCards}</div>
      <h4 class="lk-h">WEAPON PAINT JOBS</h4>
      <div class="lk-wrow">${wpnBtns}</div>
      <div class="lk-grid">${finCards}</div>
      <div class="lk-note">earn ⬡ by finishing matches — KOs and wins pay extra</div>`;

    panel.onclick = (e) => {
      const cCard = e.target.closest('[data-char]');
      const fCard = e.target.closest('[data-fin]');
      const wBtn = e.target.closest('.lk-wbtn');
      if (wBtn) { selWeapon = wBtn.dataset.w; renderPanel(); return; }
      if (cCard) {
        const id = cCard.dataset.char;
        if (id === '__random') { P.equipChar(null); }
        else if (P.ownsChar(id)) { P.equipChar(id); }
        else if (P.buyChar(id)) { P.equipChar(id); SKY.SFX.init(); SKY.SFX.pick(); }
        else { flashPoor(cCard); return; }
        renderPanel(); rebuildPreview();
        return;
      }
      if (fCard) {
        const id = fCard.dataset.fin;
        if (P.ownsFinish(id)) { P.equipFinish(selWeapon, id); }
        else if (P.buyFinish(id)) { P.equipFinish(selWeapon, id); SKY.SFX.init(); SKY.SFX.pick(); }
        else { flashPoor(fCard); return; }
        renderPanel();
      }
    };
  }

  function flashPoor(el) {
    el.classList.remove('lk-poor');
    void el.offsetWidth;         // restart the animation
    el.classList.add('lk-poor');
    SKY.SFX.init(); SKY.SFX.dry();
  }

  return {
    renderPanel,
    tick(dt) { tickPreview(dt); },
    refreshPreview() { rebuildPreview(); },
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
