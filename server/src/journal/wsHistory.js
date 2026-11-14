/**
 * История статусов машин в WS.Автопрокат: после каждой синхронизации
 * записываем, у каких машин сменился статус или текущий период (аренда,
 * бронь, сервис). По ней видно, когда изменение внесли в WS, — и на сколько
 * это позже отчёта в рабочей группе.
 */

import * as db from '../db.js';
import { plateKey } from '../fleet.js';

const q = {
  state: db.raw.prepare('SELECT signature FROM ws_car_state WHERE car_id = ?'),
  upsert: db.raw.prepare(`
    INSERT INTO ws_car_state (car_id, plate, signature, status, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(car_id) DO UPDATE SET plate = excluded.plate, signature = excluded.signature,
      status = excluded.status, updated_at = excluded.updated_at`),
  add: db.raw.prepare('INSERT INTO ws_history (car_id, plate, at, status, seg_from, seg_to) VALUES (?, ?, ?, ?, ?, ?)'),
  prune: db.raw.prepare('DELETE FROM ws_history WHERE at < ?')
};

/** Текущий период машины (аренда / бронь / сервис), в который попадает now */
export function currentSegment(car, now) {
  return car.segments.find((s) => Date.parse(s.from) <= now && now < Date.parse(s.to)) || null;
}

export function recordWsSnapshot(snapshot, now = Date.now()) {
  const at = new Date(now).toISOString();
  db.raw.exec('BEGIN');
  try {
    for (const car of snapshot.cars) {
      const seg = currentSegment(car, now);
      // Статус + границы текущего периода: продление аренды в WS — тоже изменение
      const signature = `${car.status}|${seg ? `${seg.from}|${seg.to}` : ''}`;
      if (q.state.get(String(car.id))?.signature === signature) continue;
      q.add.run(String(car.id), plateKey(car.plate), at, car.status, seg?.from || null, seg?.to || null);
      q.upsert.run(String(car.id), plateKey(car.plate), signature, car.status, at);
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}

/** Историю старше года не храним */
export function pruneWsHistory(now = Date.now()) {
  q.prune.run(new Date(now - 400 * 86400000).toISOString());
}
