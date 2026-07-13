/* =============================================================================
 * SKY PUSH — accounts / profiles / friends (Supabase)
 *
 * >>> SETUP (one time): paste your Supabase project values below. <<<
 *   SUPA_URL  = Project Settings → API → Project URL   (https://xxxx.supabase.co)
 *   SUPA_ANON = Project Settings → API → anon public key (safe to ship — RLS
 *               protects the data; NEVER put the service_role key here)
 * Then run supabase/schema.sql in the SQL editor (see that file's header).
 *
 * With the keys EMPTY the whole game runs exactly as before: everyone is a
 * guest, cosmetics live in localStorage, no account UI beyond a hint.
 *
 * What accounts add:
 *   - email+password sign-up with a UNIQUE username (that username IS your
 *     in-game name; guests keep auto "BEAN-XXX" names and can't rename)
 *   - profile page: avatar (emoji preset or uploaded image), banner, bio
 *   - cosmetics + coins saved to the account (and buying REQUIRES an account)
 *   - friends: request/accept/remove, live online presence, JOIN their lobby
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Account = (function () {
  /* ======================= PASTE YOUR KEYS HERE ======================= */
  const SUPA_URL = 'https://vtzxdqlijmesriqfewiv.supabase.co';
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0enhkcWxpam1lc3JpcWZld2l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5Mzc2NTMsImV4cCI6MjA5OTUxMzY1M30.hT5URR4IEbqg5ePl2QxvhKakLMisW6Tc5jfLoBDQG14';
  /* ==================================================================== */

  const $ = (id) => document.getElementById(id);

  const BANNERS = {
    sky:      'linear-gradient(120deg,#1c3f8f 0%,#40c8ff 60%,#bfe9ff 100%)',
    sunset:   'linear-gradient(120deg,#2a1a4a 0%,#ff5d3b 65%,#ffd34d 100%)',
    ocean:    'linear-gradient(120deg,#052c46 0%,#0d6e8c 55%,#2ee6c8 100%)',
    lava:     'linear-gradient(120deg,#1a0c0c 0%,#8a2408 55%,#ffb85a 100%)',
    forest:   'linear-gradient(120deg,#0c2414 0%,#2a6a3a 60%,#b8ff6a 100%)',
    midnight: 'linear-gradient(120deg,#05070f 0%,#1a2440 60%,#5a70ac 100%)',
    candy:    'linear-gradient(120deg,#5a1a4a 0%,#ff5db1 60%,#ffd8e8 100%)',
    gold:     'linear-gradient(120deg,#2a1f05 0%,#aa7d00 55%,#ffd34d 100%)',
  };
  // presets = the game's own cast, rendered as portraits ('c:<CharId>');
  // players can also upload a custom image
  const AVATARS = ['Casual_Male', 'Casual_Female', 'BlueSoldier_Male',
    'BlueSoldier_Female', 'Worker_Male', 'Chef_Male', 'Cowboy_Female',
    'Pirate_Female', 'Suit_Male', 'Ninja_Male'].map(id => 'c:' + id);

  let sb = null;
  let session = null;
  let profile = null;          // my profiles row
  let friends = [];            // [{ id, username, avatar, banner, bio, fid, incoming }]
  let pendingIn = [];          // requests TO me
  let pendingOut = [];         // requests FROM me
  let presenceCh = null;
  let presenceState = {};      // user_id -> { username, av, lobby, pub, inGame }
  let lastTracked = '';
  let pushTimer = null;

  const api = {
    enabled: false,
    BANNERS, AVATARS,
    isLoggedIn() { return !!(session && profile); },
    user() { return session ? session.user : null; },
    profile() { return profile; },
    username() { return profile ? String(profile.username) : null; },
    friends() { return friends; },
    pendingIn() { return pendingIn; },
    pendingOut() { return pendingOut; },
    onChange: null,              // UI refresh hook (menu re-renders)

    /* my avatar descriptor for rosters: 'e:🙂' | url | null (guest) */
    avatarDesc() { return profile ? profile.avatar : null; },

    /* who's online right now: [{ id, username, av, lobby, pub, inGame }] */
    onlineFriends() {
      return friends
        .filter(f => presenceState[f.id])
        .map(f => ({ ...f, ...presenceState[f.id] }));
    },

    async init() {
      if (!SUPA_URL || !SUPA_ANON || !window.supabase) return;
      try {
        sb = window.supabase.createClient(SUPA_URL, SUPA_ANON);
      } catch (e) { return; }
      api.enabled = true;
      const { data } = await sb.auth.getSession();
      session = data ? data.session : null;
      sb.auth.onAuthStateChange((ev, s) => {
        session = s;
        if (!s) {
          profile = null;
          friends = []; pendingIn = []; pendingOut = [];
          stopPresence();
          changed();
        } else {
          afterLogin();
        }
      });
      if (session) await afterLogin();
      startPresence();          // guests appear in presence? no — only logged in
      changed();
    },

    /* -------------------- auth -------------------- */
    async checkUsername(name) {
      if (!/^[A-Za-z0-9_]{3,14}$/.test(name)) return { ok: false, why: '3–14 letters, numbers, _' };
      const { data, error } = await sb.rpc('username_available', { name });
      if (error) return { ok: false, why: error.message };
      return data ? { ok: true } : { ok: false, why: 'username is taken' };
    },
    async signUp(email, password, username) {
      const chk = await api.checkUsername(username);
      if (!chk.ok) return { error: chk.why };
      const { error } = await sb.auth.signUp({
        email, password,
        options: { data: { username } },
      });
      if (error) return { error: error.message };
      // if email confirmation is ON in the dashboard there's no session yet
      if (!session) return { needsConfirm: true };
      return {};
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      return error ? { error: error.message } : {};
    },
    async signOut() { try { await sb.auth.signOut(); } catch (e) {} },

    /* -------------------- profile -------------------- */
    async updateProfile(patch) {
      if (!api.isLoggedIn()) return false;
      const { error } = await sb.from('profiles').update(patch).eq('id', session.user.id);
      if (!error) { Object.assign(profile, patch); changed(); }
      return !error;
    },
    /* pre-cropped blobs from the cropper UI */
    async uploadAvatarBlob(blob) {
      if (!api.isLoggedIn() || !blob) return false;
      const path = session.user.id + '/avatar-' + Date.now() + '.png';
      const { error } = await sb.storage.from('avatars').upload(path, blob, { upsert: true });
      if (error) return false;
      const { data } = sb.storage.from('avatars').getPublicUrl(path);
      return api.updateProfile({ avatar: data.publicUrl });
    },
    async uploadBannerBlob(blob) {
      if (!api.isLoggedIn() || !blob) return false;
      const path = session.user.id + '/banner-' + Date.now() + '.jpg';
      const { error } = await sb.storage.from('avatars').upload(path, blob, { upsert: true });
      if (error) return false;
      const { data } = sb.storage.from('avatars').getPublicUrl(path);
      return api.updateProfile({ banner: data.publicUrl });
    },
    /* wide custom banner image -> storage -> profiles.banner = url */
    async uploadBanner(file) {
      if (!api.isLoggedIn() || !file) return false;
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = rej;
        i.src = URL.createObjectURL(file);
      });
      const c = document.createElement('canvas');
      c.width = 640; c.height = 170;
      // cover-crop to the banner aspect
      const scale = Math.max(640 / img.width, 170 / img.height);
      const w = img.width * scale, hh = img.height * scale;
      c.getContext('2d').drawImage(img, (640 - w) / 2, (170 - hh) / 2, w, hh);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
      const path = session.user.id + '/banner-' + Date.now() + '.jpg';
      const { error } = await sb.storage.from('avatars').upload(path, blob, { upsert: true });
      if (error) return false;
      const { data } = sb.storage.from('avatars').getPublicUrl(path);
      return api.updateProfile({ banner: data.publicUrl });
    },
    async uploadAvatar(file) {
      if (!api.isLoggedIn() || !file) return false;
      // square-crop + shrink client-side; nobody needs a 4MB avatar
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = rej;
        i.src = URL.createObjectURL(file);
      });
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img,
        (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      const path = session.user.id + '/avatar-' + Date.now() + '.png';
      const { error } = await sb.storage.from('avatars').upload(path, blob, { upsert: true });
      if (error) return false;
      const { data } = sb.storage.from('avatars').getPublicUrl(path);
      return api.updateProfile({ avatar: data.publicUrl });
    },
    async fetchProfile(userId) {
      const { data } = await sb.from('profiles')
        .select('id, username, avatar, banner, bio, created_at').eq('id', userId).single();
      return data || null;
    },

    /* -------------------- friends -------------------- */
    async addFriendByUsername(name) {
      if (!api.isLoggedIn()) return { error: 'sign in first' };
      const { data: who } = await sb.from('profiles')
        .select('id, username').eq('username', name).maybeSingle();
      if (!who) return { error: 'no player with that name' };
      if (who.id === session.user.id) return { error: 'that is you' };
      const { error } = await sb.from('friendships')
        .insert({ requester: session.user.id, addressee: who.id, status: 'pending' });
      if (error) {
        return { error: /duplicate|unique/i.test(error.message)
          ? 'already friends (or a request is pending)' : error.message };
      }
      await loadFriends();
      return {};
    },
    async acceptFriend(fid) {
      await sb.from('friendships').update({ status: 'accepted' }).eq('id', fid);
      await loadFriends();
    },
    async removeFriend(fid) {
      await sb.from('friendships').delete().eq('id', fid);
      await loadFriends();
    },

    /* -------------------- cosmetics cloud sync -------------------- */
    /* called (debounced) from profile.js save() — pushes the whole bundle */
    pushCosmetics() {
      if (!api.isLoggedIn() || !SKY.Profile) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        const d = SKY.Profile.data;
        sb.from('profiles')
          .update({ cosmetics: d, coins: d.coins })
          .eq('id', session.user.id)
          .then(() => {}, () => {});
      }, 1200);
    },
  };

  function changed() { if (api.onChange) { try { api.onChange(); } catch (e) {} } }

  async function afterLogin() {
    // profile row is trigger-created; may lag a beat right after signup
    for (let i = 0; i < 6 && !profile; i++) {
      profile = await api.fetchMine();
      if (!profile) await new Promise(r => setTimeout(r, 700));
    }
    if (!profile) return;
    // cloud cosmetics REPLACE local guest state (account is the truth)
    if (SKY.Profile) {
      const cloud = profile.cosmetics;
      if (cloud && Object.keys(cloud).length) {
        Object.assign(SKY.Profile.data, cloud);
        try { localStorage.setItem('skypush-profile', JSON.stringify(SKY.Profile.data)); } catch (e) {}
      } else {
        api.pushCosmetics();   // first login: adopt whatever the guest had
      }
      if (SKY.Profile.onChange) SKY.Profile.onChange();
    }
    // the account username IS the nickname
    if (SKY.Settings) {
      SKY.Settings.data.nickname = String(profile.username);
      SKY.Settings.save();
    }
    await loadFriends();
    startPresence();
    listenFriendships();
    changed();
  }

  api.fetchMine = async function () {
    if (!session) return null;
    const { data } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    return data || null;
  };

  async function loadFriends() {
    if (!api.isLoggedIn()) return;
    const me = session.user.id;
    const { data } = await sb.from('friendships')
      .select('id, requester, addressee, status');
    friends = []; pendingIn = []; pendingOut = [];
    if (!data) { changed(); return; }
    const otherIds = data.map(f => f.requester === me ? f.addressee : f.requester);
    let profs = {};
    if (otherIds.length) {
      const { data: rows } = await sb.from('profiles')
        .select('id, username, avatar, banner, bio').in('id', otherIds);
      for (const r of rows || []) profs[r.id] = r;
    }
    for (const f of data) {
      const otherId = f.requester === me ? f.addressee : f.requester;
      const p = profs[otherId];
      if (!p) continue;
      const entry = { ...p, fid: f.id, incoming: f.addressee === me };
      if (f.status === 'accepted') friends.push(entry);
      else (f.addressee === me ? pendingIn : pendingOut).push(entry);
    }
    friends.sort((a, b) => String(a.username).localeCompare(String(b.username)));
    changed();
  }

  let friendshipCh = null;
  function listenFriendships() {
    if (friendshipCh || !sb) return;
    friendshipCh = sb.channel('friendships-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' },
        () => loadFriends())
      .subscribe();
  }

  /* -------------------- presence: who's online + where -------------------- */
  function presencePayload() {
    const N = SKY.Net;
    return {
      username: api.username(),
      av: profile ? profile.avatar : null,
      lobby: N && N.online ? (N.roster && N.inGame ? null : currentCode()) : null,
      inGame: !!(N && N.inGame),
    };
  }
  function currentCode() {
    // 'direct' lobbies can't be joined by code — don't advertise them
    const c = SKY.Net && SKY.Net.online ? SKY.Net.codePublic() : null;
    return c;
  }
  function startPresence() {
    if (!api.isLoggedIn() || presenceCh || !sb) return;
    presenceCh = sb.channel('presence:online', {
      config: { presence: { key: session.user.id } },
    });
    presenceCh.on('presence', { event: 'sync' }, () => {
      presenceState = {};
      const st = presenceCh.presenceState();
      for (const key in st) {
        if (st[key] && st[key][0]) presenceState[key] = st[key][0];
      }
      changed();
    });
    presenceCh.subscribe((status) => {
      if (status === 'SUBSCRIBED') track(true);
    });
    // keep lobby/in-game status fresh (only re-tracks when it changed)
    setInterval(() => track(false), 4000);
  }
  function stopPresence() {
    if (presenceCh) { try { presenceCh.unsubscribe(); } catch (e) {} presenceCh = null; }
    presenceState = {};
    lastTracked = '';
  }
  function track(force) {
    if (!presenceCh || !api.isLoggedIn()) return;
    const p = presencePayload();
    const key = JSON.stringify(p);
    if (!force && key === lastTracked) return;
    lastTracked = key;
    try { presenceCh.track(p); } catch (e) {}
  }

  return api;
})();
