/**
 * ============================================================================
 * Статусы техники — из портала (WS.Автопрокат только сверяется)
 * ============================================================================
 * Источники статуса (по времени, последнее главнее):
 *   - отчёты рабочей группы WhatsApp (журнал): выдача, продление, оплата,
 *     забрать, возврат, замена, бронь (с датами «From / To»);
 *   - события портала: ручная правка статуса в карточке (аренда до даты,
 *     свободна, бронь на даты, ремонт) — их же бот пишет в рабочую группу
 *     с меткой [portal #N], и такие сообщения журнал второй раз не считает;
 *   - «В ремонте» из карточки техники.
 * Из этого — «снимок» парка в том же виде, что был из WS (статус сейчас, когда
 * освободится, занятость на 30 дней): по нему работают «Парк», календарь,
 * «Обзор», утренняя сводка, сайт и боты (свободна ли техника на даты).
 *
 * Сверка с WS.Автопрокат (так решил владелец):
 *   - по технике нет данных в портале, а в WS она занята — статус из WS, «нужна проверка»;
 *   - портал и WS расходятся — «нужна проверка»;
 *   - проверяют владелец и админ: «Верно: портал» или «Верно: WS» (или ставят статус сами).
 *     Проверка действует, пока не изменится портал (отчёт, событие, ремонт) или статус в WS;
 *   - проверка не снимает предупреждение «в WS другое»: оно висит, пока WS не исправят;
 *   - пока не проверили, сайт и боты не предлагают технику, если хоть где-то она занята.
 * ============================================================================
 */

import * as db from './db.js';
import { freeFromAt, isFreeBetween } from './ws/timeline.js';
import { getWsSnapshot } from './ws/sync.js';

const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;
const WINDOW_BACK_DAYS = 20;
const WINDOW_DAYS = 30;
const CACHE_MS = 20 * 1000;
export const EVENT_KINDS = ['rent', 'free', 'reserve', 'service'];
const REPORT_KINDS = ['issue', 'return', 'changed', 'extension', 'payment', 'pickup_task', 'booking'];
export const PORTAL_MARK = '[portal #';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS vehicle_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plate_key  TEXT NOT NULL,
    plate      TEXT,
    kind       TEXT NOT NULL,
    date_from  TEXT,
    date_to    TEXT,
    note       TEXT,
    by_email   TEXT,
    by_name    TEXT,
    at         TEXT NOT NULL,
    wa_status  TEXT,
    wa_error   TEXT
  );
  CREATE INDEX IF NOT EXISTS vehicle_events_plate ON vehicle_events (plate_key);
  CREATE TABLE IF NOT EXISTS vehicle_checks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plate_key  TEXT NOT NULL,
    status     TEXT NOT NULL,
    choice     TEXT NOT NULL,
    portal_sig TEXT NOT NULL,
    ws_sig     TEXT NOT NULL,
    note       TEXT,
    by_email   TEXT,
    by_name    TEXT,
    at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vehicle_checks_plate ON vehicle_checks (plate_key);
