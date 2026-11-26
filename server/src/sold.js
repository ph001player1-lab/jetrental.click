/**
 * ============================================================================
 * Архив техники: проданная, списанная или убранная по другой причине
 * ============================================================================
 * Владелец или админ переносит технику в архив: «Продана» (дата и цена — по
 * желанию), «Списана» или «Другое» (с заметкой). Такая техника
 * больше не считается частью парка: её нет в «Парке», календаре, свободных
 * машинах на сайте и в ботах, в предупреждениях и сверке с WS. История
 * (журнал, CRM, касса, выручка) остаётся. Google-таблицу и WS портал не
 * меняет — их можно почистить потом, портал на проданные уже не смотрит.
 * Модель запоминаем, чтобы страница модели на сайте осталась с надписью
 * «нет в наличии», даже если строку машины потом удалят из таблицы.
 * ============================================================================
 */

import * as db from './db.js';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS fleet_sold (
    plate    TEXT PRIMARY KEY,
    model    TEXT,
    ws_model TEXT,
    sold_on  TEXT,
    price    REAL,
    by       TEXT NOT NULL,
    at       TEXT NOT NULL
  );
`);

// Причина и заметка появились позже (раньше в архиве были только проданные)
for (const [col, type] of [['reason', "TEXT NOT NULL DEFAULT 'sold'"], ['note', 'TEXT']]) {
  if (!db.raw.prepare('PRAGMA table_info(fleet_sold)').all().some((c) => c.name === col)) db.raw.exec(`ALTER TABLE fleet_sold ADD COLUMN ${col} ${type}`);
}
export const REASONS = ['sold', 'written_off', 'other'];

const q = {
  all: db.raw.prepare('SELECT * FROM fleet_sold ORDER BY at DESC'),
  setReason: db.raw.prepare('UPDATE fleet_sold SET reason = ?, note = ? WHERE plate = ?'),
  upsert: db.raw.prepare(`INSERT INTO fleet_sold (plate, model, ws_model, sold_on, price, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plate) DO UPDATE SET sold_on = excluded.sold_on, price = excluded.price, by = excluded.by, at = excluded.at,
      model = COALESCE(excluded.model, fleet_sold.model), ws_model = COALESCE(excluded.ws_model, fleet_sold.ws_model)`),
  remove: db.raw.prepare('DELETE FROM fleet_sold WHERE plate = ?'),
  setModel: db.raw.prepare('UPDATE fleet_sold SET model = ? WHERE plate = ? AND model IS NULL'),
  setWsModel: db.raw.prepare('UPDATE fleet_sold SET ws_model = ? WHERE plate = ? AND ws_model IS NULL')
};

export const soldPlate = (plate) => String(plate || '').replace(/\D/g, '');

// Проданы до появления отметки в портале (по просьбе владельца, без цены и даты)
const FIRST_SOLD = ['7086', '800', '1615', '960', '6578'];
if (db.getSetting('fleet_sold_seed') !== '1') {
  const at = new Date().toISOString();
  for (const plate of FIRST_SOLD) q.upsert.run(plate, null, null, null, null, 'system', at);
  db.setSetting('fleet_sold_seed', '1');
}

let cache = null;
const rows = () => {
  if (!cache) cache = new Map(q.all.all().map((r) => [r.plate, r]));
  return cache;
};

export const isSold = (plate) => rows().has(soldPlate(plate));

/** Проданные: [{ plate, model, wsModel, soldOn, price, by, at }] */
export const soldList = () => [...rows().values()].map((r) => ({
  plate: r.plate, model: r.model || null, wsModel: r.ws_model || null, soldOn: r.sold_on || null,
  price: r.price ?? null, by: r.by, at: r.at, reason: REASONS.includes(r.reason) ? r.reason : 'sold', note: r.note || ''
}));

export class SoldError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Отметить проданной (или изменить дату и цену): { plate, date?, price?, model?, wsModel? } */
export function markSold(input, by) {
  const plate = soldPlate(input.plate);
  if (!plate || plate.length > 6) throw new SoldError('invalid_plate');
  const date = String(input.date || '').trim() || null;
  if (date && (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date)))) throw new SoldError('invalid_date');
  const raw = String(input.price ?? '').replace(/[\s,]/g, '');
  const price = raw === '' ? null : Number(raw);
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1e9)) throw new SoldError('invalid_price');
  const reason = REASONS.includes(input.reason) ? input.reason : 'sold';
  q.upsert.run(plate, input.model || null, input.wsModel || null, date, reason === 'sold' ? price : null, by, new Date().toISOString());
  q.setReason.run(reason, String(input.note ?? '').trim().slice(0, 300) || null, plate);
  cache = null;
  console.log(`Vehicle #${plate} archived (${reason}) by ${by}`);
}

/** Вернуть в парк (отметили по ошибке) */
export function unmarkSold(plate, by) {
  const key = soldPlate(plate);
  if (!rows().has(key)) throw new SoldError('not_sold');
  q.remove.run(key);
  cache = null;
  console.log(`Vehicle #${key} returned to the fleet by ${by}`);
}

/** Списком: по строке «госномер [дата ГГГГ-ММ-ДД] [цена]» → { marked, errors } */
export function markSoldList(text, by) {
  const result = { marked: 0, errors: [] };
  String(text || '').split(/\r?\n/).slice(0, 200).forEach((line, i) => {
    const parts = line.replace(/[#,;]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    const date = parts.find((p) => ISO_DATE.test(p)) || null;
    const numbers = parts.filter((p) => /^\d+$/.test(p));
    try {
      markSold({ plate: numbers[0], date, price: numbers[1] ?? '' }, by);
      result.marked++;
    } catch (err) {
      result.errors.push({ line: i + 1, error: err.code || 'failed', text: line.slice(0, 60) });
    }
  });
  return result;
}

/** Запомнить модель проданной машины (из таблицы или WS), пока строка ещё есть */
export function rememberSoldModels(units = [], wsCars = []) {
  let changed = false;
  for (const u of units) {
    const r = rows().get(soldPlate(u.plate));
    if (r && !r.model && u.model) { q.setModel.run(u.model, r.plate); changed = true; }
  }
  for (const c of wsCars) {
    const r = rows().get(soldPlate(c.number ?? c.plate));
    const model = String(c.model ?? c.wsModel ?? '').trim();
    if (r && !r.ws_model && model) { q.setWsModel.run(model, r.plate); changed = true; }
  }
  if (changed) cache = null;
}
