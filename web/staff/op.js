/*
 * «＋ Операция» — кнопка на всех вкладках. Сотрудник фотографирует (камера телефона
 * или файлы), пишет пару слов; ИИ понимает, что произошло, и заполняет форму:
 * выдача (дальше — договор), возврат (акт), замена (дополнение), сервис, расход по чеку.
 * Человек проверяет и подтверждает.
 *
 * Операция — черновик на сервере (operations.js): фото с телефона сразу видны на
 * компьютере того же сотрудника; окно само подтягивает изменения с другого устройства.
 */
(function () {
  'use strict';

  const KINDS = ['booking', 'issue', 'return', 'swap', 'extend', 'service', 'expense', 'income', 'deposit_refund', 'payout'];
  const ICON = { booking: '🔖', issue: '🔑', return: '↩️', swap: '🔁', extend: '📅', service: '🔧', expense: '🧾', income: '💰', deposit_refund: '💵', payout: '👛' };
  const INCOME_CATEGORIES = ['rent', 'extras', 'deposit', 'damage', 'other'];
  const CATEGORIES = ['fuel', 'repair', 'wash', 'delivery', 'office', 'insurance', 'tax', 'ads', 'it', 'salary', 'owners', 'refunds', 'vehicles', 'personal', 'other'];
  const CURRENCIES = ['THB', 'USD', 'EUR', 'RUB', 'GBP'];
  const ACTIONS = ['to_repair', 'from_repair', 'maintenance', 'mileage'];
  const METHODS = ['cash', 'transfer', 'card'];
  const POLL_MS = 4000;

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = { open: false, view: 'list', drafts: [], allowed: [], draft: null, busy: null, msg: null, uploading: null, remote: false, done: null, bookQuote: null };
    let dlg = null;
    let quoteTimer = null;
    let saveTimer = null;
    let pollTimer = null;
    let noteTimer = null;

    const lang = () => (ctx.lang() === 'en' ? 'en' : 'ru');
    const dm = (iso) => (iso ? `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)}` : '');
    const vehicles = () => (ctx.vehicles() || []).filter((v) => v.id);
    const vName = (v) => [v.brand, v.model].filter(Boolean).join(' ') || v.clientModel || v.plate;
    const errText = (err) => {
      const own = t(`op.err.${err?.code}`);
      if (own !== `op.err.${err?.code}`) return own;
      const dc = t(`dc.err.${err?.code}`);
      return dc !== `dc.err.${err?.code}` ? dc : t('op.err.failed');
    };
    const allowed = () => st.allowed.length ? st.allowed : KINDS.filter((k) => ctx.mayOp(k));

    /* ------------------------------------------------------- Окно */

    function ensureDialog() {
      if (dlg) return dlg;
      dlg = document.createElement('dialog');
      dlg.id = 'op-dialog';
      dlg.className = 'sheet op-sheet';
      dlg.addEventListener('close', () => { st.open = false; stopPoll(); flushSave(); ctx.onClosed?.(); });
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('change', onChange);
      dlg.addEventListener('input', onInput);
      document.body.appendChild(dlg);
      return dlg;
    }

    async function open() {
      ensureDialog();
      st.open = true;
      st.msg = null;
      st.done = null;
      if (!dlg.open) dlg.showModal();
      await loadList();
      // Одна открытая (например, начатая на телефоне) — сразу она; несколько — список; нет — новая
      if (st.draft && st.drafts.some((d) => d.id === st.draft.id)) await openDraft(st.draft.id);
      else if (st.drafts.length === 1) await openDraft(st.drafts[0].id);
      else if (st.drafts.length > 1) { st.view = 'list'; st.draft = null; }
      else { st.view = 'draft'; st.draft = null; }
      render();
    }

    async function loadList() {
      try {
        const r = await api('/op/drafts');
        st.drafts = r.drafts;
        st.allowed = r.allowed;
      } catch { /* список не нужен для новой операции */ }
    }

    async function openDraft(id) {
      st.draft = (await api(`/op/draft?id=${id}`)).draft;
      st.view = 'draft';
      st.remote = false;
      startPoll();
    }

    function render() {
      if (!dlg) return;
      // Бронь: техника и даты известны — цена по «Прайсу» (один раз на каждую новую пару)
      const bf = st.view === 'draft' && !st.done ? st.draft?.form : null;
      if (bf?.kind === 'booking') {
        const key = `${bf.vehicleId}|${bf.bookFrom}|${bf.bookTo}`;
        if (key !== st.bookKey) { st.bookKey = key; st.bookQuote = null; setTimeout(bookingQuote, 0); }
      }
      const body = st.view === 'list' ? listHtml() : st.done ? doneHtml() : draftHtml();
      dlg.innerHTML = `<div class="sheet__body op">
        <div class="sheet__head"><div><div class="muted">${esc(t('op.subtitle'))}</div><h2>＋ ${esc(t('op.title'))}</h2></div>
          <button type="button" class="icon-btn icon-btn--plain" data-op-close aria-label="${esc(t('vh.close'))}">×</button></div>
        ${st.msg ? `<p class="md-status is-${st.msg.kind === 'error' ? 'error' : 'ok'}" role="status">${esc(st.msg.text)}</p>` : ''}
        ${body}
      </div>`;
    }

    /* --------------------------------------------------- Список черновиков */

    function kindLabel(kind) { return kind && KINDS.includes(kind) ? `${ICON[kind]} ${t(`op.kind.${kind}`)}` : `🤖 ${t('op.kind.auto')}`; }

    function listHtml() {
      const rows = st.drafts.map((d) => `<button type="button" class="op-draft" data-op-draft="${d.id}">
        <span><b>${esc(kindLabel(d.form?.kind || d.proposal?.kind || d.hint))}</b> <span class="muted jr-small">${esc(ctx.dateTime(d.updatedAt))}</span></span>
        <span class="muted jr-small">📷 ${d.photos.length}${d.note ? ` · ${esc(d.note.slice(0, 40))}` : ''}${d.proposal ? ` · ✓ ${esc(t('op.recognized'))}` : ''}</span>
      </button>`).join('');
      return `<p class="muted jr-small">${esc(t('op.listHint'))}</p>
        <div class="op-drafts">${rows}</div>
        <button type="button" class="btn btn--primary" data-op-new>＋ ${esc(t('op.new'))}</button>`;
    }

    /* --------------------------------------------------------- Черновик */

    function draftHtml() {
      const d = st.draft;
      const hint = d?.hint || null;
      const kinds = allowed();
      const chips = [`<button type="button" class="chip" data-op-hint="" aria-pressed="${!hint}">🤖 ${esc(t('op.kind.auto'))}</button>`,
        ...kinds.map((k) => `<button type="button" class="chip" data-op-hint="${k}" aria-pressed="${hint === k}">${ICON[k]} ${esc(t(`op.kind.${k}`))}</button>`)].join('');
      const photos = (d?.photos || []).map((p) => `<figure class="dc-thumb"><img src="/api/staff/op/draft/photo?id=${d.id}&i=${p.i}&k=${p.key}" alt="" loading="lazy">
        <button type="button" class="icon-btn" data-op-photodel="${p.i}" aria-label="${esc(t('dc.delete'))}">✕</button></figure>`).join('');
      const p = d?.proposal;
      const busy = Boolean(st.busy);
      return `${st.drafts.length ? `<button type="button" class="link jr-small op-back" data-op-list>← ${esc(t('op.all'))} (${st.drafts.length})</button>` : ''}
        ${st.remote ? `<p class="op-remote">🔄 ${esc(t('op.remote'))} <button type="button" class="link" data-op-reload>${esc(t('op.reload'))}</button></p>` : ''}
        <div class="chips op-kinds" role="group">${chips}</div>
        <div class="op-photos">
          ${photos ? `<div class="dc-thumbs">${photos}</div>` : `<p class="muted jr-small">${esc(t('op.photosHint'))}</p>`}
          <div class="dc-actions">
            <label class="btn btn--small${busy ? ' is-disabled' : ''}"><span>📷 ${esc(t('op.camera'))}</span><input type="file" accept="image/*" capture="environment" data-op-files hidden></label>
            <label class="btn btn--small${busy ? ' is-disabled' : ''}"><span>🖼 ${esc(t('op.gallery'))}</span><input type="file" accept="image/*" multiple data-op-files hidden></label>
            ${st.uploading ? `<span class="muted jr-small">⏳ ${esc(st.uploading)}</span>` : ''}
          </div>
        </div>
        <label class="field"><span>${esc(t('op.note'))}</span><textarea class="search op-note" rows="2" data-op-note placeholder="${esc(t('op.noteHint'))}">${esc(d?.note || '')}</textarea></label>
        <div class="dc-actions">
          <button type="button" class="btn btn--primary btn--small" data-op-run${busy || !(d?.photos?.length || d?.note) ? ' disabled' : ''}>🤖 ${esc(t('op.run'))}</button>
          ${hint && hint !== 'issue' && !p ? `<button type="button" class="btn btn--small" data-op-manual${busy ? ' disabled' : ''}>✍️ ${esc(t('op.manual'))}</button>` : ''}
          ${hint === 'issue' && !p ? `<button type="button" class="btn btn--small" data-op-issue${busy ? ' disabled' : ''}>📄 ${esc(t('op.openContract'))}</button>` : ''}
        </div>
        ${st.busy === 'ai' ? `<p class="dc-ai-busy">⏳ ${esc(t('dc.ai.busy'))}</p>` : ''}
        ${p ? proposalHtml(p) : ''}
        ${d ? `<p class="op-foot"><button type="button" class="link jr-small dc-del" data-op-cancel>🗑 ${esc(t('op.cancel'))}</button>
          <span class="muted jr-small">🔒 ${esc(t('op.private'))}</span></p>` : ''}`;
    }

    function proposalHtml(p) {
      const f = st.draft.form || {};
      const kind = f.kind || p.kind;
      const head = `${p.manual ? '' : `<p class="op-ai">🤖 ${esc(t('op.aiSays', { kind: t(`op.kind.${kind}`) }))}${p.model ? ` <span class="muted jr-small">${esc(String(p.usd ?? ''))} $</span>` : ''}</p>`}
        ${(p.warnings || []).length ? `<ul class="dc-ai-warn">${p.warnings.map((w) => `<li>⚠️ ${esc(w)}</li>`).join('')}</ul>` : ''}`;
      if (kind === 'unknown' || !KINDS.includes(kind)) return `${head}<p class="warn">${esc(t('op.unknown'))}</p>`;
      if (!allowed().includes(kind)) return `${head}<p class="warn">${esc(t('op.notAllowed'))}</p>`;
      if (kind === 'issue') return `${head}${issueHtml(p)}`;
      const FORMS = { booking: bookingHtml, return: returnHtml, swap: swapHtml, extend: extendHtml, service: serviceHtml, expense: expenseHtml, income: incomeHtml, deposit_refund: refundHtml, payout: payoutHtml };
      const form = FORMS[kind](p, f);
      return `${head}<form class="op-form" data-op-form data-nodraft novalidate>${form}
        <div class="dc-actions"><button type="submit" class="btn btn--primary"${st.busy ? ' disabled' : ''}>✓ ${esc(t('op.confirm'))}</button></div></form>`;
    }

    const unsure = (name) => (st.draft?.proposal?.unsure || []).includes(name) ? ' op-unsure' : '';
    const fld = (label, control, cls = '') => `<label class="field ${cls}"><span>${esc(label)}</span>${control}</label>`;
    const inp = (path, value, attrs = '', u = '') => `<input class="search${u}" data-op-f="${path}" value="${esc(value ?? '')}" ${attrs}>`;
    const fuelSel = (path, value) => `<select class="search" data-op-f="${path}"><option value="">—</option>${Array.from({ length: 9 }, (_, i) => `<option value="${i}"${String(value) === String(i) ? ' selected' : ''}>${i}/8</option>`).join('')}</select>`;

    function vehicleSel(path, selected, freeFirst = false) {
      const list = vehicles().slice().sort((a, b) => vName(a).localeCompare(vName(b)));
      const free = freeFirst && ctx.freeToday ? new Set(ctx.freeToday().map((x) => x.vehicleId)) : null;
      if (free) list.sort((a, b) => Number(free.has(b.id)) - Number(free.has(a.id)));
      return `<select class="search" data-op-f="${path}" data-op-vehicle><option value="">${esc(t('dc.pickVehicle'))}</option>
        ${list.map((v) => `<option value="${v.id}"${String(v.id) === String(selected) ? ' selected' : ''}>${esc(vName(v))} · ${esc(v.plate)}${free ? (free.has(v.id) ? ' ✓' : ` · ${t('op.busyNow')}`) : ''}</option>`).join('')}</select>`;
    }

    function contractLine(p) {
      const c = p.contract;
      if (!st.draft.form?.vehicleId) return '';
      if (!c) return `<p class="muted jr-small">📄 ${esc(t('op.noContract'))}</p>`;
      return `<p class="op-contract">📄 <b>${esc(c.number)}</b> · ${esc(c.name || '—')}${c.phone ? ` · ${esc(c.phone)}` : ''} · ${esc(dm(c.from))}–${esc(dm(c.to))}${c.deposit ? ` · ${esc(t('op.deposit'))} ${esc(ctx.money(c.deposit))}` : ''}</p>`;
    }
    function statusLine(p) {
      if (!p.holder) return '';
      return `<p class="muted jr-small">${p.holder.kind === 'rent' ? '🔴' : '🟠'} ${esc(t(p.holder.kind === 'rent' ? 'op.inRent' : 'op.booked', { to: dm(p.holder.to), from: dm(p.holder.from), name: p.renter?.name || '' }))}</p>`;
    }

    function moneyRows(path, list, label) {
      const rows = (list || []).map((x, i) => `<div class="op-row">
        ${inp(`${path}.${i}.text`, x.text, `placeholder="${esc(label)}"`)}${inp(`${path}.${i}.thb`, x.thb || '', 'inputmode="numeric" placeholder="฿"')}
        <button type="button" class="icon-btn icon-btn--plain" data-op-rowdel="${path}.${i}" aria-label="${esc(t('dc.delete'))}">✕</button></div>`).join('');
      return `${rows}<button type="button" class="link jr-small" data-op-rowadd="${path}">＋ ${esc(label)}</button>`;
    }

    function returnHtml(p, f) {
      const eq = (p.contract?.equipment || []).map((e, i) => e.given ? `<label class="mk-check"><input type="checkbox" data-op-f="equipment.${i}"${f.equipment?.[i] !== false ? ' checked' : ''}> ${esc(e.label)}</label>` : '').join('');
      return `<div class="dc-grid">
          ${fld(t('dc.vehicle'), vehicleSel('vehicleId', f.vehicleId), 'dc-wide')}
        </div>${statusLine(p)}${contractLine(p)}
        <div class="dc-grid">
          ${fld(t('op.at'), inp('at', f.at, 'type="datetime-local"'), 'dc-span2')}
          ${fld(t('dc.mileage'), inp('mileage', f.mileage, 'inputmode="numeric"', unsure('mileage')))}${fld(t('dc.fuel'), fuelSel('fuel', f.fuel))}
        </div>
        ${eq ? `<div class="op-sub"><b>${esc(t('op.equipment'))}</b><div class="dc-eq">${eq}</div></div>` : ''}
        <div class="op-sub"><b>${esc(t('op.damages'))}</b>${moneyRows('damages', f.damages, t('op.damage'))}</div>
        <div class="op-sub"><b>${esc(t('op.deductions'))}</b>${moneyRows('deductions', f.deductions, t('op.deduction'))}</div>
        ${refundFields(f)}`;
    }

    const paySel = (path, value) => `<select class="search" data-op-f="${path}"><option value="">—</option>${METHODS.map((m) => `<option value="${m}"${value === m ? ' selected' : ''}>${esc(t(`op.pay.${m}`))}</option>`).join('')}</select>`;
    const refundFields = (f) => `<div class="dc-grid">${fld(t('op.refundAmount'), inp('refundAmount', f.refundAmount, 'inputmode="numeric" placeholder="฿"'))}${fld(t('op.method'), paySel('refundPay', f.refundPay))}</div>`;

    /** Продление: новая дата возврата, сутки, доплата — сразу видно, сколько */
    function extendHtml(p, f) {
      const end = p.contract?.to ? String(p.contract.to).slice(0, 10) : '';
      const days = end && /^\d{4}-\d{2}-\d{2}$/.test(f.newTo || '') ? Math.round((Date.parse(`${f.newTo}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`)) / 86400000) : null;
      const auto = days > 0 && Number(f.perDay) > 0 ? days * Number(f.perDay) : null;
      return `<div class="dc-grid">${fld(t('dc.vehicle'), vehicleSel('vehicleId', f.vehicleId), 'dc-wide')}</div>${statusLine(p)}${contractLine(p)}
        <div class="dc-grid">
          ${fld(t('op.newTo'), inp('newTo', f.newTo, `type="date"${end ? ` min="${end}"` : ''}`, unsure('to')))}
          ${fld(t('dc.perDay'), inp('perDay', f.perDay, 'inputmode="numeric"'))}
          ${fld(t('op.extraPrice'), inp('extraPrice', f.extraPrice ?? '', `inputmode="numeric" placeholder="${auto ? esc(ctx.money(auto)) : '฿'}"`))}
        </div>
        <p class="muted jr-small" data-op-extinfo>${days > 0 ? esc(t('op.extInfo', { days, sum: auto ? ctx.money(auto) : '—' })) : esc(t('op.extHint'))}</p>
        <div class="dc-grid">${fld(t('op.paidNow'), inp('paid', f.paid, 'inputmode="numeric" placeholder="฿"'))}${fld(t('op.method'), paySel('payMethod', f.payMethod))}</div>`;
    }

    /** Бронь: техника на будущие даты, клиент (из базы или вручную), предоплата */
    function bookingHtml(p, f) {
      const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
      return `<div class="dc-grid">${fld(t('dc.vehicle'), vehicleSel('vehicleId', f.vehicleId), 'dc-wide')}</div>${statusLine(p)}
        <div class="dc-grid">
          ${fld(t('op.bookFrom'), inp('bookFrom', f.bookFrom, `type="date" min="${today}"`, unsure('from')))}
          ${fld(t('op.bookTo'), inp('bookTo', f.bookTo, `type="date" min="${today}"`, unsure('to')))}
        </div>
        ${ctx.pick ? ctx.pick.clientBox('op-client', t('pick.client')) : ''}
        <div class="dc-grid">
          ${fld(t('op.clientName'), inp('clientName', f.clientName, 'autocomplete="off"', unsure('name')))}
          ${fld(t('dc.phone'), inp('clientPhone', f.clientPhone, 'type="tel" autocomplete="off"', unsure('phone')))}
        </div>
        <div class="dc-grid">
          ${fld(t('op.total'), inp('total', f.total, 'inputmode="numeric" placeholder="฿"'))}
          ${fld(t('op.prepaid'), inp('paid', f.paid, 'inputmode="numeric" placeholder="฿"'))}
          ${fld(t('op.method'), paySel('payMethod', f.payMethod))}
        </div>
        <p class="muted jr-small" data-op-bookinfo>${esc(bookInfoText(f))}</p>
        ${fld(t('op.bookNote'), inp('note', f.note))}`;
    }
    const amount = (v) => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0;
    /** Под суммой: цена по «Прайсу» и сколько останется взять при выдаче */
    function bookInfoText(f) {
      const parts = [];
      if (st.bookQuote?.total) parts.push(t('op.bookQuote', { days: st.bookQuote.days, sum: ctx.money(st.bookQuote.total) }));
      else if (st.bookQuote) parts.push(t('op.bookNoPrice'));
      if (amount(f.total) > 0) parts.push(t('op.bookLeft', { sum: ctx.money(Math.max(0, amount(f.total) - amount(f.paid))) }));
      return parts.join(' · ') || t('op.bookHint');
    }
    function bookInfo() {
      const box = dlg?.querySelector('[data-op-bookinfo]');
      if (box && st.draft?.form) box.textContent = bookInfoText(st.draft.form);
    }
    /** Цена брони по «Прайсу»: подставляем, пока сумму не вписали руками */
    async function bookingQuote() {
      const f = st.draft?.form;
      if (!f || f.kind !== 'booking' || !f.vehicleId || !/^\d{4}-\d{2}-\d{2}$/.test(f.bookFrom || '') || !/^\d{4}-\d{2}-\d{2}$/.test(f.bookTo || '') || f.bookTo < f.bookFrom) return;
      try {
        const r = await api(`/op/quote?vehicleId=${f.vehicleId}&from=${f.bookFrom}&to=${f.bookTo}`);
        st.bookQuote = r.quote;
        if (r.quote?.total && (!amount(f.total) || f.totalAuto)) {
          f.total = String(r.quote.total);
          f.totalAuto = true;
          const el = dlg?.querySelector('[data-op-f="total"]');
          if (el) el.value = f.total;
          st.dirty = true;
          scheduleSave();
        }
        bookInfo();
      } catch { /* сумму впишут вручную */ }
    }
    // Клиента выбрали из базы — имя и телефон в форму (без перерисовки: остаётся отметка «выбран»)
    ctx.pick?.on('op-client', (c) => {
      const f = st.draft?.form;
      if (!f) return;
      f.clientName = c.name || '';
      f.clientPhone = c.phone || '';
      for (const k of ['clientName', 'clientPhone']) {
        const el = dlg?.querySelector(`[data-op-f="${k}"]`);
        if (el) { el.value = f[k]; el.classList.remove('op-unsure'); }
      }
      st.dirty = true;
      scheduleSave();
    });

    /** Приход: оплата аренды, доп. услуг, залог, компенсация ущерба */
    function incomeHtml(p, f) {
      const i = f.income || {};
      return `<div class="dc-grid">
          ${fld(t('op.amount'), inp('income.amount', i.amount, 'inputmode="decimal"', unsure('amount')))}
          ${fld(t('op.currency'), `<select class="search" data-op-f="income.currency">${CURRENCIES.map((c) => `<option${(i.currency || 'THB') === c ? ' selected' : ''}>${c}</option>`).join('')}</select>`)}
          ${fld(t('op.category'), `<select class="search" data-op-f="income.category"><option value="">—</option>${INCOME_CATEGORIES.map((c) => `<option value="${c}"${i.category === c ? ' selected' : ''}>${esc(t(`op.inc.${c}`))}</option>`).join('')}</select>`)}
          ${fld(t('op.method'), paySel('income.method', i.method))}
          ${fld(t('op.payer'), inp('income.payer', i.payer))}
          ${fld(t('op.forVehicle'), vehicleSel('income.vehicleId', i.vehicleId), 'dc-wide')}
          ${fld(t('op.what'), inp('income.note', i.note), 'dc-wide')}
        </div>`;
    }

    /** Возврат залога отдельно от возврата техники */
    function refundHtml(p, f) {
      return `<div class="dc-grid">${fld(t('dc.vehicle'), vehicleSel('vehicleId', f.vehicleId), 'dc-wide')}</div>${contractLine(p)}
        ${refundFields(f)}
        <div class="op-sub"><b>${esc(t('op.deductions'))}</b>${moneyRows('deductions', f.deductions, t('op.deduction'))}</div>
        ${fld(t('op.what'), inp('note', f.note))}`;
    }

    /** Выплата: зарплата, владельцу техники — расход со статьёй и «кому» */
    function payoutHtml(p, f) {
      return `<div class="dc-grid">${fld(t('op.payee'), inp('payee', f.payee), 'dc-wide')}</div>${expenseFields(f, false)}`;
    }

    function swapHtml(p, f) {
      return `<div class="dc-grid">
          ${fld(t('op.oldVehicle'), vehicleSel('vehicleId', f.vehicleId), 'dc-wide')}
        </div>${contractLine(p)}
        <div class="dc-grid">${fld(t('dc.mileage'), inp('mileage', f.mileage, 'inputmode="numeric"', unsure('mileage')))}${fld(t('dc.fuel'), fuelSel('fuel', f.fuel))}</div>
        <div class="dc-grid">${fld(t('op.newVehicle'), vehicleSel('newVehicleId', f.newVehicleId, true), 'dc-wide')}</div>
        <div class="dc-grid">${fld(t('dc.mileage'), inp('newMileage', f.newMileage, 'inputmode="numeric"', unsure('newMileage')))}${fld(t('dc.fuel'), fuelSel('newFuel', f.newFuel))}</div>
        ${fld(t('dc.reason'), inp('reason', f.reason))}`;
    }

    function receiptSel(f) {
      const photos = st.draft?.photos || [];
      if (!photos.length) return '';
      return fld(t('op.receipt'), `<select class="search" data-op-f="receipt"><option value="">—</option>${photos.map((ph) => `<option value="${ph.i}"${String(f.receipt) === String(ph.i) ? ' selected' : ''}>${esc(t('op.photoN', { n: ph.i + 1 }))}</option>`).join('')}</select>`);
    }

    function expenseFields(f, withVehicle) {
      const e = f.expense || {};
      return `<div class="dc-grid">
          ${fld(t('op.amount'), inp('expense.amount', e.amount, 'inputmode="decimal"', unsure('amount')))}
          ${fld(t('op.currency'), `<select class="search" data-op-f="expense.currency">${CURRENCIES.map((c) => `<option${(e.currency || 'THB') === c ? ' selected' : ''}>${c}</option>`).join('')}</select>`)}
          ${fld(t('op.date'), inp('expense.date', e.date, 'type="date"', unsure('date')))}
          ${fld(t('op.category'), `<select class="search${unsure('category')}" data-op-f="expense.category"><option value="">—</option>${CATEGORIES.map((c) => `<option value="${c}"${e.category === c ? ' selected' : ''}>${esc(t(`op.cat.${c}`))}</option>`).join('')}</select>`)}
          ${fld(t('op.method'), `<select class="search" data-op-f="expense.method"><option value="">—</option>${METHODS.map((m) => `<option value="${m}"${e.method === m ? ' selected' : ''}>${esc(t(`op.pay.${m}`))}</option>`).join('')}</select>`)}
          ${fld(t('op.vendor'), inp('expense.vendor', e.vendor))}
          ${withVehicle ? fld(t('op.forVehicle'), vehicleSel('expense.vehicleId', e.vehicleId), 'dc-wide') : ''}
          ${fld(t('op.what'), inp('expense.note', e.note), 'dc-wide')}
          ${receiptSel(f)}
        </div>`;
    }

    function serviceHtml(p, f) {
      const radios = ACTIONS.map((a) => `<label class="mk-radio"><input type="radio" name="op-action" value="${a}" data-op-f="action"${f.action === a ? ' checked' : ''}> ${esc(t(`op.action.${a}`))}</label>`).join('');
      return `<div class="dc-grid">${fld(t('dc.vehicle'), vehicleSel('vehicleId', f.vehicleId), 'dc-wide')}</div>${statusLine(p)}
        <div class="op-sub"><b>${esc(t('op.whatDone'))}</b>${radios}</div>
        <div class="dc-grid">${fld(t('dc.mileage'), inp('mileage', f.mileage, 'inputmode="numeric"', unsure('mileage')))}${fld(t('op.serviceNote'), inp('note', f.note), 'dc-span2')}</div>
        <details class="op-sub"${f.expense?.amount ? ' open' : ''}><summary><b>🧾 ${esc(t('op.serviceCost'))}</b></summary>${expenseFields(f, false)}</details>`;
    }

    function expenseHtml(p, f) {
      return expenseFields(f, true);
    }

    function issueHtml(p) {
      const c = p.contract || {};
      const lines = [];
      if (c.fields?.name) lines.push(`👤 ${esc(c.fields.name)}`);
      lines.push(c.vehicle ? `🚗 ${esc(c.vehicle.model)} · ${esc(c.vehicle.plate)}` : `🚗 ${esc(t('dc.ai.vehicleNone'))}`);
      if (c.booking) lines.push(`📅 ${esc(dm(c.booking.from))} – ${esc(dm(c.booking.to))}`);
      return `<ul class="dc-ai-lines">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
        <p class="muted jr-small">${esc(t('op.issueHint'))}</p>
        <button type="button" class="btn btn--primary" data-op-issue>📄 ${esc(t('op.openContract'))}</button>`;
    }

    function doneHtml() {
      const items = (st.done || []).map((x) => {
        if (x.type === 'doc') return `<li>📄 ${esc(t(`op.done.${x.kind}`, { no: x.number }))}${x.photos ? ` · 📷 ${x.photos}` : ''} <button type="button" class="link jr-small" data-op-opendoc="${x.contractId}">${esc(t('op.openDoc'))}</button></li>`;
        if (x.type === 'status') return `<li>🚗 ${esc(t(`op.done.status.${x.kind}`, { plate: x.plate }))}${x.wa === 'sent' ? ` · 💬 ${esc(t('op.toGroup'))}` : ''}</li>`;
        if (x.type === 'expense') return `<li>🧾 ${esc(t('op.done.expense', { sum: ctx.money(x.thb), cat: t(`op.cat.${x.category}`) }))}${x.wa === 'sent' ? ` · 💬 ${esc(t('op.toGroup'))}` : ''}</li>`;
        if (x.type === 'mileage' || x.type === 'maintenance') return `<li>🔧 ${esc(t(`op.done.${x.type}`, { plate: x.plate, km: x.mileage ?? '' }))}</li>`;
        if (x.type === 'money') return `<li>${x.dir === 'in' ? '💰' : '💵'} ${esc(t(`op.done.money.${x.kind}`, { sum: ctx.money(x.thb) }))}${x.wa === 'sent' ? ` · 💬 ${esc(t('op.toGroup'))}` : ''}</li>`;
        return '';
      }).join('');
      return `<p class="md-status is-ok">✓ ${esc(t('op.doneTitle'))}</p><ul class="op-done">${items}</ul>
        <div class="dc-actions"><button type="button" class="btn btn--primary" data-op-new>＋ ${esc(t('op.new'))}</button><button type="button" class="btn" data-op-close>${esc(t('vh.close'))}</button></div>`;
    }

    /* ------------------------------------------------- Сохранение и связь */

    async function ensureDraft() {
      if (st.draft) return st.draft;
      st.draft = (await api('/op/draft', { body: { hint: st.pendingHint || null } })).draft;
      st.pendingHint = null;
      startPoll();
      return st.draft;
    }

    function setDraft(d) {
      st.draft = d;
      st.remote = false;
    }

    /** Поля формы → на сервер (через 0,6 с после последней правки) */
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSave, 600);
    }
    async function flushSave() {
      clearTimeout(saveTimer);
      saveTimer = null;
      const d = st.draft;
      if (!d || !st.dirty) return;
      st.dirty = false;
      try {
        setDraft((await api('/op/draft/update', { body: { id: d.id, form: d.form, version: d.version } })).draft);
      } catch (err) {
        if (err.code === 'draft_changed') { st.remote = true; render(); }
      }
    }

    function startPoll() {
      stopPoll();
      pollTimer = setInterval(async () => {
        if (!st.open || !st.draft || st.busy || document.hidden) return;
        try {
          const fresh = (await api(`/op/draft?id=${st.draft.id}`)).draft;
          if (fresh.version === st.draft.version) return;
          if (fresh.status !== 'open') { st.draft = null; st.view = 'list'; await loadList(); st.msg = { kind: 'ok', text: t('op.closedElsewhere') }; render(); return; }
          // Что-то поменяли на другом устройстве: если здесь сейчас не печатают — показываем сразу
          const typing = dlg.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
          if (typing || saveTimer || st.dirty) { st.remote = true; render(); return; }
          setDraft(fresh);
          render();
        } catch { /* следующая попытка */ }
      }, POLL_MS);
    }
    function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

    async function act(kind, fn) {
      st.busy = kind;
      st.msg = null;
      render();
      try {
        await fn();
      } catch (err) {
        st.msg = { kind: 'error', text: errText(err) };
      }
      st.busy = null;
      render();
    }

    async function addFiles(files) {
      await ensureDraft();
      let n = 0;
      for (const file of files) {
        st.uploading = t('op.uploading', { i: ++n, n: files.length });
        render();
        try {
          const blob = await ctx.prepareShot(file);
          setDraft((await ctx.uploadImage(`/op/draft/photo?id=${st.draft.id}`, blob)).draft);
        } catch (err) {
          st.msg = { kind: 'error', text: errText(err) };
        }
      }
      st.uploading = null;
      render();
    }

    /* ------------------------------------------------------- Поля формы */

    function setPath(obj, pathStr, value) {
      const parts = pathStr.split('.');
      let o = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
        if (o[k] === undefined || o[k] === null) o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        o = o[k];
      }
      const last = parts[parts.length - 1];
      o[/^\d+$/.test(last) ? Number(last) : last] = value;
    }
    function getPath(obj, pathStr) { return pathStr.split('.').reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), obj); }

    function readControl(el) {
      if (el.type === 'checkbox') return el.checked;
      if (el.type === 'radio') return el.value;
      if (['receipt'].includes(el.dataset.opF)) return el.value === '' ? null : Number(el.value);
      if (el.dataset.opVehicle !== undefined) return el.value ? Number(el.value) : null;
      return el.value;
    }

    /** Выбрали технику вручную — подтянуть её статус и договор */
    async function vehicleChanged(pathStr, id) {
      if (pathStr !== 'vehicleId' || !id) return;
      try {
        const v = await api(`/op/vehicle?id=${id}&lang=${lang()}`);
        const p = st.draft.proposal;
        Object.assign(p, { vehicle: v.vehicle, status: v.status, holder: v.holder, renter: v.renter, contract: v.contract });
        st.draft.form.contractId = v.contract?.id || null;
        if (!st.draft.form.perDay && v.contract?.perDay) st.draft.form.perDay = v.contract.perDay;
        st.draft.form.equipment = (v.contract?.equipment || []).map((e) => e.given);
        if (!st.draft.form.mileage && v.vehicle?.mileage) st.draft.form.mileage = String(v.vehicle.mileage);
        st.dirty = true;
        scheduleSave();
        render();
        if (st.draft.form.kind === 'booking') bookingQuote();
      } catch { /* без подсказки */ }
    }

    /* ---------------------------------------------------------- События */

    function onClick(event) {
      const el = event.target;
      if (el === dlg) { dlg.close(); return; }
      if (el.closest('[data-op-close]')) { dlg.close(); return; }
      const draftBtn = el.closest('[data-op-draft]');
      if (draftBtn) { act('load', () => openDraft(Number(draftBtn.dataset.opDraft))); return; }
      if (el.closest('[data-op-new]')) { stopPoll(); st.draft = null; st.done = null; st.view = 'draft'; st.msg = null; render(); return; }
      if (el.closest('[data-op-list]')) { flushSave(); stopPoll(); act('load', async () => { await loadList(); st.view = 'list'; st.draft = null; }); return; }
      if (el.closest('[data-op-reload]')) { act('load', () => openDraft(st.draft.id)); return; }
      const hintBtn = el.closest('[data-op-hint]');
      if (hintBtn) {
        const hint = hintBtn.dataset.opHint || null;
        if (!st.draft) { st.pendingHint = hint; act('save', async () => { await ensureDraft(); setDraft((await api('/op/draft/update', { body: { id: st.draft.id, hint } })).draft); }); return; }
        // Уже распознано, но это другая операция — та же форма, другой вид (поля и техника остаются)
        const form = st.draft.form && hint && hint !== st.draft.form.kind ? { ...st.draft.form, kind: hint } : undefined;
        act('save', async () => setDraft((await api('/op/draft/update', { body: { id: st.draft.id, hint, ...(form ? { form } : {}) } })).draft));
        return;
      }
      const del = el.closest('[data-op-photodel]');
      if (del) { act('save', async () => setDraft((await api('/op/draft/photo/delete', { body: { id: st.draft.id, index: Number(del.dataset.opPhotodel) } })).draft)); return; }
      if (el.closest('[data-op-run]')) {
        act('ai', async () => { await flushNote(); setDraft((await api('/op/draft/recognize', { body: { id: st.draft.id, lang: lang() } })).draft); });
        return;
      }
      if (el.closest('[data-op-manual]')) { act('save', async () => setDraft((await api('/op/draft/manual', { body: { id: st.draft.id, kind: st.draft.hint } })).draft)); return; }
      if (el.closest('[data-op-issue]')) {
        // Выдача — дальше договор: данные с фото уже в нём, фото техники — в «Фото при выдаче»
        const d = st.draft;
        dlg.close();
        ctx.newContractFromDraft(d);
        return;
      }
      if (el.closest('[data-op-cancel]')) {
        if (!window.confirm(t('op.cancelAsk'))) return;
        act('save', async () => { await api('/op/draft/cancel', { body: { id: st.draft.id } }); stopPoll(); st.draft = null; await loadList(); st.view = st.drafts.length ? 'list' : 'draft'; });
        return;
      }
      const rowAdd = el.closest('[data-op-rowadd]');
      if (rowAdd) {
        const list = getPath(st.draft.form, rowAdd.dataset.opRowadd) || [];
        list.push({ text: '', thb: '' });
        setPath(st.draft.form, rowAdd.dataset.opRowadd, list);
        st.dirty = true; scheduleSave(); render();
        return;
      }
      const rowDel = el.closest('[data-op-rowdel]');
      if (rowDel) {
        const parts = rowDel.dataset.opRowdel.split('.');
        const i = Number(parts.pop());
        getPath(st.draft.form, parts.join('.'))?.splice(i, 1);
        st.dirty = true; scheduleSave(); render();
        return;
      }
      const openDoc = el.closest('[data-op-opendoc]');
      if (openDoc) { dlg.close(); ctx.openContract(Number(openDoc.dataset.opOpendoc)); }
    }

    function onInput(event) {
      const el = event.target;
      if (el.matches('[data-op-note]')) {
        clearTimeout(noteTimer);
        noteTimer = setTimeout(flushNote, 800);
        return;
      }
      if (el.dataset.opF && st.draft?.form && el.tagName !== 'SELECT' && el.type !== 'checkbox' && el.type !== 'radio') {
        setPath(st.draft.form, el.dataset.opF, readControl(el));
        el.classList.remove('op-unsure');
        st.dirty = true;
        scheduleSave();
        if (['newTo', 'perDay'].includes(el.dataset.opF)) extendInfo();
        if (el.dataset.opF === 'total') st.draft.form.totalAuto = false;
        if (['total', 'paid'].includes(el.dataset.opF)) bookInfo();
        if (['bookFrom', 'bookTo'].includes(el.dataset.opF)) { clearTimeout(quoteTimer); quoteTimer = setTimeout(bookingQuote, 400); }
      }
    }

    /** Продление: сколько суток и сколько к доплате — без перерисовки формы */
    function extendInfo() {
      const box = dlg?.querySelector('[data-op-extinfo]');
      const f = st.draft?.form;
      const end = st.draft?.proposal?.contract?.to ? String(st.draft.proposal.contract.to).slice(0, 10) : '';
      if (!box || !f) return;
      const days = end && /^\d{4}-\d{2}-\d{2}$/.test(f.newTo || '') ? Math.round((Date.parse(`${f.newTo}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`)) / 86400000) : null;
      const auto = days > 0 && Number(f.perDay) > 0 ? days * Number(f.perDay) : null;
      box.textContent = days > 0 ? t('op.extInfo', { days, sum: auto ? ctx.money(auto) : '—' }) : t('op.extHint');
      const extra = dlg.querySelector('[data-op-f="extraPrice"]');
      if (extra) extra.placeholder = auto ? ctx.money(auto) : '฿';
    }

    async function flushNote() {
      clearTimeout(noteTimer);
      const el = dlg?.querySelector('[data-op-note]');
      if (!el) return;
      const note = el.value.trim();
      if ((st.draft?.note || '') === note) return;
      if (!st.draft && !note) return;
      await ensureDraft();
      try { setDraft((await api('/op/draft/update', { body: { id: st.draft.id, note } })).draft); } catch { /* в следующий раз */ }
      const run = dlg.querySelector('[data-op-run]');
      if (run) run.disabled = Boolean(st.busy) || !(st.draft.photos.length || st.draft.note);
    }

    function onChange(event) {
      const el = event.target;
      if (el.matches('[data-op-files]')) {
        const files = [...el.files];
        el.value = '';
        if (files.length) addFiles(files);
        return;
      }
      if (el.dataset.opF && st.draft?.form && (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio')) {
        const value = readControl(el);
        setPath(st.draft.form, el.dataset.opF, value);
        st.dirty = true;
        scheduleSave();
        if (el.dataset.opVehicle !== undefined) vehicleChanged(el.dataset.opF, value);
      }
    }

    // Подтвердить
    function onSubmit(event) {
      if (!event.target.matches?.('#op-dialog [data-op-form]')) return;
      event.preventDefault();
      clearTimeout(saveTimer);
      act('apply', async () => {
        const r = await api('/op/draft/apply', { body: { id: st.draft.id, form: st.draft.form } });
        st.done = r.done;
        stopPoll();
        st.draft = null;
        await loadList();
        ctx.onApplied?.(r);
      });
    }
    document.addEventListener('submit', onSubmit, true);

    /** Сколько у меня открытых операций — для значка на кнопке */
    async function count() {
      try {
        const r = await api('/op/drafts');
        st.drafts = r.drafts;
        st.allowed = r.allowed;
        return r.drafts.length;
      } catch {
        return 0;
      }
    }

    /**
     * Бронь из «Парка» (статус «Бронь»): сразу форма брони — техника, даты и клиент уже
     * подставлены, остаётся сумма и предоплата
     */
    async function openBooking(prefill = {}) {
      ensureDialog();
      st.open = true;
      st.msg = null;
      st.done = null;
      st.bookQuote = null;
      if (!dlg.open) dlg.showModal();
      st.view = 'draft';
      st.draft = null;
      st.pendingHint = 'booking';
      render();
      await act('save', async () => {
        await ensureDraft();
        setDraft((await api('/op/draft/manual', { body: { id: st.draft.id, kind: 'booking' } })).draft);
        const f = st.draft.form;
        for (const k of ['vehicleId', 'bookFrom', 'bookTo', 'clientName', 'clientPhone']) if (prefill[k]) f[k] = prefill[k];
        st.dirty = true;
        await flushSave();
      });
      if (prefill.vehicleId) await vehicleChanged('vehicleId', Number(prefill.vehicleId));
    }

    return { open, openBooking, count, isOpen: () => st.open };
  }

  window.STAFF_OP = { create };
})();
