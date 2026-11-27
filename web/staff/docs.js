/*
 * Вкладка «Документы»: договор аренды (клиент, техника, даты, выдача, оплата),
 * к нему — фото при выдаче, квитанции, акт возврата, дополнения. Каждый
 * документ — PDF (печать), подпись пальцем на экране или по ссылке клиенту,
 * отправка PDF клиенту в WhatsApp. Сервер — documents.js. Тексты — i18n (dc.*).
 */
(function () {
  'use strict';

  const FUEL = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const KIND_ICON = { contract: '📄', photos: '📷', return: '↩️', receipt: '🧾', addendum: '➕' };

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = { view: 'list', list: null, q: '', failed: false, id: null, one: null, pre: null, form: null, msg: null, busy: false, sub: null, photoCaption: 'front', ai: { files: [], busy: false, result: null, error: null } };
    const uiLang = () => (['ru', 'th'].includes(ctx.lang()) ? ctx.lang() : 'en');
    const label = (x) => (x ? x[uiLang()] || x.en || '' : '');
    const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
    const dt = (v) => (v ? `${dmy(v.slice(0, 10))} ${v.slice(11, 16)}` : '');
    const money = (n) => (n || n === 0 ? ctx.money(n) : '—');
    const canEdit = () => Boolean(st.list?.canEdit);
    const errText = (err) => {
      const own = t(`dc.err.${err?.code}`);
      return own === `dc.err.${err?.code}` ? t('dc.err.failed') : own;
    };
    const days = (from, to) => (from && to && to.slice(0, 10) >= from.slice(0, 10)
      ? Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86400000) + 1 : '');

    /* ------------------------------------------------------------ Данные */

    async function load() {
      try {
        const [list, pre] = await Promise.all([api(`/docs${st.q ? `?q=${encodeURIComponent(st.q)}` : ''}`), st.pre ? st.pre : api('/docs/prefill')]);
        Object.assign(st, { list, pre, failed: false });
        if (st.view === 'edit' && st.id) await loadOne(st.id, false);
      } catch {
        st.failed = true;
      }
      ctx.rerender();
    }

    async function loadOne(id, rerender = true) {
      st.one = await api(`/docs/one?id=${id}`);
      st.id = st.one.contract.id;
      st.form = { ...st.one.contract.data, lang: st.one.contract.lang };
      if (rerender) ctx.rerender();
    }

    function backToList() {
      st.view = 'list'; st.id = null; st.one = null; st.sub = null; st.msg = null;
      refreshList().then(() => ctx.rerender());
    }

    /** Новый договор; prefill — из «Парка» (техника, даты) или из карточки клиента (клиент) */
    function openNew(prefill = {}) {
      if (st.view !== 'edit') ctx.pushStep?.();
      const now = new Date(Date.now() + 7 * 3600000).toISOString();
      st.view = 'edit';
      st.id = null;
      st.one = null;
      st.sub = null;
      st.msg = null;
      st.quoteNote = null;
      resetAi();
      st.form = { lang: uiLang() === 'ru' ? 'ru' : 'en', from: `${now.slice(0, 10)}T12:00`, to: '', equipment: null, fuel: 4, ...prefill, renter: { ...(prefill.renter || {}) } };
      Object.keys(st.form).forEach((k) => { if (st.form[k] === undefined) delete st.form[k]; });
      if (!st.form.from) st.form.from = `${now.slice(0, 10)}T12:00`;
      // Техника уже выбрана — подставим её данные и цену, как только форма появится
      st.pendingQuote = Boolean(prefill.vehicleId);
      ctx.rerender();
    }

    /* ------------------------------------------------------------ Список */

    function statusPills(d) {
      const pills = [];
      pills.push(d.signed.renter ? `<span class="pill pill--free">✍️ ${esc(t('dc.signedClient'))}</span>` : `<span class="pill">${esc(t('dc.notSigned'))}</span>`);
      if (d.sentAt) pills.push(`<span class="pill pill--reserve">💬 ${esc(t('dc.sent'))}</span>`);
      return pills.join(' ');
    }

    function renderList() {
      const l = st.list;
      const cards = l.contracts.map((c) => `
        <button type="button" class="card dc-card" data-dc-open="${c.id}">
          <div class="dc-card__head"><b>${esc(c.number)}</b><span class="muted jr-small">${esc(dmy(c.createdAt?.slice(0, 10)))}</span></div>
          <div>${esc(c.client || t('dc.noClient'))}${c.phone ? ` · <span class="muted">${esc(c.phone)}</span>` : ''}</div>
          <div class="muted">${esc(c.model || '')}${c.plate ? ` · ${esc(c.plate)}` : ''}${c.from ? ` · ${esc(dt(c.from))} – ${esc(dt(c.to))}` : ''}</div>
          <div class="dc-pills">${c.discount ? `<span class="pill ${c.discount.status === 'pending' ? 'pill--reserve' : 'pill--free'}">${c.discount.status === 'pending' ? '⏳ ' : ''}−${esc(c.discount.percent)}%</span> ` : ''}${statusPills(c)}${c.children.map((x) => `<span class="pill">${KIND_ICON[x.kind]} ${esc(t(`dc.kind.${x.kind}`))}${x.kind === 'receipt' || x.kind === 'addendum' ? ` ${esc(x.number.replace(/^.*\//, '/'))}` : ''}</span>`).join(' ')}</div>
        </button>`).join('');
      return `<div class="dc">
        <div class="dc-toolbar">
          ${canEdit() ? `<button type="button" class="btn btn--primary" data-dc-new>＋ ${esc(t('dc.newContract'))}</button>` : ''}
          <input type="search" class="search" data-dc-search placeholder="${esc(t('dc.search'))}" value="${esc(st.q)}" autocomplete="off">
        </div>
        ${l.pdfReady ? '' : `<p class="warn">${esc(t('dc.noPdf'))}</p>`}
        ${cards || `<div class="card empty">${esc(t('dc.empty'))}</div>`}
      </div>`;
    }

    /* ------------------------------------------------------------ Договор */

    const vehicleById = (id) => st.pre?.vehicles.find((v) => String(v.id) === String(id)) || null;
    const typeOf = (vehicleType) => (vehicleType === 'car' ? 'car' : 'bike');

    /** Список техники: filter — номер или модель; на даты нового договора — свободна или занята */
    function vehicleOptions(selected, filter = '', from = st.form?.from, to = st.form?.to) {
      const fq = String(filter || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const fd = fq.replace(/\D/g, '');
      const nameOf = (v) => [v.brand, v.model].filter(Boolean).join(' ');
      const fits = (v) => !fq || nameOf(v).toLowerCase().includes(fq) || (fd.length >= 2 && String(v.plate).replace(/\D/g, '').includes(fd));
      // Выбранная остаётся в списке, даже если не подходит под поиск
      const match = (v) => fits(v) || String(v.id) === String(selected);
      const okDates = !st.id && from && to && to.slice(0, 10) >= from.slice(0, 10) && ctx.freeVehicles;
      const free = okDates ? new Set(ctx.freeVehicles(from.slice(0, 10), to.slice(0, 10)).map((x) => x.vehicleId)) : null;
      const mark = (v) => (!free ? '' : free.has(v.id) ? ' ✓' : ` · ${t('dc.busyOnDates')}`);
      const groups = ['car', 'motorcycle', 'scooter'].map((type) => {
        const list = st.pre.vehicles.filter((v) => (v.type || 'scooter') === type && match(v))
          .sort((a, b) => (free ? Number(free.has(b.id)) - Number(free.has(a.id)) : 0) || nameOf(a).localeCompare(nameOf(b)));
        if (!list.length) return '';
        return `<optgroup label="${esc(t(`dc.type.${type}`))}">${list.map((v) => `<option value="${v.id}"${String(v.id) === String(selected) ? ' selected' : ''}${fits(v) ? '' : ' data-kept'}>${esc(nameOf(v))} · ${esc(v.plate)}${esc(mark(v))}</option>`).join('')}</optgroup>`;
      }).join('');
      return `<option value="">${esc(t(fq && !groups ? 'dc.vehicleNoMatch' : 'dc.pickVehicle'))}</option>${groups}`;
    }

    /** Техника выбрана из «Парка»: модель, номер, цвет и VIN — строкой из карточки */
    function vehicleSummary(f) {
      const missing = [!f.color && t('dc.color').toLowerCase(), !f.vin && 'VIN'].filter(Boolean);
      return `🚗 <b>${esc(f.model || '')}</b> · ${esc(f.plate || '')}${f.color ? ` · ${esc(f.color)}` : ''}${f.vin ? ` · VIN ${esc(f.vin)}` : ''}
        ${missing.length ? `<span class="muted jr-small">${esc(t('dc.vMissing', { what: missing.join(', ') }))}</span>` : ''}
        ${canEdit() ? `<button type="button" class="link jr-small" data-dc-vedit>✎ ${esc(t('dc.vEdit'))}</button>` : ''}`;
    }
    function showVehicleSummary(form) {
      const sum = form.querySelector('[data-dc-vsum]');
      const fields = form.querySelector('[data-dc-vfields]');
      if (!sum || !fields) return;
      const picked = Boolean(form.elements.vehicleId.value);
      const g = (n) => form.elements[n]?.value || '';
      sum.innerHTML = picked ? vehicleSummary({ model: g('model'), plate: g('plate'), color: g('color'), vin: g('vin') }) : '';
      sum.hidden = !picked;
      fields.hidden = picked;
    }

    /** Перестроить список техники в форме (поиск, другие даты) — выбранная остаётся */
    function rebuildVehicles(form) {
      const sel = form?.elements.vehicleId;
      if (!sel) return [];
      sel.innerHTML = vehicleOptions(sel.value, form.querySelector('[data-dc-vfilter]')?.value || '', form.elements.from.value, form.elements.to.value);
      return [...sel.options].filter((o) => o.value && !o.hasAttribute('data-kept'));
    }

    function equipmentHtml(type, list) {
      const items = st.pre.equipment[type] || [];
      const byKey = new Map((list || []).map((e) => [e.key, e]));
      return items.map((it) => {
        const e = byKey.get(it.key);
        const on = e ? e.ok : !it.off;
        return `<label class="mk-check"><input type="checkbox" name="eq_${it.key}"${on ? ' checked' : ''}> ${esc(label(it))}
          ${it.key === 'helmets' ? `<input class="search dc-count" name="helmets" inputmode="numeric" value="${esc(e?.count ?? 2)}" aria-label="${esc(label(it))}">` : ''}</label>`;
      }).join('');
    }

    const fuelSelect = (name, value) => `<select class="search" name="${name}">${FUEL.map((f) => `<option value="${f}"${Number(value) === f ? ' selected' : ''}>${f}/8</option>`).join('')}</select>`;
    const inp = (name, value, attrs = '') => `<input class="search" name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
    const fld = (labelText, control, cls = '') => `<label class="field ${cls}"><span>${esc(labelText)}</span>${control}</label>`;

    function contractForm() {
      const f = st.form;
      const v = vehicleById(f.vehicleId);
      const type = typeOf(v?.type || f.vehicleType);
      const requests = (ctx.requests() || []).filter((r) => !r.archived).slice(0, 40);
      const ro = canEdit() ? '' : ' disabled';
      return `<form class="card dc-form" data-dc-key="contract-${st.id || 'new'}" data-dc-form>
        <fieldset${ro}>
        <div class="dc-row">
          ${fld(t('dc.lang'), `<select class="search" name="lang"><option value="en"${f.lang === 'en' ? ' selected' : ''}>English + ไทย</option><option value="ru"${f.lang === 'ru' ? ' selected' : ''}>Русский + ไทย</option></select>`)}
          ${!st.id && requests.length ? fld(t('dc.fromRequest'), `<select class="search" name="requestId" data-dc-request><option value="">—</option>${requests.map((r) => `<option value="${r.id}"${String(r.id) === String(f.requestId) ? ' selected' : ''}>#${r.id} ${esc(r.clientName || '')} ${r.dateFrom ? `${esc(dmy(r.dateFrom))}–${esc(dmy(r.dateTo))}` : ''} ${esc(r.model || '')}</option>`).join('')}</select>`) : ''}
        </div>
        <h3>🚗 ${esc(t('dc.vehicle'))}</h3>
        <div class="dc-grid">
          ${canEdit() ? fld(`🔎 ${t('dc.vehicleSearch')}`, `<input class="search" type="search" data-dc-vfilter autocomplete="off" enterkeyhint="search" placeholder="${esc(t('dc.vehicleSearchHint'))}">`) : ''}
          ${fld(t('dc.vehicle'), `<select class="search" name="vehicleId" data-dc-vehicle>${vehicleOptions(f.vehicleId)}</select>`, canEdit() ? 'dc-span2' : 'dc-wide')}
        </div>
        <p class="dc-vsum" data-dc-vsum${v ? '' : ' hidden'}>${v ? vehicleSummary(f) : ''}</p>
        <div class="dc-grid" data-dc-vfields${v ? ' hidden' : ''}>
          ${fld(t('dc.model'), inp('model', f.model))}${fld(t('dc.plate'), inp('plate', f.plate))}
          ${fld(t('dc.color'), inp('color', f.color))}${fld('VIN', inp('vin', f.vin))}
        </div>
        <h3>📅 ${esc(t('dc.period'))}</h3>
        <div class="dc-grid">
          ${fld(t('dc.from'), inp('from', f.from, 'type="datetime-local" data-dc-dates'), 'dc-span2')}${fld(t('dc.to'), inp('to', f.to, 'type="datetime-local" data-dc-dates'), 'dc-span2')}
          ${fld(t('dc.pickupPlace'), inp('pickupPlace', f.pickupPlace, `placeholder="${esc(t('dc.placeHint'))}"`))}${fld(t('dc.returnPlace'), inp('returnPlace', f.returnPlace, `placeholder="${esc(t('dc.placeHint'))}"`))}
        </div>
        <h3>👤 ${esc(t('dc.client'))}</h3>
        ${canEdit() && ctx.pick ? ctx.pick.clientBox('dc-client', t('pick.client')) : ''}
        <div class="dc-grid">
          ${fld(t('dc.name'), inp('r_name', f.renter?.name, 'autocomplete="off"'), 'dc-wide')}
          ${fld(t('dc.passport'), inp('r_passport', f.renter?.passport))}${fld(t('dc.nationality'), inp('r_nationality', f.renter?.nationality))}
          ${fld(t('dc.license'), inp('r_license', f.renter?.license))}${fld(t('dc.phone'), inp('r_phone', f.renter?.phone, 'inputmode="tel" placeholder="+66 81 234 5678"'))}
          ${fld(t('dc.address'), inp('r_address', f.renter?.address), 'dc-wide')}
        </div>
        <h3>🔑 ${esc(t('dc.handover'))}</h3>
        <div class="dc-grid">
          ${fld(t('dc.mileage'), inp('mileage', f.mileage ?? v?.mileage ?? '', 'inputmode="numeric"'))}${fld(t('dc.fuel'), fuelSelect('fuel', f.fuel ?? 4))}
        </div>
        <div class="dc-eq" data-dc-eq>${equipmentHtml(type, f.equipment)}</div>
        <h3>💰 ${esc(t('dc.money'))}</h3>
        <div class="dc-grid">
          ${fld(t('dc.days'), `<output class="dc-out" data-dc-days>${esc(days(f.from, f.to))}</output>`)}
          ${fld(t('dc.base'), inp('baseTotal', f.baseTotal ?? '', 'inputmode="numeric" data-dc-money'))}
        </div>
        ${discountFields(f)}
        <div class="dc-grid">
          ${fld(t('dc.perDay'), inp('perDay', f.perDay, 'inputmode="numeric"'))}${fld(t('dc.total'), inp('total', f.total, 'inputmode="numeric"'))}
          ${fld(t('dc.deposit'), inp('deposit', f.deposit, 'inputmode="numeric"'))}${fld(t('dc.paid'), inp('paid', f.paid, 'inputmode="numeric"'))}
          ${fld(t('dc.payMethod'), inp('payMethod', f.payMethod, `placeholder="${esc(t('dc.payHint'))}"`), 'dc-wide')}
        </div>
        <p class="muted jr-small" data-dc-quote>${esc(st.quoteNote || t('dc.priceHint'))}</p>
        ${canEdit() ? `<div class="dc-actions"><button type="submit" class="btn btn--primary">${esc(t(st.id ? 'dc.save' : 'dc.create'))}</button>
          ${st.id && st.one?.contract.signed.renter ? `<span class="muted jr-small">${esc(t('dc.resignNote'))}</span>` : ''}</div>` : ''}
        </fieldset>
      </form>`;
    }

    /* ------------------------------------------------------------ Скидка */

    const PRESETS = [5, 10, 15, 20];
    const discSelect = (d) => {
      if (!d?.kind) return 'none';
      if (d.kind === 'percent' && PRESETS.includes(Number(d.value))) return `p${Number(d.value)}`;
      return d.kind === 'percent' ? 'pct' : d.kind;
    };

    function discountFields(f) {
      const cfg = st.pre.discounts || { reasons: [], other: 'Другое', approvePct: 10 };
      const sel = discSelect(f.discount);
      const opts = [['none', t('dc.discNone')], ...PRESETS.map((p) => [`p${p}`, `${p}%`]), ['pct', t('dc.discPct')], ['amount', t('dc.discAmount')], ['price', t('dc.discPrice')]];
      const custom = ['pct', 'amount', 'price'].includes(sel);
      const reasons = [...cfg.reasons, cfg.other];
      return `<div class="dc-grid dc-disc" data-dc-disc>
        ${fld(t('dc.discount'), `<select class="search" name="discKind" data-dc-money>${opts.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
        <label class="field" data-dc-discvalue${custom ? '' : ' hidden'}><span>${esc(t('dc.discValue'))}</span>${inp('discValue', custom ? f.discount?.value : '', 'inputmode="decimal" data-dc-money')}</label>
        <label class="field" data-dc-discreason${sel === 'none' ? ' hidden' : ''}><span>${esc(t('dc.discReason'))} *</span><select class="search" name="discReason" data-dc-money>
          <option value="">—</option>${reasons.map((r) => `<option${r === f.discount?.reason ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
        <label class="field dc-wide" data-dc-disccomment${sel === 'none' ? ' hidden' : ''}><span>${esc(t('dc.discComment'))}</span>${inp('discComment', f.discount?.comment || '', 'maxlength="200"')}</label>
        <p class="jr-small dc-wide" data-dc-discnote></p>
      </div>`;
    }

    /** Скидка → { kind, value } или null; размер — из списка или своё */
    function readDiscount(form) {
      const sel = form.elements.discKind?.value || 'none';
      if (sel === 'none') return null;
      const value = sel.startsWith('p') && sel !== 'pct' && sel !== 'price' ? Number(sel.slice(1)) : Number(String(form.elements.discValue.value).replace(/[\s,]/g, ''));
      const kind = sel.startsWith('p') && sel !== 'price' ? 'percent' : sel;
      return { kind, value, reason: form.elements.discReason.value, comment: form.elements.discComment.value };
    }

    /** Пересчёт итога на лету: цена по прайсу − скидка; сверх порога — предупреждение об одобрении */
    function recalcMoney(form) {
      const sel = form.elements.discKind?.value || 'none';
      const box = form.querySelector('[data-dc-disc]');
      if (!box) return;
      box.querySelector('[data-dc-discvalue]').hidden = !['pct', 'amount', 'price'].includes(sel);
      box.querySelector('[data-dc-discreason]').hidden = sel === 'none';
      box.querySelector('[data-dc-disccomment]').hidden = sel === 'none';
      const note = box.querySelector('[data-dc-discnote]');
      const d = readDiscount(form);
      // Цены по прайсу нет (вписали вручную) — берём прежний итог как цену без скидки
      if (d && !String(form.elements.baseTotal.value).trim() && String(form.elements.total.value).trim()) form.elements.baseTotal.value = form.elements.total.value;
      const base = Number(String(form.elements.baseTotal.value).replace(/[\s,]/g, ''));
      const nDays = Number(form.querySelector('[data-dc-days]')?.textContent) || 0;
      form.elements.total.readOnly = Boolean(d);
      form.elements.perDay.readOnly = Boolean(d);
      if (!d) {
        note.textContent = '';
        note.className = 'jr-small dc-wide';
        return;
      }
      if (!(base > 0)) { note.textContent = t('dc.err.no_base_price'); note.className = 'jr-small dc-wide warn'; return; }
      let final = d.kind === 'percent' ? Math.round(base * (1 - d.value / 100)) : d.kind === 'amount' ? Math.round(base - d.value) : Math.round(d.value);
      if (!(d.value > 0) || !(final >= 0) || final >= base) { note.textContent = t('dc.err.not_a_discount'); note.className = 'jr-small dc-wide warn'; return; }
      const pct = Math.round(((base - final) / base) * 1000) / 10;
      form.elements.total.value = final;
      if (nDays) form.elements.perDay.value = Math.round(final / nDays);
      const cfg = st.pre.discounts || {};
      const needs = pct > (cfg.approvePct ?? 10) && !cfg.canApprove;
      note.textContent = `${t('dc.discPreview', { base: money(base), pct, off: money(base - final), final: money(final) })}${needs ? ` ${t('dc.discNeedApproval', { pct: cfg.approvePct ?? 10 })}` : ''}`;
      note.className = `jr-small dc-wide ${needs ? 'warn' : 'muted'}`;
    }

    /** Скидка договора: ждёт одобрения / отклонена / одобрена */
    function discountBanner(c) {
      const d = c.discountFull;
      const rej = c.data.discountRejected;
      if (d?.status === 'pending') {
        const can = st.pre.discounts?.canApprove;
        return `<div class="dc-banner dc-banner--wait">${esc(t('dc.discPending', { pct: d.percent, by: d.by || '' }))}
          <div class="muted jr-small">${esc(d.reason)}${d.comment ? ` — «${esc(d.comment)}»` : ''}</div>
          ${can ? `<div class="dc-actions"><button type="button" class="btn btn--small btn--primary" data-dc-decide="${d.id}:1">✅ ${esc(t('dc.discApprove'))}</button>
            <button type="button" class="btn btn--small" data-dc-decide="${d.id}:0">❌ ${esc(t('dc.discReject'))}</button></div>` : ''}</div>`;
      }
      if (!d && rej) return `<div class="dc-banner dc-banner--bad">${esc(t('dc.discRejected', { by: rej.by || '' }))}</div>`;
      if (d?.status === 'approved') return `<div class="dc-banner dc-banner--ok">${esc(t('dc.discApproved', { pct: d.percent, off: money(d.off), reason: d.reason, by: d.decidedBy ? ` · ${d.decidedBy}` : '' }))}</div>`;
      return '';
    }
    const pendingDiscount = () => st.one?.contract.discountFull?.status === 'pending';

    /* ------------------------------------------ Клиент из базы */

    const plateDigits = (p) => String(p || '').replace(/\D/g, '');

    /** Выбрали клиента в поиске: его данные (и последнего договора) — в форму; бронь — техника и даты */
    async function applyClient(c) {
      const form = document.querySelector('[data-dc-form]');
      if (!form) return;
      const set = (name, value) => {
        const el = form.elements[name];
        if (!el) return;
        el.value = value ?? '';
        el.classList.remove('dc-ai-unsure');
        el.classList.toggle('dc-ai-filled', Boolean(value));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      // Все поля клиента — заново: данные прежнего клиента не остаются
      set('r_name', c.name);
      set('r_phone', c.phone);
      set('r_passport', c.passport);
      set('r_nationality', c.nationality);
      set('r_license', c.license);
      set('r_address', c.address);
      // Бронь клиента: техника и даты (если технику ещё не выбрали)
      const b = c.booking;
      const v = b?.plates?.length ? st.pre.vehicles.find((x) => plateDigits(x.plate) === plateDigits(b.plates[0])) : null;
      if (v && (!form.elements.vehicleId.value || form.elements.vehicleId.value === String(v.id))) {
        const time = (x) => (form.elements[x].value.split('T')[1] || '12:00');
        if (b.from) set('from', `${b.from.slice(0, 10)}T${time('from')}`);
        if (b.to) set('to', `${b.to.slice(0, 10)}T${time('to')}`);
        rebuildVehicles(form);
        set('vehicleId', String(v.id));
        await refreshQuote(form, true);
      }
      const cur = readContract(form);
      st.form = { ...st.form, ...cur.data, lang: cur.lang };
    }
    if (ctx.pick) ctx.pick.on('dc-client', (c) => { applyClient(c); });

    /* ------------------------------------------ ИИ: заполнить договор по фото */

    // Фото держим в браузере: документы клиента никуда не сохраняются, фото техники
    // после сохранения договора уходят в «Фото при выдаче»
    function resetAi() {
      st.ai = { files: [], busy: false, result: null, error: null };
    }
    const AI_INPUT = {
      name: 'r_name', passport: 'r_passport', nationality: 'r_nationality', license: 'r_license', licenseCategories: 'r_license', licenseValidTo: 'r_license',
      phone: 'r_phone', plate: 'plate', model: 'model', color: 'color', mileage: 'mileage', fuel: 'fuel', from: 'from', to: 'to'
    };
    const SOURCE = { fleet: 'dc.ai.src.fleet', crm: 'dc.ai.src.crm', request: 'dc.ai.src.request', photo: 'dc.ai.src.photo' };

    function aiBlock() {
      const a = st.ai || { files: [] };
      const thumbs = a.files.map((f, i) => `<figure class="dc-thumb"><img src="${esc(f.url)}" alt="">
        ${a.busy ? '' : `<button type="button" class="icon-btn" data-dc-aidel="${i}" aria-label="${esc(t('dc.delete'))}">✕</button>`}</figure>`).join('');
      const r = a.result;
      let out = '';
      if (a.busy) out = `<p class="dc-ai-busy">⏳ ${esc(t('dc.ai.busy'))}</p>`;
      else if (a.error) out = `<p class="md-status is-error" role="status">${esc(a.error)}</p>`;
      else if (r) {
        const lines = [];
        lines.push(r.vehicle ? `🚗 ${esc(t('dc.ai.vehicle', { v: `${r.vehicle.model} · ${r.vehicle.plate}` }))}` : `🚗 ${esc(t('dc.ai.vehicleNone'))}`);
        if (r.client) lines.push(`👤 ${esc(t('dc.ai.client', { name: r.client.name }))}`);
        if (r.booking) lines.push(`📅 ${esc(t('dc.ai.booking', { from: dmy(r.booking.from), to: dmy(r.booking.to), src: t(SOURCE[r.booking.source] || 'dc.ai.src.photo') }))}`);
        out = `<p class="md-status is-ok" role="status">✓ ${esc(t('dc.ai.done', { n: r.filledCount }))}${r.unsureCount ? ` ${esc(t('dc.ai.check'))}` : ''}</p>
          <ul class="dc-ai-lines">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
          ${r.warnings.length ? `<ul class="dc-ai-warn">${r.warnings.map((w) => `<li>⚠️ ${esc(w)}</li>`).join('')}</ul>` : ''}
          <p class="muted jr-small">${esc(t('dc.ai.cost', { model: r.modelName, usd: r.usd }))}</p>`;
      }
      return `<section class="card dc-sec dc-ai" data-dc-ai>
        <h3>🤖 ${esc(t('dc.ai.title'))}</h3>
        <p class="muted jr-small">${esc(t('dc.ai.hint'))}</p>
        ${thumbs ? `<div class="dc-thumbs">${thumbs}</div>` : ''}
        <div class="dc-actions">
          <label class="btn btn--small${a.busy ? ' is-disabled' : ''}"><span>📷 ${esc(t('op.camera'))}</span><input type="file" accept="image/*" capture="environment" data-dc-aifiles hidden${a.busy ? ' disabled' : ''}></label>
          <label class="btn btn--small${a.busy ? ' is-disabled' : ''}"><span>🖼 ${esc(t('dc.ai.add'))}</span><input type="file" accept="image/*" multiple data-dc-aifiles hidden${a.busy ? ' disabled' : ''}></label>
          <button type="button" class="btn btn--primary btn--small" data-dc-airun${a.files.length && !a.busy ? '' : ' disabled'}>🤖 ${esc(t('dc.ai.run'))}</button>
          <span class="muted jr-small">${a.files.length}/8</span>
        </div>
        ${out}
        <p class="muted jr-small">🔒 ${esc(t('dc.ai.private'))}</p>
      </section>`;
    }

    /** Обновить только блок ИИ — форма (и то, что в неё уже вписали) не трогается */
    function refreshAi() {
      const box = document.querySelector('[data-dc-ai]');
      if (box) box.outerHTML = aiBlock();
      else ctx.rerender();
    }

    const toDataUrl = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const toBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

    async function addAiFiles(files) {
      for (const file of files) {
        if (st.ai.files.length >= 8) break;
        try {
          const blob = await ctx.prepareShot(file);
          // Превью — data:-ссылкой: blob: сайт сотрудников не показывает (Content-Security-Policy)
          st.ai.files.push({ blob, url: await toDataUrl(blob) });
        } catch { /* не фото */ }
      }
      st.ai.error = null;
      refreshAi();
    }

    async function runAi() {
      const form = document.querySelector('[data-dc-form]');
      if (!form || !st.ai.files.length || st.ai.busy) return;
      st.ai.busy = true;
      st.ai.error = null;
      st.ai.result = null;
      refreshAi();
      try {
        const photos = await Promise.all(st.ai.files.map(async (f) => {
          const blob = f.blob || await (await fetch(f.url, { credentials: 'same-origin' })).blob();
          return { type: blob.type || 'image/jpeg', data: await toBase64(blob) };
        }));
        const r = await api('/docs/recognize', { body: { photos } });
        st.ai.busy = false;
        const current = document.querySelector('[data-dc-form]');
        st.ai.result = await applyAi(current || form, r);
      } catch (err) {
        st.ai.busy = false;
        st.ai.error = errText(err);
      }
      refreshAi();
    }

    /** Ответ ИИ → поля формы: вписанное ИИ — голубое, в чём он не уверен — жёлтое */
    async function applyAi(form, r) {
      const unsure = new Set((r.unsure || []).map((k) => AI_INPUT[k]).filter(Boolean));
      const filled = new Set();
      for (const el of form.querySelectorAll('.dc-ai-filled, .dc-ai-unsure')) el.classList.remove('dc-ai-filled', 'dc-ai-unsure');
      const set = (name, value) => {
        const el = form.elements[name];
        if (!el || value === '' || value === null || value === undefined) return;
        el.value = value;
        filled.add(name);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const f = r.fields || {};
      set('r_name', f.name);
      set('r_passport', f.passport);
      set('r_nationality', f.nationality);
      set('r_license', f.license);
      set('r_phone', f.phone);
      set('r_address', f.address);
      if (r.booking?.from) set('from', `${r.booking.from}T${(form.elements.from.value || 'T12:00').split('T')[1] || '12:00'}`);
      if (r.booking?.to) set('to', `${r.booking.to}T${(form.elements.to.value || 'T12:00').split('T')[1] || '12:00'}`);
      if (r.request && form.elements.requestId && [...form.elements.requestId.options].some((o) => o.value === String(r.request.id))) {
        form.elements.requestId.value = String(r.request.id);
        st.form.requestId = r.request.id;
      }
      if (r.vehicle && vehicleById(r.vehicle.id)) {
        set('vehicleId', String(r.vehicle.id));
        await refreshQuote(form, true);
        for (const n of ['model', 'plate', 'color']) if (form.elements[n]?.value) filled.add(n);
        // Цвета нет в «Парке» — берём с фото
        if (!form.elements.color?.value) set('color', f.color);
      } else {
        set('plate', f.plate);
        set('model', f.model);
        set('color', f.color);
        if (r.booking) await refreshQuote(form, false);
      }
      set('mileage', f.mileage);
      if (f.fuel !== null && f.fuel !== undefined) set('fuel', String(f.fuel));
      for (const name of filled) form.elements[name]?.classList.add('dc-ai-filled');
      for (const name of unsure) if (filled.has(name)) form.elements[name]?.classList.add('dc-ai-unsure');
      // Если форму перерисуют — значения не потеряются
      const cur = readContract(form);
      st.form = { ...st.form, ...cur.data, lang: cur.lang };
      const modelName = r.model === 'claude-opus-5-5' ? 'Claude Opus 5.5' : r.model === 'claude-sonnet-5-5' ? 'Claude Sonnet 5.5' : r.model === 'claude-haiku-5-5' ? 'Claude Haiku 5.5' : r.model;
      return {
        ...r, warnings: r.warnings || [], filledCount: filled.size, unsureCount: [...unsure].filter((n) => filled.has(n)).length,
        modelName, usd: (r.usd || 0).toFixed(2)
      };
    }

    /** После сохранения нового договора: фото техники с ИИ-подписями — в «Фото при выдаче» */
    async function attachAiPhotos(contractId) {
      const r = st.ai?.result;
      const list = r ? (r.photos || []).filter((p) => p.caption && st.ai.files[p.index]).slice(0, 9) : [];
      let n = 0;
      const fromDraft = [];
      // Фото документов (свои, не из «＋ Операция») — только в отчёт о выдаче в WhatsApp, потом удаляются
      for (const p of (r?.photos || []).filter((x) => ['passport', 'licence', 'id_card', 'booking'].includes(x.kind))) {
        const f = st.ai.files[p.index];
        if (f?.blob) await ctx.uploadImage(`/docs/pending-photo?contract=${contractId}`, f.blob).catch(() => null);
      }
      for (const p of list) {
        const f = st.ai.files[p.index];
        if (f.draftIndex !== undefined) { fromDraft.push({ index: f.draftIndex, caption: p.caption }); continue; }
        try {
          await ctx.uploadImage(`/docs/photo?contract=${contractId}&caption=${encodeURIComponent(p.caption)}`, f.blob);
          n++;
        } catch { /* остальные фото добавят вручную */ }
      }
      // Договор из «＋ Операция»: фото техники переходят из черновика, черновик закрывается
      if (st.ai?.draftId) {
        try { n += (await api('/op/draft/attach', { body: { id: st.ai.draftId, contractId, photos: fromDraft } })).photos || 0; } catch { /* черновик удалится сам через неделю */ }
      }
      return n;
    }

    /** Из «＋ Операция» (выдача): новый договор — фото черновика и то, что ИИ уже прочитал */
    async function openNewFromDraft(draft) {
      if (!st.pre) {
        try { st.pre = await api('/docs/prefill'); } catch { /* форма без подсказок */ }
      }
      openNew({});
      st.ai = {
        files: (draft.photos || []).map((p) => ({ url: `/api/staff/op/draft/photo?id=${draft.id}&i=${p.i}&k=${p.key}`, draftIndex: p.i })),
        busy: false, result: null, error: null, draftId: draft.id
      };
      ctx.rerender();
      const r = draft.proposal?.contract ? { ...draft.proposal.contract, model: draft.proposal.model, usd: draft.proposal.usd || 0 } : null;
      if (!r) return;
      for (let i = 0; i < 40 && !document.querySelector('[data-dc-form]'); i++) await new Promise((ok) => setTimeout(ok, 50));
      const form = document.querySelector('[data-dc-form]');
      if (!form) return;
      st.ai.result = await applyAi(form, r);
      refreshAi();
    }

    /** Кнопки документа: PDF, подписи, ссылка, WhatsApp, удалить */
    function docActions(d) {
      const pdfReady = st.list?.pdfReady;
      const sign = (who) => (d.signed[who]
        ? `<span class="pill pill--free">✍️ ${esc(t(`dc.who.${who}`))} · ${esc(dt(d.signed[who].at))}${d.signed[who].via === 'link' ? ` · ${esc(t('dc.viaLink'))}` : ''}</span>`
        : canEdit() ? `<button type="button" class="btn btn--small" data-dc-sign="${d.id}:${who}">✍️ ${esc(t(`dc.signBy.${who}`))}</button>` : '');
      if (pendingDiscount()) {
        return `<div class="dc-actions"><button type="button" class="btn btn--small" data-dc-pdf="${d.id}"${pdfReady ? '' : ' disabled'}>📄 PDF</button>
          <span class="muted jr-small">⏳ ${esc(t('dc.discWait'))}</span></div>`;
      }
      return `<div class="dc-actions">
        <button type="button" class="btn btn--small" data-dc-pdf="${d.id}"${pdfReady ? '' : ' disabled'}>📄 PDF</button>
        ${d.kind === 'receipt' ? '' : sign('renter')}${sign('company')}
        ${canEdit() && d.kind !== 'receipt' && !d.signed.renter ? `<button type="button" class="btn btn--small" data-dc-link="${d.id}">🔗 ${esc(t('dc.link'))}</button>` : ''}
        ${canEdit() ? `<button type="button" class="btn btn--small" data-dc-send="${d.id}"${pdfReady ? '' : ' disabled'}>💬 ${esc(t('dc.sendWa'))}</button>` : ''}
        ${d.sentAt ? `<span class="muted jr-small">💬 ${esc(t('dc.sentTo', { to: d.sentTo || '', at: ctx.dateTime(d.sentAt) }))}</span>` : ''}
        ${canEdit() ? `<button type="button" class="link jr-small dc-del" data-dc-del="${d.id}">${esc(t('dc.delete'))}</button>` : ''}
      </div>`;
    }

    /* ---------------------------------------------------- Документы к договору */

    function linesText(list) {
      return (list || []).map((x) => `${x.text || ''}${x.thb ? ` — ${x.thb}` : ''}`).join('\n');
    }
    function parseLines(text) {
      return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const m = /^(.*?)[\s;:—–-]*([\d][\d\s,.]*)\s*(฿|thb|бат\S*)?\s*$/i.exec(line);
        return m && m[1].trim() ? { text: m[1].trim(), thb: Number(m[2].replace(/[\s,]/g, '')) || null } : { text: line, thb: null };
      });
    }

    function subForm(kind, doc) {
      const c = st.one.contract.data;
      const d = doc?.data || st.sub?.data || {};
      const id = doc?.id || '';
      if (kind === 'receipt') {
        const it = (type) => d.items?.find((x) => x.type === type);
        const other = d.items?.find((x) => x.type === 'other');
        return `<form class="dc-sub" data-dc-key="receipt-${st.id}-${id || 'new'}" data-dc-sub="receipt" data-id="${id}">
          <div class="dc-grid">
            ${fld(t('dc.date'), inp('date', d.date || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10), 'type="date"'))}
            ${fld(t('dc.rentPaid'), inp('rent', it('rent')?.thb ?? (doc ? '' : c.total ?? ''), 'inputmode="numeric"'))}
            ${fld(t('dc.depositPaid'), inp('deposit', it('deposit')?.thb ?? (doc ? '' : c.deposit ?? ''), 'inputmode="numeric"'))}
            ${fld(t('dc.otherWhat'), inp('otherText', other?.text || ''))}${fld(t('dc.otherSum'), inp('otherThb', other?.thb ?? '', 'inputmode="numeric"'))}
            ${fld(t('dc.payMethod'), inp('method', d.method ?? (doc ? '' : c.payMethod || ''), `placeholder="${esc(t('dc.payHint'))}"`), 'dc-wide')}
          </div>
          <div class="dc-actions"><button type="submit" class="btn btn--primary btn--small">${esc(t('dc.save'))}</button><button type="button" class="btn btn--small" data-dc-subclose>${esc(t('dc.cancel'))}</button></div>
        </form>`;
      }
      if (kind === 'return') {
        const eq = (st.pre.equipment[typeOf(c.vehicleType)] || []).filter((x) => c.equipment?.some((e) => e.key === x.key && e.ok));
        const idx = (key) => c.equipment.findIndex((e) => e.key === key);
        return `<form class="dc-sub" data-dc-key="return-${st.id}-${id || 'new'}" data-dc-sub="return" data-id="${id}">
          <div class="dc-grid">
            ${fld(t('dc.returnedAt'), inp('at', d.at || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16), 'type="datetime-local"'))}
            ${fld(t('dc.mileage'), inp('mileage', d.mileage ?? '', 'inputmode="numeric"'))}${fld(t('dc.fuel'), fuelSelect('fuel', d.fuel ?? c.fuel ?? 4))}
          </div>
          <div class="dc-eq"><span class="muted jr-small">${esc(t('dc.returnedEq'))}</span>${eq.map((x) => `<label class="mk-check"><input type="checkbox" name="req_${idx(x.key)}"${d.equipment?.[idx(x.key)] === false ? '' : ' checked'}> ${esc(label(x))}</label>`).join('')}</div>
          ${fld(t('dc.damages'), `<textarea class="search" name="damages" rows="3" placeholder="${esc(t('dc.linesHint'))}">${esc(linesText(d.damages))}</textarea>`, 'dc-wide')}
          ${fld(t('dc.deductions'), `<textarea class="search" name="deductions" rows="3" placeholder="${esc(t('dc.linesHint'))}">${esc(linesText(d.deductions))}</textarea>`, 'dc-wide')}
          ${fld(t('dc.refundMethod'), inp('refundMethod', d.refundMethod || '', `placeholder="${esc(t('dc.payHint'))}"`))}
          <div class="dc-actions"><button type="submit" class="btn btn--primary btn--small">${esc(t('dc.save'))}</button><button type="button" class="btn btn--small" data-dc-subclose>${esc(t('dc.cancel'))}</button></div>
        </form>`;
      }
      // Дополнение: продление и / или замена техники
      const e = d.extension;
      const s = d.swap;
      return `<form class="dc-sub" data-dc-key="addendum-${st.id}-${id || 'new'}" data-dc-sub="addendum" data-id="${id}">
        ${fld(t('dc.date'), inp('date', d.date || new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10), 'type="date"'))}
        <label class="mk-check"><input type="checkbox" name="ext"${!doc || e ? ' checked' : ''}> <b>${esc(t('dc.extension'))}</b></label>
        <div class="dc-grid">
          ${fld(t('dc.newReturn'), inp('newReturn', e?.newReturn || '', 'type="datetime-local"'))}
          ${fld(t('dc.perDay'), inp('extPerDay', e?.perDay ?? c.perDay ?? '', 'inputmode="numeric"'))}
          ${fld(t('dc.extraPrice'), inp('extraPrice', e?.extraPrice ?? '', 'inputmode="numeric"'))}${fld(t('dc.paid'), inp('extPaid', e?.paid ?? '', 'inputmode="numeric"'))}
        </div>
        <label class="mk-check"><input type="checkbox" name="swapOn"${s ? ' checked' : ''}> <b>${esc(t('dc.swap'))}</b></label>
        <div class="dc-grid">
          ${fld(t('dc.newVehicle'), `<select class="search" name="swapVehicle">${vehicleOptions(s?.vehicleId)}</select>`, 'dc-wide')}
          ${fld(t('dc.oldMileage'), inp('oldMileage', s?.oldMileage ?? '', 'inputmode="numeric"'))}${fld(t('dc.oldFuel'), fuelSelect('oldFuel', s?.oldFuel ?? 4))}
          ${fld(t('dc.newMileage'), inp('newMileage', s?.newMileage ?? '', 'inputmode="numeric"'))}${fld(t('dc.newFuel'), fuelSelect('newFuel', s?.newFuel ?? 8))}
          ${fld(t('dc.reason'), inp('reason', s?.reason || ''), 'dc-wide')}
        </div>
        <div class="dc-actions"><button type="submit" class="btn btn--primary btn--small">${esc(t('dc.save'))}</button><button type="button" class="btn btn--small" data-dc-subclose>${esc(t('dc.cancel'))}</button></div>
      </form>`;
    }

    function photosBlock() {
      const doc = st.one.children.find((x) => x.kind === 'photos');
      const count = doc?.photos || 0;
      const thumbs = doc ? Array.from({ length: count }, (_, i) => `<figure class="dc-thumb"><img src="/api/staff/docs/photo?id=${doc.id}&i=${i}" alt="">
        ${canEdit() ? `<button type="button" class="icon-btn" data-dc-photodel="${doc.id}:${i}" aria-label="${esc(t('dc.delete'))}">✕</button>` : ''}</figure>`).join('') : '';
      return `<section class="card dc-sec"><h3>📷 ${esc(t('dc.kind.photos'))} <span class="muted jr-small">${count}/9</span></h3>
        ${canEdit() && count < 9 ? `<div class="dc-row">
          ${fld(t('dc.photoWhat'), `<select class="search" data-dc-caption>${st.pre.photoCaptions.map((p) => `<option value="${p.key}"${p.key === st.photoCaption ? ' selected' : ''}>${esc(label(p))}</option>`).join('')}</select>`)}
          <label class="btn btn--small"><span>📷 ${esc(t('dc.addPhoto'))}</span><input type="file" accept="image/*" multiple data-dc-photos hidden></label>
        </div>` : ''}
        ${thumbs ? `<div class="dc-thumbs">${thumbs}</div>` : `<p class="muted jr-small">${esc(t('dc.photosHint'))}</p>`}
        ${doc && count ? docActions(doc) : ''}
      </section>`;
    }

    function subBlock(kind) {
      const docs = st.one.children.filter((x) => x.kind === kind);
      const open = st.sub && st.sub.kind === kind;
      // Акт возврата — один на договор
      const canAdd = canEdit() && !(kind === 'return' && docs.length);
      const rows = docs.map((d) => `<div class="dc-doc">
        <div class="dc-doc__head"><b>${esc(d.number)}</b> <span class="muted jr-small">${esc(ctx.dateTime(d.createdAt))} · ${esc(d.by || '')}</span>
          ${canEdit() ? `<button type="button" class="link jr-small" data-dc-subedit="${d.id}">${esc(t('dc.edit'))}</button>` : ''}</div>
        ${open && st.sub.id === d.id ? subForm(kind, st.sub.doc) : docActions(d)}
      </div>`).join('');
      return `<section class="card dc-sec"><h3>${KIND_ICON[kind]} ${esc(t(`dc.kind.${kind}`))}</h3>
        ${rows}
        ${open && !st.sub.id ? subForm(kind, null) : canAdd ? `<button type="button" class="btn btn--small" data-dc-subnew="${kind}">＋ ${esc(t(`dc.add.${kind}`))}</button>` : ''}
      </section>`;
    }

    function renderEditor() {
      const c = st.one?.contract;
      return `<div class="dc">
        <div class="dc-toolbar">
          <button type="button" class="btn btn--small" data-dc-back>← ${esc(t('dc.back'))}</button>
          <h2 class="dc-title">${c ? `${esc(c.number)}` : esc(t('dc.newContract'))}</h2>
        </div>
        ${st.msg ? `<p class="md-status is-${st.msg.kind}" role="status">${esc(st.msg.text)}</p>` : ''}
        ${c ? `<section class="card dc-sec"><h3>📄 ${esc(t('dc.kind.contract'))}</h3>${discountBanner(c)}${docActions(c)}${issueBlock(c)}</section>` : ''}
        ${!c && canEdit() ? aiBlock() : ''}
        ${contractForm()}
        ${c ? `${photosBlock()}${subBlock('receipt')}${subBlock('return')}${subBlock('addendum')}` : ''}
      </div>`;
    }

    function render() {
      if (st.failed) return `<div class="dc"><div class="card empty">${esc(t('app.loadFailed'))}</div></div>`;
      if (!st.list || !st.pre) return `<div class="dc"><div class="card empty">${esc(t('app.loading'))}</div></div>`;
      if (st.view === 'edit') setTimeout(() => { const form = document.querySelector('[data-dc-form]'); if (form && form.elements.discKind?.value !== 'none') recalcMoney(form); }, 0);
      if (st.view === 'edit' && st.pendingQuote) {
        st.pendingQuote = false;
        setTimeout(() => { const form = document.querySelector('[data-dc-form]'); if (form) refreshQuote(form, true); }, 0);
      }
      return st.view === 'edit' ? renderEditor() : renderList();
    }

    /** Выдача по договору: статус техники «В аренде» (или «Бронь») — с подтверждением и отменой */
    function issueBlock(c) {
      const d = c.data;
      if (c.issued) {
        const i = c.issued;
        return `<div class="dc-issued">🔑 ${esc(t(i.kind === 'reserve' ? 'dc.issuedReserve' : 'dc.issuedRent', { from: dmy(i.from), to: dmy(i.to), at: ctx.dateTime(i.at), by: i.by || '' }))}
          ${canEdit() ? `<button type="button" class="link jr-small dc-del" data-dc-unissue="${c.id}">${esc(t('dc.unissue'))}</button>` : ''}</div>`;
      }
      if (!canEdit()) return '';
      if (pendingDiscount()) return '';
      if (!d.vehicleId || !d.to) return `<p class="muted jr-small">${esc(t('dc.issueNeed'))}</p>`;
      const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
      const reserve = d.from && d.from.slice(0, 10) > today;
      return `<button type="button" class="btn btn--small btn--primary" data-dc-issue="${c.id}">🔑 ${esc(t(reserve ? 'dc.issueReserve' : 'dc.issueRent'))}</button>`;
    }

    /* ------------------------------------------------------------ Форма */

    function readContract(form) {
      const g = (n) => form.elements[n]?.value ?? '';
      const v = vehicleById(g('vehicleId'));
      const type = typeOf(v?.type || st.form.vehicleType);
      return {
        lang: g('lang') || 'en',
        data: {
          vehicleId: g('vehicleId') || null, vehicleType: v?.type || st.form.vehicleType || null,
          model: g('model'), plate: g('plate'), color: g('color'), vin: g('vin'),
          from: g('from'), to: g('to'), pickupPlace: g('pickupPlace'), returnPlace: g('returnPlace'),
          renter: { name: g('r_name'), passport: g('r_passport'), nationality: g('r_nationality'), license: g('r_license'), phone: g('r_phone'), address: g('r_address') },
          mileage: g('mileage'), fuel: g('fuel'),
          equipment: (st.pre.equipment[type] || []).map((it) => ({ key: it.key, ok: Boolean(form.elements[`eq_${it.key}`]?.checked), ...(it.key === 'helmets' ? { count: g('helmets') } : {}) })),
          perDay: g('perDay'), total: g('total'), deposit: g('deposit'), paid: g('paid'), payMethod: g('payMethod'),
          baseTotal: g('baseTotal'), discount: readDiscount(form),
          requestId: g('requestId') || st.form.requestId || null
        }
      };
    }

    /** Техника и даты поменялись — подставляем данные машины и цену из «Прайса» */
    async function refreshQuote(form, vehicleChanged) {
      const v = vehicleById(form.elements.vehicleId.value);
      if (vehicleChanged && v) {
        for (const [n, val] of [['model', v.model], ['plate', v.plate], ['color', v.color], ['vin', v.vin], ['mileage', v.mileage ?? '']]) form.elements[n].value = val ?? '';
        st.form.vehicleType = v.type;
        showVehicleSummary(form);
        const box = form.querySelector('[data-dc-eq]');
        if (box) box.innerHTML = equipmentHtml(typeOf(v.type), null);
      }
      if (vehicleChanged && !v) showVehicleSummary(form);
      const from = form.elements.from.value;
      const to = form.elements.to.value;
      const out = form.querySelector('[data-dc-days]');
      if (out) out.textContent = days(from, to);
      const note = form.querySelector('[data-dc-quote]');
      if (!v || !from || !to || to.slice(0, 10) < from.slice(0, 10)) return;
      try {
        const p = await api(`/docs/prefill?vehicleId=${v.id}&from=${from.slice(0, 10)}&to=${to.slice(0, 10)}`);
        if (p.quote?.total) {
          form.elements.perDay.value = p.quote.perDay;
          form.elements.total.value = p.quote.total;
          form.elements.baseTotal.value = p.quote.total;
          if (p.quote.deposit) form.elements.deposit.value = p.quote.deposit;
          st.quoteNote = t('dc.priceFrom', { days: p.quote.days, total: money(p.quote.total) });
        } else st.quoteNote = t('dc.noPrice');
        if (note) note.textContent = st.quoteNote;
        recalcMoney(form);
      } catch { /* цену впишут вручную */ }
    }

    async function fillFromRequest(form, id) {
      if (!id) return;
      try {
        const p = await api(`/docs/prefill?requestId=${id}`);
        const r = p.request;
        if (!r) return;
        if (r.name) form.elements.r_name.value = r.name;
        if (r.phone) form.elements.r_phone.value = r.phone.startsWith('+') ? r.phone : `+${r.phone}`;
        if (r.from) form.elements.from.value = `${r.from}T12:00`;
        if (r.to) form.elements.to.value = `${r.to}T12:00`;
        form.elements.lang.value = r.lang;
        st.form.requestId = r.id;
        await refreshQuote(form, false);
      } catch { /* без заявки */ }
    }

    async function saveContract(form) {
      const { lang, data } = readContract(form);
      st.busy = true;
      try {
        const wasNew = !st.id;
        const r = await api('/docs/save', { body: { id: st.id, kind: 'contract', lang, data } });
        st.msg = { kind: 'ok', text: t(st.id ? 'dc.saved' : 'dc.created') };
        if (wasNew) {
          const n = await attachAiPhotos(r.id);
          if (n) st.msg = { kind: 'ok', text: `${t('dc.created')} ${t('dc.ai.photosAttached', { n })}` };
          resetAi();
        }
        await loadOne(r.id, false);
        await refreshList();
      } catch (err) {
        st.form = { ...st.form, ...data, lang };
        st.msg = { kind: 'error', text: errText(err) };
      }
      st.busy = false;
      ctx.rerender();
      window.scrollTo(0, 0);
    }

    async function refreshList() {
      try { st.list = await api(`/docs${st.q ? `?q=${encodeURIComponent(st.q)}` : ''}`); } catch { /* старый список */ }
    }

    async function saveSub(form) {
      const kind = form.dataset.dcSub;
      const g = (n) => form.elements[n]?.value ?? '';
      let data;
      if (kind === 'receipt') {
        data = { date: g('date'), method: g('method'), items: [
          { type: 'rent', thb: g('rent') }, { type: 'deposit', thb: g('deposit') }, { type: 'other', text: g('otherText'), thb: g('otherThb') }
        ].filter((x) => String(x.thb).trim()) };
      } else if (kind === 'return') {
        const c = st.one.contract.data;
        data = {
          at: g('at'), mileage: g('mileage'), fuel: g('fuel'), refundMethod: g('refundMethod'),
          equipment: c.equipment.map((e, i) => (form.elements[`req_${i}`] ? form.elements[`req_${i}`].checked : true)),
          damages: parseLines(g('damages')), deductions: parseLines(g('deductions'))
        };
      } else {
        const v = vehicleById(g('swapVehicle'));
        data = {
          date: g('date'),
          extension: form.elements.ext.checked ? { newReturn: g('newReturn'), perDay: g('extPerDay'), extraPrice: g('extraPrice'), paid: g('extPaid') } : null,
          swap: form.elements.swapOn.checked ? { vehicleId: v?.id || null, model: v?.model || '', plate: v?.plate || '', oldMileage: g('oldMileage'), newMileage: g('newMileage'), oldFuel: g('oldFuel'), newFuel: g('newFuel'), reason: g('reason') } : null
        };
      }
      try {
        await api('/docs/save', { body: { id: form.dataset.id ? Number(form.dataset.id) : null, kind, contractId: st.id, lang: st.one.contract.lang, data } });
        st.sub = null;
        st.msg = { kind: 'ok', text: t('dc.saved') };
        await loadOne(st.id, false);
        await refreshList();
      } catch (err) {
        st.msg = { kind: 'error', text: errText(err) };
      }
      ctx.rerender();
    }

    /* ------------------------------------------------------------ Подпись */

    function signDialog(id, who) {
      let dlg = document.getElementById('dc-sign');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'dc-sign';
        dlg.className = 'sheet dc-signbox';
        document.body.append(dlg);
      }
      dlg.innerHTML = `<div class="sheet__body">
        <h3>✍️ ${esc(t(`dc.signBy.${who}`))}</h3>
        <p class="muted jr-small">${esc(t(who === 'renter' ? 'dc.signHintClient' : 'dc.signHintStaff'))}</p>
        <canvas class="dc-pad"></canvas>
        <p class="md-status is-error" data-dc-signmsg hidden></p>
        <div class="dc-actions"><button type="button" class="btn btn--primary" data-dc-signsave>${esc(t('dc.signSave'))}</button>
          <button type="button" class="btn" data-dc-signclear>${esc(t('dc.signClear'))}</button><button type="button" class="btn" data-dc-signcancel>${esc(t('dc.cancel'))}</button></div></div>`;
      dlg.showModal();
      const canvas = dlg.querySelector('canvas');
      const g = canvas.getContext('2d');
      let drawn = false;
      let down = false;
      let last = null;
      const fit = () => {
        const r = canvas.getBoundingClientRect();
        const k = window.devicePixelRatio || 1;
        canvas.width = r.width * k;
        canvas.height = r.height * k;
        g.setTransform(k, 0, 0, k, 0, 0);
        Object.assign(g, { lineWidth: 2.4, lineCap: 'round', lineJoin: 'round', strokeStyle: '#0b1f6b' });
        drawn = false;
      };
      fit();
      const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      canvas.onpointerdown = (e) => { down = true; last = pt(e); canvas.setPointerCapture(e.pointerId); };
      canvas.onpointermove = (e) => { if (!down) return; const p = pt(e); g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke(); last = p; drawn = true; };
      canvas.onpointerup = () => { down = false; };
      canvas.onpointercancel = () => { down = false; };
      const msg = dlg.querySelector('[data-dc-signmsg]');
      dlg.querySelector('[data-dc-signclear]').onclick = () => { g.clearRect(0, 0, canvas.width, canvas.height); drawn = false; };
      dlg.querySelector('[data-dc-signcancel]').onclick = () => dlg.close();
      dlg.querySelector('[data-dc-signsave]').onclick = async (e) => {
        if (!drawn) { msg.hidden = false; msg.textContent = t('dc.signEmpty'); return; }
        e.target.disabled = true;
        try {
          await api('/docs/sign', { body: { id, who, png: canvas.toDataURL('image/png') } });
          dlg.close();
          st.msg = { kind: 'ok', text: t('dc.signed') };
          await loadOne(st.id, false);
          await refreshList();
          ctx.rerender();
        } catch (err) {
          e.target.disabled = false;
          msg.hidden = false;
          msg.textContent = errText(err);
        }
      };
    }

    /* ------------------------------------------------------------ События */

    async function act(fn, okText) {
      try {
        const r = await fn();
        st.msg = okText ? { kind: 'ok', text: typeof okText === 'function' ? okText(r) : okText } : st.msg;
        if (st.id) await loadOne(st.id, false);
        await refreshList();
      } catch (err) {
        st.msg = { kind: 'error', text: errText(err) };
      }
      ctx.rerender();
    }

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.dc')) return false;
      if (el.closest('[data-dc-new]')) { openNew(); return true; }
      const open = el.closest('[data-dc-open]');
      if (open) { ctx.pushStep?.(); st.view = 'edit'; st.sub = null; st.msg = null; st.quoteNote = null; loadOne(open.dataset.dcOpen).catch(() => { st.msg = { kind: 'error', text: t('app.loadFailed') }; ctx.rerender(); }); return true; }
      if (el.closest('[data-dc-back]')) { ctx.popStep?.(); backToList(); return true; }
      const pdf = el.closest('[data-dc-pdf]');
      if (pdf) { window.open(`/api/staff/docs/pdf?id=${pdf.dataset.dcPdf}`, '_blank', 'noopener'); return true; }
      const sign = el.closest('[data-dc-sign]');
      if (sign) { const [id, who] = sign.dataset.dcSign.split(':'); signDialog(Number(id), who); return true; }
      const link = el.closest('[data-dc-link]');
      if (link) {
        const send = window.confirm(t('dc.linkAsk'));
        act(async () => {
          const r = await api('/docs/link', { body: { id: Number(link.dataset.dcLink), send } });
          try { await navigator.clipboard.writeText(r.url); } catch { /* показываем ниже */ }
          return r;
        }, (r) => (r.sentTo ? t('dc.linkSent', { to: r.sentTo }) : t('dc.linkCopied', { url: r.url })));
        return true;
      }
      const send = el.closest('[data-dc-send]');
      if (send) {
        const phone = st.one?.contract.data.renter?.phone || '';
        const to = window.prompt(t('dc.sendAsk'), phone);
        if (to === null) return true;
        send.disabled = true;
        act(() => api('/docs/send', { body: { id: Number(send.dataset.dcSend), phone: to } }), (r) => t('dc.sentOk', { to: r.to }));
        return true;
      }
      const del = el.closest('[data-dc-del]');
      if (del) {
        const id = Number(del.dataset.dcDel);
        const isContract = id === st.id;
        if (!window.confirm(t(isContract ? 'dc.deleteContractAsk' : 'dc.deleteAsk'))) return true;
        act(async () => {
          await api('/docs/delete', { body: { id } });
          if (isContract) { st.view = 'list'; st.id = null; st.one = null; }
        }, t('dc.deleted'));
        return true;
      }
      if (el.closest('[data-dc-airun]')) { runAi(); return true; }
      if (el.closest('[data-dc-vedit]')) {
        const form = el.closest('form');
        form.querySelector('[data-dc-vfields]').hidden = false;
        form.querySelector('[data-dc-vsum]').hidden = true;
        form.elements.color?.focus();
        return true;
      }
      const aidel = el.closest('[data-dc-aidel]');
      if (aidel) {
        st.ai.files.splice(Number(aidel.dataset.dcAidel), 1);
        st.ai.result = null;
        refreshAi();
        return true;
      }
      const decide = el.closest('[data-dc-decide]');
      if (decide) {
        const [id, ok] = decide.dataset.dcDecide.split(':');
        decide.disabled = true;
        act(() => api('/discounts/decide', { body: { id: Number(id), approve: ok === '1' } }), t('dc.discDecided'));
        return true;
      }
      const issue = el.closest('[data-dc-issue]');
      if (issue) {
        const d = st.one.contract.data;
        const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
        const reserve = d.from && d.from.slice(0, 10) > today;
        const ask = t(reserve ? 'dc.issueAskReserve' : 'dc.issueAskRent', { vehicle: `${d.model || ''} · ${d.plate || ''}`, from: dmy(d.from?.slice(0, 10)), to: dmy(d.to?.slice(0, 10)), client: d.renter?.name || '—' });
        if (!window.confirm(ask)) return true;
        issue.disabled = true;
        act(() => api('/docs/issue', { body: { id: Number(issue.dataset.dcIssue) } }), (r) => t(r.kind === 'reserve' ? 'dc.issuedOkReserve' : 'dc.issuedOkRent') + (r.wa === 'sent' ? ` ${t('dc.toGroup')}` : ''));
        return true;
      }
      const unissue = el.closest('[data-dc-unissue]');
      if (unissue) {
        if (!window.confirm(t('dc.unissueAsk'))) return true;
        act(() => api('/docs/unissue', { body: { id: Number(unissue.dataset.dcUnissue) } }), t('dc.unissued'));
        return true;
      }
      const subNew = el.closest('[data-dc-subnew]');
      if (subNew) { st.sub = { kind: subNew.dataset.dcSubnew, id: null, doc: null }; ctx.rerender(); return true; }
      const subEdit = el.closest('[data-dc-subedit]');
      if (subEdit) {
        api(`/docs/one?id=${subEdit.dataset.dcSubedit}`).then((r) => { st.sub = { kind: r.doc.kind, id: r.doc.id, doc: r.doc }; ctx.rerender(); }).catch(() => null);
        return true;
      }
      if (el.closest('[data-dc-subclose]')) { st.sub = null; ctx.rerender(); return true; }
      const pdel = el.closest('[data-dc-photodel]');
      if (pdel) {
        const [id, index] = pdel.dataset.dcPhotodel.split(':').map(Number);
        if (window.confirm(t('dc.deletePhotoAsk'))) act(() => api('/docs/photo/delete', { body: { id, index } }));
        return true;
      }
      return false;
    }

    function onChange(event) {
      const el = event.target;
      if (!el.closest?.('.dc')) return false;
      if (el.matches('[data-dc-vehicle]')) { refreshQuote(el.form, true); return true; }
      if (el.matches('[data-dc-dates]')) { rebuildVehicles(el.form); refreshQuote(el.form, false); return true; }
      if (el.matches('[data-dc-money]')) { recalcMoney(el.form); return true; }
      if (el.matches('[data-dc-request]')) { fillFromRequest(el.form, el.value); return true; }
      if (el.matches('[data-dc-caption]')) { st.photoCaption = el.value; return true; }
      if (el.matches('[data-dc-aifiles]')) {
        const files = [...el.files];
        el.value = '';
        if (files.length) addAiFiles(files);
        return true;
      }
      if (el.matches('[data-dc-photos]')) {
        const files = [...el.files];
        if (!files.length) return true;
        (async () => {
          try {
            for (const file of files) {
              const blob = await ctx.prepareShot(file);
              await ctx.uploadImage(`/docs/photo?contract=${st.id}&caption=${encodeURIComponent(st.photoCaption)}`, blob);
            }
            st.msg = { kind: 'ok', text: t('dc.photosAdded', { n: files.length }) };
          } catch (err) {
            st.msg = { kind: 'error', text: errText(err) };
          }
          await loadOne(st.id, false);
          await refreshList();
          ctx.rerender();
        })();
        return true;
      }
      return false;
    }

    let searchTimer = null;
    function onInput(event) {
      // Поиск техники: номер или модель; одна подходящая — сразу выбрана
      if (event.target.matches?.('[data-dc-vfilter]')) {
        const form = event.target.form;
        const left = rebuildVehicles(form);
        const q = event.target.value.trim();
        if (q.length >= 3 && left.length === 1 && form.elements.vehicleId.value !== left[0].value) {
          form.elements.vehicleId.value = left[0].value;
          form.elements.vehicleId.dispatchEvent(new Event('input', { bubbles: true }));
          refreshQuote(form, true);
        }
        return true;
      }
      // Сотрудник поправил поле, в котором ИИ не был уверен, — подсветку снимаем
      if (event.isTrusted && event.target.classList?.contains('dc-ai-unsure')) event.target.classList.remove('dc-ai-unsure');
      if (event.target.matches?.('[data-dc-money]')) { recalcMoney(event.target.form); return true; }
      if (!event.target.matches?.('[data-dc-search]')) return false;
      st.q = event.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        await refreshList();
        const view = document.querySelector('.dc');
        if (view && st.view === 'list') {
          const pos = event.target.selectionStart;
          ctx.rerender();
          const input = document.querySelector('[data-dc-search]');
          if (input) { input.focus(); input.setSelectionRange(pos, pos); }
        }
      }, 350);
      return true;
    }

    function onSubmit(event) {
      const form = event.target;
      if (!form.closest?.('.dc')) return false;
      event.preventDefault();
      if (form.matches('[data-dc-form]')) { if (!st.busy) saveContract(form); return true; }
      if (form.matches('[data-dc-sub]')) { saveSub(form); return true; }
      return true;
    }

    /** Пока правят договор или открыт документ — фон вкладку не перерисовывает */
    const canRefresh = () => st.view === 'list' && !document.activeElement?.matches?.('[data-dc-search]');

    return {
      load, render, onClick, onChange, onInput, onSubmit, canRefresh, openNew, openNewFromDraft,
      openContract: (id) => { if (st.view !== 'edit') ctx.pushStep?.(); st.view = 'edit'; st.sub = null; st.msg = null; loadOne(id).catch(() => null); },
      // «Назад» телефона: из договора — к списку
      back: () => { if (st.view !== 'edit') return false; backToList(); return true; }
    };
  }

  window.STAFF_DOCS = { create };
})();
