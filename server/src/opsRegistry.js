/**
 * ============================================================================
 * Вкладка «Операции»: всё, что сделано в портале, — открыть, изменить, отменить
 * ============================================================================
 * Операция «＋ Операция» помнит всё, что создала: статус техники (vehicle_events.op_id),
 * деньги (cash_moves.op_id), расходы (expenses.op_id), документы (в result).
 * Статусы из «Парка» и выдачи по договору — тоже строками списка.
 *
 * Отменить: статусы снимаются, деньги и расходы помечаются отменёнными (в «Финансах»
 * их больше нет), в группу уходит «Cancelled». Ничего не удаляется: отменённое
 * остаётся в списке с причиной, кто и когда. Бронь с предоплатой: вернули клиенту
 * (вся или часть — запись возврата), оставили компании (остаётся в приходе) или
 * ошибочная запись (денег не было — предоплата отменяется).
 * Изменить: бронь (техника, даты, клиент, сумма, предоплата) и деньги (сумма, способ).
 * Свою операцию — автор в течение суток, любую — владелец и админ.
 *
 *   GET  /api/staff/ops?from=&to=&kind=&q=&mine=   — список
 *   GET  /api/staff/ops/one?id=op12|ev34           — карточка
 *   POST /api/staff/ops/cancel { id, reason, refund?: { mode, amount, method } }
 *   POST /api/staff/ops/edit   { id, changes }
 *   GET  /api/staff/ops/bookings?vehicleId=        — брони техники для договора
 * ============================================================================
 */

import * as db from './db.js';
import { HttpError, sendJson, readJson } from './http.js';
import { can } from './roles.js';
import { getVehicle, vehicleByPlate, setRepair, keyOf } from './fleetStore.js';
import { invalidateFleet } from './fleet.js';
import { eventsOfOp, eventsBetween, getEvent, undoEvent, redoEvent, editEvent, eventReport, StatusError } from './vehicleStatus.js';
import { addCashMove, movesOfOp, movesOfEvent, cancelMove, updateMove } from './cashMoves.js';
import { postFleetEvent } from './wabot.js';
import { currentRates } from './finance.js';
import { isOwnerOrAdmin, allowedOps, anyKind } from './opPerms.js';
import { PAY_METHODS, EXPENSE_CATEGORIES } from './ai/operation.js';
import { todayIso } from './dates.js';

const DAY_MS = 86400000;
const EDITABLE = ['booking', 'income', 'deposit_refund', 'extend', 'expense', 'payout'];
const REFUND_MODES = ['returned', 'kept', 'partial', 'mistake'];

// Таблицы op_drafts и expenses создаёт operations.js — запросы готовим при первом обращении
let Q = null;
const qq = () => Q || (Q = {
  done: db.raw.prepare(`SELECT * FROM op_drafts WHERE status = 'done' AND COALESCE(done_at, updated_at) >= ? AND COALESCE(done_at, updated_at) < ?
    ORDER BY COALESCE(done_at, updated_at) DESC LIMIT 1500`),
  recentDone: db.raw.prepare("SELECT * FROM op_drafts WHERE status = 'done' AND COALESCE(done_at, updated_at) >= ? ORDER BY id DESC"),
  op: db.raw.prepare('SELECT * FROM op_drafts WHERE id = ?'),
  setState: db.raw.prepare('UPDATE op_drafts SET state = ?, state_at = ?, state_by = ?, state_reason = ?, state_info = ? WHERE id = ?'),
  setForm: db.raw.prepare('UPDATE op_drafts SET form = ?, edited_at = ?, history = ? WHERE id = ?'),
  expOfOp: db.raw.prepare('SELECT * FROM expenses WHERE op_id = ? ORDER BY id'),
  expDel: db.raw.prepare('UPDATE expenses SET deleted_at = ?, deleted_by = ?, deleted_reason = ? WHERE id = ? AND deleted_at IS NULL'),
  expUpd: db.raw.prepare('UPDATE expenses SET amount = ?, currency = ?, thb = ?, method = ?, note = ?, category = ? WHERE id = ?')
});

