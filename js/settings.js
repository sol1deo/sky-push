/* =============================================================================
 * SKY PUSH — settings
 * Rebindable keys for every action, mouse sensitivity, FOV, render scale,
 * shadow quality, vignette and an FPS counter. Persisted to localStorage.
 * The panel UI is built here and opens from the menu and the pause screen.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Settings = (function () {
  const KEY = 'skypush-settings';
  const DEFAULTS = {
    nickname: '',
    sens: 1.0,          // multiplier on mouse sensitivity
    fov: 95,
    renderScale: 1.0,   // multiplier on pixel ratio
    shadows: 'high',    // high | low | off  (applies on next round)
    vignette: true,
    shafts: true,       // cinematic sun rays (applies on next map load)
    showFps: false,
    rawInput: true,     // unadjusted mouse + spike filter; OFF = classic feel
    binds: {
      forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
      jump: 'Space', crouch: 'KeyC',
      fire: 'Mouse0', aim: 'Mouse2', reload: 'KeyR',
      grapple: 'KeyE', cannon: 'KeyQ', grenade: 'KeyG', dash: 'KeyF',
      interact: 'KeyX', buymenu: 'KeyB',
      taunt: 'KeyT', scoreboard: 'Tab', reset: 'KeyP',
      replay: 'KeyV',
    },
  };
  const BIND_LABELS = {
    forward: 'Move forward', back: 'Move back', left: 'Move left', right: 'Move right',
    jump: 'Jump / bhop', crouch: 'Crouch / slide',
    fire: 'Fire', aim: 'Aim / zoom', reload: 'Reload',
    grapple: 'Grapple', cannon: 'Air cannon', grenade: 'Throw grenade', dash: 'Air dash',
    interact: 'Plant / defuse', buymenu: 'Buy menu (bomb)',
    taunt: 'Taunt', scoreboard: 'Scoreboard', reset: 'Reset position',
    replay: 'Replay editor',
  };

  let data = load();
  let listening = null;   // action currently being rebound
  let panel = null;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      const d = JSON.parse(raw);
      const merged = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...d };
      merged.binds = { ...DEFAULTS.binds, ...(d.binds || {}) };
      return merged;
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }

  function apply() {
    SKY.TUNING.camera.baseFov = data.fov;
    const vg = document.getElementById('vignette');
    if (vg) vg.style.display = data.vignette ? '' : 'none';
    const fps = document.getElementById('fps');
    if (fps) fps.classList.toggle('hidden', !data.showFps);
    if (SKY.applyGraphics) SKY.applyGraphics();
    save();
  }

  function bindName(code) {
    if (!code) return '—';
    if (code === 'Mouse0') return 'LMB';
    if (code === 'Mouse2') return 'RMB';
    if (code === 'Mouse1') return 'MMB';
    return code.replace(/^Key|^Digit/, '').replace('Left', 'L-').replace('Right', 'R-');
  }

  /* ---------------- panel UI ---------------- */
  function buildPanel() {
    panel = document.getElementById('settings-ov');
    const box = panel.querySelector('.settings-body');
    const slider = (label, key, min, max, step, fmt) => `
      <div class="set-row"><span>${label}</span>
        <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${data[key]}">
        <b class="set-val" data-v="${key}">${fmt(data[key])}</b></div>`;
    const check = (label, key, note) => `
      <div class="set-row"><span>${label}${note ? ` <small>${note}</small>` : ''}</span>
        <input type="checkbox" data-k="${key}" ${data[key] ? 'checked' : ''}></div>`;

    box.innerHTML = `
      <h4>MOUSE & VIEW</h4>
      ${slider('Sensitivity', 'sens', 0.2, 3, 0.05, v => (+v).toFixed(2) + 'x')}
      ${slider('Field of view', 'fov', 80, 115, 1, v => v + '°')}
      ${check('Raw mouse input', 'rawInput', 'no OS accel + spike filter — turn OFF for the classic feel')}
      <h4>GRAPHICS</h4>
      ${slider('Render scale', 'renderScale', 0.5, 1.5, 0.05, v => Math.round(v * 100) + '%')}
      <div class="set-row"><span>Shadows</span>
        <select data-k="shadows">
          <option value="high" ${data.shadows === 'high' ? 'selected' : ''}>High</option>
          <option value="low" ${data.shadows === 'low' ? 'selected' : ''}>Low</option>
          <option value="off" ${data.shadows === 'off' ? 'selected' : ''}>Off</option>
        </select></div>
      ${check('Vignette', 'vignette')}
      ${check('Light shafts', 'shafts', 'cinematic sun rays — applies next map load')}
      ${check('Show FPS', 'showFps')}
      <h4>CONTROLS <small>click a key, then press the new one (Esc cancels)</small></h4>
      <div class="bind-grid">${Object.keys(DEFAULTS.binds).map(a => `
        <div class="bind-row" data-a="${a}"><span>${BIND_LABELS[a]}</span>
          <button class="bind-btn" data-a="${a}">${bindName(data.binds[a])}</button></div>`).join('')}
      </div>
      <button class="btn small" id="set-defaults">RESET DEFAULTS</button>`;

    box.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      if (e.target.type === 'checkbox') data[k] = e.target.checked;
      else if (e.target.type === 'range') data[k] = parseFloat(e.target.value);
      else data[k] = e.target.value;
      const v = box.querySelector(`[data-v="${k}"]`);
      if (v) {
        if (k === 'sens') v.textContent = data[k].toFixed(2) + 'x';
        else if (k === 'fov') v.textContent = data[k] + '°';
        else if (k === 'renderScale') v.textContent = Math.round(data[k] * 100) + '%';
      }
      apply();
    });

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.bind-btn');
      if (btn) {
        if (listening) listening.el.textContent = bindName(data.binds[listening.action]);
        listening = { action: btn.dataset.a, el: btn };
        btn.textContent = '···';
        e.stopPropagation();
        return;
      }
      if (e.target.id === 'set-defaults') {
        data = JSON.parse(JSON.stringify(DEFAULTS));
        apply();
        buildPanel();   // rebuild with fresh values
      }
    });

    panel.querySelector('#settings-close').onclick = close;
  }

  // capture the next key / mouse button while rebinding
  window.addEventListener('keydown', (e) => {
    if (!listening) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code !== 'Escape') {
      data.binds[listening.action] = e.code;
      save();
    }
    listening.el.textContent = bindName(data.binds[listening.action]);
    listening = null;
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (!listening || e.target.closest('.bind-btn')) return;
    e.preventDefault(); e.stopPropagation();
    data.binds[listening.action] = 'Mouse' + e.button;
    save();
    listening.el.textContent = bindName(data.binds[listening.action]);
    listening = null;
  }, true);

  function open() {
    if (!panel) buildPanel();
    panel.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function close() {
    listening = null;
    panel.classList.add('hidden');
    save();
  }

  return {
    get data() { return data; },
    apply, open, close, save, bindName,
    init() { apply(); },
  };
})();
