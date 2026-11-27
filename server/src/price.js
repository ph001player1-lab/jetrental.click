/**
 * ============================================================================
 * Прайс в портале (вкладка «Прайс»)
 * ============================================================================
 * Сезоны с периодами (дд.мм – дд.мм, у сезона их может быть несколько),
 * цены по моделям на 5 сроков аренды (1–2 / 3–6 / 7–13 / 14–27 / 28+ дней),
 * залог и перепробег; при необходимости — особая цена отдельного госномера.
 * Каждое изменение — с подтверждением в портале и записью в историю (можно
 * отменить). Менять — владелец и админ, смотреть — менеджеры.
 *
 * Это источник цен для ботов, сайта и вкладки «Парк» вместо листов
 * Google-таблицы: один раз переносим цены из таблицы — с новыми сезонами
 * (Пик 20.12–20.01, Высокий 21.01–01.03, Средний 02.03–31.05 и 01.11–19.12,
 * Низкий 01.06–31.10) и последней ступенью «28+ дней» вместо «31+».
 * ============================================================================
 */

import * as db from './db.js';
import { TIER_LABELS, hasTypo } from './pricing.js';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS price_seasons (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    color    TEXT,
    sort     INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 1,
    periods  TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS price_rates (
    season_id INTEGER NOT NULL,
    scope     TEXT NOT NULL,
    key       TEXT NOT NULL,
    model     TEXT,
    tiers     TEXT NOT NULL,
    deposit   INTEGER,
    over_km   INTEGER,
    PRIMARY KEY (season_id, scope, key)
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    by_email    TEXT,
    by_name     TEXT,
    summary     TEXT,
    changes     TEXT NOT NULL,
    reverted_at TEXT,
    reverted_by TEXT
  );
`);

const q = {
  seasons: db.raw.prepare('SELECT * FROM price_seasons ORDER BY sort, id'),
  season: db.raw.prepare('SELECT * FROM price_seasons WHERE id = ?'),
  addSeason: db.raw.prepare('INSERT INTO price_seasons (name, color, sort, verified, periods) VALUES (?, ?, ?, ?, ?)'),
  updateSeason: db.raw.prepare('UPDATE price_seasons SET name = ?, color = ?, sort = ?, verified = ?, periods = ? WHERE id = ?'),
  deleteSeason: db.raw.prepare('DELETE FROM price_seasons WHERE id = ?'),
  deleteSeasonRates: db.raw.prepare('DELETE FROM price_rates WHERE season_id = ?'),
  rates: db.raw.prepare('SELECT * FROM price_rates'),
  rate: db.raw.prepare('SELECT * FROM price_rates WHERE season_id = ? AND scope = ? AND key = ?'),
  setRate: db.raw.prepare(`INSERT INTO price_rates (season_id, scope, key, model, tiers, deposit, over_km) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season_id, scope, key) DO UPDATE SET model = excluded.model, tiers = excluded.tiers, deposit = excluded.deposit, over_km = excluded.over_km`),
  deleteRate: db.raw.prepare('DELETE FROM price_rates WHERE season_id = ? AND scope = ? AND key = ?'),
  addHistory: db.raw.prepare('INSERT INTO price_history (at, by_email, by_name, summary, changes) VALUES (?, ?, ?, ?, ?)'),
  history: db.raw.prepare('SELECT * FROM price_history ORDER BY id DESC LIMIT ?'),
  historyById: db.raw.prepare('SELECT * FROM price_history WHERE id = ?'),
  markReverted: db.raw.prepare('UPDATE price_history SET reverted_at = ?, reverted_by = ? WHERE id = ?')
};

export class PriceError extends Error {
  constructor(code, details = null) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const now = () => new Date().toISOString();

/** Прайс уже в портале (перенесён из таблицы) — тогда таблицу для цен не читаем */
export const priceActive = () => q.seasons.all().length > 0;

/* ---------------------------------------------------------- Чтение */

const seasonOf = (row) => ({
  id: row.id, name: row.name, color: row.color || '#5d6d7e', sort: row.sort, verified: Boolean(row.verified),
  periods: parse(row.periods, []).filter((p) => p?.from && p?.to)
});

export const listSeasons = () => q.seasons.all().map(seasonOf);

const rateOf = (row) => ({
  seasonId: row.season_id, scope: row.scope, key: row.key, model: row.model,
  tiers: (parse(row.tiers, []) || []).slice(0, 5).concat([null, null, null, null, null]).slice(0, 5).map((v) => (v ? Number(v) : null)),
  deposit: row.deposit ?? null, overKm: row.over_km ?? null
});

/** Все цены: Map('season|scope|key' → rate) */
export function allRates() {
  const map = new Map();
  for (const row of q.rates.all()) map.set(`${row.season_id}|${row.scope}|${row.key}`, rateOf(row));
  return map;
}

/* ---------------------------------------- Для расчёта (боты, сайт, «Парк») */

/**
 * Прайс в формате расчёта pricing.js: сезоны (каждый период — отдельной
 * строкой) и цены по госномерам: особая цена госномера или цена его модели.
 * units — машины парка [{ plate, model }]; plateKey — нормализация госномера.
 */
export function buildPortalPricing(units, plateKey) {
  const seasons = [];
  for (const s of listSeasons()) {
    for (const p of s.periods) seasons.push({ id: s.id, name: s.name, sheet: `s${s.id}`, from: p.from, to: p.to, verified: s.verified });
  }
  const rates = allRates();
  const prices = new Map();
  for (const s of listSeasons()) {
    const byPlate = new Map();
    for (const unit of units) {
      const plate = plateKey(unit.plate);
      if (!plate) continue;
      const rate = rates.get(`${s.id}|plate|${plate}`) || (unit.model ? rates.get(`${s.id}|model|${unit.model}`) : null);
      if (!rate) continue;
      byPlate.set(plate, { name: unit.model, tiers: rate.tiers, suspicious: hasTypo(rate.tiers), deposit: rate.deposit, overKm: rate.overKm });
    }
    prices.set(`s${s.id}`, byPlate);
  }
  return { seasons, prices, source: 'portal' };
}

/** «Цена от» модели для сайта: самая низкая цена 28+ дней в проверенных сезонах */
export function priceFromByModel() {
  const verified = new Set(listSeasons().filter((s) => s.verified).map((s) => s.id));
  const out = new Map();
  for (const rate of allRates().values()) {
    if (rate.scope !== 'model' || !verified.has(rate.seasonId)) continue;
    const price = rate.tiers.filter(Boolean).at(-1);
    if (price && (!out.has(rate.key) || price < out.get(rate.key))) out.set(rate.key, price);
  }
  return out;
}

/* -------------------------------------------------- Сезоны: проверка */

/** Дни года без сезона и с двумя сезонами сразу — диапазонами ['ММ-ДД', 'ММ-ДД'] */
export function seasonIssues(seasons) {
  const flat = seasons.flatMap((s) => s.periods.map((p) => ({ name: s.name, ...p })));
  const covering = (md) => flat.filter((p) => (p.from <= p.to ? p.from <= md && md <= p.to : md >= p.from || md <= p.to)).map((p) => p.name);
  const gaps = [];
  const overlaps = [];
  let gap = null;
  let over = null;
  // 2024 — високосный: проверяем и 29 февраля
  for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2025, 0, 1); ms += 86400000) {
    const md = new Date(ms).toISOString().slice(5, 10);
    const names = covering(md);
    if (!names.length) { if (gap) gap[1] = md; else gap = [md, md]; } else if (gap) { gaps.push(gap); gap = null; }
    if (names.length > 1) {
      const key = [...new Set(names)].join(' + ');
      if (over && over.names === key) over.range[1] = md; else { if (over) overlaps.push(over); over = { names: key, range: [md, md] }; }
    } else if (over) { overlaps.push(over); over = null; }
  }
  if (gap) gaps.push(gap);
  if (over) overlaps.push(over);
  return { gaps, overlaps: overlaps.map((o) => ({ names: o.names, from: o.range[0], to: o.range[1] })) };
}

/* ------------------------------------------- Перенос из Google-таблицы */

// Новые сезоны (листок владельца, ноябрь 2026): название, цвет, периоды
const NEW_SEASONS = [
  { name: 'Пик', color: '#e2557d', periods: [{ from: '12-20', to: '01-20' }] },
  { name: 'Высокий', color: '#ff8a1f', periods: [{ from: '01-21', to: '03-01' }] },
  { name: 'Средний', color: '#2a8fa3', periods: [{ from: '03-02', to: '05-31' }, { from: '11-01', to: '12-19' }] },
  { name: 'Низкий', color: '#3ddc84', periods: [{ from: '06-01', to: '10-31' }] }
];

/**
 * Один раз: цены из листов таблицы → прайс портала. У модели — цена,
 * которая у большинства её машин; у машин с другой ценой — особая цена.
 * sheetPricing — то, что прочитал pricing.js из таблицы.
 */
export function importFromSheets(sheetPricing, units, plateKey) {
  if (priceActive() || !sheetPricing?.seasons?.length) return false;
  const sheetOf = new Map(sheetPricing.seasons.map((s) => [s.name.toLowerCase(), s]));
  const modelOf = new Map(units.map((u) => [plateKey(u.plate), u.model]).filter(([p, m]) => p && m));
  const sig = (e) => JSON.stringify([e.tiers, e.deposit, e.overKm]);
  let rates = 0;
  db.raw.exec('BEGIN');
  try {
    NEW_SEASONS.forEach((s, i) => {
      const old = sheetOf.get(s.name.toLowerCase());
      const seasonId = Number(q.addSeason.run(s.name, s.color, i, old ? (old.verified ? 1 : 0) : 1, JSON.stringify(s.periods)).lastInsertRowid);
      const byPlate = old ? sheetPricing.prices.get(old.sheet) : null;
      if (!byPlate) return;
      const byModel = new Map();
      for (const [plate, entry] of byPlate) {
        const model = modelOf.get(plate);
        if (!model) continue;
        if (!byModel.has(model)) byModel.set(model, []);
        byModel.get(model).push({ plate, entry });
      }
      for (const [model, list] of byModel) {
        // Цена модели — самая частая среди её машин
        const counts = new Map();
        for (const { entry } of list) counts.set(sig(entry), (counts.get(sig(entry)) || 0) + 1);
        const main = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        const base = list.find(({ entry }) => sig(entry) === main).entry;
        q.setRate.run(seasonId, 'model', model, model, JSON.stringify(base.tiers), base.deposit, base.overKm);
        rates++;
        for (const { plate, entry } of list) {
          if (sig(entry) === main) continue;
          q.setRate.run(seasonId, 'plate', plate, model, JSON.stringify(entry.tiers), entry.deposit, entry.overKm);
          rates++;
        }
      }
    });
    q.addHistory.run(now(), null, 'Перенос', 'Цены перенесены из Google-таблицы: новые сезоны, последняя ступень — 28+ дней', '[]');
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  console.log(`Price: imported from the Google sheet — ${NEW_SEASONS.length} seasons, ${rates} price rows`);
  return true;
}

/* --------------------------------------------------- Для вкладки «Прайс» */

/**
 * Всё для вкладки: сезоны, сроки, модели с ценами по сезонам и особыми ценами
 * госномеров, проверки, история. units — машины парка, types — тип модели.
 */
export function priceView(units, typeOf, plateKey) {
  const seasons = listSeasons();
  const rates = allRates();
  const models = new Map();
  for (const unit of units) {
    if (!unit.model) continue;
    if (!models.has(unit.model)) models.set(unit.model, { model: unit.model, type: typeOf(unit.model) || unit.type || null, plates: [] });
    const plate = plateKey(unit.plate);
    if (plate) models.get(unit.model).plates.push({ plate: unit.plate, key: plate });
  }
  // Модели с ценой, но без машин в парке (проданы) — тоже показываем, чтобы цену можно было убрать
  for (const rate of rates.values()) {
    if (rate.scope === 'model' && !models.has(rate.key)) models.set(rate.key, { model: rate.key, type: typeOf(rate.key) || null, plates: [], noUnits: true });
  }
  const out = [...models.values()].map((m) => ({
    ...m,
    rates: Object.fromEntries(seasons.map((s) => [s.id, rates.get(`${s.id}|model|${m.model}`) || null])),
    overrides: m.plates.flatMap((p) => seasons.map((s) => rates.get(`${s.id}|plate|${p.key}`)).filter(Boolean))
  }));
  const ORDER = ['scooter', 'motorcycle', 'car'];
  out.sort((a, b) => (ORDER.indexOf(a.type) + 1 || 9) - (ORDER.indexOf(b.type) + 1 || 9) || a.model.localeCompare(b.model));
  return {
    seasons, tiers: TIER_LABELS, models: out, issues: seasonIssues(seasons),
    history: q.history.all(40).map((h) => ({
      id: h.id, at: h.at, by: h.by_name || h.by_email || '—', summary: h.summary,
      changes: parse(h.changes, []), revertedAt: h.reverted_at, revertedBy: h.reverted_by
    }))
  };
}

/* ------------------------------------------------------- Изменения */

const cleanPrice = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(String(v).replace(/[\s,]/g, '')));
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new PriceError('bad_price');
  return n || null;
};
const cleanMd = (v) => {
  const m = /^(\d{1,2})[./-](\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const md = `${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // Проверка даты в високосном году — допускаем 29 февраля
  const d = new Date(`2024-${md}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(5, 10) !== md ? null : md;
};

const rateValue = (r) => (r ? { tiers: r.tiers, deposit: r.deposit, overKm: r.overKm } : null);

/**
 * Применить подтверждённые изменения (всё или ничего):
 *   rates:   [{ seasonId, scope: 'model'|'plate', key, model, tiers[5], deposit, overKm, remove }]
 *   seasons: [{ id?, name, color, verified, periods: [{ from: 'дд.мм', to: 'дд.мм' }], remove }]
 * В историю — старые и новые значения (для отмены).
 */
export function applyChanges(input, by, summary = null) {
  const changes = [];
  const seasonsIn = Array.isArray(input.seasons) ? input.seasons : [];
  const ratesIn = Array.isArray(input.rates) ? input.rates : [];
  if (!seasonsIn.length && !ratesIn.length) throw new PriceError('nothing_to_save');
  db.raw.exec('BEGIN');
  try {
    seasonsIn.forEach((s, i) => {
      const old = s.id ? q.season.get(Number(s.id)) : null;
      if (s.id && !old) throw new PriceError('season_not_found');
      if (s.remove) {
        if (!old) return;
        changes.push({ type: 'season', id: old.id, old: seasonOf(old), new: null });
        q.deleteSeasonRates.run(old.id);
        q.deleteSeason.run(old.id);
        return;
      }
      const name = String(s.name || '').trim().slice(0, 30);
      if (!name) throw new PriceError('season_name_required');
      const periods = (Array.isArray(s.periods) ? s.periods : []).map((p) => ({ from: cleanMd(p.from), to: cleanMd(p.to) }));
      if (!periods.length || periods.some((p) => !p.from || !p.to)) throw new PriceError('bad_period', name);
      const color = /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : old?.color || '#5d6d7e';
      const sort = Number.isFinite(Number(s.sort)) ? Number(s.sort) : i;
      const verified = s.verified === false ? 0 : 1;
      if (old) {
        // Сезон не меняли — не трогаем и не пишем в историю
        const was = seasonOf(old);
        if (was.name === name && was.color === color && was.sort === sort && was.verified === Boolean(verified) && JSON.stringify(was.periods) === JSON.stringify(periods)) return;
        q.updateSeason.run(name, color, sort, verified, JSON.stringify(periods), old.id);
        changes.push({ type: 'season', id: old.id, old: was, new: seasonOf(q.season.get(old.id)) });
      } else {
        const id = Number(q.addSeason.run(name, color, sort, verified, JSON.stringify(periods)).lastInsertRowid);
        changes.push({ type: 'season', id, old: null, new: seasonOf(q.season.get(id)) });
      }
    });
    for (const r of ratesIn) {
      const seasonId = Number(r.seasonId);
      if (!q.season.get(seasonId)) throw new PriceError('season_not_found');
      const scope = r.scope === 'plate' ? 'plate' : 'model';
      const key = String(r.key || '').trim().slice(0, 80);
      if (!key) throw new PriceError('bad_key');
      const oldRow = q.rate.get(seasonId, scope, key);
      const old = oldRow ? rateOf(oldRow) : null;
      if (r.remove) {
        if (!old) continue;
        q.deleteRate.run(seasonId, scope, key);
        changes.push({ type: 'rate', seasonId, scope, key, model: old.model, old: rateValue(old), new: null });
        continue;
      }
      const tiers = (Array.isArray(r.tiers) ? r.tiers : []).slice(0, 5).map(cleanPrice);
      while (tiers.length < 5) tiers.push(null);
      const deposit = cleanPrice(r.deposit);
      const overKm = cleanPrice(r.overKm);
      const model = String(r.model || old?.model || (scope === 'model' ? key : '')).slice(0, 80) || null;
      const next = { tiers, deposit, overKm };
      if (old && JSON.stringify(rateValue(old)) === JSON.stringify(next)) continue;
      q.setRate.run(seasonId, scope, key, model, JSON.stringify(tiers), deposit, overKm);
      changes.push({ type: 'rate', seasonId, scope, key, model, old: rateValue(old), new: next });
    }
    if (!changes.length) throw new PriceError('nothing_changed');
    const text = summary || summarize(changes);
    const id = Number(q.addHistory.run(now(), by?.email || null, by?.name || null, text, JSON.stringify(changes)).lastInsertRowid);
    db.raw.exec('COMMIT');
    return { id, count: changes.length, summary: text };
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}

function summarize(changes) {
  const rates = changes.filter((c) => c.type === 'rate');
  const seasons = changes.filter((c) => c.type === 'season');
  const models = [...new Set(rates.map((c) => c.model || c.key))];
  const parts = [];
  if (rates.length) parts.push(`цены: ${models.slice(0, 3).join(', ')}${models.length > 3 ? ` и ещё ${models.length - 3}` : ''}`);
  if (seasons.length) parts.push(`сезоны: ${[...new Set(seasons.map((c) => (c.new || c.old).name))].join(', ')}`);
  return parts.join('; ');
}

/** Отменить изменение из истории: вернуть старые значения (это тоже запись в истории) */
export function revertChange(historyId, by) {
  const row = q.historyById.get(Number(historyId));
  if (!row) throw new PriceError('not_found');
  if (row.reverted_at) throw new PriceError('already_reverted');
  const changes = parse(row.changes, []);
  if (!changes.length) throw new PriceError('cannot_revert');
  const seasons = [];
  const rates = [];
  for (const c of changes) {
    if (c.type === 'season') {
      if (!c.old) seasons.push({ id: c.id, remove: true });
      else if (!c.new) throw new PriceError('cannot_revert');
      else seasons.push({ ...c.old, periods: c.old.periods.map((p) => ({ from: mdToDm(p.from), to: mdToDm(p.to) })) });
    } else if (c.old) rates.push({ seasonId: c.seasonId, scope: c.scope, key: c.key, model: c.model, ...c.old });
    else rates.push({ seasonId: c.seasonId, scope: c.scope, key: c.key, remove: true });
  }
  const result = applyChanges({ seasons, rates }, by, `Отмена изменения от ${row.at.slice(0, 10)}: ${row.summary}`);
  q.markReverted.run(now(), by?.name || by?.email || null, row.id);
  return result;
}

const mdToDm = (md) => `${md.slice(3)}.${md.slice(0, 2)}`;
