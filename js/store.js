/* =============================================================================
 * SKY PUSH — the ⬡ coin store. Four packs with real-money price tags and the
 * painted pack art (assets/store/pack1-4.jpg). Checkout is pluggable: drop a
 * payment link (Stripe payment link, Ko-fi, itch.io reward URL...) into
 * CHECKOUT below and the BUY buttons open it; while a pack has no link the
 * button says NOTIFY ME and remembers the interest locally.
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

  function fmtCoins(n) { return n.toLocaleString('en-US'); }

  function renderPanel() {
    const panel = document.getElementById('panel-store');
    if (!panel) return;
    const notified = JSON.parse(localStorage.getItem('skypush-store-notify') || '[]');
    const cards = PACKS.map((p) => {
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
          <h3>COIN STORE</h3>
          <div class="st-sub">⬡ buys characters and weapon skins in the LOCKER —
            every match pays some out, packs skip the grind</div>
        </div>
        <div class="st-balance">BALANCE <b>⬡ ${fmtCoins(SKY.Profile.coins())}</b></div>
      </div>
      <div class="st-grid">${cards}</div>
      <div class="st-note">purchases open a secure checkout in a new tab — coins land on your
        account after payment. Payments are still being switched on: hit a pack to
        get on the launch list.</div>`;

    panel.onclick = (e) => {
      const b = e.target.closest('[data-buy]');
      if (!b) return;
      const id = b.dataset.buy;
      const url = CHECKOUT[id];
      if (url) {
        window.open(url, '_blank', 'noopener');
        return;
      }
      // no payment link yet — register the interest so launch has numbers
      const list = JSON.parse(localStorage.getItem('skypush-store-notify') || '[]');
      if (!list.includes(id)) {
        list.push(id);
        localStorage.setItem('skypush-store-notify', JSON.stringify(list));
      }
      if (SKY.SFX) { SKY.SFX.init(); SKY.SFX.cash(); }
      b.textContent = '✓ ON THE LIST';
      b.classList.add('st-listed');
      const note = panel.querySelector('.st-note');
      if (note) note.textContent = 'payments are almost live — you’re on the list, this pack unlocks the moment checkout opens.';
    };
  }

  return { renderPanel, PACKS, CHECKOUT };
})();
