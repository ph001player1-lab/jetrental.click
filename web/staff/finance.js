/*
 * Вкладка «Финансы» — только просмотр и только на русском (так решил владелец).
 * Данные: отчёты рабочей группы WhatsApp (журнал) и — для расходов и сверки —
 * загруженная «Касса» из WS. Суммы в батах, другие валюты — по курсу дня.
 * Блоки по порядку: сводка, касса, залоги, долги клиентов, машины, расходы,
 * прогноз, сверка с WS, деньги в отчётах. Скидки — из договоров («Документы»):
 * какие сделки со скидкой, причина, кто дал и кто одобрил.
 */
(function () {
  'use strict';

  const DAY_MS = 86400000;
  const PRESETS = [['today', 'Сегодня'], ['week', '7 дней'], ['month', 'Этот месяц'], ['lastMonth', 'Прошлый месяц'], ['d30', '30 дней'], ['d90', '90 дней'], ['year', 'С начала года']];
  const KIND = {
    booking: 'Бронь', issue: 'Выдача', return: 'Возврат', extension: 'Продление', payment: 'Оплата', changed: 'Замена', pickup_task: 'Забрать (задание)'
  };
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const SECTIONS = [['sum', 'Сводка'], ['disc', 'Скидки'], ['cash', 'Касса'], ['ai', 'ИИ-касса'], ['dep', 'Залоги'], ['debt', 'Долги'], ['cars', 'Машины'], ['exp', 'Расходы'], ['fc', 'Прогноз'], ['ws', 'Сверка']];
  const ERRORS = {
    not_cashbook: 'Это не выгрузка «Касса» из WS: нужен файл .xlsx с колонками «Дата», «Назначение платежа», «Приход», «Расход».',
    admin_only: 'Это может только админ.',
    owner_or_admin_only: 'Одобрить скидку может только владелец или админ.',
    already_decided: 'По этой скидке уже решили.',
    body_too_large: 'Файл слишком большой (больше 20 МБ).'
  };
  const TEMPLATES = {
    expense: 'Expense: 1,200 THB — Fuel — Honda ADV350 #5951 (cash)',
    handover: 'Cash handover: 20,000 THB to @Alexey'
  };

  function create(ctx) {
    const { api, esc } = ctx;
    const st = {
      preset: 'month', data: null, failed: false, loading: false, sort: 'revenue', opsAll: false, upload: null,
      wsOnlyAll: false, groupOnlyAll: false, debtsAll: false, withheldAll: false, loansOpen: false, loansMsg: null,
      disc: null, discAll: false, discMsg: null, receipts: null, receiptsAll: false, ai: null, aiAll: false, aiPortalAll: false
    };

    // Даты и числа — всегда по-русски, время по Бангкоку
    const fmtNum = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
    const fmtDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
    const fmtDateTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const num = (n) => fmtNum.format(Math.round(n || 0));
    const baht = (n) => `${num(n)} ฿`;
    const day = (iso) => (iso ? fmtDate.format(new Date(iso.length === 10 ? `${iso}T12:00:00+07:00` : iso)) : '—');
    // Конец окна — граница «до» (полночь следующего дня): показываем предыдущий день
    const dayEnd = (iso) => (iso ? day(new Date(Date.parse(iso) - 60000).toISOString()) : '—');
    const when = (iso) => (iso ? fmtDateTime.format(new Date(iso)) : '—');
    const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
    const money = (currencies) => Object.entries(currencies || {}).map(([c, v]) => `${num(v)} ${c}`).join(' · ');
    const plates = (list) => (list || []).map((p) => `<span class="plate">#${esc(p)}</span>`).join(' ');
    const signed = (n) => `${n > 0 ? '+' : ''}${num(n)}`;
    const diffCell = (ws, group) => {
      const d = ws - group;
      const cls = Math.abs(d) < 500 ? 'fin-ok' : d > 0 ? 'fin-more' : 'fin-less';
      return `<td class="fin-num ${cls}">${esc(signed(d))}</td>`;
    };
    const journalLink = (plate, label = 'в журнале') => (ctx.can('journal.view') && plate
      ? ` <button type="button" class="link jr-small" data-problem="journal" data-q="${esc(plate)}">${esc(label)}</button>` : '');
    const showAll = (key, count, limit) => (count > limit && !st[key] ? `<button type="button" class="btn btn--small" data-fin-all="${key}">Показать все (${count})</button>` : '');

    const bkk = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
    function range(preset) {
      const now = Date.now();
      const today = bkk(now);
      const monthStart = `${today.slice(0, 8)}01`;
      if (preset === 'today') return [today, today];
      if (preset === 'week') return [bkk(now - 6 * DAY_MS), today];
      if (preset === 'd30') return [bkk(now - 29 * DAY_MS), today];
      if (preset === 'd90') return [bkk(now - 89 * DAY_MS), today];
      if (preset === 'year') return [`${today.slice(0, 4)}-01-01`, today];
      if (preset === 'lastMonth') {
        const lastEnd = bkk(Date.parse(`${monthStart}T00:00:00Z`) - DAY_MS);
        return [`${lastEnd.slice(0, 8)}01`, lastEnd];
      }
      return [monthStart, today];
    }

    async function load() {
      const [from, to] = range(st.preset);
      st.loading = true;
      ctx.rerender();
      try {
        const [data, disc, receipts, ai] = await Promise.all([api(`/finance?from=${from}&to=${to}`), api(`/discounts?from=${from}&to=${to}`).catch(() => null),
          api(`/expenses?from=${from}&to=${to}`).catch(() => null), api(`/finance/ai-log?from=${from}&to=${to}`).catch(() => null)]);
        st.data = data;
        st.ai = ai;
        st.disc = disc;
        st.receipts = receipts;
        st.failed = false;
      } catch (err) {
        st.failed = ERRORS[err.code] || 'Не удалось загрузить данные. Обновите страницу.';
      }
      st.loading = false;
      ctx.rerender();
    }

    async function send(path, body, type) {
      const response = await fetch(`/api/staff${path}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type }, body
      });
      const r = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(r.error), { code: r.error });
      return r;
    }

    async function uploadCashbook(file) {
      if (!file) return;
      st.upload = { kind: 'busy', text: 'Загружаем кассу…' };
      ctx.rerender();
      try {
        const r = await send('/finance/cashbook', file, 'application/octet-stream');
        await load();
        st.upload = { kind: 'ok', text: `✓ Загружено строк: ${num(r.rows)} (${day(r.from)} — ${day(r.to)})${r.replaced ? `, заменено прежних: ${num(r.replaced)}` : ''}.` };
        ctx.rerender();
      } catch (err) {
        st.upload = { kind: 'error', text: ERRORS[err.code] || 'Не удалось загрузить файл.' };
        ctx.rerender();
      }
    }

    async function saveLoans(text) {
      try {
        const r = await send('/finance/loans', JSON.stringify({ text }), 'application/json');
        st.loansOpen = false;
        await load();
        st.loansMsg = { kind: 'ok', text: `✓ Сохранено машин с кредитом: ${Object.keys(r.loans).length}.` };
        ctx.rerender();
      } catch (err) {
        st.loansMsg = { kind: 'error', text: ERRORS[err.code] || 'Не удалось сохранить.' };
        ctx.rerender();
      }
    }

    const tile = (label, value, hint, tone = '') => `
      <div class="stat fin-tile${tone ? ` fin-tile--${tone}` : ''}">
        <div class="stat__label">${esc(label)}</div>
        <div class="stat__value">${esc(value)}</div>
        ${hint ? `<div class="muted jr-small">${esc(hint)}</div>` : ''}
      </div>`;
    const section = (id, title, body, intro = '') => `
      <section class="card fin-sec" id="fin-${id}"><h3>${esc(title)}</h3>${intro ? `<p class="muted jr-small">${intro}</p>` : ''}${body}</section>`;
    const status = (msg) => (msg ? `<p class="md-status is-${msg.kind === 'error' ? 'error' : 'ok'}" role="status">${esc(msg.text)}</p>` : '');
    const template = (key) => `<pre class="fin-template">${esc(TEMPLATES[key])}</pre>`;

    /* ------------------------------------------------------- Скидки */

    async function decide(id, approve) {
      try {
        await send('/discounts/decide', JSON.stringify({ id, approve }), 'application/json');
        st.discMsg = { kind: 'ok', text: approve ? '✓ Скидка одобрена.' : '✓ Скидка отклонена: в договоре снова цена по прайсу.' };
      } catch (err) {
        st.discMsg = { kind: 'error', text: ERRORS[err.code] || 'Не удалось сохранить решение.' };
      }
      await load();
    }

    const DISC_STATUS = { pending: '⏳ ждёт одобрения', approved: 'дана', rejected: 'отклонена' };
    const discKind = (x) => (x.kind === 'percent' ? `${x.value}%` : x.kind === 'amount' ? `−${baht(x.value)}` : `своя цена ${baht(x.value)}`);
    const contractLink = (x) => (ctx.openContract ? `<button type="button" class="link" data-fin-contract="${x.docId}">${esc(x.number || 'договор')}</button>` : esc(x.number || ''));

    function renderDiscounts() {
      const d = st.disc;
      if (!d) return '';
      const pending = d.pending.length ? `<div class="fin-disc-wait"><h4>⏳ Ждут одобрения (${d.pending.length})</h4><ul class="fin-ops">${d.pending.map((x) => `<li>
          <div><b>−${esc(x.percent)}%</b> (${esc(discKind(x))}) · ${contractLink(x)} · ${esc(x.client || '—')} ${x.plate ? `<span class="plate">#${esc(x.plate)}</span>` : ''}</div>
          <div class="fin-op__money">${esc(baht(x.base))} → ${esc(baht(x.final))} · причина: ${esc(x.reason)}${x.comment ? ` — «${esc(x.comment)}»` : ''}</div>
          <div class="muted jr-small">запросил(а) ${esc(x.by || '—')} · ${esc(when(x.at))}</div>
          ${d.canApprove ? `<div class="fin-disc-btns"><button type="button" class="btn btn--small btn--primary" data-fin-decide="${x.id}:1">✅ Одобрить</button> <button type="button" class="btn btn--small" data-fin-decide="${x.id}:0">❌ Отклонить</button></div>` : ''}
        </li>`).join('')}</ul></div>` : '';
      const t = d.totals;
      const tiles = `<div class="stats fin-tiles">
        ${tile('Сделок со скидкой', num(t.count), 'одобренные и выданные без одобрения')}
        ${tile('Скидок на сумму', baht(t.off), t.base ? `${Math.round((t.off / t.base) * 1000) / 10}% от цены по прайсу` : '')}
      </div>`;
      const groupTable = (title, head, rows) => (rows.length ? `<h4>${esc(title)}</h4><div class="table-wrap"><table class="fin-table">
        <thead><tr><th>${esc(head)}</th><th class="fin-num">Сделок</th><th class="fin-num">Скидка</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="fin-num">${esc(num(r.count))}</td><td class="fin-num">${esc(baht(r.off))}</td></tr>`).join('')}</tbody></table></div>` : '');
      const list = st.discAll ? d.list : d.list.slice(0, 20);
      const deals = d.list.length ? `<h4>Сделки со скидкой</h4><div class="table-wrap"><table class="fin-table fin-table--wide fin-table--stack">
        <thead><tr><th>Когда</th><th>Договор</th><th>Клиент и техника</th><th class="fin-num">По прайсу</th><th class="fin-num">Итог</th><th>Скидка</th><th>Причина</th><th>Кто дал</th><th>Решение</th></tr></thead>
        <tbody>${list.map((x) => `<tr>
          <td data-label="Когда">${esc(when(x.at))}</td>
          <td data-label="Договор">${contractLink(x)}</td>
          <td data-label="Клиент">${esc(x.client || '—')} ${x.plate ? `<span class="plate">#${esc(x.plate)}</span>` : ''}<div class="muted jr-small">${esc(x.model || '')}</div></td>
          <td class="fin-num" data-label="По прайсу">${esc(num(x.base))}</td>
          <td class="fin-num" data-label="Итог"><b>${esc(num(x.final))}</b></td>
          <td data-label="Скидка"><b>−${esc(x.percent)}%</b><div class="muted jr-small">${esc(discKind(x))}</div></td>
          <td data-label="Причина">${esc(x.reason)}${x.comment ? `<div class="muted jr-small">«${esc(x.comment)}»</div>` : ''}</td>
          <td data-label="Кто дал">${esc(x.by || '—')}</td>
          <td data-label="Решение">${esc(DISC_STATUS[x.status] || x.status)}${x.decidedBy ? `<div class="muted jr-small">${esc(x.decidedBy)}${x.decidedVia ? ` · ${esc({ portal: 'портал', telegram: 'Telegram', whatsapp: 'WhatsApp' }[x.decidedVia] || x.decidedVia)}` : ''}</div>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>${showAll('discAll', d.list.length, 20)}` : '<p class="muted">За этот период скидок не было.</p>';
      return section('disc', 'Скидки', `${status(st.discMsg)}${pending}${tiles}${groupTable('По причинам', 'Причина', d.byReason)}${groupTable('Кто давал', 'Сотрудник', d.byStaff)}${deals}`,
        `Скидки из договоров («Документы»). Больше ${esc(d.settings.approvePct)}% — только с одобрения владельца или админа.`);
    }

    /* ------------------------------------------------------- 1. Сводка */

    function renderSummary(d) {
      const s = d.summary;
      const p = d.profit;
      const partial = d.dataFrom && d.dataFrom.slice(0, 10) > d.period.from;
      let expHint = 'касса WS, «Expense:» в группе, чеки из «＋ Операция»';
      if (p.expenses === null) expHint = 'нет данных: загрузите кассу WS или пишите «Expense:» в группу';
      else if (p.expensesTo && p.expensesTo < p.to) expHint = `по кассе WS по ${dayEnd(p.expensesTo)}`;
      let profitTone = '';
      if (p.result !== null) profitTone = p.result >= 0 ? 'in' : 'held';
      const tiles = `
        <div class="stats fin-tiles">
          ${tile('Выручка', baht(p.revenue), `аренда и доп. услуги по отчётам (${s.reports})`)}
          ${tile('Расходы', p.expenses === null ? '—' : baht(p.expenses), expHint)}
          ${tile('Прибыль', p.result === null ? '—' : baht(p.result), p.result === null ? '' : 'выручка минус расходы', profitTone)}
          ${tile('Получено денег', baht(s.moneyIn), `с залогами · наличные ${baht(s.inCash)} · переводы ${baht(s.inTransfer)}`)}
        </div>`;
      const note = partial ? `<p class="muted jr-small">Отчёты группы есть с ${esc(day(d.dataFrom))} — прибыль считаем с этой даты (${esc(day(p.from))} — ${esc(dayEnd(p.to))}).</p>` : '';
      const rows = [
        ['Оплата за аренду', s.rent, 'аренда и продления в отчётах о выдаче, продлении, оплате'],
        ['Оплата за доп. услуги', s.extras, 'доставка, шлемы, детское кресло, бокс, топливо, переработка'],
        ['Предоплата за заявку/бронь', s.prepaid, '«Booking received» в бронях — войдёт в аренду при выдаче'],
        ['Внесение залога', d.deposits.taken, 'залоги в отчётах о выдаче'],
        ['Возврат залога', -d.deposits.returned, 'возвраты в отчётах о возврате']
      ];
      const byItem = `<h4>По статьям — как в кассе WS</h4><div class="table-wrap"><table class="fin-table">
        <thead><tr><th>Статья</th><th class="fin-num">Сумма</th></tr></thead>
        <tbody>${rows.map(([label, v, hint]) => `<tr><td><b>${esc(label)}</b><div class="muted jr-small">${esc(hint)}</div></td><td class="fin-num${v < 0 ? ' fin-less' : ''}">${esc(baht(v))}</td></tr>`).join('')}</tbody>
      </table></div>`;
      const months = d.months.length < 2 ? '' : `<h4>По месяцам</h4><div class="table-wrap"><table class="fin-table fin-table--wide fin-table--stack">
        <thead><tr><th>Месяц</th><th class="fin-num">Аренда</th><th class="fin-num">Доп. услуги</th><th class="fin-num">Предоплата</th><th class="fin-num">Залог внесён</th><th class="fin-num">Залог возвращён</th><th class="fin-num">Получено</th></tr></thead>
        <tbody>${d.months.map((m) => `<tr><td><b>${esc(monthName(m.month))}</b></td><td class="fin-num" data-label="Аренда">${esc(num(m.rent))}</td><td class="fin-num" data-label="Доп. услуги">${esc(num(m.extras))}</td>
          <td class="fin-num" data-label="Предоплата">${esc(num(m.prepaid))}</td><td class="fin-num" data-label="Залог внесён">${esc(num(m.depositIn))}</td><td class="fin-num" data-label="Залог возвращён">${esc(num(m.depositOut))}</td><td class="fin-num" data-label="Получено"><b>${esc(num(m.moneyIn))}</b></td></tr>`).join('')}</tbody></table></div>`;
      return section('sum', 'Сводка', tiles + note + byItem + months);
    }

    /* -------------------------------------------------------- 2. Касса */

    function renderCash(d) {
      const c = d.cash;
      const t = c.team;
      const rows = c.holders.map((h) => `
        <tr>
          <td><b>${esc(h.name)}</b>${h.lastHandover ? `<div class="muted jr-small">сдал(а) ${esc(when(h.lastHandover))}</div>` : ''}</td>
          <td class="fin-num" data-label="Принял">${esc(num(h.received))}</td>
          <td class="fin-num" data-label="Выдал">${esc(num(h.paidOut))}</td>
          <td class="fin-num" data-label="Расходы">${esc(num(h.spent))}</td>
          <td class="fin-num" data-label="Сдал">${esc(num(h.handed))}</td>
          <td class="fin-num" data-label="На руках">${h.onHand === null ? '<span class="muted">—</span>' : `<b class="${h.onHand > 0 ? 'fin-more' : ''}">${esc(num(h.onHand))}</b>`}</td>
        </tr>`).join('');
      const table = c.holders.length ? `<div class="table-wrap"><table class="fin-table fin-table--wide fin-table--stack">
        <thead><tr><th>Сотрудник</th><th class="fin-num">Принял наличными</th><th class="fin-num">Выдал (возвраты залогов)</th><th class="fin-num">Расходы наличными</th><th class="fin-num">Сдал</th><th class="fin-num">На руках с последней сдачи</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td><b>Все вместе</b></td><td class="fin-num" data-label="Принял"><b>${esc(num(t.received))}</b></td><td class="fin-num" data-label="Выдал"><b>${esc(num(t.paidOut))}</b></td><td class="fin-num" data-label="Расходы"><b>${esc(num(t.spent))}</b></td><td class="fin-num" data-label="Сдал"><b>${esc(num(t.handed))}</b></td><td class="fin-num" data-label="Остаток за период"><b>${esc(num(t.net))}</b></td></tr></tfoot>
      </table></div>` : '<p class="muted">За период наличных в отчётах нет.</p>';
      const handoverNote = c.handoverReports
        ? '<p class="muted jr-small">«На руках» — с последнего сообщения «Cash handover» этого сотрудника (считаем, что при сдаче отдают всё). Минус — выдал больше, чем принял (например, залоги из кассы офиса).</p>'
        : `<p class="fin-warn">«На руках» пока не считается: в группе не пишут, когда сдают кассу. Попросите сотрудников при сдаче писать одной строкой:</p>${template('handover')}`;
      const office = c.office ? `<h4>Касса офиса по WS (счёт Office)</h4>
        <div class="stats fin-tiles">
          ${tile('Приход наличными', baht(c.office.in))}
          ${tile('Расход наличными', baht(c.office.out))}
          ${tile('Снято из кассы', baht(c.office.toOwner), 'снятие средств — Алексею')}
          ${tile('Остаток за период', baht(c.office.in - c.office.out - c.office.toOwner + c.office.fromOwner), 'приход − расход − снято')}
        </div>
        <p class="muted jr-small">Сравните «Принял наличными — все вместе» по группе (${esc(baht(t.received))}) с приходом в кассу офиса по WS (${esc(baht(c.office.in))}): большая разница — деньги не внесли в кассу или в группу.</p>` : '';
      // Куда поступили деньги: счета как в кассе WS и кто принял
      const accounts = d.accounts.map((a) => `<tr${/Не указано|не указан/.test(a.account) ? ' class="fin-unknown"' : ''}><td><b>${esc(a.account)}</b></td><td class="fin-num">${esc(baht(a.thb))}</td><td class="muted">${esc(money(a.currencies))}</td></tr>`).join('');
      const people = d.receivers.map((r) => `
        <tr${r.name ? '' : ' class="fin-unknown"'}>
          <td><b>${esc(r.name || 'Не указано')}</b>${r.name ? '' : '<div class="muted jr-small">в отчёте не написано, кто принял — пишите «received in cash by @имя»</div>'}</td>
          <td class="fin-num">${esc(baht(r.thb))}</td><td class="muted">${esc(money(r.currencies))}</td><td class="fin-num muted">${esc(String(r.count))}</td>
        </tr>`).join('');
      const where = d.accounts.length ? `
        <h4>Куда поступили деньги — по счетам</h4>
        <p class="muted jr-small">«Касса» — наличные у сотрудников; Alexey — переводы на счета Алексея по валютам. Вместе с залогами.</p>
        <div class="table-wrap"><table class="fin-table fin-table--cash"><thead><tr><th>Счёт</th><th class="fin-num">Сумма</th><th>По валютам</th></tr></thead><tbody>${accounts}</tbody></table></div>
        <h4>Кто принял деньги</h4>
        <div class="table-wrap"><table class="fin-table fin-table--cash"><thead><tr><th>Кто</th><th class="fin-num">Всего</th><th>По валютам</th><th class="fin-num">Отчётов</th></tr></thead><tbody>${people}</tbody></table></div>` : '';
      return section('cash', 'Касса: наличные у сотрудников', table + handoverNote + office + where,
        'Кто сколько принял наличными и сколько сдал. Остаток «на руках» — самое частое место потерь.');
    }

    /* ------------------------------------------------------- 3. Залоги */

    function renderDeposits(d) {
      const dp = d.deposits;
      const list = (st.withheldAll ? dp.withheldList : dp.withheldList.slice(0, 8)).map((w) => `
        <li><b>${esc(baht(w.withheld))}</b> · ${esc(day(w.ts))} · ${plates(w.plates)} · залог ${esc(num(w.deposit))}, вернули ${esc(num(w.returned))} · ${esc(w.author)}${journalLink(w.plates[0])}</li>`).join('');
      return section('dep', 'Залоги', `
        <div class="stats fin-tiles">
          ${tile('На руках сейчас', baht(dp.held), `машин в аренде: ${dp.cars} — это долг клиентам`, 'held')}
          ${tile('Внесено', baht(dp.taken), 'за период, по отчётам о выдаче')}
          ${tile('Возвращено', baht(dp.returned), 'за период, по отчётам о возврате')}
          ${tile('Удержано', baht(dp.withheld), `возвратов с удержанием: ${dp.withheldCount}`)}
        </div>
        ${dp.withheldList.length ? `<h4>Удержания из залога</h4><ul class="fin-list">${list}</ul>${showAll('withheldAll', dp.withheldList.length, 8)}` : ''}
        ${dp.noAmount ? `<p class="muted jr-small">Ещё ${dp.noAmount} возврат(ов) без суммы возврата залога в отчёте — удержание по ним не посчитать.</p>` : ''}`,
      'Удержано — залог (из отчёта о возврате или о выдаче) минус возвращённое клиенту: ремонт, топливо, штрафы.');
    }

    /* ------------------------------------------------- 4. Долги клиентов */

    function renderDebts(d) {
      const debts = d.debts;
      const list = (st.debtsAll ? debts.list : debts.list.slice(0, 10)).map((x) => `
        <li><b>${esc(baht(x.amount))}</b> · ${plates(x.plates)} · ${esc(KIND[x.kind] || x.kind)} ${esc(day(x.ts))} · ${esc(x.author)}
          <div class="jr-small">${x.overdue ? `<b class="fin-less">просрочено ${x.late} дн.</b> (срок ${esc(day(x.due))})` : `срок ${esc(day(x.due))}`}${x.note ? ` · «${esc(x.note)}»` : ''}${journalLink(x.plates[0])}</div></li>`).join('');
      return section('debt', 'Долги клиентов', `
        <div class="stats fin-tiles stats--3">
          ${tile('Просрочено', baht(debts.overdueSum), `оплат: ${debts.overdueCount}`, debts.overdueSum ? 'held' : '')}
          ${tile('Ожидается', baht(debts.upcomingSum), `оплат: ${debts.upcomingCount}`)}
          ${tile('Всего должны', baht(debts.overdueSum + debts.upcomingSum))}
        </div>
        ${debts.list.length ? `<ul class="fin-list">${list}</ul>${showAll('debtsAll', debts.list.length, 10)}` : '<p class="muted">Долгов нет.</p>'}`,
      'На сегодня, за последние 90 дней: «Left amount» и «To collect» в выдаче, продлении и оплате, после которых по этой машине не было отчёта с полученными деньгами.');
    }

    /* ------------------------------------------------------- 5. Машины */

    function verdict(v, days) {
      if (v.sold) return `<span class="fin-badge">продана${v.sold.soldOn ? ` ${esc(day(v.sold.soldOn))}` : ''}</span>`;
      if (!v.revenue && !v.rentedDays) return v.loan ? '<span class="fin-badge fin-badge--bad">простаивает, кредит идёт</span>' : '<span class="fin-badge">простаивает</span>';
      if (v.result < 0) return '<span class="fin-badge fin-badge--bad">в минусе</span>';
      if (days >= 28 && v.rentedDays && v.utilization < 25) return '<span class="fin-badge fin-badge--warn">мало аренды</span>';
      return '<span class="fin-badge fin-badge--ok">окупается</span>';
    }

    function renderLoans(d) {
      if (!ctx.can('access.admin')) return '';
      const count = Object.keys(d.loans || {}).length;
      if (!st.loansOpen) return `<button type="button" class="btn btn--small" data-fin-loans-open>💳 Платежи по кредитам${count ? ` (${count})` : ''}</button>${status(st.loansMsg)}`;
      const text = Object.entries(d.loans || {}).map(([plate, sum]) => `${plate} ${sum}`).join('\n');
      return `
        <form class="fin-loans" data-fin-loans>
          <label class="field"><span>Платёж по кредиту в месяц: госномер и сумма в батах, по строке</span>
            <textarea name="loans" class="search" rows="6" placeholder="5257 12000&#10;7836 9500">${esc(text)}</textarea></label>
          <div class="ac-form__buttons"><button type="submit" class="btn btn--primary btn--small">Сохранить</button>
            <button type="button" class="btn btn--small" data-fin-loans-cancel>Отмена</button></div>
        </form>${status(st.loansMsg)}`;
    }

    function renderVehicles(d) {
      const list = [...d.vehicles].sort((a, b) => {
        if (st.sort === 'util') return b.utilization - a.utilization || b.revenue - a.revenue;
        if (st.sort === 'result') return a.result - b.result;
        return b.revenue - a.revenue || b.rentedDays - a.rentedDays;
      });
      const idle = list.filter((v) => !v.sold && !v.revenue && !v.rentedDays).length;
      const rows = list.map((v) => `
        <tr${v.revenue || v.rentedDays ? '' : ' class="fin-idle"'}>
          <td><b>${esc(v.model || '—')}</b> <span class="plate">#${esc(v.plate)}</span><div>${verdict(v, d.period.days)}</div></td>
          <td class="fin-num" data-label="Выручка">${esc(v.revenue ? num(v.revenue) : '—')}</td>
          <td data-label="Загрузка">${v.rentedDays || !v.revenue ? `<span><span class="fin-bar" title="${v.utilization}%"><span style="width:${v.utilization}%"></span></span><span class="jr-small">${v.utilization}% · ${v.rentedDays} дн.</span></span>` : '<span class="muted jr-small">нет дат в отчётах</span>'}</td>
          <td class="fin-num" data-label="Ремонт">${esc(v.repair ? num(v.repair) : '—')}</td>
          <td class="fin-num" data-label="Прочие расходы">${esc(v.otherCosts ? num(v.otherCosts) : '—')}</td>
          <td class="fin-num" data-label="Кредит">${esc(v.loan ? num(v.loan) : '—')}</td>
          <td class="fin-num" data-label="Итог"><b class="${v.result < 0 ? 'fin-less' : ''}">${esc(num(v.result))}</b></td>
        </tr>`).join('');
      return section('cars', 'Машины: окупаемость', `
        <div class="chips fin-sort">
          <button type="button" class="chip" data-fin-sort="revenue" aria-pressed="${st.sort === 'revenue'}">По выручке</button>
          <button type="button" class="chip" data-fin-sort="util" aria-pressed="${st.sort === 'util'}">По загрузке</button>
          <button type="button" class="chip" data-fin-sort="result" aria-pressed="${st.sort === 'result'}">Сначала убыточные</button>
        </div>
        <p class="muted jr-small">Итог = выручка − ремонт − прочие расходы по машине − кредит за период. Простаивали: ${idle}. Чтобы решать «продавать или нет», смотрите «90 дней» или «С начала года».</p>
        <div class="table-wrap"><table class="fin-table fin-table--wide fin-table--stack">
          <thead><tr><th>Машина</th><th class="fin-num">Выручка</th><th>Загрузка</th><th class="fin-num">Ремонт</th><th class="fin-num">Прочие расходы</th><th class="fin-num">Кредит</th><th class="fin-num">Итог</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        ${renderLoans(d)}`,
      'Выручка и дни аренды — из отчётов группы; ремонт, топливо, мойка, страховка, налог — из кассы WS (колонка «Автомобиль») и сообщений «Expense: … #госномер»; кредит вводит админ.');
    }

    function renderSoldVehicles(d) {
      const list = d.soldVehicles || [];
      if (!list.length) return '';
      const rows = list.map((v) => `
        <tr>
          <td><b>${esc(v.model || '—')}</b> <span class="plate">#${esc(v.plate)}</span>
            <div class="muted jr-small">продана ${esc(v.soldOn ? day(v.soldOn) : '— дата не указана')}${v.first ? ` · в отчётах с ${esc(day(v.first))} по ${esc(day(v.last))}` : ''}</div></td>
          <td class="fin-num" data-label="Выручка">${esc(v.revenue ? num(v.revenue) : '—')}</td>
          <td class="fin-num" data-label="Покупка">${esc(v.purchase ? num(v.purchase) : '—')}</td>
          <td class="fin-num" data-label="Ремонт">${esc(v.repair ? num(v.repair) : '—')}</td>
          <td class="fin-num" data-label="Прочие расходы">${esc(v.other ? num(v.other) : '—')}</td>
          <td class="fin-num" data-label="Цена продажи">${v.price ? esc(num(v.price)) : '<span class="muted">не указана</span>'}</td>
          <td class="fin-num" data-label="Итог"><b class="${v.result < 0 ? 'fin-less' : ''}">${esc(num(v.result))}</b></td>
        </tr>`).join('');
      return section('sold', 'Проданные машины — за всё время', `
        <div class="table-wrap"><table class="fin-table fin-table--wide fin-table--stack">
          <thead><tr><th>Машина</th><th class="fin-num">Выручка</th><th class="fin-num">Покупка</th><th class="fin-num">Ремонт</th><th class="fin-num">Прочие расходы</th><th class="fin-num">Цена продажи</th><th class="fin-num">Итог</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <p class="muted jr-small">Итог = выручка − покупка − ремонт − прочие расходы + цена продажи. Покупка и расходы — по кассе WS (с ${esc(d.cashbook ? day(d.cashbook.coveredFrom) : '—')}): если машину купили раньше, покупки здесь нет. Дату и цену продажи админ вносит во вкладке «Парк» → «Проданные машины».</p>`,
      'Отмечены «Продана» во вкладке «Парк». В парк, календарь, сайт и простой они больше не входят.');
    }

    /* ------------------------------------------------------ 6. Расходы */

    function renderSalary(e) {
      const sal = e.salary;
      if (!sal.ratesSet) return '<p class="muted jr-small">Зарплата по табелю появится, когда в «Доступах» у сотрудников будет заполнена «Ставка в час».</p>';
      const people = sal.people.map((p) => `<tr><td>${esc(p.name)}</td><td class="fin-num">${esc(String(p.hours))} ч</td><td class="fin-num">${esc(num(p.rate))}</td><td class="fin-num"><b>${esc(num(p.sum))}</b></td></tr>`).join('');
      const paid = e.categories.find((c) => c.key === 'salary');
      return `<h4>Зарплата по табелю: часы × ставка</h4>
        ${sal.people.length ? `<div class="table-wrap"><table class="fin-table"><thead><tr><th>Сотрудник</th><th class="fin-num">Часы</th><th class="fin-num">Ставка, ฿/ч</th><th class="fin-num">Начислено</th></tr></thead><tbody>${people}</tbody></table></div>` : ''}
        <p class="muted jr-small">Начислено по табелю: <b>${esc(baht(sal.total))}</b>${paid ? `; выплачено по кассе WS (Salary): ${esc(baht(paid.sum))}` : ''}. Табель — по отметкам «Morning» и «Good night» в группе; ставки — во вкладке «Доступы».</p>`;
    }

    function renderExpenses(d) {
      const e = d.expenses;
      let sources = '';
      if (e.cashTo) sources = `касса WS ${day(e.cashFrom)} — ${dayEnd(e.cashTo)}${e.groupReports ? ` и сообщения «Expense:» вне кассы (${e.groupReports})` : ''}`;
      else if (e.groupReports) sources = `сообщения «Expense:» в группе (${e.groupReports})`;
      const rows = e.categories.map((c) => {
        let src = '';
        const portalWhat = c.key === 'it' ? '«Настройки»' : 'портал (чеки)';
        if (c.portal && (c.ws || c.group)) src = `<div class="muted jr-small">${portalWhat} ${esc(num(c.portal))} · касса и группа ${esc(num(c.ws + c.group))}</div>`;
        else if (c.portal) src = `<div class="muted jr-small">${c.key === 'it' ? 'оплаты сервисов из «Настроек»' : 'чеки из «＋ Операция»'}</div>`;
        else if (c.ws && c.group) src = `<div class="muted jr-small">касса ${esc(num(c.ws))} · группа ${esc(num(c.group))}</div>`;
        else if (c.group) src = '<div class="muted jr-small">из группы</div>';
        return `<tr><td><b>${esc(c.label)}</b>${src}</td><td class="fin-num">${esc(baht(c.sum))}</td><td class="fin-num muted">${esc(num(c.count))}</td></tr>`;
      }).join('');
      const ads = e.categories.some((c) => c.key === 'ads') ? '' : '<p class="muted jr-small">Рекламы в расходах нет — в кассе WS такой статьи нет. Пишите её в группу: «Expense: 2,000 THB Facebook ads».</p>';
      const empty = d.cashbook ? 'За этот период расходов нет ни в кассе WS, ни в группе.' : 'Расходов пока нет: загрузите кассу WS (блок «Сверка») или пишите расходы в группу.';
      const table = e.categories.length ? `
        <div class="table-wrap"><table class="fin-table"><thead><tr><th>Статья</th><th class="fin-num">Сумма</th><th class="fin-num">Записей</th></tr></thead>
          <tbody>${rows}</tbody><tfoot><tr><td><b>Итого расходов</b></td><td class="fin-num"><b>${esc(baht(e.total))}</b></td><td></td></tr></tfoot></table></div>
        ${e.notOperating.length ? `<p class="muted jr-small">Не входят в расходы: ${e.notOperating.map((c) => `${esc(c.label)} — ${esc(baht(c.sum))}`).join(', ')}.</p>` : ''}
        ${ads}` : `<p class="muted">${empty}</p>`;
      const ws = e.ws ? `<p class="muted jr-small">По кассе WS: приход без залогов ${esc(baht(e.ws.income))}, залоги внесено ${esc(baht(e.ws.depositsIn))} / возвращено ${esc(baht(e.ws.depositsOut))}. Перемещения денег (снятие и внесение средств) — не расход.</p>` : '';
      return section('exp', 'Расходы по статьям', `${table}${ws}${renderReceipts()}${renderSalary(e)}
        <p class="muted jr-small">Чтобы со временем отказаться от WS, расходы можно писать в группу одной строкой — статья определится по словам (fuel, repair, wash, taxi, salary, ads, office, insurance, tax):</p>
        ${template('expense')}`, sources ? `Источник: ${esc(sources.replace(/\.$/, ''))}.` : '');
    }

    /** Расходы по чекам из «＋ Операция»: кто, за что, фото чека; ошибочный — удалить */
    function renderReceipts() {
      const r = st.receipts;
      if (!r || !r.items.length) return '';
      const list = st.receiptsAll ? r.items : r.items.slice(0, 15);
      const pay = { cash: 'наличные', transfer: 'перевод', card: 'карта' };
      return `<h4>Чеки из «＋ Операция»</h4><div class="table-wrap"><table class="fin-table fin-table--wide fin-table--stack">
        <thead><tr><th>Дата</th><th>Статья</th><th>Что</th><th class="fin-num">Сумма</th><th>Кто</th><th></th></tr></thead>
        <tbody>${list.map((x) => `<tr>
          <td data-label="Дата">${esc(day(x.date))}</td>
          <td data-label="Статья">${esc(x.label)}${x.plate ? ` <span class="plate">#${esc(x.plate)}</span>` : ''}</td>
          <td data-label="Что">${esc([x.vendor, x.note].filter(Boolean).join(' — ') || '—')}</td>
          <td class="fin-num" data-label="Сумма"><b>${esc(baht(x.thb))}</b>${x.currency !== 'THB' ? `<div class="muted jr-small">${esc(num(x.amount))} ${esc(x.currency)}</div>` : ''}${x.method ? `<div class="muted jr-small">${esc(pay[x.method] || x.method)}</div>` : ''}</td>
          <td data-label="Кто">${esc(x.by || '—')}</td>
          <td>${x.receipt ? `<a class="link jr-small" href="/api/staff/expenses/photo?id=${x.id}" target="_blank" rel="noopener">🧾 чек</a>` : ''}
            ${r.canDelete ? ` <button type="button" class="link jr-small fin-less" data-fin-expdel="${x.id}">удалить</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>${showAll('receiptsAll', r.items.length, 15)}`;
    }

    /* ------------------------------------------------------ 7. Прогноз */

    function renderForecast(d) {
      const f = d.forecast;
      return section('fc', 'Прогноз: брони на 30 дней вперёд', `
        <div class="stats fin-tiles">
          ${tile('Броней', num(f.bookings))}
          ${tile('Ожидается выручки', baht(f.total))}
          ${tile('Уже предоплачено', baht(f.prepaid))}
          ${tile('Осталось получить', baht(f.left), '', 'in')}
        </div>`, 'По броням в группе с датой начала аренды в ближайшие 30 дней.');
    }

    /* ------------------------------------------------- 8. Сверка с WS */

    function renderWsCheck(d) {
      const meta = d.cashbook;
      const uploadBox = ctx.can('access.admin') ? `
        <label class="btn btn--small"><span>📄 ${meta ? 'Загрузить новую кассу (.xlsx)' : 'Загрузить кассу из WS (.xlsx)'}</span><input type="file" accept=".xlsx" data-fin-cashbook hidden></label>
        ${status(st.upload)}` : '';
      const intro = meta
        ? `Касса загружена: ${esc(day(meta.coveredFrom))} — ${esc(day(meta.coveredTo))} (последняя загрузка ${esc(when(meta.at))}). Сверяем там, где есть и касса, и отчёты группы.`
        : 'Загрузите выгрузку «Касса» из WS (Отчёты → Касса → Excel). Портал сравнит её с отчётами группы и покажет расхождения. Повторная загрузка заменяет данные за тот же период.';
      const title = 'Сверка: группа и касса WS';
      const w = d.wsCheck;
      if (!meta) return section('ws', title, uploadBox, intro);
      if (!w) return section('ws', title, `${uploadBox}<p class="muted">За выбранный период нет одновременно и кассы, и отчётов группы (отчёты есть с ${esc(day(d.dataFrom))}).</p>`, intro);
      const cats = w.categories.map((c) => `<tr><td><b>${esc(c.label)}</b></td><td class="fin-num">${esc(num(c.ws))}</td><td class="fin-num">${esc(num(c.group))}</td>${diffCell(c.ws, c.group)}</tr>`).join('');
      const months = w.months.length > 1 ? `
        <h4>По месяцам: аренда, доп. услуги и предоплата</h4>
        <div class="table-wrap"><table class="fin-table"><thead><tr><th>Месяц</th><th class="fin-num">Касса WS</th><th class="fin-num">Группа</th><th class="fin-num">Разница</th></tr></thead>
        <tbody>${w.months.map((m) => {
          const ws = m.ws.rent + m.ws.extras + m.ws.prepaid;
          const gr = m.group.rent + m.group.extras + m.group.prepaid;
          return `<tr><td>${esc(monthName(m.month))}</td><td class="fin-num">${esc(num(ws))}</td><td class="fin-num">${esc(num(gr))}</td>${diffCell(ws, gr)}</tr>`;
        }).join('')}</tbody></table></div>` : '';
      const vehicles = w.vehicles.length ? `
        <h4>Машины с самой большой разницей</h4>
        <div class="table-wrap"><table class="fin-table"><thead><tr><th>Машина</th><th class="fin-num">Касса WS</th><th class="fin-num">Группа</th><th class="fin-num">Разница</th></tr></thead>
        <tbody>${w.vehicles.map((v) => `<tr><td>${esc(v.vehicle || '—')} <span class="plate">#${esc(v.plate)}</span></td><td class="fin-num">${esc(num(v.ws))}</td><td class="fin-num">${esc(num(v.group))}</td>${diffCell(v.ws, v.group)}</tr>`).join('')}</tbody></table></div>` : '';
      const wsOnlyList = (st.wsOnlyAll ? w.wsOnly : w.wsOnly.slice(0, 10)).map((x) => `
        <li><b>${esc(baht(x.sum))}</b> · ${esc(day(x.ts))} · ${esc(x.vehicle || `#${x.plate}`)}${x.booking ? ` · бронь WS № ${esc(x.booking)}` : ''}${x.client ? ` · ${esc(x.client)}` : ''}${journalLink(x.plate, 'журнал по машине')}</li>`).join('');
      const groupOnlyList = (st.groupOnlyAll ? w.groupOnly : w.groupOnly.slice(0, 10)).map((x) => `
        <li><b>${esc(baht(x.sum))}</b> · ${esc(day(x.ts))} · ${esc(KIND[x.kind] || x.kind)} · ${plates(x.plates)} · ${esc(x.author)}${journalLink(x.plates[0])}</li>`).join('');
      return section('ws', title, `${uploadBox}
        <p class="muted jr-small">Окно сверки: ${esc(day(w.from))} — ${esc(dayEnd(w.to))}. «+» — в кассе больше, чем в отчётах группы; «−» — меньше.</p>
        <div class="table-wrap"><table class="fin-table"><thead><tr><th>Статья</th><th class="fin-num">Касса WS</th><th class="fin-num">Группа</th><th class="fin-num">Разница</th></tr></thead><tbody>${cats}</tbody></table></div>
        ${months}
        ${vehicles}
        <h4>В кассе WS есть, в группе нет отчёта: ${esc(num(w.wsOnlyCount))} на ${esc(baht(w.wsOnlySum))}</h4>
        <p class="muted jr-small">Оплата в кассе по броне, а в группе по этой машине нет отчёта ±3 дня — отчёт не написали или в нём нет госномера.</p>
        ${w.wsOnly.length ? `<ul class="fin-list">${wsOnlyList}</ul>${showAll('wsOnlyAll', w.wsOnly.length, 10)}` : '<p class="muted">Нет.</p>'}
        <h4>В группе есть, в кассе WS нет: ${esc(num(w.groupOnlyCount))} на ${esc(baht(w.groupOnlySum))}</h4>
        <p class="muted jr-small">Отчёт с деньгами в группе, а в кассе по этой машине ±3 дня ничего нет — деньги не внесли в WS.</p>
        ${w.groupOnly.length ? `<ul class="fin-list">${groupOnlyList}</ul>${showAll('groupOnlyAll', w.groupOnly.length, 10)}` : '<p class="muted">Нет.</p>'}
        <p class="muted jr-small">Наличные — сверка «группа ↔ касса офиса» в блоке «Касса».</p>`, intro);
    }

    /* -------------------------------------------- ИИ-касса: сообщения группы про деньги (тест) */

    const AI_ACC = { op: 'операционный сейф', dep: 'залоговый сейф' };
    const aiAccount = (k) => (String(k).startsWith('staff:') ? String(k).slice(6) : AI_ACC[k] || k);
    const AI_METHOD = { cash: 'наличные', transfer: 'перевод', card: 'карта' };
    function aiLine(l) {
      if (l.balance) return `<li>📌 остаток — ${esc(l.account)}: <b>${esc(baht(l.thb))}</b></li>`;
      const extra = [l.purpose, AI_METHOD[l.method] || '', l.note].filter(Boolean).join(' · ');
      return `<li>${esc(l.from || '?')} → ${esc(l.to || '?')}: <b>${esc(baht(l.thb))}</b>${extra ? ` <span class="muted">${esc(extra)}</span>` : ''}</li>`;
    }
    function renderAi() {
      const a = st.ai;
      if (!a) return '';
      const b = a.balances;
      const c = (k) => a.counts[k]?.n || 0;
      const usd = Object.values(a.counts).reduce((s, x) => s + (x.usd || 0), 0);
      const blocked = a.blocked === 'ai_no_key' ? 'ИИ выключен: нет ключа ANTHROPIC_API_KEY — сообщения ждут в очереди.'
        : a.blocked === 'ai_limit' ? 'Месячный лимит ИИ исчерпан — сообщения ждут в очереди. Поднять лимит: «Настройки» → «Модель ИИ».' : '';
      const t = b.totals || { op: b.op, dep: b.dep };
      const tiles = `<div class="stats fin-tiles">
        ${tile('Операционные — всего', baht(t.op), `в сейфе офиса ${baht(b.op)}, у сотрудников ${baht(t.op - b.op)}`)}
        ${tile('Залоги — всего', baht(t.dep), `в залоговом сейфе ${baht(b.dep)}, у сотрудников ${baht(t.dep - b.dep)}`)}
      </div>`;
      const cell = (n) => `<td class="fin-num ${n < 0 ? 'fin-less' : ''}">${esc(baht(n))}</td>`;
      const people = b.staff.length ? `<div class="table-wrap"><table class="fin-table"><thead><tr><th>Сотрудник</th><th class="fin-num">Операционные</th><th class="fin-num">Залоги</th><th class="fin-num">Всего на руках</th><th>Последнее движение</th></tr></thead>
        <tbody>${b.staff.map((s) => `<tr><td>${esc(s.name)}</td>${cell(s.op ?? s.thb)}${cell(s.dep ?? 0)}${cell(s.thb)}<td>${esc(when(s.last))}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Пока ни у кого.</p>';
      const checks = b.checks.length ? `<h4>Сверка с «закрытием дня»</h4><ul class="fin-list">${b.checks.map((x) => `<li>${esc(when(x.at))} · ${esc(aiAccount(x.account))}: посчитано ${esc(baht(x.counted))}, в сообщении ${esc(baht(x.reported))} — <b class="${Math.abs(x.diff) >= 1 ? 'fin-less' : 'fin-ok'}">${esc(signed(x.diff))} ฿</b></li>`).join('')}</ul>` : '';
      const STATUS = { queued: '⏳ в очереди', error: '⚠ ИИ не смог разобрать', ignored: '🚫 не учитывается' };
      const list = st.aiAll ? a.entries : a.entries.slice(0, 30);
      const items = list.map((e) => {
        const pills = [STATUS[e.status] ? `<span class="pill">${esc(STATUS[e.status])}</span>` : '', e.status === 'done' && e.relevant === false ? '<span class="pill">не про деньги</span>' : '',
          e.unsure ? '<span class="pill">❓ неуверенно</span>' : ''].join(' ');
        const btns = !a.canEdit ? '' : [
          e.status === 'done' && e.relevant ? `<button type="button" class="btn btn--small" data-fin-aiignore="${esc(e.id)}:1">Неверно — не учитывать</button>` : '',
          e.status === 'ignored' ? `<button type="button" class="btn btn--small" data-fin-aiignore="${esc(e.id)}:0">Учитывать снова</button>` : '',
          e.status !== 'queued' ? `<button type="button" class="btn btn--small" data-fin-airetry="${esc(e.id)}">Распознать заново</button>` : ''
        ].join(' ');
        return `<li class="${e.status === 'ignored' || (e.status === 'done' && e.relevant === false) ? 'fin-ai--off' : ''}">
          <div><span class="muted">${esc(when(e.at))} · ${esc(e.who || '—')}</span> ${pills}</div>
          ${e.summary ? `<div><b>${esc(e.summary)}</b></div>` : ''}
          ${e.lines.length ? `<ul class="fin-ai-moves">${e.lines.map(aiLine).join('')}</ul>` : ''}
          ${e.question ? `<div class="muted jr-small">❓ ${esc(e.question)}</div>` : ''}
          <details class="fin-ai-src"><summary>Сообщение в группе</summary><pre class="fin-template">${esc(e.text)}</pre></details>
          ${btns ? `<div class="fin-disc-btns">${btns}</div>` : ''}
        </li>`;
      }).join('');
      const portalItems = (st.aiPortalAll ? a.portal : a.portal.slice(0, 10)).map((l) => `<li><span class="muted">${esc(when(l.at))}</span> ${aiLine(l).replace(/^<li>|<\/li>$/g, '')}</li>`).join('');
      const intro = 'ИИ читает в рабочей группе сообщения про деньги — сдачу кассы, закрытие дня, расходы, залоги, оплаты, выплаты — и записывает каждое как движение «откуда → куда». '
        + 'Деньги из «＋ Операция» добавляются как есть. Из этого считаются остатки сейфов и наличные у сотрудников — отдельно операционные и залоги (у сотрудника в кармане может быть и то, и другое). «Всего» — сейф офиса плюс деньги на руках. Это тест: в общие цифры «Финансов» пока не входит — копим данные несколько дней.';
      return section('ai', 'ИИ-касса — сообщения группы про деньги (тест)', `
        ${blocked ? `<p class="md-status is-error" role="status">${esc(blocked)}</p>` : ''}
        ${tiles}
        <h4>Наличные у сотрудников</h4>${people}
        ${checks}
        <h4>Журнал за период</h4>
        <p class="muted jr-small">Разобрано ${c('done')} · в очереди ${c('queued')}${c('error') ? ` · не разобрано ${c('error')}` : ''} · не учитывается ${c('ignored')} · расход на ИИ ${usd.toFixed(2)} $ — с ${esc(when(a.since))}</p>
        <ul class="fin-ops">${items || '<li class="muted">За период сообщений про деньги нет.</li>'}</ul>${showAll('aiAll', a.entries.length, 30)}
        ${a.portal.length ? `<h4>Из «＋ Операция» (без ИИ)</h4><ul class="fin-ops">${portalItems}</ul>${showAll('aiPortalAll', a.portal.length, 10)}` : ''}`, intro);
    }

    /* -------------------------------------------- Деньги в отчётах группы */

    function renderOperations(d) {
      if (!d.operations.length) return '';
      const list = st.opsAll ? d.operations : d.operations.slice(0, 30);
      const items = list.map((o) => {
        const parts = [];
        if (o.revenue) parts.push(`начислено ${baht(o.revenue)}`);
        if (o.moneyIn) {
          let how = '';
          if (o.cash) how = ' · наличные';
          else if (o.transfer) how = ' · перевод';
          parts.push(`получено ${baht(o.moneyIn)}${how}`);
        }
        if (o.deposit) parts.push(`залог ${baht(o.deposit)}`);
        if (o.moneyOut) parts.push(`возвращено ${baht(o.moneyOut)}`);
        return `<li>
          <div><span class="jr-kind jr-kind--task">${esc(KIND[o.kind] || o.kind)}</span>${String(o.id).startsWith('pm') ? ' <span class="pill">＋ Операция</span>' : ''} <span class="muted">${esc(when(o.ts))} · ${esc(o.author)}</span> ${plates(o.plates)}</div>
          <div class="fin-op__money">${esc(parts.join(' · '))}${o.receiver ? ` <span class="muted">— принял(а) ${esc(o.receiver)}</span>` : ''}</div>
          ${String(o.id).startsWith('pm') ? (st.receipts?.canDelete ? `<button type="button" class="link jr-small fin-less" data-fin-moneydel="${esc(o.id)}">удалить ошибочную запись</button>` : '') : journalLink(o.plates[0], 'Открыть в журнале')}
        </li>`;
      }).join('');
      return `<section class="card fin-sec"><h3>Деньги в отчётах группы и из «＋ Операция»</h3>
        <ul class="fin-ops">${items}</ul>${showAll('opsAll', d.operations.length, 30)}</section>`;
    }

    function render() {
      const presets = PRESETS.map(([id, label]) => `<button type="button" class="chip" data-fin-preset="${id}" aria-pressed="${st.preset === id}">${esc(label)}</button>`).join('');
      if (st.failed) return `<div class="fin"><div class="chips">${presets}</div><div class="empty">${esc(st.failed)}</div></div>`;
      const d = st.data;
      if (!d) return `<div class="fin"><div class="chips">${presets}</div><div class="empty">Загружаем…</div></div>`;
      const rates = Object.entries(d.rates.rates).filter(([c]) => ['USD', 'EUR', 'RUB', 'GBP'].includes(c)).map(([c, v]) => `${c} ${v}`).join(' · ');
      const nav = SECTIONS.map(([id, label]) => `<button type="button" class="link" data-fin-go="${id}">${esc(label)}</button>`).join('');
      return `
        <div class="fin${st.loading ? ' fin--loading' : ''}">
          <div class="chips">${presets}</div>
          <p class="muted jr-small">${esc(day(d.period.from))} — ${esc(day(d.period.to))} (${d.period.days} дн.) · всё в батах, валюты ${d.rates.approximate ? 'по примерному курсу' : `по курсу на ${esc(when(d.rates.at))}`}: ${esc(rates)}</p>
          <nav class="fin-nav" aria-label="Разделы">${nav}</nav>
          ${renderSummary(d)}
          ${renderDiscounts()}
          ${renderCash(d)}
          ${renderAi()}
          ${renderDeposits(d)}
          ${renderDebts(d)}
          ${renderVehicles(d)}
          ${renderSoldVehicles(d)}
          ${renderExpenses(d)}
          ${renderForecast(d)}
          ${renderWsCheck(d)}
          ${renderOperations(d)}
          <p class="muted jr-small fin-foot">Суммы — из отчётов в группе, как их написали сотрудники; это не бухгалтерия. Странные цифры проверяйте через «в журнале».</p>
        </div>`;
    }

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.fin')) return false;
      const preset = el.closest('[data-fin-preset]');
      if (preset) { st.preset = preset.dataset.finPreset; st.upload = null; st.loansMsg = null; st.discMsg = null; load(); return true; }
      const go = el.closest('[data-fin-go]');
      if (go) { document.getElementById(`fin-${go.dataset.finGo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
      const sort = el.closest('[data-fin-sort]');
      if (sort) { st.sort = sort.dataset.finSort; ctx.rerender(); return true; }
      const all = el.closest('[data-fin-all]');
      if (all) { st[all.dataset.finAll] = true; ctx.rerender(); return true; }
      const dec = el.closest('[data-fin-decide]');
      if (dec) { const [id, ok] = dec.dataset.finDecide.split(':'); dec.disabled = true; decide(Number(id), ok === '1'); return true; }
      const aiIgnore = el.closest('[data-fin-aiignore]');
      if (aiIgnore) {
        const [id, on] = aiIgnore.dataset.finAiignore.split(':');
        aiIgnore.disabled = true;
        send('/finance/ai-log/ignore', JSON.stringify({ id, ignored: on === '1' }), 'application/json').then(load).catch(() => load());
        return true;
      }
      const aiRetry = el.closest('[data-fin-airetry]');
      if (aiRetry) {
        aiRetry.disabled = true;
        send('/finance/ai-log/retry', JSON.stringify({ id: aiRetry.dataset.finAiretry }), 'application/json').then(() => setTimeout(load, 4000)).catch(() => load());
        return true;
      }
      const moneyDel = el.closest('[data-fin-moneydel]');
      if (moneyDel) {
        if (!window.confirm('Удалить эту запись о деньгах? Она пропадёт из «Финансов».')) return true;
        send('/money/delete', JSON.stringify({ id: moneyDel.dataset.finMoneydel }), 'application/json').then(load).catch(() => null);
        return true;
      }
      const expDel = el.closest('[data-fin-expdel]');
      if (expDel) {
        if (!window.confirm('Удалить этот расход? Он пропадёт из «Финансов» и кабинета инвестора.')) return true;
        send('/expenses/delete', JSON.stringify({ id: Number(expDel.dataset.finExpdel) }), 'application/json').then(load).catch(() => null);
        return true;
      }
      const contract = el.closest('[data-fin-contract]');
      if (contract) { ctx.openContract(Number(contract.dataset.finContract)); return true; }
      if (el.closest('[data-fin-loans-open]')) { st.loansOpen = true; st.loansMsg = null; ctx.rerender(); return true; }
      if (el.closest('[data-fin-loans-cancel]')) { st.loansOpen = false; ctx.rerender(); return true; }
      return false;
    }

    function onChange(event) {
      const input = event.target.closest?.('[data-fin-cashbook]');
      if (!input) return false;
      uploadCashbook(input.files?.[0]);
      input.value = '';
      return true;
    }

    function onSubmit(event) {
      const form = event.target.closest?.('[data-fin-loans]');
      if (!form) return false;
      event.preventDefault();
      saveLoans(form.elements.loans.value);
      return true;
    }

    return { load, render, onClick, onChange, onSubmit };
  }

  window.STAFF_FINANCE = { create };
})();
