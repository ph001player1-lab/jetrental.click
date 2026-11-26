/**
 * ============================================================================
 * Автопарк: какие модели свободны на даты и сколько стоят
 * ============================================================================
 * Техника и каталог моделей — в базе портала (fleetStore.js): их правят на
 * вкладках «Парк» и «Сайт». Раньше это были листы Vehicles и Catalog
 * Google-таблицы — при первом запуске они один раз переносятся в портал.
 * Цены — вкладка «Прайс» (price.js), занятость — WS.Автопрокат.
 * ============================================================================
 */

import { getRows, getValues, sheetsEnabled as googleEnabled } from './google/sheets.js';
import { fleetMoved, importFromSheet, markMovedWithoutSheet, vehicleUnits, catalogMap } from './fleetStore.js';
import { parsePrice, buildPricing, priceSheetNames, SEASONS_SHEET, quotePlate } from './pricing.js';
import { priceActive, importFromSheets, buildPortalPricing, priceFromByModel } from './price.js';
import { listActiveRequests } from './db.js';
import { portalSnapshot, freeOnDates } from './vehicleStatus.js';
import { isSold, rememberSoldModels } from './sold.js';

const VEHICLES_SHEET = 'Vehicles';
const CATALOG_SHEET = 'Catalog';
// Пока парк в таблице — читаем не чаще раза в 2 минуты; из базы — быстро, кэш короткий
const CACHE_MS = 2 * 60 * 1000;
const PORTAL_CACHE_MS = 15 * 1000;

/** Данные парка есть всегда: в портале (раньше — только при подключённой таблице) */
export const fleetEnabled = true;

const VEHICLE_COL = {
  type: 'Тип',
  brand: 'Марка',
  model: 'Модель',
  plate: 'Госномер',
  status: 'Статус',
  rentFrom: 'Дата начала аренды',
  rentTo: 'Дата окончания аренды',
  clientModel: 'Модель для клиента'
};

const CATALOG_COL = {
  model: 'Модель для клиента',
  type: 'Тип',
  // Заголовок менялся («как на сайте» → «из прайса …»): ищем по началу
  priceFrom: 'Цена от ฿/день',
  pricePerDay: 'Цена ฿/день (1–6 дней)',
  pricePerDayWeek: 'Цена ฿/день (7–29 дней)',
  pricePerDayMonth: 'Цена ฿/день (от 30 дней)',
  deposit: 'Депозит ฿',
  // «Описание для клиента» — английское, остальные языки — в своих колонках
  description: 'Описание для клиента',
  descriptionRu: 'Описание RU',
  descriptionTh: 'Описание TH',
  descriptionZh: 'Описание ZH',
  photo: 'Фото (ссылка)',
  gallery: 'Фото — галерея'
};

// Значения колонки «Тип» в таблице → внутренние ключи бота
const TYPE_KEYS = { Car: 'car', Motorcycle: 'motorcycle', Scooter: 'scooter' };

let cache = null;
let lastError = null;

/** '20.12.2025' / '20.12.2025 14:00' / '2025-12-20' → '2025-12-20' */
export function parseSheetDate(value) {
  const text = String(value || '').trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return m ? m[0] : null;
}

/** Значение колонки, заголовок которой начинается с prefix */
function byPrefix(row, prefix) {
  const key = Object.keys(row).find((k) => k.startsWith(prefix));
  return key ? row[key] : '';
}

/** Сезоны и листы цен; null — если листа «Сезоны» нет или он пуст */
async function loadPricing() {
  const seasonRows = await getRows(SEASONS_SHEET);
  const names = priceSheetNames(seasonRows);
  if (!names.length) return null;
  const sheets = await Promise.all(names.map((name) => getValues(`'${name}'!A2:I`).catch((err) => {
    console.error(`Price sheet "${name}" load failed:`, err.message);
    return [];
  })));
  return buildPricing(seasonRows, new Map(names.map((name, i) => [name, sheets[i]])));
}

/** Парк без проданных машин; проданные — отдельно (для сайта: «нет в наличии») */
async function loadFleet() {
  const all = await loadFleetAll();
  const sold = all.units.filter((u) => isSold(u.plate));
  if (sold.length) rememberSoldModels(sold);
  return { ...all, units: sold.length ? all.units.filter((u) => !isSold(u.plate)) : all.units, soldUnits: sold };
}

