/* =============================================================================
 * SKY PUSH — account/profile/friends UI (data layer: js/account.js)
 *   - nav chips: SIGN IN / avatar+name, friends-online counter
 *   - PROFILE menu tab: banner + avatar + bio editing, friends list
 *     (online dots, JOIN their lobby, view profile, remove), requests
 *   - sign-in / sign-up modal (username live availability check)
 * Everything renders a "not configured" hint until the Supabase keys are in.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.AccountUI = (function () {
  const $ = (id) => document.getElementById(id);
  const A = () => SKY.Account;
  let mode = 'in';            // modal: 'in' | 'up'
  let userChkT = null;
  let iconRig = null;

  /* banner value -> css background (preset id or an uploaded image url) */
  function bannerCss(b) {
    if (b && /^https?:/.test(b)) return `#12151d url(${b}) center/cover no-repeat`;
    return A().BANNERS[b] || A().BANNERS.sky;
  }

  /* render the cast as PORTRAITS for avatar presets (cache: SKY._charIcons).
     Async-ish: returns false until the character pack is in; callers just
     re-render when it lands. */
  function ensureCharIcons() {
    if (!SKY.GFX || !SKY.GFX.charReady || !SKY.GFX.charReady()) return false;
    SKY._charIcons = SKY._charIcons || {};
    const chars = (SKY.Profile && SKY.Profile.CHARS) || [];
    let made = false;
    for (const cd of chars) {
      if (SKY._charIcons[cd.id]) continue;
      const inst = SKY.GFX.charInstance(0, cd.id);
      if (!inst) continue;
      try {
        if (!iconRig) {
          const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
          r.setSize(72, 72); r.setPixelRatio(1);
          r.outputEncoding = THREE.sRGBEncoding;
          const sc = new THREE.Scene();
          sc.add(new THREE.HemisphereLight(0xe8f0ff, 0x3a4150, 1.25));
          const key = new THREE.DirectionalLight(0xffffff, 1.3);
          key.position.set(0.8, 1.6, 2);
          sc.add(key);
          iconRig = { r, sc, cam: new THREE.PerspectiveCamera(30, 1, 0.01, 50) };
        }
        const root = inst.root;
        iconRig.sc.add(root);
        const h = inst.height || 1.8;
        // head-and-shoulders framing, straight-on (UACP faces +Z) — the
        // camera sits at FACE height or the icons are all scalp
        iconRig.cam.position.set(0, h * 0.76, h * 0.95);
        iconRig.cam.lookAt(0, h * 0.74, 0);
        iconRig.r.render(iconRig.sc, iconRig.cam);
        SKY._charIcons[cd.id] = iconRig.r.domElement.toDataURL();
        iconRig.sc.remove(root);
        made = true;
      } catch (e) {}
    }
    return made;
  }

  /* ---------------- image cropper ----------------
     drag = pan, wheel/slider = zoom; SAVE crops the visible region into an
     outW x outH blob. `round` shapes the stage like the avatar chip. */
  const crop = { img: null, scale: 1, min: 1, ox: 0, oy: 0, outW: 0, outH: 0,
    stW: 0, stH: 0, then: null };
  function openCropper(file, outW, outH, round, then) {
    const img = new Image();
    img.onload = () => {
      crop.img = img; crop.outW = outW; crop.outH = outH; crop.then = then;
      const maxW = 320;
      crop.stW = outW >= outH ? maxW : Math.round(maxW * outW / outH);
      crop.stH = Math.round(crop.stW * outH / outW);
      const cv = $('crop-canvas');
      cv.width = crop.stW; cv.height = crop.stH;
      $('crop-stage').style.width = crop.stW + 'px';
      $('crop-stage').style.height = crop.stH + 'px';
      $('crop-stage').classList.toggle('round', !!round);
      // cover-fit start
      crop.min = Math.max(crop.stW / img.width, crop.stH / img.height);
      crop.scale = crop.min;
      crop.ox = (crop.stW - img.width * crop.scale) / 2;
      crop.oy = (crop.stH - img.height * crop.scale) / 2;
      $('crop-zoom').value = 100;
      drawCrop();
      $('crop-modal').classList.remove('hidden');
    };
    img.src = URL.createObjectURL(file);
  }
  function clampCrop() {
    const w = crop.img.width * crop.scale, h = crop.img.height * crop.scale;
    crop.ox = SKY.U.clamp(crop.ox, crop.stW - w, 0);
    crop.oy = SKY.U.clamp(crop.oy, crop.stH - h, 0);
  }
  function drawCrop() {
    if (!crop.img) return;
    clampCrop();
    const g = $('crop-canvas').getContext('2d');
    g.clearRect(0, 0, crop.stW, crop.stH);
    g.drawImage(crop.img, crop.ox, crop.oy,
      crop.img.width * crop.scale, crop.img.height * crop.scale);
  }
  function zoomCrop(mult, cxr, cyr) {
    const old = crop.scale;
    crop.scale = SKY.U.clamp(old * mult, crop.min, crop.min * 4);
    const k = crop.scale / old;
    // zoom around the given stage point (defaults to center)
    const cx = cxr !== undefined ? cxr : crop.stW / 2;
    const cy = cyr !== undefined ? cyr : crop.stH / 2;
    crop.ox = cx - (cx - crop.ox) * k;
    crop.oy = cy - (cy - crop.oy) * k;
    $('crop-zoom').value = Math.round((crop.scale / crop.min) * 100);
    drawCrop();
  }
  function finishCrop() {
    const out = document.createElement('canvas');
    out.width = crop.outW; out.height = crop.outH;
    const k = crop.outW / crop.stW;
    out.getContext('2d').drawImage(crop.img,
      crop.ox * k, crop.oy * k,
      crop.img.width * crop.scale * k, crop.img.height * crop.scale * k);
    $('crop-modal').classList.add('hidden');
    out.toBlob((b) => { if (crop.then) crop.then(b); },
      crop.outW > 200 ? 'image/jpeg' : 'image/png', 0.88);
  }
  function wireCropper() {
    const stage = $('crop-stage');
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      crop.ox += e.clientX - drag.x;
      crop.oy += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      drawCrop();
    });
    stage.addEventListener('pointerup', () => { drag = null; });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomCrop(e.deltaY > 0 ? 0.92 : 1.09, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    $('crop-zoom').addEventListener('input', (e) => {
      const target = crop.min * (+e.target.value / 100);
      zoomCrop(target / crop.scale);
    });
    $('crop-save').onclick = finishCrop;
    $('crop-cancel').onclick = () => $('crop-modal').classList.add('hidden');
    $('crop-modal').addEventListener('click', (e) => {
      if (e.target.id === 'crop-modal') $('crop-modal').classList.add('hidden');
    });
  }

  /* ---------------- nav ---------------- */
  function refreshNav() {
    ensureCharIcons();
    const acct = A();
    const nick = $('nav-nick');
    const fr = $('nav-friends');
    // profile lives behind the top-right nickname / friends chips — the nav
    // tab stays hidden (still click()-able programmatically for those flows)
    $('tab-profile').classList.add('hidden');
    if (!acct.enabled) { fr.classList.add('hidden'); return; }
    if (acct.isLoggedIn()) {
      const p = acct.profile();
      nick.innerHTML = SKY.U.avatarHtml(p.avatar, '#ffd34d', p.username) +
        ' <b>' + p.username + '</b>';
      nick.title = 'your profile';
      const online = acct.onlineFriends().length;
      fr.classList.remove('hidden');
      fr.classList.toggle('online', online > 0);
      $('nav-friends-n').textContent = online;
    } else {
      nick.textContent = 'SIGN IN';
      nick.title = 'create an account — save cosmetics, add friends';
      fr.classList.add('hidden');
    }
  }

  /* ---------------- modal ---------------- */
  function openModal(startMode) {
    mode = startMode || 'in';
    syncModal();
    $('acct-modal').classList.remove('hidden');
    $('acct-email').focus();
  }
  function closeModal() { $('acct-modal').classList.add('hidden'); }
  function syncModal() {
    $('acct-tab-in').classList.toggle('sel', mode === 'in');
    $('acct-tab-up').classList.toggle('sel', mode === 'up');
    $('acct-user-row').classList.toggle('hidden', mode === 'in');
    $('acct-go').textContent = mode === 'in' ? 'SIGN IN' : 'CREATE ACCOUNT';
    $('acct-err').textContent = '';
  }
  async function submit() {
    const email = $('acct-email').value.trim();
    const pass = $('acct-pass').value;
    const err = $('acct-err');
    err.textContent = '';
    if (!email || pass.length < 6) { err.textContent = 'email + a 6+ character password'; return; }
    $('acct-go').disabled = true;
    try {
      let r;
      if (mode === 'up') {
        const uname = $('acct-user').value.trim();
        r = await A().signUp(email, pass, uname);
      } else {
        r = await A().signIn(email, pass);
      }
      if (r && r.error) { err.textContent = r.error; return; }
      if (r && r.needsConfirm) {
        err.style.color = '#49e07f';
        err.textContent = 'check your email to confirm, then sign in';
        mode = 'in'; syncModal();
        return;
      }
      closeModal();
    } finally {
      $('acct-go').disabled = false;
      err.style.color = '';
    }
  }

  /* ---------------- profile panel ---------------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  function renderPanel() {
    const el = $('panel-profile');
    if (!el) return;
    const acct = A();
    if (!acct.enabled) {
      el.innerHTML = `<div class="panel-title">Profile</div>
        <div class="hint" style="margin-top:14px">The account system isn't configured yet —
        paste the Supabase keys into js/account.js and run supabase/schema.sql.</div>`;
      return;
    }
    if (!acct.isLoggedIn()) {
      el.innerHTML = `<div class="panel-title">Profile</div>
        <div class="hint" style="margin:16px 0">Create an account to get a profile:
        a permanent username, avatar &amp; banner, saved cosmetics, and a friends list.</div>
        <button class="btn" id="pf-signin">SIGN IN / CREATE ACCOUNT</button>`;
      $('pf-signin').onclick = () => openModal('in');
      return;
    }
    ensureCharIcons();
    const p = acct.profile();
    const banners = acct.BANNERS;
    const online = {};
    for (const f of acct.onlineFriends()) online[f.id] = f;
    const frRow = (f, kind) => {
      const o = online[f.id];
      const canJoin = o && o.lobby && !o.inGame;
      return `<div class="fr-row${o ? ' online' : ''}" data-fid="${f.fid}" data-uid="${f.id}">
        <i class="fr-dot"></i>
        ${SKY.U.avatarHtml(f.avatar, '#8a94a8', f.username)}
        <b data-view="${f.id}">${esc(f.username)}</b>
        <small>${kind === 'in' ? 'wants to be friends' : kind === 'out' ? 'request sent' :
          o ? (o.inGame ? 'in a match' : o.lobby ? 'in a lobby' : 'online') : 'offline'}</small>
        ${kind === 'in' ? `<button class="fr-btn join" data-accept="${f.fid}">ACCEPT</button>` : ''}
        ${canJoin ? `<button class="fr-btn join" data-join="${o.lobby}">JOIN</button>` : ''}
        <button class="fr-btn" data-remove="${f.fid}">${kind === 'out' ? 'CANCEL' : kind === 'in' ? 'DECLINE' : '✕'}</button>
      </div>`;
    };
    el.innerHTML = `
      <div class="pf-banner" style="background:${bannerCss(p.banner)}">
        ${SKY.U.avatarHtml(p.avatar, '#ffd34d', p.username, 'pav-big')}
        <div class="pf-uname">${esc(p.username)}<small>⬡ ${SKY.Profile ? SKY.Profile.coins() : 0} · member since ${new Date(p.created_at).toLocaleDateString()}</small></div>
      </div>
      <div class="pf-sec">Banner</div>
      <div class="pf-row">${Object.keys(banners).map(b =>
        `<div class="pf-sw${p.banner === b ? ' sel' : ''}" data-banner="${b}" style="background:${banners[b]}" title="${b}"></div>`).join('')}
        <label class="fr-btn" style="cursor:pointer">UPLOAD…<input id="pf-bn-file" type="file" accept="image/*" style="display:none"></label></div>
      <div class="pf-sec">Avatar</div>
      <div class="pf-row">${acct.AVATARS.map(a => {
        const url = SKY._charIcons && SKY._charIcons[a.slice(2)];
        return `<span class="pav pav-mid pf-av-opt${p.avatar === a ? ' sel' : ''}" data-av="${a}">${
          url ? `<img src="${url}" alt="">` : ''}</span>`;
      }).join('')}
        <label class="fr-btn" style="cursor:pointer">UPLOAD…<input id="pf-av-file" type="file" accept="image/*" style="display:none"></label>
      </div>
      <div class="pf-sec">Bio</div>
      <input id="pf-bio" maxlength="120" placeholder="say something (120 chars)" value="${esc(p.bio)}">
      <div class="pf-sec">Friends ${acct.friends().length ? '· ' + acct.friends().length : ''}</div>
      <div id="fr-add-row">
        <input id="fr-add-name" maxlength="14" placeholder="add a friend by username…">
        <button class="fr-btn join" id="fr-add-go">ADD</button>
      </div>
      <div id="fr-err" style="min-height:14px;font-size:11px;color:var(--danger)"></div>
      ${acct.pendingIn().map(f => frRow(f, 'in')).join('')}
      ${acct.friends().map(f => frRow(f, 'fr')).join('')}
      ${acct.pendingOut().map(f => frRow(f, 'out')).join('')}
      ${!acct.friends().length && !acct.pendingIn().length && !acct.pendingOut().length
        ? '<div class="hint">No friends yet — add someone by their username, or from a lobby.</div>' : ''}
      <div class="pf-sec">Account</div>
      <button class="fr-btn" id="pf-signout">SIGN OUT</button>`;

    el.querySelectorAll('[data-banner]').forEach(d => {
      d.onclick = () => acct.updateProfile({ banner: d.dataset.banner }).then(renderPanel);
    });
    el.querySelectorAll('[data-av]').forEach(d => {
      d.onclick = () => acct.updateProfile({ avatar: d.dataset.av }).then(renderPanel);
    });
    const avf = $('pf-av-file');
    if (avf) avf.onchange = (e) => {
      if (!e.target.files[0]) return;
      openCropper(e.target.files[0], 128, 128, true,
        async (b) => { await acct.uploadAvatarBlob(b); renderPanel(); });
      e.target.value = '';
    };
    const bnf = $('pf-bn-file');
    if (bnf) bnf.onchange = (e) => {
      if (!e.target.files[0]) return;
      openCropper(e.target.files[0], 640, 170, false,
        async (b) => { await acct.uploadBannerBlob(b); renderPanel(); });
      e.target.value = '';
    };
    $('pf-bio').onchange = (e) => acct.updateProfile({ bio: e.target.value.slice(0, 120) });
    $('pf-signout').onclick = async () => { await acct.signOut(); renderPanel(); refreshNav(); };
    $('fr-add-go').onclick = async () => {
      const name = $('fr-add-name').value.trim();
      if (!name) return;
      const r = await acct.addFriendByUsername(name);
      $('fr-err').textContent = r.error || '';
      if (!r.error) renderPanel();
    };
    el.querySelectorAll('[data-accept]').forEach(b => {
      b.onclick = () => acct.acceptFriend(+b.dataset.accept).then(renderPanel);
    });
    el.querySelectorAll('[data-remove]').forEach(b => {
      b.onclick = () => acct.removeFriend(+b.dataset.remove).then(renderPanel);
    });
    el.querySelectorAll('[data-join]').forEach(b => {
      b.onclick = () => { if (SKY.Net.joinCode) SKY.Net.joinCode(b.dataset.join); };
    });
    el.querySelectorAll('[data-view]').forEach(b => {
      b.onclick = () => showFriendProfile(b.dataset.view);
    });
  }

  /* ---------------- friend profile modal ---------------- */
  async function showFriendProfile(userId) {
    const acct = A();
    const p = await acct.fetchProfile(userId);
    if (!p) return;
    $('fp-banner').style.background = bannerCss(p.banner);
    $('fp-av').outerHTML = SKY.U.avatarHtml(p.avatar, '#8a94a8', p.username, 'pav-big')
      .replace('class="pav', 'id="fp-av" class="pav');
    $('fp-name').textContent = p.username;
    $('fp-bio').textContent = p.bio || '';
    const fr = acct.friends().find(f => f.id === userId);
    $('fp-actions').innerHTML = fr
      ? `<button class="fr-btn" data-fpremove="${fr.fid}">REMOVE FRIEND</button>` : '';
    const rm = document.querySelector('[data-fpremove]');
    if (rm) rm.onclick = async () => {
      await acct.removeFriend(+rm.dataset.fpremove);
      $('fp-modal').classList.add('hidden');
      renderPanel();
    };
    $('fp-modal').classList.remove('hidden');
  }

  const api = {
    openModal, renderPanel, refreshNav,
    init() {
      $('acct-tab-in').onclick = () => { mode = 'in'; syncModal(); };
      $('acct-tab-up').onclick = () => { mode = 'up'; syncModal(); };
      $('acct-go').onclick = submit;
      $('acct-close').onclick = closeModal;
      $('acct-modal').addEventListener('click', (e) => { if (e.target.id === 'acct-modal') closeModal(); });
      $('fp-close').onclick = () => $('fp-modal').classList.add('hidden');
      $('fp-modal').addEventListener('click', (e) => { if (e.target.id === 'fp-modal') $('fp-modal').classList.add('hidden'); });
      $('acct-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      // live username availability while typing
      $('acct-user').addEventListener('input', () => {
        clearTimeout(userChkT);
        const v = $('acct-user').value.trim();
        const chk = $('acct-user-chk');
        chk.textContent = '';
        if (v.length < 3) return;
        userChkT = setTimeout(async () => {
          const r = await A().checkUsername(v);
          chk.textContent = r.ok ? '✓' : '✕';
          chk.style.color = r.ok ? '#49e07f' : 'var(--danger)';
          chk.title = r.ok ? 'available' : r.why;
        }, 350);
      });
      wireCropper();
      $('nav-friends').onclick = () => {
        document.getElementById('tab-profile').click();
      };
      A().onChange = () => {
        refreshNav();
        // live-refresh the panel if it's on screen
        if (!$('panel-profile').classList.contains('hidden')) renderPanel();
      };
      refreshNav();
    },
  };
  return api;
})();
