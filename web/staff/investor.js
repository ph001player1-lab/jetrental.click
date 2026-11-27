/*
 * Вкладка «Инвестор»: машины инвестора сейчас, загрузка и деньги по месяцам
 * (выручка, каждый расход, кредит, прибыль, доля), начисления и выплаты.
 * Владелец и админ открывают кабинет любого инвестора из «Доступов» (просмотр)
 * и записывают выплаты. Клиентов инвестор не видит — только даты и суммы аренд.
 * Тексты — i18n (inv.*).
 */
(function () {
  'use strict';

  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = { data: null, failed: null, staff: null, month: null, open: new Set(), payMsg: null, pay: { amount: '', date: '', method: '', note: '' } };
    const money = (n) => (Number(n) ? ctx.money(n) : '0 ฿');
    // Расход со знаком минус; ноль — просто «0 ฿»
    const minus = (n) => (Number(n) ? `−${money(n)}` : money(0));
    const dm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '?');
    const monthName = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString(ctx.locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });

    async function load(staff = st.staff) {
      st.staff = staff || null;
      try {
        const params = new URLSearchParams({ lang: ctx.lang() });
        if (st.staff) params.set('staff', st.staff);
        if (st.month) params.set('month', st.month);
        st.data = await api(`/investor?${params}`);
        st.month = st.data.month;
        st.failed = null;
      } catch (err) {
        st.failed = err.code === 'no_cabinet' ? t('inv.noCabinet') : t('inv.loadFailed');
      }
      ctx.rerender();
    }

    function render() {
      if (st.failed) return `<div class="inv"><div class="card empty">${esc(st.failed)}</div></div>`;
      const d = st.data;
      if (!d) return `<div class="inv"><div class="card empty">${esc(t('app.loading'))}</div></div>`;
      return `<div class="inv">
        ${d.preview ? `<div class="cab-preview" role="status"><span>👁 ${esc(t('inv.preview', { name: d.investor.name }))}</span>
          <button type="button" class="btn btn--small" data-inv-close>✕ ${esc(t('cab.close'))}</button></div>` : ''}
        <header class="cab-head"><h2>📈 ${esc(d.investor.name)}</h2><span class="pill cab-pct">${esc(t('inv.share', { n: d.investor.percent }))}</span></header>
        ${renderStats(d)}
        ${renderFleet(d)}
        ${renderMonth(d)}
        <div class="cab-grid">${renderPayouts(d)}${renderHistory(d)}</div>
      </div>`;
    }

    function renderStats(d) {
      const tile = (label, value, cls = '') => `<div class="card cab-stat ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
      return `<div class="cab-stats inv-stats">
        ${tile(t('cab.balance'), money(d.money.balance), 'cab-stat--main')}
        ${tile(t('inv.accrued'), money(d.money.accrued))}
        ${tile(t('cab.paid'), money(d.money.paid))}
        ${d.money.expected !== null ? tile(t('inv.expected', { month: monthName(d.current) }), money(d.money.expected)) : ''}
      </div>`;
    }

    function renderFleet(d) {
      if (!d.fleet.length) return `<div class="card empty">${esc(t('inv.noVehicles'))}</div>`;
      const items = d.fleet.map((c) => {
        const when = c.status === 'rent' && c.until ? t('fl.until', { date: dm(c.until) })
          : c.status !== 'free' && c.freeFrom && c.freeFrom !== 'later' ? t('inv.freeFrom', { date: ctx.dateTime(c.freeFrom) })
            : c.nextBooking ? t('inv.nextBooking', { from: dm(c.nextBooking.from), to: dm(c.nextBooking.to) }) : '';
        return `<li><span>${TYPE_ICON[c.type] || ''} <b>${esc(c.model)}</b> <span class="car__plate">${esc(c.plate)}</span></span>
          <span class="pill pill--${c.status}"><span class="dot dot--${c.status}"></span>${esc(ctx.statusName(c.status))}</span>
          ${when ? `<span class="muted jr-small">${esc(when)}</span>` : ''}</li>`;
      }).join('');
      return `<section class="card cab-sec"><h3>🚘 ${esc(t('inv.myFleet', { n: d.fleet.length }))}</h3><ul class="inv-fleet">${items}</ul></section>`;
    }

    function renderMonth(d) {
      const chips = d.months.map((m) => `<button type="button" class="chip" data-inv-month="${m}" aria-pressed="${m === d.month}">${esc(monthName(m))}</button>`).join('');
      const note = d.month === d.current ? t('inv.monthOpen') : d.closed ? t('inv.monthClosed') : t('inv.monthPending');
      const cards = d.rows.map((r) => {
        const open = st.open.has(r.vehicleId);
        const costs = r.costItems.length ? `<ul class="inv-list">${r.costItems.map((x) => `<li><span>${esc(dm(String(x.at).slice(0, 10)))}</span><b>${esc(money(x.sum))}</b><span class="pill ${x.kind === 'repair' ? 'inv-repair' : 'inv-other'}">${esc(t(`inv.cost.${x.kind}`))}</span><span class="inv-text">${esc(x.text || '—')}</span></li>`).join('')}</ul>`
          : `<p class="cab-muted">${esc(t('inv.noCosts'))}</p>`;
        const rentals = r.rentals.length ? `<ul class="inv-list">${r.rentals.map((x) => `<li><span>${esc(dm(x.from))}–${esc(x.to ? dm(x.to) : '…')}</span><b>${esc(money(x.sum))}</b>${x.active ? `<span class="pill pill--rent">${esc(t('inv.rentNow'))}</span>` : ''}</li>`).join('')}</ul>`
          : `<p class="cab-muted">${esc(t('inv.noRentals'))}</p>`;
        return `<article class="card inv-car${r.profit < 0 ? ' inv-car--minus' : ''}">
          <header class="inv-car__head" data-inv-toggle="${r.vehicleId}" role="button" tabindex="0" aria-expanded="${open}">
            <span>${TYPE_ICON[r.type] || ''} <b>${esc(r.model)}</b> <span class="car__plate">${esc(r.plate)}</span>${r.sold ? ` <span class="pill">${esc(t('inv.sold'))}</span>` : ''}</span>
            <span class="inv-car__amount">${esc(t('inv.yourShare'))}: <b>${esc(money(r.amount))}</b></span>
          </header>
          <dl class="inv-nums">
            <div><dt>${esc(t('inv.load'))}</dt><dd>${r.utilization}% · ${esc(t('inv.days', { n: r.rentedDays }))}</dd></div>
            <div><dt>${esc(t('inv.revenue'))}</dt><dd>${esc(money(r.revenue))}</dd></div>
            <div><dt>${esc(t('inv.repair'))}</dt><dd>${esc(minus(r.repair))}</dd></div>
            <div><dt>${esc(t('inv.other'))}</dt><dd>${esc(minus(r.other))}</dd></div>
            ${r.loan ? `<div><dt>${esc(t('inv.loan'))}</dt><dd>${esc(minus(r.loan))}</dd></div>` : ''}
            <div><dt>${esc(t('inv.profit'))}</dt><dd><b>${esc(money(r.profit))}</b></dd></div>
            <div><dt>${esc(t('inv.pct'))}</dt><dd>${r.percent}%</dd></div>
          </dl>
          ${open ? `<div class="inv-more"><h4>${esc(t('inv.costs'))}</h4>${costs}<h4>${esc(t('inv.rentals'))}</h4>${rentals}</div>`
            : `<button type="button" class="link" data-inv-toggle="${r.vehicleId}">${esc(t('inv.details'))}</button>`}
        </article>`;
      }).join('');
      const tot = d.totals;
      return `<section class="inv-month">
        <h3 class="section-title">💰 ${esc(t('inv.money'))}</h3>
        <div class="chips">${chips}</div>
        <p class="cab-tip">${esc(note)} ${esc(t('inv.formula'))}</p>
        ${d.rows.length ? `<div class="list">${cards}</div>
          <div class="card inv-total"><span>${esc(t('inv.total', { month: monthName(d.month) }))}</span>
            <span>${esc(t('inv.revenue'))} ${esc(money(tot.revenue))} · ${esc(t('inv.profit'))} ${esc(money(tot.profit))}</span>
            <b>${esc(t('inv.yourShare'))}: ${esc(money(tot.amount))}</b></div>` : `<div class="card empty">${esc(t('inv.noVehicles'))}</div>`}
      </section>`;
    }

    function renderPayouts(d) {
      const list = d.payouts.map((p) => `<li><b>${esc(money(p.amount))}</b> · ${esc(dm(p.date))}${p.method ? ` · ${esc(p.method)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}
        ${d.canPay ? `<button type="button" class="link cab-danger" data-inv-paydel="${p.id}">${esc(t('cab.payDelete'))}</button>` : ''}</li>`).join('');
      const pay = st.pay;
      const form = d.canPay ? `
        <form class="cab-pay" data-inv-pay novalidate>
          <h4>${esc(t('cab.payTitle'))}</h4>
          <div class="cab-pay__grid">
            <label class="field"><span>${esc(t('cab.p.amount'))}</span><input class="search" name="amount" inputmode="numeric" value="${esc(pay.amount || (d.money.balance > 0 ? String(d.money.balance) : ''))}"></label>
            <label class="field"><span>${esc(t('cab.p.date'))}</span><input class="search" type="date" name="date" value="${esc(pay.date || ctx.today())}"></label>
            <label class="field"><span>${esc(t('cab.p.method'))}</span><input class="search" name="method" maxlength="60" placeholder="${esc(t('cab.p.methodPh'))}" value="${esc(pay.method)}"></label>
            <label class="field"><span>${esc(t('cab.p.note'))}</span><input class="search" name="note" maxlength="300" value="${esc(pay.note)}"></label>
          </div>
          <div class="cab-actions"><button type="submit" class="btn btn--primary btn--small">${esc(t('cab.paySave'))}</button>
            ${st.payMsg ? `<p class="cab-msg cab-msg--${st.payMsg.kind}" role="status">${esc(st.payMsg.text)}</p>` : ''}</div>
        </form>` : '';
      return `<section class="card cab-sec"><h3>💸 ${esc(t('cab.payouts'))}</h3>
        ${list ? `<ul class="cab-payouts">${list}</ul>` : `<p class="cab-muted">${esc(t('cab.noPayouts'))}</p>`}${form}</section>`;
    }

    function renderHistory(d) {
      const rows = d.history.map((h) => `<tr><td>${esc(monthName(h.month))}</td><td class="num"><b>${esc(money(h.amount))}</b></td></tr>`).join('');
      return `<section class="card cab-sec"><h3>🗓 ${esc(t('inv.history'))}</h3>
        ${rows ? `<div class="cab-table"><table><tbody>${rows}</tbody></table></div>` : `<p class="cab-muted">${esc(t('inv.noHistory'))}</p>`}</section>`;
    }

    async function savePayout(form) {
      st.pay = Object.fromEntries(new FormData(form));
      try {
        await api('/investor/payout', { body: { staffId: st.data.investor.id, ...st.pay } });
        st.pay = { amount: '', date: '', method: '', note: '' };
        st.payMsg = { kind: 'ok', text: t('inv.paySaved') };
        await load();
      } catch (err) {
        st.payMsg = { kind: 'error', text: t(err.code === 'bad_amount' ? 'cab.err.amount' : 'cab.err.failed') };
        ctx.rerender();
      }
    }

    async function deletePayout(id) {
      if (!window.confirm(t('cab.payDeleteConfirm'))) return;
      try { await api('/investor/payout/delete', { body: { id } }); } catch { /* ниже — перезагрузим */ }
      await load();
    }

    function onClick(event) {
      const el = event.target.closest('[data-inv-month], [data-inv-toggle], [data-inv-paydel], [data-inv-close]');
      if (!el) return false;
      const d = el.dataset;
      if (d.invMonth) { st.month = d.invMonth; st.open.clear(); load(); return true; }
      if (d.invToggle) {
        const id = Number(d.invToggle);
        if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
        ctx.rerender();
        return true;
      }
      if (d.invPaydel) { deletePayout(Number(d.invPaydel)); return true; }
      if ('invClose' in d) { ctx.closePreview(); return true; }
      return false;
    }

    function onSubmit(event) {
      const form = event.target.closest('[data-inv-pay]');
      if (!form) return false;
      event.preventDefault();
      savePayout(form);
      return true;
    }

    const canRefresh = () => !document.activeElement?.closest?.('.inv input');

    return { load, render, onClick, onSubmit, canRefresh, reset: () => { st.month = null; st.open.clear(); } };
  }

  window.STAFF_INVESTOR = { create };
})();
