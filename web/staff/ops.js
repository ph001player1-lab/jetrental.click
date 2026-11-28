/*
 * Вкладка «Операции»: всё, что сделано в портале («＋ Операция», статусы из «Парка»,
 * выдачи по договору). Строку открывают — карточка: что сделано, деньги, документы,
 * история. Изменить (бронь, деньги) и отменить: свою — в течение суток, любую —
 * владелец и админ. Отмена брони спрашивает, что с предоплатой.
 */
(function () {
  'use strict';

  const ICON = {
    booking: '🔖', issue: '🔑', return: '↩️', swap: '🔁', extend: '📅', service: '🔧', expense: '🧾', income: '💰',
    deposit_refund: '💵', payout: '👛', status: '🚗', contract: '📄', unknown: '❔'
  };
  const FILTER_KINDS = ['booking', 'issue', 'return', 'swap', 'extend', 'service', 'expense', 'income', 'deposit_refund', 'payout', 'status', 'contract', 'cancelled'];
  const METHODS = ['cash', 'transfer', 'card'];
  const PERIODS = [7, 30, 90];

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = { days: 30, kind: '', q: '', mine: false, data: null, failed: false, loading: false, card: null, mode: 'view', busy: false, msg: null };
    let dlg = null;
    let qTimer = null;

    const money = (n) => ctx.money(n);
    const dm = (iso) => (iso ? `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)}` : '');
    const dmy = (iso) => (iso ? `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)}.${String(iso).slice(0, 4)}` : '');
    const bkkDay = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
    const kindName = (it) => (it.kind === 'status' ? t('ops.k.status', { status: t(`ops.st.${it.status}`) }) : it.kind === 'contract' ? t(it.status === 'reserve' ? 'ops.k.contractReserve' : 'ops.k.contract') : t(`op.kind.${it.kind}`));
    const errText = (err) => {
      const own = t(`ops.err.${err?.code}`);
      if (own !== `ops.err.${err?.code}`) return own;
      const op = t(`op.err.${err?.code}`);
      return op !== `op.err.${err?.code}` ? op : t('ops.err.failed');
    };

    /* ------------------------------------------------------------ Список */

    async function load() {
      st.loading = true;
      const to = bkkDay(Date.now());
      const from = bkkDay(Date.now() - (st.days - 1) * 86400000);
      const qs = new URLSearchParams({ from, to, ...(st.kind ? { kind: st.kind } : {}), ...(st.q ? { q: st.q } : {}), ...(st.mine ? { mine: '1' } : {}) });
      try {
        st.data = await api(`/ops?${qs}`);
        st.failed = false;
      } catch {
        st.failed = true;
      }
      st.loading = false;
      ctx.rerender();
    }

    function stateBadge(it) {
      if (it.state === 'cancelled') return `<span class="pill pill--rent">✕ ${esc(t('ops.cancelled'))}</span>`;
      if (it.state === 'issued') return `<span class="pill pill--free">🔑 ${esc(t('ops.issued'))}</span>`;
      if (it.edited) return `<span class="pill">✏️ ${esc(t('ops.edited'))}</span>`;
      return '';
    }

    function moneyText(it) {
      const parts = [];
      if (it.booking?.total) parts.push(t('ops.total', { sum: money(it.booking.total) }));
      if (it.moneyIn) parts.push(`+${money(it.moneyIn)}`);
      if (it.moneyOut) parts.push(`−${money(it.moneyOut)}`);
      return parts.join(' · ');
    }

    function rowHtml(it) {
      const v = it.vehicle;
      const what = [v ? `${v.name || ''} ${v.plate ? `#${v.plate}` : ''}`.trim() : it.plates.map((p) => `#${p}`).join(', '), it.client,
        it.from && it.to ? `${dm(it.from)}–${dm(it.to)}` : it.to ? `→ ${dm(it.to)}` : ''].filter(Boolean).join(' · ');
      return `<li><button type="button" class="ops-row${it.state === 'cancelled' ? ' ops-row--off' : ''}" data-ops-open="${esc(it.id)}">
        <span class="ops-row__head"><b>${ICON[it.kind] || '•'} ${esc(kindName(it))}</b> ${stateBadge(it)}<span class="muted jr-small ops-row__at">${esc(ctx.dateTime(it.at))}</span></span>
        ${what ? `<span class="ops-row__what">${esc(what)}</span>` : ''}
        <span class="ops-row__foot"><span class="ops-row__money">${esc(moneyText(it))}</span><span class="muted jr-small">${esc(it.by || '')}</span></span>
      </button></li>`;
    }

    function render() {
      const periods = PERIODS.map((n) => `<button type="button" class="chip" data-ops-days="${n}" aria-pressed="${st.days === n}">${esc(t('ops.days', { n }))}</button>`).join('');
      const kinds = `<select class="search ops-kind" data-ops-kind aria-label="${esc(t('ops.kindAll'))}"><option value="">${esc(t('ops.kindAll'))}</option>
        ${FILTER_KINDS.map((k) => `<option value="${k}"${st.kind === k ? ' selected' : ''}>${ICON[k] || '✕'} ${esc(k === 'cancelled' ? t('ops.onlyCancelled') : k === 'status' ? t('ops.k.statusAll') : k === 'contract' ? t('ops.k.contract') : t(`op.kind.${k}`))}</option>`).join('')}</select>`;
      const head = `<div class="toolbar ops-bar">
          <input class="search" type="search" data-ops-q value="${esc(st.q)}" placeholder="${esc(t('ops.search'))}" autocomplete="off" enterkeyhint="search">
          <div class="chips">${periods}${kinds}<label class="mk-check ops-mine"><input type="checkbox" data-ops-mine${st.mine ? ' checked' : ''}> ${esc(t('ops.mine'))}</label></div>
        </div>`;
      if (st.failed) return `<div class="ops">${head}<div class="empty">${esc(t('app.loadFailed'))}</div></div>`;
      if (!st.data) return `<div class="ops">${head}<div class="empty">${esc(t('app.loading'))}</div></div>`;
      const items = st.data.items;
      return `<div class="ops${st.loading ? ' ops--loading' : ''}">${head}
        <p class="muted jr-small">${esc(t('ops.lead'))}</p>
        ${items.length ? `<ul class="ops-list">${items.map(rowHtml).join('')}</ul>` : `<div class="empty">${esc(t('ops.none'))}</div>`}
      </div>`;
    }

    /* ------------------------------------------------------------ Карточка */

    function ensureDialog() {
      if (dlg) return dlg;
      dlg = document.createElement('dialog');
      dlg.id = 'ops-dialog';
      dlg.className = 'sheet ops-sheet';
      dlg.addEventListener('click', onDialogClick);
      dlg.addEventListener('change', onDialogChange);
      dlg.addEventListener('submit', onDialogSubmit);
      dlg.addEventListener('close', () => { st.card = null; st.mode = 'view'; st.msg = null; });
      document.body.appendChild(dlg);
      return dlg;
    }

    async function openCard(id) {
      ensureDialog();
      st.mode = 'view';
      st.msg = null;
      try {
        st.card = (await api(`/ops/one?id=${encodeURIComponent(id)}`)).item;
      } catch (err) {
        st.card = null;
        st.msg = { kind: 'error', text: errText(err) };
      }
      if (!dlg.open) dlg.showModal();
      renderCard();
    }

    const line = (label, value) => (value ? `<div class="ops-kv"><span class="muted">${esc(label)}</span><span>${value}</span></div>` : '');

    function cardInfo(c) {
      const v = c.vehicle;
      const b = c.booking;
      const info = c.stateInfo || {};
      return `
        ${line(t('ops.when'), esc(ctx.dateTime(c.at)))}
        ${line(t('ops.by'), esc(c.by || '—'))}
        ${line(t('ops.vehicle'), v ? esc(`${v.name || ''} #${v.plate}`.trim()) : c.plates.length ? esc(c.plates.map((p) => `#${p}`).join(', ')) : '')}
        ${line(t('ops.client'), esc(c.client))}
        ${line(t('ops.dates'), c.from && c.to ? esc(`${dmy(c.from)} – ${dmy(c.to)}`) : c.to ? esc(`→ ${dmy(c.to)}`) : '')}
        ${b ? line(t('ops.bTotal'), b.total ? esc(money(b.total)) : '—') : ''}
        ${b ? line(t('ops.bPrepaid'), `${esc(money(b.prepaid))}${b.method ? ` · ${esc(t(`op.pay.${b.method}`))}` : ''}`) : ''}
        ${b && b.total ? line(t('ops.bLeft'), esc(money(b.left))) : ''}
        ${b && b.refunded ? line(t('ops.bRefunded'), esc(money(b.refunded))) : ''}
        ${c.note ? line(t('ops.note'), esc(c.note)) : ''}
        ${c.state === 'cancelled' ? `<p class="ops-cancelled">✕ ${esc(t('ops.cancelledBy', { by: c.stateBy || '—', at: ctx.dateTime(c.stateAt) }))}${c.stateReason ? ` — «${esc(c.stateReason)}»` : ''}
          ${info.mode ? `<br>${esc(t(`ops.refund.done.${info.mode}`, { back: money(info.returned || 0), kept: money(info.kept || 0) }))}` : ''}</p>` : ''}
        ${c.state === 'issued' ? `<p class="ops-issued">🔑 ${esc(t('ops.issuedBy', { no: info.number || '' }))}</p>` : ''}`;
    }

    function cardParts(c) {
      const ev = (c.events || []).map((e) => `<li class="${e.cancelled ? 'is-off' : ''}">🚗 ${esc(t(`ops.st.${e.kind}`))} #${esc(e.plate)}${e.from || e.to ? ` · ${esc(e.from ? `${dm(e.from)}–` : '→ ')}${esc(dm(e.to))}` : ''}${e.cancelled ? ` · ${esc(t('ops.cancelled'))}` : ''}</li>`);
      const mv = (c.moves || []).map((m) => `<li class="${m.cancelled ? 'is-off' : ''}">${m.dir === 'in' ? '💰' : '💵'} ${esc(t(`ops.mv.${m.kind}`) !== `ops.mv.${m.kind}` ? t(`ops.mv.${m.kind}`) : m.kind)}${m.category === 'deposit' ? ` (${esc(t('ops.deposit'))})` : ''}: ${m.dir === 'in' ? '+' : '−'}${esc(money(m.thb))}${m.method ? ` · ${esc(t(`op.pay.${m.method}`))}` : ''}${m.cancelled ? ` · ${esc(t('ops.cancelled'))}${m.reason ? ` («${esc(m.reason)}»)` : ''}` : ''}</li>`);
      const ex = (c.expenses || []).map((x) => `<li class="${x.cancelled ? 'is-off' : ''}">🧾 ${esc(t(`op.cat.${x.category}`))}: −${esc(money(x.thb))}${x.vendor ? ` · ${esc(x.vendor)}` : ''}${x.cancelled ? ` · ${esc(t('ops.cancelled'))}` : ''}</li>`);
      const docs = (c.docs || []).map((d) => `<li>📄 ${esc(d.number || '')} <button type="button" class="link jr-small" data-ops-doc="${d.contractId || d.id}">${esc(t('op.openDoc'))}</button></li>`);
      if (c.docId) docs.push(`<li>📄 <button type="button" class="link jr-small" data-ops-doc="${c.docId}">${esc(t('op.openDoc'))}</button></li>`);
      const all = [...ev, ...mv, ...ex, ...docs];
      const hist = (c.history || []).map((h) => `<li><span class="muted jr-small">${esc(ctx.dateTime(h.at))} · ${esc(h.by)}</span><br>${esc(h.what)}</li>`).join('');
      return `${all.length ? `<h3>${esc(t('ops.whatDone'))}</h3><ul class="ops-parts">${all.join('')}</ul>` : ''}
        ${hist ? `<h3>${esc(t('ops.history'))}</h3><ul class="ops-parts">${hist}</ul>` : ''}`;
    }

    function actionsHtml(c) {
      const btns = [];
      if (c.kind === 'booking' && c.state === 'done' && ctx.canDocs?.()) btns.push(`<button type="button" class="btn btn--primary" data-ops-issue>🔑 ${esc(t('ops.issueBooking'))}</button>`);
      if (c.canEdit) btns.push(`<button type="button" class="btn" data-ops-mode="edit">✏️ ${esc(t('ops.edit'))}</button>`);
      if (c.canCancel) btns.push(`<button type="button" class="btn ops-danger" data-ops-mode="cancel">✕ ${esc(t('ops.cancel'))}</button>`);
      const hint = c.state === 'done' && !c.canCancel ? (c.kind === 'contract' ? t('ops.contractHint') : t('ops.noRights')) : '';
      return `${btns.length ? `<div class="dc-actions ops-actions">${btns.join('')}</div>` : ''}${hint ? `<p class="muted jr-small">${esc(hint)}</p>` : ''}
        ${c.state === 'done' && c.docs?.length && c.canCancel ? `<p class="muted jr-small">${esc(t('ops.docsStay'))}</p>` : ''}`;
    }

    const fld = (label, control, cls = '') => `<label class="field ${cls}"><span>${esc(label)}</span>${control}</label>`;
    const inp = (name, value, attrs = '') => `<input class="search" name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
    const paySel = (name, value) => `<select class="search" name="${name}"><option value="">—</option>${METHODS.map((m) => `<option value="${m}"${value === m ? ' selected' : ''}>${esc(t(`op.pay.${m}`))}</option>`).join('')}</select>`;

    function editForm(c) {
      if (c.kind === 'booking') {
        const f = c.form || {};
        const ev = (c.events || []).find((e) => !e.cancelled) || {};
        const list = (ctx.vehicles() || []).filter((v) => v.id).sort((a, b) => String(a.plate).localeCompare(String(b.plate)));
        const vid = c.vehicle?.id;
        return `<div class="dc-grid">
            ${fld(t('ops.vehicle'), `<select class="search" name="vehicleId">${list.map((v) => `<option value="${v.id}"${v.id === vid ? ' selected' : ''}>${esc([v.brand, v.model].filter(Boolean).join(' ') || v.clientModel || '')} · ${esc(v.plate)}</option>`).join('')}</select>`, 'dc-wide')}
            ${fld(t('op.bookFrom'), inp('from', ev.from || f.bookFrom, 'type="date"'))}${fld(t('op.bookTo'), inp('to', ev.to || f.bookTo, 'type="date"'))}
            ${fld(t('op.clientName'), inp('clientName', ev.client ?? f.clientName))}${fld(t('dc.phone'), inp('clientPhone', ev.phone ?? f.clientPhone, 'type="tel"'))}
            ${fld(t('op.total'), inp('total', f.total, 'inputmode="numeric"'))}${fld(t('op.prepaid'), inp('paid', c.booking?.prepaid || '', 'inputmode="numeric"'))}
            ${fld(t('op.method'), paySel('payMethod', c.booking?.method || f.payMethod || ''))}${fld(t('op.bookNote'), inp('note', f.note))}
          </div>`;
      }
      const m = (c.moves || []).find((x) => !x.cancelled);
      const x = (c.expenses || []).find((y) => !y.cancelled);
      const cur = m || x || {};
      return `<div class="dc-grid">
          ${fld(t('op.amount'), inp('amount', cur.amount ?? '', 'inputmode="decimal"'))}${fld(t('op.method'), paySel('method', cur.method || ''))}
          ${fld(t('ops.note'), inp('note', cur.note || ''), 'dc-wide')}
        </div>`;
    }

    function cancelForm(c) {
      const b = c.booking;
      const left = b ? b.prepaid - b.refunded : 0;
      const modes = left > 0 ? `<fieldset class="ops-refund"><legend>${esc(t('ops.refund.q', { sum: money(left) }))}</legend>
          ${['returned', 'kept', 'partial', 'mistake'].map((mode, i) => `<label class="mk-check"><input type="radio" name="mode" value="${mode}"${i === 0 ? ' checked' : ''}> ${esc(t(`ops.refund.${mode}`))}</label>`).join('')}
          <div class="dc-grid">
            ${fld(t('ops.refund.amount'), inp('amount', '', 'inputmode="numeric" placeholder="฿"'), 'ops-refund-amount')}
            ${fld(t('op.method'), paySel('method', b.method || ''), 'ops-refund-method')}
          </div></fieldset>` : '';
      return `${modes}${fld(t('ops.reason'), inp('reason', '', `required minlength="3" placeholder="${esc(t('ops.reasonHint'))}"`), 'dc-wide')}`;
    }

    function syncRefund() {
      const form = dlg?.querySelector('[data-ops-form="cancel"]');
      if (!form || !form.elements.mode) return;
      const mode = form.elements.mode.value;
      form.querySelector('.ops-refund-amount').hidden = mode !== 'partial';
      form.querySelector('.ops-refund-method').hidden = !['returned', 'partial'].includes(mode);
    }

    const msgHtml = () => (st.msg ? `<p class="md-status is-${st.msg.kind === 'error' ? 'error' : 'ok'}" role="status">${esc(st.msg.text)}</p>` : '');
    /** Сообщение без перерисовки формы — введённое не теряется */
    function showMsg() {
      const box = dlg?.querySelector('[data-ops-msg]');
      if (box) box.innerHTML = msgHtml();
      box?.scrollIntoView({ block: 'nearest' });
    }

    function renderCard() {
      if (!dlg) return;
      const c = st.card;
      const msg = `<div data-ops-msg>${msgHtml()}</div>`;
      if (!c) {
        dlg.innerHTML = `<div class="sheet__body"><div class="sheet__head"><h2>${esc(t('tab.ops'))}</h2><button type="button" class="icon-btn icon-btn--plain" data-ops-close aria-label="${esc(t('vh.close'))}">×</button></div>${msg}</div>`;
        return;
      }
      const body = st.mode === 'edit'
        ? `<form class="ops-form" data-ops-form="edit" novalidate><h3>✏️ ${esc(t('ops.edit'))}</h3>${editForm(c)}
            <div class="dc-actions"><button type="submit" class="btn btn--primary"${st.busy ? ' disabled' : ''}>✓ ${esc(t('ops.save'))}</button><button type="button" class="btn" data-ops-mode="view">${esc(t('vh.cancel'))}</button></div></form>`
        : st.mode === 'cancel'
          ? `<form class="ops-form" data-ops-form="cancel" novalidate><h3>✕ ${esc(t('ops.cancelTitle'))}</h3><p class="muted jr-small">${esc(t('ops.cancelHint'))}</p>${cancelForm(c)}
              <div class="dc-actions"><button type="submit" class="btn ops-danger"${st.busy ? ' disabled' : ''}>✕ ${esc(t('ops.cancelDo'))}</button><button type="button" class="btn" data-ops-mode="view">${esc(t('vh.cancel'))}</button></div></form>`
          : `${cardParts(c)}${actionsHtml(c)}`;
      dlg.innerHTML = `<div class="sheet__body ops-card">
        <div class="sheet__head"><div><div class="muted">${esc(t('tab.ops'))} · ${esc(c.id)}</div><h2>${ICON[c.kind] || '•'} ${esc(kindName(c))} ${stateBadge(c)}</h2></div>
          <button type="button" class="icon-btn icon-btn--plain" data-ops-close aria-label="${esc(t('vh.close'))}">×</button></div>
        ${msg}
        <div class="ops-info">${cardInfo(c)}</div>
        ${body}
      </div>`;
      syncRefund();
    }

    async function act(fn, okText) {
      const buttons = [...dlg.querySelectorAll('[data-ops-form] button')];
      st.busy = true;
      st.msg = null;
      showMsg();
      buttons.forEach((x) => { x.disabled = true; });
      try {
        await fn();
        st.msg = { kind: 'ok', text: okText };
        st.mode = 'view';
        st.card = (await api(`/ops/one?id=${encodeURIComponent(st.card.id)}`)).item;
        st.busy = false;
        renderCard();
        load();
        ctx.onChanged?.();
      } catch (err) {
        // Ошибка — форма остаётся как есть, с тем, что ввели
        st.busy = false;
        st.msg = { kind: 'error', text: errText(err) };
        buttons.forEach((x) => { x.disabled = false; });
        showMsg();
      }
    }

    function onDialogClick(event) {
      const el = event.target;
      if (el === dlg || el.closest('[data-ops-close]')) { dlg.close(); return; }
      const mode = el.closest('[data-ops-mode]');
      if (mode) { st.mode = mode.dataset.opsMode; st.msg = null; renderCard(); return; }
      const doc = el.closest('[data-ops-doc]');
      if (doc) { dlg.close(); ctx.openContract(Number(doc.dataset.opsDoc)); return; }
      if (el.closest('[data-ops-issue]')) {
        const c = st.card;
        const opId = Number(String(c.id).replace(/^op/, ''));
        dlg.close();
        ctx.newContract({ vehicleId: c.vehicle?.id, from: c.from ? `${c.from}T12:00` : undefined, to: c.to ? `${c.to}T12:00` : undefined, bookingOpId: opId, renter: { name: c.client || '', phone: (c.events || [])[0]?.phone || '' } });
      }
    }

    function onDialogChange(event) {
      if (event.target.name === 'mode') syncRefund();
    }

    function onDialogSubmit(event) {
      const form = event.target.closest('[data-ops-form]');
      if (!form) return;
      event.preventDefault();
      const g = (n) => form.elements[n]?.value ?? '';
      const c = st.card;
      if (form.dataset.opsForm === 'cancel') {
        if (g('reason').trim().length < 3) { st.msg = { kind: 'error', text: t('ops.err.reason_required') }; showMsg(); form.elements.reason.focus(); return; }
        const refund = form.elements.mode ? { mode: g('mode'), amount: g('amount'), method: g('method') } : null;
        act(() => api('/ops/cancel', { body: { id: c.id, reason: g('reason'), refund } }), t('ops.cancelledOk'));
        return;
      }
      const changes = c.kind === 'booking'
        ? { vehicleId: Number(g('vehicleId')) || null, from: g('from'), to: g('to'), clientName: g('clientName'), clientPhone: g('clientPhone'), total: g('total'), paid: g('paid'), payMethod: g('payMethod'), note: g('note') }
        : { amount: g('amount'), method: g('method'), note: g('note') };
      act(() => api('/ops/edit', { body: { id: c.id, changes } }), t('ops.savedOk'));
    }

    /* ------------------------------------------------------------ События списка */

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.ops')) return false;
      const open = el.closest('[data-ops-open]');
      if (open) { openCard(open.dataset.opsOpen); return true; }
      const days = el.closest('[data-ops-days]');
      if (days) { st.days = Number(days.dataset.opsDays); load(); return true; }
      return false;
    }

    function onChange(event) {
      const el = event.target;
      if (!el.closest?.('.ops')) return false;
      if (el.matches('[data-ops-kind]')) { st.kind = el.value; load(); return true; }
      if (el.matches('[data-ops-mine]')) { st.mine = el.checked; load(); return true; }
      return false;
    }

    function onInput(event) {
      const el = event.target;
      if (!el.matches?.('.ops [data-ops-q]')) return false;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { st.q = el.value.trim(); load().then(() => { const box = document.querySelector('.ops [data-ops-q]'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }); }, 350);
      return true;
    }

    return { load, render, onClick, onChange, onInput, openCard, canRefresh: () => !dlg?.open };
  }

  window.STAFF_OPS = { create };
})();
