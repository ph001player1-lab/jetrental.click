/*
 * Вкладка «Кабинет» агента (и партнёра): свои ссылки с QR-кодами, свои заявки
 * и их путь (новая → взята → бронь → аренда), комиссия (начислено / выплачено /
 * к выплате), цены для клиентов и форма «＋ Заявка». Админ и владелец открывают
 * кабинет любого источника из «Маркетинга» (просмотр) и записывают выплаты.
 * Тексты — i18n (cab.*).
 */
(function () {
  'use strict';

  const TYPES = ['scooter', 'motorcycle', 'car'];
  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };
  const STAGES = ['new', 'taken', 'booked', 'rental'];
  const LINKS = ['site', 'tg', 'wa'];

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = {
      data: null, failed: null, source: null, season: null, qr: null, msg: null, payMsg: null, sending: false,
      form: { name: '', phone: '', type: '', model: '', from: '', to: '', comment: '' },
      pay: { amount: '', date: '', method: '', note: '' }
    };
    // Ноль — «0 ฿», а не прочерк: «к выплате 0» — это ответ, а не «нет данных»
    const money = (n) => (Number(n) ? ctx.money(n) : '0 ฿');
    const dm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '?');
    const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '—');

    /* ------------------------------------------------------------ Данные */

    /** source — id источника для просмотра (админ из «Маркетинга»), иначе свой кабинет */
    async function load(source = st.source) {
      st.source = source || null;
      try {
        const params = new URLSearchParams({ lang: ctx.lang() });
        if (st.source) params.set('source', st.source);
        st.data = await api(`/agent?${params}`);
        st.failed = null;
        const p = st.data.prices;
        if (p && (!st.season || !p.seasons.some((s) => String(s.id) === String(st.season)))) st.season = p.currentSeason ?? p.seasons[0]?.id ?? null;
      } catch (err) {
        st.failed = err.code === 'no_cabinet' ? t('cab.noCabinet') : t('cab.loadFailed');
      }
      ctx.rerender();
    }

    /* ------------------------------------------------------------ QR-код */

    function qrOf(text) {
      const qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr;
    }

    function qrSvg(text) {
      try {
        return qrOf(text).createSvgTag({ cellSize: 6, margin: 4, scalable: true });
      } catch {
        return '';
      }
    }

    /** PNG для печати: 1024 px, белое поле вокруг */
    function downloadQr(text, name) {
      const qr = qrOf(text);
      const n = qr.getModuleCount();
      const margin = 4;
      const cell = Math.floor(1024 / (n + margin * 2));
      const size = cell * (n + margin * 2);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, size, size);
      g.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${name}.png`;
      document.body.append(a);
      a.click();
      a.remove();
    }

    /* ------------------------------------------------------------ Экран */

    function render() {
      if (st.failed) return `<div class="cab"><div class="card empty">${esc(st.failed)}</div></div>`;
      const d = st.data;
      if (!d) return `<div class="cab"><div class="card empty">${esc(t('app.loading'))}</div></div>`;
      return `<div class="cab">
        ${renderHead(d)}
        ${renderStats(d)}
        <div class="cab-grid">
          <div class="cab-col">
            ${renderRequests(d)}
            ${renderMoney(d)}
          </div>
          <div class="cab-col">
            ${renderLinks(d)}
            ${d.canRequest ? renderForm(d) : ''}
            ${renderPrices(d)}
          </div>
        </div>
      </div>`;
    }

    function renderHead(d) {
      const preview = d.preview ? `
        <div class="cab-preview" role="status">
          <span>👁 ${esc(t('cab.preview'))}${d.agents?.length ? ` · ${esc(d.agents.map((a) => a.name).join(', '))}` : ` · ${esc(t('cab.noAgents'))}`}</span>
          <button type="button" class="btn btn--small" data-cab-close>✕ ${esc(t('cab.close'))}</button>
        </div>` : '';
      const pct = d.commission.percent ? t('cab.percent', { n: d.commission.percent }) : t('cab.noPercent');
      return `${preview}
        <header class="cab-head">
          <h2>💼 ${esc(d.source.name)}</h2>
          <span class="pill cab-pct">${esc(pct)}</span>
        </header>`;
    }

    function renderStats(d) {
      const c = d.commission;
      const tile = (label, value, cls = '') => `<div class="card cab-stat ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
      return `<div class="cab-stats">
        ${tile(t('cab.balance'), money(c.balance), 'cab-stat--main')}
        ${tile(t('cab.accrued'), money(c.accrued))}
        ${tile(t('cab.paid'), money(c.paid))}
        ${tile(t('cab.pending'), money(c.pending))}
        ${tile(t('cab.requests'), String(d.requests.length))}
        ${tile(t('cab.visits30'), String(d.visits.days30))}
      </div>`;
    }

    function renderLinks(d) {
      const rows = LINKS.filter((k) => d.links[k]).map((k) => {
        const url = d.links[k];
        const open = st.qr === k;
        return `
          <li class="cab-link">
            <div class="cab-link__head"><b>${esc(t(`cab.link.${k}`))}</b></div>
            <input class="search cab-link__url" readonly value="${esc(url)}" aria-label="${esc(t(`cab.link.${k}`))}" data-cab-url>
            <div class="cab-link__btns">
              <button type="button" class="btn btn--small" data-cab-copy="${k}">${esc(t('cab.copy'))}</button>
              <button type="button" class="btn btn--small" data-cab-qr="${k}" aria-expanded="${open}">${esc(t(open ? 'cab.qrHide' : 'cab.qr'))}</button>
              <button type="button" class="btn btn--small" data-cab-qrdl="${k}">${esc(t('cab.qrDownload'))}</button>
            </div>
            ${open ? `<div class="cab-qr">${qrSvg(url)}</div>` : ''}
          </li>`;
      }).join('');
      return `
        <section class="card cab-sec" aria-labelledby="cab-links">
          <h3 id="cab-links">🔗 ${esc(t('cab.links'))}</h3>
          <p class="cab-tip">${esc(t('cab.linksTip'))}</p>
          <ul class="cab-links">${rows}</ul>
          <p class="cab-tip">${esc(t('cab.visits', { d30: d.visits.days30, total: d.visits.total }))}</p>
        </section>`;
    }

    function renderForm(d) {
      const f = st.form;
      const models = (d.prices?.models || []).filter((m) => !f.type || m.type === f.type).map((m) => `<option value="${esc(m.model)}"></option>`).join('');
      return `
        <section class="card cab-sec" aria-labelledby="cab-new">
          <h3 id="cab-new">＋ ${esc(t('cab.newRequest'))}</h3>
          <p class="cab-tip">${esc(t('cab.newTip'))}</p>
          <form class="cab-form" data-cab-form novalidate>
            <label class="field"><span>${esc(t('cab.f.name'))} *</span><input class="search" name="name" maxlength="80" autocomplete="off" value="${esc(f.name)}"></label>
            <label class="field"><span>${esc(t('cab.f.phone'))} *</span><input class="search" name="phone" inputmode="tel" maxlength="30" autocomplete="off" placeholder="+66 …" value="${esc(f.phone)}"></label>
            <label class="field"><span>${esc(t('cab.f.type'))}</span><select class="search" name="type">
              <option value="">—</option>
              ${TYPES.map((x) => `<option value="${x}"${f.type === x ? ' selected' : ''}>${TYPE_ICON[x]} ${esc(t(`type.${x}`))}</option>`).join('')}
            </select></label>
            <label class="field"><span>${esc(t('cab.f.model'))}</span><input class="search" name="model" list="cab-models" maxlength="80" autocomplete="off" value="${esc(f.model)}"></label>
            <datalist id="cab-models">${models}</datalist>
            <div class="cab-form__dates">
              <label class="field"><span>${esc(t('cab.f.from'))}</span><input class="search" type="date" name="from" min="${ctx.today()}" value="${esc(f.from)}"></label>
              <label class="field"><span>${esc(t('cab.f.to'))}</span><input class="search" type="date" name="to" min="${esc(f.from || ctx.today())}" value="${esc(f.to)}"></label>
            </div>
            <label class="field cab-form__wide"><span>${esc(t('cab.f.comment'))}</span><textarea class="search" name="comment" rows="3" maxlength="1000">${esc(f.comment)}</textarea></label>
            <div class="cab-form__wide cab-actions">
              <button type="submit" class="btn btn--primary" ${st.sending ? 'disabled' : ''}>${esc(t(st.sending ? 'cab.sending' : 'cab.send'))}</button>
              ${st.msg ? `<p class="cab-msg cab-msg--${st.msg.kind}" role="status">${esc(st.msg.text)}</p>` : ''}
            </div>
          </form>
        </section>`;
    }

    function stagePill(r) {
      const label = r.stage === 'taken' && r.takenBy ? t('cab.stage.takenBy', { name: r.takenBy }) : t(`cab.stage.${r.stage}`);
      return `<span class="pill cab-stage cab-stage--${r.stage}">${esc(label)}</span>`;
    }

    function renderRequests(d) {
      const list = d.requests.map((r) => {
        const what = [r.vehicleType ? `${TYPE_ICON[r.vehicleType] || ''} ${t(`type.${r.vehicleType}`)}` : '', r.model].filter(Boolean).join(' · ');
        const dates = r.dateFrom ? `📅 ${dm(r.dateFrom)}–${dm(r.dateTo)}` : '';
        const steps = STAGES.map((s, i) => `<li class="${STAGES.indexOf(r.stage) >= i ? 'is-done' : ''}">${esc(t(`cab.stage.${s}`))}</li>`).join('');
        const rentals = r.rentals.map((x) => `
          <li>
            <span>${esc(x.model || '—')} · ${dm(x.from)}–${dm(x.to)}</span>
            <span>${esc(t('cab.rentalSum', { sum: money(x.sum) }))}</span>
            <b>${esc(t('cab.commissionOf', { sum: money(x.commission) }))}</b>
            <span class="pill ${x.accrued ? 'cab-acc--yes' : 'cab-acc--wait'}">${esc(t(x.accrued ? 'cab.accruedYes' : x.ended ? 'cab.accruedSoon' : 'cab.accruedWait'))}</span>
          </li>`).join('');
        return `
          <article class="card cab-req">
            <header class="cab-req__head">
              <b>#${r.id} · ${esc(r.clientName || '—')}</b>
              ${r.phoneTail ? `<span class="cab-muted">📞 •••• ${esc(r.phoneTail)}</span>` : ''}
              ${stagePill(r)}
            </header>
            <p class="cab-req__what">${esc([what, dates].filter(Boolean).join(' · ') || '—')}</p>
            <ol class="cab-steps" aria-label="${esc(t('cab.path'))}">${steps}</ol>
            ${rentals ? `<ul class="cab-rentals">${rentals}</ul>` : ''}
            <p class="cab-muted cab-req__at">${esc(t('cab.created', { at: ctx.dateTime(r.createdAt) }))}${r.channel === 'agent' ? ` · ${esc(t('cab.byYou'))}` : ''}</p>
          </article>`;
      }).join('');
      return `
        <section class="cab-sec cab-sec--plain" aria-labelledby="cab-reqs">
          <h3 class="section-title" id="cab-reqs">${esc(t('cab.myRequests'))}</h3>
          ${list ? `<div class="list">${list}</div>` : `<div class="card empty">${esc(t('cab.noRequests'))}</div>`}
        </section>`;
    }

    function renderMoney(d) {
      const acc = d.accruals.map((a) => `
        <tr><td>${dm(a.from)}–${dm(a.to)}</td><td>${esc(a.model || '—')}</td><td class="num">${esc(money(a.sum))}</td><td class="num cab-pctcol">${a.percent}%</td><td class="num"><b>${esc(money(a.amount))}</b></td></tr>`).join('');
      const pays = d.payouts.map((p) => `
        <li>
          <b>${esc(money(p.amount))}</b> · ${esc(dmy(p.date))}${p.method ? ` · ${esc(p.method)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}
          ${d.canPay ? `<button type="button" class="link cab-danger" data-cab-paydel="${p.id}">${esc(t('cab.payDelete'))}</button>` : ''}
        </li>`).join('');
      const pay = st.pay;
      const payForm = d.canPay ? `
        <form class="cab-pay" data-cab-pay novalidate>
          <h4>${esc(t('cab.payTitle'))}</h4>
          <div class="cab-pay__grid">
            <label class="field"><span>${esc(t('cab.p.amount'))}</span><input class="search" name="amount" inputmode="numeric" value="${esc(pay.amount || (d.commission.balance > 0 ? String(d.commission.balance) : ''))}"></label>
            <label class="field"><span>${esc(t('cab.p.date'))}</span><input class="search" type="date" name="date" value="${esc(pay.date || ctx.today())}"></label>
            <label class="field"><span>${esc(t('cab.p.method'))}</span><input class="search" name="method" maxlength="60" placeholder="${esc(t('cab.p.methodPh'))}" value="${esc(pay.method)}"></label>
            <label class="field"><span>${esc(t('cab.p.note'))}</span><input class="search" name="note" maxlength="300" value="${esc(pay.note)}"></label>
          </div>
          <div class="cab-actions">
            <button type="submit" class="btn btn--primary btn--small">${esc(t('cab.paySave'))}</button>
            ${st.payMsg ? `<p class="cab-msg cab-msg--${st.payMsg.kind}" role="status">${esc(st.payMsg.text)}</p>` : ''}
          </div>
        </form>` : '';
      return `
        <section class="card cab-sec" aria-labelledby="cab-money">
          <h3 id="cab-money">💰 ${esc(t('cab.money'))}</h3>
          <p class="cab-tip">${esc(t('cab.moneyTip'))}</p>
          <h4>${esc(t('cab.accruals'))}</h4>
          ${acc ? `<div class="cab-table"><table><thead><tr><th>${esc(t('cab.th.dates'))}</th><th>${esc(t('cab.th.model'))}</th><th class="num">${esc(t('cab.th.sum'))}</th><th class="num cab-pctcol">%</th><th class="num">${esc(t('cab.th.commission'))}</th></tr></thead><tbody>${acc}</tbody></table></div>`
            : `<p class="cab-muted">${esc(t('cab.noAccruals'))}</p>`}
          <h4>${esc(t('cab.payouts'))}</h4>
          ${pays ? `<ul class="cab-payouts">${pays}</ul>` : `<p class="cab-muted">${esc(t('cab.noPayouts'))}</p>`}
          ${payForm}
        </section>`;
    }

    function renderPrices(d) {
      const p = d.prices;
      if (!p || !p.models.length) return '';
      const season = p.seasons.find((s) => String(s.id) === String(st.season)) || p.seasons[0];
      const chips = p.seasons.map((s) => `<button type="button" class="chip" data-cab-season="${s.id}" aria-pressed="${s.id === season.id}">
        <span class="cab-dot" style="background:${esc(s.color || '#888')}"></span>${esc(ctx.seasonName(s.name))}${s.id === p.currentSeason ? ` · ${esc(t('cab.now'))}` : ''}</button>`).join('');
      const periods = season.periods.map((x) => `${x.from.slice(3)}.${x.from.slice(0, 2)}–${x.to.slice(3)}.${x.to.slice(0, 2)}`).join(', ');
      const rows = TYPES.map((type) => {
        const list = p.models.filter((m) => (m.type || 'car') === type && m.rates[season.id]);
        if (!list.length) return '';
        return `<tr class="cab-prices__type"><th colspan="${p.tiers.length + 2}">${TYPE_ICON[type]} ${esc(t(`types.${type}`))}</th></tr>` + list.map((m) => {
          const r = m.rates[season.id];
          return `<tr><th scope="row">${esc(m.model)}</th>${r.tiers.map((v) => `<td class="num">${v ? esc(money(v)) : '—'}</td>`).join('')}<td class="num">${r.deposit ? esc(money(r.deposit)) : '—'}</td></tr>`;
        }).join('');
      }).join('');
      return `
        <section class="card cab-sec" aria-labelledby="cab-prices">
          <h3 id="cab-prices">🏷 ${esc(t('cab.prices'))}</h3>
          <div class="chips cab-seasons">${chips}</div>
          <p class="cab-tip">${esc(t('cab.pricesTip', { periods }))}</p>
          <div class="cab-table"><table class="cab-prices">
            <thead><tr><th>${esc(t('cab.th.model'))}</th>${p.tiers.map((x) => `<th class="num">${esc(x)} ${esc(t('unit.d'))}</th>`).join('')}<th class="num">${esc(t('cab.th.deposit'))}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </section>`;
    }

    /* ------------------------------------------------------- Действия */

    const ERR = {
      name_required: 'cab.err.name', invalid_phone: 'cab.err.phone', invalid_dates: 'cab.err.dates', date_past: 'cab.err.past',
      date_order: 'cab.err.order', too_long: 'cab.err.long', message_required: 'cab.err.empty', too_many_requests: 'cab.err.many'
    };

    async function send() {
      st.sending = true;
      st.msg = null;
      ctx.rerender();
      try {
        const { id } = await api(`/agent/request`, { body: { ...st.form } });
        st.form = { name: '', phone: '', type: '', model: '', from: '', to: '', comment: '' };
        st.msg = { kind: 'ok', text: t('cab.sent', { id }) };
        st.sending = false;
        await load();
        return;
      } catch (err) {
        st.msg = { kind: 'error', text: t(ERR[err.code] || 'cab.err.failed') };
      }
      st.sending = false;
      ctx.rerender();
    }

    async function savePayout() {
      try {
        await api('/agent/payout', { body: { sourceId: st.data.source.id, ...st.pay } });
        st.pay = { amount: '', date: '', method: '', note: '' };
        st.payMsg = { kind: 'ok', text: t('cab.paySaved') };
        await load();
      } catch (err) {
        st.payMsg = { kind: 'error', text: t(err.code === 'bad_amount' ? 'cab.err.amount' : 'cab.err.failed') };
        ctx.rerender();
      }
    }

    async function deletePayout(id) {
      if (!window.confirm(t('cab.payDeleteConfirm'))) return;
      try {
        await api('/agent/payout/delete', { body: { id } });
        await load();
      } catch {
        st.payMsg = { kind: 'error', text: t('cab.err.failed') };
        ctx.rerender();
      }
    }

    async function copy(k, button) {
      const url = st.data.links[k];
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const input = button.closest('.cab-link')?.querySelector('[data-cab-url]');
        input?.select();
        document.execCommand?.('copy');
      }
      button.textContent = t('cab.copied');
      setTimeout(() => { if (button.isConnected) button.textContent = t('cab.copy'); }, 1500);
    }

    /* ------------------------------------------------------- События */

    function onClick(event) {
      const el = event.target.closest('[data-cab-copy], [data-cab-qr], [data-cab-qrdl], [data-cab-season], [data-cab-paydel], [data-cab-close], [data-cab-url]');
      if (!el) return false;
      const d = el.dataset;
      if ('cabUrl' in d) { el.select(); return true; }
      if (d.cabCopy) { copy(d.cabCopy, el); return true; }
      if (d.cabQrdl) { downloadQr(st.data.links[d.cabQrdl], `qr-${st.data.source.code}-${d.cabQrdl}`); return true; }
      if (d.cabPaydel) { deletePayout(Number(d.cabPaydel)); return true; }
      if ('cabClose' in d) { ctx.closePreview(); return true; }
      if (d.cabQr) st.qr = st.qr === d.cabQr ? null : d.cabQr;
      if (d.cabSeason) st.season = d.cabSeason;
      ctx.rerender();
      return true;
    }

    function onInput(event) {
      const el = event.target;
      const form = el.closest('[data-cab-form], [data-cab-pay]');
      if (!form || !el.name) return false;
      (form.matches('[data-cab-form]') ? st.form : st.pay)[el.name] = el.value;
      return true;
    }

    function onChange(event) {
      const el = event.target;
      if (!el.closest('[data-cab-form]') || !el.name) return false;
      st.form[el.name] = el.value;
      // Тип сменили — подсказки моделей и «по» для дат обновляем
      if (el.name === 'type' || el.name === 'from') {
        if (el.name === 'from' && st.form.to && st.form.to <= st.form.from) st.form.to = '';
        ctx.rerender();
      }
      return true;
    }

    function onSubmit(event) {
      const form = event.target.closest('[data-cab-form], [data-cab-pay]');
      if (!form) return false;
      event.preventDefault();
      if (form.matches('[data-cab-form]')) { if (!st.sending) send(); }
      else savePayout();
      return true;
    }

    /** Фоновое обновление не трогает вкладку, пока заполняют форму */
    function canRefresh() {
      return !document.activeElement?.closest?.('.cab input, .cab textarea, .cab select') && !st.sending;
    }

    return { load, render, onClick, onInput, onChange, onSubmit, canRefresh, previewSource: () => st.source };
  }

  window.STAFF_CABINET = { create };
})();
