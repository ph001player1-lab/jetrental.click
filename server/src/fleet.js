/**
 * ============================================================================
 * Автопарк из Google-таблицы: какие модели свободны на даты и сколько стоят
 * ============================================================================
 * Vehicles — единицы техники (госномер, статус, даты текущей аренды) и
 *            колонка «Модель для клиента», которая объединяет одинаковые байки.
 * Catalog  — одна строка на модель: цены по срокам аренды и депозит.
 *
 * Таблица читается не чаще раза в 2 минуты, чтобы не упираться в лимиты Google.
 * ============================================================================
 */

import { getRows, sheetsEnabled } from './google/sheets.js';
import { listActiveRequests } from './db.js';

const VEHICLES_SHEET = 'Vehicles';
const CATALOG_SHEET = 'Catalog';
const CACHE_MS = 2 * 60 * 1000;

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
  pricePerDay: 'Цена ฿/день (1–6 дней)',
  pricePerDayWeek: 'Цена ฿/день (7–29 дней)',
  pricePerDayMonth: 'Цена ฿/день (от 30 дней)',
  deposit: 'Депозит ฿'
};

// Значения колонки «Тип» в таблице → внутренние ключи бота
const TYPE_KEYS = { Car: 'car', Motorcycle: 'motorcycle', Scooter: 'scooter' };
const REPAIR_STATUSES = ['In Repair', 'Needs Repair'];

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

/** '1 200' / '1200,00' / '฿1,200' → 1200 */
function parsePrice(value) {
  const text = String(value || '').replace(/[\s ฿]/g, '');
  if (!text) return null;
  const normalized = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const number = Math.round(parseFloat(normalized));
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function loadFleet() {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;

  try {
    const [vehicleRows, catalogRows] = await Promise.all([
      getRows(VEHICLES_SHEET),
      getRows(CATALOG_SHEET).catch(() => [])
    ]);

    const catalog = new Map();
    for (const row of catalogRows) {
      const name = String(row[CATALOG_COL.model] || '').trim();
      if (!name) continue;
      catalog.set(name, {
        type: TYPE_KEYS[row[CATALOG_COL.type]] || null,
        pricePerDay: parsePrice(row[CATALOG_COL.pricePerDay]),
        pricePerDayWeek: parsePrice(row[CATALOG_COL.pricePerDayWeek]),
        pricePerDayMonth: parsePrice(row[CATALOG_COL.pricePerDayMonth]),
        deposit: parsePrice(row[CATALOG_COL.deposit])
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

    cache = { loadedAt: Date.now(), units, catalog };
    lastError = null;
    return cache;
  } catch (err) {
    lastError = err.message;
    // Если Google недоступен, работаем на последних загруженных данных
    if (cache) return cache;
    throw err;
  }
}

/**
 * Единица свободна на [from, to], если она не в ремонте и её текущая аренда
 * из таблицы не пересекается с этими датами.
 */
function isUnitFree(unit, from, to) {
  if (REPAIR_STATUSES.includes(unit.status)) return false;
  if (unit.rentFrom && unit.rentTo) return unit.rentTo < from || unit.rentFrom > to;
  // «Rented» без дат — не знаем, когда вернут, поэтому не предлагаем
  return unit.status !== 'Rented';
}

function overlaps(request, from, to) {
  return request.date_from && request.date_to && request.date_from <= to && request.date_to >= from;
}

/** Цена за весь срок по тарифам модели или null, если цены не заполнены */
export function priceFor(entry, days) {
  if (!entry) return null;
  let perDay = entry.pricePerDay;
  if (days >= 7 && entry.pricePerDayWeek) perDay = entry.pricePerDayWeek;
  if (days >= 30 && entry.pricePerDayMonth) perDay = entry.pricePerDayMonth;
  if (!perDay) return null;
  return { perDay, total: perDay * days, deposit: entry.deposit };
}

/**
 * Свободные модели нужного типа на даты: [{ model, freePlates, price }].
 * Заявки, которые уже приняты ботом на эти даты, «придерживают» единицы.
 */
export async function findAvailableModels(vehicleType, from, to) {
  const { units, catalog } = await loadFleet();
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

  const byModel = new Map();
  for (const unit of units) {
    if (unit.type !== vehicleType || !unit.model) continue;
    if (!byModel.has(unit.model)) byModel.set(unit.model, []);
    if (isUnitFree(unit, from, to)) byModel.get(unit.model).push(unit.plate);
  }

  const held = new Map();
  for (const request of listActiveRequests()) {
    if (request.model && overlaps(request, from, to)) held.set(request.model, (held.get(request.model) || 0) + 1);
  }

  const result = [];
  for (const [model, plates] of byModel) {
    const freeCount = plates.length - (held.get(model) || 0);
    if (freeCount <= 0) continue;
    result.push({ model, freePlates: plates, price: priceFor(catalog.get(model), days) });
  }

  // Сначала модели с ценой (от дешёвых к дорогим), потом без цены по алфавиту
  return result.sort((a, b) => {
    if (a.price && b.price) return a.price.perDay - b.price.perDay;
    if (a.price || b.price) return a.price ? -1 : 1;
    return a.model.localeCompare(b.model);
  });
}

export function fleetStatus() {
  return {
    enabled: sheetsEnabled,
    units: cache ? cache.units.length : 0,
    catalogModels: cache ? cache.catalog.size : 0,
    loadedAt: cache ? new Date(cache.loadedAt).toISOString() : null,
    error: lastError
  };
}

export { sheetsEnabled };
