/**
 * ============================================================================
 * Парк и каталог моделей — в базе портала (раньше — Google-таблица)
 * ============================================================================
 * Первоисточник — портал: вся техника (машины, скутеры, мотоциклы) и каталог
 * моделей для сайта (тип, описания на 4 языках, фото, галерея). Владелец и
 * админ правят карточки на вкладке «Парк», описания и фото — на вкладке «Сайт».
 * WS.Автопрокат сверяется с парком портала, расхождения — в «Обзоре».
 *
 * Переезд: один раз переносим листы Vehicles и Catalog из Google-таблицы
 * (ничего в ней не меняем — она остаётся архивом). Пока перенос не удался
 * (нет связи с Google), работаем по таблице, как раньше, и пробуем снова.
 * Без Google-таблицы на сервере портал сразу работает сам по себе.
 * ============================================================================
 */

import * as db from './db.js';

export const TYPES = ['scooter', 'motorcycle', 'car'];
export const REPAIR = ['ok', 'needs_repair', 'in_repair'];
const SHEET_TYPES = { car: 'car', motorcycle: 'motorcycle', scooter: 'scooter' };
// Статус из таблицы → «ремонт»; аренду и свободу берём из WS и журнала
const SHEET_REPAIR = { 'needs repair': 'needs_repair', 'in repair': 'in_repair' };

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS fleet_vehicles (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    plate             TEXT NOT NULL DEFAULT '',
    plate_key         TEXT UNIQUE,
    type              TEXT,
    brand             TEXT,
    model             TEXT,
    client_model      TEXT,
    year              TEXT,
    vin               TEXT,
    color             TEXT,
    mileage           INTEGER,
    service_date      TEXT,
    service_km        INTEGER,
    next_service_km   INTEGER,
    next_service_date TEXT,
    repair            TEXT NOT NULL DEFAULT 'ok',
    responsible       TEXT,
    inventory_date    TEXT,
    photo             TEXT,
    comment           TEXT,
    sheet_id          TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    updated_by        TEXT
  );
  CREATE TABLE IF NOT EXISTS catalog_models (
    model       TEXT PRIMARY KEY,
    type        TEXT,
    price_from  REAL,
    price_day   REAL,
    price_week  REAL,
    price_month REAL,
    deposit     REAL,
    desc_en     TEXT NOT NULL DEFAULT '',
    desc_ru     TEXT NOT NULL DEFAULT '',
    desc_th     TEXT NOT NULL DEFAULT '',
    desc_zh     TEXT NOT NULL DEFAULT '',
    photo       TEXT NOT NULL DEFAULT '',
    gallery     TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fleet_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    by      TEXT NOT NULL,
    plate   TEXT,
    action  TEXT NOT NULL,
    details TEXT
  );