const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => { const n = Number(String(v ?? '').replace(/[\s,]/g, '')); return Number.isFinite(n) ? n : null; };
const int = (v) => { const n = num(v); return n !== null && n >= 0 && String(v ?? '').trim() !== '' ? Math.round(n) : null; };
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const live = (x) => !x.deleted_at;
const sum = (list) => list.reduce((s, x) => s + (Number(x.thb) || 0), 0);
const nameOf = (v) => (v ? v.clientModel || [v.brand, v.model].filter(Boolean).join(' ') || v.plate : '');
const money = (n) => `${new Intl.NumberFormat('en-US').format(Math.round(n))} THB`;
const who = (staff) => staff.name || staff.email;
const statusCall = (fn) => {
  try { return fn(); } catch (err) {
    if (err instanceof StatusError) throw new HttpError(400, err.code);
    throw err;
  }
};

/* ------------------------------------------------------------ Строки */

/** Предоплата брони: принятые деньги (kind booking) минус возвращённые (booking_refund) */
function bookingMoney(moves) {
  const ins = moves.filter((m) => live(m) && m.dir === 'in' && m.kind === 'booking');
  const back = moves.filter((m) => live(m) && m.dir === 'out' && m.kind === 'booking_refund');
  return { ins, prepaid: sum(ins), refunded: sum(back), method: ins[0]?.method || null };
}

/** Строка списка по операции «＋ Операция» (full — для карточки: всё, что она создала) */
function opItem(r, staff, full = false) {
  const form = parse(r.form, {}) || {};
  const kind = form.kind || r.hint || 'unknown';
  const events = eventsOfOp(r.id);
  const moves = movesOfOp(r.id);
  const exps = qq().expOfOp.all(r.id);
  const result = parse(r.result, []) || [];
  const ev = events.find((e) => !e.undone_at) || events[0] || null;
  const vehicle = form.vehicleId ? getVehicle(form.vehicleId) : (ev ? vehicleByPlate(ev.plate) : null);
  const plates = [...new Set([vehicle?.plate, ...events.map((e) => e.plate), ...moves.map((m) => m.plate), ...exps.map((e) => e.plate)].filter(Boolean))];
  const at = r.done_at || r.updated_at;
  const state = r.state || 'done';
  const inn = sum(moves.filter((m) => live(m) && m.dir === 'in'));
  const out = sum(moves.filter((m) => live(m) && m.dir === 'out')) + sum(exps.filter(live));
  const own = r.staff_email === staff.email;
  const mayChange = state === 'done' && (isOwnerOrAdmin(staff) || (own && Date.now() - Date.parse(at) < DAY_MS));
  const item = {
    id: `op${r.id}`, src: 'op', kind, at, by: r.staff_name || r.staff_email, own, state,
    stateAt: r.state_at || null, stateBy: r.state_by || null, stateReason: r.state_reason || null, stateInfo: parse(r.state_info, null),
    plates, vehicle: vehicle ? { id: vehicle.id, plate: vehicle.plate, name: nameOf(vehicle) } : null,
    client: text(form.clientName || ev?.client_name || moves.find((m) => m.party)?.party || form.payee || '', 100),
    from: ev?.date_from || form.bookFrom || null, to: ev?.date_to || form.bookTo || form.newTo || null,
    moneyIn: inn, moneyOut: out,
    docs: result.filter((d) => d.type === 'doc').map((d) => ({ id: d.id, contractId: d.contractId || null, number: d.number, kind: d.kind })),
    note: text(form.note || r.note || '', 200), edited: Boolean(r.edited_at),
    canCancel: mayChange, canEdit: mayChange && EDITABLE.includes(kind)
  };
  if (kind === 'booking') {
    const b = bookingMoney(moves);
    item.booking = { total: int(form.total), prepaid: b.prepaid, refunded: b.refunded, method: b.method, left: int(form.total) ? Math.max(0, int(form.total) - b.prepaid) : null };
  }
  if (!full) return item;
  return {
    ...item,
    form,
    done: result,
    history: parse(r.history, []) || [],
    events: events.map((e) => ({ id: e.id, kind: e.kind, plate: e.plate, from: e.date_from, to: e.date_to, client: e.client_name || '', phone: e.client_phone || '', note: e.note || '', cancelled: Boolean(e.undone_at), wa: e.wa_status })),
    moves: moves.map((m) => ({ id: m.id, dir: m.dir, kind: m.kind, category: m.category, amount: m.amount, currency: m.currency, thb: m.thb, method: m.method, note: m.note || '', at: m.at, cancelled: Boolean(m.deleted_at), reason: m.deleted_reason || null })),
    expenses: exps.map((e) => ({ id: e.id, thb: e.thb, amount: e.amount, currency: e.currency, category: e.category, method: e.method, vendor: e.vendor || '', note: e.note || '', cancelled: Boolean(e.deleted_at), reason: e.deleted_reason || null }))
  };
}

