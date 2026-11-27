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
    const st = { view: 'list', list: null, q: '', failed: false, id: null, one: null, pre: null, form: null, msg: null, busy: false, sub: null, photoCaption: 'front' };
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

    /** Новый договор; prefill — из «Парка» (техника, даты) или из карточки клиента (клиент) */
    function openNew(prefill = {}) {
      const now = new Date(Date.now() + 7 * 3600000).toISOString();
      st.view = 'edit';
      st.id = null;
      st.one = null;
      st.sub = null;
      st.msg = null;
      st.quoteNote = null;
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
          <div class="dc-pills">${statusPills(c)}${c.children.map((x) => `<span class="pill">${KIND_ICON[x.kind]} ${esc(t(`dc.kind.${x.kind}`))}${x.kind === 'receipt' || x.kind === 'addendum' ? ` ${esc(x.number.replace(/^.*\//, '/'))}` : ''}</span>`).join(' ')}</div>
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

    function vehicleOptions(selected) {
      const groups = ['car', 'motorcycle', 'scooter'].map((type) => {
        const list = st.pre.vehicles.filter((v) => (v.type || 'scooter') === type).sort((a, b) => a.model.localeCompare(b.model));
        if (!list.length) return '';
        return `<optgroup label="${esc(t(`dc.type.${type}`))}">${list.map((v) => `<option value="${v.id}"${String(v.id) === String(selected) ? ' selected' : ''}>${esc(v.model)} · ${esc(v.plate)}</option>`).join('')}</optgroup>`;
      }).join('');
      return `<option value="">${esc(t('dc.pickVehicle'))}</option>${groups}`;
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
          ${fld(t('dc.vehicle'), `<select class="search" name="vehicleId" data-dc-vehicle>${vehicleOptions(f.vehicleId)}</select>`, 'dc-wide')}
          ${fld(t('dc.model'), inp('model', f.model))}${fld(t('dc.plate'), inp('plate', f.plate))}
          ${fld(t('dc.color'), inp('color', f.color))}${fld('VIN', inp('vin', f.vin))}
        </div>
        <h3>📅 ${esc(t('dc.period'))}</h3>
        <div class="dc-grid">
          ${fld(t('dc.from'), inp('from', f.from, 'type="datetime-local" data-dc-dates'))}${fld(t('dc.to'), inp('to', f.to, 'type="datetime-local" data-dc-dates'))}
          ${fld(t('dc.pickupPlace'), inp('pickupPlace', f.pickupPlace, `placeholder="${esc(t('dc.placeHint'))}"`))}${fld(t('dc.returnPlace'), inp('returnPlace', f.returnPlace, `placeholder="${esc(t('dc.placeHint'))}"`))}
        </div>
        <h3>👤 ${esc(t('dc.client'))}</h3>
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

    /** Кнопки документа: PDF, подписи, ссылка, WhatsApp, удалить */
    function docActions(d) {
      const pdfReady = st.list?.pdfReady;
      const sign = (who) => (d.signed[who]
        ? `<span class="pill pill--free">✍️ ${esc(t(`dc.who.${who}`))} · ${esc(dt(d.signed[who].at))}${d.signed[who].via === 'link' ? ` · ${esc(t('dc.viaLink'))}` : ''}</span>`
        : canEdit() ? `<button type="button" class="btn btn--small" data-dc-sign="${d.id}:${who}">✍️ ${esc(t(`dc.signBy.${who}`))}</button>` : '');
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
        ${c ? `<section class="card dc-sec"><h3>📄 ${esc(t('dc.kind.contract'))}</h3>${docActions(c)}${issueBlock(c)}</section>` : ''}
        ${contractForm()}
        ${c ? `${photosBlock()}${subBlock('receipt')}${subBlock('return')}${subBlock('addendum')}` : ''}
      </div>`;
    }

    function render() {
      if (st.failed) return `<div class="dc"><div class="card empty">${esc(t('app.loadFailed'))}</div></div>`;
      if (!st.list || !st.pre) return `<div class="dc"><div class="card empty">${esc(t('app.loading'))}</div></div>`;
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
        const box = form.querySelector('[data-dc-eq]');
        if (box) box.innerHTML = equipmentHtml(typeOf(v.type), null);
      }
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
          if (p.quote.deposit) form.elements.deposit.value = p.quote.deposit;
          st.quoteNote = t('dc.priceFrom', { days: p.quote.days, total: money(p.quote.total) });
        } else st.quoteNote = t('dc.noPrice');
        if (note) note.textContent = st.quoteNote;
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
        const r = await api('/docs/save', { body: { id: st.id, kind: 'contract', lang, data } });
        st.msg = { kind: 'ok', text: t(st.id ? 'dc.saved' : 'dc.created') };
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
      if (open) { st.view = 'edit'; st.sub = null; st.msg = null; st.quoteNote = null; loadOne(open.dataset.dcOpen).catch(() => { st.msg = { kind: 'error', text: t('app.loadFailed') }; ctx.rerender(); }); return true; }
      if (el.closest('[data-dc-back]')) { st.view = 'list'; st.id = null; st.one = null; st.sub = null; st.msg = null; refreshList().then(() => ctx.rerender()); return true; }
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
      if (el.matches('[data-dc-dates]')) { refreshQuote(el.form, false); return true; }
      if (el.matches('[data-dc-request]')) { fillFromRequest(el.form, el.value); return true; }
      if (el.matches('[data-dc-caption]')) { st.photoCaption = el.value; return true; }
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
      load, render, onClick, onChange, onInput, onSubmit, canRefresh, openNew,
      openContract: (id) => { st.view = 'edit'; st.sub = null; st.msg = null; loadOne(id).catch(() => null); }
    };
  }

  window.STAFF_DOCS = { create };
})();
