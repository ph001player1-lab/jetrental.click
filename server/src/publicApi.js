/**
 * ============================================================================
 * Открытое API для сайта jetrental.click
 * ============================================================================
 *   GET  /api/public/catalog                         — модели, цены, фото,
 *                                                     свободна ли сейчас
 *   GET  /api/public/availability?type=&from=&to=   — что свободно на даты
 *   POST /api/public/request                         — заявка с сайта
 *                                                     (уходит в рабочую группу)
 * Госномера и количество единиц наружу не отдаём.
 * ============================================================================
 */

import * as db from './db.js';
import { HttpError, sendJson, readJson, clientIp, rateLimiter } from './http.js';
import { findAvailableModels, getFleet, sheetsEnabled } from './fleet.js';
import { getWsSnapshot } from './ws/sync.js';
import { publishRequest } from './staff.js';
import { todayIso } from './dates.js';
import { VEHICLE_TYPES } from './format.js';
import { LANGUAGES } from './i18n.js';
import { isValidEmail } from './staffUsers.js';
import { slugify, TYPE_ORDER } from './site/urls.js';
import { safePhoto, photoExists, thumbOf, parseGallery, MAX_GALLERY } from './photos.js';

const CATALOG_CACHE_MS = 60 * 1000;
const AVAILABILITY_CACHE_MS = 2 * 60 * 1000;
const MAX_RENTAL_DAYS = 365;

const availabilityLimiter = rateLimiter(60 * 1000, 30);
const requestLimiter = rateLimiter(60 * 60 * 1000, 5);

let catalogCache = null;
const availabilityCache = new Map();

async function buildCatalog() {
  if (!sheetsEnabled) return { updatedAt: null, models: [] };
  const { units, catalog } = await getFleet();
  const snapshot = getWsSnapshot();

  const unitCount = new Map();
  for (const unit of units) if (unit.model) unitCount.set(unit.model, (unitCount.get(unit.model) || 0) + 1);
  const freeNow = new Map();
  for (const car of snapshot?.cars || []) {
    if (car.model && car.status === 'free') freeNow.set(car.model, (freeNow.get(car.model) || 0) + 1);
  }

  const models = [];
  for (const [model, entry] of catalog) {
    if (!unitCount.get(model) || !entry.type) continue;
    const tiers = [entry.pricePerDay, entry.pricePerDayWeek, entry.pricePerDayMonth].filter(Boolean);
    // Удалённые с сервера файлы не показываем; нет главного фото — берём первое из галереи
    const gallery = parseGallery(entry.gallery).filter(photoExists);
    const main = safePhoto(entry.photo);
    const photo = photoExists(main) ? main : gallery[0] || '';
    models.push({
      model,
      slug: slugify(model),
      type: entry.type,
      priceFrom: entry.priceFrom || (tiers.length ? Math.min(...tiers) : null),
      perDay: entry.pricePerDay,
      perDayWeek: entry.pricePerDayWeek,
      perDayMonth: entry.pricePerDayMonth,
      deposit: entry.deposit,
      description: entry.description,
      photo,
      // Кадры карусели на странице модели: главное фото, затем галерея
      gallery: [photo, ...gallery.filter((src) => src !== photo)].filter(Boolean).slice(0, MAX_GALLERY + 1)
        .map((src) => ({ src, thumb: thumbOf(src) })),
      // null — данных из Автопроката пока нет
      availableNow: snapshot ? (freeNow.get(model) || 0) > 0 : null
    });
  }

  models.sort((a, b) =>
    TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
    || (a.priceFrom || Infinity) - (b.priceFrom || Infinity)
    || a.model.localeCompare(b.model));
  return { updatedAt: snapshot?.updatedAt || null, models };
}

/** Сбросить кэш каталога (после правки фото или описания) */
export function resetCatalog() {
  catalogCache = null;
}

/** Версия каталога: меняется при каждой пересборке — по ней обновляются страницы сайта */
export function catalogVersion() {
  return catalogCache?.at || 0;
}