/** Строка по статусу из «Парка» или выдаче по договору (без «＋ Операция») */
function eventItem(e, staff, full = false) {
  const vehicle = vehicleByPlate(e.plate);
  const moves = movesOfEvent(e.id);
  const own = e.by_email === staff.email;
  const state = e.undone_at ? 'cancelled' : 'done';
  const mayChange = state === 'done' && (isOwnerOrAdmin(staff) || (own && Date.now() - Date.parse(e.at) < DAY_MS));
  const item = {
    id: `ev${e.id}`, src: 'event', kind: e.doc_id ? 'contract' : 'status', status: e.kind, at: e.at, by: e.by_name || e.by_email, own, state,
    stateAt: e.undone_at || null, stateBy: e.undone_by || null, stateReason: null, stateInfo: null,
    plates: [e.plate], vehicle: vehicle ? { id: vehicle.id, plate: vehicle.plate, name: nameOf(vehicle) } : { id: null, plate: e.plate, name: '' },
    client: e.client_name || '', from: e.date_from, to: e.date_to, docId: e.doc_id || null,
    moneyIn: sum(moves.filter((m) => live(m) && m.dir === 'in')), moneyOut: sum(moves.filter((m) => live(m) && m.dir === 'out')),
    docs: [], note: e.note || '', edited: Boolean(e.edited_at),
    // Выдачу по договору отменяют в договоре («Отменить выдачу») — там и документы
    canCancel: mayChange && !e.doc_id, canEdit: false
  };
  if (!full) return item;
  return {
    ...item, form: null, done: [], history: [],
    events: [{ id: e.id, kind: e.kind, plate: e.plate, from: e.date_from, to: e.date_to, client: e.client_name || '', phone: e.client_phone || '', note: e.note || '', cancelled: Boolean(e.undone_at), wa: e.wa_status }],
    moves: moves.map((m) => ({ id: m.id, dir: m.dir, kind: m.kind, category: m.category, amount: m.amount, currency: m.currency, thb: m.thb, method: m.method, note: m.note || '', at: m.at, cancelled: Boolean(m.deleted_at), reason: m.deleted_reason || null })),
    expenses: []
  };
}

/** Что сотруднику видно: владельцу и админу — всё; остальным — свои, операции своих видов, статусы — при доступе к «Парку» */
function visible(item, staff, kinds) {
  if (isOwnerOrAdmin(staff) || item.own) return true;
  if (item.src === 'op') return kinds.has(item.kind);
  return can(staff, 'fleet.view');
}

const mayOpen = (staff) => anyKind(staff) || can(staff, 'fleet.edit');

function itemById(id, staff, full) {
  const m = /^(op|ev)(\d+)$/.exec(String(id || ''));
  if (!m) throw new HttpError(404, 'not_found');
  if (m[1] === 'op') {
    const r = qq().op.get(Number(m[2]));
    if (!r || r.status !== 'done') throw new HttpError(404, 'not_found');
    return { row: r, item: opItem(r, staff, full) };
  }
  const e = getEvent(Number(m[2]));
  if (!e) throw new HttpError(404, 'not_found');
  // Событие операции — открываем операцию
  if (e.op_id) return itemById(`op${e.op_id}`, staff, full);
  return { event: e, item: eventItem(e, staff, full) };
}

/* ------------------------------------------------------------ Список */

