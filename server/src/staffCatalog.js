/**
 * ============================================================================
 * Сайт сотрудников: фото и описания моделей для публичного сайта
 * ============================================================================
 *   GET  /api/staff/models                    — модели из листа Catalog
 *   POST /api/staff/models/description        { model, descriptions: { en, ru, th, zh } }
 *   POST /api/staff/models/photo?model=…      тело — картинка webp/jpeg/png
 *                                             (браузер заранее уменьшает её);
 *                                             главное фото, а с &gallery=1 —
 *                                             только файл для галереи
 *   POST /api/staff/models/thumb?photo=…      миниатюра к загруженному фото
 *   POST /api/staff/models/gallery            { model, photo, gallery: [...] } —
 *                                             главное фото и порядок галереи
 * Менять могут сотрудники с ролью Editor или Admin в листе Users, остальные
 * только смотрят. Описание и ссылки на фото пишутся в лист Catalog, файлы фото
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
import { safePhoto, parseGallery, MAX_GALLERY } from './photos.js';

const CATALOG_SHEET = 'Catalog';
const COL = {
  model: 'Модель для клиента',
  // «Описание для клиента» — английское, переводы — в своих колонках
  description: 'Описание для клиента',
  descriptionRu: 'Описание RU',
  descriptionTh: 'Описание TH',
  descriptionZh: 'Описание ZH',
  photo: 'Фото (ссылка)',
  gallery: 'Фото — галерея'
};
// Эти колонки добавили позже: без них работает всё, кроме их правки
const OPTIONAL_COLS = ['gallery', 'descriptionRu', 'descriptionTh', 'descriptionZh'];
const DESCRIPTION_FIELDS = { en: 'description', ru: 'descriptionRu', th: 'descriptionTh', zh: 'descriptionZh' };
const EDIT_ROLES = ['editor', 'admin'];
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_DESCRIPTION = 100;
const IMAGE_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

// Галерея — до 12 фото с миниатюрами за одно сохранение
const uploadLimiter = rateLimiter(60 * 60 * 1000, 200);

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
  if (Object.entries(cols).some(([key, i]) => i < 0 && !OPTIONAL_COLS.includes(key))) throw new HttpError(500, 'catalog_columns_missing');
  const index = rows.findIndex((r) => String(r[cols.model] || '').trim() === model);
  if (index < 0) throw new HttpError(404, 'model_not_found');
  return { rowNumber: index + 2, row: rows[index], cols };
}

/** Записать поля модели в Catalog и в журнал; сайт и бот увидят изменение сразу */
async function writeFields(model, values, staff, found = null) {
  const { rowNumber, row, cols } = found || await findCatalogRow(model);
  let changed = false;
  for (const [field, value] of Object.entries(values)) {
    if (cols[field] < 0) throw new HttpError(500, 'catalog_columns_missing');
    const oldValue = String(row[cols[field]] ?? '').trim();
    if (oldValue === value) continue;
    // RAW — текст как есть: описание «=…» не превратится в формулу
    await updateRange(`'${CATALOG_SHEET}'!${columnLetter(cols[field])}${rowNumber}`, [[value]], { raw: true });
    db.logCatalogChange({ model, field, oldValue, newValue: value, email: staff.email, name: staff.name });
    changed = true;
  }
  if (!changed) return;
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
    descriptions: entry.descriptions,
    photo: photoUrl(entry.photo),
    gallery: parseGallery(entry.gallery),
    units: unitCount.get(model) || 0,
    // На сайте показываются модели, у которых есть техника в парке
    onSite: Boolean(entry.type && unitCount.get(model)),
    lastChange: changes.get(model) || null
  }));
  models.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.model.localeCompare(b.model));
  sendJson(res, 200, { canEdit: canEdit(staff), maxGallery: MAX_GALLERY, models });
}

export async function saveDescription(staff, req, res) {
  requireEditor(staff);
  const body = await readJson(req);
  const model = String(body.model || '').trim();
  if (!model) throw new HttpError(400, 'model_required');
  const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
  // Старый формат { description } — только английское
  const given = body.descriptions && typeof body.descriptions === 'object' ? body.descriptions : { en: body.description };
  const descriptions = Object.fromEntries(Object.keys(DESCRIPTION_FIELDS).filter((l) => l in given).map((l) => [l, clean(given[l])]));
  const found = await findCatalogRow(model);
  const values = {};
  for (const [lang, text] of Object.entries(descriptions)) {
    // Колонки перевода ещё нет, а текст пустой — писать нечего
    if (found.cols[DESCRIPTION_FIELDS[lang]] < 0 && !text) continue;
    values[DESCRIPTION_FIELDS[lang]] = text;
  }
  await writeFields(model, values, staff, found);
  sendJson(res, 200, { ok: true, descriptions, description: descriptions.en ?? '' });
}