/** Каталог для API и страниц сайта (кэш на минуту) */
export async function getCatalog() {
  if (!catalogCache || Date.now() - catalogCache.at > CATALOG_CACHE_MS) {
    catalogCache = { at: Date.now(), data: await buildCatalog() };
  }
  return catalogCache.data;
}

async function catalog(req, res) {
  sendJson(res, 200, await getCatalog(), { 'Cache-Control': 'public, max-age=60' });
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Проверка дат аренды; возвращает число дней */
function checkDates(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new HttpError(400, 'invalid_dates');
  if (from < todayIso()) throw new HttpError(400, 'date_past');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  if (days < 1) throw new HttpError(400, 'date_order');
  if (days > MAX_RENTAL_DAYS) throw new HttpError(400, 'too_long');
  return days;
}

async function availableOptions(type, from, to) {
  const key = `${type}|${from}|${to}`;
  const cached = availabilityCache.get(key);
  if (cached && Date.now() - cached.at < AVAILABILITY_CACHE_MS) return cached.options;
  const options = sheetsEnabled ? await findAvailableModels(type, from, to) : [];
  availabilityCache.set(key, { at: Date.now(), options });
  if (availabilityCache.size > 500) {
    for (const [k, v] of availabilityCache) if (Date.now() - v.at > AVAILABILITY_CACHE_MS) availabilityCache.delete(k);
  }
  return options;
}

async function availability(req, res, url) {
  const type = url.searchParams.get('type');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!VEHICLE_TYPES[type]) throw new HttpError(400, 'invalid_type');
  const days = checkDates(from, to);
  if (!availabilityLimiter.hit(clientIp(req))) throw new HttpError(429, 'too_many_requests');

  const options = await availableOptions(type, from, to);
  sendJson(res, 200, {
    type,
    from,
    to,
    days,
    models: options.map((o) => ({ model: o.model, price: o.price || null }))
  });
}

const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, max);

async function createSiteRequest(req, res) {
  const body = await readJson(req);
  // Скрытое поле-ловушка: люди его не видят, боты заполняют
  if (body.website) return sendJson(res, 200, { ok: true });

  const name = cleanText(body.name, 80);
  const phone = cleanText(body.phone, 30);
  const email = cleanText(body.email, 200);
  const message = cleanText(body.message, 1000);
  const model = cleanText(body.model, 80) || null;
  const type = body.type ? String(body.type) : null;
  const digits = phone.replace(/\D/g, '');

  if (!name) throw new HttpError(400, 'name_required');
  if (digits.length < 7 || digits.length > 15) throw new HttpError(400, 'invalid_phone');
  if (email && !isValidEmail(email)) throw new HttpError(400, 'invalid_email');
  if (type && !VEHICLE_TYPES[type]) throw new HttpError(400, 'invalid_type');
  const hasDates = Boolean(body.from || body.to);
  if (hasDates) checkDates(body.from, body.to);
  if (!hasDates && !message && !model) throw new HttpError(400, 'message_required');
  if (!requestLimiter.hit(clientIp(req))) throw new HttpError(429, 'too_many_requests');

  // Оценка и свободные госномера — для карточки в рабочей группе
  let estimateThb = null;
  let freeUnits = null;
  if (type && model && hasDates) {
    const match = (await availableOptions(type, body.from, body.to).catch(() => [])).find((o) => o.model === model);
    estimateThb = match?.price?.total || null;
    freeUnits = match?.freePlates?.join(', ') || null;
  }

  const request = db.createRequest({
    channel: 'site',
    clientName: name,
    clientPhone: phone,
    vehicleType: type,
    dateFrom: hasDates ? body.from : null,
    dateTo: hasDates ? body.to : null,
    model,
    estimateThb,
    freeUnits,
    comment: [email && `email: ${email}`, message].filter(Boolean).join('\n') || null,
    lang: LANGUAGES[body.lang] ? body.lang : null
  });
  await publishRequest(request);
  sendJson(res, 200, { ok: true, id: request.id });
}

const ROUTES = {
  'GET /api/public/catalog': catalog,
  'GET /api/public/availability': availability,
  'POST /api/public/request': createSiteRequest
};

export function publicRoute(method, pathname) {
  return ROUTES[`${method} ${pathname}`] || null;
}
