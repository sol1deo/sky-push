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

  /* ---------------- nav ---------------- */
  function refreshNav() {
    const acct = A();
    const nick = $('nav-nick');
    const fr = $('nav-friends');
    $('tab-profile').classList.toggle('hidden', !acct.enabled);
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
      <div class="pf-banner" style="background:${banners[p.banner] || banners.sky}">
        <span class="pav pav-big">${p.avatar && p.avatar.indexOf('e:') === 0 ? p.avatar.slice(2)
          : p.avatar ? `<img src="${p.avatar}" alt="">` : '🙂'}</span>
        <div class="pf-uname">${esc(p.username)}<small>⬡ ${SKY.Profile ? SKY.Profile.coins() : 0} · member since ${new Date(p.created_at).toLocaleDateString()}</small></div>
      </div>
      <div class="pf-sec">Banner</div>
      <div class="pf-row">${Object.keys(banners).map(b =>
        `<div class="pf-sw${p.banner === b ? ' sel' : ''}" data-banner="${b}" style="background:${banners[b]}" title="${b}"></div>`).join('')}</div>
      <div class="pf-sec">Avatar</div>
      <div class="pf-row">${acct.AVATARS.map(a =>
        `<span class="pav pav-mid pf-av-opt${p.avatar === 'e:' + a ? ' sel' : ''}" data-av="e:${a}">${a}</span>`).join('')}
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
    if (avf) avf.onchange = async (e) => {
      if (e.target.files[0]) { await acct.uploadAvatar(e.target.files[0]); renderPanel(); }
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
    $('fp-banner').style.background = acct.BANNERS[p.banner] || acct.BANNERS.sky;
    $('fp-av').innerHTML = p.avatar && p.avatar.indexOf('e:') === 0 ? p.avatar.slice(2)
      : p.avatar ? `<img src="${p.avatar}" alt="">` : '🙂';
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