async function loadFleetAll() {
  if (cache && Date.now() - cache.loadedAt < (fleetMoved() ? PORTAL_CACHE_MS : CACHE_MS)) return cache;

  try {
    if (!fleetMoved() && !googleEnabled) markMovedWithoutSheet();
    if (fleetMoved()) return loadFromPortal();
    // Переезд: один раз читаем таблицу и переносим технику и каталог в портал
    const portal = priceActive();
    const [vehicleRows, catalogRows, sheetPricing] = await Promise.all([
      getRows(VEHICLES_SHEET),
      getRows(CATALOG_SHEET),
      portal ? Promise.resolve(null) : loadPricing().catch(() => null)
    ]);
    let pricing = sheetPricing;

    const catalog = new Map();
    for (const row of catalogRows) {
      const name = String(row[CATALOG_COL.model] || '').trim();
      if (!name) continue;
      catalog.set(name, {
        type: TYPE_KEYS[row[CATALOG_COL.type]] || null,
        priceFrom: parsePrice(byPrefix(row, CATALOG_COL.priceFrom)),
        pricePerDay: parsePrice(row[CATALOG_COL.pricePerDay]),
        pricePerDayWeek: parsePrice(row[CATALOG_COL.pricePerDayWeek]),
        pricePerDayMonth: parsePrice(row[CATALOG_COL.pricePerDayMonth]),
        deposit: parsePrice(row[CATALOG_COL.deposit]),
        description: String(row[CATALOG_COL.description] || '').trim(),
        descriptions: {
          en: String(row[CATALOG_COL.description] || '').trim(),
          ru: String(row[CATALOG_COL.descriptionRu] || '').trim(),
          th: String(row[CATALOG_COL.descriptionTh] || '').trim(),
          zh: String(row[CATALOG_COL.descriptionZh] || '').trim()
        },
        photo: String(row[CATALOG_COL.photo] || '').trim(),
        gallery: String(row[CATALOG_COL.gallery] || '').trim()
      });
    }

    const units = vehicleRows.map((row) => {
      const clientModel = String(row[VEHICLE_COL.clientModel] || '').trim()
        || `${row[VEHICLE_COL.brand] || ''} ${row[VEHICLE_COL.model] || ''}`.trim();
      return {
        plate: String(row[VEHICLE_COL.plate] || '').trim(),
        type: catalog.get(clientModel)?.type || TYPE_KEYS[row[VEHICLE_COL.type]] || null,
        model: clientModel,
        status: String(row[VEHICLE_COL.status] || '').trim(),
        rentFrom: parseSheetDate(row[VEHICLE_COL.rentFrom]),
        rentTo: parseSheetDate(row[VEHICLE_COL.rentTo])
      };
    });

    // Первый раз — переносим прайс из таблицы в портал (новые сезоны, ступень 28+)
    if (!portal && sheetPricing) {
      try { importFromSheets(sheetPricing, units, plateKey); } catch (err) { console.error('Price import failed:', err.message); }
    }
    if (priceActive()) {
      pricing = buildPortalPricing(units, plateKey);
      // «Цена от» на сайте — из прайса: самая низкая цена 28+ дней
      const from = priceFromByModel();
      for (const [model, entry] of catalog) if (from.has(model)) entry.priceFrom = from.get(model);
    }

    try {
      importFromSheet(vehicleRows, catalogRows);
      return loadFromPortal();
    } catch (err) {
      console.error('Fleet move to the portal failed (still reading the sheet):', err.message);
    }
    cache = { loadedAt: Date.now(), units, catalog, pricing };
    lastError = null;
    return cache;
  } catch (err) {
    lastError = err.message;
    // Если Google недоступен, работаем на последних загруженных данных
    if (cache) return cache;
    throw err;
  }
}

/** Парк из базы портала: техника, каталог, цены из «Прайса» */
function loadFromPortal() {
  const catalog = catalogMap();
  const units = vehicleUnits(catalog);
  let pricing = null;
  if (priceActive()) {
    pricing = buildPortalPricing(units, plateKey);
    // «Цена от» на сайте — из прайса: самая низкая цена 28+ дней
    const from = priceFromByModel();
    for (const [model, entry] of catalog) if (from.has(model)) entry.priceFrom = from.get(model);
  }
  cache = { loadedAt: Date.now(), units, catalog, pricing };
  lastError = null;
  return cache;
}


function overlaps(request, from, to) {
  return request.date_from && request.date_to && request.date_from <= to && request.date_to >= from;
}

/**
 * Цена модели на срок:
 * - заполнены тарифы по срокам → { perDay, total, deposit } (точная оценка);
 * - есть только цена «от» с сайта → { fromPerDay, deposit } (без суммы);
 * - ничего нет → null (цену уточнит менеджер).
 */
export function priceFor(entry, days) {
  if (!entry) return null;
  let perDay = entry.pricePerDay;
  if (days >= 7 && entry.pricePerDayWeek) perDay = entry.pricePerDayWeek;
  if (days >= 30 && entry.pricePerDayMonth) perDay = entry.pricePerDayMonth;
  if (perDay) return { perDay, total: perDay * days, deposit: entry.deposit };
  if (entry.priceFrom) return { fromPerDay: entry.priceFrom, deposit: entry.deposit };
  return null;
}

const sortPrice = (price) => price?.perDay || price?.fromPerDay || 0;

/** Госномер для сопоставления таблицы и Автопроката: только цифры ('ก 7072' → '7072') */
export function plateKey(plate) {
  return String(plate || '').replace(/\D/g, '');
}