`);

// Чья машина (кабинет инвестора) и особая доля для этой машины (пусто — доля инвестора)
// investor_negative — особое условие для машины: минус учитывать ('carry') или обнулять ('zero'); пусто — как у инвестора
for (const [col, type] of [['investor_id', 'INTEGER'], ['investor_percent', 'REAL'], ['investor_negative', 'TEXT']]) {
  if (!db.raw.prepare('PRAGMA table_info(fleet_vehicles)').all().some((c) => c.name === col)) db.raw.exec(`ALTER TABLE fleet_vehicles ADD COLUMN ${col} ${type}`);
}

const q = {
  setInvestor: db.raw.prepare('UPDATE fleet_vehicles SET investor_id = ?, investor_percent = ? WHERE id = ?'),
  setNegative: db.raw.prepare('UPDATE fleet_vehicles SET investor_negative = ? WHERE id = ?'),
  vehicles: db.raw.prepare('SELECT * FROM fleet_vehicles ORDER BY type, client_model, plate'),
  vehicle: db.raw.prepare('SELECT * FROM fleet_vehicles WHERE id = ?'),
  byKey: db.raw.prepare('SELECT * FROM fleet_vehicles WHERE plate_key = ?'),
  insert: db.raw.prepare(`INSERT INTO fleet_vehicles (plate, plate_key, type, brand, model, client_model, year, vin, color, mileage,
    service_date, service_km, next_service_km, next_service_date, repair, responsible, inventory_date, photo, comment, sheet_id, created_at, updated_at, updated_by)
    VALUES (:plate, :plate_key, :type, :brand, :model, :client_model, :year, :vin, :color, :mileage, :service_date, :service_km, :next_service_km,
      :next_service_date, :repair, :responsible, :inventory_date, :photo, :comment, :sheet_id, :at, :at, :by)`),
  update: db.raw.prepare(`UPDATE fleet_vehicles SET plate = :plate, plate_key = :plate_key, type = :type, brand = :brand, model = :model,
    client_model = :client_model, year = :year, vin = :vin, color = :color, mileage = :mileage, service_date = :service_date,
    service_km = :service_km, next_service_km = :next_service_km, next_service_date = :next_service_date, repair = :repair,
    responsible = :responsible, inventory_date = :inventory_date, photo = :photo, comment = :comment, updated_at = :at, updated_by = :by
    WHERE id = :id`),
  remove: db.raw.prepare('DELETE FROM fleet_vehicles WHERE id = ?'),
  catalog: db.raw.prepare('SELECT * FROM catalog_models ORDER BY model'),
  catalogRow: db.raw.prepare('SELECT * FROM catalog_models WHERE model = ?'),
  addCatalog: db.raw.prepare(`INSERT OR IGNORE INTO catalog_models (model, type, price_from, price_day, price_week, price_month, deposit,
    desc_en, desc_ru, desc_th, desc_zh, photo, gallery, updated_at)
    VALUES (:model, :type, :price_from, :price_day, :price_week, :price_month, :deposit, :desc_en, :desc_ru, :desc_th, :desc_zh, :photo, :gallery, :at)`),
  log: db.raw.prepare('INSERT INTO fleet_log (at, by, plate, action, details) VALUES (?, ?, ?, ?, ?)'),
  lastLog: db.raw.prepare('SELECT * FROM fleet_log ORDER BY id DESC LIMIT ?')
};

const nowIso = () => new Date().toISOString();
export const keyOf = (plate) => String(plate || '').replace(/\D/g, '');

/** Парк уже в портале (перенесён или Google-таблицы на сервере нет) */
export const fleetMoved = () => db.getSetting('fleet_portal') === '1';

/* ------------------------------------------------------------- Чтение */

/** Единицы для расчётов (как раньше из таблицы): plate, type, model (для клиента), status */
export function vehicleUnits(catalog) {
  return q.vehicles.all().map((v) => {
    const model = v.client_model || `${v.brand || ''} ${v.model || ''}`.trim();
    return {
      id: v.id, plate: v.plate, type: catalog?.get(model)?.type || v.type || null, model,
      brand: v.brand || '', wsName: `${v.brand || ''} ${v.model || ''}`.trim(),
      status: v.repair === 'in_repair' ? 'In Repair' : v.repair === 'needs_repair' ? 'Needs Repair' : 'Free',
      rentFrom: null, rentTo: null
    };
  });
}

const publicVehicle = (v) => ({
  id: v.id, plate: v.plate, type: v.type, brand: v.brand || '', model: v.model || '', clientModel: v.client_model || '',
  year: v.year || '', vin: v.vin || '', color: v.color || '', mileage: v.mileage ?? null,
  serviceDate: v.service_date || '', serviceKm: v.service_km ?? null, nextServiceKm: v.next_service_km ?? null,
  nextServiceDate: v.next_service_date || '', repair: v.repair || 'ok', responsible: v.responsible || '',
  inventoryDate: v.inventory_date || '', photo: v.photo || '', comment: v.comment || '',
  investorId: v.investor_id || null, investorPercent: v.investor_percent ?? null,
  investorNegative: ['carry', 'zero'].includes(v.investor_negative) ? v.investor_negative : null,
  updatedAt: v.updated_at, updatedBy: v.updated_by || ''
});

export const listVehicles = () => q.vehicles.all().map(publicVehicle);
export const getVehicle = (id) => { const v = q.vehicle.get(Number(id) || 0); return v ? publicVehicle(v) : null; };
export const vehicleByPlate = (plate) => { const v = keyOf(plate) && q.byKey.get(keyOf(plate)); return v ? publicVehicle(v) : null; };
export const fleetLog = (n = 30) => q.lastLog.all(n).map((r) => ({ at: r.at, by: r.by, plate: r.plate, action: r.action, details: JSON.parse(r.details || '{}') }));

/** Каталог моделей: модель → { type, priceFrom, …, descriptions, photo, gallery } (как раньше из листа) */
export function catalogMap() {
  const map = new Map();
  for (const r of q.catalog.all()) {
    map.set(r.model, {
      type: SHEET_TYPES[r.type] || null,
      priceFrom: r.price_from || null, pricePerDay: r.price_day || null, pricePerDayWeek: r.price_week || null,
      pricePerDayMonth: r.price_month || null, deposit: r.deposit || null,
      description: r.desc_en, descriptions: { en: r.desc_en, ru: r.desc_ru, th: r.desc_th, zh: r.desc_zh },
      photo: r.photo, gallery: r.gallery
    });
  }
  return map;
}

/* ------------------------------------------------------------ Каталог */

const CATALOG_FIELDS = { description: 'desc_en', descriptionRu: 'desc_ru', descriptionTh: 'desc_th', descriptionZh: 'desc_zh', photo: 'photo', gallery: 'gallery' };

export const catalogEntry = (model) => q.catalogRow.get(String(model || '')) || null;

/** Изменить поля модели (описания, фото, галерея); вернёт [{ field, oldValue, newValue }] */
export function setCatalogFields(model, values) {
  const row = catalogEntry(model);
  if (!row) return null;
  const changes = [];
  for (const [field, value] of Object.entries(values)) {
    const col = CATALOG_FIELDS[field];
    if (!col) continue;
    const oldValue = String(row[col] ?? '');
    if (oldValue === value) continue;
    db.raw.prepare(`UPDATE catalog_models SET ${col} = ?, updated_at = ? WHERE model = ?`).run(value, nowIso(), row.model);
    changes.push({ field, oldValue, newValue: value });
  }
  return changes;
}

/** Новая «модель для клиента» у техники — сразу строка в каталоге (описание и фото — на вкладке «Сайт») */
function ensureCatalogModel(model, type) {
  if (!model || catalogEntry(model)) return;
  q.addCatalog.run({ model, type: type || null, price_from: null, price_day: null, price_week: null, price_month: null, deposit: null,
    desc_en: '', desc_ru: '', desc_th: '', desc_zh: '', photo: '', gallery: '', at: nowIso() });
}

/* ------------------------------------------------------------- Правка */

export class FleetError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null;
const intOrNull = (v) => {
  const s = String(v ?? '').replace(/[\s,]/g, '');
  if (s === '') return null;
  const n = Math.round(Number(s));
  if (!Number.isFinite(n) || n < 0 || n > 1e8) throw new FleetError('bad_number');
  return n;
};
const dateOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new FleetError('bad_date');
  return s;
};

/** Создать или изменить карточку: { id?, plate, type, brand, model, clientModel, … } */
export function saveVehicle(input, by) {
  const plate = text(input.plate, 20) || '';
  const plateKey = keyOf(plate) || null;
  if (!plateKey) throw new FleetError('plate_required');
  const type = TYPES.includes(input.type) ? input.type : null;
  if (!type) throw new FleetError('type_required');
  const brand = text(input.brand, 40);
  const model = text(input.model, 60);
  const clientModel = text(input.clientModel, 60) || `${brand || ''} ${model || ''}`.trim() || null;
  if (!clientModel) throw new FleetError('model_required');
  const row = {
    plate, plate_key: plateKey, type, brand, model, client_model: clientModel,
    year: text(input.year, 10), vin: text(input.vin, 40), color: text(input.color, 30),
    mileage: intOrNull(input.mileage), service_date: dateOrNull(input.serviceDate), service_km: intOrNull(input.serviceKm),
    next_service_km: intOrNull(input.nextServiceKm), next_service_date: dateOrNull(input.nextServiceDate),
    repair: REPAIR.includes(input.repair) ? input.repair : 'ok', responsible: text(input.responsible, 60),
    inventory_date: dateOrNull(input.inventoryDate), photo: text(input.photo, 300), comment: text(input.comment, 2000),
    at: nowIso(), by
  };
  // Инвестор машины (кабинет инвестора) и особая доля (пусто — доля инвестора); не переданы — прежние
  const investorId = input.investorId === undefined ? undefined : (Number(input.investorId) > 0 ? Math.round(Number(input.investorId)) : null);
  const pctRaw = input.investorPercent === undefined ? undefined : String(input.investorPercent ?? '').replace(',', '.').trim();
  const investorPct = pctRaw === undefined || pctRaw === '' ? (pctRaw === '' ? null : undefined) : Number(pctRaw);
  if (investorPct !== undefined && investorPct !== null && !(investorPct >= 0 && investorPct <= 100)) throw new FleetError('bad_percent');
  // Минус по этой машине: 'carry' / 'zero'; '' — как у инвестора; не передано — прежнее
  const negative = input.investorNegative === undefined ? undefined : ['carry', 'zero'].includes(input.investorNegative) ? input.investorNegative : null;
  const same = q.byKey.get(plateKey);
  if (input.id) {
    const old = q.vehicle.get(Number(input.id));
    if (!old) throw new FleetError('not_found');
    if (same && same.id !== old.id) throw new FleetError('plate_taken');
    q.update.run({ ...row, id: old.id });
    if (negative !== undefined && (old.investor_negative || null) !== negative) {
      q.setNegative.run(negative, old.id);
      q.log.run(row.at, by, plate, 'investor', JSON.stringify({ negative: `${old.investor_negative || '—'} → ${negative || '—'}` }));
    }
    if (investorId !== undefined || investorPct !== undefined) {
      const nextId = investorId !== undefined ? investorId : old.investor_id;
      const nextPct = investorPct !== undefined ? investorPct : old.investor_percent;
      q.setInvestor.run(nextId, nextPct, old.id);
      if ((old.investor_id || null) !== (nextId || null) || (old.investor_percent ?? null) !== (nextPct ?? null)) {
        q.log.run(row.at, by, plate, 'investor', JSON.stringify({ investor: `${old.investor_id || '—'} → ${nextId || '—'}`, percent: `${old.investor_percent ?? '—'} → ${nextPct ?? '—'}` }));
      }
    }
    const changed = Object.keys(row).filter((k) => !['at', 'by', 'plate_key'].includes(k) && String(old[k] ?? '') !== String(row[k] ?? ''));
    q.log.run(row.at, by, plate, 'update', JSON.stringify(Object.fromEntries(changed.map((k) => [k, `${old[k] ?? '—'} → ${row[k] ?? '—'}`]))));
    ensureCatalogModel(clientModel, type);
    console.log(`Fleet: ${plate} updated by ${by} (${changed.join(', ') || 'no changes'})`);
    return publicVehicle(q.vehicle.get(old.id));
  }
  if (same) throw new FleetError('plate_taken');
  const info = q.insert.run({ ...row, sheet_id: null });
  if (investorId || investorPct !== undefined) q.setInvestor.run(investorId || null, investorPct ?? null, Number(info.lastInsertRowid));
  if (negative) q.setNegative.run(negative, Number(info.lastInsertRowid));
  q.log.run(row.at, by, plate, 'create', JSON.stringify({ model: clientModel, type }));
  ensureCatalogModel(clientModel, type);
  console.log(`Fleet: ${plate} (${clientModel}) added by ${by}`);
  return publicVehicle(q.vehicle.get(Number(info.lastInsertRowid)));
}

/** Состояние «ремонт» из смены статуса (В ремонт / Свободна) — без остальных полей карточки */
export function setRepair(id, repair, by) {
  const old = q.vehicle.get(Number(id) || 0);
  if (!old || !REPAIR.includes(repair) || old.repair === repair) return;
  db.raw.prepare('UPDATE fleet_vehicles SET repair = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(repair, nowIso(), by, old.id);
  q.log.run(nowIso(), by, old.plate, 'update', JSON.stringify({ repair: `${old.repair} → ${repair}` }));
}

/** Удалить карточку (ошибка, дубль). Проданную — не удаляют, а переносят в архив */
export function deleteVehicle(id, by) {
  const old = q.vehicle.get(Number(id) || 0);
  if (!old) throw new FleetError('not_found');
  q.remove.run(old.id);
  q.log.run(nowIso(), by, old.plate, 'delete', JSON.stringify({ model: old.client_model, type: old.type }));
  console.log(`Fleet: ${old.plate} deleted by ${by}`);
}

/* ------------------------------------------------------ Переезд из таблицы */

/** '20.12.2025' / '2025-12-20' → '2025-12-20' */
function sheetDate(value) {
  const s = String(value || '').trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[0] : null;
}
const sheetInt = (v) => { const n = Math.round(Number(String(v ?? '').replace(/[^\d.]/g, ''))); return Number.isFinite(n) && String(v ?? '').trim() ? n : null; };
const sheetPrice = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return n > 0 ? n : null; };
const byPrefix = (row, prefix) => { const key = Object.keys(row).find((k) => k.startsWith(prefix)); return key ? row[key] : ''; };

/**
 * Один раз: листы Vehicles и Catalog → база. Возвращает { vehicles, models, skipped }.
 * Повторные госномера пропускаем (первая строка главнее) — их видно в журнале сервера.
 */
export function importFromSheet(vehicleRows, catalogRows) {
  if (fleetMoved()) return null;
  const at = nowIso();
  let vehicles = 0;
  let models = 0;
  const skipped = [];
  db.raw.exec('BEGIN');
  try {
    for (const row of catalogRows) {
      const model = String(row['Модель для клиента'] || '').trim();
      if (!model) continue;
      const info = q.addCatalog.run({
        model, type: SHEET_TYPES[String(row['Тип'] || '').trim().toLowerCase()] || null,
        price_from: sheetPrice(byPrefix(row, 'Цена от ฿/день')), price_day: sheetPrice(row['Цена ฿/день (1–6 дней)']),
        price_week: sheetPrice(row['Цена ฿/день (7–29 дней)']), price_month: sheetPrice(row['Цена ฿/день (от 30 дней)']),
        deposit: sheetPrice(row['Депозит ฿']),
        desc_en: String(row['Описание для клиента'] || '').trim(), desc_ru: String(row['Описание RU'] || '').trim(),
        desc_th: String(row['Описание TH'] || '').trim(), desc_zh: String(row['Описание ZH'] || '').trim(),
        photo: String(row['Фото (ссылка)'] || '').trim(), gallery: String(row['Фото — галерея'] || '').trim(), at
      });
      models += info.changes;
    }
    for (const row of vehicleRows) {
      const plate = String(row['Госномер'] || '').trim();
      const brand = String(row['Марка'] || '').trim();
      const model = String(row['Модель'] || '').trim();
      const clientModel = String(row['Модель для клиента'] || '').trim() || `${brand} ${model}`.trim();
      if (!plate && !clientModel) continue;
      const plateKey = keyOf(plate) || null;
      if (plateKey && q.byKey.get(plateKey)) { skipped.push(plate); continue; }
      const type = SHEET_TYPES[String(row['Тип'] || '').trim().toLowerCase()] || null;
      q.insert.run({
        plate, plate_key: plateKey, type, brand: brand || null, model: model || null, client_model: clientModel || null,
        year: String(row['Год выпуска'] || '').trim() || null, vin: String(row.VIN || '').trim() || null,
        color: String(row['Цвет'] || '').trim() || null, mileage: sheetInt(row['Текущий пробег']),
        service_date: sheetDate(row['Дата последнего ТО']), service_km: sheetInt(row['Пробег последнего ТО']),
        next_service_km: sheetInt(row['Следующее ТО по пробегу']), next_service_date: sheetDate(row['Следующее ТО по дате']),
        repair: SHEET_REPAIR[String(row['Статус'] || '').trim().toLowerCase()] || 'ok',
        responsible: String(row['Ответственный'] || '').trim() || null, inventory_date: sheetDate(row['Последняя инвентаризация']),
        photo: String(row['Фото'] || '').trim() || null, comment: String(row['Комментарий'] || '').trim() || null,
        sheet_id: String(row.ID || '').trim() || null, at, by: 'import'
      });
      ensureCatalogModel(clientModel, type);
      vehicles++;
    }
    q.log.run(at, 'import', null, 'import', JSON.stringify({ vehicles, models, skipped }));
    db.setSetting('fleet_portal', '1');
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  console.log(`Fleet moved to the portal: ${vehicles} vehicles, ${models} catalog models${skipped.length ? `, skipped duplicate plates: ${skipped.join(', ')}` : ''}`);
  return { vehicles, models, skipped };
}

/** Google-таблицы на сервере нет — портал сразу главный */
export function markMovedWithoutSheet() {
  if (!fleetMoved()) db.setSetting('fleet_portal', '1');
}
