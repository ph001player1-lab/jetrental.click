/*
 * «Парк»: карточки техники в портале (первоисточник; WS.Автопрокат сверяется).
 * Все, кому открыт «Парк», видят данные карточки (год, VIN, пробег, ТО, ремонт,
 * ответственный, комментарий). «Парк: меняет» (владелец и админ) — добавить,
 * изменить, перенести в архив (продана / списана / другое), вернуть из архива,
 * удалить ошибочную карточку. Тексты — i18n (vh.*).
 */
(function () {
  'use strict';

  const TYPES = ['scooter', 'motorcycle', 'car'];
  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };
  const REPAIR = ['ok', 'needs_repair', 'in_repair'];
  const REASONS = ['sold', 'written_off', 'other'];
  const FIELDS = [
    ['plate', 'text', 20], ['type', 'type'], ['brand', 'text', 40], ['model', 'text', 60], ['clientModel', 'text', 60],
    ['year', 'text', 10], ['color', 'text', 30], ['vin', 'text', 40], ['mileage', 'num'], ['repair', 'repair'],
    ['serviceDate', 'date'], ['serviceKm', 'num'], ['nextServiceDate', 'date'], ['nextServiceKm', 'num'],
    ['responsible', 'text', 60], ['inventoryDate', 'date'], ['comment', 'area', 2000]
  ];

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = { dialog: null, msg: null, saving: false, archiveOpen: false, archiveMsg: null };
    const fleet = () => ctx.fleet() || {};
    const canEdit = () => Boolean(fleet().canEditFleet);
    const keyOf = (plate) => String(plate || '').replace(/\D/g, '');
    const vehicles = () => fleet().vehicles || [];
    const byId = (id) => vehicles().find((v) => v.id === Number(id));
    const byPlate = (plate) => vehicles().find((v) => keyOf(v.plate) && keyOf(v.plate) === keyOf(plate));
    const nameOf = (v) => v.clientModel || `${v.brand} ${v.model}`.trim() || '—';
    const num = (n) => (n === null || n === undefined || n === '' ? '' : new Intl.NumberFormat('en-US').format(n));

    /* --------------------------------------------- Данные карточки (для всех) */

    /** Блок в раскрытой карточке WS-машины: данные из портала и кнопки */
    function cardBlock(car) {
      const v = car.vehicleId ? byId(car.vehicleId) : byPlate(car.plate);
      if (!v) {
        return `<div class="vh-block vh-block--missing">
          <p class="warn">⚠️ ${esc(t('vh.notInPortal'))}</p>
          ${canEdit() ? `<button type="button" class="btn btn--small btn--primary" data-vh-add-ws="${esc(car.id)}">＋ ${esc(t('vh.addFromWs'))}</button>` : ''}
        </div>`;
      }
      return `<div class="vh-block">${details(v)}${actions(v)}</div>`;
    }

    function details(v) {
      const rows = [
        [t('vh.f.brandModel'), `${v.brand} ${v.model}`.trim()],
        [t('vh.f.year'), v.year], [t('vh.f.color'), v.color], [t('vh.f.vin'), v.vin],
        [t('vh.f.mileage'), v.mileage !== null ? `${num(v.mileage)} ${t('vh.km')}` : ''],
        [t('vh.f.service'), [v.serviceDate && ctx.shortDate(v.serviceDate), v.serviceKm !== null && `${num(v.serviceKm)} ${t('vh.km')}`].filter(Boolean).join(' · ')],
        [t('vh.f.nextService'), [v.nextServiceDate && ctx.shortDate(v.nextServiceDate), v.nextServiceKm !== null && `${num(v.nextServiceKm)} ${t('vh.km')}`].filter(Boolean).join(' · ')],
        [t('vh.f.responsible'), v.responsible], [t('vh.f.inventoryDate'), v.inventoryDate && ctx.shortDate(v.inventoryDate)],
        [t('vh.f.comment'), v.comment]
      ].filter(([, value]) => value);
      return `
        ${v.repair !== 'ok' ? `<p class="vh-repair">🔧 ${esc(t(`vh.repair.${v.repair}`))}</p>` : ''}
        ${rows.length ? `<dl class="vh-dl">${rows.map(([k, value]) => `<dt>${esc(k)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` : ''}`;
    }

    function actions(v) {
      if (!canEdit()) return '';
      return `<div class="vh-actions">
        <button type="button" class="btn btn--small" data-vh-edit="${v.id}">✏️ ${esc(t('vh.edit'))}</button>
        <button type="button" class="btn btn--small" data-vh-archive="${v.id}">🗄 ${esc(t('vh.toArchive'))}</button>
      </div>`;
    }

    /* ---------------------------------------- Вкладка: кнопка, «нет в WS», архив */

    function toolbar() {
      if (!canEdit()) return '';
      return `<div class="vh-toolbar"><button type="button" class="btn btn--small btn--primary" data-vh-new>＋ ${esc(t('vh.add'))}</button>
        ${st.msg && !st.dialog ? `<span class="vh-msg vh-msg--${st.msg.kind}" role="status">${esc(st.msg.text)}</span>` : ''}</div>`;
    }

    /** Техника из портала, которой нет в WS.Автопрокат (или WS не подключён) */
    function renderNotInWs(q) {
      const wsKeys = new Set((fleet().cars || []).map((c) => keyOf(c.plate)));
      const query = String(q || '').trim().toLowerCase();
      const list = vehicles().filter((v) => !wsKeys.has(keyOf(v.plate)))
        .filter((v) => !query || [v.plate, nameOf(v), v.brand, v.model].some((x) => String(x || '').toLowerCase().includes(query)));
      if (!list.length) return '';
      const items = list.map((v) => `
        <article class="card car vh-card" data-vh-card="${v.id}">
          <div class="car__head">
            <div class="row__main">
              <div class="car__title">${esc(nameOf(v))}</div>
              <div><span class="car__plate">${esc(v.plate || '—')}</span><span class="muted" style="font-size:13px">${TYPE_ICON[v.type] || ''} ${esc(v.type ? t(`type.${v.type}`) : '')}</span></div>
            </div>
          </div>
          <div class="vh-block">${details(v)}${actions(v)}</div>
        </article>`).join('');
      return `<section class="vh-nows">
        <h3 class="section-title">${esc(t('vh.notInWs', { n: list.length }))}</h3>
        <p class="muted jr-small">${esc(t('vh.notInWsTip'))}</p>
        <div class="list">${items}</div>
      </section>`;
    }

    function renderArchive() {
      if (!canEdit()) return '';
      const list = fleet().sold || [];
      const rows = list.map((r) => {
        const name = `${r.model || r.wsModel || ''} #${r.plate}`.trim();
        const what = [t(`vh.reason.${r.reason || 'sold'}`), r.soldOn ? ctx.shortDate(r.soldOn) : '', r.price ? ctx.money(r.price) : '', r.note].filter(Boolean).join(' · ');
        return `<li>
          <b>${esc(name)}</b> <span class="muted">${esc(what)}</span>
          <span class="sold-actions">
            <button type="button" class="link" data-vh-archive-edit="${esc(r.plate)}">${esc(t('vh.archiveEdit'))}</button>
            <button type="button" class="link" data-vh-restore="${esc(r.plate)}">${esc(t('vh.restore'))}</button>
          </span>
        </li>`;
      }).join('');
      return `
        <details class="card sold-box" data-vh-archive-box${st.archiveOpen ? ' open' : ''}>
          <summary><b>${esc(t('vh.archiveTitle', { n: list.length }))}</b></summary>
          ${st.archiveMsg ? `<p class="md-status is-${st.archiveMsg.kind}" role="status">${esc(st.archiveMsg.text)}</p>` : ''}
          ${list.length ? `<ul class="sold-list">${rows}</ul>` : `<p class="muted">${esc(t('vh.archiveEmpty'))}</p>`}
        </details>`;
    }

    /* ------------------------------------------------------------- Окно */

    function dialogEl() {
      let dlg = document.getElementById('vh-dialog');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'vh-dialog';
        dlg.className = 'sheet vh-sheet';
        document.body.append(dlg);
        dlg.addEventListener('close', () => { st.dialog = null; });
      }
      return dlg;
    }

    function openDialog(d) {
      st.dialog = d;
      st.msg = null;
      const dlg = dialogEl();
      dlg.innerHTML = d.kind === 'archive' ? archiveForm(d) : vehicleForm(d);
      if (!dlg.open) dlg.showModal();
      dlg.querySelector('input:not([type=hidden]), select, textarea')?.focus();
    }

    function refreshDialogMsg() {
      const box = document.querySelector('#vh-dialog [data-vh-dmsg]');
      if (box) box.innerHTML = st.msg ? `<p class="vh-msg vh-msg--${st.msg.kind}" role="status">${esc(st.msg.text)}</p>` : '';
      document.querySelectorAll('#vh-dialog button[type=submit]').forEach((b) => { b.disabled = st.saving; });
    }

    function closeDialog() {
      const dlg = document.getElementById('vh-dialog');
      if (dlg?.open) dlg.close();
      st.dialog = null;
    }

    function field([name, kind, max], v) {
      const value = v[name] ?? '';
      const label = `<span>${esc(t(`vh.f.${name}`))}${name === 'plate' || name === 'type' ? ' *' : ''}</span>`;
      if (kind === 'type') {
        return `<label class="field">${label}<select class="search" name="type">${['', ...TYPES].map((x) => `<option value="${x}"${x === value ? ' selected' : ''}>${x ? `${TYPE_ICON[x]} ${esc(t(`type.${x}`))}` : '—'}</option>`).join('')}</select></label>`;
      }
      if (kind === 'repair') {
        return `<label class="field">${label}<select class="search" name="repair">${REPAIR.map((x) => `<option value="${x}"${x === (value || 'ok') ? ' selected' : ''}>${esc(t(`vh.repair.${x}`))}</option>`).join('')}</select></label>`;
      }
      if (kind === 'area') return `<label class="field vh-wide">${label}<textarea class="search" name="${name}" rows="3" maxlength="${max}">${esc(value)}</textarea></label>`;
      const type = kind === 'date' ? 'date' : 'text';
      const extra = kind === 'num' ? ' inputmode="numeric"' : max ? ` maxlength="${max}"` : '';
      const list = name === 'clientModel' ? ' list="vh-models"' : name === 'brand' ? ' list="vh-brands"' : '';
      return `<label class="field">${label}<input class="search" type="${type}" name="${name}" value="${esc(value === null ? '' : String(value))}"${extra}${list} autocomplete="off"></label>`;
    }

    function vehicleForm(d) {
      const v = d.vehicle || {};
      const models = [...new Set(vehicles().map(nameOf).concat(ctx.catalogModels()))].filter(Boolean).sort();
      const brands = [...new Set(vehicles().map((x) => x.brand).filter(Boolean))].sort();
      return `
        <form class="sheet__body vh-form" data-vh-form novalidate>
          <div class="sheet__head">
            <div><div class="muted">${esc(t(v.id ? 'vh.editTitle' : 'vh.addTitle'))}</div><h2>${esc(v.id ? `${nameOf(v)} · ${v.plate}` : t('vh.newVehicle'))}</h2></div>
            <button type="button" class="icon-btn icon-btn--plain" data-vh-close aria-label="${esc(t('vh.close'))}">×</button>
          </div>
          <p class="muted jr-small">${esc(t('vh.formTip'))}</p>
          <div class="vh-grid">${FIELDS.map((f) => field(f, v)).join('')}</div>
          <datalist id="vh-models">${models.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
          <datalist id="vh-brands">${brands.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
          <div data-vh-dmsg></div>
          <div class="vh-actions">
            <button type="submit" class="btn btn--primary">${esc(t('vh.save'))}</button>
            <button type="button" class="btn" data-vh-close>${esc(t('vh.cancel'))}</button>
            ${v.id ? `<button type="button" class="btn btn--danger-text vh-del" data-vh-delete="${v.id}">${esc(t('vh.delete'))}</button>` : ''}
          </div>
          ${v.updatedAt ? `<p class="muted jr-small">${esc(t('vh.updated', { at: ctx.dateTime(v.updatedAt), by: v.updatedBy || '—' }))}</p>` : ''}
        </form>`;
    }

    function archiveForm(d) {
      const r = d.entry || {};
      return `
        <form class="sheet__body vh-form" data-vh-archive-form novalidate>
          <div class="sheet__head">
            <div><div class="muted">${esc(t('vh.toArchive'))}</div><h2>${esc(`${d.name} · ${d.plate}`)}</h2></div>
            <button type="button" class="icon-btn icon-btn--plain" data-vh-close aria-label="${esc(t('vh.close'))}">×</button>
          </div>
          <p class="muted jr-small">${esc(t('vh.archiveTip'))}</p>
          <div class="vh-grid">
            <label class="field"><span>${esc(t('vh.reasonLabel'))}</span><select class="search" name="reason">
              ${REASONS.map((x) => `<option value="${x}"${x === (r.reason || 'sold') ? ' selected' : ''}>${esc(t(`vh.reason.${x}`))}</option>`).join('')}</select></label>
            <label class="field"><span>${esc(t('vh.archiveDate'))}</span><input class="search" type="date" name="date" value="${esc(r.soldOn || ctx.today())}"></label>
            <label class="field"${(r.reason || 'sold') === 'sold' ? '' : ' hidden'}><span>${esc(t('vh.salePrice'))}</span><input class="search" name="price" inputmode="numeric" value="${esc(r.price ?? '')}" placeholder="350000"></label>
            <label class="field"><span>${esc(t('vh.note'))}</span><input class="search" name="note" maxlength="300" value="${esc(r.note || '')}"></label>
          </div>
          <div data-vh-dmsg></div>
          <div class="vh-actions">
            <button type="submit" class="btn btn--primary">${esc(t('vh.archiveSave'))}</button>
            <button type="button" class="btn" data-vh-close>${esc(t('vh.cancel'))}</button>
          </div>
        </form>`;
    }

    /* ------------------------------------------------------- Действия */

    const ERR = {
      plate_required: 'vh.err.plate', type_required: 'vh.err.type', model_required: 'vh.err.model', plate_taken: 'vh.err.taken',
      bad_number: 'vh.err.number', bad_date: 'vh.err.date', invalid_price: 'vh.err.price', invalid_date: 'vh.err.date'
    };
    const errText = (err) => t(ERR[err.code] || 'vh.err.failed');

    async function saveVehicle(form) {
      const data = Object.fromEntries(new FormData(form));
      if (st.dialog?.vehicle?.id) data.id = st.dialog.vehicle.id;
      st.saving = true;
      st.msg = null;
      refreshDialogMsg();
      try {
        await api('/fleet/vehicle', { body: data });
        st.saving = false;
        closeDialog();
        st.msg = { kind: 'ok', text: t('vh.saved', { plate: data.plate }) };
        await ctx.reload();
      } catch (err) {
        st.saving = false;
        st.msg = { kind: 'error', text: errText(err) };
        refreshDialogMsg();
      }
    }

    async function saveArchive(form) {
      const data = Object.fromEntries(new FormData(form));
      const d = st.dialog;
      st.saving = true;
      refreshDialogMsg();
      try {
        await api('/fleet/sold', { body: { plate: d.plate, model: d.name, reason: data.reason, date: data.date, price: data.reason === 'sold' ? data.price : '', note: data.note } });
        st.saving = false;
        closeDialog();
        st.archiveMsg = { kind: 'ok', text: t('vh.archived', { plate: d.plate }) };
        st.archiveOpen = true;
        await ctx.reload();
      } catch (err) {
        st.saving = false;
        st.msg = { kind: 'error', text: errText(err) };
        refreshDialogMsg();
      }
    }

    async function restore(plate) {
      if (!window.confirm(t('vh.restoreConfirm', { plate }))) return;
      try {
        await api('/fleet/sold', { body: { plate, restore: true } });
        st.archiveMsg = { kind: 'ok', text: t('vh.restored', { plate }) };
      } catch {
        st.archiveMsg = { kind: 'error', text: t('vh.err.failed') };
      }
      await ctx.reload();
    }

    async function remove(id) {
      const v = byId(id);
      if (!v || !window.confirm(t('vh.deleteConfirm', { plate: v.plate || nameOf(v) }))) return;
      try {
        await api('/fleet/vehicle/delete', { body: { id } });
        closeDialog();
        st.msg = { kind: 'ok', text: t('vh.deleted', { plate: v.plate }) };
        await ctx.reload();
      } catch (err) {
        st.msg = { kind: 'error', text: errText(err) };
        refreshDialogMsg();
      }
    }

    /** Новая карточка из машины WS: госномер и модель из Автопроката */
    function fromWs(carId) {
      const car = (fleet().cars || []).find((c) => String(c.id) === String(carId));
      if (!car) return {};
      const name = String(car.wsModel || '').replace(/\s*\(\d+\)\s*$/, '').trim();
      const [brand, ...rest] = name.split(/\s+/);
      return { plate: car.plate, brand: brand || '', model: rest.join(' '), clientModel: name, type: car.type || '' };
    }

    /* ------------------------------------------------------- События */

    function onClick(event) {
      const el = event.target.closest('[data-vh-new], [data-vh-edit], [data-vh-add-ws], [data-vh-archive], [data-vh-archive-edit], [data-vh-restore], [data-vh-delete], [data-vh-close], [data-vh-archive-box] > summary');
      if (!el) return false;
      const d = el.dataset;
      if (el.matches('summary')) { st.archiveOpen = !el.parentElement.open; return false; }
      if ('vhNew' in d) openDialog({ kind: 'vehicle', vehicle: null });
      else if (d.vhEdit) openDialog({ kind: 'vehicle', vehicle: byId(d.vhEdit) });
      else if (d.vhAddWs) openDialog({ kind: 'vehicle', vehicle: fromWs(d.vhAddWs) });
      else if (d.vhArchive) { const v = byId(d.vhArchive); if (v) openDialog({ kind: 'archive', plate: v.plate, name: nameOf(v), entry: null }); }
      else if (d.vhArchiveEdit) {
        const r = (fleet().sold || []).find((x) => x.plate === d.vhArchiveEdit);
        if (r) openDialog({ kind: 'archive', plate: r.plate, name: r.model || r.wsModel || '', entry: r });
      } else if (d.vhRestore) restore(d.vhRestore);
      else if (d.vhDelete) remove(Number(d.vhDelete));
      else if ('vhClose' in d) closeDialog();
      return true;
    }

    function onSubmit(event) {
      const form = event.target.closest('[data-vh-form], [data-vh-archive-form]');
      if (!form) return false;
      event.preventDefault();
      if (st.saving) return true;
      if (form.matches('[data-vh-form]')) saveVehicle(form);
      else saveArchive(form);
      return true;
    }

    /** Цену продажи вводят только для «Продана» */
    function onChange(event) {
      const el = event.target;
      if (!el.matches('[data-vh-archive-form] [name=reason]')) return false;
      const price = el.form.querySelector('[name=price]');
      price.closest('.field').hidden = el.value !== 'sold';
      return true;
    }

    return { cardBlock, toolbar, renderNotInWs, renderArchive, onClick, onSubmit, onChange, canEdit, dialogOpen: () => Boolean(st.dialog) };
  }

  window.STAFF_VEHICLES = { create };
})();
