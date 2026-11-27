/*
 * Быстрый выбор клиента из базы — в договоре («Документы») и в смене статуса («Парк»).
 * Ищет по имени, телефону или номеру паспорта в CRM и прошлых договорах
 * (GET /api/staff/clients/pick); из последнего договора берёт паспорт, права, адрес.
 *   pick.clientBox(key, label) — поле поиска и список; pick.on(key, (client, box) => …) — что делать с выбранным
 * Слушает документ сам: работает и во вкладках, и в окнах поверх них.
 */
(function () {
  'use strict';

  function create(ctx) {
    const { api, esc, t } = ctx;
    const handlers = new Map();
    const results = new WeakMap();
    let timer = null;
    let seq = 0;
    const dm = (iso) => (iso ? `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)}` : '');

    function clientBox(key, label) {
      return `<div class="pick" data-pick-box="${esc(key)}">
        <label class="field"><span>🔎 ${esc(label || t('pick.client'))}</span>
          <input class="search" type="search" data-pick-q autocomplete="off" enterkeyhint="search" placeholder="${esc(t('pick.clientHint'))}"></label>
        <div class="pick-list" data-pick-list hidden></div>
        <p class="pick-note muted jr-small" data-pick-note hidden></p>
      </div>`;
    }

    function itemHtml(c, i) {
      const badges = [];
      if (c.rent) badges.push(`<span class="pill pill--rent">${esc(t('pick.rent', { plate: c.rent.plates?.[0] || '', to: dm(c.rent.to) }))}</span>`);
      if (c.booking) badges.push(`<span class="pill pill--reserve">${esc(t('pick.booking', { plate: c.booking.plates?.[0] || '', from: dm(c.booking.from) }))}</span>`);
      if (c.contract) badges.push(`<span class="pill">📄 ${esc(c.contract.number)}</span>`);
      if (c.passport) badges.push(`<span class="pill pill--free">🛂 ${esc(t('pick.hasDocs'))}</span>`);
      return `<button type="button" class="pick-item" data-pick-item="${i}">
        <span><b>${esc(c.name || '—')}</b> <span class="muted">${esc(c.phone || '')}</span></span>
        ${badges.length ? `<span class="pick-badges">${badges.join(' ')}</span>` : ''}</button>`;
    }

    async function search(box, q) {
      const list = box.querySelector('[data-pick-list]');
      if (q.length < 2) { list.hidden = true; list.innerHTML = ''; return; }
      const mine = ++seq;
      let items = [];
      try {
        items = (await api(`/clients/pick?q=${encodeURIComponent(q)}`)).items || [];
      } catch {
        items = null;
      }
      if (mine !== seq || !box.isConnected) return;
      results.set(box, items || []);
      list.hidden = false;
      list.innerHTML = items === null ? `<p class="muted jr-small">${esc(t('app.loadFailed'))}</p>`
        : items.length ? items.map(itemHtml).join('') : `<p class="muted jr-small">${esc(t('pick.none'))}</p>`;
    }

    function choose(box, i) {
      const item = results.get(box)?.[i];
      if (!item) return;
      box.querySelector('[data-pick-list]').hidden = true;
      box.querySelector('[data-pick-q]').value = '';
      const note = box.querySelector('[data-pick-note]');
      note.hidden = false;
      note.textContent = `✓ ${t(item.contract ? 'pick.chosenDocs' : 'pick.chosen', { name: item.name, no: item.contract?.number || '' })}`;
      handlers.get(box.dataset.pickBox)?.(item, box);
    }

    document.addEventListener('input', (event) => {
      const input = event.target.closest?.('[data-pick-q]');
      if (!input) return;
      const box = input.closest('[data-pick-box]');
      clearTimeout(timer);
      timer = setTimeout(() => search(box, input.value.trim()), 250);
    });
    // Enter в поле поиска не отправляет форму — выбирает первого
    document.addEventListener('keydown', (event) => {
      const input = event.target.closest?.('[data-pick-q]');
      if (!input || event.key !== 'Enter') return;
      event.preventDefault();
      const box = input.closest('[data-pick-box]');
      if (results.get(box)?.length && !box.querySelector('[data-pick-list]').hidden) choose(box, 0);
    });
    document.addEventListener('click', (event) => {
      const btn = event.target.closest?.('[data-pick-item]');
      if (!btn) return;
      choose(btn.closest('[data-pick-box]'), Number(btn.dataset.pickItem));
    });

    return { clientBox, on: (key, fn) => handlers.set(key, fn) };
  }

  window.STAFF_PICK = { create };
})();
