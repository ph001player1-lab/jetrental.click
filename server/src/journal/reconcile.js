/**
 * ============================================================================
 * Сверка: рабочая группа WhatsApp ↔ WS.Автопрокат
 * ============================================================================
 * Статус машины «по группе» — по последнему отчёту с её госномером:
 *   выдача, продление, оплата, задание «забрать» → в аренде;
 *   возврат, «замена: откуда» → свободна; «замена: куда» → в аренде;
 *   бронь с госномером → бронь (если машина не в аренде).
 * В WS вносят с опозданием, поэтому расхождение сначала «ждём внесения»,
 * а через 3 рабочих часа (10:00–19:00 по Бангкоку) — предупреждение.
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
    byPlate.set(row.plate, { status, at: row.ts, id: row.id, kind: row.kind, author: row.author, authorName: row.author_name, to: fields.to || null });
  }
  return byPlate;
}

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
 * ok / waiting (ждём внесения в WS) / mismatch / unknown (до наблюдателя) / none (нет отчётов)
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
    if (g && !agrees(g.status, car.status)) {
      const at = Date.parse(g.at);
      if (!live || at < live) item.state = 'unknown';
      else {
        item.state = workingMinutes(at, now) >= GRACE_WORK_MINUTES ? 'mismatch' : 'waiting';
        item.reason = `group_${g.status}`;
      }
    }
    // Обратная сверка: аренда в WS началась после подключения наблюдателя, а отчёта о выдаче нет
    if (live && car.status === 'rent' && seg && item.state !== 'mismatch') {
      const from = Date.parse(seg.from);
      const reported = g && g.status === 'rent' && Date.parse(g.at) >= from - DAY_MS;
      if (from >= live && !reported) {
        item.state = workingMinutes(from, now) >= GRACE_WORK_MINUTES ? 'mismatch' : 'waiting';
        item.reason = 'ws_only';
      }
    }
    return item;
  });
  return { available: true, live: live ? new Date(live).toISOString() : null, items, lag: wsLag(now) };
}

/**
 * Насколько WS отстаёт от группы: для выдач и возвратов за 30 дней находим,
 * когда WS сменил статус машины. Только после начала истории WS (+1 час).
 */
export function wsLag(now = Date.now(), days = 30) {
  const first = db.raw.prepare('SELECT MIN(at) a FROM ws_history').get()?.a;
  if (!first) return null;
  const since = new Date(Math.max(Date.parse(first) + HOUR_MS, now - days * DAY_MS)).toISOString();
  const events = db.raw.prepare(`
    SELECT m.ts, m.kind, p.plate, p.role FROM wa_messages m JOIN wa_message_plates p ON p.message_id = m.id
    WHERE m.kind IN ('issue', 'return', 'changed') AND m.status != 'ignored' AND p.role != 'mention' AND m.ts >= ?`).all(since);
  const next = db.raw.prepare('SELECT at, status FROM ws_history WHERE plate = ? AND at >= ? ORDER BY at');
  const lags = [];
  let pending = 0;
  for (const e of events) {
    const wantRent = e.kind === 'issue' || (e.kind === 'changed' && e.role === 'to');
    const t = Date.parse(e.ts);
    const hit = next.all(e.plate, new Date(t - 6 * HOUR_MS).toISOString())
      .find((h) => (wantRent ? h.status === 'rent' : h.status !== 'rent'));
    if (hit) lags.push(Math.max(0, Date.parse(hit.at) - t));
    else pending++;
  }
  lags.sort((a, b) => a - b);
  const hours = (ms) => Math.round((ms / HOUR_MS) * 10) / 10;
  return {
    events: events.length,
    entered: lags.length,
    pending,
    medianHours: lags.length ? hours(lags[Math.floor(lags.length / 2)]) : null,
    maxHours: lags.length ? hours(lags[lags.length - 1]) : null
  };
}