/** Сколько единиц каждой модели уже «держат» заявки бота на эти даты */
function heldByModel(from, to) {
  const held = new Map();
  for (const request of listActiveRequests()) {
    if (request.model && overlaps(request, from, to)) held.set(request.model, (held.get(request.model) || 0) + 1);
  }
  return held;
}

/**
 * Свободные единицы по статусам портала (отчёты рабочей группы, события портала,
 * ремонт из карточки — vehicleStatus.js). WS.Автопрокат сюда не смотрит: он только сверяется.
 */
function freeByPortal(units, vehicleType, from, to) {
  const snapshot = portalSnapshot(units);
  const carByPlate = new Map(snapshot.cars.map((c) => [plateKey(c.plate), c]));
  const byModel = new Map();
  for (const unit of units) {
    if (unit.type !== vehicleType || !unit.model) continue;
    if (!byModel.has(unit.model)) byModel.set(unit.model, { plates: [] });
    const car = carByPlate.get(plateKey(unit.plate));
    if (car && unit.plate && freeOnDates(car, from, to)) byModel.get(unit.model).plates.push(unit.plate);
  }
  return byModel;
}

/**
 * Свободные модели нужного типа на даты: [{ model, freePlates, price }].
 * Занятость — по статусам портала, цены — из «Прайса». Заявки, которые уже
 * приняты ботом на эти даты, «придерживают» единицы.
 */
export async function findAvailableModels(vehicleType, from, to) {
  const { catalog, pricing } = await loadFleet();
  // Тот же список, что у снимка статусов (снимок не пересчитывается на каждый запрос)
  const units = loadedUnits();
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

  const byModel = freeByPortal(units, vehicleType, from, to);

  const held = heldByModel(from, to);
  const result = [];
  for (const [model, { plates }] of byModel) {
    if (plates.length - (held.get(model) || 0) <= 0) continue;
    // Цена: сезонный прайс (самая дешёвая из свободных единиц) → цена «от» из каталога
    const quoted = plates
      .map((plate) => ({ plate, price: quotePlate(pricing, plateKey(plate), from, to) }))
      .filter((q) => q.price)
      .sort((a, b) => a.price.total - b.price.total);
    // Самую дешёвую единицу ставим первой — менеджер увидит её в карточке заявки
    const freePlates = quoted.length ? [quoted[0].plate, ...plates.filter((p) => p !== quoted[0].plate)] : plates;
    result.push({ model, freePlates, price: quoted[0]?.price || priceFor(catalog.get(model), days) });
  }

  // Сначала модели с ценой (от дешёвых к дорогим), потом без цены по алфавиту
  return result.sort((a, b) => {
    const pa = sortPrice(a.price);
    const pb = sortPrice(b.price);
    if (pa && pb) return pa - pb;
    if (pa || pb) return pa ? -1 : 1;
    return a.model.localeCompare(b.model);
  });
}

/** Текущие данные таблицы (для синхронизации с Автопрокатом) */
export function getFleet() {
  return loadFleet();
}

/** Перечитать таблицу при следующем обращении (после правки с сайта сотрудников) */
export function invalidateFleet() {
  if (cache) cache.loadedAt = 0;
}

/** Снимок статусов портала прямо сейчас (для «Обзора», сводки, сайта); null — парк ещё не загружен */
export function portalSnapshotNow() {
  return cache ? portalSnapshot(loadedUnits()) : null;
}

/** Парк без архива из уже загруженных данных */
function loadedUnits() {
  if (!cache) return [];
  if (cache.activeUnits && cache.activeFor === cache.units) return cache.activeUnits;
  cache.activeUnits = cache.units.filter((u) => !isSold(u.plate));
  cache.activeFor = cache.units;
  return cache.activeUnits;
}

/** Снимок статусов портала (с загрузкой парка) */
export async function getPortalSnapshot() {
  await loadFleet();
  return portalSnapshotNow();
}

/** Загрузка при старте сервера (и переезд парка из таблицы, если ещё не было) */
export function warmUpFleet() {
  loadFleet().catch((err) => console.error('Fleet warm-up failed:', err.message));
}

export function fleetStatus() {
  return {
    enabled: true,
    source: fleetMoved() ? 'portal' : 'sheet',
    units: cache ? cache.units.length : 0,
    catalogModels: cache ? cache.catalog.size : 0,
    seasons: cache?.pricing ? cache.pricing.seasons.length : 0,
    verifiedSeasons: cache?.pricing ? [...new Set(cache.pricing.seasons.filter((s) => s.verified).map((s) => s.name))] : [],
    loadedAt: cache ? new Date(cache.loadedAt).toISOString() : null,
    error: lastError
  };
}

// Прежнее имя «таблица подключена» — теперь «данные парка есть» (их читают дашборд, сайт, CRM)
export { fleetEnabled as sheetsEnabled };
