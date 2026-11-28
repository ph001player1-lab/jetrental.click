/*
 * Вкладка «Настройки» (только админ): связь (Telegram, WhatsApp-бот для
 * клиентов, наблюдатель рабочей группы), домены и сертификаты, ключи
 * («задан / не задан» — сами ключи только на сервере), сервисы и оплаты
 * с напоминаниями в Telegram, модель ИИ для «＋ Операция» и лимит расходов,
 * скидки (порог одобрения, куда слать запросы, список причин).
 * Сервер — itSettings.js; WhatsApp — те же адреса /wabot и /wa, что раньше
 * были в «Маркетинге» и «Журнале» (там теперь ссылка сюда).
 */
(function () {
  'use strict';

  const VIEWS = [['links', '🔌 Связь'], ['pay', '💳 Сервисы и оплаты'], ['domains', '🌐 Домены и сайты'], ['site', '📞 Сайт: контакты'], ['keys', '🔑 Ключи'], ['ai', '🤖 Модель ИИ'], ['disc', '💸 Скидки']];
  const KIND = { server: '🖥 Сервер', domain: '🌐 Домен', subscription: '🔁 Подписка', service: '🧩 Сервис', other: '📦 Другое' };
  const PERIOD = { month: 'в месяц', quarter: 'в квартал', half: 'раз в полгода', year: 'в год', once: 'разово' };
  const AHEAD = { month: 'месяц', quarter: 'квартал', half: 'полгода', year: 'год' };
  const STATE = { overdue: 'просрочено', today: 'сегодня', soon: 'скоро', ok: '', nodate: 'нет даты', off: 'выключен' };
  // Типовые сервисы — добавить разом и заполнить суммы и даты
  const TEMPLATES = [
    { name: 'Сервер (VPS)', kind: 'server', period: 'month', currency: 'USD' },
    { name: 'Домен jetmobility.org', kind: 'domain', period: 'year', currency: 'USD', domain: 'jetmobility.org' },
    { name: 'Домен kokoncar.com', kind: 'domain', period: 'year', currency: 'USD', domain: 'kokoncar.com' },
    { name: 'ИИ — Anthropic API (Claude)', kind: 'subscription', period: 'month', currency: 'USD', url: 'https://console.anthropic.com' },
    { name: 'Почта — Resend', kind: 'subscription', period: 'month', currency: 'USD', url: 'https://resend.com' },
    { name: 'WS.Автопрокат', kind: 'subscription', period: 'month', currency: 'RUB' }
  ];
  const ERR = {
    name_required: 'Укажите название.', bad_cost: 'Сумма — числом.', bad_amount: 'Сумма оплаты — числом больше нуля.', bad_date: 'Дата — в формате ДД.ММ.ГГГГ.',
    bad_url: 'Ссылка должна начинаться с https://', unknown_service: 'Сервис не найден — обновите страницу.', unknown_payment: 'Оплата не найдена — обновите страницу.',
    phone_required: 'Нужен хотя бы один телефон.', bad_phone: 'Телефон — от 8 до 15 цифр, с кодом страны.', bad_whatsapp: 'WhatsApp — номер с кодом страны (8–15 цифр).',
    bad_telegram: 'Telegram — имя без @ (латиница, цифры, _; от 5 символов).', bad_map: 'Точка на карте: широта и долгота числами.',
    map_not_found: 'Не нашёл точку в ссылке. Откройте место в Google Maps, нажмите «Поделиться» и вставьте ссылку — или впишите широту и долготу.',
    owner_or_admin_only: 'Только владелец и админ.',
    bad_model: 'Выберите модель из списка.', bad_limit: 'Лимит — числом (0 — без лимита).', admin_only: 'Только для админа.',
    bad_invite: 'Это не ссылка-приглашение WhatsApp (нужна https://chat.whatsapp.com/…) или она уже не действует.',
    join_failed: 'Бот не смог вступить в группу: ссылку сбросили или в группу пускают только по одобрению админа.',
    telegram_off: 'Telegram-бот не подключён.', not_connected: 'WhatsApp-бот не подключён.',
    bad_percent: 'Процент — числом от 0 до 100.', bad_channels: 'Выберите, куда слать запросы.', no_reasons: 'Нужна хотя бы одна причина.',
    no_tg_group: 'Рабочая группа Telegram не привязана (/bind в группе).',
    not_waiting_for_link: 'Код можно получить, только пока показывается QR-код.', unknown_group: 'Группа не найдена — обновите страницу.', wabot_unreachable: 'Бот не отвечает на сервере.'
  };

  function create(ctx) {
    const { api, esc } = ctx;
    const st = { view: 'links', data: null, wabot: null, wa: null, failed: false, editing: null, paying: null, msg: null, linkMsg: null, checking: false, busy: false };
    const num = (n, digits = 0) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(n || 0);
    const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '—');
    const phoneText = (id) => (id ? `+${String(id).split(/[:@]/)[0]}` : '—');
    const errText = (err) => ERR[err?.code] || 'Не получилось. Попробуйте ещё раз.';
    /** Пункты выбора группы; выбранная видна всегда — даже если WhatsApp пока не отдал список групп */
    const groupOptions = (list, selected, selectedName, mark = () => '') => {
      const items = (list || []).map((g) => `<option value="${esc(g.id)}"${g.id === selected ? ' selected' : ''}>${esc(`${g.subject} (${g.size})`)}${mark(g)}</option>`);
      if (selected && !(list || []).some((g) => g.id === selected)) items.unshift(`<option value="${esc(selected)}" selected>${esc(selectedName || 'текущая группа')}</option>`);
      return items.join('');
    };
    const groupName = (list, id) => (list || []).find((g) => g.id === id)?.subject || null;
    const staleNote = (w) => (w?.groupsStale ? '<p class="note">⏳ WhatsApp временно не отдаёт список групп (так бывает после перезапуска). Показан последний известный список — настройки на месте, список обновится сам.</p>' : '');

    // Владелец видит в «Настройках» только контакты сайта; админ — всё
    const onlySite = () => !ctx.isAdmin();

    async function load() {
      try {
        if (onlySite()) {
          st.view = 'site';
          st.site = await api('/site-contacts');
        } else {
          const [data, wabot, wa, site] = await Promise.all([api('/settings'), api('/wabot').catch(() => null), api('/wa').catch(() => null), api('/site-contacts').catch(() => null)]);
          Object.assign(st, { data, wabot, wa, site });
        }
        st.failed = false;
      } catch {
        st.failed = true;
      }
      ctx.rerender();
    }

    /** Пока идёт привязка по QR — обновляем каждые 5 секунд (код меняется) */
    let ticks = 0;
    async function tick() {
      ticks++;
      const d = st.data?.discounts;
      if (st.view === 'disc' && d?.tgLink) {
        const fresh = await api('/settings').then((r) => r.discounts).catch(() => null);
        // Код ссылки израсходован — группу привязали; истёк — просто убираем ссылку
        if (fresh && !fresh.tgLink) {
          const bound = Date.now() < Date.parse(d.tgLink.until);
          st.data.discounts = fresh;
          st.msg = bound ? { kind: 'ok', text: `Группа Telegram привязана: «${fresh.tgTitle || 'без названия'}».` } : { kind: 'error', text: 'Ссылка устарела — нажмите «Привязать группу» ещё раз.' };
          ctx.rerender();
        }
        return;
      }
      const linking = [st.wabot, st.wa].some((w) => w && ['qr', 'connecting', 'starting'].includes(w.status));
      if (st.view !== 'links' || (!linking && ticks % 12)) return;
      const [wabot, wa] = await Promise.all([api('/wabot').catch(() => st.wabot), api('/wa').catch(() => st.wa)]);
      st.wabot = wabot;
      st.wa = wa;
      if (canRefresh()) ctx.rerender();
    }

    /** Пока что-то вводят — фоновое обновление не трогает вкладку */
    function canRefresh() {
      const view = document.querySelector('.set');
      return !st.editing && !st.paying && !view?.querySelector('form[data-dirty]')
        && !(view && view.contains(document.activeElement) && document.activeElement.matches('input, select, textarea'));
    }

    function status(msg) {
      return msg ? `<p class="md-status is-${msg.kind}" role="status">${esc(msg.text)}</p>` : '';
    }

    function render() {
      if (st.failed) return '<div class="set"><div class="card empty">Не удалось загрузить настройки. Обновите страницу.</div></div>';
      if (onlySite()) return st.site ? `<div class="set">${renderSite()}</div>` : '<div class="set"><div class="card empty">Загрузка…</div></div>';
      if (!st.data) return '<div class="set"><div class="card empty">Загрузка…</div></div>';
      const d = st.data;
      const overdue = d.services.filter((s) => s.state === 'overdue').length;
      const soon = d.services.filter((s) => s.state === 'today' || s.state === 'soon').length;
      const badge = (id) => {
        if (id === 'pay' && (overdue || soon)) return ` <span class="set-dot set-dot--${overdue ? 'bad' : 'warn'}">${overdue || soon}</span>`;
        if (id === 'domains' && [...d.domains.domains, ...d.domains.hosts].some((x) => x.days !== null && x.days <= 30)) return ' <span class="set-dot set-dot--warn">!</span>';
        if (id === 'keys' && d.keys.some((k) => k.required && !k.set)) return ' <span class="set-dot set-dot--bad">!</span>';
        return '';
      };
      const chips = VIEWS.map(([id, title]) => `<button type="button" class="chip" data-set-view="${id}" aria-pressed="${st.view === id}">${esc(title)}${badge(id)}</button>`).join('');
      let body = '';
      if (st.view === 'links') body = renderLinks();
      if (st.view === 'pay') body = renderPay();
      if (st.view === 'domains') body = renderDomains();
      if (st.view === 'site') body = renderSite();
      if (st.view === 'keys') body = renderKeys();
      if (st.view === 'ai') body = renderAi();
      if (st.view === 'disc') body = renderDiscounts();
      return `<div class="set"><div class="chips set-views">${chips}</div>${body}</div>`;
    }

    /* ------------------------------------------------------------ Связь */

    function renderLinks() {
      return `${renderMap()}${renderTelegram()}${renderWabot()}${renderObserver()}${status(st.linkMsg)}`;
    }

    /** Все связи на одном экране: что и куда пишется, где это настроить */
    function renderMap() {
      const tg = st.data.telegram;
      const d = st.data.discounts || {};
      const w = st.wabot && st.wabot.reachable !== false && st.wabot.status === 'connected' ? st.wabot : null;
      const set = w?.settings || {};
      const o = st.wa && st.wa.reachable && st.wa.status === 'connected' ? st.wa : null;
      const q = (name) => `«${esc(name)}»`;
      const off = '<span class="muted">никуда</span>';
      const list = (parts) => { const p = parts.filter(Boolean); return p.length ? p.join(' + ') : off; };
      const tgGroup = tg.groupBound ? `Telegram ${q(tg.groupTitle || 'рабочая группа')}` : null;
      const waName = (id, name) => (id ? `WhatsApp ${q(name || groupName(w?.groups, id) || 'группа')}` : null);
      // Заявки: в группу WhatsApp (если выбрана) и/или в Telegram (без группы WhatsApp — всегда)
      const reqWa = w ? waName(w.groupId, w.groupSubject) : null;
      const reqTg = tgGroup && (!reqWa || set.telegramCopy) ? tgGroup : null;
      const discTg = (d.channels === 'tg' || d.channels === 'both') && d.tgChat ? `Telegram ${q(d.tgTitle || 'группа')}` : null;
      const discWa = (d.channels === 'wa' || d.channels === 'both') && d.waGroup ? waName(d.waGroup) : null;
      const rows = [
        ['📨 Заявки клиентов (сайт, боты)', list([reqWa, reqTg]), 'set-wabot'],
        ['🚗 События парка (выдача, возврат, бронь, ремонт)', list([w ? waName(set.eventsGroup) : null]), 'set-wabot'],
        ['💸 Скидки: запросы на одобрение и большие скидки', list([discTg, discWa]), 'disc'],
        ['☀️ Утренняя сводка', list([tgGroup]), 'set-tg'],
        ['🔔 Оповещения админам (сервер, оплаты, сроки)', tg.alertsTo.length ? `Telegram, лично: ${tg.alertsTo.map(esc).join(', ')}` : off, 'set-tg'],
        ['👀 Журнал: наблюдатель читает', list([o?.groupId ? `WhatsApp ${q(o.groupSubject || 'группа')}` : null]), 'set-observer']
      ];
      return `<section class="card set-sec"><h3>🗺 Куда что пишется</h3>
        <div class="table-wrap"><table class="set-map"><tbody>${rows.map(([what, where, go]) => `<tr><td>${esc(what)}</td><td>${where}</td>
          <td><button type="button" class="link jr-small" ${go === 'disc' ? 'data-set-view="disc"' : `data-set-go="${go}"`}>настроить ${go === 'disc' ? '→' : '↓'}</button></td></tr>`).join('')}</tbody></table></div></section>`;
    }

    function renderTelegram() {
      const tg = st.data.telegram;
      const rows = [];
      rows.push(tg.tokenSet
        ? `<li>✅ Бот ${tg.bot ? `<a href="https://t.me/${esc(tg.bot)}" target="_blank" rel="noopener">@${esc(tg.bot)}</a>` : 'подключён'}</li>`
        : '<li>⚪ Бот не подключён: нет ключа TELEGRAM_BOT_TOKEN (вкладка «Ключи»).</li>');
      rows.push(tg.groupBound
        ? `<li>✅ Рабочая группа: <b>${esc(tg.groupTitle || 'привязана')}</b>${tg.groupFixed ? ' (задана на сервере)' : ''} · язык ${esc(tg.groupLang.toUpperCase())}</li>`
        : '<li>⚠️ Рабочая группа не привязана. Добавьте бота в группу Telegram и напишите там <code>/bind</code>.</li>');
      rows.push(tg.alertsTo.length
        ? `<li>🔔 Оповещения админам (сервер, оплаты, сроки): ${tg.alertsTo.map((n) => `<b>${esc(n)}</b>`).join(', ')}</li>`
        : '<li>⚠️ Оповещения админам получать некому: ни у одного админа нет Telegram ID.</li>');
      if (tg.adminsWithoutTelegram.length) rows.push(`<li class="muted">Без Telegram ID (оповещения не придут): ${tg.adminsWithoutTelegram.map(esc).join(', ')} — укажите ID во вкладке «Доступы» и нажмите «Старт» у бота.</li>`);
      return `<section class="card set-sec" id="set-tg"><h3>✈️ Telegram</h3><ul class="set-list">${rows.join('')}</ul>
        <p class="mk-tip">Перепривязать группу — написать <code>/bind</code> в новой группе. Утренняя сводка и заявки (если включено) — в эту группу.</p></section>`;
    }

    function renderWabot() {
      const w = st.wabot;
      let body;
      if (!w || w.reachable === false) body = '<p class="warn">Бот не отвечает на сервере. Если сервер только что обновили — подождите минуту и обновите страницу.</p>';
      else if (w.status === 'connected') {
        const set = w.settings || { mode: 'off', testNumbers: [] };
        const groups = groupOptions(w.groups, w.groupId, w.groupSubject);
        const obs = w.observerGroup || {};
        const events = groupOptions(w.groups, set.eventsGroup, null, (g) => (g.id === obs.id ? ' — читает наблюдатель' : ''));
        const botInObserver = obs.id && (w.groups || []).some((g) => g.id === obs.id);
        body = `
          <p>✅ Подключён номер <b>${esc(phoneText(w.me?.id))}</b>${w.me?.name ? ` (${esc(w.me.name)})` : ''}${w.today?.date ? ` · сегодня написали ${num(w.today.received)}, бот ответил ${num(w.today.sent)}` : ''}</p>
          ${staleNote(w)}
          <form class="mk-form" data-set-wabot-mode>
            <div class="mk-label">Кому отвечает бот</div>
            <label class="mk-radio"><input type="radio" name="mode" value="off"${set.mode === 'off' ? ' checked' : ''}> Никому — клиентам отвечают люди с телефона</label>
            <label class="mk-radio"><input type="radio" name="mode" value="test"${set.mode === 'test' ? ' checked' : ''}> Только тестовым номерам</label>
            <label class="field"><span>Тестовые номера (через запятую)</span><input class="search" name="testNumbers" inputmode="tel" value="${esc((set.testNumbers || []).map((n) => `+${n}`).join(', '))}" placeholder="+66 81 234 5678"></label>
            <label class="mk-radio"><input type="radio" name="mode" value="on"${set.mode === 'on' ? ' checked' : ''}> Всем, кто пишет</label>
            <button type="submit" class="btn btn--primary btn--small">Сохранить</button>
          </form>
          <form class="mk-form" data-set-wabot-group>
            <label class="field"><span>Группа WhatsApp для заявок</span><select class="search" name="groupId"><option value="">— не присылать —</option>${groups}</select></label>
            <label class="mk-check"><input type="checkbox" name="telegramCopy"${set.telegramCopy ? ' checked' : ''}> Дублировать заявки в Telegram-группу</label>
            <p class="mk-tip">Нет нужной группы — добавьте номер бота ${esc(phoneText(w.me?.id))} в группу на телефоне, через минуту она появится здесь.</p>
            <button type="submit" class="btn btn--small">Сохранить</button>
          </form>
          <form class="mk-form" data-set-wabot-events>
            <label class="field"><span>Группа для событий парка (выдача, возврат, бронь, ремонт)</span><select class="search" name="eventsGroup"><option value="">— не писать —</option>${events}</select></label>
            <p class="mk-tip">Пишет этот же номер, тем же текстом, что отчёт.${obs.id && !botInObserver ? ` Наблюдатель читает «${esc(obs.subject || '')}» — добавьте туда номер бота, и группа появится в списке.` : ''} Отдельный номер для событий — позже (в планах).</p>
            <button type="submit" class="btn btn--small">Сохранить</button>
          </form>
          <button type="button" class="btn btn--small mk-danger" data-set-wabot-logout>Отвязать номер</button>`;
      } else if (w.status === 'qr' || w.status === 'logged_out') {
        body = `
          <ol class="jr-steps"><li>Телефон с номером компании → WhatsApp.</li><li>Настройки (или ⋮) → «Связанные устройства» → «Привязать устройство».</li><li>Наведите камеру на QR-код. Код обновляется сам.</li></ol>
          ${w.qr ? `<img class="jr-qr" src="${esc(w.qr)}" alt="QR-код для привязки WhatsApp">` : '<p class="mk-tip">QR-код готовится…</p>'}
          <form class="mk-form" data-set-wabot-pair>
            <label class="field"><span>Или вход по коду: номер компании</span><input class="search" name="phone" inputmode="tel" placeholder="+66 98 227 6467"></label>
            <button type="submit" class="btn btn--small">Получить код</button>
          </form>
          ${w.pairingCode ? `<p class="jr-code">${esc(w.pairingCode)}</p><p class="mk-tip">На телефоне: «Связанные устройства» → «Привязать устройство» → «Связать по номеру телефона».</p>` : ''}`;
      } else body = `<p class="mk-text">Состояние: ${esc(w.status || '—')}</p>`;
      return `<section class="card set-sec" id="set-wabot"><h3>💬 WhatsApp-бот для клиентов</h3>${body}</section>`;
    }

    function renderObserver() {
      const w = st.wa;
      let body;
      if (!w || !w.reachable) body = `<p class="warn">${w?.error === 'observer_not_configured' ? 'Наблюдатель не настроен на сервере (нет общего секрета).' : 'Наблюдатель не отвечает на сервере.'}</p>`;
      else if (w.status === 'connected') {
        const groups = (w.groups || []).map((g) => `<option value="${esc(g.id)}"${g.id === w.groupId ? ' selected' : ''}>${esc(`${g.subject} (${g.size})`)}</option>`).join('');
        body = `
          <p>✅ Подключён номер <b>${esc(phoneText(w.me?.id))}</b></p>
          ${w.groupId ? `<p class="note">👀 Читает группу «${esc(w.groupSubject || '—')}»${w.lastMessageAt ? ` · последнее сообщение ${esc(ctx.dateTime(w.lastMessageAt))}` : ''}</p>` : '<p class="warn">Выберите рабочую группу — наблюдатель пока ничего не читает.</p>'}
          <form class="mk-form" data-set-wa-group>
            <label class="field"><span>Какую группу читать</span><select class="search" name="groupId"><option value="">— выберите группу —</option>${groups}</select></label>
            <button type="submit" class="btn btn--small">Читать эту группу</button>
          </form>
          <p class="mk-tip">Наблюдатель только читает выбранную группу и ничего не отправляет.</p>
          <button type="button" class="btn btn--small mk-danger" data-set-wa-logout>Отвязать номер</button>`;
      } else if (w.status === 'qr') {
        body = `
          <ol class="jr-steps"><li>Телефон с номером наблюдателя → WhatsApp.</li><li>«Связанные устройства» → «Привязать устройство».</li><li>Наведите камеру на QR-код.</li></ol>
          ${w.qr ? `<img class="jr-qr" src="${esc(w.qr)}" alt="QR">` : '<p class="mk-tip">QR-код готовится…</p>'}
          <form class="mk-form" data-set-wa-pair>
            <label class="field"><span>Или вход по коду: номер наблюдателя</span><input class="search" name="phone" inputmode="tel" placeholder="+66 6x xxx xxxx"></label>
            <button type="submit" class="btn btn--small">Получить код</button>
          </form>
          ${w.pairingCode ? `<p class="jr-code">${esc(w.pairingCode)}</p>` : ''}`;
      } else body = `<p class="mk-text">Состояние: ${esc(w.status || '—')}</p>`;
      return `<section class="card set-sec" id="set-observer"><h3>👀 Наблюдатель рабочей группы WhatsApp</h3>${body}
        <p class="mk-tip">Загрузка истории группы из файла — во вкладке «Журнал» → WhatsApp.</p></section>`;
    }

    /* ---------------------------------------------------- Сервисы и оплаты */

    function stateBadge(s) {
      if (s.state === 'ok' || !STATE[s.state]) return s.days !== null ? `<span class="muted">через ${num(s.days)} дн.</span>` : '';
      const text = s.state === 'overdue' ? `просрочено ${num(-s.days)} дн.` : s.state === 'soon' ? `через ${num(s.days)} дн.` : STATE[s.state];
      return `<span class="set-badge set-badge--${s.state}">${esc(text)}</span>`;
    }

    function renderPay() {
      const d = st.data;
      const list = d.services.map((s) => (st.editing === s.id ? serviceForm(s) : serviceCard(s))).join('');
      const missing = TEMPLATES.filter((t) => !d.services.some((s) => s.name.toLowerCase() === t.name.toLowerCase()));
      const pays = d.payments.length ? `
        <section class="card set-sec"><h3>🧾 Последние оплаты</h3>
          <div class="table-wrap"><table class="fin-table"><thead><tr><th>Дата</th><th>Сервис</th><th class="fin-num">Сумма</th><th class="fin-num">В батах</th><th>Кто</th><th></th></tr></thead>
          <tbody>${d.payments.map((p) => `<tr><td>${esc(dmy(p.paidOn))}</td><td>${esc(p.service)}${p.note ? `<div class="muted jr-small">${esc(p.note)}</div>` : ''}</td>
            <td class="fin-num">${esc(`${num(p.amount, 2)} ${p.currency}`)}</td><td class="fin-num">${esc(num(p.thb))} ฿</td><td>${esc(p.by || '—')}</td>
            <td><button type="button" class="link jr-small" data-set-paydel="${p.id}" title="Удалить ошибочную запись">✕</button></td></tr>`).join('')}</tbody></table></div>
          <p class="mk-tip">Оплаты попадают во «Финансы» — статья «IT и подписки». Ошибочную запись можно удалить: дата следующей оплаты вернётся.</p></section>` : '';
      return `
        <section class="card set-sec set-summary">
          <div><span class="muted">Сервисы и подписки в месяц, примерно</span><b>${esc(num(d.monthlyThb))} ฿</b></div>
          <div class="set-actions">
            <button type="button" class="btn btn--primary btn--small" data-set-edit="new">＋ Сервис</button>
            ${missing.length ? `<button type="button" class="btn btn--small" data-set-templates>＋ Типовые (${missing.length})</button>` : ''}
          </div>
          <p class="mk-tip">Напоминания админам в Telegram: за 7 дней, за день и в день оплаты, при просрочке — каждый день. С автосписанием в день оплаты оплата запишется сама.</p>
          ${status(st.msg)}
        </section>
        ${st.editing === 'new' ? serviceForm(null) : ''}
        ${list || '<div class="card empty">Сервисов пока нет. Добавьте свои или типовые и заполните суммы и даты.</div>'}
        ${pays}`;
    }

    function serviceCard(s) {
      const cost = s.cost ? `${num(s.cost, 2)} ${s.currency} ${PERIOD[s.period] || ''}` : '<span class="warn">сумма не указана</span>';
      const facts = [
        s.howToPay ? `💳 ${esc(s.howToPay)}` : '',
        s.autoRenew ? '🔁 автосписание' : '',
        s.responsible ? `👤 ${esc(s.responsible)}` : '',
        s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">кабинет ↗</a>` : ''
      ].filter(Boolean).join(' · ');
      const paying = st.paying === s.id ? `
        <form class="set-paid" data-set-paid="${s.id}">
          <label class="field"><span>Сумма</span><input class="search" name="amount" inputmode="decimal" value="${esc(s.cost ?? '')}" required></label>
          <label class="field"><span>Валюта</span><select class="search" name="currency">${st.data.options.currencies.map((c) => `<option${c === s.currency ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
          <label class="field"><span>Дата оплаты</span><input class="search" type="date" name="paidOn" value="${esc(st.data.today)}" required></label>
          <label class="field set-wide"><span>Заметка (необязательно)</span><input class="search" name="note" maxlength="300" placeholder="Счёт №…, карта …"></label>
          <div class="set-actions set-wide"><button type="submit" class="btn btn--primary btn--small">Записать оплату</button><button type="button" class="btn btn--small" data-set-cancel>Отмена</button></div>
          <p class="mk-tip set-wide">${s.period === 'once' ? 'Разовая оплата: после записи сервис больше не ждёт оплат.' : `Следующая оплата перенесётся на ${esc(AHEAD[s.period] || '')} вперёд: с ${esc(dmy(s.nextDate || st.data.today))}.`}</p>
        </form>` : '';
      return `<article class="card set-svc set-svc--${s.state}">
        <div class="set-svc__head"><div><b>${esc(s.name)}</b> <span class="muted jr-small">${esc(KIND[s.kind] || '')}</span>${s.active ? '' : ' <span class="tag">выключен</span>'}</div>
          <div class="set-svc__due">${s.nextDate ? `<span>${esc(dmy(s.nextDate))}</span> ${stateBadge(s)}` : '<span class="muted">дата не указана</span>'}</div></div>
        <div class="set-svc__cost">${cost}</div>
        ${facts ? `<div class="set-svc__facts muted jr-small">${facts}</div>` : ''}
        ${s.note ? `<div class="jr-small">${esc(s.note)}</div>` : ''}
        ${paying || `<div class="set-actions">
          ${s.active ? `<button type="button" class="btn btn--primary btn--small" data-set-pay="${s.id}">✓ Оплачено</button>` : ''}
          <button type="button" class="btn btn--small" data-set-edit="${s.id}">Изменить</button></div>`}
      </article>`;
    }

    function serviceForm(s) {
      const v = s || { name: '', kind: 'service', cost: '', currency: 'USD', period: 'month', nextDate: '', howToPay: '', autoRenew: false, responsible: '', note: '', url: '', domain: '', active: true };
      const o = st.data.options;
      const opt = (list, cur, label) => list.map((x) => `<option value="${x}"${x === cur ? ' selected' : ''}>${esc(label ? label[x] : x)}</option>`).join('');
      return `<form class="card set-form" data-set-service="${s ? s.id : ''}">
        <h3>${s ? 'Изменить сервис' : 'Новый сервис'}</h3>
        <label class="field set-wide"><span>Название</span><input class="search" name="name" maxlength="80" required value="${esc(v.name)}" placeholder="Сервер, домен, подписка…"></label>
        <label class="field"><span>Что это</span><select class="search" name="kind">${opt(o.kinds, v.kind, KIND)}</select></label>
        <label class="field"><span>Сумма</span><input class="search" name="cost" inputmode="decimal" value="${esc(v.cost ?? '')}" placeholder="12.5"></label>
        <label class="field"><span>Валюта</span><select class="search" name="currency">${opt(o.currencies, v.currency)}</select></label>
        <label class="field"><span>Как часто</span><select class="search" name="period">${opt(o.periods, v.period, PERIOD)}</select></label>
        <label class="field"><span>Следующая оплата</span><input class="search" type="date" name="nextDate" value="${esc(v.nextDate || '')}"></label>
        <label class="field"><span>Кто отвечает</span><input class="search" name="responsible" maxlength="80" value="${esc(v.responsible || '')}"></label>
        <label class="field set-wide"><span>Как платить</span><input class="search" name="howToPay" maxlength="300" value="${esc(v.howToPay || '')}" placeholder="Карта Visa …1234 в кабинете провайдера"></label>
        <label class="field set-wide"><span>Ссылка на кабинет (необязательно)</span><input class="search" name="url" maxlength="300" value="${esc(v.url || '')}" placeholder="https://"></label>
        <label class="field"><span>Домен (для доменов — дата из реестра сама)</span><input class="search" name="domain" maxlength="100" value="${esc(v.domain || '')}" placeholder="jetmobility.org"></label>
        <label class="field set-wide"><span>Заметка</span><input class="search" name="note" maxlength="500" value="${esc(v.note || '')}"></label>
        <label class="mk-check"><input type="checkbox" name="autoRenew"${v.autoRenew ? ' checked' : ''}> Списывается автоматически (автопродление)</label>
        <label class="mk-check"><input type="checkbox" name="active"${v.active ? ' checked' : ''}> Действует (напоминать об оплате)</label>
        <div class="set-actions set-wide">
          <button type="submit" class="btn btn--primary btn--small">Сохранить</button>
          <button type="button" class="btn btn--small" data-set-cancel>Отмена</button>
          ${s ? `<button type="button" class="btn btn--small mk-danger" data-set-del="${s.id}">Удалить</button>` : ''}
        </div>
        ${status(st.msg)}
      </form>`;
    }

    /* ---------------------------------------------------- Домены и сайты */

    function left(days) {
      if (days === null || days === undefined) return '<span class="muted">—</span>';
      const cls = days < 0 ? 'overdue' : days <= 7 ? 'today' : days <= 30 ? 'soon' : '';
      const text = days < 0 ? `истёк ${num(-days)} дн. назад` : `${num(days)} дн.`;
      return cls ? `<span class="set-badge set-badge--${cls}">${esc(text)}</span>` : esc(text);
    }

    /* ------------------------------------------------- Сайт: контакты */

    const LANG_NAMES = { en: 'English', ru: 'Русский', th: 'ไทย', zh: '中文' };
    const phoneRow = (p, i) => `<div class="set-phone" data-set-phone>
        <input class="search" name="phone" value="${esc(p.number || '')}" inputmode="tel" placeholder="+66 80 123 45 67" aria-label="Телефон ${i + 1}">
        <label class="mk-check"><input type="checkbox" name="header"${p.header !== false ? ' checked' : ''}> в шапке</label>
        <button type="button" class="icon-btn icon-btn--plain" data-set-phonedel aria-label="Убрать телефон">✕</button>
      </div>`;

    function renderSite() {
      const d = st.site;
      if (!d) return '<section class="card set-sec"><p class="muted">Не удалось загрузить контакты сайта.</p></section>';
      const c = d.contacts;
      const map = c.map || {};
      const mapSrc = map.lat ? `https://www.google.com/maps?q=${map.lat},${map.lng}&z=16&output=embed` : '';
      return `<section class="card set-sec set-site"><h3>📞 Контакты на сайте jetmobility.org</h3>
        <p class="muted jr-small">Что здесь сохраните — через минуту на сайте: в шапке, в разделе «Контакты» и внизу страницы. kokoncar.com не меняется. ${d.saved ? `Последний раз сохранил(а) ${esc(d.by || '—')}, ${esc(ctx.dateTime(d.at))}.` : 'Пока на сайте то, что было в коде.'}</p>
        <div data-set-sitemsg>${status(st.siteMsg)}</div>
        <form data-set-sitecontacts novalidate>
          <h4>Телефоны</h4>
          <div data-set-phones>${(c.phones.length ? c.phones : [{ number: '' }]).map(phoneRow).join('')}</div>
          <button type="button" class="link jr-small" data-set-phoneadd>＋ телефон</button>
          <h4>Мессенджеры</h4>
          <div class="set-grid">
            <label class="field"><span>WhatsApp (номер для кнопок на сайте)</span><input class="search" name="whatsapp" value="${esc(c.whatsapp ? `+${c.whatsapp}` : '')}" inputmode="tel"></label>
            <label class="field"><span>Telegram (имя, без @)</span><input class="search" name="telegram" value="${esc(c.telegram || '')}" autocomplete="off"></label>
          </div>
          <p class="note">⚠️ Кнопки WhatsApp ведут на номер с ботом (+66 98 227 6467): бот отвечает клиентам и знает, с какого сайта они пришли. Если поменять номер, бот перестанет получать клиентов с сайта.</p>
          <h4>Адрес</h4>
          <div class="set-grid">${d.langs.map((l) => `<label class="field"><span>${esc(LANG_NAMES[l] || l)}</span><input class="search" name="addr_${l}" value="${esc(c.address?.[l] || '')}" placeholder="${l === 'ru' ? 'Пусто — «Пляж Банг Тао»' : l === 'en' ? 'Empty — «Bang Tao Beach»' : ''}"></label>`).join('')}</div>
          <p class="muted jr-small">Под адресом на сайте — «Пхукет, Таиланд». Пустой язык — берётся английский.</p>
          <h4>Точка на карте</h4>
          <div class="set-grid">
            <label class="field set-wide"><span>Ссылка Google Maps (кнопка «Поделиться»)</span><input class="search" name="mapLink" value="${esc(map.link || '')}" placeholder="https://maps.app.goo.gl/…"></label>
            <label class="field"><span>Широта</span><input class="search" name="lat" value="${esc(map.lat ?? '')}" inputmode="decimal"></label>
            <label class="field"><span>Долгота</span><input class="search" name="lng" value="${esc(map.lng ?? '')}" inputmode="decimal"></label>
          </div>
          <button type="button" class="btn btn--small" data-set-resolve>📍 Найти точку по ссылке</button>
          ${mapSrc ? `<div class="set-mapbox"><iframe src="${esc(mapSrc)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Точка на карте"></iframe></div>` : ''}
          <div class="dc-actions"><button type="submit" class="btn btn--primary"${st.busy ? ' disabled' : ''}>Сохранить</button>
            <a class="link jr-small" href="https://jetmobility.org/#contact" target="_blank" rel="noopener">открыть сайт ↗</a></div>
        </form>
      </section>`;
    }

    function showSiteMsg() {
      const box = document.querySelector('[data-set-sitemsg]');
      if (box) { box.innerHTML = status(st.siteMsg); box.scrollIntoView({ block: 'nearest' }); }
    }

    function readSite(form) {
      const phones = [...form.querySelectorAll('[data-set-phone]')].map((row) => ({ number: row.querySelector('[name="phone"]').value, header: row.querySelector('[name="header"]').checked }))
        .filter((p) => p.number.trim());
      const g = (n) => form.elements[n]?.value ?? '';
      return {
        phones, whatsapp: g('whatsapp'), telegram: g('telegram'),
        address: Object.fromEntries((st.site?.langs || []).map((l) => [l, g(`addr_${l}`)])),
        map: { link: g('mapLink'), lat: g('lat').replace(',', '.'), lng: g('lng').replace(',', '.') }
      };
    }

    function renderDomains() {
      const v = st.data.domains;
      const domains = v.domains.map((d) => `<tr><td><b>${esc(d.domain)}</b>${d.error ? `<div class="warn jr-small">реестр не ответил: ${esc(d.error)}</div>` : ''}</td>
        <td>${esc(d.expires ? dmy(d.expires.slice(0, 10)) : '—')}</td><td>${left(d.days)}</td><td>${esc(d.registrar || '—')}</td></tr>`).join('');
      const hosts = v.hosts.map((h) => `<tr><td><a href="https://${esc(h.host)}" target="_blank" rel="noopener">${esc(h.host)}</a>${h.error ? `<div class="warn jr-small">${esc(h.error)}</div>` : ''}</td>
        <td>${esc(h.validTo ? dmy(h.validTo.slice(0, 10)) : '—')}</td><td>${left(h.days)}</td><td>${esc(h.issuer || '—')}</td></tr>`).join('');
      return `
        <section class="card set-sec"><h3>🌐 Домены</h3>
          <div class="table-wrap"><table class="fin-table"><thead><tr><th>Домен</th><th>Оплачен до</th><th>Осталось</th><th>Регистратор</th></tr></thead><tbody>${domains}</tbody></table></div>
          <p class="mk-tip">Срок — из открытого реестра доменов (RDAP), проверяем раз в сутки. Напоминание админам — за 30 и 7 дней, за день и в день окончания.</p>
        </section>
        <section class="card set-sec"><h3>🔒 Сайты и сертификаты (https)</h3>
          <div class="table-wrap"><table class="fin-table"><thead><tr><th>Адрес</th><th>Сертификат до</th><th>Осталось</th><th>Выдал</th></tr></thead><tbody>${hosts}</tbody></table></div>
          <p class="mk-tip">Сертификаты продлеваются сами (бесплатно, примерно за месяц до конца). Если осталось меньше 10 дней — продление не идёт, придёт оповещение.</p>
          <div class="set-actions"><button type="button" class="btn btn--small" data-set-check${st.checking ? ' disabled' : ''}>${st.checking ? 'Проверяю…' : 'Проверить сейчас'}</button>
            <span class="muted jr-small">${v.checkedAt ? `Проверено ${esc(ctx.dateTime(v.checkedAt))}` : 'Ещё не проверяли'}</span></div>
        </section>`;
    }

    /* ------------------------------------------------------------- Ключи */

    function renderKeys() {
      const rows = st.data.keys.map((k) => `<tr><td>${k.set ? '✅ задан' : k.required ? '<span class="warn">⚠️ не задан</span>' : '⚪ не задан'}</td>
        <td><b>${esc(k.label)}</b><div class="muted jr-small">${esc(k.purpose)}</div></td><td><code>${esc(k.name)}</code></td></tr>`).join('');
      return `<section class="card set-sec"><h3>🔑 Ключи и доступы</h3>
        <div class="table-wrap"><table class="fin-table"><thead><tr><th>Состояние</th><th>Для чего</th><th>Имя</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="mk-tip">Сами ключи хранятся только на сервере и сюда не попадают. Задать или поменять ключ — на сервере:</p>
        <pre class="set-code">bash /opt/kokon/app/deploy/set-secret.sh ИМЯ_КЛЮЧА
bash /opt/kokon/app/deploy/update.sh</pre>
        <p class="mk-tip">Ключи не присылайте в чат и не пишите в группы.</p></section>`;
    }

    /* --------------------------------------------------------- Модель ИИ */

    function renderAi() {
      const ai = st.data.ai;
      const current = ai.models.find((m) => m.id === ai.model) || ai.models[0];
      const used = ai.month.usd;
      const pct = ai.limitUsd ? Math.min(100, Math.round((used / ai.limitUsd) * 100)) : 0;
      const radios = ai.models.map((m) => `<label class="mk-radio"><input type="radio" name="model" value="${esc(m.id)}"${m.id === ai.model ? ' checked' : ''}> <b>${esc(m.name)}</b> — ${esc(m.note)}</label>`).join('');
      return `<section class="card set-sec"><h3>🤖 Модель ИИ для «＋ Операция»</h3>
        <p>Сейчас работает: <b>${esc(current.name)}</b> <span class="muted jr-small">(${esc(current.id)})</span></p>
        ${ai.keySet ? '' : '<p class="warn">⚠️ Ключ ANTHROPIC_API_KEY не задан — «＋ Операция» не заработает, пока его не зададут на сервере (вкладка «Ключи»).</p>'}
        <div class="set-meter"><div class="set-meter__bar${pct >= 100 ? ' is-over' : pct >= 80 ? ' is-warn' : ''}" style="width:${pct}%"></div></div>
        <p class="muted jr-small">В этом месяце: $${esc(num(used, 2))}${ai.limitUsd ? ` из $${esc(num(ai.limitUsd))}` : ' (без лимита)'} · запросов ${esc(num(ai.month.requests))}</p>
        <form class="mk-form" data-set-ai>
          <div class="mk-label">Какую модель использовать</div>
          ${radios}
          <label class="field"><span>Лимит расходов в месяц, $ (0 — без лимита)</span><input class="search" name="limitUsd" inputmode="decimal" value="${esc(ai.limitUsd)}"></label>
          <button type="submit" class="btn btn--primary btn--small">Сохранить</button>
          ${status(st.msg)}
        </form>
        <p class="mk-tip">Модель выбирается здесь: сервер передаёт её в каждом запросе к Claude, в настройках соединения или ключа её менять не нужно. При 80% и 100% лимита админам придёт оповещение в Telegram; после 100% распознавание останавливается до следующего месяца или до нового лимита.</p>
      </section>`;
    }

    /* ------------------------------------------------------------ Скидки */

    function renderDiscounts() {
      const s = st.data.discounts;
      const w = st.wabot;
      const ch = (v, label) => `<label class="mk-radio"><input type="radio" name="channels" value="${v}"${s.channels === v ? ' checked' : ''}> ${esc(label)}</label>`;
      // Группа Telegram: настоящее название; другую — по ссылке (выбрать группу в Telegram)
      let tgLine;
      if (!s.telegram) tgLine = '<p class="warn">Telegram-бот не подключён (вкладка «Ключи») — в Telegram писать некуда.</p>';
      else {
        const name = s.tgChat ? (s.tgTitle ? `«${esc(s.tgTitle)}»` : 'без названия') : '';
        tgLine = `<div class="set-disc-tg">
          <p class="mk-text">${s.tgChat
            ? `✅ Группа Telegram: <b>${name}</b>${s.tgIsStaff ? ' <span class="muted">— это рабочая группа</span>' : ''}${s.tgFound ? '' : ' <span class="warn">— бот не видит группу (его удалили?)</span>'}`
            : '⚠️ Группа Telegram не выбрана.'}</p>
          <div class="set-actions">
            <button type="button" class="btn btn--small" data-set-disc-tglink>🔗 ${s.tgChat ? 'Привязать другую группу' : 'Привязать группу'}</button>
            ${s.staffTgGroup && !s.tgIsStaff ? `<button type="button" class="btn btn--small" data-set-disc-staff>Рабочая группа${s.staffTgTitle ? ` «${esc(s.staffTgTitle)}»` : ''}</button>` : ''}
            ${s.tgChat ? '<button type="button" class="link jr-small" data-set-disc-unbind>отвязать</button>' : ''}
          </div>
          ${s.tgLink ? `<div class="set-disc-link">
            <a class="btn btn--primary btn--small" href="${esc(s.tgLink.url)}" target="_blank" rel="noopener">Открыть Telegram и выбрать группу</a>
            <ol class="jr-steps"><li>Нажмите кнопку — откроется Telegram (на телефоне или компьютере).</li><li>Выберите группу из списка. Если бота там нет — Telegram добавит его.</li>
              <li>Нажмите «Запустить» / «Start», если Telegram спросит. В группе бот напишет «✅ Сюда будут приходить запросы на скидки».</li></ol>
            <label class="field"><span>Или скопируйте ссылку и откройте её на телефоне</span><input class="search" readonly value="${esc(s.tgLink.url)}" data-set-copy></label>
            <p class="muted jr-small">⏳ Ждём привязку… Ссылка действует 30 минут, сработает один раз.</p></div>` : ''}
        </div>`;
      }
      const waConnected = w && w.status === 'connected';
      const groups = waConnected ? groupOptions(w.groups, s.waGroup) : '';
      const waField = waConnected
        ? `${staleNote(w)}<label class="field"><span>Группа WhatsApp для скидок</span><select class="search" name="waGroup"><option value="">— не выбрана —</option>${groups}</select></label>
           <p class="mk-tip">Пишет номер клиентского бота ${esc(phoneText(w.me?.id))}. Одобрить — ответить на сообщение «+», отклонить — «-».</p>`
        : '<p class="warn">WhatsApp-бот не подключён (вкладка «Связь») — группу WhatsApp выбрать нельзя.</p>';
      const waJoin = waConnected ? `<form class="mk-form set-disc-join" data-set-disc-join>
          <label class="field"><span>Другая группа WhatsApp — по ссылке-приглашению</span><input class="search" name="invite" placeholder="https://chat.whatsapp.com/…" autocomplete="off"></label>
          <p class="mk-tip">В WhatsApp: группа → «Пригласить по ссылке» → «Копировать ссылку». Бот вступит в группу, и она станет группой для скидок.</p>
          <button type="submit" class="btn btn--small">Подключить группу</button>
        </form>` : '';
      return `<section class="card set-sec"><h3>💸 Скидки</h3>
        <form class="mk-form" data-set-disc>
          <label class="field"><span>Нужно одобрение, если скидка больше, %</span><input class="search" name="approvePct" inputmode="decimal" value="${esc(s.approvePct)}"></label>
          <p class="mk-tip">Больше этого — запрос владельцу и админам, пока не одобрят, договор не подписать и технику не выдать. Владелец и админ дают любую скидку сразу.</p>
          <label class="field"><span>Сообщать в группу о скидках больше, %</span><input class="search" name="notifyPct" inputmode="decimal" value="${esc(s.notifyPct)}"></label>
          <div class="mk-label">Куда писать о скидках</div>
          ${ch('tg', 'Telegram')}${ch('wa', 'WhatsApp')}${ch('both', 'Telegram и WhatsApp')}
          ${tgLine}
          <p class="mk-tip">В Telegram под запросом — кнопки «Одобрить / Отклонить». Нажать могут владелец и админы с Telegram ID во вкладке «Доступы». Одобрить можно и в портале: «Финансы» → «Скидки».</p>
          ${waField}
          <label class="field"><span>Причины скидки (по одной в строке; «Другое» — всегда есть, с комментарием)</span><textarea class="search" name="reasons" rows="8">${esc(s.reasons.join('\n'))}</textarea></label>
          <button type="submit" class="btn btn--primary btn--small">Сохранить</button>
          ${status(st.msg)}
        </form>
        ${waJoin}
      </section>`;
    }

    async function saveDisc(body, okText) {
      await act(async () => {
        const r = await api('/settings/discounts', { body });
        st.data.discounts = r.settings;
        if (r.joined && st.wabot) st.wabot = await api('/wabot').catch(() => st.wabot);
        if (typeof okText === 'function') okText = okText(r);
        return r;
      }, okText);
      ctx.rerender();
    }

    /* ---------------------------------------------------------- События */

    async function act(fn, okText, where = 'msg') {
      if (st.busy) return;
      st.busy = true;
      try {
        const r = await fn();
        const text = typeof okText === 'function' ? okText(r) : okText;
        st[where] = text ? { kind: 'ok', text } : null;
        return true;
      } catch (err) {
        st[where] = { kind: 'error', text: errText(err) };
        return false;
      } finally {
        st.busy = false;
      }
    }

    async function reloadAll() {
      await load();
    }

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.set')) return false;
      if (el.closest('[data-set-phoneadd]')) {
        const box = document.querySelector('[data-set-phones]');
        if (box && box.children.length < 6) box.insertAdjacentHTML('beforeend', phoneRow({ number: '', header: true }, box.children.length));
        return true;
      }
      const pdel = el.closest('[data-set-phonedel]');
      if (pdel) { pdel.closest('[data-set-phone]').remove(); return true; }
      if (el.closest('[data-set-resolve]')) {
        const form = el.closest('form');
        api('/site-contacts/resolve', { body: { link: form.elements.mapLink.value.trim() } })
          .then((r) => {
            form.elements.lat.value = r.point.lat;
            form.elements.lng.value = r.point.lng;
            st.siteMsg = { kind: 'ok', text: `Точка: ${r.point.lat}, ${r.point.lng}. Нажмите «Сохранить».` };
          })
          .catch((err) => { st.siteMsg = { kind: 'error', text: errText(err) }; })
          .finally(showSiteMsg);
        return true;
      }
      const view = el.closest('[data-set-view]');
      if (view) { st.view = view.dataset.setView; st.msg = null; st.editing = null; st.paying = null; ctx.rerender(); return true; }
      const edit = el.closest('[data-set-edit]');
      if (edit) { st.editing = edit.dataset.setEdit === 'new' ? 'new' : Number(edit.dataset.setEdit); st.paying = null; st.msg = null; ctx.rerender(); return true; }
      if (el.closest('[data-set-cancel]')) { st.editing = null; st.paying = null; st.msg = null; ctx.rerender(); return true; }
      const pay = el.closest('[data-set-pay]');
      if (pay) { st.paying = Number(pay.dataset.setPay); st.editing = null; st.msg = null; ctx.rerender(); return true; }
      const del = el.closest('[data-set-del]');
      if (del) {
        if (!window.confirm('Удалить сервис? Записанные оплаты останутся во «Финансах».')) return true;
        act(() => api('/settings/service/delete', { body: { id: Number(del.dataset.setDel) } }), 'Сервис удалён.').then((ok) => { if (ok) st.editing = null; return reloadAll(); });
        return true;
      }
      const payDel = el.closest('[data-set-paydel]');
      if (payDel) {
        if (!window.confirm('Удалить запись об оплате? Она пропадёт и из «Финансов».')) return true;
        act(() => api('/settings/payment/delete', { body: { id: Number(payDel.dataset.setPaydel) } }), 'Оплата удалена.').then(reloadAll);
        return true;
      }
      if (el.closest('[data-set-templates]')) {
        const missing = TEMPLATES.filter((t) => !st.data.services.some((s) => s.name.toLowerCase() === t.name.toLowerCase()));
        act(async () => { for (const t of missing) await api('/settings/service', { body: t }); }, `Добавлено: ${missing.length}. Заполните суммы, даты и как платить.`).then(reloadAll);
        return true;
      }
      if (el.closest('[data-set-check]')) {
        st.checking = true;
        ctx.rerender();
        api('/settings/domains/check', { body: {} }).then((r) => { st.data.domains = r.domains; }).catch(() => null)
          .finally(() => { st.checking = false; ctx.rerender(); });
        return true;
      }
      const go = el.closest('[data-set-go]');
      if (go) { document.getElementById(go.dataset.setGo)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
      if (el.closest('[data-set-disc-staff]')) { saveDisc({ tgUseStaff: true }, 'Запросы на скидки — в рабочую группу Telegram.'); return true; }
      if (el.closest('[data-set-disc-tglink]')) { saveDisc({ tgLink: true }, null); return true; }
      if (el.matches('[data-set-copy]')) { el.select(); return true; }
      if (el.closest('[data-set-disc-unbind]')) {
        if (window.confirm('Отвязать группу Telegram для скидок?')) saveDisc({ tgUnbind: true }, 'Группа Telegram для скидок отвязана.');
        return true;
      }
      if (el.closest('[data-set-wabot-logout]')) {
        if (window.confirm('Отвязать номер компании от бота? Бот перестанет отвечать клиентам, пока номер не привяжут снова.')) linkAction('/wabot/logout', {}, 'Номер отвязан.');
        return true;
      }
      if (el.closest('[data-set-wa-logout]')) {
        if (window.confirm('Отвязать номер наблюдателя? Журнал перестанет пополняться, пока номер не привяжут снова.')) linkAction('/wa/logout', {}, 'Номер наблюдателя отвязан.');
        return true;
      }
      return false;
    }

    async function linkAction(path, body, okText) {
      await act(() => api(path, { body }), okText, 'linkMsg');
      const [wabot, wa] = await Promise.all([api('/wabot').catch(() => st.wabot), api('/wa').catch(() => st.wa)]);
      st.wabot = wabot;
      st.wa = wa;
      ctx.rerender();
    }

    function onSubmit(event) {
      const form = event.target;
      if (!form.closest?.('.set')) return false;
      event.preventDefault();
      const f = new FormData(form);
      if (form.matches('[data-set-sitecontacts]')) {
        const body = readSite(form);
        act(() => api('/site-contacts/save', { body }), 'Сохранено. На сайте — в течение минуты.', 'siteMsg').then(async (ok) => {
          // Ошибка — форма остаётся с тем, что ввели; сохранили — показываем, что теперь на сайте
          if (!ok) { showSiteMsg(); return; }
          st.site = await api('/site-contacts').catch(() => st.site);
          ctx.rerender();
        });
        return true;
      }
      if (form.matches('[data-set-service]')) {
        const id = form.dataset.setService ? Number(form.dataset.setService) : null;
        const body = {
          id, name: f.get('name'), kind: f.get('kind'), cost: f.get('cost'), currency: f.get('currency'), period: f.get('period'),
          nextDate: f.get('nextDate') || null, responsible: f.get('responsible'), howToPay: f.get('howToPay'), url: f.get('url'),
          domain: f.get('domain'), note: f.get('note'), autoRenew: f.get('autoRenew') === 'on', active: f.get('active') === 'on'
        };
        act(() => api('/settings/service', { body }), id ? 'Сохранено.' : 'Сервис добавлен.').then((ok) => { if (ok) st.editing = null; return ok ? reloadAll() : ctx.rerender(); });
        return true;
      }
      if (form.matches('[data-set-paid]')) {
        const body = { id: Number(form.dataset.setPaid), amount: f.get('amount'), currency: f.get('currency'), paidOn: f.get('paidOn'), note: f.get('note') };
        act(() => api('/settings/service/paid', { body }), 'Оплата записана, дата следующей оплаты перенесена.').then((ok) => { if (ok) st.paying = null; return ok ? reloadAll() : ctx.rerender(); });
        return true;
      }
      if (form.matches('[data-set-ai]')) {
        act(async () => { const r = await api('/settings/ai', { body: { model: f.get('model'), limitUsd: f.get('limitUsd') } }); Object.assign(st.data.ai, r.ai); }, 'Сохранено.')
          .then(() => ctx.rerender());
        return true;
      }
      if (form.matches('[data-set-disc-join]')) {
        saveDisc({ waInvite: f.get('invite') }, (r) => `Бот в группе «${r.joined?.subject || 'WhatsApp'}» — запросы на скидки пойдут туда.`);
        return true;
      }
      if (form.matches('[data-set-disc]')) {
        const body = { approvePct: f.get('approvePct'), notifyPct: f.get('notifyPct'), channels: f.get('channels') || 'tg', reasons: f.get('reasons') };
        if (form.elements.waGroup) body.waGroup = f.get('waGroup') || null;
        saveDisc(body, 'Сохранено.');
        return true;
      }
      if (form.matches('[data-set-wabot-mode]')) {
        const mode = f.get('mode');
        linkAction('/wabot/settings', { mode, testNumbers: f.get('testNumbers') || '' },
          mode === 'on' ? 'Бот отвечает всем клиентам.' : mode === 'test' ? 'Бот отвечает только тестовым номерам.' : 'Бот никому не отвечает.');
        return true;
      }
      if (form.matches('[data-set-wabot-group]')) {
        const telegramCopy = f.get('telegramCopy') === 'on';
        api('/wabot/settings', { body: { telegramCopy } }).catch(() => null)
          .then(() => linkAction('/wabot/config', { groupId: f.get('groupId') },
            f.get('groupId') ? `Заявки будут приходить в эту группу${telegramCopy ? ' и копией в Telegram' : ''}.` : 'Заявки в WhatsApp-группу не приходят — только в Telegram.'));
        return true;
      }
      if (form.matches('[data-set-wabot-events]')) {
        const group = f.get('eventsGroup') || null;
        linkAction('/wabot/settings', { eventsGroup: group }, group ? 'События парка будут приходить в эту группу.' : 'События парка в группу не пишем.');
        return true;
      }
      if (form.matches('[data-set-wabot-pair]')) { linkAction('/wabot/pair', { phone: f.get('phone') }); return true; }
      if (form.matches('[data-set-wa-group]')) { linkAction('/wa/config', { groupId: f.get('groupId') }, 'Наблюдатель читает эту группу.'); return true; }
      if (form.matches('[data-set-wa-pair]')) { linkAction('/wa/pair', { phone: f.get('phone') }); return true; }
      return false;
    }

    return { load, render, onClick, onSubmit, tick, canRefresh, show: (view) => { if (view) st.view = view; } };
  }

  window.STAFF_SETTINGS = { create };
})();
