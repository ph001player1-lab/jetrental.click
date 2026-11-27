/*
 * Вкладка «CRM» — клиенты: кто, сколько раз брал, сколько заплатил, что сейчас
 * (аренда, бронь, долг), история, метки и заметки. Только на русском, как «Финансы».
 * Видна тем, у кого открыт раздел «CRM» (по умолчанию — владелец и админ);
 * менять (заметки, метки, контакты, объединение дублей) — с уровнем «меняет».
 */
(function () {
  'use strict';

  const FILTERS = [
    ['all', 'Все'], ['rent', 'Сейчас в аренде'], ['booking', 'Бронь'], ['debt', 'Должны'], ['regular', 'Постоянные'],
    ['lost', 'Давно не были'], ['new', 'Новые'], ['vip', 'VIP'], ['problem', 'Проблемные'], ['blacklist', 'Чёрный список'],
    ['dupes', 'Дубли'], ['badPhone', 'Проверить номер']
  ];
  const TAG_LABEL = { regular: 'Постоянный', vip: 'VIP', problem: 'Проблемный', blacklist: 'Чёрный список' };
  const SOURCE = { ws: 'из списка клиентов WS', group: 'из отчётов в группе', request: 'из заявки', manual: 'добавлен вручную' };
  const CHANNEL = { telegram: 'Telegram', whatsapp: 'WhatsApp', site: 'сайт', web: 'сайт' };
  const ERRORS = {
    not_clients: 'Это не список клиентов из WS: нужен файл .xlsx с колонками «Имя» и «Телефон».',
    read_only: 'У вас доступ к CRM только на просмотр.',
    no_section_access: 'Раздел CRM для вас закрыт.',
    name_required: 'Укажите имя.',
    note_required: 'Напишите заметку.',
    not_found: 'Клиент не найден — возможно, его объединили с другим.',
    same_client: 'Это один и тот же клиент.',
    body_too_large: 'Файл слишком большой (больше 20 МБ).'
  };

  function create(ctx) {
    const { api, esc } = ctx;
    const st = {
      filter: 'all', q: '', data: null, failed: null, loading: false,
      openId: null, card: null, cardFailed: null, editing: false, msg: null, listMsg: null, timer: null
    };
    const canEdit = () => ctx.can('crm.edit');

    const fmtNum = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
    const fmtDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' });
    const fmtShort = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
    const fmtWhen = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const num = (n) => fmtNum.format(Math.round(n || 0));
    const baht = (n) => `${num(n)} ฿`;
    const asDate = (iso) => new Date(iso.length === 10 ? `${iso}T12:00:00+07:00` : iso);
    const date = (iso) => (iso ? fmtDate.format(asDate(iso)) : '—');
    const short = (iso) => (iso ? fmtShort.format(asDate(iso)) : '—');
    const when = (iso) => (iso ? fmtWhen.format(new Date(iso)) : '—');
    // Флаг страны из кода ISO («RU» → 🇷🇺)
    const flag = (country) => (country?.code ? String.fromCodePoint(...[...country.code].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '');
    const tagBadges = (tags) => (tags || []).map((tag) => `<span class="crm-tag crm-tag--${esc(tag)}">${esc(TAG_LABEL[tag] || tag)}</span>`).join('');
    const plates = (list) => (list || []).map((p) => `<span class="plate">#${esc(p)}</span>`).join(' ');
    const journalLink = (plate) => (ctx.can('journal.view') && plate
      ? ` <button type="button" class="link jr-small" data-problem="journal" data-q="${esc(plate)}">в журнале</button>` : '');
    const status = (msg) => (msg ? `<p class="md-status is-${msg.kind === 'error' ? 'error' : 'ok'}" role="status">${esc(msg.text)}</p>` : '');
    const errText = (err) => ERRORS[err.code] || 'Не получилось. Попробуйте ещё раз.';

    /* ------------------------------------------------------------- Данные */

    async function loadList() {
      st.loading = true;
      try {
        st.data = await api(`/crm?filter=${encodeURIComponent(st.filter)}&q=${encodeURIComponent(st.q)}`);
        st.failed = null;
      } catch (err) {
        st.failed = errText(err);
      }
      st.loading = false;
    }

    async function load() {
      if (st.openId) return openCard(st.openId);
      await loadList();
      ctx.rerender();
    }

    async function openCard(id) {
      st.openId = id;
      st.card = null;
      st.cardFailed = null;
      st.editing = false;
      ctx.rerender();
      try {
        st.card = await api(`/crm/client?id=${encodeURIComponent(id)}`);
      } catch (err) {
        st.cardFailed = errText(err);
      }
      ctx.rerender();
      window.scrollTo(0, 0);
    }

    async function change(path, body, okText) {
      try {
        st.card = await api(path, { body });
        st.openId = st.card.client.id;
        st.msg = { kind: 'ok', text: okText };
        st.data = null;
      } catch (err) {
        st.msg = { kind: 'error', text: errText(err) };
      }
      ctx.rerender();
    }

    async function importFile(file) {
      if (!file) return;
      st.listMsg = { kind: 'ok', text: 'Загружаем список…' };
      ctx.rerender();
      try {
        const response = await fetch('/api/staff/crm/import', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        const r = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(r.error), { code: r.error });
        await loadList();
        st.listMsg = { kind: 'ok', text: `✓ Строк в файле: ${num(r.rows)}. Новых клиентов: ${num(r.added)}, дополнено: ${num(r.updated)}.` };
      } catch (err) {
        st.listMsg = { kind: 'error', text: errText(err) };
      }
      ctx.rerender();
    }

    /* -------------------------------------------------------------- Список */

    function item(c) {
      const facts = [];
      if (c.phone) facts.push(`${flag(c.country)} ${esc(c.phone)}`.trim());
      else if (c.telegram) facts.push(esc(c.telegram));
      facts.push(c.rentals ? `аренд: ${c.rentals}` : 'аренд нет');
      if (c.paid) facts.push(`заплатил ${baht(c.paid)}`);
      if (c.lastAt) facts.push(`последняя ${short(c.lastAt)}`);
      const now = [];
      if (c.rent) now.push(`<span class="crm-now crm-now--rent">в аренде ${plates(c.rent.plates)}${c.rent.to ? ` до ${short(c.rent.to)}` : ''}</span>`);
      if (c.booking) now.push(`<span class="crm-now crm-now--booking">бронь с ${short(c.booking.from)}</span>`);
      if (c.debt) now.push(`<span class="crm-now crm-now--debt">${c.overdue ? 'просрочен долг' : 'долг'} ${baht(c.debt)}</span>`);
      if (c.dupes) now.push('<span class="crm-now">возможен дубль</span>');
      if (c.badPhone) now.push('<span class="crm-now">проверить номер</span>');
      if (c.notes) now.push(`<span class="crm-now">📝 ${c.notes}</span>`);
      return `
        <li><button type="button" class="crm-item${c.tags.includes('blacklist') ? ' crm-item--black' : ''}" data-crm-open="${c.id}">
          <span class="crm-item__name">${esc(c.name)} ${tagBadges(c.tags)}</span>
          <span class="crm-item__facts">${facts.join(' · ')}</span>
          ${now.length ? `<span class="crm-item__now">${now.join('')}</span>` : ''}
        </button></li>`;
    }

    function results() {
      const d = st.data;
      if (st.failed) return `<div class="empty">${esc(st.failed)}</div>`;
      if (!d) return '<div class="empty">Загружаем…</div>';
      if (!d.items.length) return `<div class="empty">${st.q ? 'Никого не нашли.' : 'В этом списке пока никого нет.'}</div>`;
      return `<ul class="crm-list">${d.items.map(item).join('')}</ul>
        ${d.more ? `<p class="muted jr-small">И ещё ${num(d.more)} — уточните поиск.</p>` : ''}`;
    }

    function renderList() {
      const d = st.data;
      const counts = d?.counts || {};
      const chips = FILTERS.map(([id, label]) => `<button type="button" class="chip" data-crm-filter="${id}" aria-pressed="${st.filter === id}">${esc(label)}${counts[id] !== undefined ? ` <span class="chip__n">${num(counts[id])}</span>` : ''}</button>`).join('');
      const s = d?.summary;
      const summary = s ? `
        <div class="stats crm-stats">
          <div class="stat"><div class="stat__label">Клиентов</div><div class="stat__value">${esc(num(s.total))}</div><div class="muted jr-small">с арендами: ${esc(num(s.withRentals))}</div></div>
          <div class="stat"><div class="stat__label">Постоянных</div><div class="stat__value">${esc(String(s.regularShare))}%</div><div class="muted jr-small">брали 2 раза и больше</div></div>
          <div class="stat"><div class="stat__label">Новых за 30 дней</div><div class="stat__value">${esc(num(s.newMonth))}</div></div>
          <div class="stat"><div class="stat__label">Давно не были</div><div class="stat__value">${esc(num(counts.lost))}</div><div class="muted jr-small">больше 90 дней без аренды</div></div>
        </div>
        <p class="muted jr-small">Страны клиентов с арендами: ${s.countries.map((c) => `${flag(c)} ${esc(c.name)} ${num(c.n)}`).join(' · ')}</p>` : '';
      const tools = canEdit() ? `
        <div class="crm-tools">
          <button type="button" class="btn btn--small" data-crm-new>＋ Клиент</button>
          <label class="btn btn--small"><span>📄 Загрузить список клиентов из WS (.xlsx)</span><input type="file" accept=".xlsx" data-crm-import hidden></label>
        </div>
        ${d?.imported ? `<p class="muted jr-small">Список WS загружен ${esc(when(d.imported.at))}: строк ${esc(num(d.imported.rows))}. Повторная загрузка добавляет новых и не задваивает.</p>` : ''}
        ${status(st.listMsg)}` : '';
      return `
        <div class="crm">
          ${summary}
          ${tools}
          <input type="search" class="search crm-search" data-crm-search placeholder="Имя, телефон, госномер или № брони WS" aria-label="Поиск: имя, телефон, @telegram, госномер или № брони WS" value="${esc(st.q)}" autocomplete="off">
          <div class="chips crm-filters">${chips}</div>
          <div id="crm-results">${results()}</div>
          <p class="muted jr-small">Клиенты — из списка WS, из строки «Contact» в отчётах группы и из заявок. История — по отчётам группы (по телефону или @telegram) и по кассе WS (по имени).</p>
        </div>`;
    }

    /* ------------------------------------------------------------ Карточка */

    function contactForm(c) {
      return `
        <form class="crm-form" data-crm-contact="${c?.id || ''}">
          <label class="field"><span>Имя</span><input name="name" class="search" required maxlength="120" value="${esc(c?.name || '')}"></label>
          <label class="field"><span>Телефоны (через запятую, с «+» и кодом страны)</span><input name="phones" class="search" inputmode="tel" value="${esc((c?.phones || []).map((p) => p.phone).join(', '))}" placeholder="+7 900 000-00-00"></label>
          <label class="field"><span>Telegram</span><input name="telegram" class="search" value="${esc(c?.telegram || '')}" placeholder="@username"></label>
          <div class="ac-form__buttons">
            <button type="submit" class="btn btn--primary btn--small">Сохранить</button>
            <button type="button" class="btn btn--small" data-crm-cancel>Отмена</button>
          </div>
        </form>`;
    }

    function contacts(c) {
      const phones = c.phones.map((p) => {
        const d = p.phone.replace(/\D/g, '');
        return `<li>${flag(p.country)} <b>${esc(p.phone)}</b> <span class="muted jr-small">${esc(p.country?.name || '')}</span>
          ${p.bad ? '<span class="crm-now">проверить номер</span>' : ''}
          <span class="crm-links"><a href="https://wa.me/${esc(d)}" target="_blank" rel="noopener">WhatsApp</a> · <a href="tel:${esc(p.phone)}">Позвонить</a></span></li>`;
      }).join('');
      const tg = c.telegram ? `<li>✈️ <b>${esc(c.telegram)}</b> <span class="crm-links"><a href="https://t.me/${esc(c.telegram.slice(1))}" target="_blank" rel="noopener">Telegram</a></span></li>` : '';
      return phones || tg ? `<ul class="crm-contacts">${phones}${tg}</ul>` : '<p class="muted">Контактов нет.</p>';
    }

    function tagsBlock(card) {
      const c = card.client;
      if (!canEdit()) {
        const shown = [...new Set([...c.tags, ...(card.flags.regular ? ['regular'] : [])])];
        return shown.length ? `<div>${tagBadges(shown)}</div>` : '';
      }
      return `<div class="chips crm-tagchips">${Object.entries(TAG_LABEL).map(([id, label]) => {
        const on = c.tags.includes(id);
        const auto = id === 'regular' && !on && c.autoRegular;
        return `<button type="button" class="chip crm-tagchip crm-tagchip--${id}" data-crm-tag="${id}" aria-pressed="${on}">${esc(label)}${auto ? ' <span class="chip__n">авто</span>' : ''}</button>`;
      }).join('')}</div>
      <p class="muted jr-small">«Постоянный» ставится сам, если клиент брал 2 раза и больше. «Чёрный список» — портал предупредит в журнале и на главной, если клиент снова появится в брони или выдаче.</p>`;
    }

    // Переход в карточку техники в «Парке»
    const fleetLink = (plate) => (plate && ctx.can('fleet.view') ? ` <button type="button" class="link jr-small" data-crm-vehicle="${esc(plate)}">🚗 открыть в «Парке»</button>` : '');

    function nowBlock(card) {
      const n = card.now;
      const parts = [];
      if (n.rent) parts.push(`<li><b>В аренде:</b> ${esc(n.rent.model || '')} ${plates(n.rent.plates)} · ${esc(short(n.rent.from))} — ${esc(short(n.rent.to))}${n.rent.deposit ? ` · залог ${esc(baht(n.rent.deposit))}` : ''}${fleetLink(n.rent.plates[0])}${journalLink(n.rent.plates[0])}</li>`);
      for (const b of n.bookings) parts.push(`<li><b>Бронь:</b> ${esc(b.model || '')} ${plates(b.plates)} · ${esc(short(b.from))} — ${esc(short(b.to))}${b.total ? ` · ${esc(baht(b.total))}` : ''}${b.prepaid ? `, предоплата ${esc(baht(b.prepaid))}` : ''}${fleetLink(b.plates[0])}${journalLink(b.plates[0])}</li>`);
      for (const x of n.debts) parts.push(`<li class="crm-debt"><b>${x.overdue ? `Просрочен долг (${x.late} дн.)` : 'Долг'}:</b> ${esc(baht(x.amount))} · ${plates(x.plates)} · срок ${esc(short(x.due))}${x.note ? ` · «${esc(x.note)}»` : ''}${journalLink(x.plates[0])}</li>`);
      return parts.length ? `<ul class="crm-nowlist">${parts.join('')}</ul>` : '<p class="muted">Сейчас ни аренды, ни брони, ни долгов.</p>';
    }

    /** Выдать или забронировать технику клиенту, новый договор */
    function actionsBlock(card) {
      const btns = [];
      if (ctx.canSetStatus()) btns.push('<button type="button" class="btn btn--small btn--primary" data-crm-issue>＋ Выдать или забронировать технику</button>');
      if (ctx.canDocsEdit()) btns.push('<button type="button" class="btn btn--small" data-crm-newdoc>📄 Новый договор</button>');
      if (!btns.length) return '';
      return `<div class="crm-actions">${btns.join('')}</div>${st.issue ? issueForm(card) : ''}`;
    }

    function issueForm() {
      const f = st.issue;
      const list = f.from && f.to ? ctx.freeVehicles(f.from, f.to, f.type) : null;
      const opts = (list || []).map((v) => `<li><span><b>${esc(v.model)}</b> <span class="plate">#${esc(v.plate)}</span>${v.price ? ` <span class="muted jr-small">· ${esc(baht(v.price))}/сутки</span>` : ''}</span>
        <button type="button" class="btn btn--small" data-crm-pick="${v.vehicleId}">Выбрать</button></li>`).join('');
      return `<form class="crm-issue" data-crm-issueform>
        <div class="chips">${[['rent', 'Выдача сейчас'], ['reserve', 'Бронь']].map(([k, l]) => `<button type="button" class="chip" data-crm-issuekind="${k}" aria-pressed="${f.kind === k}">${l}</button>`).join('')}</div>
        <div class="crm-issue__row">
          ${f.kind === 'reserve' ? `<label class="field"><span>С</span><input class="search" type="date" name="from" value="${esc(f.from)}" min="${ctx.today()}"></label>` : ''}
          <label class="field"><span>${f.kind === 'reserve' ? 'По' : 'До'}</span><input class="search" type="date" name="to" value="${esc(f.to || '')}" min="${ctx.today()}"></label>
          <label class="field"><span>Тип</span><select class="search" name="type">${[['all', 'Все'], ['scooter', 'Скутеры'], ['motorcycle', 'Мотоциклы'], ['car', 'Автомобили']].map(([k, l]) => `<option value="${k}"${f.type === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <button type="button" class="btn btn--small" data-crm-issueclose>Отмена</button>
        </div>
        ${list === null ? '<p class="muted jr-small">Выберите даты — покажу свободную на них технику.</p>' : list.length ? `<ul class="crm-free">${opts}</ul>` : '<p class="muted">На эти даты ничего свободного.</p>'}
      </form>`;
    }

    function contractsBlock(card) {
      if (!card.contracts?.length) return '';
      return `<section class="card fin-sec"><h3>Договоры</h3><ul class="crm-rentals">${card.contracts.map((d) => `
        <li><button type="button" class="link" data-crm-doc="${d.id}">📄 ${esc(d.number)}</button> · ${esc(d.model || '')} ${d.plate ? `<span class="plate">#${esc(d.plate)}</span>` : ''}
          ${d.from ? `<span class="muted jr-small">${esc(short(d.from.slice(0, 10)))} — ${esc(d.to ? short(d.to.slice(0, 10)) : '…')}</span>` : ''}</li>`).join('')}</ul></section>`;
    }

    function rentalsBlock(card) {
      if (!card.rentals.length) return '<p class="muted">Аренд пока нет.</p>';
      const source = (r) => {
        if (r.source === 'both') return `группа + касса WS${r.ws?.booking ? ` (бронь № ${esc(r.ws.booking)})` : ''}`;
        if (r.source === 'ws') return `касса WS${r.ws?.booking ? ` (бронь № ${esc(r.ws.booking)})` : ''}`;
        return 'отчёты группы';
      };
      return `<ul class="crm-rentals">${card.rentals.map((r) => {
        const sum = r.ws ? r.ws.sum : r.revenue;
        const money = [];
        if (sum) money.push(`<b>${esc(baht(sum))}</b>`);
        const deposit = r.deposit || r.ws?.deposit;
        if (deposit) money.push(`залог ${esc(num(deposit))}`);
        const back = r.returned || r.ws?.depositBack;
        if (back) money.push(`вернули ${esc(num(back))}`);
        if (r.withheld) money.push(`удержали ${esc(num(r.withheld))}`);
        return `<li${r.active ? ' class="crm-rental--active"' : ''}>
          <div><b>${esc(short(r.from || r.startTs))} — ${esc(r.to ? short(r.to) : '…')}</b> · ${esc(r.model || '')} ${plates(r.plates)}${r.active ? ' <span class="crm-now crm-now--rent">сейчас</span>' : ''}</div>
          <div class="jr-small">${money.join(' · ')}${money.length ? ' · ' : ''}<span class="muted">${source(r)}${r.issuedBy ? ` · выдал(а) ${esc(r.issuedBy)}` : ''}</span>${journalLink(r.plates[0])}</div>
        </li>`;
      }).join('')}</ul>`;
    }

    function notesBlock(card) {
      const form = canEdit() ? `
        <form class="crm-note-form" data-crm-note>
          <textarea name="text" class="search" rows="2" maxlength="2000" placeholder="Заметка: договорённости, особенности клиента…"></textarea>
          <button type="submit" class="btn btn--primary btn--small">Добавить</button>
        </form>` : '';
      const list = card.notes.map((n) => `<li class="crm-note${n.kind === 'system' ? ' crm-note--system' : ''}">
        <div class="muted jr-small">${esc(when(n.at))} · ${esc(n.by)}</div><div>${esc(n.text)}</div></li>`).join('');
      return `${form}${list ? `<ul class="crm-notes">${list}</ul>` : '<p class="muted">Заметок пока нет.</p>'}`;
    }

    function dupesBlock(card) {
      if (!card.dupes.length) return '';
      const items = card.dupes.map((d) => `<li><button type="button" class="link" data-crm-open="${d.id}">${esc(d.name)}</button>
        <span class="muted jr-small">${esc(d.phone || '')} · аренд: ${d.rentals} · ${d.reason === 'phone' ? 'тот же телефон' : 'то же имя'}</span>
        ${canEdit() ? `<button type="button" class="btn btn--small" data-crm-merge="${d.id}">Объединить сюда</button>` : ''}</li>`).join('');
      return `<section class="card fin-sec"><h3>Возможные дубли</h3>
        <p class="muted jr-small">«Объединить сюда» — телефоны, метки и заметки дубля перейдут в эту карточку, дубль исчезнет из списка. История аренд соберётся по всем номерам.</p>
        <ul class="crm-dupes">${items}</ul></section>`;
    }

    function renderCard() {
      const back = '<button type="button" class="link crm-back" data-crm-back>← Все клиенты</button>';
      if (st.cardFailed) return `<div class="crm">${back}<div class="empty">${esc(st.cardFailed)}</div></div>`;
      if (st.openId === 'new') {
        return `<div class="crm">${back}<section class="card fin-sec"><h3>Новый клиент</h3>${contactForm(null)}${status(st.msg)}</section></div>`;
      }
      const card = st.card;
      if (!card) return `<div class="crm">${back}<div class="empty">Загружаем…</div></div>`;
      const c = card.client;
      const s = card.stats;
      const black = c.tags.includes('blacklist');
      return `
        <div class="crm">
          ${back}
          <section class="card fin-sec crm-head${black ? ' crm-head--black' : ''}">
            <h2 class="crm-name">${esc(c.name)}</h2>
            ${black ? '<p class="crm-blacknote">⛔ Клиент в чёрном списке</p>' : ''}
            <p class="muted jr-small">${esc(SOURCE[c.source] || '')}${c.wsName && c.wsName !== c.name ? ` · в WS: ${esc(c.wsName)}` : ''} · в CRM с ${esc(date(c.createdAt))}</p>
            ${st.editing ? contactForm(c) : `${contacts(c)}${canEdit() ? '<button type="button" class="link jr-small" data-crm-edit>Изменить контакт</button>' : ''}`}
            ${tagsBlock(card)}
            ${status(st.msg)}
          </section>
          <section class="card fin-sec"><h3>Сейчас</h3>${nowBlock(card)}${actionsBlock(card)}</section>
          ${contractsBlock(card)}
          <section class="card fin-sec"><h3>Итоги</h3>
            <div class="stats crm-stats">
              <div class="stat"><div class="stat__label">Аренд</div><div class="stat__value">${esc(num(s.rentals))}</div></div>
              <div class="stat"><div class="stat__label">Заплатил</div><div class="stat__value">${esc(baht(s.paid))}</div><div class="muted jr-small">без залогов</div></div>
              <div class="stat"><div class="stat__label">Средний чек</div><div class="stat__value">${esc(baht(s.avg))}</div></div>
              <div class="stat"><div class="stat__label">Дней в аренде</div><div class="stat__value">${esc(num(s.days))}</div></div>
            </div>
            <p class="muted jr-small">${s.firstAt ? `Первая аренда ${esc(date(s.firstAt))}, последняя ${esc(date(s.lastAt))}.` : ''}${s.models.length ? ` Чаще берёт: ${s.models.map((m) => `${esc(m.model)} (${m.n})`).join(', ')}.` : ''}</p>
          </section>
          <section class="card fin-sec"><h3>История аренд</h3>${rentalsBlock(card)}</section>
          ${card.requests.length ? `<section class="card fin-sec"><h3>Заявки</h3><ul class="crm-rentals">${card.requests.map((r) => `
            <li><b>${esc(when(r.at))}</b> · ${esc(CHANNEL[r.channel] || r.channel)}${r.model ? ` · ${esc(r.model)}` : ''}${r.from ? ` · ${esc(short(r.from))} — ${esc(short(r.to))}` : ''} <span class="muted jr-small">${r.status === 'new' ? 'не взята' : 'взята в работу'}${r.source ? ` · откуда: ${esc(r.source)}` : ''}</span></li>`).join('')}</ul></section>` : ''}
          <section class="card fin-sec"><h3>Заметки</h3>${notesBlock(card)}</section>
          ${dupesBlock(card)}
        </div>`;
    }

    function render() {
      return st.openId ? renderCard() : renderList();
    }

    /* ------------------------------------------------------------- События */

    function refreshResults() {
      const box = document.getElementById('crm-results');
      if (box) box.innerHTML = results();
      document.querySelectorAll('[data-crm-filter]').forEach((el) => {
        const n = st.data?.counts?.[el.dataset.crmFilter];
        const badge = el.querySelector('.chip__n');
        if (badge && n !== undefined) badge.textContent = num(n);
      });
    }

    function onInput(event) {
      const input = event.target.closest?.('[data-crm-search]');
      if (!input) return false;
      st.q = input.value;
      clearTimeout(st.timer);
      st.timer = setTimeout(async () => {
        await loadList();
        refreshResults();
      }, 300);
      return true;
    }

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.crm')) return false;
      const filter = el.closest('[data-crm-filter]');
      if (filter) {
        st.filter = filter.dataset.crmFilter;
        document.querySelectorAll('[data-crm-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === filter)));
        loadList().then(refreshResults);
        return true;
      }
      const open = el.closest('[data-crm-open]');
      if (open) { st.msg = null; st.issue = null; openCard(open.dataset.crmOpen); return true; }
      const veh = el.closest('[data-crm-vehicle]');
      if (veh) { ctx.openVehicle(veh.dataset.crmVehicle); return true; }
      const doc = el.closest('[data-crm-doc]');
      if (doc) { ctx.openContract(Number(doc.dataset.crmDoc)); return true; }
      if (el.closest('[data-crm-newdoc]')) {
        const c = st.card?.client;
        ctx.newContract({ renter: { name: c?.name || '', phone: c?.phones?.[0] ? `+${String(c.phones[0]).replace(/^\+/, '')}` : '' } });
        return true;
      }
      if (el.closest('[data-crm-issue]')) { st.issue = st.issue ? null : { kind: 'rent', from: ctx.today(), to: '', type: 'all' }; ctx.rerender(); return true; }
      if (el.closest('[data-crm-issueclose]')) { st.issue = null; ctx.rerender(); return true; }
      const ik = el.closest('[data-crm-issuekind]');
      if (ik && st.issue) { st.issue.kind = ik.dataset.crmIssuekind; if (st.issue.kind === 'rent') st.issue.from = ctx.today(); ctx.rerender(); return true; }
      const pick = el.closest('[data-crm-pick]');
      if (pick && st.issue) {
        const c = st.card?.client;
        const f = st.issue;
        const id = st.openId;
        ctx.openStatus(Number(pick.dataset.crmPick), f.kind, {
          from: f.kind === 'reserve' ? f.from : '', to: f.to, clientName: c?.name || '',
          clientPhone: c?.phones?.[0] ? `+${String(c.phones[0]).replace(/^\+/, '')}` : ''
        }, () => { st.issue = null; st.msg = { kind: 'ok', text: 'Статус техники сохранён — он появится в «Парке» и в группе.' }; openCard(id); });
        return true;
      }
      if (el.closest('[data-crm-back]')) {
        st.openId = null;
        st.card = null;
        st.msg = null;
        ctx.rerender();
        if (!st.data) load();
        return true;
      }
      if (el.closest('[data-crm-new]')) { st.openId = 'new'; st.msg = null; st.cardFailed = null; ctx.rerender(); return true; }
      if (el.closest('[data-crm-edit]')) { st.editing = true; st.msg = null; ctx.rerender(); return true; }
      if (el.closest('[data-crm-cancel]')) {
        if (st.openId === 'new') st.openId = null;
        st.editing = false;
        ctx.rerender();
        return true;
      }
      const tag = el.closest('[data-crm-tag]');
      if (tag && st.card) {
        const id = tag.dataset.crmTag;
        const tags = st.card.client.tags.includes(id) ? st.card.client.tags.filter((x) => x !== id) : [...st.card.client.tags, id];
        if (id === 'blacklist' && tags.includes('blacklist') && !window.confirm('Внести клиента в чёрный список? Портал будет предупреждать, если он снова появится в брони или выдаче.')) return true;
        change('/crm/tags', { id: st.card.client.id, tags }, 'Метки сохранены.');
        return true;
      }
      const merge = el.closest('[data-crm-merge]');
      if (merge && st.card) {
        const other = st.card.dupes.find((d) => String(d.id) === merge.dataset.crmMerge);
        if (window.confirm(`Объединить «${other?.name || ''}» с этой карточкой? Отменить нельзя.`)) {
          change('/crm/merge', { into: st.card.client.id, from: Number(merge.dataset.crmMerge) }, 'Дубль объединён.');
        }
        return true;
      }
      return false;
    }

    function onChange(event) {
      // Выдача / бронь: даты и тип — список свободной техники обновляется
      const issue = event.target.closest?.('[data-crm-issueform]');
      if (issue && st.issue) {
        const f = new FormData(issue);
        Object.assign(st.issue, { from: f.get('from') || st.issue.from, to: f.get('to') || '', type: f.get('type') || 'all' });
        ctx.rerender();
        return true;
      }
      const input = event.target.closest?.('[data-crm-import]');
      if (!input) return false;
      importFile(input.files?.[0]);
      input.value = '';
      return true;
    }

    function onSubmit(event) {
      const contact = event.target.closest?.('[data-crm-contact]');
      if (contact) {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(contact));
        const id = contact.dataset.crmContact;
        st.editing = false;
        change('/crm/client', { ...data, id: id ? Number(id) : undefined }, id ? 'Контакт сохранён.' : 'Клиент добавлен.');
        return true;
      }
      const note = event.target.closest?.('[data-crm-note]');
      if (note && st.card) {
        event.preventDefault();
        change('/crm/note', { id: st.card.client.id, text: note.elements.text.value }, 'Заметка добавлена.');
        return true;
      }
      return false;
    }

    return { load, render, onClick, onInput, onChange, onSubmit, open: (id) => { st.issue = null; st.msg = null; openCard(id); } };
  }

  window.STAFF_CRM = { create };
})();
