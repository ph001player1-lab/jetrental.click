/*
 * Вкладка «Настройки» (только админ): связь (Telegram, WhatsApp-бот для
 * клиентов, наблюдатель рабочей группы), домены и сертификаты, ключи
 * («задан / не задан» — сами ключи только на сервере), сервисы и оплаты
 * с напоминаниями в Telegram, модель ИИ для «＋ Операция» и лимит расходов.
 * Сервер — itSettings.js; WhatsApp — те же адреса /wabot и /wa, что раньше
 * были в «Маркетинге» и «Журнале» (там теперь ссылка сюда).
 */
(function () {
  'use strict';

  const VIEWS = [['links', '🔌 Связь'], ['pay', '💳 Сервисы и оплаты'], ['domains', '🌐 Домены и сайты'], ['keys', '🔑 Ключи'], ['ai', '🤖 Модель ИИ']];
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
    bad_model: 'Выберите модель из списка.', bad_limit: 'Лимит — числом (0 — без лимита).', admin_only: 'Только для админа.',
    not_waiting_for_link: 'Код можно получить, только пока показывается QR-код.', unknown_group: 'Группа не найдена — обновите страницу.', wabot_unreachable: 'Бот не отвечает на сервере.'
  };

  function create(ctx) {
    const { api, esc } = ctx;
    const st = { view: 'links', data: null, wabot: null, wa: null, failed: false, editing: null, paying: null, msg: null, linkMsg: null, checking: false, busy: false };
    const num = (n, digits = 0) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(n || 0);
    const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '—');
    const phoneText = (id) => (id ? `+${String(id).split(/[:@]/)[0]}` : '—');
    const errText = (err) => ERR[err?.code] || 'Не получилось. Попробуйте ещё раз.';

    async function load() {
      try {
        const [data, wabot, wa] = await Promise.all([api('/settings'), api('/wabot').catch(() => null), api('/wa').catch(() => null)]);
        Object.assign(st, { data, wabot, wa, failed: false });
      } catch {
        st.failed = true;
      }
      ctx.rerender();
    }

    /** Пока идёт привязка по QR — обновляем каждые 5 секунд (код меняется) */
    let ticks = 0;
    async function tick() {
      ticks++;
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
      return !st.editing && !st.paying && !(view && view.contains(document.activeElement) && document.activeElement.matches('input, select, textarea'));
    }

    function status(msg) {
      return msg ? `<p class="md-status is-${msg.kind}" role="status">${esc(msg.text)}</p>` : '';
    }

    function render() {
      if (st.failed) return '<div class="set"><div class="card empty">Не удалось загрузить настройки. Обновите страницу.</div></div>';
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
      if (st.view === 'keys') body = renderKeys();
      if (st.view === 'ai') body = renderAi();
      return `<div class="set"><div class="chips set-views">${chips}</div>${body}</div>`;
    }

    /* ------------------------------------------------------------ Связь */

    function renderLinks() {
      return `${renderTelegram()}${renderWabot()}${renderObserver()}${status(st.linkMsg)}`;
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
      return `<section class="card set-sec"><h3>✈️ Telegram</h3><ul class="set-list">${rows.join('')}</ul>
        <p class="mk-tip">Перепривязать группу — написать <code>/bind</code> в новой группе. Утренняя сводка и заявки (если включено) — в эту группу.</p></section>`;
    }

    function renderWabot() {
      const w = st.wabot;
      let body;
      if (!w || w.reachable === false) body = '<p class="warn">Бот не отвечает на сервере. Если сервер только что обновили — подождите минуту и обновите страницу.</p>';
      else if (w.status === 'connected') {
        const set = w.settings || { mode: 'off', testNumbers: [] };
        const groups = (w.groups || []).map((g) => `<option value="${esc(g.id)}"${g.id === w.groupId ? ' selected' : ''}>${esc(`${g.subject} (${g.size})`)}</option>`).join('');
        const obs = w.observerGroup || {};
        const events = (w.groups || []).map((g) => `<option value="${esc(g.id)}"${g.id === set.eventsGroup ? ' selected' : ''}>${esc(`${g.subject} (${g.size})`)}${g.id === obs.id ? ' — читает наблюдатель' : ''}</option>`).join('');
        const botInObserver = obs.id && (w.groups || []).some((g) => g.id === obs.id);
        body = `
          <p>✅ Подключён номер <b>${esc(phoneText(w.me?.id))}</b>${w.me?.name ? ` (${esc(w.me.name)})` : ''}${w.today?.date ? ` · сегодня написали ${num(w.today.received)}, бот ответил ${num(w.today.sent)}` : ''}</p>
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
      return `<section class="card set-sec"><h3>💬 WhatsApp-бот для клиентов</h3>${body}</section>`;
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
      return `<section class="card set-sec"><h3>👀 Наблюдатель рабочей группы WhatsApp</h3>${body}
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

    /* ---------------------------------------------------------- События */

    async function act(fn, okText, where = 'msg') {
      if (st.busy) return;
      st.busy = true;
      try {
        await fn();
        st[where] = okText ? { kind: 'ok', text: okText } : null;
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
