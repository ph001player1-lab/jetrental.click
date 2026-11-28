/**
 * ============================================================================
 * Деньги из портала (касса портала): приход и выдача денег не по чеку
 * ============================================================================
 * Оплата продления, аренды при выдаче по договору, предоплата брони, приход,
 * залог, возврат залога и предоплаты. Расходы по чекам — отдельно (expenses).
 * Каждая запись знает свою операцию (op_id) или событие выдачи по договору
 * (event_id): по ним операцию отменяют. Ничего не удаляется — отменённая
 * запись помечается (deleted_at, кто и почему) и в «Финансах» не считается.
 * ============================================================================
 */

import * as db from './db.js';
import { HttpError } from './http.js';
import { getVehicle } from './fleetStore.js';
import { currentRates } from './finance.js';
import { PAY_METHODS } from './ai/operation.js';
import { currentOpId } from './opContext.js';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS cash_moves (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    dir         TEXT NOT NULL,
    kind        TEXT NOT NULL,
    category    TEXT NOT NULL,
    amount      REAL NOT NULL,
    currency    TEXT NOT NULL,
    thb         INTEGER NOT NULL,
    method      TEXT,
    plate       TEXT,
    vehicle_id  INTEGER,
    contract_id INTEGER,
    party       TEXT,
    note        TEXT,
    by_email    TEXT,
    by_name     TEXT,
    deleted_at  TEXT,
    deleted_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS cash_moves_at ON cash_moves (at);
`);
// Операция и событие выдачи, причина отмены, когда меняли
for (const [col, type] of [['op_id', 'INTEGER'], ['event_id', 'INTEGER'], ['deleted_reason', 'TEXT'], ['edited_at', 'TEXT']]) {
  if (!db.raw.prepare('PRAGMA table_info(cash_moves)').all().some((c) => c.name === col)) db.raw.exec(`ALTER TABLE cash_moves ADD COLUMN ${col} ${type}`);
}
db.raw.exec('CREATE INDEX IF NOT EXISTS cash_moves_op ON cash_moves (op_id)');

const q = {
  add: db.raw.prepare(`INSERT INTO cash_moves (at, dir, kind, category, amount, currency, thb, method, plate, vehicle_id, contract_id, party, note, by_email, by_name, op_id, event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  all: db.raw.prepare('SELECT * FROM cash_moves WHERE deleted_at IS NULL ORDER BY at'),
  one: db.raw.prepare('SELECT * FROM cash_moves WHERE id = ?'),
  ofOp: db.raw.prepare('SELECT * FROM cash_moves WHERE op_id = ? ORDER BY id'),
  ofEvent: db.raw.prepare('SELECT * FROM cash_moves WHERE event_id = ? ORDER BY id'),
  del: db.raw.prepare('UPDATE cash_moves SET deleted_at = ?, deleted_by = ?, deleted_reason = ? WHERE id = ? AND deleted_at IS NULL'),
  undel: db.raw.prepare('UPDATE cash_moves SET deleted_at = NULL, deleted_by = NULL, deleted_reason = NULL WHERE id = ?'),
  update: db.raw.prepare('UPDATE cash_moves SET amount = ?, currency = ?, thb = ?, method = ?, note = ?, category = ?, edited_at = ? WHERE id = ?')
};

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => { const n = Number(String(v ?? '').replace(/[\s,]/g, '')); return Number.isFinite(n) ? n : null; };

function thbOf(amount, currency) {
  const rate = currency === 'THB' ? 1 : currentRates().rates[currency];
  if (!rate) throw new HttpError(400, 'bad_currency');
  return Math.round(amount * rate);
}

/** Способ оплаты из свободного текста договора («наличными», «перевод», «card»…) */
export function methodFromText(s) {
  const v = String(s || '').toLowerCase();
  if (/нал|cash|เงินสด/.test(v)) return 'cash';
  if (/карт|card|บัตร/.test(v)) return 'card';
  if (/перев|transfer|bank|банк|โอน|qr|promptpay/.test(v)) return 'transfer';
  return null;
}

/**
 * Деньги в кассу портала: dir in|out; бат — по курсу. Возвращает { id, thb, amount, currency }.
 * Операцию берёт из выполняемой «＋ Операция» (или m.opId), событие выдачи — m.eventId.
 */
export function addCashMove(m, staff) {
  const amount = num(m.amount);
  if (!(amount > 0)) throw new HttpError(400, 'bad_amount');
  const currency = /^[A-Z]{3}$/.test(String(m.currency || '')) ? m.currency : 'THB';
  const thb = thbOf(amount, currency);
  const vehicle = m.vehicleId ? getVehicle(m.vehicleId) : null;
  const id = Number(q.add.run(new Date().toISOString(), m.dir, m.kind, m.category, amount, currency, thb,
    PAY_METHODS.includes(m.method) ? m.method : null, vehicle?.plate || m.plate || null, vehicle?.id || null, Number(m.contractId) || null,
    text(m.party, 80) || null, text(m.note, 300) || null, staff.email, staff.name || staff.email,
    Number(m.opId) || currentOpId(), Number(m.eventId) || null).lastInsertRowid);
  console.log(`Cash move #${id}: ${m.dir} ${amount} ${currency} ${m.kind}/${m.category} by ${staff.email}`);
  return { id, thb, amount, currency };
}

export const moveById = (id) => q.one.get(Number(id) || 0) || null;
export const movesOfOp = (opId) => q.ofOp.all(Number(opId) || 0);
export const movesOfEvent = (eventId) => q.ofEvent.all(Number(eventId) || 0);
export const activeMoves = () => q.all.all();

/** Отменить запись (не удаляя): в «Финансах» её больше нет */
export function cancelMove(id, staff, reason = null) {
  const r = q.del.run(new Date().toISOString(), staff.name || staff.email, text(reason, 200) || null, Number(id));
  if (r.changes) console.log(`Cash move #${id} cancelled by ${staff.email}`);
  return r.changes > 0;
}
export const restoreMove = (id) => q.undel.run(Number(id));

/** Поменять сумму, способ, заметку, статью — запись остаётся той же */
export function updateMove(id, { amount, currency, method, note, category }) {
  const row = moveById(id);
  if (!row) throw new HttpError(404, 'not_found');
  const a = amount === undefined ? row.amount : num(amount);
  if (!(a > 0)) throw new HttpError(400, 'bad_amount');
  const cur = currency && /^[A-Z]{3}$/.test(currency) ? currency : row.currency;
  q.update.run(a, cur, thbOf(a, cur), method === undefined ? row.method : (PAY_METHODS.includes(method) ? method : null),
    note === undefined ? row.note : (text(note, 300) || null), category || row.category, new Date().toISOString(), row.id);
  return moveById(id);
}

/**
 * Деньги из портала — строками, как отчёты группы, для «Финансов» (выручка, касса у сотрудников,
 * залоги): row.m — уже посчитанное (как moneyOf отчёта). Возврат предоплаты брони уменьшает
 * выручку и наличные того, кто вернул (не «возврат залога»).
 */
export function portalMoneyRows() {
  return q.all.all().map((r) => {
    const cash = r.method === 'cash';
    const inn = r.dir === 'in';
    const back = !inn && r.kind === 'booking_refund' ? r.thb : 0;
    const rent = inn && (r.kind === 'extension' || r.category === 'rent') ? r.thb : back ? -back : 0;
    const extras = inn && !rent && ['extras', 'damage', 'other'].includes(r.category) ? r.thb : 0;
    const deposit = inn && r.category === 'deposit' ? r.thb : 0;
    const moneyIn = inn ? r.thb : back ? -back : 0;
    const at = Date.parse(r.at);
    return {
      id: `pm${r.id}`, ts: r.at, at, portal: true, kind: inn || back ? (r.kind === 'extension' ? 'extension' : 'payment') : 'return',
      author: r.by_name || r.by_email, author_name: r.by_name || r.by_email, text: '', data: '{}',
      m: {
        revenue: rent + extras, rent, extras, moneyIn, inCash: moneyIn && cash ? [{ currency: r.currency, amount: inn ? r.amount : -r.amount }] : [],
        cashLike: cash, transferLike: !cash, cashIn: moneyIn && cash ? moneyIn : 0,
        moneyOut: inn || back ? 0 : r.thb, outCash: !inn && !back && cash, deposit, returnDeposit: 0, left: 0, debt: 0, debtNote: null, toReceive: 0, toReturn: 0,
        bookingTotal: 0, prepaid: 0, receiver: r.by_name || r.by_email, plates: r.plate ? [{ plate: r.plate, model: null }] : [], from: null, to: null, keys: {}
      }
    };
  });
}