`);

// Клиент события (арендатор), договор, из которого выдали, и отмена события
// Операция «＋ Операция», которая поставила статус (по ней событие отменяют и меняют во вкладке «Операции»)
for (const [col, type] of [['client_name', 'TEXT'], ['client_phone', 'TEXT'], ['doc_id', 'INTEGER'], ['undone_at', 'TEXT'], ['undone_by', 'TEXT'], ['op_id', 'INTEGER'], ['edited_at', 'TEXT']]) {
  if (!db.raw.prepare('PRAGMA table_info(vehicle_events)').all().some((c) => c.name === col)) db.raw.exec(`ALTER TABLE vehicle_events ADD COLUMN ${col} ${type}`);
}

const q = {
  reports: db.raw.prepare(`
    SELECT m.id, m.ts, m.kind, m.data, m.author_name, p.plate, p.role
    FROM wa_message_plates p JOIN wa_messages m ON m.id = p.message_id
    WHERE m.kind IN (${REPORT_KINDS.map(() => '?').join(',')}) AND m.status != 'ignored' AND p.role != 'mention'
      AND instr(m.text, '${PORTAL_MARK}') = 0
    ORDER BY m.ts`),
  events: db.raw.prepare('SELECT * FROM vehicle_events WHERE undone_at IS NULL ORDER BY at'),
  event: db.raw.prepare('SELECT * FROM vehicle_events WHERE id = ?'),
  addEvent: db.raw.prepare(`INSERT INTO vehicle_events (plate_key, plate, kind, date_from, date_to, note, by_email, by_name, at, client_name, client_phone, doc_id, op_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  ofOp: db.raw.prepare('SELECT * FROM vehicle_events WHERE op_id = ? ORDER BY id'),
  redo: db.raw.prepare('UPDATE vehicle_events SET undone_at = NULL, undone_by = NULL WHERE id = ?'),
  editEvent: db.raw.prepare('UPDATE vehicle_events SET plate_key = ?, plate = ?, date_from = ?, date_to = ?, note = ?, client_name = ?, client_phone = ?, edited_at = ? WHERE id = ?'),
  between: db.raw.prepare('SELECT * FROM vehicle_events WHERE at >= ? AND at < ? ORDER BY at DESC'),
  undo: db.raw.prepare('UPDATE vehicle_events SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_at IS NULL'),
  setWa: db.raw.prepare('UPDATE vehicle_events SET wa_status = ?, wa_error = ? WHERE id = ?'),
  lastEvents: db.raw.prepare('SELECT * FROM vehicle_events WHERE plate_key = ? AND undone_at IS NULL ORDER BY id DESC LIMIT ?'),
  checks: db.raw.prepare('SELECT * FROM vehicle_checks ORDER BY id'),
  addCheck: db.raw.prepare(`INSERT INTO vehicle_checks (plate_key, status, choice, portal_sig, ws_sig, note, by_email, by_name, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
};

const keyOf = (plate) => String(plate || '').replace(/\D/g, '');
const dayStart = (iso) => Date.parse(`${iso}T00:00:00+07:00`);
const dayOf = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 10);
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
const parseJson = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

/* ------------------------------------------------------- Хронология техники */

let cache = null;
export const invalidateStatuses = () => { cache = null; };

/** Все события по госномерам (отчёты группы + события портала) → состояние каждой техники */
function histories() {
  const items = [];
  for (const r of q.reports.all(...REPORT_KINDS)) {
    const f = parseJson(r.data).fields || {};
    items.push({ plate: r.plate, ts: Date.parse(r.ts), kind: r.kind, role: r.role, from: isIso(f.from) ? f.from : null, to: isIso(f.to) ? f.to : null, src: 'group', ref: r.id, by: r.author_name || null });
  }
  for (const e of q.events.all()) {
    const client = e.client_name || e.client_phone ? { name: e.client_name || '', phone: e.client_phone || '' } : null;
    items.push({ plate: e.plate_key, ts: Date.parse(e.at), kind: `p_${e.kind}`, role: 'main', from: e.date_from, to: e.date_to, src: 'portal', ref: e.id, by: e.by_name || e.by_email, client, docId: e.doc_id || null });
  }
  items.sort((a, b) => a.ts - b.ts);

  const byPlate = new Map();
  const stateOf = (plate) => {
    if (!byPlate.has(plate)) byPlate.set(plate, { rent: null, rents: [], bookings: [], last: null, log: [] });
    return byPlate.get(plate);
  };
  for (const it of items) {
    if (!it.plate) continue;
    const st = stateOf(it.plate);
    const close = () => { if (st.rent) { st.rents.push({ from: st.rent.start, to: it.ts }); st.rent = null; } };
    const open = () => {
      close();
      // Кто арендует: событие портала (клиент, договор) или отчёт группы (клиент — по CRM)
      st.rent = { start: it.ts, until: it.to, src: it.src, ref: it.ref, client: it.client || null, docId: it.docId || null };
      // Выдача по брони: бронь на эти дни выполнена
      const day = dayOf(it.ts);
      st.bookings = st.bookings.filter((b) => !(b.from <= addDays(day, 1) && b.to >= addDays(day, -1)));
    };
    switch (it.kind) {
      case 'issue': case 'p_rent': open(); break;
      case 'extension': case 'payment': case 'pickup_task':
        if (st.rent) { if (it.to && (!st.rent.until || it.to > st.rent.until)) st.rent.until = it.to; } else open();
        break;
      case 'return': case 'p_free': close(); break;
      case 'changed':
        if (it.role === 'from') close();
        else if (it.role === 'to') open();
        break;
      case 'booking': case 'p_reserve':
        if (it.role === 'main' || it.src === 'portal') {
          const from = it.from || dayOf(it.ts);
          st.bookings.push({ from, to: it.to && it.to >= from ? it.to : from, at: it.ts, src: it.src, ref: it.ref, client: it.client || null, docId: it.docId || null });
        }
        break;
      default: break;
    }
    st.last = { kind: it.kind, at: new Date(it.ts).toISOString(), src: it.src, by: it.by || null, ref: it.ref };
    st.log.push(st.last);
    if (st.log.length > 8) st.log.shift();
  }
  return byPlate;
}

function addDays(iso, n) {
  return new Date(dayStart(iso) + n * DAY_MS + BANGKOK_MS).toISOString().slice(0, 10);
}

/**
 * «Снимок» парка из портала — тот же вид, что был из WS:
 * { updatedAt, windowFrom, windowTo, cars: [{ id, plate, model, wsModel, type, status, freeFrom, freeWeek, segments, … }] }.
 * units — техника из fleet.js (без архива): plate, type, model, wsName, status (In Repair / Needs Repair / Free).
 */
export function portalSnapshot(units, now = Date.now()) {
  const ws = getWsSnapshot();
  if (cache && now - cache.at < CACHE_MS && cache.units === units && cache.ws === ws) return cache.snapshot;
  const windowFrom = now - WINDOW_BACK_DAYS * DAY_MS;
  const windowTo = now + WINDOW_DAYS * DAY_MS;
  const hist = histories();
  const today = dayOf(now);
  const wsByPlate = new Map((ws?.cars || []).map((c) => [keyOf(c.plate), c]));
  const checks = new Map(q.checks.all().map((c) => [c.plate_key, c]));
  const cars = units.filter((u) => u.plate || u.model).map((u) => {
    const h = hist.get(keyOf(u.plate)) || { rent: null, rents: [], bookings: [], last: null, log: [] };
    const segments = [];
    for (const r of h.rents) if (r.to > windowFrom) segments.push({ kind: 'rent', from: Math.max(r.from, windowFrom), to: r.to });
    let overdue = false;
    let until = null;
    if (h.rent) {
      until = h.rent.until;
      const end = until ? dayStart(until) + DAY_MS : null;
      // Срок прошёл, а возврата нет — занята, пока не отметят возврат
      overdue = Boolean(until && until < today);
      segments.push({ kind: 'rent', from: Math.max(h.rent.start, windowFrom), to: end && !overdue ? Math.min(end, windowTo) : windowTo });
    }
    const bookings = h.bookings.filter((b) => dayStart(b.to) + DAY_MS > now && dayStart(b.from) < windowTo).sort((a, b) => a.from.localeCompare(b.from));
    for (const b of bookings) segments.push({ kind: 'reserve', from: Math.max(dayStart(b.from), windowFrom), to: Math.min(dayStart(b.to) + DAY_MS, windowTo) });
    if (u.status === 'In Repair') segments.push({ kind: 'service', from: now - 60000, to: windowTo });
    segments.sort((a, b) => a.from - b.from);
    const portalStatus = statusOf(segments, now);

    // Сверка с WS и ручная проверка (см. начало файла)
    const key = keyOf(u.plate);
    const w = key ? wsByPlate.get(key) : null;
    const wsStatus = w ? w.status : null;
    const wsSegs = w ? (w.segments || []).map((x) => ({ kind: x.kind, from: Date.parse(x.from), to: Date.parse(x.to) })) : [];
    const portalHas = Boolean(h.last) || u.status === 'In Repair';
    const portalSig = `${h.last ? `${h.last.src}:${h.last.ref}` : 'none'}|${u.status}`;
    const wsSig = wsStatus || 'none';
    const chk = checks.get(key);
    const checked = chk && chk.portal_sig === portalSig && chk.ws_sig === wsSig ? chk : null;
    const both = () => [...segments, ...wsSegs].sort((a, b) => a.from - b.from);
    let status = portalStatus;
    let effective = segments;
    let needsCheck = false;
    let source = h.last ? { kind: h.last.src, by: h.last.by, at: h.last.at } : { kind: 'none' };
    if (checked) {
      status = checked.status;
      // «Верно: портал» — занятость по порталу; «Верно: WS» — по обоим (что-то из WS ещё не внесено в портал)
      effective = checked.status === portalStatus ? segments : both();
      source = { kind: 'check', by: checked.by_name || checked.by_email, at: checked.at, choice: checked.choice };
    } else if (portalHas) {
      if (wsStatus && wsStatus !== portalStatus) { needsCheck = true; effective = both(); }
    } else if (wsStatus && wsStatus !== 'free') {
      // В портале по технике ничего нет, а в WS она занята — берём из WS и просим проверить
      status = wsStatus;
      needsCheck = true;
      effective = both();
      source = { kind: 'ws' };
    } else {
      // Нет данных в портале, в WS свободна — свободна (будущие брони WS тоже учитываем)
      effective = both();
      if (wsStatus) source = { kind: 'ws' };
    }
    const freeFrom = freeFromAt(effective, now, windowTo);
    // У кого техника: текущая аренда, иначе бронь сейчас или ближайшая
    const bookingNow = bookings.find((b) => dayStart(b.from) <= now) || null;
    const holderOf = (x, kind, from) => (x ? { kind, from, to: x.until ?? x.to ?? null, src: x.src, ref: x.ref, client: x.client, docId: x.docId } : null);
    const holder = h.rent ? holderOf(h.rent, 'rent', dayOf(h.rent.start))
      : holderOf(bookingNow || bookings.find((b) => dayStart(b.from) > now), 'reserve', (bookingNow || bookings.find((b) => dayStart(b.from) > now))?.from);
    return {
      id: u.id, vehicleId: u.id, plate: u.plate, model: u.model || '', wsModel: u.wsName || '', type: u.type || null,
      status, portalStatus, wsStatus, needsCheck,
      // Проверили (или портал прав), а в WS всё ещё другое — пока WS не исправят
      wsMismatch: Boolean(wsStatus) && !needsCheck && status !== wsStatus,
      source, portalSig, wsSig,
      freeFrom: freeFrom === null ? null : freeFrom === Infinity ? 'later' : new Date(freeFrom).toISOString(),
      freeWeek: isFreeBetween(effective, now, now + 7 * DAY_MS),
      needsRepair: u.status === 'Needs Repair', overdue: overdue && status === 'rent', until,
      nextBooking: bookings.find((b) => dayStart(b.from) > now) || null,
      last: h.last, history: [...h.log].reverse(), deposit: null, tariffs: [], holder,
      segments: effective.map((x) => ({ kind: x.kind, from: new Date(x.from).toISOString(), to: new Date(x.to).toISOString() }))
    };
  });
  const snapshot = { updatedAt: new Date(now).toISOString(), windowFrom: new Date(windowFrom).toISOString(), windowTo: new Date(windowTo).toISOString(), cars, source: 'portal' };
  cache = { at: now, units, ws, snapshot };
  return snapshot;
}

/** Статус сейчас по занятости: аренда главнее ремонта, ремонт главнее брони */
function statusOf(segments, now) {
  const nowSegs = segments.filter((x) => x.from <= now && now < x.to);
  return ['rent', 'service', 'reserve'].find((k) => nowSegs.some((x) => x.kind === k)) || 'free';
}

/**
 * Ручная проверка (владелец, админ): choice 'portal' | 'ws' — какой источник прав.
 * car — из portalSnapshot (её подписи источников запоминаем: изменится источник — проверка снимется).
 */
export function addCheck(car, choice, staff, note = '') {
  if (!['portal', 'ws'].includes(choice)) throw new StatusError('bad_choice');
  if (choice === 'ws' && !car.wsStatus) throw new StatusError('no_ws');
  const status = choice === 'ws' ? car.wsStatus : car.portalStatus;
  q.addCheck.run(keyOf(car.plate), status, choice, car.portalSig, car.wsSig, String(note || '').trim().slice(0, 300) || null,
    staff.email, staff.name || staff.email, new Date().toISOString());
  invalidateStatuses();
  console.log(`Vehicle ${car.plate}: status checked by ${staff.email} — «${choice}» is right (${status})`);
  return status;
}

/**
 * Свободна ли техника на даты [from, to] (ГГГГ-ММ-ДД): не в ремонте, не «нужен ремонт»,
 * нет аренды (день возврата тоже занят — так надёжнее), брони и ремонта в эти дни.
 */
export function freeOnDates(car, from, to) {
  if (car.needsRepair) return false;
  const a = dayStart(from);
  const b = dayStart(to) + DAY_MS;
  return isFreeBetween(car.segments.map((s) => ({ from: Date.parse(s.from), to: Date.parse(s.to) })), a, b);
}

/** Модель для сравнения с WS: буквы и цифры без пробелов, без «(1019)» в конце названия */
export const modelKey = (value) => String(value || '').replace(/\s*\(\d+\)\s*$/, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Названия из WS и портала — про одну модель (одно входит в другое: «Honda Click 160» ≈ «HONDA CLICK 160») */
export function sameModel(wsModel, names) {
  const ws = modelKey(wsModel);
  const list = names.map(modelKey).filter(Boolean);
  return !ws || !list.length || list.some((n) => n.includes(ws) || ws.includes(n));
}

/* --------------------------------------------------- Ручная правка статуса */

export class StatusError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * Событие портала: { kind: rent|free|reserve|service, from?, to?, note? }.
 * rent — с сегодня до даты «to»; reserve — на даты from–to; free — вернули (аренда закрыта);
 * service — в ремонт (флаг ставит вызывающий в карточке). Возвращает событие.
 */
export function addStatusEvent(vehicle, input, staff, now = Date.now()) {
  const kind = EVENT_KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new StatusError('bad_status');
  const key = keyOf(vehicle.plate);
  if (!key) throw new StatusError('plate_required');
  const today = dayOf(now);
  let from = null;
  let to = null;
  if (kind === 'rent') {
    to = isIso(input.to) ? input.to : null;
    if (!to) throw new StatusError('date_required');
    if (to < today) throw new StatusError('date_past');
  }
  if (kind === 'reserve') {
    from = isIso(input.from) ? input.from : null;
    to = isIso(input.to) ? input.to : null;
    if (!from || !to) throw new StatusError('date_required');
    if (to < from) throw new StatusError('date_order');
    if (to < today) throw new StatusError('date_past');
  }
  const note = String(input.note ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) || null;
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null;
  // Клиент — для выдачи и брони (кто арендует; номер — в отчёт группы строкой Contact, по ней CRM найдёт клиента)
  const withClient = kind === 'rent' || kind === 'reserve';
  const info = q.addEvent.run(key, vehicle.plate, kind, from, to, note, staff.email, staff.name || staff.email, new Date(now).toISOString(),
    withClient ? clean(input.clientName, 100) : null, withClient ? clean(input.clientPhone, 40) : null, Number(input.docId) || null, Number(input.opId) || null);
  invalidateStatuses();
  console.log(`Vehicle ${vehicle.plate}: status «${kind}» set in the portal by ${staff.email}`);
  return q.event.get(Number(info.lastInsertRowid));
}

export const setEventWa = (id, status, error = null) => q.setWa.run(status, error, id);
export const getEvent = (id) => q.event.get(Number(id) || 0) || null;
export const recentEvents = (plate, n = 5) => q.lastEvents.all(keyOf(plate), n).map((e) => ({
  id: e.id, kind: e.kind, from: e.date_from, to: e.date_to, note: e.note || '', by: e.by_name || e.by_email, at: e.at, wa: e.wa_status, waError: e.wa_error,
  client: e.client_name || '', docId: e.doc_id || null
}));

/** Отменить событие портала (ошибочная выдача из договора и т. п.): статусы считаются без него */
export function undoEvent(id, staff) {
  const e = getEvent(id);
  if (!e || e.undone_at) throw new StatusError('not_found');
  q.undo.run(new Date().toISOString(), staff.name || staff.email, e.id);
  invalidateStatuses();
  console.log(`Vehicle ${e.plate}: portal event #${e.id} («${e.kind}») undone by ${staff.email}`);
  return e;
}

/** События операции (и отменённые) */
export const eventsOfOp = (opId) => q.ofOp.all(Number(opId) || 0);
/** События портала за период (новые сверху) — для вкладки «Операции» */
export const eventsBetween = (fromIso, toIso) => q.between.all(fromIso, toIso);
/** Вернуть отменённое событие (отменили отмену выдачи и т. п.) */
export function redoEvent(id) {
  q.redo.run(Number(id));
  invalidateStatuses();
}

/** Поменять бронь или аренду: техника, даты, клиент, заметка — то же событие */
export function editEvent(id, input, now = Date.now()) {
  const e = getEvent(id);
  if (!e || e.undone_at) throw new StatusError('not_found');
  const plate = input.plate || e.plate;
  const key = keyOf(plate);
  if (!key) throw new StatusError('plate_required');
  const from = input.from === undefined ? e.date_from : (isIso(input.from) ? input.from : null);
  const to = input.to === undefined ? e.date_to : (isIso(input.to) ? input.to : null);
  if (e.kind === 'reserve') {
    if (!from || !to) throw new StatusError('date_required');
    if (to < from) throw new StatusError('date_order');
    if (to < dayOf(now)) throw new StatusError('date_past');
  }
  if (e.kind === 'rent' && !to) throw new StatusError('date_required');
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null;
  q.editEvent.run(key, plate, from, to, input.note === undefined ? e.note : clean(input.note, 300),
    input.clientName === undefined ? e.client_name : clean(input.clientName, 100), input.clientPhone === undefined ? e.client_phone : clean(input.clientPhone, 40),
    new Date(now).toISOString(), e.id);
  invalidateStatuses();
  return getEvent(e.id);
}

/** Текст для рабочей группы — в формате отчётов (журнал его узнаёт), с меткой портала */
export function eventReport(e, vehicleName) {
  const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  const head = { rent: 'Rented', free: 'Accepted', reserve: 'Booking', service: 'Service' }[e.kind];
  const lines = [`${head}`, `#${e.plate} ${vehicleName || ''}`.trim()];
  if (e.date_from) lines.push(`From: ${dm(e.date_from)}`);
  if (e.date_to) lines.push(`To: ${dm(e.date_to)}`);
  // Клиент — строкой Contact, как в отчётах (CRM свяжет аренду с клиентом)
  if (e.client_name || e.client_phone) lines.push(`Contact: ${[e.client_name, e.client_phone].filter(Boolean).join(' ')}`);
  if (e.note) lines.push(e.note);
  lines.push(`${PORTAL_MARK}${e.id} · ${e.by_name || e.by_email}]`);
  return lines.join('\n');
}
