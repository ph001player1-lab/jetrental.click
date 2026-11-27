/*
 * Вкладка «Прайс»: сезоны (полоса года), цены по моделям на 5 сроков аренды,
 * залог и перепробег, особые цены отдельных госномеров. Менять — «Прайс:
 * меняет» (владелец и админ): правки подсвечиваются, «Сохранить» показывает
 * окно со всеми изменениями (было → стало, %), применяются после «Подтвердить».
 * Есть история с отменой и калькулятор для менеджеров. Тексты — i18n (pr.*).
 */
(function () {
  'use strict';

  const TYPES = ['scooter', 'motorcycle', 'car'];
  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };
  // 0–4 — сроки аренды, 5 — залог, 6 — перепробег
  const FIELDS = 7;
  const BIG_CHANGE = 0.3;

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = {
      data: null, failed: null, season: null, type: 'all', q: '',
      edits: new Map(), selected: new Set(), open: new Set(),
      seasonDraft: null, confirm: null, msg: null, saving: false,
      // Цены из файлов тарифов WS: { files: [{ name, data }], data (предпросмотр), mapping, busy, error }
      imp: null,
      calc: { model: '', from: '', to: '', result: null, error: null }
    };
    const canEdit = () => Boolean(st.data?.canEdit);
    const money = (n) => ctx.money(n);
    const num = (n) => (n === null || n === undefined || n === '' ? '' : String(n));
    const seasonById = (id) => st.data?.seasons.find((s) => String(s.id) === String(id));
    const seasonLabel = (s) => ctx.seasonName(s.name);
    const dm = (md) => `${md.slice(3)}.${md.slice(0, 2)}`;
    const periodText = (s) => s.periods.map((p) => `${dm(p.from)}–${dm(p.to)}`).join(', ');

    /* ------------------------------------------------------------ Данные */

    async function load() {
      try {
        st.data = await api('/price');
        st.failed = null;
        if (!st.season || !seasonById(st.season)) st.season = currentSeason()?.id ?? st.data.seasons?.[0]?.id ?? null;
      } catch (err) {
        st.failed = err.code === 'no_section_access' ? t('pr.noAccess') : t('pr.loadFailed');
      }
      ctx.rerender();
    }

    /** Сезон на сегодня (по Бангкоку) */
    function currentSeason() {
      const md = new Date(Date.now() + 7 * 3600000).toISOString().slice(5, 10);
      return (st.data?.seasons || []).find((s) => s.periods.some((p) => (p.from <= p.to ? p.from <= md && md <= p.to : md >= p.from || md <= p.to)));
    }

    /* ------------------------------------------- Значения: база и правки */

    const rateKey = (seasonId, scope, key) => `${seasonId}|${scope}|${key}`;
    const asValues = (r) => (r ? [...r.tiers, r.deposit, r.overKm] : Array(FIELDS).fill(null));
    function baseRate(model, seasonId, plate = null) {
      if (!plate) return model.rates[seasonId] || null;
      return model.overrides.find((o) => o.key === plate && String(o.seasonId) === String(seasonId)) || null;
    }
    /** Текущие значения ячеек строки (с учётом несохранённых правок): массив из 7 или null — нет особой цены */
    function valuesOf(model, seasonId, plate = null) {
      const edit = st.edits.get(rateKey(seasonId, plate ? 'plate' : 'model', plate || model.model));
      if (edit) return edit.remove ? null : edit.values;
      const base = baseRate(model, seasonId, plate);
      return base ? asValues(base) : (plate ? null : Array(FIELDS).fill(null));
    }
    function setEdit(model, seasonId, plate, values, remove = false) {
      const scope = plate ? 'plate' : 'model';
      const key = plate || model.model;
      const base = baseRate(model, seasonId, plate);
      const k = rateKey(seasonId, scope, key);
      const same = remove ? !base : base && JSON.stringify(asValues(base)) === JSON.stringify(values);
      if (same || (!base && !remove && values.every((v) => v === null))) st.edits.delete(k);
      else st.edits.set(k, { seasonId: Number(seasonId), scope, key, model: model.model, values, remove });
    }
    const typo = (tiers) => {
      const known = tiers.filter(Boolean);
      return known.some((p, i) => i > 0 && (p > known[i - 1] || p < known[i - 1] / 3));
    };
    const roundTo10 = (v) => Math.max(10, Math.round(v / 10) * 10);

    /* ------------------------------------------------------- Отрисовка */

    function yearStrip() {
      const seasons = st.data.seasons;
      const cover = (md) => seasons.find((s) => s.periods.some((p) => (p.from <= p.to ? p.from <= md && md <= p.to : md >= p.from || md <= p.to)));
      const segs = [];
      for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2025, 0, 1); ms += 86400000) {
        const md = new Date(ms).toISOString().slice(5, 10);
        const s = cover(md);
        const last = segs[segs.length - 1];
        if (last && last.s === s) { last.days++; last.to = md; } else segs.push({ s, days: 1, from: md, to: md });
      }
      const months = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(ctx.locale(), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, i, 15))));
      return `<div class="pr-year" aria-hidden="true">
        <div class="pr-year__bar">${segs.map((g) => `<span style="flex:${g.days};background:${g.s ? g.s.color : 'repeating-linear-gradient(135deg,#c0392b,#c0392b 3px,transparent 3px,transparent 6px)'}" title="${esc(g.s ? seasonLabel(g.s) : t('pr.noSeason'))}: ${dm(g.from)}–${dm(g.to)}"></span>`).join('')}</div>
        <div class="pr-year__months">${months.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      </div>`;
    }

    function issuesBlock() {
      const { gaps, overlaps } = st.data.issues || { gaps: [], overlaps: [] };
      if (!gaps.length && !overlaps.length) return '';
      const items = [
        ...gaps.map(([a, b]) => t('pr.gap', { range: a === b ? dm(a) : `${dm(a)}–${dm(b)}` })),
        ...overlaps.map((o) => t('pr.overlap', { range: o.from === o.to ? dm(o.from) : `${dm(o.from)}–${dm(o.to)}`, names: o.names }))
      ];
      return `<div class="pr-warn" role="alert">⚠️ ${items.map(esc).join('<br>')}</div>`;
    }

    function seasonChips() {
      return st.data.seasons.map((s) => `<button type="button" class="chip pr-season" data-pr-season="${s.id}" aria-pressed="${String(s.id) === String(st.season)}">
        <i style="background:${esc(s.color)}"></i>${esc(seasonLabel(s))}${s.verified ? '' : ' ⚠️'}<small>${esc(periodText(s))}</small></button>`).join('');
    }

    function visibleModels() {
      const q = st.q.trim().toLowerCase();
      return st.data.models.filter((m) => (st.type === 'all' || m.type === st.type) && (!q || m.model.toLowerCase().includes(q) || m.plates.some((p) => p.key.includes(q.replace(/\D/g, '') || '\u0000'))));
    }

    function cellsHtml(model, seasonId, plate, values, base) {
      const edit = canEdit();
      return values.map((v, i) => {
        const was = base ? asValues(base)[i] : null;
        const changed = (v ?? null) !== (was ?? null) && !(base === null && v === null);
        const cls = `pr-cell${changed ? ' is-changed' : ''}${i < 5 && v === null ? ' is-empty' : ''}`;
        if (!edit) return `<td class="${cls}">${v ? money(v) : '—'}</td>`;
        return `<td class="${cls}"><input class="pr-input" inputmode="numeric" value="${esc(num(v))}" aria-label="${esc(model.model)} ${esc(i < 5 ? st.data.tiers[i] : i === 5 ? t('pr.deposit') : t('pr.overKm'))}"
          data-pr-cell="${esc(model.model)}" data-season="${seasonId}" data-i="${i}"${plate ? ` data-plate="${esc(plate)}"` : ''}></td>`;
      }).join('');
    }

    function modelRows(model) {
      const sid = st.season;
      const values = valuesOf(model, sid);
      const overrides = model.overrides.filter((o) => String(o.seasonId) === String(sid));
      const pending = [...st.edits.values()].filter((e) => e.scope === 'plate' && e.model === model.model && String(e.seasonId) === String(sid));
      const special = new Set([...overrides.map((o) => o.key), ...pending.filter((e) => !e.remove).map((e) => e.key)]);
      pending.filter((e) => e.remove).forEach((e) => special.delete(e.key));
      const open = st.open.has(model.model);
      const warn = typo(values.slice(0, 5));
      const head = `<tr class="pr-row${warn ? ' is-typo' : ''}" data-model="${esc(model.model)}">
        <th scope="row" class="pr-model">
          ${canEdit() ? `<input type="checkbox" class="pr-check" data-pr-select="${esc(model.model)}"${st.selected.has(model.model) ? ' checked' : ''} aria-label="${esc(t('pr.select'))}">` : ''}
          <span class="pr-model__name">${esc(model.model)}</span>
          <button type="button" class="pr-units" data-pr-open="${esc(model.model)}" aria-expanded="${open}">${esc(t('pr.units', { n: model.plates.length }))}${special.size ? ` · ${esc(t('pr.special', { n: special.size }))}` : ''} ${open ? '▴' : '▾'}</button>
          ${warn ? `<span class="pr-flag" title="${esc(t('pr.typoHint'))}">⚠️</span>` : ''}
        </th>
        ${cellsHtml(model, sid, null, values, baseRate(model, sid))}
      </tr>`;
      if (!open) return head;
      const plates = model.plates.map((p) => {
        const own = special.has(p.key);
        const pv = own ? valuesOf(model, sid, p.key) || values : values;
        return `<tr class="pr-plate${own ? ' is-own' : ''}">
          <th scope="row" class="pr-model"><span class="pr-plate__no">${esc(p.plate)}</span>
            ${canEdit() ? (own
              ? `<button type="button" class="link" data-pr-own-off="${esc(p.key)}" data-model="${esc(model.model)}">${esc(t('pr.ownOff'))}</button>`
              : `<button type="button" class="link" data-pr-own-on="${esc(p.key)}" data-model="${esc(model.model)}">${esc(t('pr.ownOn'))}</button>`)
              : `<span class="muted">${esc(own ? t('pr.ownPrice') : t('pr.modelPrice'))}</span>`}
          </th>
          ${own ? cellsHtml(model, sid, p.key, pv, baseRate(model, sid, p.key)) : pv.map((v) => `<td class="pr-cell is-inherited">${v ? money(v) : '—'}</td>`).join('')}
        </tr>`;
      }).join('');
      return head + plates;
    }

    function table() {
      const list = visibleModels();
      if (!list.length) {
        // Пусто из-за поиска или фильтра — показываем, что ищем, и кнопку «все модели»
        const filtered = st.q.trim() || st.type !== 'all';
        return `<div class="empty">${esc(filtered && st.q.trim() ? t('pr.noneFor', { q: st.q.trim() }) : t('pr.none'))}
          ${filtered ? `<p><button type="button" class="btn btn--small" data-pr-reset>${esc(t('pr.showAll'))}</button></p>` : ''}</div>`;
      }
      const head = `<thead><tr><th scope="col" class="pr-model">${esc(t('pr.model'))}</th>${st.data.tiers.map((x) => `<th scope="col">${esc(x)} ${esc(t('unit.d'))}</th>`).join('')}<th scope="col">${esc(t('pr.deposit'))}</th><th scope="col">${esc(t('pr.overKm'))}</th></tr></thead>`;
      const body = TYPES.concat([null]).map((type) => {
        const rows = list.filter((m) => (type ? m.type === type : !TYPES.includes(m.type)));
        if (!rows.length) return '';
        return `<tr class="pr-group"><th colspan="8"><span>${type ? `${TYPE_ICON[type]} ${esc(t(`pr.type.${type}`))}` : esc(t('pr.type.other'))}</span></th></tr>${rows.map(modelRows).join('')}`;
      }).join('');
      return `<div class="pr-table"><table>${head}<tbody>${body}</tbody></table></div>`;
    }

    function toolsHtml() {
      const types = ['all', ...TYPES].map((x) => `<button type="button" class="chip" data-pr-type="${x}" aria-pressed="${st.type === x}">${x === 'all' ? esc(t('pr.all')) : `${TYPE_ICON[x]} ${esc(t(`pr.type.${x}`))}`}</button>`).join('');
      const others = st.data.seasons.filter((s) => String(s.id) !== String(st.season));
      return `<div class="pr-tools">
        <div class="chips">${types}</div>
        <input class="search pr-search" type="search" name="pr-model-filter" autocomplete="off" placeholder="${esc(t('pr.search'))}" value="${esc(st.q)}" data-pr-q aria-label="${esc(t('pr.search'))}">
        ${canEdit() ? `
        <form class="pr-bulk" data-pr-bulk>
          <span>${esc(t('pr.bulk', { n: st.selected.size }))}</span>
          <input class="search" name="pct" inputmode="decimal" placeholder="+10" aria-label="%" required> %
          <button type="submit" class="btn btn--small"${st.selected.size ? '' : ' disabled'}>${esc(t('pr.apply'))}</button>
        </form>
        ${others.length ? `<form class="pr-bulk" data-pr-copy>
          <span>${esc(t('pr.copyFrom'))}</span>
          <select class="search" name="from">${others.map((s) => `<option value="${s.id}">${esc(seasonLabel(s))}</option>`).join('')}</select>
          <input class="search" name="pct" inputmode="decimal" value="0" aria-label="%"> %
          <button type="submit" class="btn btn--small">${esc(t('pr.copy'))}</button>
        </form>` : ''}` : ''}
      </div>`;
    }

    function saveBar() {
      if (!canEdit()) return '';
      const n = [...st.edits.values()].length;
      return `<div class="pr-savebar${n ? ' is-on' : ''}" data-pr-savebar>
        <span>${esc(t('pr.changed', { n }))}</span>
        <button type="button" class="btn btn--small" data-pr-discard${n ? '' : ' disabled'}>${esc(t('pr.discard'))}</button>
        <button type="button" class="btn btn--primary btn--small" data-pr-review${n ? '' : ' disabled'}>${esc(t('pr.save'))}</button>
      </div>`;
    }

    function calcHtml() {
      const c = st.calc;
      const models = st.data.models.filter((m) => m.plates.length);
      const r = c.result;
      return `<section class="card pr-calc">
        <h3>${esc(t('pr.calc'))}</h3>
        <form class="pr-calc__form" data-pr-calc>
          <label class="field"><span>${esc(t('pr.model'))}</span><select class="search" name="model" required>
            <option value="">—</option>${models.map((m) => `<option${m.model === c.model ? ' selected' : ''}>${esc(m.model)}</option>`).join('')}</select></label>
          <label class="field"><span>${esc(t('pr.from'))}</span><input class="search" type="date" name="from" value="${esc(c.from)}" required></label>
          <label class="field"><span>${esc(t('pr.to'))}</span><input class="search" type="date" name="to" value="${esc(c.to)}" required></label>
          <button type="submit" class="btn btn--small">${esc(t('pr.calcGo'))}</button>
        </form>
        <p class="muted jr-small">${esc(t('pr.calcDays'))}</p>
        ${c.error ? `<p class="md-status is-error">${esc(c.error)}</p>` : ''}
        ${r ? (r.quote
          ? `<p class="pr-calc__res"><b>${esc(money(r.quote.total))}</b> · ${esc(t('pr.calcRes', { days: r.days, perDay: money(r.quote.perDay) }))}${r.quote.deposit ? ` · ${esc(t('pr.deposit'))} ${esc(money(r.quote.deposit))}` : ''}</p>`
          : `<p class="muted">${esc(t('pr.calcNone'))}</p>`) : ''}
      </section>`;
    }

    function historyHtml() {
      const list = st.data.history || [];
      if (!list.length) return '';
      return `<section class="card pr-history"><h3>${esc(t('pr.history'))}</h3><ul>${list.map((h) => `<li>
        <span class="muted">${esc(ctx.dateTime(h.at))} · ${esc(h.by)}</span>
        <span>${esc(h.summary || '')}</span>
        ${h.revertedAt ? `<span class="pill">${esc(t('pr.reverted'))}</span>` : canEdit() && h.changes.length ? `<button type="button" class="link" data-pr-revert="${h.id}">${esc(t('pr.revert'))}</button>` : ''}
      </li>`).join('')}</ul></section>`;
    }

    /* ------------------------------------------ Цены из файлов тарифов (Excel) */

    const toBase64 = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    async function importPreview(apply = false) {
      const imp = st.imp;
      if (!imp?.files?.length) return;
      imp.busy = true;
      imp.error = null;
      rerender();
      try {
        const r = await api('/price/import', { body: { files: imp.files, mapping: imp.mapping, apply } });
        if (apply) {
          st.imp = null;
          st.msg = { kind: 'ok', text: t('pr.imp.done', { n: r.count }) };
          await load();
          return;
        }
        imp.data = r;
        imp.mapping = Object.fromEntries(r.report.map((x) => [x.seasonId, x.file]));
      } catch (err) {
        imp.error = err.code === 'nothing_changed' ? t('pr.imp.nothing') : t('pr.imp.failed');
      }
      imp.busy = false;
      rerender();
    }

    const cell = (oldV, newV) => (oldV === newV ? `<span class="muted">${esc(num(newV) || '—')}</span>`
      : `${oldV ? `<s class="muted">${esc(num(oldV))}</s> ` : ''}<b>${esc(num(newV) || '—')}</b>`);
    const rowCells = (o, n) => [0, 1, 2, 3, 4].map((i) => `<td class="pr-num">${cell(o?.tiers?.[i] ?? null, n?.tiers?.[i] ?? null)}</td>`).join('')
      + `<td class="pr-num">${cell(o?.deposit ?? null, n?.deposit ?? null)}</td><td class="pr-num">${cell(o?.overKm ?? null, n?.overKm ?? null)}</td>`;

    function importHtml() {
      const imp = st.imp;
      if (!imp) return '';
      const d = imp.data;
      const head = `<tr><th></th>${st.data.tiers.map((x) => `<th class="pr-num">${esc(x)}</th>`).join('')}<th class="pr-num">${esc(t('pr.deposit'))}</th><th class="pr-num">${esc(t('pr.overKm'))}</th></tr>`;
      let body = '';
      if (d) {
        const fileOpts = (sel) => `<option value="-1"${sel === -1 ? ' selected' : ''}>${esc(t('pr.imp.none'))}</option>`
          + d.files.map((f, i) => `<option value="${i}"${sel === i ? ' selected' : ''}>${esc(f.title.replace(/^.*?:\s*/, ''))}</option>`).join('');
        const seasons = d.report.map((r) => {
          const season = seasonById(r.seasonId);
          const stats = t('pr.imp.stats', { models: r.models.length, plates: r.plates.length, removed: r.removed, same: r.same });
          const rows = [...r.models.map((m) => `<tr><td>${esc(m.model)}</td>${rowCells(m.old, m.new)}</tr>`),
            ...r.plates.map((p) => `<tr><td>${esc(p.model)} · <span class="plate">${esc(p.plate)}</span> <span class="muted jr-small">${esc(t('pr.imp.own'))}</span></td>${rowCells(p.old, p.new)}</tr>`)].join('');
          const notes = [
            r.suspicious.length ? `<p class="warn jr-small">⚠️ ${esc(t('pr.imp.suspicious', { list: r.suspicious.join(', ') }))}</p>` : '',
            r.file >= 0 && r.missing.length ? `<p class="muted jr-small">${esc(t('pr.imp.missing', { list: r.missing.join(', ') }))}</p>` : ''
          ].join('');
          return `<section class="pr-imp__season">
            <div class="pr-imp__map">
              <span class="pr-imp__name"><span class="pr-dot" style="background:${esc(season?.color || '#999')}"></span><b>${esc(season ? seasonLabel(season) : r.name)}</b>
                <span class="muted jr-small">${esc(season ? periodText(season) : '')}</span></span>
              <label class="field"><span>${esc(t('pr.imp.file'))}</span><select class="search" data-pr-imp-map="${r.seasonId}"${imp.busy ? ' disabled' : ''}>${fileOpts(r.file)}</select></label>
              ${r.file >= 0 ? `<span class="muted jr-small">${esc(t('pr.imp.cover', { n: r.coveredDays, total: r.totalDays }))}${r.file === r.auto ? '' : ` · ${esc(t('pr.imp.manual'))}`}</span>` : ''}
            </div>
            ${r.file >= 0 ? `<p class="jr-small">${esc(stats)}</p>
              ${rows ? `<details class="pr-imp__details"><summary>${esc(t('pr.imp.show'))}</summary>
                <div class="table-wrap"><table class="fin-table pr-imp__table"><thead>${head}</thead><tbody>${rows}</tbody></table></div></details>` : ''}
              ${notes}` : ''}
          </section>`;
        }).join('');
        const files = d.files.map((f) => `<li><b>${esc(f.title.replace(/^.*?:\s*/, ''))}</b> <span class="muted jr-small">${esc(f.name)} · ${esc(t('pr.imp.rows', { n: f.rows }))}${f.ranges.length ? '' : ` · ${esc(t('pr.imp.noDates'))}`}</span></li>`).join('');
        const noPlate = d.files.flatMap((f) => f.noPlate);
        const warn = (key, list) => (list.length ? `<p class="muted jr-small">${esc(t(key, { list: list.slice(0, 30).join(', ') + (list.length > 30 ? ` …(+${list.length - 30})` : '') }))}</p>` : '');
        body = `
          <ul class="pr-imp__files">${files}</ul>
          ${seasons}
          ${warn('pr.imp.notInFleet', d.notInFleet)}${warn('pr.imp.notInFiles', d.notInFiles)}${warn('pr.imp.noPlate', noPlate)}
          <div class="pr-imp__actions">
            <button type="button" class="btn btn--primary btn--small" data-pr-imp-apply${d.count && !imp.busy ? '' : ' disabled'}>${esc(d.count ? t('pr.imp.apply', { n: d.count }) : t('pr.imp.nothing'))}</button>
            <button type="button" class="btn btn--small" data-pr-imp-cancel>${esc(t('pr.imp.cancel'))}</button>
          </div>`;
      }
      return `<section class="card pr-imp">
        <h3>⬆ ${esc(t('pr.imp.title'))}</h3>
        <p class="muted jr-small">${esc(t('pr.imp.how'))}</p>
        <label class="btn btn--small${imp.busy ? ' is-busy' : ''}"><span>${esc(imp.files?.length ? t('pr.imp.other') : t('pr.imp.choose'))}</span>
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple data-pr-imp-files hidden></label>
        ${imp.busy ? `<p class="muted">${esc(t('pr.imp.reading'))}</p>` : ''}
        ${imp.error ? `<p class="md-status is-error" role="status">${esc(imp.error)}</p>` : ''}
        ${body}
        ${d ? '' : `<div class="pr-imp__actions"><button type="button" class="btn btn--small" data-pr-imp-cancel>${esc(t('pr.imp.cancel'))}</button></div>`}
      </section>`;
    }

    function render() {
      if (st.failed) return `<div class="pr"><div class="empty">${esc(st.failed)}</div></div>`;
      if (!st.data) return `<div class="pr"><div class="empty">${esc(t('pr.loading'))}</div></div>`;
      if (!st.data.active) return `<div class="pr"><div class="empty">${esc(t('pr.notYet'))}</div></div>`;
      return `<div class="pr">
        <div class="pr-head">
          <div class="chips pr-seasons" role="group" aria-label="${esc(t('pr.seasons'))}">${seasonChips()}</div>
          ${canEdit() ? `<button type="button" class="btn btn--small" data-pr-seasons>${esc(t('pr.editSeasons'))}</button>
            <button type="button" class="btn btn--small" data-pr-import aria-pressed="${Boolean(st.imp)}">⬆ ${esc(t('pr.import'))}</button>` : ''}
        </div>
        ${yearStrip()}
        ${issuesBlock()}
        ${importHtml()}
        ${st.msg ? `<p class="md-status is-${st.msg.kind === 'error' ? 'error' : 'ok'}" role="status">${esc(st.msg.text)}</p>` : ''}
        ${toolsHtml()}
        ${table()}
        ${saveBar()}
        <div class="pr-lower">${calcHtml()}${historyHtml()}</div>
        <dialog id="pr-dialog" class="sheet pr-sheet" aria-label="${esc(t('pr.confirmTitle'))}">${dialogHtml()}</dialog>
      </div>`;
    }

    /* -------------------------------------------- Окно: подтверждение и сезоны */

    function changeList() {
      const out = [];
      for (const e of st.edits.values()) {
        const model = st.data.models.find((m) => m.model === e.model);
        const season = seasonById(e.seasonId);
        const base = model ? baseRate(model, e.seasonId, e.scope === 'plate' ? e.key : null) : null;
        const who = `${e.model}${e.scope === 'plate' ? ` · ${e.key}` : ''} · ${season ? seasonLabel(season) : ''}`;
        if (e.remove) { out.push({ who, text: t('pr.ownRemoved'), flag: null }); continue; }
        if (!base && e.scope === 'plate') out.push({ who, text: t('pr.ownAdded'), flag: null });
        const was = asValues(base);
        e.values.forEach((v, i) => {
          if ((v ?? null) === (was[i] ?? null)) return;
          const label = i < 5 ? `${st.data.tiers[i]} ${t('unit.d')}` : i === 5 ? t('pr.deposit') : t('pr.overKm');
          const pct = was[i] && v ? (v - was[i]) / was[i] : null;
          const text = `${label}: ${was[i] ? money(was[i]) : '—'} → ${v ? money(v) : '—'}${pct !== null ? ` (${pct > 0 ? '+' : ''}${Math.round(pct * 100)}%)` : ''}`;
          const flag = i < 5 && !v ? t('pr.flagEmpty') : pct !== null && Math.abs(pct) > BIG_CHANGE ? t('pr.flagBig') : null;
          out.push({ who, text, flag });
        });
        if (typo(e.values.slice(0, 5))) out.push({ who, text: t('pr.typoHint'), flag: t('pr.flagTypo') });
      }
      return out;
    }

    function dialogHtml() {
      if (st.confirm === 'rates') {
        const list = changeList();
        const flags = list.filter((x) => x.flag).length;
        return `<div class="sheet__body">
          <div class="sheet__head"><div><div class="muted">${esc(t('tab.price'))}</div><h2>${esc(t('pr.confirmTitle'))}</h2></div>
            <button type="button" class="icon-btn icon-btn--plain" data-pr-close aria-label="${esc(t('pr.back'))}">×</button></div>
          ${flags ? `<p class="pr-warn">⚠️ ${esc(t('pr.flagsHint', { n: flags }))}</p>` : ''}
          <ul class="pr-changes">${list.map((x) => `<li${x.flag ? ' class="is-flag"' : ''}><b>${esc(x.who)}</b><span>${esc(x.text)}</span>${x.flag ? `<em>${esc(x.flag)}</em>` : ''}</li>`).join('')}</ul>
          <div class="md-buttons"><button type="button" class="btn" data-pr-close>${esc(t('pr.back'))}</button>
            <button type="button" class="btn btn--primary" data-pr-confirm${st.saving ? ' disabled' : ''}>${esc(t('pr.confirm', { n: list.length }))}</button></div>
        </div>`;
      }
      if (st.confirm === 'seasons' && st.seasonDraft) {
        const d = st.seasonDraft;
        return `<form class="sheet__body" data-pr-seasons-form>
          <div class="sheet__head"><div><div class="muted">${esc(t('tab.price'))}</div><h2>${esc(t('pr.editSeasons'))}</h2></div>
            <button type="button" class="icon-btn icon-btn--plain" data-pr-close aria-label="${esc(t('pr.back'))}">×</button></div>
          <p class="muted">${esc(t('pr.seasonsHint'))}</p>
          ${d.map((s, i) => s.remove ? '' : `<fieldset class="pr-sd" data-sd="${i}">
            <div class="pr-sd__head">
              <input type="color" value="${esc(s.color)}" data-sd-color="${i}" aria-label="${esc(t('pr.color'))}">
              <input class="search" value="${esc(s.name)}" data-sd-name="${i}" maxlength="30" aria-label="${esc(t('pr.seasonName'))}" required>
              <label class="mk-check"><input type="checkbox" data-sd-verified="${i}"${s.verified ? ' checked' : ''}> ${esc(t('pr.verified'))}</label>
              <button type="button" class="link pr-danger" data-sd-remove="${i}">${esc(t('pr.removeSeason'))}</button>
            </div>
            ${s.periods.map((p, j) => `<div class="pr-sd__period">
              <input class="search" value="${esc(p.from)}" placeholder="дд.мм" data-sd-from="${i}:${j}" aria-label="${esc(t('pr.from'))}"> –
              <input class="search" value="${esc(p.to)}" placeholder="дд.мм" data-sd-to="${i}:${j}" aria-label="${esc(t('pr.to'))}">
              ${s.periods.length > 1 ? `<button type="button" class="link" data-sd-delp="${i}:${j}" aria-label="${esc(t('pr.removePeriod'))}">×</button>` : ''}
            </div>`).join('')}
            <button type="button" class="link" data-sd-addp="${i}">${esc(t('pr.addPeriod'))}</button>
          </fieldset>`).join('')}
          <button type="button" class="btn btn--small" data-sd-add>${esc(t('pr.addSeason'))}</button>
          ${st.msg?.dialog ? `<p class="md-status is-error">${esc(st.msg.text)}</p>` : ''}
          <div class="md-buttons"><button type="button" class="btn" data-pr-close>${esc(t('pr.back'))}</button>
            <button type="submit" class="btn btn--primary"${st.saving ? ' disabled' : ''}>${esc(t('pr.saveSeasons'))}</button></div>
        </form>`;
      }
      return '';
    }

    function openDialog(kind) {
      st.confirm = kind;
      const dlg = document.getElementById('pr-dialog');
      if (!dlg) return;
      dlg.innerHTML = dialogHtml();
      if (!dlg.open) dlg.showModal?.();
    }
    function closeDialog() {
      st.confirm = null;
      st.seasonDraft = null;
      if (st.msg?.dialog) st.msg = null;
      const dlg = document.getElementById('pr-dialog');
      if (dlg?.open) dlg.close();
    }
    /** Черновик сезонов — из полей окна (то, что введено, но ещё не ушло в «change») */
    function syncDraft() {
      const d = st.seasonDraft;
      if (!d) return;
      document.querySelectorAll('#pr-dialog [data-sd-name]').forEach((el) => { d[Number(el.dataset.sdName)].name = el.value; });
      document.querySelectorAll('#pr-dialog [data-sd-color]').forEach((el) => { d[Number(el.dataset.sdColor)].color = el.value; });
      document.querySelectorAll('#pr-dialog [data-sd-verified]').forEach((el) => { d[Number(el.dataset.sdVerified)].verified = el.checked; });
      document.querySelectorAll('#pr-dialog [data-sd-from]').forEach((el) => { const [i, j] = el.dataset.sdFrom.split(':').map(Number); d[i].periods[j].from = el.value.trim(); });
      document.querySelectorAll('#pr-dialog [data-sd-to]').forEach((el) => { const [i, j] = el.dataset.sdTo.split(':').map(Number); d[i].periods[j].to = el.value.trim(); });
    }
    function refreshDialog() {
      const dlg = document.getElementById('pr-dialog');
      if (!dlg || !st.confirm) return;
      syncDraft();
      dlg.innerHTML = dialogHtml();
    }

    /**
     * Подписи столбцов всегда видны: закреплены под верхней панелью портала (её высоту
     * меряем — на телефоне и компьютере она разная). Если таблица шире экрана, она
     * прокручивается внутри своей рамки и вбок, и вниз — подписи закреплены в ней.
     */
    function afterRender() {
      const wrap = document.querySelector('#view .pr-table');
      if (!wrap) return;
      const bar = document.querySelector('.topbar');
      wrap.style.setProperty('--pr-head-top', `${bar ? bar.offsetHeight : 60}px`);
      wrap.classList.remove('pr-table--scroll');
      const table = wrap.querySelector('table');
      wrap.classList.toggle('pr-table--scroll', table.scrollWidth > wrap.clientWidth + 1);
    }
    let fitTimer = null;
    window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(afterRender, 100); });

    /** Перерисовать вкладку, сохранив фокус и прокрутку */
    function rerender() {
      const y = window.scrollY;
      ctx.rerender();
      window.scrollTo(0, y);
    }

    /* ------------------------------------------------------------ События */

    function findModel(name) { return st.data.models.find((m) => m.model === name); }

    function onInput(event) {
      const el = event.target;
      if (!el.closest?.('.pr')) return false;
      if (el.matches('[data-pr-q]')) {
        st.q = el.value;
        const pos = el.selectionStart;
        rerender();
        const input = document.querySelector('[data-pr-q]');
        if (input) { input.focus(); input.setSelectionRange(pos, pos); }
        return true;
      }
      if (el.matches('[data-pr-cell]')) {
        const model = findModel(el.dataset.prCell);
        const plate = el.dataset.plate || null;
        const sid = el.dataset.season;
        const values = [...(valuesOf(model, sid, plate) || valuesOf(model, sid))];
        const digits = el.value.replace(/[^\d]/g, '');
        values[Number(el.dataset.i)] = digits ? Number(digits) : null;
        setEdit(model, sid, plate, values);
        // Без перерисовки — чтобы не терять курсор: подсветка ячейки и счётчик внизу
        const base = baseRate(model, sid, plate);
        const was = base ? asValues(base)[Number(el.dataset.i)] : null;
        el.closest('td').classList.toggle('is-changed', (values[Number(el.dataset.i)] ?? null) !== (was ?? null));
        const bar = document.querySelector('[data-pr-savebar]');
        if (bar) bar.outerHTML = saveBar();
        return true;
      }
      return false;
    }

    function onChange(event) {
      const el = event.target;
      if (!el.closest?.('.pr')) return false;
      if (el.matches('[data-pr-imp-files]')) {
        const list = [...(el.files || [])];
        if (!list.length) return true;
        st.imp = { files: null, data: null, mapping: null, busy: true, error: null };
        rerender();
        Promise.all(list.map(async (f) => ({ name: f.name, data: await toBase64(f) })))
          .then((files) => { st.imp.files = files; return importPreview(); })
          .catch(() => { st.imp.busy = false; st.imp.error = t('pr.imp.failed'); rerender(); });
        return true;
      }
      if (el.matches('[data-pr-imp-map]') && st.imp) {
        st.imp.mapping = { ...(st.imp.mapping || {}), [el.dataset.prImpMap]: Number(el.value) };
        importPreview();
        return true;
      }
      if (el.matches('[data-pr-select]')) {
        if (el.checked) st.selected.add(el.dataset.prSelect); else st.selected.delete(el.dataset.prSelect);
        const bulk = document.querySelector('[data-pr-bulk] span');
        if (bulk) bulk.textContent = t('pr.bulk', { n: st.selected.size });
        const btn = document.querySelector('[data-pr-bulk] button');
        if (btn) btn.disabled = !st.selected.size;
        return true;
      }
      // Окно сезонов: правки черновика без перерисовки
      const d = st.seasonDraft;
      if (d) {
        if (el.dataset.sdName !== undefined) { d[Number(el.dataset.sdName)].name = el.value; return true; }
        if (el.dataset.sdColor !== undefined) { d[Number(el.dataset.sdColor)].color = el.value; return true; }
        if (el.dataset.sdVerified !== undefined) { d[Number(el.dataset.sdVerified)].verified = el.checked; return true; }
        for (const field of ['from', 'to']) {
          const ref = el.dataset[`sd${field === 'from' ? 'From' : 'To'}`];
          if (ref !== undefined) { const [i, j] = ref.split(':').map(Number); d[i].periods[j][field] = el.value.trim(); return true; }
        }
      }
      return false;
    }

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.pr')) return false;
      const dlg = el.closest('#pr-dialog');
      if (dlg && (el === dlg || el.closest('[data-pr-close]'))) { closeDialog(); return true; }
      if (el.closest('[data-pr-import]')) { st.imp = st.imp ? null : { files: null, data: null, mapping: null, busy: false, error: null }; st.msg = null; rerender(); return true; }
      if (el.closest('[data-pr-imp-cancel]')) { st.imp = null; rerender(); return true; }
      if (el.closest('[data-pr-imp-apply]')) { if (!st.imp?.busy) importPreview(true); return true; }
      const season = el.closest('[data-pr-season]');
      if (season) { st.season = Number(season.dataset.prSeason); rerender(); return true; }
      if (el.closest('[data-pr-reset]')) { st.q = ''; st.type = 'all'; rerender(); return true; }
      const type = el.closest('[data-pr-type]');
      if (type) { st.type = type.dataset.prType; rerender(); return true; }
      const open = el.closest('[data-pr-open]');
      if (open) { const m = open.dataset.prOpen; if (st.open.has(m)) st.open.delete(m); else st.open.add(m); rerender(); return true; }
      const ownOn = el.closest('[data-pr-own-on]');
      if (ownOn) {
        // Особая цена госномера начинается с цены модели — дальше её можно менять
        const model = findModel(ownOn.dataset.model);
        setEdit(model, st.season, ownOn.dataset.prOwnOn, [...valuesOf(model, st.season)]);
        rerender();
        return true;
      }
      const ownOff = el.closest('[data-pr-own-off]');
      if (ownOff) { setEdit(findModel(ownOff.dataset.model), st.season, ownOff.dataset.prOwnOff, null, true); rerender(); return true; }
      if (el.closest('[data-pr-discard]')) { st.edits.clear(); st.msg = null; rerender(); return true; }
      if (el.closest('[data-pr-review]')) { if (st.edits.size) openDialog('rates'); return true; }
      if (el.closest('[data-pr-confirm]')) { saveRates(); return true; }
      if (el.closest('[data-pr-seasons]')) {
        st.seasonDraft = st.data.seasons.map((s) => ({ id: s.id, name: s.name, color: s.color, verified: s.verified, periods: s.periods.map((p) => ({ from: dm(p.from), to: dm(p.to) })) }));
        openDialog('seasons');
        return true;
      }
      const d = st.seasonDraft;
      if (d) {
        if (el.closest('[data-sd-add]')) { d.push({ name: '', color: '#9b59b6', verified: true, periods: [{ from: '', to: '' }] }); refreshDialog(); return true; }
        const addp = el.closest('[data-sd-addp]');
        if (addp) { d[Number(addp.dataset.sdAddp)].periods.push({ from: '', to: '' }); refreshDialog(); return true; }
        const delp = el.closest('[data-sd-delp]');
        if (delp) { const [i, j] = delp.dataset.sdDelp.split(':').map(Number); d[i].periods.splice(j, 1); refreshDialog(); return true; }
        const rm = el.closest('[data-sd-remove]');
        if (rm) {
          const s = d[Number(rm.dataset.sdRemove)];
          if (!s.id || window.confirm(t('pr.removeSeasonConfirm', { name: s.name }))) { s.remove = true; refreshDialog(); }
          return true;
        }
      }
      const revert = el.closest('[data-pr-revert]');
      if (revert) {
        if (window.confirm(t('pr.revertConfirm'))) {
          api('/price/revert', { body: { id: Number(revert.dataset.prRevert) } })
            .then(() => { st.msg = { kind: 'ok', text: t('pr.reverted') }; return load(); })
            .catch((err) => { st.msg = { kind: 'error', text: errorText(err) }; rerender(); });
        }
        return true;
      }
      return false;
    }

    function errorText(err) {
      const own = t(`pr.err.${err.code}`);
      return own === `pr.err.${err.code}` ? t('pr.saveFailed') : own;
    }

    async function saveRates() {
      st.saving = true;
      refreshDialog();
      const rates = [...st.edits.values()].map((e) => (e.remove
        ? { seasonId: e.seasonId, scope: e.scope, key: e.key, remove: true }
        : { seasonId: e.seasonId, scope: e.scope, key: e.key, model: e.model, tiers: e.values.slice(0, 5), deposit: e.values[5], overKm: e.values[6] }));
      try {
        const r = await api('/price/save', { body: { rates } });
        st.edits.clear();
        st.selected.clear();
        st.msg = { kind: 'ok', text: t('pr.saved', { n: r.count }) };
        st.saving = false;
        closeDialog();
        await load();
      } catch (err) {
        st.saving = false;
        st.msg = { kind: 'error', text: errorText(err) };
        closeDialog();
        rerender();
      }
    }

    function onSubmit(event) {
      const form = event.target;
      if (!form.closest?.('.pr')) return false;
      event.preventDefault();
      const f = new FormData(form);
      if (form.matches('[data-pr-bulk]')) {
        const pct = Number(String(f.get('pct') || '').replace(',', '.').replace('%', ''));
        if (!Number.isFinite(pct) || !pct) return true;
        for (const name of st.selected) {
          const model = findModel(name);
          const values = valuesOf(model, st.season).map((v, i) => (v && i < 5 ? roundTo10(v * (1 + pct / 100)) : v));
          setEdit(model, st.season, null, values);
        }
        rerender();
        return true;
      }
      if (form.matches('[data-pr-copy]')) {
        const from = Number(f.get('from'));
        const pct = Number(String(f.get('pct') || '0').replace(',', '.').replace('%', '')) || 0;
        if (!window.confirm(t('pr.copyConfirm', { from: seasonLabel(seasonById(from)), to: seasonLabel(seasonById(st.season)), pct }))) return true;
        for (const model of visibleModels()) {
          const src = valuesOf(model, from);
          if (!src.some(Boolean)) continue;
          setEdit(model, st.season, null, src.map((v, i) => (v && i < 5 ? roundTo10(v * (1 + pct / 100)) : v)));
        }
        rerender();
        return true;
      }
      if (form.matches('[data-pr-calc]')) {
        st.calc = { model: f.get('model'), from: f.get('from'), to: f.get('to'), result: null, error: null };
        api(`/price/quote?model=${encodeURIComponent(st.calc.model)}&from=${st.calc.from}&to=${st.calc.to}`)
          .then((r) => { st.calc.result = r; rerender(); })
          .catch((err) => { st.calc.error = err.code === 'bad_dates' ? t('pr.badDates') : t('pr.loadFailed'); rerender(); });
        return true;
      }
      if (form.matches('[data-pr-seasons-form]')) {
        saveSeasons();
        return true;
      }
      return false;
    }

    async function saveSeasons() {
      syncDraft();
      const d = st.seasonDraft;
      const seasons = d.map((s, i) => (s.remove ? (s.id ? { id: s.id, remove: true } : null) : { id: s.id, name: s.name, color: s.color, verified: s.verified, sort: i, periods: s.periods }))
        .filter(Boolean);
      st.saving = true;
      refreshDialog();
      try {
        await api('/price/save', { body: { seasons } });
        st.saving = false;
        st.msg = { kind: 'ok', text: t('pr.seasonsSaved') };
        closeDialog();
        await load();
      } catch (err) {
        st.saving = false;
        st.msg = { kind: 'error', text: errorText(err), dialog: true };
        refreshDialog();
      }
    }

    /** Переход из «Обзора»: сразу найти модель */
    function show({ q = '' } = {}) {
      st.q = q;
      st.type = 'all';
    }

    /** Фоновое обновление портала не трогает вкладку, пока есть правки или открыто окно */
    function canRefresh() {
      return !st.edits.size && !st.confirm && !st.imp && !document.activeElement?.closest?.('.pr input, .pr select');
    }

    return { load, render, afterRender, onClick, onInput, onChange, onSubmit, show, canRefresh };
  }

  window.STAFF_PRICE = { create };
})();
