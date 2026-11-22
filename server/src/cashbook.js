/**
 * ============================================================================
 * Касса WS (выгрузка «Касса» из WS.Автопрокат, .xlsx) — для сверки с отчётами
 * ============================================================================
 * Админ загружает файл на вкладке «Финансы». Строки за период файла заменяют
 * прежние за тот же период (повторная загрузка не задваивает). Колонки ищем по
 * заголовкам: №, н/д, Дата, Клиент, Назначение платежа, Счет, Автомобиль,
 * Приход, Расход, Описание, Статус утверждения. Суммы в кассе — в батах.
 * ============================================================================
 */

import * as db from './db.js';
import { readFirstSheet } from './xlsx.js';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS fin_cashbook (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    booking     TEXT,
    client      TEXT,
    purpose     TEXT NOT NULL,
    account     TEXT,
    vehicle     TEXT,
    plate       TEXT,
    income      REAL NOT NULL DEFAULT 0,
    expense     REAL NOT NULL DEFAULT 0,
    description TEXT,
    status      TEXT
  );
  CREATE INDEX IF NOT EXISTS fin_cashbook_ts ON fin_cashbook (ts);
`);

/** Назначение платежа → статья сверки */
export const PURPOSE_GROUP = {
  'Оплата за аренду': 'rent',
  'Оплата за доп. услуги': 'extras',
  'Delivery to client': 'extras',
  'Предоплата за заявку/бронь': 'prepaid',
  'Внесение залога': 'depositIn',
  'Возврат залога': 'depositOut',
  'Возврат за аренду': 'refund',
  // Перемещения денег (снятие в банк/владельцу, внесение) — не расход и не выручка
  'Снятие средств': 'transfer',
  'Внесение средств': 'transfer'
};

const HEADERS = {
  booking: 'н/д', date: 'Дата', client: 'Клиент', purpose: 'Назначение платежа', account: 'Счет',
  vehicle: 'Автомобиль', income: 'Приход', expense: 'Расход', description: 'Описание', status: 'Статус утверждения'
};

/** '21.11.2026 17:37' → ISO (время по Бангкоку) */
function parseWsDate(value) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(value || '').trim());
  if (!m) return null;
  const pad = (x) => String(x).padStart(2, '0');
  const iso = `${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(m[4] || 0)}:${m[5] || '00'}:00+07:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const amount = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Загрузить файл кассы: { rows, from, to, replaced } */
export function importCashbook(buffer, by) {
  let table;
  try {
    table = readFirstSheet(buffer);
  } catch {
    throw Object.assign(new Error('not_cashbook'), { code: 'not_cashbook' });
  }
  const headerIndex = table.findIndex((r) => r.includes(HEADERS.purpose) && r.includes(HEADERS.income) && r.includes(HEADERS.date));
  if (headerIndex < 0) throw Object.assign(new Error('not_cashbook'), { code: 'not_cashbook' });
  const header = table[headerIndex];
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, name]) => [k, header.indexOf(name)]));
  const cell = (row, key) => (col[key] >= 0 ? row[col[key]] : null);
  const text = (v) => (v == null ? null : String(v).trim() || null);

  const rows = [];
  for (const row of table.slice(headerIndex + 1)) {
    const ts = parseWsDate(cell(row, 'date'));
    const purpose = text(cell(row, 'purpose'));
    if (!ts || !purpose) continue;
    const vehicle = text(cell(row, 'vehicle'));
    rows.push({
      ts, purpose, vehicle,
      booking: text(cell(row, 'booking')),
      client: text(cell(row, 'client')),
      account: text(cell(row, 'account')),
      plate: /\((\d{2,5})\s*\)\s*$/.exec(vehicle || '')?.[1] || null,
      income: amount(cell(row, 'income')),
      expense: amount(cell(row, 'expense')),
      description: text(cell(row, 'description')),
      status: text(cell(row, 'status'))
    });
  }
  if (!rows.length) throw Object.assign(new Error('not_cashbook'), { code: 'not_cashbook' });
  const from = rows.reduce((m, r) => (r.ts < m ? r.ts : m), rows[0].ts);
  const to = rows.reduce((m, r) => (r.ts > m ? r.ts : m), rows[0].ts);

  const insert = db.raw.prepare(`INSERT INTO fin_cashbook (ts, booking, client, purpose, account, vehicle, plate, income, expense, description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.raw.exec('BEGIN');
  let replaced = 0;
  try {
    // Тот же период из нового файла заменяет старый — повторная загрузка не задваивает
    replaced = Number(db.raw.prepare('DELETE FROM fin_cashbook WHERE ts BETWEEN ? AND ?').run(from, to).changes);
    for (const r of rows) insert.run(r.ts, r.booking, r.client, r.purpose, r.account, r.vehicle, r.plate, r.income, r.expense, r.description, r.status);
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  const covered = db.raw.prepare('SELECT MIN(ts) a, MAX(ts) b FROM fin_cashbook').get();
  const meta = { at: new Date().toISOString(), by, rows: rows.length, from, to, coveredFrom: covered.a, coveredTo: covered.b };
  db.setSetting('cashbook_import', JSON.stringify(meta));
  console.log(`Cashbook import by ${by}: ${rows.length} rows ${from.slice(0, 10)}…${to.slice(0, 10)} (replaced ${replaced})`);
  return { ...meta, replaced };
}

export function cashbookMeta() {
  try {
    return JSON.parse(db.getSetting('cashbook_import') || 'null');
  } catch {
    return null;
  }
}

/** Строки кассы за период [fromIso, toIso) */
export function cashbookRows(fromIso, toIso) {
  return db.raw.prepare('SELECT * FROM fin_cashbook WHERE ts >= ? AND ts < ? ORDER BY ts').all(fromIso, toIso);
}