export async function opsList(staff, req, res, url) {
  if (!mayOpen(staff)) throw new HttpError(403, 'no_section_access');
  const p = url.searchParams;
  const today = todayIso();
  const from = isDay(p.get('from')) ? p.get('from') : new Date(Date.parse(`${today}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
  const to = isDay(p.get('to')) ? p.get('to') : today;
  const fromIso = new Date(Date.parse(`${from}T00:00:00+07:00`)).toISOString();
  const toIso = new Date(Date.parse(`${to}T00:00:00+07:00`) + DAY_MS).toISOString();
  const kinds = new Set(allowedOps(staff));
  const items = [
    ...qq().done.all(fromIso, toIso).map((r) => opItem(r, staff)),
    ...eventsBetween(fromIso, toIso).filter((e) => !e.op_id).map((e) => eventItem(e, staff))
  ].filter((it) => visible(it, staff, kinds));
  const kind = String(p.get('kind') || '');
  const qs = String(p.get('q') || '').trim().toLowerCase();
  const out = items
    .filter((it) => !kind || it.kind === kind || (kind === 'cancelled' && it.state === 'cancelled'))
    .filter((it) => p.get('mine') !== '1' || it.own)
    .filter((it) => !qs || [...it.plates, it.client, it.by, it.vehicle?.name, it.note, ...it.docs.map((d) => d.number)].some((x) => String(x || '').toLowerCase().includes(qs)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 500);
  sendJson(res, 200, { from, to, items: out, total: out.length, seeAll: isOwnerOrAdmin(staff) });
}

export async function opsOne(staff, req, res, url) {
  if (!mayOpen(staff)) throw new HttpError(403, 'no_section_access');
  const { item } = itemById(url.searchParams.get('id'), staff, true);
  if (!visible(item, staff, new Set(allowedOps(staff)))) throw new HttpError(404, 'not_found');
  sendJson(res, 200, { item });
}

/* ------------------------------------------------------------ Отмена */

async function tellGroup(lines, mark, staff) {
  const wa = await postFleetEvent([...lines.filter(Boolean), `[portal #${mark} · ${who(staff)}]`].join('\n'));
  return wa.status;
}

const KIND_EN = {
  booking: 'Booking', issue: 'Rented', return: 'Return', swap: 'Vehicle swap', extend: 'Extension', service: 'Service', expense: 'Expense',
  income: 'Payment', deposit_refund: 'Deposit returned', payout: 'Payout', status: 'Status', contract: 'Contract'
};

export async function opsCancel(staff, req, res) {
  if (!mayOpen(staff)) throw new HttpError(403, 'no_section_access');
  const body = await readJson(req);
  const found = itemById(body.id, staff, true);
  const { item } = found;
  if (!item.canCancel) throw new HttpError(403, item.state !== 'done' ? 'already_cancelled' : 'cancel_not_allowed');
  const reason = text(body.reason, 200);
  if (reason.length < 3) throw new HttpError(400, 'reason_required');
  const lines = [];
  const info = {};
  const plate = item.plates[0] || '';

  if (found.event) {
    const e = found.event;
    statusCall(() => undoEvent(e.id, staff));
    for (const m of movesOfEvent(e.id)) if (live(m)) cancelMove(m.id, staff, reason);
    invalidateFleet();
    const wa = await tellGroup([`Cancelled`, `#${e.plate} ${item.vehicle?.name || ''}`.trim(), `${KIND_EN.status}: ${e.kind}`, `Reason: ${reason}`], e.id, staff);
    console.log(`Operation ev${e.id} cancelled by ${staff.email}`);
    return sendJson(res, 200, { ok: true, wa });
  }

  const r = found.row;
  const kind = item.kind;
  const moves = movesOfOp(r.id);
  const events = eventsOfOp(r.id).filter((e) => !e.undone_at);

  if (kind === 'booking') {
    const b = bookingMoney(moves);
    const left = b.prepaid - b.refunded;
    if (left > 0) {
      const mode = REFUND_MODES.includes(body.refund?.mode) ? body.refund.mode : null;
      if (!mode) throw new HttpError(400, 'refund_mode_required');
      const method = PAY_METHODS.includes(body.refund?.method) ? body.refund.method : null;
      let back = 0;
      if (mode === 'returned') back = left;
      if (mode === 'partial') {
        back = int(body.refund?.amount) || 0;
        if (!(back > 0 && back < left)) throw new HttpError(400, 'bad_refund_amount');
      }
      if (mode === 'mistake') {
        for (const m of b.ins) cancelMove(m.id, staff, `ошибочная бронь: ${reason}`);
      } else if (back > 0) {
        addCashMove({ dir: 'out', kind: 'booking_refund', category: 'rent', amount: back, currency: 'THB', method, vehicleId: item.vehicle?.id, party: item.client, note: `возврат предоплаты: ${reason}`, opId: r.id }, staff);
      }
      Object.assign(info, { mode, prepaid: left, returned: mode === 'mistake' ? 0 : back, kept: mode === 'mistake' ? 0 : left - back, method });
      lines.push(mode === 'mistake' ? `Prepaid ${money(left)}: entered by mistake, removed`
        : back ? `Prepaid returned: ${money(back)}${method ? ` (${method})` : ''}${left - back > 0 ? ` · kept: ${money(left - back)}` : ''}`
          : `Prepaid kept by the company: ${money(left)}`);
    }
  } else {
    for (const m of moves) if (live(m)) cancelMove(m.id, staff, reason);
  }
  for (const e of events) statusCall(() => undoEvent(e.id, staff));
  // Ремонт: отменили «в ремонт» — снова исправна; отменили «из ремонта» — снова в ремонте
  for (const e of events.filter((x) => x.kind === 'service' || (kind === 'service' && x.kind === 'free'))) {
    const v = vehicleByPlate(e.plate);
    if (v) setRepair(v.id, e.kind === 'service' ? 'ok' : 'in_repair', staff.email);
  }
  for (const x of qq().expOfOp.all(r.id)) if (live(x)) qq().expDel.run(new Date().toISOString(), who(staff), reason, x.id);
  qq().setState.run('cancelled', new Date().toISOString(), who(staff), reason, JSON.stringify(info), r.id);
  invalidateFleet();
  const docs = item.docs.map((d) => d.number).filter(Boolean);
  const wa = await tellGroup([
    'Cancelled', plate ? `#${plate} ${item.vehicle?.name || ''}`.trim() : null,
    `${KIND_EN[kind] || kind}${item.from && item.to ? ` ${item.from.split('-').reverse().join('.')}–${item.to.split('-').reverse().join('.')}` : ''}${item.client ? ` · ${item.client}` : ''}`,
    ...lines, docs.length ? `Documents stay: ${docs.join(', ')}` : null, `Reason: ${reason}`
  ], `op${r.id}`, staff);
  console.log(`Operation op${r.id} («${kind}») cancelled by ${staff.email}`);
  sendJson(res, 200, { ok: true, wa });
}

/* ------------------------------------------------------------ Изменить */

function pushHistory(r, staff, what) {
  const list = parse(r.history, []) || [];
  list.push({ at: new Date().toISOString(), by: who(staff), what: what.slice(0, 300) });
  return JSON.stringify(list.slice(-50));
}

function updateExpense(x, ch) {
  const amount = ch.amount === undefined ? x.amount : num(ch.amount);
  if (!(amount > 0)) throw new HttpError(400, 'bad_amount');
  const currency = /^[A-Z]{3}$/.test(String(ch.currency || '')) ? ch.currency : x.currency;
  const rate = currency === 'THB' ? 1 : currentRates().rates[currency];
  if (!rate) throw new HttpError(400, 'bad_currency');
  qq().expUpd.run(amount, currency, Math.round(amount * rate), ch.method === undefined ? x.method : (PAY_METHODS.includes(ch.method) ? ch.method : null),
    ch.note === undefined ? x.note : (text(ch.note, 300) || null), EXPENSE_CATEGORIES.includes(ch.category) ? ch.category : x.category, x.id);
  return Math.round(amount * rate);
}

export async function opsEdit(staff, req, res) {
  if (!mayOpen(staff)) throw new HttpError(403, 'no_section_access');
  const body = await readJson(req);
  const found = itemById(body.id, staff, true);
  const { item } = found;
  if (!item.canEdit || !found.row) throw new HttpError(403, item.state !== 'done' ? 'already_cancelled' : 'edit_not_allowed');
  const r = found.row;
  const ch = body.changes || {};
  const form = parse(r.form, {}) || {};
  const kind = item.kind;
  const moves = movesOfOp(r.id);
  const what = [];
  let report = null;

  if (kind === 'booking') {
    const ev = eventsOfOp(r.id).find((e) => !e.undone_at && e.kind === 'reserve');
    if (!ev) throw new HttpError(409, 'not_active');
    const vehicle = ch.vehicleId ? getVehicle(ch.vehicleId) : vehicleByPlate(ev.plate);
    if (!vehicle) throw new HttpError(400, 'no_vehicle');
    const from = ch.from ?? ev.date_from;
    const to = ch.to ?? ev.date_to;
    const total = ch.total === undefined ? int(form.total) : int(ch.total);
    const paid = ch.paid === undefined ? null : (num(ch.paid) || 0);
    const method = ch.payMethod === undefined ? undefined : (PAY_METHODS.includes(ch.payMethod) ? ch.payMethod : null);
    const b = bookingMoney(moves);
    const prepaid = paid === null ? b.prepaid : paid;
    if (total && prepaid > total) throw new HttpError(400, 'prepaid_over_total');
    // Деньги: одна запись предоплаты — меняем её; не было — добавляем; убрали — отменяем
    if (paid !== null && paid !== b.prepaid) {
      if (paid > 0 && b.ins.length) {
        updateMove(b.ins[0].id, { amount: paid, method: method === undefined ? b.ins[0].method : method });
        for (const m of b.ins.slice(1)) cancelMove(m.id, staff, 'бронь изменена');
      } else if (paid > 0) {
        addCashMove({ dir: 'in', kind: 'booking', category: 'rent', amount: paid, currency: 'THB', method: method ?? null, vehicleId: vehicle.id, party: ch.clientName ?? ev.client_name, note: `предоплата брони ${from}–${to}`, opId: r.id }, staff);
      } else for (const m of b.ins) cancelMove(m.id, staff, 'бронь изменена: без предоплаты');
      what.push(`предоплата ${b.prepaid} → ${paid} ฿`);
    } else if (method !== undefined && b.ins.length && method !== b.ins[0].method) {
      updateMove(b.ins[0].id, { method });
      what.push(`способ оплаты → ${method || '—'}`);
    }
    const payLine = [total ? `Total: ${money(total)}` : '', prepaid ? `Prepaid: ${money(prepaid)}` : '', total ? `Left: ${money(Math.max(0, total - prepaid))}` : ''].filter(Boolean).join(' · ');
    const note = [payLine, text(ch.note ?? form.note ?? '', 200)].filter(Boolean).join(' · ');
    const e2 = statusCall(() => editEvent(ev.id, { plate: vehicle.plate, from, to, clientName: ch.clientName, clientPhone: ch.clientPhone, note }));
    const dd = (a, b) => [a, b].map((x) => (x ? `${x.slice(8, 10)}.${x.slice(5, 7)}` : '—')).join('–');
    if (keyOf(ev.plate) !== keyOf(e2.plate)) what.push(`техника #${ev.plate} → #${e2.plate}`);
    if (ev.date_from !== e2.date_from || ev.date_to !== e2.date_to) what.push(`даты ${dd(ev.date_from, ev.date_to)} → ${dd(e2.date_from, e2.date_to)}`);
    if ((ev.client_name || '') !== (e2.client_name || '') || (ev.client_phone || '') !== (e2.client_phone || '')) {
      what.push(`клиент ${[ev.client_name, ev.client_phone].filter(Boolean).join(' ') || '—'} → ${[e2.client_name, e2.client_phone].filter(Boolean).join(' ') || '—'}`);
    }
    if (total !== int(form.total)) what.push(`сумма ${int(form.total) || 0} → ${total || 0} ฿`);
    Object.assign(form, {
      vehicleId: vehicle.id, bookFrom: from, bookTo: to, total: total ?? '', paid: String(prepaid || ''),
      ...(method !== undefined ? { payMethod: method || '' } : {}),
      ...(ch.clientName !== undefined ? { clientName: text(ch.clientName, 100) } : {}), ...(ch.clientPhone !== undefined ? { clientPhone: text(ch.clientPhone, 40) } : {}),
      ...(ch.note !== undefined ? { note: text(ch.note, 200) } : {})
    });
    invalidateFleet();
    report = eventReport({ ...e2, id: `op${r.id}` }, nameOf(vehicle)).replace(/^Booking/, 'Booking changed');
  } else if (['income', 'deposit_refund', 'extend'].includes(kind)) {
    const m = moves.find((x) => live(x) && (kind !== 'extend' || x.kind === 'extension'));
    if (!m) throw new HttpError(409, 'not_active');
    const amount = ch.amount === undefined ? m.amount : num(ch.amount);
    const updated = updateMove(m.id, { amount, method: ch.method, note: ch.note });
    what.push(`${m.amount} ${m.currency} → ${updated.amount} ${updated.currency}${ch.method !== undefined ? ` · ${updated.method || '—'}` : ''}`);
    report = [`Changed: ${KIND_EN[kind]} ${money(m.thb)} → ${money(updated.thb)}${updated.method ? ` (${updated.method})` : ''}`, item.plates[0] ? `#${item.plates[0]}` : null].filter(Boolean).join('\n');
  } else if (['expense', 'payout'].includes(kind)) {
    const x = qq().expOfOp.all(r.id).find(live);
    if (!x) throw new HttpError(409, 'not_active');
    const thb = updateExpense(x, ch);
    what.push(`${x.thb} → ${thb} THB`);
    report = `Changed: ${KIND_EN[kind]} ${money(x.thb)} → ${money(thb)}`;
  } else throw new HttpError(400, 'not_editable');

  if (!what.length) return sendJson(res, 200, { ok: true, changed: false });
  qq().setForm.run(JSON.stringify(form), new Date().toISOString(), pushHistory(r, staff, what.join('; ')), r.id);
  const wa = report ? await tellGroup(report.split('\n').filter((l) => !/^\[portal /.test(l)), `op${r.id}`, staff) : null;
  console.log(`Operation op${r.id} («${kind}») changed by ${staff.email}: ${what.join('; ')}`);
  sendJson(res, 200, { ok: true, changed: true, wa });
}

/* ------------------------------------------------------- Брони для договора */

/** Активные брони (не отменены и не выданы, не прошли): из «＋ Операция» */
export function activeBookings(vehicleId = null) {
  const today = todayIso();
  const key = vehicleId ? keyOf(getVehicle(vehicleId)?.plate) : null;
  const out = [];
  for (const r of qq().recentDone.all(new Date(Date.now() - 400 * DAY_MS).toISOString())) {
    if (r.state) continue;
    const form = parse(r.form, {}) || {};
    if (form.kind !== 'booking') continue;
    const ev = eventsOfOp(r.id).find((e) => !e.undone_at && e.kind === 'reserve');
    if (!ev || (ev.date_to && ev.date_to < today) || (key && keyOf(ev.plate) !== key)) continue;
    const v = vehicleByPlate(ev.plate);
    const b = bookingMoney(movesOfOp(r.id));
    out.push({
      opId: r.id, vehicleId: v?.id || null, plate: ev.plate, vehicle: nameOf(v), from: ev.date_from, to: ev.date_to,
      clientName: ev.client_name || '', clientPhone: ev.client_phone || '', total: int(form.total), prepaid: b.prepaid - b.refunded, method: b.method,
      by: r.staff_name || r.staff_email, at: r.done_at || r.updated_at
    });
  }
  return out.sort((a, b) => String(a.from).localeCompare(String(b.from)));
}

export const bookingForContract = (opId) => activeBookings().find((b) => b.opId === Number(opId)) || null;

/** Договор по брони выдан: бронь — «выдана», её статус снимаем (дальше — аренда по договору) */
export function markBookingIssued(opId, doc, staff) {
  const r = qq().op.get(Number(opId) || 0);
  if (!r || r.state) return false;
  for (const e of eventsOfOp(r.id)) if (!e.undone_at && e.kind === 'reserve') undoEvent(e.id, staff);
  qq().setState.run('issued', new Date().toISOString(), who(staff), null, JSON.stringify({ docId: doc.id, number: doc.number }), r.id);
  return true;
}

/** Выдачу по договору отменили — бронь снова активна */
export function unmarkBookingIssued(opId) {
  const r = qq().op.get(Number(opId) || 0);
  if (!r || r.state !== 'issued') return false;
  const ev = eventsOfOp(r.id).filter((e) => e.kind === 'reserve').pop();
  if (ev) redoEvent(ev.id);
  qq().setState.run(null, null, null, null, null, r.id);
  return true;
}

/** GET /api/staff/ops/bookings?vehicleId= — брони техники (для договора: учесть предоплату) */
export async function opsBookings(staff, req, res, url) {
  if (!anyKind(staff) && !can(staff, 'docs.edit')) throw new HttpError(403, 'no_section_access');
  sendJson(res, 200, { items: activeBookings(url.searchParams.get('vehicleId') || null) });
}

/** Брони портала на прогноз «Финансов»: { from, total, prepaid } */
export const portalBookingForecast = () => activeBookings().map((b) => ({ from: b.from, total: b.total || 0, prepaid: b.prepaid || 0 }));
