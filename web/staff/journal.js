/**
 * ============================================================================
 * Вкладка «Журнал»: что пишут в рабочую группу WhatsApp
 * ============================================================================
 *   Лента     — брони, выдачи, возвраты, замены, продления, оплаты, задания;
 *   Проверить — отчёты, которые сервер не смог разобрать до конца;
 *   Табель    — смены по отметкам «Morning» / «Good night»;
 *   Сверка    — статус машины по группе против статуса в WS.Автопрокат;
 *   WhatsApp  — (Admin) подключение номера-наблюдателя, выбор группы,
 *               загрузка истории из «Экспорта чата».
 * Фото, контакты клиентов и исходный текст видят только Admin и Editor.
 * Данные — /api/staff/journal… и /api/staff/wa… (сервер: server/src/journal/).
 * ============================================================================
 */
(() => {
  'use strict';

  const FILTERS = {
    all: '',
    booking: 'booking',
    issue: 'issue',
    return: 'return',
    changed: 'changed,change_task',
    extension: 'extension,reschedule',
    payment: 'payment',
    tasks: 'pickup_task,change_task',
    service: 'service',
    shifts: 'shift_start,shift_end',
    notes: 'note'
  };
  const KIND_TONE = {
    booking: 'reserve', issue: 'rent', return: 'free', changed: 'service', change_task: 'task', pickup_task: 'task',
    extension: 'reserve', reschedule: 'task', payment: 'free', service: 'service', shift_start: 'task', shift_end: 'task', note: 'task', question: 'task'
  };
  const FIX_KINDS = ['booking', 'issue', 'return', 'pickup_task', 'change_task', 'changed', 'reschedule', 'extension', 'payment', 'service', 'shift_start', 'shift_end'];
  const PAGE = 50;

  function create(ctx) {
    const { t, tn, esc } = ctx;
    const st = {
      view: 'feed', filter: 'all', search: '', events: null, counts: null, live: null, observer: null, imported: null,
      loading: false, failed: false, hasMore: false, month: null, timesheet: null, reconcile: null, recAll: false,
      wa: null, waNote: null, importNote: null, fixing: null, open: new Set()
    };

    const num = (n) => new Intl.NumberFormat(ctx.locale()).format(n);
    const plateLink = (plate) => `<button type="button" class="jr-plate" data-jr-plate="${esc(plate)}">#${esc(plate)}</button>`;

    /* ------------------------------------------------------- Загрузка */

    async function load(more = false) {
      st.loading = true;
      st.failed = false;
      ctx.rerender();
      try {
        if (st.view === 'feed' || st.view === 'review') {
          const params = new URLSearchParams({ view: st.view, limit: PAGE });
          if (st.view === 'feed' && FILTERS[st.filter]) params.set('kinds', FILTERS[st.filter]);
          const search = st.search.trim();
          if (/^#?\d{2,5}$/.test(search)) params.set('plate', search.replace('#', ''));
          else if (search) params.set('q', search);
          if (more && st.events?.length) params.set('before', st.events[st.events.length - 1].ts);
          const data = await ctx.api(`/journal?${params}`);
          st.events = more ? [...st.events, ...data.events] : data.events;
          st.hasMore = data.events.length === PAGE;
          Object.assign(st, { counts: data.counts, live: data.live, observer: data.observer, imported: data.imported });
        } else if (st.view === 'timesheet') {
          st.timesheet = await ctx.api(`/journal/timesheet${st.month ? `?month=${st.month}` : ''}`);
          st.month = st.timesheet.month;
        } else if (st.view === 'reconcile') {
          st.reconcile = await ctx.api('/journal/reconcile');
        } else if (st.view === 'wa') {
          st.wa = await ctx.api('/wa');
        }
      } catch (err) {
        if (err.status === 401) return ctx.signedOut(err);
        st.failed = true;
      }
      st.loading = false;
      ctx.rerender();
    }

    /** Разделы журнала по роли: табель и WhatsApp — только админам */
    function allowedViews() {
      return ['feed', 'review', ...(ctx.can('journal.timesheet') ? ['timesheet'] : []), 'reconcile', ...(ctx.can('journal.admin') ? ['wa'] : [])];
    }

    /** Открыть журнал (с фильтром по госномеру — из предупреждения на обзоре) */
    function show(params = {}) {
      // После смены пользователя открытый раздел мог стать недоступен
      if (!allowedViews().includes(st.view)) st.view = 'feed';
      if (params.plate) {
        st.view = 'feed';
        st.filter = 'all';
        st.search = params.plate;
      }
      load();
    }

    /* ------------------------------------------------------- Карточка */

    function moneyChips(money) {
      return (money || []).map((m) => {
        const label = t(`jr.money.${m.key}`) === `jr.money.${m.key}` || m.key === 'other' ? m.label : t(`jr.money.${m.key}`);
        const sum = m.amounts.map((a) => `${num(a.amount)} ${a.currency}`).join(' / ');
        const how = [m.cash && t('jr.cash'), m.transfer && t('jr.transfer')].filter(Boolean).join(', ');
        return `<span class="jr-money"><i>${esc(label)}</i> ${esc(sum)}${how ? ` <small>${esc(how)}</small>` : ''}</span>`;
      }).join('');
    }

    function title(e) {
      const plates = e.plates.filter((p) => p.role !== 'mention');
      const from = plates.find((p) => p.role === 'from');
      const to = plates.find((p) => p.role === 'to');
      const one = (p) => `${p.model ? `${esc(p.model)} ` : ''}${plateLink(p.plate)}`;
      if (from || to) return `${from ? one(from) : '?'} <span class="muted">→</span> ${to ? one(to) : '?'}`;
      const mains = plates.filter((p) => p.role === 'main');
      if (mains.length) return mains.map(one).join(', ');
      if (e.fields.model) return `${esc(e.fields.model)} <span class="muted">${esc(t('jr.noPlate'))}</span>`;
      return '';
    }

    function facts(f) {
      const list = [];
      if (f.from || f.to) {
        const len = f.days ? tn('n.days', f.days) : f.months ? tn('jr.months', f.months) : '';
        list.push(`📅 ${ctx.shortDate(f.from)} → ${ctx.shortDate(f.to)}${len ? ` (${len})` : ''}`);
      }
      if (f.perDay) list.push(`${num(f.perDay.amount)} ${f.perDay.currency}${t('jr.perDay')}`);
      if (f.location) list.push(`📍 ${/^https?:/.test(f.location) ? t('jr.onMap') : f.location}`);
      if (f.time) list.push(`🕑 ${f.time}`);
      if (f.fuel) list.push(`⛽ ${f.fuel.map((x) => `${x.percent}%${x.plate ? ` (#${x.plate})` : ''}`).join(', ')}`);
      if (f.mileage) list.push(`🛣 ${f.mileage.map((x) => `${num(x.km)} ${t('jr.km')}${x.plate ? ` (#${x.plate})` : ''}`).join(', ')}`);
      if (f.helmets != null) list.push(`⛑ ${f.helmets}`);
      if (f.nextPayment) list.push(`${t('jr.nextPayment')} ${ctx.shortDate(f.nextPayment)}`);
      if (f.bookingPaid === false) list.push(`⚠️ ${t('jr.noPrepayment')}`);
      return list.map((x) => `<span>${esc(x)}</span>`).join('');
    }

    function fixForm(e) {
      const change = e.kind === 'changed' || e.kind === 'change_task';
      const from = e.plates.find((p) => p.role === 'from')?.plate || '';
      const to = e.plates.find((p) => p.role === 'to')?.plate || '';
      const main = e.plates.find((p) => p.role === 'main')?.plate || '';
      return `
        <form class="jr-fix" data-jr-fix="${esc(e.id)}">
          <label><span>${esc(t('jr.fix.kind'))}</span>
            <select name="kind">${FIX_KINDS.map((k) => `<option value="${k}"${k === e.kind ? ' selected' : ''}>${esc(t(`jr.kind.${k}`))}</option>`).join('')}</select></label>
          ${change ? `
            <label><span>${esc(t('jr.fix.from'))}</span><input name="plateFrom" inputmode="numeric" value="${esc(from)}" placeholder="7072"></label>
            <label><span>${esc(t('jr.fix.to'))}</span><input name="plateTo" inputmode="numeric" value="${esc(to)}" placeholder="9002"></label>`
            : `<label><span>${esc(t('jr.fix.plate'))}</span><input name="plate" inputmode="numeric" value="${esc(main)}" placeholder="7072"></label>`}
          <div class="jr-fix__buttons">
            <button type="submit" class="btn btn--primary btn--small" name="status" value="ok">${esc(t('jr.fix.save'))}</button>
            <button type="submit" class="btn btn--small" name="status" value="ignored">${esc(t('jr.fix.ignore'))}</button>
          </div>
        </form>`;
    }

    function card(e) {
      const f = e.fields || {};
      const canFix = ctx.can('journal.edit');
      const shift = e.kind === 'shift_start' || e.kind === 'shift_end';
      const notes = [...(f.notes || [])];
      return `
        <article class="card jr-card${e.status === 'review' ? ' jr-card--review' : ''}">
          <div class="jr-card__head">
            <span class="jr-kind jr-kind--${KIND_TONE[e.kind] || 'task'}">${esc(t(`jr.kind.${e.kind}`))}</span>
            <span class="jr-when">${esc(ctx.time(e.ts))}</span>
            <span class="jr-who">${esc(e.author)}</span>
            ${e.edited ? `<span class="jr-edited" title="${esc(e.edited.by)}">✎</span>` : ''}
          </div>
          ${shift ? '' : `<div class="jr-title">${title(e) || `<span class="muted">${esc(t('jr.noPlate'))}</span>`}</div>`}
          ${facts(f) ? `<div class="jr-facts">${facts(f)}</div>` : ''}
          ${f.money ? `<div class="jr-moneys">${moneyChips(f.money)}</div>` : ''}
          ${f.contact ? `<div class="jr-contact">👤 ${esc(f.contact)}</div>` : ''}
          ${f.assignees?.length ? `<div class="jr-assign">👷 ${f.assignees.map(esc).join(', ')}</div>` : ''}
          ${notes.length ? `<div class="jr-notes">${notes.slice(0, 3).map(esc).join('<br>')}</div>` : ''}
          ${e.media?.length ? `<div class="jr-photos">${e.media.map((m) => `
            <a href="/api/staff/journal/media?id=${m.id}" target="_blank" rel="noopener"><img src="/api/staff/journal/media?id=${m.id}" alt="" loading="lazy"></a>`).join('')}</div>`
            : e.mediaCount && !ctx.can('journal.private') ? `<div class="muted jr-small">📷 ${esc(t('jr.photosHidden'))}</div>` : ''}
          ${e.text ? `<details class="jr-raw"${st.open.has(e.id) ? ' open' : ''} data-jr-raw="${esc(e.id)}"><summary>${esc(t('jr.raw'))}</summary><pre>${esc(e.text)}</pre></details>` : ''}
          ${e.status === 'review' ? `<p class="jr-review-note">⚠️ ${esc(t('jr.reviewNote'))}</p>` : ''}
          ${canFix && (e.status === 'review' || st.fixing === e.id) ? fixForm(e)
            : canFix && !shift ? `<button type="button" class="link jr-small" data-jr-fixopen="${esc(e.id)}">${esc(t('jr.fix.open'))}</button>` : ''}
        </article>`;
    }

    /* ---------------------------------------------------------- Лента */

    function renderFeed() {
      const chips = Object.keys(FILTERS)
        .filter((k) => k !== 'notes' || ctx.can('journal.private'))
        .map((k) => `<button type="button" class="chip" data-jr-filter="${k}" aria-pressed="${st.filter === k}">${esc(t(`jr.f.${k}`))}</button>`).join('');
      const events = st.events || [];
      let lastDay = '';
      const list = events.map((e) => {
        const day = ctx.dayLabel(e.ts);
        const head = day !== lastDay ? `<h3 class="jr-day">${esc(day)}</h3>` : '';
        lastDay = day;
        return head + card(e);
      }).join('');
      return `
        <div class="filters">
          <input class="search" type="search" data-jr-search value="${esc(st.search)}" placeholder="${esc(t(ctx.can('journal.private') ? 'jr.searchFull' : 'jr.searchPlate'))}" />
          ${st.view === 'feed' ? `<div class="chips">${chips}</div>` : ''}
        </div>
        ${coverage()}
        ${st.events === null ? `<div class="empty">${esc(t('app.loading'))}</div>`
          : events.length ? `<div class="list">${list}</div>` : `<div class="empty">${esc(t(st.view === 'review' ? 'jr.reviewEmpty' : 'jr.empty'))}</div>`}
        ${st.hasMore ? `<div class="jr-more"><button type="button" class="btn" data-jr-more>${esc(t('jr.more'))}</button></div>` : ''}`;
    }

    /** Откуда данные: история из выгрузки и/или наблюдатель */
    function coverage() {
      const c = st.counts;
      if (!c) return '';
      if (!c.messages) return `<p class="note jr-banner">${esc(t(ctx.can('journal.admin') ? 'jr.noDataAdmin' : 'jr.noData'))}</p>`;
      const parts = [t('jr.coverage', { from: ctx.shortDate(c.from?.slice(0, 10)), to: ctx.shortDate(c.to?.slice(0, 10)), ops: num(c.operations), shifts: num(c.shifts) })];
      parts.push(st.observer?.connected ? t('jr.liveOn', { group: st.observer.groupSubject || '—' }) : t('jr.liveOff'));
      return `<p class="note muted">${esc(parts.join(' · '))}</p>`;
    }

    /* --------------------------------------------------------- Табель */

    function shiftMonth(delta) {
      const [y, m] = (st.month || new Date().toISOString().slice(0, 7)).split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + delta, 1));
      st.month = d.toISOString().slice(0, 7);
      st.timesheet = null;
      load();
    }

    function renderTimesheet() {
      const ts = st.timesheet;
      const monthName = st.month ? new Intl.DateTimeFormat(ctx.locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${st.month}-01T00:00:00Z`)) : '';
      const nav = `
        <div class="jr-month">
          <button type="button" class="icon-btn icon-btn--plain" data-jr-month="-1" aria-label="${esc(t('jr.prevMonth'))}">◀</button>
          <b>${esc(monthName)}</b>
          <button type="button" class="icon-btn icon-btn--plain" data-jr-month="1" aria-label="${esc(t('jr.nextMonth'))}">▶</button>
        </div>`;
      if (!ts) return nav + `<div class="empty">${esc(t('app.loading'))}</div>`;
      if (!ts.people.length) return nav + `<div class="empty">${esc(t('jr.ts.empty'))}</div>`;
      const rows = ts.people.map((p) => {
        const days = Object.entries(p.days).sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => {
          const wd = ctx.weekday(date);
          const span = `${d.start ? ctx.time(d.start).slice(-5) : '—'} → ${d.end ? ctx.time(d.end).slice(-5) : '—'}`;
          return `<li><span>${esc(`${wd} ${ctx.shortDate(date)}`)}</span><span>${esc(span)}</span><b>${d.hours != null ? esc(`${num(d.hours)} ${t('jr.h')}`) : `<span class="warn">${esc(t(d.start ? 'jr.ts.noEnd' : 'jr.ts.noStart'))}</span>`}</b></li>`;
        }).join('');
        return `
          <details class="card jr-person">
            <summary>
              <b>${esc(p.name)}</b>
              <span>${esc(tn('jr.ts.days', p.daysMarked))}</span>
              <span>${esc(tn('jr.ts.full', p.daysFull))}</span>
              <span><b>${esc(`${num(p.hours)} ${t('jr.h')}`)}</b></span>
            </summary>
            <ul class="jr-shifts">${days}</ul>
          </details>`;
      }).join('');
      return `${nav}<p class="note muted">${esc(t('jr.ts.note'))}</p><div class="list">${rows}</div>`;
    }

    /* ---------------------------------------------------------- Сверка */

    function renderReconcile() {
      const r = st.reconcile;
      if (!r) return `<div class="empty">${esc(t('app.loading'))}</div>`;
      if (!r.available) return `<div class="empty">${esc(t('jr.rec.noWs'))}</div>`;
      const issues = r.items.filter((i) => i.state === 'mismatch' || i.state === 'waiting');
      const shown = st.recAll ? r.items : issues;
      const lag = r.lag && r.lag.events
        ? `<p class="note">${esc(t('jr.rec.lag', { median: r.lag.medianHours ?? '—', max: r.lag.maxHours ?? '—', entered: r.lag.entered, events: r.lag.events }))}${r.lag.pending ? ` · <span class="warn">${esc(t('jr.rec.pending', { n: r.lag.pending }))}</span>` : ''}</p>` : '';
      const rows = shown.map((i) => `
        <div class="card jr-rec jr-rec--${i.state}">
          <div class="jr-rec__car"><b>${esc(i.model || '—')}</b> ${plateLink(i.plate)}</div>
          <div class="jr-rec__ws"><span class="muted">WS</span> <span class="pill pill--${esc(i.ws.status)}">${esc(t(`status.${i.ws.status}`))}</span></div>
          <div class="jr-rec__group"><span class="muted">${esc(t('jr.rec.group'))}</span>
            ${i.group ? `<span class="pill pill--${i.group.status === 'reserve' ? 'reserve' : i.group.status}">${esc(t(`jr.gs.${i.group.status}`))}</span>
              <span class="muted jr-small">${esc(`${t(`jr.kind.${i.group.kind}`)} · ${ctx.dateTime(i.group.at)} · ${i.group.who}`)}</span>` : `<span class="muted">${esc(t('jr.rec.noReports'))}</span>`}
          </div>
          <div class="jr-rec__state">${esc(t(`jr.rs.${i.state}`))}${i.reason === 'ws_only' ? ` — ${esc(t('jr.rec.wsOnly'))}` : ''}</div>
        </div>`).join('');
      return `
        ${r.live ? `<p class="note muted">${esc(t('jr.rec.liveSince', { time: ctx.dateTime(r.live) }))}</p>` : `<p class="note jr-banner">${esc(t('jr.rec.notLive'))}</p>`}
        ${lag}
        <div class="chips">
          <button type="button" class="chip" data-jr-recall="0" aria-pressed="${!st.recAll}">${esc(t('jr.rec.issues'))} · ${issues.length}</button>
          <button type="button" class="chip" data-jr-recall="1" aria-pressed="${st.recAll}">${esc(t('jr.rec.all'))} · ${r.items.length}</button>
        </div>
        ${shown.length ? `<div class="list jr-recs">${rows}</div>` : `<div class="empty">✅ ${esc(t('jr.rec.none'))}</div>`}`;
    }

    /* --------------------------------------------------- WhatsApp (Admin) */

    function renderWa() {
      const w = st.wa;
      const importBlock = `
        <section class="card jr-wa">
          <h3>${esc(t('jr.imp.title'))}</h3>
          <p class="muted">${esc(t('jr.imp.how'))}</p>
          ${st.imported ? `<p class="note">${esc(t('jr.imp.last', { time: ctx.dateTime(st.imported.at), added: st.imported.added, from: ctx.shortDate(st.imported.from?.slice(0, 10)), to: ctx.shortDate(st.imported.to?.slice(0, 10)) }))}</p>` : ''}
          <label class="btn"><span>${esc(t('jr.imp.choose'))}</span><input type="file" accept=".txt,text/plain" data-jr-import hidden></label>
          ${st.importNote ? `<p class="md-status is-${st.importNote.kind}" role="status">${esc(st.importNote.text)}</p>` : ''}
        </section>`;
      if (!w) return `<div class="empty">${esc(t('app.loading'))}</div>${importBlock}`;
      let body;
      if (!w.reachable) {
        body = `<p class="warn">${esc(t(w.error === 'observer_not_configured' ? 'jr.wa.noSecret' : 'jr.wa.unreachable'))}</p>`;
      } else if (w.status === 'connected') {
        const groups = (w.groups || []).map((g) => `<option value="${esc(g.id)}"${g.id === w.groupId ? ' selected' : ''}>${esc(`${g.subject} (${g.size})`)}</option>`).join('');
        body = `
          <p>✅ ${esc(t('jr.wa.connected', { me: w.me?.id ? `+${w.me.id}` : '—' }))}</p>
          <form class="jr-wa__group" data-jr-group>
            <label class="field"><span>${esc(t('jr.wa.group'))}</span>
              <select name="groupId" class="search"><option value="">${esc(t('jr.wa.chooseGroup'))}</option>${groups}</select></label>
            <button type="submit" class="btn btn--primary">${esc(t('jr.wa.watch'))}</button>
          </form>
          ${w.groupId ? `<p class="note">👀 ${esc(t('jr.wa.watching', { group: w.groupSubject || '—' }))}${w.lastMessageAt ? ` · ${esc(t('jr.wa.lastMsg', { time: ctx.dateTime(w.lastMessageAt) }))}` : ''}</p>` : `<p class="warn">${esc(t('jr.wa.pickGroup'))}</p>`}
          <p class="muted jr-small">${esc(t('jr.wa.readOnly'))}</p>
          <button type="button" class="btn btn--small" data-jr-logout>${esc(t('jr.wa.logout'))}</button>`;
      } else if (w.status === 'qr') {
        body = `
          <ol class="jr-steps"><li>${esc(t('jr.wa.step1'))}</li><li>${esc(t('jr.wa.step2'))}</li><li>${esc(t('jr.wa.step3'))}</li></ol>
          ${w.qr ? `<img class="jr-qr" src="${esc(w.qr)}" alt="QR">` : ''}
          <p class="muted jr-small">${esc(t('jr.wa.qrRefresh'))}</p>
          <form class="jr-wa__pair" data-jr-pair>
            <label class="field"><span>${esc(t('jr.wa.pairLabel'))}</span><input name="phone" inputmode="tel" placeholder="+66 6x xxx xxxx"></label>
            <button type="submit" class="btn">${esc(t('jr.wa.pair'))}</button>
          </form>
          ${w.pairingCode ? `<p class="jr-code">${esc(w.pairingCode)}</p><p class="muted jr-small">${esc(t('jr.wa.pairHow'))}</p>` : ''}`;
      } else {
        body = `<p>${esc(t(`jr.wa.st.${w.status}`) === `jr.wa.st.${w.status}` ? w.status : t(`jr.wa.st.${w.status}`))}</p>`;
      }
      return `
        <section class="card jr-wa">
          <h3>${esc(t('jr.wa.title'))}</h3>
          ${body}
          ${st.waNote ? `<p class="md-status is-${st.waNote.kind}" role="status">${esc(st.waNote.text)}</p>` : ''}
        </section>
        ${importBlock}`;
    }

    /* ---------------------------------------------------------- Всё */

    function render() {
      const reviewN = st.counts?.review || 0;
      const views = allowedViews();
      const tabs = views.map((v) => `<button type="button" class="chip" data-jr-view="${v}" aria-pressed="${st.view === v}">${esc(t(`jr.v.${v}`))}${v === 'review' && reviewN ? ` · ${reviewN}` : ''}</button>`).join('');
      let body = '';
      if (st.failed) body = `<div class="empty">${esc(t('app.loadFailed'))}</div>`;
      else if (st.view === 'feed' || st.view === 'review') body = renderFeed();
      else if (st.view === 'timesheet') body = renderTimesheet();
      else if (st.view === 'reconcile') body = renderReconcile();
      else if (st.view === 'wa') body = renderWa();
      return `<div id="journal" class="jr"><div class="chips jr-views">${tabs}</div>${body}</div>`;
    }

    /* -------------------------------------------------------- События */

    function onClick(event) {
      const el = event.target;
      if (!el.closest('#journal')) return false;
      const view = el.closest('[data-jr-view]');
      if (view) {
        st.view = allowedViews().includes(view.dataset.jrView) ? view.dataset.jrView : 'feed';
        st.events = st.view === 'feed' || st.view === 'review' ? null : st.events;
        load();
        return true;
      }
      const filter = el.closest('[data-jr-filter]');
      if (filter) { st.filter = filter.dataset.jrFilter; st.events = null; load(); return true; }
      const plate = el.closest('[data-jr-plate]');
      if (plate) { st.view = 'feed'; st.filter = 'all'; st.search = plate.dataset.jrPlate; st.events = null; load(); window.scrollTo(0, 0); return true; }
      if (el.closest('[data-jr-more]')) { load(true); return true; }
      const month = el.closest('[data-jr-month]');
      if (month) { shiftMonth(Number(month.dataset.jrMonth)); return true; }
      const recAll = el.closest('[data-jr-recall]');
      if (recAll) { st.recAll = recAll.dataset.jrRecall === '1'; ctx.rerender(); return true; }
      const fixOpen = el.closest('[data-jr-fixopen]');
      if (fixOpen) { st.fixing = fixOpen.dataset.jrFixopen; ctx.rerender(); return true; }
      if (el.closest('[data-jr-logout]')) {
        if (window.confirm(t('jr.wa.logoutConfirm'))) waAction('/wa/logout', {});
        return true;
      }
      const raw = el.closest('[data-jr-raw] summary');
      if (raw) {
        const id = raw.parentElement.dataset.jrRaw;
        if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
        return false;
      }
      return false;
    }

    let searchTimer = null;
    function onInput(event) {
      if (!event.target.matches('[data-jr-search]')) return false;
      st.search = event.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st.events = null; load(); }, 400);
      return true;
    }

    async function waAction(path, body, okText) {
      st.waNote = null;
      try {
        await ctx.api(path, { body });
        if (okText) st.waNote = { kind: 'ok', text: okText };
      } catch (err) {
        st.waNote = { kind: 'error', text: ctx.errorText(err) };
      }
      st.wa = await ctx.api('/wa').catch(() => st.wa);
      ctx.rerender();
    }

    function onSubmit(event) {
      const form = event.target;
      if (!form.closest('#journal')) return false;
      event.preventDefault();
      if (form.matches('[data-jr-fix]')) {
        const status = event.submitter?.value === 'ignored' ? 'ignored' : 'ok';
        const body = { id: form.dataset.jrFix, kind: form.elements.kind.value, status };
        for (const name of ['plate', 'plateFrom', 'plateTo']) if (form.elements[name]) body[name] = form.elements[name].value;
        ctx.api('/journal/fix', { body }).then(() => { st.fixing = null; load(); })
          .catch((err) => window.alert(ctx.errorText(err)));
        return true;
      }
      if (form.matches('[data-jr-group]')) {
        if (form.elements.groupId.value) waAction('/wa/config', { groupId: form.elements.groupId.value }, t('jr.wa.saved'));
        return true;
      }
      if (form.matches('[data-jr-pair]')) {
        waAction('/wa/pair', { phone: form.elements.phone.value });
        return true;
      }
      return true;
    }

    async function onChange(event) {
      const input = event.target;
      if (!input.matches('[data-jr-import]') || !input.files?.[0]) return false;
      const file = input.files[0];
      st.importNote = { kind: 'ok', text: t('jr.imp.loading') };
      ctx.rerender();
      try {
        const text = await file.text();
        const r = await ctx.api('/journal/import', { body: { text } });
        st.importNote = { kind: 'ok', text: t('jr.imp.done', { added: num(r.added), ops: num(r.operations), skipped: num(r.skipped) }) };
        st.imported = { at: new Date().toISOString(), added: r.added, from: r.from, to: r.to };
      } catch (err) {
        st.importNote = { kind: 'error', text: ctx.errorText(err) };
      }
      ctx.rerender();
      return true;
    }

    /** Пока открыт WhatsApp-экран с QR-кодом — обновляем его (код меняется каждые ~20 секунд) */
    function tick() {
      if (st.view === 'wa' && st.wa && st.wa.status !== 'connected' && !document.hidden) {
        ctx.api('/wa').then((w) => { st.wa = w; ctx.rerender(); }).catch(() => {});
      }
    }

    return { render, show, load, onClick, onInput, onSubmit, onChange, tick, get view() { return st.view; } };
  }

  window.STAFF_JOURNAL = { create };
})();
