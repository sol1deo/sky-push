/* =============================================================================
 * SKY PUSH — ARM LAB (hidden viewmodel tuner, open with  index.html?armlab )
 * Live editor for every procedural-animation dial: spring sway, contact
 * jolts, hand damping, arm build (scale/shoulders/stretch) and per-weapon
 * grip sockets — while the game runs next to it. Changes apply INSTANTLY;
 * SAVE persists to localStorage (loaded by arms.js in every session),
 * COPY exports the JSON to bake into the shipped defaults.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.ArmLab = (function () {
  if (!/armlab/.test(location.search)) return {};
  const A = () => SKY.Arms;

  const css = document.createElement('style');
  css.textContent = `
  #armlab { position:fixed; top:0; right:0; bottom:0; width:342px; z-index:59;
    background:rgba(11,14,20,.96); color:#e8ecf5; border-left:1px solid rgba(255,255,255,.14);
    font:12px Inter,system-ui,sans-serif; display:flex; flex-direction:column; }
  #armlab.hidden { display:none; }
  #armlab header { padding:12px 16px; display:flex; align-items:center; gap:10px;
    border-bottom:1px solid rgba(255,255,255,.1); }
  #armlab header h3 { margin:0; font-size:13px; letter-spacing:.18em; color:#ffd34d; }
  #armlab header .sp { flex:1; }
  #armlab .scroll { overflow-y:auto; flex:1; padding-bottom:30px; }
  #armlab .grp { padding:12px 16px 4px; font:800 10px Inter,sans-serif;
    letter-spacing:.16em; color:#9aa4b8; }
  #armlab .row { display:flex; align-items:center; gap:8px; padding:3px 16px; }
  #armlab .row label { width:96px; color:#c6cdd9; font-size:11px; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; }
  #armlab .row input[type=range] { flex:1; accent-color:#ffd34d; }
  #armlab .row .val { width:52px; text-align:right; color:#ffd34d;
    font:600 11px ui-monospace,monospace; }
  #armlab button { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.22);
    color:#e8ecf5; border-radius:8px; padding:6px 11px; font:600 11px Inter,sans-serif;
    letter-spacing:.06em; cursor:pointer; }
  #armlab button:hover { border-color:#ffd34d; color:#ffd34d; }
  #armlab button.on { background:#ffd34d; color:#141821; border-color:#ffd34d; }
  #armlab .btns { display:flex; flex-wrap:wrap; gap:6px; padding:8px 16px; }
  #armlab select { background:#141821; color:#e8ecf5; border:1px solid rgba(255,255,255,.22);
    border-radius:8px; padding:5px 8px; font:600 11px Inter,sans-serif; flex:1; }
  #armlab .hint { padding:8px 16px; color:#9aa4b8; font-size:11px; }
  #armlab-chip { position:fixed; right:14px; bottom:14px; z-index:60; padding:9px 16px;
    background:#ffd34d; color:#141821; border-radius:10px; font:800 11px Inter,sans-serif;
    letter-spacing:.12em; cursor:pointer; user-select:none; }`;
  document.head.appendChild(css);

  const el = document.createElement('div');
  el.id = 'armlab';
  document.body.appendChild(el);
  const chip = document.createElement('div');
  chip.id = 'armlab-chip';
  chip.textContent = 'ARM LAB';
  chip.onclick = () => el.classList.toggle('hidden');
  document.body.appendChild(chip);

  /* ---------------- slider spec ----------------
     [holder-fn, key-or-index, label, min, max, step, onChange?] */
  const num = (v) => Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
  let saveT = 0;
  function persist() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try {
        localStorage.setItem(A().LAB_KEY, JSON.stringify(
          { v: 1, CFG: A().CFG, SWAY: A().SWAY, RIG: A().RIG_OVR }));
      } catch (e) {}
    }, 250);
  }
  function row(parent, obj, key, idx, label, min, max, step, onCh) {
    const r = document.createElement('div');
    r.className = 'row';
    const get = () => idx === null ? obj()[key] : obj()[key][idx];
    const set = (v) => { if (idx === null) obj()[key] = v; else obj()[key][idx] = v; };
    r.innerHTML = `<label title="${label}">${label}</label>
      <input type="range" min="${min}" max="${max}" step="${step}">
      <span class="val"></span>`;
    const inp = r.querySelector('input'), val = r.querySelector('.val');
    const refresh = () => { inp.value = get(); val.textContent = num(+get()); };
    refresh();
    inp.oninput = () => {
      set(+inp.value);
      val.textContent = num(+inp.value);
      if (onCh) onCh();
      persist();
    };
    r._refresh = refresh;
    parent.appendChild(r);
    return r;
  }
  const grp = (parent, name) => {
    const g = document.createElement('div');
    g.className = 'grp';
    g.textContent = name;
    parent.appendChild(g);
  };

  const head = document.createElement('header');
  head.innerHTML = '<h3>ARM LAB</h3><span class="sp"></span>';
  const btnReset = document.createElement('button');
  btnReset.textContent = 'RESET';
  btnReset.onclick = () => {
    if (!confirm('Reset all arm-lab tuning to defaults?')) return;
    localStorage.removeItem(A().LAB_KEY);
    location.reload();
  };
  const btnCopy = document.createElement('button');
  btnCopy.textContent = 'COPY JSON';
  btnCopy.onclick = () => {
    const json = JSON.stringify({ CFG: A().CFG, SWAY: A().SWAY, RIG: A().RIG_OVR }, null, 1);
    try { navigator.clipboard.writeText(json); } catch (e) {}
    console.log('[armlab]', json);
    btnCopy.textContent = 'COPIED ✓';
    setTimeout(() => { btnCopy.textContent = 'COPY JSON'; }, 1200);
  };
  head.appendChild(btnCopy);
  head.appendChild(btnReset);
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'scroll';
  el.appendChild(body);

  /* ---------------- preview drivers ---------------- */
  grp(body, 'PREVIEW');
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Start a VS BOTS match first — the lab drives the live viewmodel.';
  body.appendChild(hint);
  const selRow = document.createElement('div');
  selRow.className = 'btns';
  const wsel = document.createElement('select');
  selRow.appendChild(wsel);
  body.appendChild(selRow);
  const fillWeapons = () => {
    const ks = SKY.TUNING && SKY.TUNING.weapons ? Object.keys(SKY.TUNING.weapons) : [];
    wsel.innerHTML = ks.map((k) => `<option value="${k}">${k.toUpperCase()}</option>`).join('');
  };
  fillWeapons();
  wsel.onchange = () => {
    const p = SKY.Game.player;
    if (!p || !p.alive) return;
    p.slots[1] = wsel.value;
    p.slotAmmo[1] = 999;
    p.switchSlot(1, true);
    buildRigRows();
  };
  const btns = document.createElement('div');
  btns.className = 'btns';
  body.appendChild(btns);
  const act = (label, fn, toggle) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { const on = fn(b); if (toggle) b.classList.toggle('on', !!on); };
    btns.appendChild(b);
    return b;
  };
  let loop = null, loopSpeed = { s: 1 };
  act('RELOAD', () => {
    const p = SKY.Game.player;
    if (p && p.alive) { p.ammo = 1; SKY.Weapons.tryReload(p); }
  });
  act('LOOP RELOAD', () => {
    if (loop) { clearInterval(loop); loop = null; return false; }
    loop = setInterval(() => {
      const p = SKY.Game.player;
      if (!p || !p.alive) return;
      const W = SKY.Weapons.defOf(p);
      const total = W.reloadTime * (p.mods ? p.mods.cdMult : 1);
      const cyc = total / loopSpeed.s + 0.8;
      const t = ((performance.now() / 1000) % cyc) * loopSpeed.s;
      p.reloadT = t < total ? Math.max(0.0001, total - t) : 0;
    }, 16);
    return true;
  }, true);
  act('DRAW', () => {
    const p = SKY.Game.player;
    if (p && p.alive) { p.switchSlot(p.activeSlot === 1 ? 2 : 1, true); }
  });
  act('FIRE', () => {
    const p = SKY.Game.player;
    if (p && p.alive) { p.ammo = Math.max(p.ammo, 2); SKY.Weapons.tryFirePrimary(p); }
  });
  row(body, () => loopSpeed, 's', null, 'loop speed', 0.15, 1.5, 0.05);

  /* ---------------- SWAY ---------------- */
  grp(body, 'SWAY SPRINGS (movement + look inertia)');
  const S = () => A().SWAY;
  const swayRows = [
    ['freq', 'stiffness', 1, 14, 0.1], ['zeta', 'damping', 0.05, 1, 0.01],
    ['lookRot', 'look rot lag', 0, 0.2, 0.002], ['lookPos', 'look pos lag', 0, 0.05, 0.001],
    ['lookRoll', 'look roll', 0, 0.12, 0.002],
    ['movePos', 'move drift', 0, 0.09, 0.002], ['moveRoll', 'strafe lean', 0, 0.09, 0.002],
    ['fallTilt', 'fall tilt', 0, 0.25, 0.005], ['riseFloat', 'jump float', 0, 0.06, 0.001],
    ['bobAmp', 'bob amount', 0, 0.045, 0.001], ['bobFreq', 'bob rate', 2, 15, 0.1],
    ['bobRoll', 'bob roll', 0, 9, 0.1],
    ['landKick', 'land thud', 0, 0.25, 0.005],
    ['animFeed', 'reload sway feed', 0, 8, 0.1], ['joltFeed', 'contact sway feed', 0, 4, 0.05],
    ['maxRot', 'rot cap', 0.02, 0.45, 0.01], ['maxPos', 'pos cap', 0.01, 0.16, 0.005],
  ];
  for (const [k, lb, mn, mx, st] of swayRows) row(body, S, k, null, lb, mn, mx, st);

  /* ---------------- FEEL ---------------- */
  grp(body, 'HANDS & CONTACTS');
  const C = () => A().CFG;
  row(body, C, 'handDamp', null, 'hand chase', 6, 60, 1);
  row(body, C, 'joltScale', null, 'jolt strength', 0, 3, 0.05);

  /* ---------------- ARM BUILD ---------------- */
  grp(body, 'ARM BUILD (rebuilds the rig)');
  const reb = () => { A().refresh(); };
  const apply = () => { A().applyCfg(); };
  row(body, C, 'scale', null, 'arm size', 0.2, 0.9, 0.01, apply);
  row(body, C, 'lenMul', null, 'arm stretch', 1, 3.2, 0.05, reb);
  row(body, C, 'shoulderR', 0, 'shoulder X', 0.1, 0.65, 0.01, () => {
    C().shoulderL[0] = -C().shoulderR[0]; apply();
  });
  row(body, C, 'shoulderR', 1, 'shoulder Y', -0.95, -0.25, 0.01, () => {
    C().shoulderL[1] = C().shoulderR[1]; apply();
  });
  row(body, C, 'shoulderR', 2, 'shoulder Z', -0.35, 0.3, 0.01, () => {
    C().shoulderL[2] = C().shoulderR[2]; apply();
  });
  for (let i = 0; i < 3; i++) row(body, C, 'fistRotR', i, 'R fist rot ' + 'XYZ'[i], -3.2, 3.2, 0.02);
  for (let i = 0; i < 3; i++) row(body, C, 'fistRotL', i, 'L fist rot ' + 'XYZ'[i], -3.2, 3.2, 0.02);

  /* ---------------- PER-WEAPON RIG ---------------- */
  grp(body, 'WEAPON GRIP (current weapon)');
  const rigBox = document.createElement('div');
  body.appendChild(rigBox);
  let rigKind = null;
  function buildRigRows() {
    const kind = (SKY.Effects._vm && SKY.Effects._vm.kind) || wsel.value || 'pistol';
    rigKind = kind;
    rigBox.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'hint';
    t.textContent = 'editing: ' + kind.toUpperCase();
    rigBox.appendChild(t);
    const r = () => A().rigOf(kind);
    const ovr = () => {
      // touched fields persist per-weapon
      A().RIG_OVR[kind] = A().RIG[kind];
      persist();
    };
    const vec = (key, lb, mn, mx) => {
      const cur = r();
      if (!cur[key]) cur[key] = [0, 0, 0];
      for (let i = 0; i < 3; i++) row(rigBox, r, key, i, lb + ' ' + 'XYZ'[i], mn, mx, 0.005, ovr);
    };
    // ranges must cover LONG guns (mega len 0.6, longshot 0.72: an under-
    // barrel support hand needs z past -0.35) — the IK now stretches to reach
    vec('grip', 'grip', -0.5, 0.5);
    vec('gripRot', 'grip rot', -3.2, 3.2);
    vec('fore', 'support', -0.65, 0.65);
    vec('foreRot', 'support rot', -3.2, 3.2);
    vec('bolt', 'bolt', -0.5, 0.5);
  }
  buildRigRows();
  // follow live weapon switches
  setInterval(() => {
    const k = SKY.Effects._vm && SKY.Effects._vm.kind;
    if (k && k !== rigKind) { buildRigRows(); if (wsel.value !== k) wsel.value = k; }
    if (!wsel.options.length) fillWeapons();
  }, 600);

  return { open: () => el.classList.remove('hidden') };
})();