/** Первые байты файла совпадают с заявленным типом картинки */
function looksLike(buffer, ext) {
  if (ext === 'jpg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === 'png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

/** Картинка из тела запроса: { body, ext } после проверки типа, размера и лимита */
async function readImage(staff, req) {
  const ext = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw new HttpError(415, 'image_required');
  if (!uploadLimiter.hit(staff.email)) throw new HttpError(429, 'too_many_uploads');
  const body = await readBody(req, MAX_PHOTO_BYTES);
  if (body.length < 100 || !looksLike(body, ext)) throw new HttpError(400, 'bad_image');
  return { body, ext };
}

const uploadsFile = (photo) => path.join(config.site.uploadsDir, photo.replace(/^\/uploads\//, ''));
const slugOf = (model) => slugify(model) || 'model';

/** Файл, загруженный для этой модели: /uploads/models/<модель>-<хэш>.<тип> */
function isOwnUpload(model, photo) {
  const m = /^\/uploads\/models\/([a-z0-9-]+)-[0-9a-f]{10}\.(webp|jpg|png)$/.exec(photo);
  return Boolean(m && m[1] === slugOf(model) && fs.existsSync(uploadsFile(photo)));
}

export async function uploadPhoto(staff, req, res, url) {
  requireEditor(staff);
  const model = String(url.searchParams.get('model') || '').trim();
  if (!model) throw new HttpError(400, 'model_required');
  const toGallery = url.searchParams.get('gallery') === '1';
  const { body, ext } = await readImage(staff, req);
  const found = await findCatalogRow(model); // модель есть — только тогда сохраняем файл

  // Имя с хэшем содержимого: новое фото — новый адрес, браузеры не покажут старое из кэша
  const name = `${slugOf(model)}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}.${ext}`;
  const dir = path.join(config.site.uploadsDir, 'models');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);

  const photo = `uploads/models/${name}`;
  // Фото для галереи попадёт в таблицу вместе с новым порядком (POST …/gallery)
  if (!toGallery) await writeFields(model, { photo }, staff, found);
  sendJson(res, 200, { ok: true, photo: `/${photo}` });
}

/** Миниатюра name.sm.jpg рядом с загруженным фото name.jpg — для ряда под каруселью */
export async function uploadThumb(staff, req, res, url) {
  requireEditor(staff);
  const photo = String(url.searchParams.get('photo') || '').trim();
  const model = String(url.searchParams.get('model') || '').trim();
  if (!isOwnUpload(model, photo)) throw new HttpError(400, 'unknown_photo');
  const { body, ext } = await readImage(staff, req);
  if (!photo.endsWith(`.${ext}`)) throw new HttpError(400, 'bad_image');
  fs.writeFileSync(uploadsFile(photo.replace(/(\.\w+)$/, '.sm$1')), body);
  sendJson(res, 200, { ok: true });
}

/**
 * Главное фото и галерея модели. Можно только переставить, убрать или сделать
 * главным уже известное фото (из таблицы или только что загруженное) —
 * чужие ссылки сюда не попадут.
 */
export async function saveGallery(staff, req, res) {
  requireEditor(staff);
  const body = await readJson(req);
  const model = String(body.model || '').trim();
  if (!model) throw new HttpError(400, 'model_required');
  if (!Array.isArray(body.gallery)) throw new HttpError(400, 'gallery_required');
  const found = await findCatalogRow(model);
  const { row, cols } = found;
  if (cols.gallery < 0) throw new HttpError(500, 'catalog_columns_missing');

  const known = new Set([safePhoto(row[cols.photo]), ...parseGallery(row[cols.gallery])].filter(Boolean));
  const check = (value) => {
    const photo = safePhoto(value);
    if (!photo || (!known.has(photo) && !isOwnUpload(model, photo))) throw new HttpError(400, 'unknown_photo');
    return photo;
  };
  const photo = body.photo ? check(body.photo) : '';
  const gallery = [...new Set(body.gallery.map(check))].filter((p) => p !== photo);
  if (gallery.length > MAX_GALLERY) throw new HttpError(400, 'too_many_photos');

  // В таблице — без начального «/», как и раньше: img/…, uploads/…
  const cell = (p) => p.replace(/^\//, '');
  await writeFields(model, { photo: cell(photo), gallery: gallery.map(cell).join('\n') }, staff, found);
  sendJson(res, 200, { ok: true, photo, gallery });
}
