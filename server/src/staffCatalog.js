/**
 * ============================================================================
 * Сайт сотрудников: фото и описания моделей для публичного сайта
 * ============================================================================
 *   GET  /api/staff/models                    — модели из листа Catalog
 *   POST /api/staff/models/description        { model, description }
 *   POST /api/staff/models/photo?model=…      тело — картинка webp/jpeg/png
 *                                             (браузер заранее уменьшает её)
 * Менять могут сотрудники с ролью Editor или Admin в листе Users, остальные
 * только смотрят. Описание и ссылка на фото пишутся в лист Catalog, файлы фото
 * лежат на сервере (папка uploads, Caddy отдаёт их по адресу /uploads/…).
 * Каждое изменение попадает в журнал: кто, когда, что было и что стало.
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson, readJson, readBody, rateLimiter } from './http.js';
import { getValues, updateRange, sheetsEnabled } from './google/sheets.js';
import { getFleet, invalidateFleet } from './fleet.js';
import { resetCatalog } from './publicApi.js';
import { slugify, TYPE_ORDER } from './site/urls.js';

const CATALOG_SHEET = 'Catalog';
const COL = { model: 'Модель для клиента', description: 'Описание для клиента', photo: 'Фото (ссылка)' };
const EDIT_ROLES = ['editor', 'admin'];
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_DESCRIPTION = 100;
const IMAGE_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

const uploadLimiter = rateLimiter(60 * 60 * 1000, 60);

export const canEdit = (staff) => EDIT_ROLES.includes(String(staff.role || '').toLowerCase());

function requireEditor(staff) {
  if (!canEdit(staff)) throw new HttpError(403, 'read_only');
  if (!sheetsEnabled) throw new HttpError(503, 'sheets_not_configured');
}

/** 0 → 'A', 25 → 'Z', 26 → 'AA' */
function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Строка модели в листе Catalog: { rowNumber, row, cols } */
async function findCatalogRow(model) {
  const [header = [], ...rows] = await getValues(`'${CATALOG_SHEET}'`);
  const cols = Object.fromEntries(Object.entries(COL).map(([key, title]) => [key, header.findIndex((h) => String(h).trim() === title)]));
  if (Object.values(cols).some((i) => i < 0)) throw new HttpError(500, 'catalog_columns_missing');
  const index = rows.findIndex((r) => String(r[cols.model] || '').trim() === model);
  if (index < 0) throw new HttpError(404, 'model_not_found');
  return { rowNumber: index + 2, row: rows[index], cols };
}

/** Записать поле модели в Catalog и в журнал; сайт и бот увидят изменение сразу */
async function writeField(model, field, value, staff) {
  const { rowNumber, row, cols } = await findCatalogRow(model);
  const oldValue = String(row[cols[field]] ?? '').trim();
  if (oldValue === value) return;
  // RAW — текст как есть: описание «=…» не превратится в формулу
  await updateRange(`'${CATALOG_SHEET}'!${columnLetter(cols[field])}${rowNumber}`, [[value]], { raw: true });
  db.logCatalogChange({ model, field, oldValue, newValue: value, email: staff.email, name: staff.name });
  invalidateFleet();
  resetCatalog();
}

/** Адрес фото для сайта сотрудников (картинки сайта и загрузки отдаются и на staff-домене) */
function photoUrl(value) {
  const text = String(value || '').trim();
  return /^\/?(img|uploads)\/[\w\-./]+$/.test(text) && !text.includes('..') ? `/${text.replace(/^\//, '')}` : '';
}

export async function listModels(staff, req, res) {
  if (!sheetsEnabled) return sendJson(res, 200, { canEdit: false, models: [] });
  const { units, catalog } = await getFleet();
  const unitCount = new Map();
  for (const unit of units) if (unit.model) unitCount.set(unit.model, (unitCount.get(unit.model) || 0) + 1);
  const changes = db.lastCatalogChanges();

  const models = [...catalog].map(([model, entry]) => ({
    model,
    type: entry.type,
    description: entry.description,
    photo: photoUrl(entry.photo),
    units: unitCount.get(model) || 0,
    // На сайте показываются модели, у которых есть техника в парке
    onSite: Boolean(entry.type && unitCount.get(model)),
    lastChange: changes.get(model) || null
  }));
  models.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.model.localeCompare(b.model));
  sendJson(res, 200, { canEdit: canEdit(staff), models });
}

export async function saveDescription(staff, req, res) {
  requireEditor(staff);
  const body = await readJson(req);
  const model = String(body.model || '').trim();
  if (!model) throw new HttpError(400, 'model_required');
  const description = String(body.description ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
  await writeField(model, 'description', description, staff);
  sendJson(res, 200, { ok: true, description });
}

/** Первые байты файла совпадают с заявленным типом картинки */
function looksLike(buffer, ext) {
  if (ext === 'jpg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === 'png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

export async function uploadPhoto(staff, req, res, url) {
  requireEditor(staff);
  const model = String(url.searchParams.get('model') || '').trim();
  if (!model) throw new HttpError(400, 'model_required');
  const ext = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw new HttpError(415, 'image_required');
  if (!uploadLimiter.hit(staff.email)) throw new HttpError(429, 'too_many_uploads');

  const body = await readBody(req, MAX_PHOTO_BYTES);
  if (body.length < 100 || !looksLike(body, ext)) throw new HttpError(400, 'bad_image');
  await findCatalogRow(model); // модель есть — только тогда сохраняем файл

  // Имя с хэшем содержимого: новое фото — новый адрес, браузеры не покажут старое из кэша
  const name = `${slugify(model) || 'model'}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}.${ext}`;
  const dir = path.join(config.site.uploadsDir, 'models');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);

  const photo = `uploads/models/${name}`;
  await writeField(model, 'photo', photo, staff);
  sendJson(res, 200, { ok: true, photo: `/${photo}` });
}
