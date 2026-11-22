/**
 * ============================================================================
 * Сверка: рабочая группа WhatsApp ↔ WS.Автопрокат
 * ============================================================================
 * Статус машины «по группе» — по последнему отчёту с её госномером:
 *   выдача, продление, оплата, задание «забрать» → в аренде;
 *   возврат, «замена: откуда» → свободна; «замена: куда» → в аренде;
 *   бронь с госномером → бронь (если машина не в аренде).
 * В WS вносят с опозданием. Сколько не внесено — считаем в рабочем времени
 * (10:00–19:00 по Бангкоку): до 3 часов — норма, больше 3 часов — жёлтый
 * (предупреждение), больше рабочего дня — красный и счёт в днях.
 * Бронь сверяем по датам: в WS у машины на эти дни должна быть бронь или аренда.
 * Судим только по отчётам после подключения наблюдателя: по истории из
 * выгрузки показываем статус, но расхождением не считаем — в ней бывают дыры.
 * Обратная сверка: в WS аренда началась, а отчёта о выдаче в группе нет.
 * ============================================================================
 */

import * as db from '../db.js';
import { plateKey } from '../fleet.js';
import { getWsSnapshot } from '../ws/sync.js';
import { workingMinutes } from '../dashboard.js';
import { liveSince } from './journal.js';
import { currentSegment } from './wsHistory.js';

export const GRACE_WORK_MINUTES = 180;
// Рабочий день 10:00–19:00: дольше — «красный», счёт в днях
export const WORK_DAY_MINUTES = 9 * 60;
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

const STATUS_KINDS = ['issue', 'return', 'changed', 'extension', 'payment', 'pickup_task', 'booking'];

/** Последний отчёт по каждому госномеру → { status, at, id, kind, author, authorName, to } */
export function groupStatusByPlate() {
  const rows = db.raw.prepare(`
    SELECT m.id, m.ts, m.kind, m.author, m.author_name, m.data, p.plate, p.role
    FROM wa_message_plates p JOIN wa_messages m ON m.id = p.message_id
    WHERE m.kind IN (${STATUS_KINDS.map(() => '?').join(',')}) AND m.status != 'ignored' AND p.role != 'mention'
    ORDER BY m.ts`).all(...STATUS_KINDS);
  const byPlate = new Map();
  for (const row of rows) {
    let status = null;
    if (row.kind === 'changed') status = row.role === 'from' ? 'free' : row.role === 'to' ? 'rent' : null;
    else if (row.kind === 'return') status = 'free';
    else if (row.kind === 'booking') status = byPlate.get(row.plate)?.status === 'rent' ? null : 'reserve';
    else status = 'rent';
    if (!status) continue;
    const fields = JSON.parse(row.data || '{}').fields || {};
    byPlate.set(row.plate, { status, at: row.ts, id: row.id, kind: row.kind, author: row.author, authorName: row.author_name, from: fields.from || null, to: fields.to || null });
  }
  return byPlate;
}

/** Бронь из группы есть в WS: на её даты у машины в WS бронь или аренда */
function bookingInWs(car, g) {
  const day = (iso) => Date.parse(`${iso}T00:00:00+07:00`);
  const from = g.from ? day(g.from) : Date.parse(g.at);
  const to = g.to ? day(g.to) + DAY_MS : from + DAY_MS;
  return (car.segments || []).some((s) => (s.kind === 'reserve' || s.kind === 'rent') && Date.parse(s.from) < to && Date.parse(s.to) > from);
}

/** Насколько срочно: до 3 рабочих часов — норма, дольше — жёлтый, дольше рабочего дня — красный */
const severityOf = (minutes) => (minutes >= WORK_DAY_MINUTES ? 'overdue' : minutes >= GRACE_WORK_MINUTES ? 'late' : 'fresh');

/** Совпадает ли статус по группе со статусом в WS */
function agrees(group, wsStatus) {
  if (group === 'rent') return wsStatus === 'rent';
  // Вернули — в WS может быть уже следующая бронь или сервис
  if (group === 'free') return wsStatus !== 'rent';
  if (group === 'reserve') return wsStatus === 'reserve' || wsStatus === 'rent';
  return true;
}

/**
 * По каждой машине Автопроката: статус в WS, статус по группе и итог —
 * ok / waiting (меньше 3 рабочих часов) / mismatch (дольше) / unknown (до наблюдателя) /
 * none (нет отчётов). reason: group_* — не внесено в WS, ws_only — нет отчёта в группе;
 * age — сколько рабочих минут не внесено, severity — fresh / late / overdue.
 */
export function reconcile(now = Date.now()) {
  const snapshot = getWsSnapshot();
  const live = liveSince();
  if (!snapshot) return { available: false, live: live ? new Date(live).toISOString() : null, items: [] };
  const group = groupStatusByPlate();
  const items = snapshot.cars.map((car) => {
    const plate = plateKey(car.plate);
    const g = group.get(plate) || null;
    const seg = currentSegment(car, now);
    const item = {
      plate,
      carId: car.id,
      model: car.model || car.wsModel,
      ws: { status: car.status, from: seg?.from || null, to: seg?.to || null },
      group: g,
      state: g ? 'ok' : 'none',
      reason: null
    };
    const inWs = g && (agrees(g.status, car.status) || (g.status === 'reserve' && bookingInWs(car, g)));
    if (g && !inWs) {
      const at = Date.parse(g.at);
      if (!live || at < live) item.state = 'unknown';
      else {
        item.age = workingMinutes(at, now);
        item.state = item.age >= GRACE_WORK_MINUTES ? 'mismatch' : 'waiting';
        item.severity = severityOf(item.age);
        item.since = g.at;
        item.reason = `group_${g.status}`;
      }
    }
    // Обратная сверка: аренда в WS началась после подключения наблюдателя, а отчёта о выдаче нет
    if (live && car.status === 'rent' && seg && item.state !== 'mismatch') {
      const from = Date.parse(seg.from);
      const reported = g && g.status === 'rent' && Date.parse(g.at) >= from - DAY_MS;
      if (from >= live && !reported) {
        item.age = workingMinutes(from, now);
        item.state = item.age >= GRACE_WORK_MINUTES ? 'mismatch' : 'waiting';
        item.severity = severityOf(item.age);
        item.since = seg.from;
        item.reason = 'ws_only';
      }
    }
    return item;
  });
  return { available: true, live: live ? new Date(live).toISOString() : null, items };
}
