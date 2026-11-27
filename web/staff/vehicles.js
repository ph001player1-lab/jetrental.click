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
    const VIEW_KEY = 'jm_fleet_view';
    const savedView = () => { try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards'; } catch { return 'cards'; } };
    const st = { dialog: null, msg: null, saving: false, archiveOpen: false, archiveMsg: null, view: savedView(), onlyProblems: false, onlyCheck: false };
    const STATUS_KINDS = ['free', 'rent', 'reserve', 'service'];
    const dm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');
    const fleet = () => ctx.fleet() || {};
    const canEdit = () => Boolean(fleet().canEditFleet);
    const canCheck = () => Boolean(fleet().canCheck);
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

    /** Инвестор машины — видят только владелец и админ (у них есть список инвесторов) */
    function investorName(v) {
      const p = (fleet().investors || []).find((x) => x.id === v.investorId);
      return p ? `${p.name} · ${v.investorPercent ?? p.percent}%` : '';
    }

    function details(v) {
      const rows = [
        [t('vh.f.brandModel'), `${v.brand} ${v.model}`.trim()],
        [t('vh.f.year'), v.year], [t('vh.f.color'), v.color], [t('vh.f.vin'), v.vin],
        [t('vh.f.mileage'), v.mileage !== null ? `${num(v.mileage)} ${t('vh.km')}` : ''],
        [t('vh.f.service'), [v.serviceDate && ctx.shortDate(v.serviceDate), v.serviceKm !== null && `${num(v.serviceKm)} ${t('vh.km')}`].filter(Boolean).join(' · ')],
        [t('vh.f.nextService'), [v.nextServiceDate && ctx.shortDate(v.nextServiceDate), v.nextServiceKm !== null && `${num(v.nextServiceKm)} ${t('vh.km')}`].filter(Boolean).join(' · ')],
        [t('vh.f.responsible'), v.responsible], [t('vh.f.inventoryDate'), v.inventoryDate && ctx.shortDate(v.inventoryDate)],
        [t('vh.f.investor'), investorName(v)],
        [t('vh.f.comment'), v.comment]
      ].filter(([, value]) => value);
      return `
        ${v.repair !== 'ok' ? `<p class="vh-repair">🔧 ${esc(t(`vh.repair.${v.repair}`))}</p>` : ''}
        ${rows.length ? `<dl class="vh-dl">${rows.map(([k, value]) => `<dt>${esc(k)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` : ''}`;
    }

    function actions(v) {
      const model = nameOf(v);
      const buttons = [
        ctx.canSetStatus() ? `<button type="button" class="btn btn--small btn--primary" data-vh-status="${v.id}">🔄 ${esc(t('fs.change'))}</button>` : '',
        canEdit() ? `<button type="button" class="btn btn--small" data-vh-edit="${v.id}">✏️ ${esc(t('vh.edit'))}</button>` : '',
        ctx.canEditModel() ? `<button type="button" class="btn btn--small" data-vh-model="${esc(model)}">🖼 ${esc(t('vh.photoDesc'))}</button>` : '',
        canEdit() ? `<button type="button" class="btn btn--small" data-vh-archive="${v.id}">🗄 ${esc(t('vh.toArchive'))}</button>` : ''
      ].filter(Boolean);
      return buttons.length ? `<div class="vh-actions">${buttons.join('')}</div>` : '';
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
      dlg.innerHTML = d.type === 'check' ? checkForm(d) : d.type === 'status' ? statusForm(d) : d.kind === 'archive' ? archiveForm(d) : vehicleForm(d);
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

    /** Чья машина (кабинет инвестора) и особая доля для неё — владелец и админ */
    function investorFields(v) {
      const list = fleet().investors || [];
      if (!list.length) return '';
      const options = list.map((p) => `<option value="${p.id}"${p.id === v.investorId ? ' selected' : ''}>${esc(p.name)} (${p.percent}%)</option>`).join('');
      return `
        <label class="field"><span>${esc(t('vh.f.investor'))}</span><select class="search" name="investorId"><option value="">${esc(t('vh.f.investorNone'))}</option>${options}</select></label>
        <label class="field"><span>${esc(t('vh.f.investorPercent'))}</span><input class="search" name="investorPercent" inputmode="decimal" value="${esc(v.investorPercent ?? '')}" placeholder="${esc(t('vh.f.investorPercentPh'))}"></label>`;
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
          <div class="vh-grid">${FIELDS.map((f) => field(f, v)).join('')}${investorFields(v)}</div>
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

    /* ------------------------------------------- Проблемы, вид, таблица */

    /** Значки «что сделать» — в карточке и в таблице */
    function problemBadges(car, compact = false) {
      const list = car.problems || [];
      if (!list.length) return compact ? '<span class="vh-ok" title="OK">✓</span>' : '';
      return `<span class="vh-probs">${list.map((p) => {
        const name = (x) => (['free', 'rent', 'reserve', 'service'].includes(x) ? ctx.statusName(x) : x || '');
        const code = p.code === 'needs_check' && !p.portal ? 'needs_check_ws' : p.code;
        const text = t(`fp.${code}`, { date: dm(p.date), ws: name(p.ws), portal: name(p.portal) });
        const fix = ['no_photo', 'no_description'].includes(p.code) ? ` data-vh-model="${esc(car.model)}"` : '';
        return `<span class="vh-prob vh-prob--${p.level}"${fix} title="${esc(text)}">${p.level === 'error' ? '⛔' : '⚠️'} ${esc(text)}</span>`;
      }).join('')}</span>`;
    }

    const withProblems = (cars) => cars.filter((c) => (c.problems || []).length);

    /** Кнопки над списком: добавить, вид (карточки / таблица), «только с проблемами» */
    function toolbar(cars = []) {
      const n = withProblems(cars).length;
      return `<div class="vh-toolbar">
        ${canEdit() ? `<button type="button" class="btn btn--small btn--primary" data-vh-new>＋ ${esc(t('vh.add'))}</button>` : ''}
        <div class="chips vh-view" role="group" aria-label="${esc(t('fl.view.label'))}">
          <button type="button" class="chip" data-vh-view="cards" aria-pressed="${st.view === 'cards'}">▦ ${esc(t('fl.view.cards'))}</button>
          <button type="button" class="chip" data-vh-view="table" aria-pressed="${st.view === 'table'}">☰ ${esc(t('fl.view.table'))}</button>
        </div>
        <button type="button" class="chip vh-onlyprob" data-vh-onlyprob aria-pressed="${st.onlyProblems}">⚠️ ${esc(t('fl.onlyProblems', { n }))}</button>
        ${cars.some((c) => c.needsCheck) ? `<button type="button" class="chip vh-onlycheck" data-vh-onlycheck aria-pressed="${st.onlyCheck}">🔍 ${esc(t('ck.only', { n: cars.filter((c) => c.needsCheck).length }))}</button>` : ''}
        ${st.msg && !st.dialog ? `<span class="vh-msg vh-msg--${st.msg.kind}" role="status">${esc(st.msg.text)}</span>` : ''}
      </div>`;
    }

    const filterProblems = (cars) => {
      let list = st.onlyProblems ? withProblems(cars) : cars;
      if (st.onlyCheck) list = list.filter((c) => c.needsCheck);
      return list;
    };
    const view = () => st.view;

    /** Откуда статус и кто его поставил: «рабочая группа · Nik · 27 Nov, 14:20», «WS (не проверено)», «проверено · Анна» */
    function sourceText(car) {
      const s = car.source || { kind: 'none' };
      const parts = [t(`src.${s.kind}`)];
      if (s.kind === 'check' && s.choice) parts[0] = `${t('src.check')} (${t(`ck.right.${s.choice}`)})`;
      if (s.by) parts.push(s.by);
      if (s.at) parts.push(ctx.dateTime(s.at));
      return parts.join(' · ');
    }

    /** Под статусом: источник; кнопка «Проверить», если портал и WS расходятся */
    function wsLine(car) {
      const check = car.needsCheck && canCheck()
        ? ` <button type="button" class="btn btn--small vh-check-btn" data-vh-check="${car.vehicleId}">🔍 ${esc(t('ck.btn'))}</button>` : '';
      return `<div class="vh-src${car.needsCheck ? ' vh-src--check' : ''}">${esc(t('src.line', { src: sourceText(car) }))}${check}</div>`;
    }

    /** История статуса: последние отчёты группы и события портала */
    function historyBlock(car) {
      const list = car.history || [];
      if (!list.length) return '';
      return `<details class="vh-hist"><summary>${esc(t('ck.history'))}</summary><ol>${list.map((h) => {
        const kind = h.kind.startsWith('p_') ? t(`fs.kind.${h.kind.slice(2)}`) : t(`jr.kind.${h.kind}`);
        return `<li>${esc(ctx.dateTime(h.at))} · <b>${esc(kind)}</b> · ${esc(t(`src.${h.src}`))}${h.by ? ` · ${esc(h.by)}` : ''}</li>`;
      }).join('')}</ol></details>`;
    }

    /** Последнее событие по технике: «Выдача · 12 Nov, 12:44 · группа» */
    function lastLine(car) {
      const l = car.last;
      if (!l) return '';
      const kind = l.kind.startsWith('p_') ? t(`fs.kind.${l.kind.slice(2)}`) : t(`jr.kind.${l.kind}`);
      return `<div class="muted jr-small">${esc(t('fs.last', { what: kind, at: ctx.dateTime(l.at), src: t(`fs.src.${l.src}`) }))}${l.by ? ` · ${esc(l.by)}` : ''}</div>`;
    }

    function statusText(car) {
      if (car.status === 'rent' && car.overdue) return t('fl.rentOverdue', { date: dm(car.until) });
      if (car.status === 'rent' && car.until) return `${ctx.statusName('rent')} ${t('fl.until', { date: dm(car.until) })}`;
      return ctx.statusName(car.status);
    }

    function renderTable(cars) {
      const tariff = (car) => fleet().tariffs?.[car.id]?.tiers?.find(Boolean);
      const rows = cars.map((car) => {
        const v = car.vehicleId ? byId(car.vehicleId) : null;
        const service = v ? [v.nextServiceDate && dm(v.nextServiceDate), v.nextServiceKm && `${num(v.nextServiceKm)} ${t('vh.km')}`].filter(Boolean).join(' · ') : '';
        return `<tr class="vh-tr${(car.problems || []).some((p) => p.level === 'error') ? ' vh-tr--error' : (car.problems || []).length ? ' vh-tr--warn' : ''}">
          <td class="vh-col-p"><b class="car__plate">${esc(car.plate || '—')}</b></td>
          <td><b>${esc(car.model || car.wsModel || '—')}</b><div class="muted jr-small"><span class="car__plate vh-plate-m">${esc(car.plate || '—')}</span>${TYPE_ICON[car.type] || ''} ${esc(v ? `${v.brand} ${v.model}`.trim() : car.wsModel || '')}</div></td>
          <td><span class="pill pill--${car.status}">${esc(statusText(car))}</span><div class="muted jr-small vh-src-t">${esc(sourceText(car))}</div>
            ${car.needsCheck && canCheck() ? `<button type="button" class="btn btn--small vh-check-btn" data-vh-check="${car.vehicleId}">🔍 ${esc(t('ck.btn'))}</button>` : ''}</td>
          <td class="vh-col-x">${car.ws ? (car.ws.status === car.status ? '<span class="vh-ok">✓</span>' : `<span class="warn">⚠️ ${esc(ctx.statusName(car.ws.status))}</span>`) : fleet().ws?.enabled ? '<span class="warn">—</span>' : ''}</td>
          <td class="num vh-col-x">${tariff(car) ? esc(ctx.money(tariff(car))) : '—'}</td>
          <td class="num vh-col-x">${v?.mileage !== null && v?.mileage !== undefined ? esc(num(v.mileage)) : ''}</td>
          <td class="vh-col-x">${esc(service)}</td>
          <td>${problemBadges(car, true)}</td>
          <td><div class="vh-td-actions">
            ${ctx.canSetStatus() && car.vehicleId ? `<button type="button" class="icon-btn icon-btn--plain" data-vh-status="${car.vehicleId}" title="${esc(t('fs.change'))}" aria-label="${esc(t('fs.change'))}">🔄</button>` : ''}
            ${canEdit() && car.vehicleId ? `<button type="button" class="icon-btn icon-btn--plain" data-vh-edit="${car.vehicleId}" title="${esc(t('vh.edit'))}" aria-label="${esc(t('vh.edit'))}">✏️</button>` : ''}
            ${car.model && ctx.canEditModel() ? `<button type="button" class="icon-btn icon-btn--plain" data-vh-model="${esc(car.model)}" title="${esc(t('vh.photoDesc'))}" aria-label="${esc(t('vh.photoDesc'))}">🖼</button>` : ''}
            ${canEdit() && car.vehicleId ? `<button type="button" class="icon-btn icon-btn--plain" data-vh-archive="${car.vehicleId}" title="${esc(t('vh.toArchive'))}" aria-label="${esc(t('vh.toArchive'))}">🗄</button>` : ''}
          </div></td>
        </tr>`;
      }).join('');
      return `<div class="vh-table-wrap"><table class="vh-table">
        <thead><tr><th class="vh-col-p">${esc(t('fl.th.plate'))}</th><th>${esc(t('fl.th.model'))}</th><th>${esc(t('fl.th.status'))}</th><th class="vh-col-x">WS</th>
          <th class="num vh-col-x">${esc(t('fl.th.price'))}</th><th class="num vh-col-x">${esc(t('fl.th.mileage'))}</th><th class="vh-col-x">${esc(t('fl.th.service'))}</th><th>${esc(t('fl.th.problems'))}</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    }

    /**
     * Подписи столбцов всегда видны: закреплены под верхней панелью и строкой поиска с фильтрами
     * (их высота разная на телефоне и компьютере — считаем после отрисовки). Если таблица шире
     * экрана, она прокручивается вбок внутри себя, а подписи закреплены в ней.
     */
    function afterRender() {
      const wrap = document.querySelector('.vh-table-wrap');
      if (!wrap) return;
      const bar = document.querySelector('#view .toolbar');
      const top = (parseFloat(bar ? getComputedStyle(bar).top : '') || 60) + (bar ? bar.offsetHeight : 0);
      wrap.style.setProperty('--vh-head-top', `${top}px`);
      const table = wrap.querySelector('table');
      wrap.classList.toggle('vh-table-wrap--scroll', table.scrollWidth > wrap.clientWidth + 1);
    }
    let fitTimer = null;
    window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(afterRender, 100); });

    /* ------------------------------------------------- Проверка расхождения */

    function checkForm(d) {
      const car = d.car;
      const portalTxt = car.source?.kind === 'ws' ? t('ck.portalNone') : `${ctx.statusName(car.portalStatus)}`;
      return `
        <form class="sheet__body vh-form" data-vh-check-form novalidate>
          <div class="sheet__head">
            <div><div class="muted">${esc(t('ck.title'))}</div><h2>${esc(`${car.model || car.wsModel} · ${car.plate}`)}</h2></div>
            <button type="button" class="icon-btn icon-btn--plain" data-vh-close aria-label="${esc(t('vh.close'))}">×</button>
          </div>
          <dl class="vh-dl">
            <dt>${esc(t('ck.portalSide'))}</dt><dd><b>${esc(portalTxt)}</b>${car.last ? ` · ${esc(t(`src.${car.last.src}`))}${car.last.by ? ` · ${esc(car.last.by)}` : ''} · ${esc(ctx.dateTime(car.last.at))}` : ''}</dd>
            <dt>${esc(t('ck.wsSide'))}</dt><dd><b>${esc(ctx.statusName(car.wsStatus))}</b></dd>
          </dl>
          ${historyBlock(car)}
          <label class="field"><span>${esc(t('ck.note'))}</span><input class="search" name="note" maxlength="300" placeholder="${esc(t('ck.notePh'))}"></label>
          <p class="muted jr-small">${esc(t('ck.tip'))}</p>
          <div data-vh-dmsg></div>
          <div class="vh-actions vh-check-actions">
            <button type="submit" class="btn btn--primary" name="choice" value="portal">✓ ${esc(t('ck.portal', { status: portalTxt }))}</button>
            <button type="submit" class="btn btn--primary" name="choice" value="ws">✓ ${esc(t('ck.ws', { status: ctx.statusName(car.wsStatus) }))}</button>
            <button type="button" class="btn" data-vh-status="${car.vehicleId}">${esc(t('ck.other'))}</button>
          </div>
        </form>`;
    }

    async function saveCheck(form, choice) {
      const d = st.dialog;
      const note = new FormData(form).get('note') || '';
      st.saving = true;
      st.msg = null;
      refreshDialogMsg();
      try {
        await api('/fleet/check', { body: { vehicleId: d.car.vehicleId, choice, note } });
        st.saving = false;
        closeDialog();
        st.msg = { kind: 'ok', text: t('ck.saved', { plate: d.car.plate }) };
        await ctx.reload();
      } catch (err) {
        st.saving = false;
        st.msg = { kind: 'error', text: t(err.code === 'nothing_to_check' ? 'ck.already' : 'vh.err.failed') };
        refreshDialogMsg();
      }
    }

    /* ------------------------------------------------------ Смена статуса */

    function statusForm(d) {
      const v = d.vehicle;
      const k = d.kind || 'rent';
      const dates = k === 'rent'
        ? `<label class="field"><span>${esc(t('fs.until'))}</span><input class="search" type="date" name="to" min="${ctx.today()}"></label>`
        : k === 'reserve'
          ? `<label class="field"><span>${esc(t('fs.from'))}</span><input class="search" type="date" name="from" min="${ctx.today()}"></label>
             <label class="field"><span>${esc(t('fs.to'))}</span><input class="search" type="date" name="to" min="${ctx.today()}"></label>` : '';
      return `
        <form class="sheet__body vh-form" data-vh-status-form novalidate>
          <div class="sheet__head">
            <div><div class="muted">${esc(t('fs.title'))}</div><h2>${esc(`${nameOf(v)} · ${v.plate}`)}</h2></div>
            <button type="button" class="icon-btn icon-btn--plain" data-vh-close aria-label="${esc(t('vh.close'))}">×</button>
          </div>
          <div class="chips vh-kinds" role="group" aria-label="${esc(t('fs.title'))}">
            ${STATUS_KINDS.map((x) => `<button type="button" class="chip" data-vh-kind="${x}" aria-pressed="${x === k}"><span class="dot dot--${x}"></span>${esc(t(`fs.kind.${x}`))}</button>`).join('')}
          </div>
          <div class="vh-grid">${dates}
            <label class="field vh-wide"><span>${esc(t('fs.note'))}</span><input class="search" name="note" maxlength="300" placeholder="${esc(t('fs.notePh'))}"></label>
          </div>
          <p class="muted jr-small">${esc(t(fleet().eventsToGroup ? 'fs.tipGroup' : 'fs.tipNoGroup'))}</p>
          <div data-vh-dmsg></div>
          <div class="vh-actions">
            <button type="submit" class="btn btn--primary">${esc(t('fs.save'))}</button>
            <button type="button" class="btn" data-vh-close>${esc(t('vh.cancel'))}</button>
          </div>
        </form>`;
    }

    async function saveStatus(form) {
      const data = Object.fromEntries(new FormData(form));
      const d = st.dialog;
      st.saving = true;
      st.msg = null;
      refreshDialogMsg();
      try {
        const r = await api('/fleet/status', { body: { vehicleId: d.vehicle.id, kind: d.kind, ...data } });
        st.saving = false;
        closeDialog();
        st.msg = { kind: r.wa === 'failed' ? 'error' : 'ok', text: `${t('fs.saved', { plate: d.vehicle.plate })} ${t(`fs.wa.${r.wa}`)}` };
        await ctx.reload();
      } catch (err) {
        st.saving = false;
        st.msg = { kind: 'error', text: t({ date_required: 'fs.err.dates', date_past: 'fs.err.past', date_order: 'fs.err.order' }[err.code] || 'vh.err.failed') };
        refreshDialogMsg();
      }
    }

    /* ------------------------------------------------------- Действия */

    const ERR = {
      plate_required: 'vh.err.plate', type_required: 'vh.err.type', model_required: 'vh.err.model', plate_taken: 'vh.err.taken',
      bad_number: 'vh.err.number', bad_date: 'vh.err.date', invalid_price: 'vh.err.price', invalid_date: 'vh.err.date', bad_percent: 'vh.err.percent'
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
      const el = event.target.closest('[data-vh-new], [data-vh-edit], [data-vh-add-ws], [data-vh-archive], [data-vh-archive-edit], [data-vh-restore], [data-vh-delete], [data-vh-close], [data-vh-archive-box] > summary, [data-vh-view], [data-vh-onlyprob], [data-vh-onlycheck], [data-vh-check], [data-vh-status], [data-vh-kind], [data-vh-model]');
      if (!el) return false;
      const d = el.dataset;
      if (el.matches('summary')) { st.archiveOpen = !el.parentElement.open; return false; }
      if (d.vhView) {
        st.view = d.vhView;
        try { localStorage.setItem(VIEW_KEY, st.view); } catch { /* приватный режим */ }
        ctx.rerender();
        return true;
      }
      if ('vhOnlyprob' in d) { st.onlyProblems = !st.onlyProblems; ctx.rerender(); return true; }
      if ('vhOnlycheck' in d) { st.onlyCheck = !st.onlyCheck; ctx.rerender(); return true; }
      if (d.vhCheck) {
        const car = (fleet().cars || []).find((c) => c.vehicleId === Number(d.vhCheck));
        if (car) openDialog({ type: 'check', car });
        return true;
      }
      if (d.vhModel) { ctx.openModel(d.vhModel); return true; }
      if (d.vhStatus) { const v = byId(d.vhStatus); if (v) openDialog({ type: 'status', vehicle: v, kind: 'rent' }); return true; }
      if (d.vhKind) { if (st.dialog?.type === 'status') openDialog({ ...st.dialog, kind: d.vhKind }); return true; }
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
      const form = event.target.closest('[data-vh-form], [data-vh-archive-form], [data-vh-status-form], [data-vh-check-form]');
      if (!form) return false;
      event.preventDefault();
      if (st.saving) return true;
      if (form.matches('[data-vh-check-form]')) saveCheck(form, event.submitter?.value || 'portal');
      else if (form.matches('[data-vh-form]')) saveVehicle(form);
      else if (form.matches('[data-vh-status-form]')) saveStatus(form);
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

    return {
      cardBlock, toolbar, renderNotInWs, renderArchive, renderTable, problemBadges, wsLine, lastLine, historyBlock, statusText, filterProblems, view, afterRender,
      onClick, onSubmit, onChange, canEdit, dialogOpen: () => Boolean(st.dialog)
    };
  }

  window.STAFF_VEHICLES = { create };
})();
