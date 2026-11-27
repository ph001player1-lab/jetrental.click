/**
 * ============================================================================
 * Архив фото техники — в служебной карточке («Парк»), не путать с фото на сайте
 * ============================================================================
 * Фото при выдаче (договор), при возврате (акт), при замене, ремонте и ТО, чеки
 * расходов на машину — всё, что снимали по этой единице техники, с датой, видом
 * действия, номером документа и кто снял. Фото документов клиентов сюда не попадают.
 *
 *   GET /api/staff/fleet/media?vehicleId=   — список (группами по действию)
 *   GET /api/staff/fleet/media/file?id=     — само фото
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson } from './http.js';
import { can } from './roles.js';

const DIR = path.join(config.dataDir, 'vehicle-media');
export const MEDIA_KINDS = ['issue', 'return', 'swap', 'service', 'expense', 'extend', 'other'];

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS vehicle_media (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id  INTEGER NOT NULL,
    plate       TEXT,
    at          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    ref         TEXT,
    caption     TEXT,
    file        TEXT NOT NULL,
    by_name     TEXT
  );
  CREATE INDEX IF NOT EXISTS vehicle_media_vehicle ON vehicle_media (vehicle_id, at);
`);

const q = {
  add: db.raw.prepare('INSERT INTO vehicle_media (vehicle_id, plate, at, kind, ref, caption, file, by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  list: db.raw.prepare('SELECT * FROM vehicle_media WHERE vehicle_id = ? ORDER BY at DESC, id ASC LIMIT 500'),
  one: db.raw.prepare('SELECT * FROM vehicle_media WHERE id = ?'),
  counts: db.raw.prepare('SELECT vehicle_id, COUNT(*) AS n FROM vehicle_media GROUP BY vehicle_id')
};

const isJpeg = (b) => Buffer.isBuffer(b) && b.length > 1000 && b[0] === 0xff && b[1] === 0xd8;

/**
 * Фото в архив техники: photos — [{ buffer, caption }] (JPEG). Одно действие — одно время,
 * так фото одного возврата в карточке идут одной группой. Возвращает, сколько сохранено.
 */
export function archivePhotos(vehicle, photos, { kind = 'other', ref = null, staff = null, at = null } = {}) {
  if (!vehicle?.id) return 0;
  const when = at || new Date().toISOString();
  let n = 0;
  for (const p of photos || []) {
    if (!isJpeg(p?.buffer)) continue;
    const file = `${vehicle.id}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, file), p.buffer);
    q.add.run(vehicle.id, vehicle.plate || null, when, MEDIA_KINDS.includes(kind) ? kind : 'other', ref ? String(ref).slice(0, 80) : null,
      p.caption ? String(p.caption).slice(0, 40) : null, file, staff ? staff.name || staff.email : null);
    n++;
  }
  return n;
}

/** Сколько фото в архиве у каждой техники: Map(vehicleId → n) — для «Парка» */
export const mediaCounts = () => new Map(q.counts.all().map((r) => [r.vehicle_id, r.n]));

export async function fleetMediaList(staff, req, res, url) {
  if (!can(staff, 'fleet.view')) throw new HttpError(403, 'no_section_access');
  const rows = q.list.all(Number(url.searchParams.get('vehicleId')) || 0);
  // Группы: одно действие (вид + номер документа + время) — одна строка с фото
  const groups = [];
  for (const r of rows) {
    const key = `${r.kind}|${r.ref || ''}|${r.at}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, kind: r.kind, ref: r.ref, at: r.at, by: r.by_name, photos: [] }; groups.push(g); }
    g.photos.push({ id: r.id, caption: r.caption });
  }
  sendJson(res, 200, { groups: groups.map(({ key, ...g }) => g) });
}

export async function fleetMediaFile(staff, req, res, url) {
  if (!can(staff, 'fleet.view')) throw new HttpError(403, 'no_section_access');
  const r = q.one.get(Number(url.searchParams.get('id')) || 0);
  if (!r) throw new HttpError(404, 'not_found');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  fs.createReadStream(path.join(DIR, r.file)).on('error', () => res.end()).pipe(res);
}
