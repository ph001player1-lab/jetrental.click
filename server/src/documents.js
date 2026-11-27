/**
 * ============================================================================
 * Документы: договор аренды, фото при выдаче, акт возврата, квитанция,
 * дополнение к договору (шаблоны утвердил владелец — docs/templates.js)
 * ============================================================================
 * Договор — главный документ: клиент, техника, даты, выдача (пробег,
 * топливо, что передали), деньги. Остальные документы привязаны к нему.
 * Номера: договор JM-2026-0125, квитанция R-2026-0311, дополнение
 * JM-2026-0125/1; акт возврата и фото — под номером договора.
 * Сутки — все дни по календарю (rentalDays), цена — из «Прайса».
 *
 * Подпись: на экране портала (клиент расписывается пальцем на телефоне или
 * планшете сотрудника) или по ссылке, которую клиент открывает у себя
 * (jetmobility.org/sign/…; действует 3 дня). Если после подписи документ
 * поменяли, подписи снимаются — подписывать нужно заново.
 * PDF печатает Chromium (docs/pdf.js); клиенту уходит в WhatsApp с номера
 * компании (wabot) по кнопке сотрудника и сам — после подписи по ссылке.
 *
 *   GET  /api/staff/docs                     — договоры и их документы
 *   GET  /api/staff/docs/one?id=             — документ для правки
 *   GET  /api/staff/docs/prefill?vehicleId=&from=&to=&requestId= — техника, цена, клиент из заявки
 *   POST /api/staff/docs/save                { id?, kind, contractId?, lang, data }
 *   POST /api/staff/docs/delete              { id }
 *   GET  /api/staff/docs/pdf?id=             — PDF
 *   POST /api/staff/docs/sign                { id, who: renter|company, png }
 *   POST /api/staff/docs/unsign              { id, who }
 *   POST /api/staff/docs/link                { id } — ссылка клиенту на подпись
 *   POST /api/staff/docs/send                { id, phone? } — PDF клиенту в WhatsApp
 *   POST /api/staff/docs/photo?contract=&caption= (JPEG) — фото при выдаче
 *   GET  /api/staff/docs/photo?id=&i=        — фото (для портала)
 *   POST /api/staff/docs/photo/delete        { id, index }
 *   GET  /sign/<token>, /sign/<token>/pdf, POST /api/public/sign — подпись клиентом
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as db from './db.js';
import { config } from './config.js';
import { HttpError, sendJson, readJson, readBody, clientIp, rateLimiter } from './http.js';
import { can } from './roles.js';
import { getVehicle, listVehicles } from './fleetStore.js';
import { getFleet, plateKey } from './fleet.js';
import { quotePlate } from './pricing.js';
import { rentalDays } from './format.js';
import { renderDocument, LANGS, docTitle, COMPANY } from './docs/templates.js';
import { htmlToPdf, PdfError, chromiumPath } from './docs/pdf.js';
import { wabotSendDocument, wabotSend, wabotStatus, postFleetEvent } from './wabot.js';
import { addStatusEvent, undoEvent, eventReport, setEventWa, getEvent, StatusError } from './vehicleStatus.js';
import { invalidateFleet } from './fleet.js';
import { isSold } from './sold.js';
import { archivePhotos } from './vehicleMedia.js';
import { computeDiscount, syncContractDiscount, activeDiscount, dropDocDiscounts, setDecisionHandler, discountSettings, canApprove, DiscountError, KINDS as DISCOUNT_KINDS, OTHER as OTHER_REASON } from './discounts.js';

const DOCS_DIR = path.join(config.dataDir, 'docs');
const KINDS = ['contract', 'photos', 'return', 'receipt', 'addendum'];
const SIGN_DAYS = 3;
const MAX_PHOTOS = 9;
// Фото документов клиента для отчёта о выдаче в WhatsApp: лежат только до «Выдать технику» (не дольше 3 дней)
const PENDING_DIR = path.join(config.dataDir, 'pending-wa');
const PENDING_DAYS = 3;
const BANGKOK_MS = 7 * 3600000;

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    number       TEXT NOT NULL,
    contract_id  INTEGER,
    lang         TEXT NOT NULL DEFAULT 'en',
    data         TEXT NOT NULL DEFAULT '{}',
    signatures   TEXT NOT NULL DEFAULT '{}',
    sign_token   TEXT,
    sign_expires TEXT,
    sent_at      TEXT,
    sent_to      TEXT,
    created_at   TEXT NOT NULL,
    created_by   TEXT,
    created_name TEXT,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT
  );
  CREATE INDEX IF NOT EXISTS documents_contract ON documents (contract_id);
  CREATE UNIQUE INDEX IF NOT EXISTS documents_token ON documents (sign_token);
  CREATE TABLE IF NOT EXISTS doc_counters (
    key TEXT PRIMARY KEY,
    n   INTEGER NOT NULL
  );
`);

// Выдача по договору: событие статуса «В аренде» / «Бронь», которое поставили из договора
if (!db.raw.prepare('PRAGMA table_info(documents)').all().some((c) => c.name === 'event_id')) db.raw.exec('ALTER TABLE documents ADD COLUMN event_id INTEGER');

const q = {
  contracts: db.raw.prepare("SELECT * FROM documents WHERE kind = 'contract' ORDER BY id DESC LIMIT ?"),
  children: db.raw.prepare('SELECT * FROM documents WHERE contract_id = ? ORDER BY id'),
  doc: db.raw.prepare('SELECT * FROM documents WHERE id = ?'),
  byToken: db.raw.prepare('SELECT * FROM documents WHERE sign_token = ?'),
  insert: db.raw.prepare(`INSERT INTO documents (kind, number, contract_id, lang, data, created_at, created_by, created_name, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  update: db.raw.prepare('UPDATE documents SET lang = ?, data = ?, signatures = ?, updated_at = ?, updated_by = ? WHERE id = ?'),
  setSignatures: db.raw.prepare('UPDATE documents SET signatures = ? WHERE id = ?'),
  setToken: db.raw.prepare('UPDATE documents SET sign_token = ?, sign_expires = ? WHERE id = ?'),
  setSent: db.raw.prepare('UPDATE documents SET sent_at = ?, sent_to = ? WHERE id = ?'),
  setEvent: db.raw.prepare('UPDATE documents SET event_id = ? WHERE id = ?'),
  remove: db.raw.prepare('DELETE FROM documents WHERE id = ?'),
  counter: db.raw.prepare('INSERT INTO doc_counters (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n')
};

export class DocError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const t3 = (en, ru, th) => ({ en, ru, th });
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const now = () => new Date().toISOString();
const bangkokNow = () => new Date(Date.now() + BANGKOK_MS).toISOString();

/* ------------------------------------------------- Что передаём и условия */

export const EQUIPMENT = {
  key_car: t3('Car key', 'Ключ', 'กุญแจรถ'),
  key_bike: t3('Motorbike key', 'Ключ', 'กุญแจรถจักรยานยนต์'),
  sealant: t3('Tyre sealant', 'Герметик для шин', 'น้ำยาปะยาง'),
  phone_holder: t3('Phone holder', 'Держатель телефона', 'ที่วางโทรศัพท์'),
  insurance: t3('Insurance document', 'Страховой полис', 'เอกสารประกันภัย'),
  helmets: t3('Helmets', 'Шлемы', 'หมวกกันน็อก'),
  tax_sticker: t3('Tax sticker', 'Налоговая наклейка', 'สติกเกอร์ภาษี'),
  mirrors: t3('Rear-view mirrors', 'Зеркала', 'กระจกมองข้าง'),
  child_seat: t3('Child seat', 'Детское кресло', 'คาร์ซีทเด็ก'),
  top_box: t3('Top box', 'Кофр', 'กล่องท้ายรถ')
};
export const EQUIPMENT_BY_TYPE = {
  car: ['key_car', 'sealant', 'phone_holder', 'insurance', 'child_seat'],
  bike: ['key_bike', 'helmets', 'phone_holder', 'insurance', 'tax_sticker', 'mirrors', 'top_box']
};
// Отмечены по умолчанию (кресло и кофр — только если дали)
const EQUIPMENT_DEFAULT_OFF = new Set(['child_seat', 'top_box']);

// Условия и штрафы — из бланков компании (позже — правка в «Настройках»)
const TERMS = {
  car: {
    penalties: [
      { ...t3('Lost key', 'Потеря ключа', 'ทำกุญแจหาย'), thb: 10000 },
      { ...t3('Damage to the key / remote', 'Повреждение ключа / пульта', 'ความเสียหายของกุญแจหรือรีโมท'), thb: 8000 },
      { ...t3('Traffic violation', 'Нарушение ПДД', 'การฝ่าฝืนกฎจราจร'), thb: 3500 },
      { ...t3('Smoking or odour in the car', 'Курение или запах в салоне', 'สูบบุหรี่หรือมีกลิ่นในรถ'), thb: 5000 },
      { ...t3('Minimum damage charge', 'Минимальная плата за повреждение', 'ค่าความเสียหายขั้นต่ำ'), thb: 3500 },
      { ...t3('Cleaning a dirty car', 'Мойка грязного автомобиля', 'ค่าทำความสะอาดรถที่สกปรก'), thb: 500 }
    ],
    rules: [
      t3('Return the car in the same condition and with the same fuel level.', 'Вернуть автомобиль в том же состоянии и с тем же уровнем топлива.', 'ต้องส่งคืนรถในสภาพเดิม และมีปริมาณน้ำมันเชื้อเพลิงเท่าเดิม'),
      t3('Alloy wheel damage: from 4,000 ฿ per wheel.', 'Повреждение литого диска — от 4 000 ฿ за колесо.', 'ล้ออัลลอยเสียหาย: เริ่มต้น 4,000 บาทต่อล้อ'),
      t3('Scratches or dents on the body: from 5,000 ฿.', 'Царапины или вмятины на кузове — от 5 000 ฿.', 'รอยขีดข่วนหรือรอยบุบบนตัวถัง: เริ่มต้น 5,000 บาท'),
      t3('Accident damage: from 20,000 ฿.', 'Повреждения в ДТП — от 20 000 ฿.', 'ความเสียหายจากอุบัติเหตุ: เริ่มต้น 20,000 บาท'),
      t3('Interior damage or stains: from 2,000 ฿.', 'Повреждения или пятна в салоне — от 2 000 ฿.', 'ความเสียหายหรือคราบเปื้อนภายในรถ: เริ่มต้น 2,000 บาท'),
      t3('A valid driving licence is required (Thai or international).', 'Нужны действующие права (тайские или международные).', 'ผู้เช่าต้องแสดงใบขับขี่ที่ยังไม่หมดอายุ (ใบขับขี่ไทยหรือใบขับขี่สากล)'),
      t3('Pets only after telling the office; the deposit is 5,000 ฿ higher.', 'Животных — только предупредив офис; залог больше на 5 000 ฿.', 'หากต้องการนำสัตว์เลี้ยงขึ้นรถ ต้องแจ้งสำนักงาน และชำระเงินมัดจำเพิ่ม 5,000 บาท')
    ]
  },
  bike: {
    penalties: [
      { ...t3('Lost key', 'Потеря ключа', 'ทำกุญแจหาย'), thb: 10000 },
      { ...t3('Motorbike damage', 'Повреждение мотоцикла', 'ความเสียหายของรถจักรยานยนต์'), thb: 5000, from: true },
      { ...t3('Traffic violation', 'Нарушение ПДД', 'การฝ่าฝืนกฎจราจร'), thb: 3500 },
      { ...t3('Accident damage', 'Повреждения в ДТП', 'ความเสียหายจากอุบัติเหตุ'), thb: 20000, from: true },
      { ...t3('Lost helmet', 'Потеря шлема', 'ทำหมวกกันน็อกหาย'), thb: 800, from: true },
      { ...t3('Lost phone holder', 'Потеря держателя телефона', 'ทำที่วางโทรศัพท์หาย'), thb: 800, from: true }
    ],
    rules: [
      t3('A valid motorbike licence (category A) is required, and a helmet must always be worn.', 'Нужны действующие права категории A, шлем обязателен.', 'ผู้เช่าต้องมีใบขับขี่รถจักรยานยนต์ที่ยังไม่หมดอายุ และต้องสวมหมวกกันน็อกทุกครั้ง'),
      t3('Theft or total loss: the renter pays the full value of the motorbike.', 'Угон, утрата или полная гибель — арендатор оплачивает полную стоимость мотоцикла.', 'ผู้เช่าต้องรับผิดชอบเต็มจำนวนกรณีรถจักรยานยนต์ถูกโจรกรรม สูญหาย หรือเสียหายสิ้นเชิง และต้องชำระมูลค่ารถเต็มจำนวน'),
      t3('The renter pays all damage, traffic fines, penalties and related costs during the rental.', 'Арендатор оплачивает все повреждения, штрафы, сборы и связанные расходы за время аренды.', 'ผู้เช่าต้องรับผิดชอบต่อความเสียหาย ค่าปรับ ค่าธรรมเนียม และค่าใช้จ่ายต่าง ๆ ที่เกิดขึ้นระหว่างระยะเวลาเช่า'),
      t3('The renter is fully liable for any accident, damage or third-party claim arising from the use of the motorbike.', 'Арендатор полностью отвечает за ДТП, ущерб и претензии третьих лиц, связанные с использованием мотоцикла.', 'ผู้เช่าต้องรับผิดชอบต่ออุบัติเหตุ ความเสียหาย หรือการเรียกร้องจากบุคคลภายนอกทั้งหมดที่เกิดจากการใช้หรือครอบครองรถในระหว่างการเช่า')
    ]
  }
};

const PHOTO_CAPTIONS = {
  front: t3('Front', 'Спереди', 'ด้านหน้า'), rear: t3('Rear', 'Сзади', 'ด้านหลัง'), left: t3('Left side', 'Слева', 'ด้านซ้าย'),
  right: t3('Right side', 'Справа', 'ด้านขวา'), dashboard: t3('Dashboard: mileage, fuel', 'Приборы: пробег, топливо', 'หน้าปัด: เลขไมล์ ระดับน้ำมัน'),
  interior: t3('Interior', 'Салон', 'ภายในรถ'), damage: t3('Existing damage', 'Имеющиеся повреждения', 'ความเสียหายที่มีอยู่'), other: t3('Photo', 'Фото', 'ภาพถ่าย')
};

const docType = (vehicleType) => (vehicleType === 'car' ? 'car' : 'bike');

/* ------------------------------------------------------------ Проверка данных */

const str = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v, min = 0, max = 1e9) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Math.round(Number(String(v).replace(/[\s,]/g, '')));
  if (!Number.isFinite(n) || n < min || n > max) throw new DocError('bad_number');
  return n;
};
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isDateTime = (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}:00Z`));
const dt = (v) => (isDateTime(v) ? v : isDate(v) ? `${v}T12:00` : null);
const fuel = (v) => Math.max(0, Math.min(8, Math.round(Number(v) || 0)));
const items = (list, max = 20) => (Array.isArray(list) ? list : []).slice(0, max)
  .map((x) => ({ text: str(x?.text, 200), thb: int(x?.thb, 0, 1e7) })).filter((x) => x.text || x.thb);

function cleanContract(data) {
  const v = data.vehicleId ? getVehicle(data.vehicleId) : null;
  const type = docType(v?.type || data.vehicleType);
  const keys = EQUIPMENT_BY_TYPE[type];
  const given = new Map((Array.isArray(data.equipment) ? data.equipment : []).map((e) => [e?.key, e]));
  const from = dt(data.from);
  const to = dt(data.to);
  if (from && to && to.slice(0, 10) < from.slice(0, 10)) throw new DocError('date_order');
  return {
    vehicleId: v?.id || null, vehicleType: v?.type || data.vehicleType || null,
    model: str(data.model, 80) || v?.model || '', plate: str(data.plate, 40) || v?.plate || '',
    color: str(data.color, 40), vin: str(data.vin, 40),
    renter: {
      name: str(data.renter?.name, 100), passport: str(data.renter?.passport, 40), nationality: str(data.renter?.nationality, 40),
      license: str(data.renter?.license, 60), phone: str(data.renter?.phone, 40), address: str(data.renter?.address, 160)
    },
    from, to, pickupPlace: str(data.pickupPlace, 80), returnPlace: str(data.returnPlace, 80),
    mileage: int(data.mileage, 0, 5e6), fuel: fuel(data.fuel),
    equipment: keys.map((key) => {
      const e = given.get(key);
      return { key, ok: e ? Boolean(e.ok) : !EQUIPMENT_DEFAULT_OFF.has(key), ...(key === 'helmets' ? { count: Math.max(0, Math.min(4, Math.round(Number(e?.count ?? 2) || 0))) } : {}) };
    }),
    perDay: int(data.perDay, 0, 1e6), total: int(data.total, 0, 1e8), deposit: int(data.deposit, 0, 1e7), paid: int(data.paid, 0, 1e8),
    payMethod: str(data.payMethod, 120), requestId: int(data.requestId, 1, 1e9),
    ...priceWithDiscount(data, from, to)
  };
}

/**
 * Цена по прайсу (baseTotal) и скидка: итог (total) и цена за сутки считает сервер.
 * Скидка — { kind: percent|amount|price, value, reason, comment }; причина обязательна,
 * «Другое» — с комментарием.
 */
function priceWithDiscount(data, from, to) {
  const baseTotal = int(data.baseTotal, 0, 1e8);
  const d = data.discount;
  if (!d || !d.kind) return { baseTotal, discount: null };
  if (!baseTotal) throw new DocError('no_base_price');
  const kind = DISCOUNT_KINDS.includes(d.kind) ? d.kind : null;
  const value = Number(String(d.value ?? '').replace(/[\s,]/g, ''));
  const reason = str(d.reason, 60);
  const comment = str(d.comment, 200);
  if (!reason) throw new DocError('reason_required');
  if (reason === OTHER_REASON && !comment) throw new DocError('comment_required');
  let final;
  try {
    ({ final } = computeDiscount(baseTotal, kind, value));
  } catch (err) {
    if (err instanceof DiscountError) throw new DocError(err.code);
    throw err;
  }
  const days = from && to ? rentalDays(from.slice(0, 10), to.slice(0, 10)) : 0;
  return { baseTotal, discount: { kind, value, reason, comment }, total: final, perDay: days ? Math.round(final / days) : null };
}

function cleanSub(kind, data, contract) {
  if (kind === 'return') {
    return {
      at: dt(data.at), mileage: int(data.mileage, 0, 5e6), fuel: fuel(data.fuel),
      equipment: contract.equipment.map((e, i) => (Array.isArray(data.equipment) ? data.equipment[i] !== false : true)),
      damages: items(data.damages), deductions: items(data.deductions), refundMethod: str(data.refundMethod, 120)
    };
  }
  if (kind === 'receipt') {
    const list = (Array.isArray(data.items) ? data.items : []).slice(0, 10).map((x) => ({
      type: ['rent', 'deposit', 'other'].includes(x?.type) ? x.type : 'other', text: str(x?.text, 200), thb: int(x?.thb, 0, 1e8)
    })).filter((x) => x.thb);
    if (!list.length) throw new DocError('receipt_empty');
    return { date: isDate(data.date) ? data.date : bangkokNow().slice(0, 10), items: list, method: str(data.method, 160) };
  }
  if (kind === 'addendum') {
    const ext = data.extension ? {
      newReturn: dt(data.extension.newReturn), perDay: int(data.extension.perDay, 0, 1e6),
      extraPrice: int(data.extension.extraPrice, 0, 1e8), paid: int(data.extension.paid, 0, 1e8)
    } : null;
    const v = data.swap?.vehicleId ? getVehicle(data.swap.vehicleId) : null;
    const swap = data.swap ? {
      vehicleId: v?.id || null, model: str(data.swap.model, 80) || v?.model || '', plate: str(data.swap.plate, 40) || v?.plate || '',
      oldMileage: int(data.swap.oldMileage, 0, 5e6), newMileage: int(data.swap.newMileage, 0, 5e6),
      oldFuel: fuel(data.swap.oldFuel), newFuel: fuel(data.swap.newFuel), reason: str(data.swap.reason, 200)
    } : null;
    if (!ext && !swap) throw new DocError('addendum_empty');
    return { date: isDate(data.date) ? data.date : bangkokNow().slice(0, 10), extension: ext, swap };
  }
  if (kind === 'photos') return { photos: (Array.isArray(data.photos) ? data.photos : []).slice(0, MAX_PHOTOS) };
  throw new DocError('bad_kind');
}

/* --------------------------------------------------------------- Хранение */

const rowData = (row) => parse(row.data, {});
const signaturesOf = (row) => parse(row.signatures, {});
const getDoc = (id) => q.doc.get(Number(id) || 0) || null;

function nextNumber(kind, contract = null) {
  const year = bangkokNow().slice(0, 4);
  if (kind === 'contract') return `JM-${year}-${String(q.counter.get(`contract:${year}`).n).padStart(4, '0')}`;
  if (kind === 'receipt') return `R-${year}-${String(q.counter.get(`receipt:${year}`).n).padStart(4, '0')}`;
  if (kind === 'addendum') return `${contract.number}/${q.counter.get(`addendum:${contract.id}`).n}`;
  return contract.number;
}

const by = (staff) => staff?.name || staff?.email || null;

export function saveDocument(body, staff) {
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) throw new DocError('bad_kind');
  const lang = LANGS.includes(body.lang) ? body.lang : 'en';
  const at = now();
  const existing = body.id ? getDoc(body.id) : null;
  if (body.id && (!existing || existing.kind !== kind)) throw new DocError('unknown_document');
  let contract = null;
  if (kind !== 'contract') {
    contract = getDoc(existing?.contract_id || body.contractId);
    if (!contract || contract.kind !== 'contract') throw new DocError('unknown_contract');
  }
  const data = kind === 'contract' ? cleanContract(body.data || {}) : cleanSub(kind, body.data || {}, rowData(contract));
  if ((kind === 'photos' || kind === 'return') && existing) data.photos = rowData(existing).photos || [];
  const json = JSON.stringify(data);
  dropContractCache();
  if (existing) {
    // Поменяли подписанный документ — подписи больше не действуют
    const changed = existing.data !== json || existing.lang !== lang;
    const signatures = changed ? {} : signaturesOf(existing);
    if (changed && Object.keys(signaturesOf(existing)).length) removeSignatureFiles(existing.id);
    q.update.run(lang, json, JSON.stringify(signatures), at, by(staff), existing.id);
    if (kind === 'contract') syncDiscount(existing.id, data, staff);
    return existing.id;
  }
  // Фото при выдаче — одно на договор
  if (kind === 'photos') {
    const found = q.children.all(contract.id).find((r) => r.kind === 'photos');
    if (found) return found.id;
  }
  const number = nextNumber(kind, contract);
  const id = Number(q.insert.run(kind, number, contract?.id || null, lang, json, at, staff?.email || null, by(staff), at, by(staff)).lastInsertRowid);
  if (kind === 'contract') syncDiscount(id, data, staff);
  return id;
}

function syncDiscount(id, data, staff) {
  const doc = getDoc(id);
  syncContractDiscount(doc, data, data.discount ? { ...data.discount, base: data.baseTotal } : null, staff);
}

/** Пока скидка ждёт одобрения — договор не подписать, не отправить, технику не выдать */
function checkNotPending(doc) {
  const contractId = doc.kind === 'contract' ? doc.id : doc.contract_id;
  if (activeDiscount(contractId)?.status === 'pending') throw new HttpError(409, 'discount_pending');
}

// Скидку отклонили — в договоре снова цена по прайсу (подписи снимаются: цена другая)
setDecisionHandler((d) => {
  if (d.status !== 'rejected') return;
  const doc = getDoc(d.docId);
  if (!doc) return;
  const data = rowData(doc);
  const days = data.from && data.to ? rentalDays(data.from.slice(0, 10), data.to.slice(0, 10)) : 0;
  const next = { ...data, discount: null, total: data.baseTotal ?? data.total, perDay: days && data.baseTotal ? Math.round(data.baseTotal / days) : data.perDay, discountRejected: { by: d.decidedBy, at: d.decidedAt } };
  removeSignatureFiles(doc.id);
  q.update.run(doc.lang, JSON.stringify(next), '{}', now(), d.decidedBy, doc.id);
  dropContractCache();
});

function removeSignatureFiles(id) {
  for (const who of ['renter', 'company']) fs.rmSync(path.join(DOCS_DIR, String(id), `sign-${who}.png`), { force: true });
}

export function deleteDocument(id, staff) {
  const doc = getDoc(id);
  if (!doc) throw new DocError('unknown_document');
  // Подписанный документ удаляет только админ
  if (Object.keys(signaturesOf(doc)).length && !can(staff, 'access.admin')) throw new DocError('signed_admin_only');
  const children = doc.kind === 'contract' ? q.children.all(doc.id) : [];
  if (children.some((c) => Object.keys(signaturesOf(c)).length) && !can(staff, 'access.admin')) throw new DocError('signed_admin_only');
  dropContractCache();
  for (const d of [...children, doc]) {
    fs.rmSync(path.join(DOCS_DIR, String(d.id)), { recursive: true, force: true });
    if (d.kind === 'contract') dropDocDiscounts(d.id);
    q.remove.run(d.id);
  }
}

/* ------------------------------------------------------ Данные для шаблона */

const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const fmtDT = (v) => (v ? `${fmtDate(v.slice(0, 10))} ${v.slice(11, 16)}` : '');

function equipmentItems(type, list) {
  return list.map((e) => {
    const base = EQUIPMENT[e.key] || { en: e.key, ru: e.key, th: '' };
    const label = e.key === 'helmets' ? t3(`${base.en}: ${e.count ?? 0}`, `${base.ru}: ${e.count ?? 0}`, `${base.th} ${e.count ?? 0} ใบ`) : base;
    return { ...label, ok: Boolean(e.ok) };
  });
}

function lateText(plan, actual, lang) {
  if (!plan || !actual) return '';
  const min = Math.round((Date.parse(`${actual}:00Z`) - Date.parse(`${plan}:00Z`)) / 60000);
  if (min <= 15) return '';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const u = lang === 'ru' ? ['дн', 'ч', 'мин'] : ['d', 'h', 'min'];
  return [d ? `${d} ${u[0]}` : '', h ? `${h} ${u[1]}` : '', m ? `${m} ${u[2]}` : ''].filter(Boolean).join(' ');
}

function signaturesForRender(doc) {
  const out = {};
  for (const [who, s] of Object.entries(signaturesOf(doc))) {
    try {
      const png = fs.readFileSync(path.join(DOCS_DIR, String(doc.id), `sign-${who}.png`));
      out[who] = { png: `data:image/png;base64,${png.toString('base64')}`, at: fmtDT(s.at) };
    } catch { /* файла нет — подписи нет */ }
  }
  return out;
}

function photoSrc(docId, file) {
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(path.join(DOCS_DIR, String(docId), file)).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Документ → данные для шаблона (договор + свои поля документа) */
function renderData(doc) {
  const contractRow = doc.kind === 'contract' ? doc : getDoc(doc.contract_id);
  const c = rowData(contractRow);
  const own = rowData(doc);
  const type = docType(c.vehicleType);
  const lang = doc.lang;
  const days = c.from && c.to ? rentalDays(c.from.slice(0, 10), c.to.slice(0, 10)) : '';
  const d = {
    no: doc.number, contractNo: contractRow.number, date: fmtDate(own.date || contractRow.created_at.slice(0, 10)),
    staff: doc.created_name || '', lang,
    renter: c.renter || {},
    vehicle: { type, model: c.model, plate: c.plate, color: c.color, vin: c.vin },
    handover: { mileage: c.mileage, fuel: c.fuel, equipment: equipmentItems(type, c.equipment || []) },
    penalties: TERMS[type].penalties, rules: TERMS[type].rules,
    period: { from: fmtDT(c.from), to: fmtDT(c.to), pickupPlace: c.pickupPlace, returnPlace: c.returnPlace },
    money: { days, perDay: c.perDay, total: c.total, deposit: c.deposit, paid: c.paid },
    signatures: signaturesForRender(doc)
  };
  // Скидка: цена по прайсу и строка «Скидка» (причину клиенту не показываем); не одобрена — «черновик»
  const disc = c.discount ? activeDiscount(contractRow.id) : null;
  if (disc && disc.status !== 'rejected') {
    d.money.base = c.baseTotal;
    d.money.discount = { percent: disc.percent, off: disc.off };
    if (disc.status === 'pending') d.draft = true;
  }
  if (doc.kind === 'contract') d.date = fmtDate(bangkokOf(contractRow.created_at));
  if (doc.kind === 'photos') {
    d.date = fmtDate(bangkokOf(contractRow.created_at));
    d.photos = (own.photos || []).map((p) => ({ src: photoSrc(doc.id, p.file), caption: (PHOTO_CAPTIONS[p.caption] || PHOTO_CAPTIONS.other)[lang], at: fmtDT(p.at) }));
  }
  if (doc.kind === 'return') {
    d.return = { ...own, at: fmtDT(own.at), date: fmtDate(own.at?.slice(0, 10) || ''), late: lateText(c.to, own.at, lang), refundMethod: own.refundMethod };
  }
  if (doc.kind === 'receipt') {
    d.date = fmtDate(own.date);
    d.receipt = {
      method: own.method,
      items: own.items.map((x) => {
        if (x.type === 'rent') {
          const per = c.perDay ? ` × ${new Intl.NumberFormat('en-US').format(c.perDay)} ฿` : '';
          return { ...t3(`Rent: ${days} days${per}`, `Аренда: ${days} сут.${per}`, `ค่าเช่า: ${days} วัน${per.replace('฿', 'บาท')}`), thb: x.thb };
        }
        if (x.type === 'deposit') return { ...t3('Deposit (refundable)', 'Залог (возвращается)', 'เงินมัดจำ (คืนได้)'), thb: x.thb, deposit: true };
        return { text: x.text || '—', thb: x.thb };
      })
    };
  }
  if (doc.kind === 'addendum') {
    d.date = fmtDate(own.date);
    const ext = own.extension;
    d.addendum = {
      extension: ext ? {
        newReturn: fmtDT(ext.newReturn), perDay: ext.perDay, extraPrice: ext.extraPrice, paid: ext.paid,
        extraDays: ext.newReturn && c.to ? Math.max(0, rentalDays(c.to.slice(0, 10), ext.newReturn.slice(0, 10)) - 1) : ''
      } : null,
      swap: own.swap
    };
  }
  return d;
}

const bangkokOf = (iso) => new Date(Date.parse(iso) + BANGKOK_MS).toISOString().slice(0, 10);

export async function documentPdf(doc) {
  if (!chromiumPath()) throw new DocError('pdf_unavailable');
  try {
    return await htmlToPdf(renderDocument(doc.kind, renderData(doc), doc.lang));
  } catch (err) {
    if (err instanceof PdfError) throw new DocError(err.code);
    throw err;
  }
}

const fileName = (doc) => {
  const c = doc.kind === 'contract' ? doc : getDoc(doc.contract_id);
  const name = { contract: 'Contract', photos: 'Photos', return: 'Return', receipt: 'Receipt', addendum: 'Addendum' }[doc.kind];
  return `JetMobility_${name}_${(doc.kind === 'receipt' ? doc.number : c.number).replace(/[^\w-]+/g, '-')}.pdf`;
};

/* ----------------------------------------------------------------- Подписи */

const MAX_SIGN_BYTES = 400 * 1024;

function saveSignature(doc, who, png, via) {
  if (!['renter', 'company'].includes(who)) throw new DocError('bad_signer');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(png || ''));
  const buffer = m ? Buffer.from(m[1], 'base64') : null;
  // PNG: подпись 0x89 'PNG'
  if (!buffer || buffer.length < 200 || buffer.length > MAX_SIGN_BYTES || buffer.readUInt32BE(0) !== 0x89504e47) throw new DocError('bad_signature');
  const dir = path.join(DOCS_DIR, String(doc.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `sign-${who}.png`), buffer);
  const sigs = signaturesOf(doc);
  sigs[who] = { at: bangkokNow().slice(0, 16), via };
  q.setSignatures.run(JSON.stringify(sigs), doc.id);
}

const signBase = () => (process.env.SIGN_BASE_URL || `https://${config.site.jetmobilityHosts.find((h) => !h.startsWith('www.') && h.includes('.')) || 'jetmobility.org'}`).replace(/\/+$/, '');

/* ------------------------------------------- Договор к аренде (для «Парка», CRM) */

const allContracts = db.raw.prepare("SELECT id, number, data, created_at FROM documents WHERE kind = 'contract' ORDER BY id DESC");
const keyOfPlate = (plate) => String(plate || '').replace(/\D/g, '');
// Договоры с разобранными данными — на несколько секунд (в «Парке» их ищут для каждой машины)
let contractCache = null;
const contractRows = () => {
  if (!contractCache || Date.now() - contractCache.at > 5000) contractCache = { at: Date.now(), rows: allContracts.all().map((row) => ({ row, d: rowData(row) })) };
  return contractCache.rows;
};
const dropContractCache = () => { contractCache = null; };

/**
 * Договор, который относится к аренде или брони техники: ссылка из события
 * (docId) или договор этой техники, чьи даты пересекаются с from–to (последний).
 */
export function contractFor(plate, from, to, docId = null) {
  if (docId) {
    const row = getDoc(docId);
    if (row?.kind === 'contract') return contractBrief(row);
  }
  const key = keyOfPlate(plate);
  if (!key) return null;
  for (const { row, d } of contractRows()) {
    if (keyOfPlate(d.plate) !== key || !d.from || !d.to) continue;
    const a = d.from.slice(0, 10);
    const b = d.to.slice(0, 10);
    if ((!to || a <= to) && (!from || b >= from)) return contractBrief(row);
  }
  return null;
}

/** Договоры клиента (по телефону или имени) — для карточки клиента */
export function contractsOfClient(phones = [], name = '') {
  const keys = new Set(phones.map((p) => String(p || '').replace(/\D/g, '').slice(-9)).filter((p) => p.length >= 8));
  const nm = String(name || '').trim().toLowerCase();
  const out = [];
  for (const { row, d } of contractRows()) {
    const phone = String(d.renter?.phone || '').replace(/\D/g, '').slice(-9);
    if ((phone && keys.has(phone)) || (nm && nm.length > 3 && String(d.renter?.name || '').trim().toLowerCase() === nm)) out.push(contractBrief(row));
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Клиенты из прошлых договоров по имени, телефону или номеру паспорта — данные из последнего
 * договора каждого (паспорт, права, адрес): чтобы не вписывать их заново
 */
export function contractRenters(query, limit = 10) {
  const text = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const qd = text.replace(/\D/g, '');
  const compact = text.replace(/\s/g, '');
  if (text.length < 2) return [];
  const seen = new Set();
  const out = [];
  for (const { row, d } of contractRows()) {
    const r = d.renter || {};
    const name = String(r.name || '').toLowerCase();
    const hit = (name && name.includes(text)) || (qd.length >= 3 && String(r.phone || '').replace(/\D/g, '').includes(qd))
      || (compact.length >= 4 && String(r.passport || '').toLowerCase().replace(/\s/g, '').includes(compact));
    if (!hit) continue;
    const key = String(r.phone || '').replace(/\D/g, '').slice(-9) || name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: r.name || '', phone: r.phone || '', passport: r.passport || '', nationality: r.nationality || '', license: r.license || '', address: r.address || '',
      contract: { id: row.id, number: row.number, from: d.from || null }
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Договор целиком — для «＋ Операция»: номер, язык, данные, оборудование с подписями */
export function contractById(id) {
  const row = getDoc(id);
  if (!row || row.kind !== 'contract') return null;
  const d = rowData(row);
  return {
    id: row.id, number: row.number, lang: row.lang, data: d,
    returned: q.children.all(row.id).some((x) => x.kind === 'return'),
    equipment: (d.equipment || []).map((e) => ({ key: e.key, ok: Boolean(e.ok), label: EQUIPMENT[e.key] || { en: e.key, ru: e.key, th: '' } }))
  };
}

/** Фото (JPEG) к документу «Фото при выдаче» или к акту возврата: [{ buffer, caption }] → сколько добавлено */
export function addDocPhotos(docId, photos, staff) {
  const doc = getDoc(docId);
  if (!doc || !['photos', 'return'].includes(doc.kind)) return 0;
  const data = rowData(doc);
  data.photos = data.photos || [];
  let n = 0;
  for (const p of photos) {
    if (data.photos.length >= MAX_PHOTOS) break;
    if (!p?.buffer || p.buffer.length < 1000 || p.buffer[0] !== 0xff || p.buffer[1] !== 0xd8) continue;
    const file = `photo-${crypto.randomBytes(6).toString('hex')}.jpg`;
    fs.mkdirSync(path.join(DOCS_DIR, String(doc.id)), { recursive: true });
    fs.writeFileSync(path.join(DOCS_DIR, String(doc.id), file), p.buffer);
    data.photos.push({ file, caption: PHOTO_CAPTIONS[p.caption] ? p.caption : 'other', at: bangkokNow().slice(0, 16) });
    n++;
  }
  if (n) {
    // Фото техники — и в архив её служебной карточки
    const contract = getDoc(doc.contract_id);
    const vehicle = contract ? getVehicle(rowData(contract).vehicleId) : null;
    if (vehicle) archivePhotos(vehicle, photos.filter((p) => p?.buffer).slice(0, n), { kind: doc.kind === 'return' ? 'return' : 'issue', ref: contract.number, staff });
    // Новое фото — подписи снимаем (подписывали без него)
    const signed = Object.keys(signaturesOf(doc)).length > 0;
    if (signed) removeSignatureFiles(doc.id);
    q.update.run(doc.lang, JSON.stringify(data), signed ? '{}' : (doc.signatures || '{}'), now(), by(staff), doc.id);
  }
  return n;
}

/** Фото документов клиента — до отчёта о выдаче в WhatsApp (потом удаляются) */
export function savePendingPhotos(contractId, buffers) {
  const dir = path.join(PENDING_DIR, String(Number(contractId) || 0));
  let n = 0;
  for (const b of buffers) {
    if (!Buffer.isBuffer(b) || b.length < 1000 || b[0] !== 0xff || b[1] !== 0xd8) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`), b);
    n++;
  }
  return n;
}
function takePendingPhotos(contractId) {
  const dir = path.join(PENDING_DIR, String(contractId));
  let files = [];
  try { files = fs.readdirSync(dir).sort(); } catch { return []; }
  const out = files.map((f) => { try { return fs.readFileSync(path.join(dir, f)); } catch { return null; } }).filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
/** Невыданные дольше 3 дней — фото документов удаляем */
function cleanupPending() {
  let dirs = [];
  try { dirs = fs.readdirSync(PENDING_DIR); } catch { return; }
  for (const d of dirs) {
    const full = path.join(PENDING_DIR, d);
    try { if (Date.now() - fs.statSync(full).mtimeMs > PENDING_DAYS * 86400000) fs.rmSync(full, { recursive: true, force: true }); } catch { /* дальше */ }
  }
}
setInterval(cleanupPending, 3600000).unref();

/** Фото «при выдаче» договора (файлы) — к отчёту о выдаче */
function contractPhotoBuffers(contractId) {
  const doc = q.children.all(contractId).find((r) => r.kind === 'photos');
  if (!doc) return [];
  return (rowData(doc).photos || []).map((p) => { try { return fs.readFileSync(path.join(DOCS_DIR, String(doc.id), p.file)); } catch { return null; } }).filter(Boolean);
}

/** POST /api/staff/docs/pending-photo?contract= — фото документа (JPEG) для отчёта о выдаче в WhatsApp */
export async function docsPendingPhoto(staff, req, res, url) {
  needEdit(staff);
  const contract = getDoc(url.searchParams.get('contract'));
  if (!contract || contract.kind !== 'contract') throw new HttpError(404, 'unknown_contract');
  const buffer = await readBody(req, 6 * 1024 * 1024);
  sendJson(res, 200, { saved: savePendingPhotos(contract.id, [buffer]) });
}

/** Документ по id: { id, kind, number, contractId } или null */
export function docBrief(id) {
  const row = getDoc(id);
  return row ? { id: row.id, kind: row.kind, number: row.number, contractId: row.contract_id || row.id } : null;
}

function contractBrief(row) {
  const d = rowData(row);
  return { id: row.id, number: row.number, name: d.renter?.name || '', phone: d.renter?.phone || '', model: d.model, plate: d.plate, from: d.from, to: d.to, discount: discountBrief(activeDiscount(row.id)) };
}

/* ------------------------------------------------------------- WhatsApp */

const CAPTION = {
  contract: t3('Your rental agreement', 'Ваш договор аренды', 'สัญญาเช่าของคุณ'),
  photos: t3('Photos at pick-up', 'Фото при выдаче', 'ภาพถ่ายขณะส่งมอบรถ'),
  return: t3('Vehicle return report', 'Акт возврата', 'บันทึกการคืนรถ'),
  receipt: t3('Payment receipt', 'Квитанция об оплате', 'ใบเสร็จรับเงิน'),
  addendum: t3('Addendum to your agreement', 'Дополнение к договору', 'บันทึกเพิ่มเติมท้ายสัญญา')
};

async function sendToClient(doc, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw new DocError('bad_phone');
  const pdf = await documentPdf(doc);
  const caption = `Jet Mobility — ${CAPTION[doc.kind][doc.lang] || CAPTION[doc.kind].en} ${doc.number}`;
  await wabotSendDocument(digits, fileName(doc), pdf, caption);
  q.setSent.run(now(), `+${digits}`, doc.id);
  return `+${digits}`;
}

/* ------------------------------------------------------------- Маршруты */

const needView = (staff) => { if (!can(staff, 'docs.view') && !can(staff, 'docs.edit')) throw new HttpError(403, 'no_section_access'); };
const needEdit = (staff) => { if (!can(staff, 'docs.edit')) throw new HttpError(403, 'read_only'); };

async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DocError || err instanceof DiscountError) throw new HttpError(400, err.code);
    throw err;
  }
}

const discountBrief = (d) => (d ? { id: d.id, percent: d.percent, off: d.off, status: d.status, reason: d.reason, by: d.by, decidedBy: d.decidedBy } : null);

function issuedOf(row) {
  const e = row.event_id ? getEvent(row.event_id) : null;
  if (!e || e.undone_at) return null;
  return { eventId: e.id, kind: e.kind, from: e.date_from, to: e.date_to, at: e.at, by: e.by_name || e.by_email, wa: e.wa_status };
}

const summary = (row) => {
  const data = rowData(row);
  const sigs = signaturesOf(row);
  return {
    issued: row.kind === 'contract' ? issuedOf(row) : undefined,
    discount: row.kind === 'contract' ? discountBrief(activeDiscount(row.id)) : undefined,
    id: row.id, kind: row.kind, number: row.number, lang: row.lang, createdAt: row.created_at, by: row.created_name,
    signed: { renter: sigs.renter || null, company: sigs.company || null },
    sentAt: row.sent_at, sentTo: row.sent_to, photos: row.kind === 'photos' || row.kind === 'return' ? (data.photos || []).length : undefined
  };
};

export async function docsList(staff, req, res, url) {
  needView(staff);
  const qtext = String(url.searchParams.get('q') || '').toLowerCase().trim().slice(0, 60);
  const rows = q.contracts.all(qtext ? 2000 : 200).filter((r) => {
    if (!qtext) return true;
    const d = rowData(r);
    return [r.number, d.renter?.name, d.renter?.phone, d.plate, d.model].some((v) => String(v || '').toLowerCase().includes(qtext));
  }).slice(0, 200);
  const status = wabotStatus();
  sendJson(res, 200, {
    canEdit: can(staff, 'docs.edit'),
    pdfReady: Boolean(chromiumPath()),
    wabotConnected: status.connected === true || status.status === 'connected',
    contracts: rows.map((r) => {
      const d = rowData(r);
      return {
        ...summary(r), client: d.renter?.name || '', phone: d.renter?.phone || '', model: d.model, plate: d.plate,
        from: d.from, to: d.to, total: d.total, children: q.children.all(r.id).map(summary)
      };
    })
  });
}

export async function docsOne(staff, req, res, url) {
  needView(staff);
  const doc = getDoc(url.searchParams.get('id'));
  if (!doc) throw new HttpError(404, 'unknown_document');
  const contract = doc.kind === 'contract' ? doc : getDoc(doc.contract_id);
  sendJson(res, 200, {
    doc: { ...summary(doc), contractId: contract.id, contractNumber: contract.number, data: rowData(doc), signLink: doc.sign_token && doc.sign_expires > now() ? `${signBase()}/sign/${doc.sign_token}` : null, signExpires: doc.sign_expires },
    contract: { ...summary(contract), data: rowData(contract), discountFull: activeDiscount(contract.id) },
    children: q.children.all(contract.id).map(summary)
  });
}

/** Подсказка для формы: техника из «Парка», цена на даты из «Прайса», клиент из заявки */
export async function docsPrefill(staff, req, res, url) {
  needView(staff);
  const out = { vehicles: listVehicles().map((v) => ({ id: v.id, plate: v.plate, brand: v.brand, model: v.model, type: v.type, color: v.color, vin: v.vin, mileage: v.mileage })) };
  out.equipment = Object.fromEntries(Object.entries(EQUIPMENT_BY_TYPE).map(([t, keys]) => [t, keys.map((k) => ({ key: k, ...EQUIPMENT[k], off: EQUIPMENT_DEFAULT_OFF.has(k) }))]));
  out.photoCaptions = Object.entries(PHOTO_CAPTIONS).map(([key, l]) => ({ key, ...l }));
  const ds = discountSettings();
  out.discounts = { reasons: ds.reasons, other: OTHER_REASON, approvePct: ds.approvePct, canApprove: canApprove(staff) };
  const vehicle = getVehicle(url.searchParams.get('vehicleId'));
  const from = String(url.searchParams.get('from') || '').slice(0, 10);
  const to = String(url.searchParams.get('to') || '').slice(0, 10);
  if (vehicle && isDate(from) && isDate(to) && to >= from) {
    const { pricing } = await getFleet();
    const quote = quotePlate(pricing, plateKey(vehicle.plate), from, to);
    out.quote = { days: rentalDays(from, to), ...(quote || {}) };
  }
  const request = url.searchParams.get('requestId') ? db.getRequest(url.searchParams.get('requestId')) : null;
  if (request) {
    out.request = {
      id: request.id, name: request.client_name || '', phone: request.client_phone || (request.client_chat_id || '').split('@')[0].replace(/\D/g, ''),
      from: request.date_from, to: request.date_to, model: request.model, type: request.vehicle_type, lang: request.lang === 'ru' ? 'ru' : 'en'
    };
  }
  sendJson(res, 200, out);
}

export async function docsSave(staff, req, res) {
  needEdit(staff);
  const body = await readJson(req, 64 * 1024);
  sendJson(res, 200, { id: await call(() => saveDocument(body, staff)) });
}

export async function docsDelete(staff, req, res) {
  needEdit(staff);
  const { id } = await readJson(req);
  await call(() => deleteDocument(id, staff));
  sendJson(res, 200, { ok: true });
}

export async function docsPdf(staff, req, res, url) {
  needView(staff);
  const doc = getDoc(url.searchParams.get('id'));
  if (!doc) throw new HttpError(404, 'unknown_document');
  const pdf = await call(() => documentPdf(doc));
  res.writeHead(200, {
    'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
    'Content-Disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${fileName(doc)}"`
  });
  res.end(pdf);
}

export async function docsSign(staff, req, res) {
  needEdit(staff);
  const { id, who, png } = await readJson(req, MAX_SIGN_BYTES * 2);
  const doc = getDoc(id);
  if (!doc) throw new HttpError(404, 'unknown_document');
  checkNotPending(doc);
  await call(() => saveSignature(doc, String(who), png, 'screen'));
  console.log(`Document ${doc.number} (${doc.kind}) signed by ${who} on screen, staff ${staff.email}`);
  sendJson(res, 200, { ok: true });
}

export async function docsUnsign(staff, req, res) {
  needEdit(staff);
  const { id, who } = await readJson(req);
  const doc = getDoc(id);
  if (!doc) throw new HttpError(404, 'unknown_document');
  const sigs = signaturesOf(doc);
  delete sigs[who];
  fs.rmSync(path.join(DOCS_DIR, String(doc.id), `sign-${who}.png`), { force: true });
  q.setSignatures.run(JSON.stringify(sigs), doc.id);
  sendJson(res, 200, { ok: true });
}

const LINK_TEXT = {
  en: (title, number, url) => `Jet Mobility: please sign «${title}» ${number}. Open the link, check the document and sign with your finger:\n${url}\nThe link works for ${SIGN_DAYS} days.`,
  ru: (title, number, url) => `Jet Mobility: пожалуйста, подпишите «${title}» ${number}. Откройте ссылку, проверьте документ и распишитесь пальцем:\n${url}\nСсылка действует ${SIGN_DAYS} дня.`
};

/** Ссылка клиенту на подпись (3 дня); send — сразу отправить её в WhatsApp клиента */
export async function docsLink(staff, req, res) {
  needEdit(staff);
  const { id, send } = await readJson(req);
  const doc = getDoc(id);
  if (!doc) throw new HttpError(404, 'unknown_document');
  checkNotPending(doc);
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + SIGN_DAYS * 86400000).toISOString();
  q.setToken.run(token, expires, doc.id);
  const link = `${signBase()}/sign/${token}`;
  let sentTo = null;
  if (send) {
    const contract = doc.kind === 'contract' ? doc : getDoc(doc.contract_id);
    const digits = String(rowData(contract).renter?.phone || '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) throw new HttpError(400, 'bad_phone');
    const type = docType(rowData(contract).vehicleType);
    await wabotSend(digits, (LINK_TEXT[doc.lang] || LINK_TEXT.en)(docTitle(doc.kind, type, doc.lang), doc.number, link));
    sentTo = `+${digits}`;
  }
  sendJson(res, 200, { url: link, expiresAt: expires, sentTo });
}

/** PDF документа — клиенту в WhatsApp (номер компании) */
export async function docsSend(staff, req, res) {
  needEdit(staff);
  const { id, phone } = await readJson(req);
  const doc = getDoc(id);
  if (!doc) throw new HttpError(404, 'unknown_document');
  checkNotPending(doc);
  const contract = doc.kind === 'contract' ? doc : getDoc(doc.contract_id);
  const to = await call(() => sendToClient(doc, phone || rowData(contract).renter?.phone));
  console.log(`Document ${doc.number} (${doc.kind}) sent to WhatsApp ${to.slice(0, -4).replace(/\d/g, '•')}${to.slice(-4)} by ${staff.email}`);
  sendJson(res, 200, { ok: true, to });
}

/* --------------------------------------- Выдача техники по договору (статус) */

/**
 * POST /api/staff/docs/issue { id } — по договору ставим статус техники: выдача сегодня
 * («В аренде» до даты возврата) или бронь на даты договора, с клиентом; событие — в группу.
 * Подтверждение спрашивает портал; отменить — /docs/unissue.
 */
export async function docsIssue(staff, req, res) {
  needEdit(staff);
  const { id } = await readJson(req);
  const doc = getDoc(id);
  if (!doc || doc.kind !== 'contract') throw new HttpError(404, 'unknown_contract');
  if (issuedOf(doc)) throw new HttpError(409, 'already_issued');
  checkNotPending(doc);
  const c = rowData(doc);
  const vehicle = c.vehicleId ? getVehicle(c.vehicleId) : null;
  if (!vehicle || isSold(vehicle.plate)) throw new HttpError(400, 'no_vehicle');
  if (!c.to) throw new HttpError(400, 'date_required');
  const today = bangkokNow().slice(0, 10);
  const from = (c.from || '').slice(0, 10);
  const kind = from && from > today ? 'reserve' : 'rent';
  let event;
  try {
    event = addStatusEvent(vehicle, { kind, from, to: c.to.slice(0, 10), clientName: c.renter?.name, clientPhone: c.renter?.phone, note: doc.number, docId: doc.id }, staff);
  } catch (err) {
    if (err instanceof StatusError) throw new HttpError(400, err.code);
    throw err;
  }
  q.setEvent.run(event.id, doc.id);
  invalidateFleet();
  const name = vehicle.clientModel || `${vehicle.brand} ${vehicle.model}`.trim();
  // В группу — отчёт и фото: техника при выдаче и документы клиента (документы потом удаляются)
  const wa = await postFleetEvent(eventReport(event, name), [...contractPhotoBuffers(doc.id), ...takePendingPhotos(doc.id)]);
  setEventWa(event.id, wa.status, wa.error || null);
  console.log(`Contract ${doc.number}: ${vehicle.plate} set «${kind}» by ${staff.email}`);
  sendJson(res, 200, { ok: true, kind, wa: wa.status });
}

/** POST /api/staff/docs/unissue { id } — отменить выдачу по договору (ошибка): статус как до неё */
export async function docsUnissue(staff, req, res) {
  needEdit(staff);
  const { id } = await readJson(req);
  const doc = getDoc(id);
  const issued = doc ? issuedOf(doc) : null;
  if (!issued) throw new HttpError(404, 'not_issued');
  const e = undoEvent(issued.eventId, staff);
  q.setEvent.run(null, doc.id);
  invalidateFleet();
  // В группу — что выдачу отменили (с той же меткой портала: журнал это не считает)
  const vehicle = getVehicle(rowData(doc).vehicleId);
  const name = vehicle ? (vehicle.clientModel || `${vehicle.brand} ${vehicle.model}`.trim()) : '';
  const wa = await postFleetEvent(`Cancelled\n#${e.plate} ${name}`.trim() + `\n${doc.number}\n[portal #${e.id} · ${staff.name || staff.email}]`);
  sendJson(res, 200, { ok: true, wa: wa.status });
}

/* ----------------------------------------------------- Фото при выдаче */

export async function docsPhotoUpload(staff, req, res, url) {
  needEdit(staff);
  const contract = getDoc(url.searchParams.get('contract'));
  if (!contract || contract.kind !== 'contract') throw new HttpError(404, 'unknown_contract');
  const caption = PHOTO_CAPTIONS[url.searchParams.get('caption')] ? url.searchParams.get('caption') : 'other';
  const buffer = await readBody(req, 6 * 1024 * 1024);
  if (buffer.length < 1000 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new HttpError(400, 'bad_photo');
  const id = saveDocument({ kind: 'photos', contractId: contract.id, lang: contract.lang, data: {} }, staff);
  const doc = getDoc(id);
  const data = rowData(doc);
  data.photos = data.photos || [];
  if (data.photos.length >= MAX_PHOTOS) throw new HttpError(400, 'too_many_photos');
  const file = `photo-${crypto.randomBytes(6).toString('hex')}.jpg`;
  fs.mkdirSync(path.join(DOCS_DIR, String(doc.id)), { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, String(doc.id), file), buffer);
  data.photos.push({ file, caption, at: bangkokNow().slice(0, 16) });
  const vehicle = getVehicle(rowData(contract).vehicleId);
  if (vehicle) archivePhotos(vehicle, [{ buffer, caption }], { kind: 'issue', ref: contract.number, staff });
  // Новое фото — подписи приложения снимаем (подписывали без него)
  if (Object.keys(signaturesOf(doc)).length) removeSignatureFiles(doc.id);
  q.update.run(doc.lang, JSON.stringify(data), '{}', now(), by(staff), doc.id);
  sendJson(res, 200, { id: doc.id, count: data.photos.length });
}

export async function docsPhotoGet(staff, req, res, url) {
  needView(staff);
  const doc = getDoc(url.searchParams.get('id'));
  const photo = doc?.kind === 'photos' || doc?.kind === 'return' ? rowData(doc).photos?.[Number(url.searchParams.get('i'))] : null;
  if (!photo) throw new HttpError(404, 'unknown_photo');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
  fs.createReadStream(path.join(DOCS_DIR, String(doc.id), photo.file)).on('error', () => res.end()).pipe(res);
}

export async function docsPhotoDelete(staff, req, res) {
  needEdit(staff);
  const { id, index } = await readJson(req);
  const doc = getDoc(id);
  if (!doc || doc.kind !== 'photos') throw new HttpError(404, 'unknown_document');
  const data = rowData(doc);
  const [removed] = (data.photos || []).splice(Number(index), 1);
  if (!removed) throw new HttpError(404, 'unknown_photo');
  fs.rmSync(path.join(DOCS_DIR, String(doc.id), removed.file), { force: true });
  if (Object.keys(signaturesOf(doc)).length) removeSignatureFiles(doc.id);
  q.update.run(doc.lang, JSON.stringify(data), '{}', now(), by(staff), doc.id);
  sendJson(res, 200, { ok: true });
}

/* ------------------------------------------------- Подпись клиентом по ссылке */

const signLimiter = rateLimiter(60 * 60 * 1000, 60);

function docByToken(token) {
  const doc = /^[\w-]{20,60}$/.test(String(token || '')) ? q.byToken.get(String(token)) : null;
  return doc && doc.sign_expires > now() ? doc : null;
}

const SIGN_TEXT = {
  en: { title: 'Sign the document', open: 'Open the document (PDF)', agree: 'I have read the document and agree to its terms.', hint: 'Sign with your finger in the box below.', clear: 'Clear', sign: 'Sign', done: 'Thank you! The document is signed.', sent: 'A copy will come to your WhatsApp.', download: 'Download PDF', expired: 'This link is no longer valid. Please ask Jet Mobility for a new one.', already: 'The document is already signed.', failed: 'Could not save the signature. Please try again.', empty: 'Please sign in the box first.', mustAgree: 'Please tick that you agree.' },
  ru: { title: 'Подписать документ', open: 'Открыть документ (PDF)', agree: 'С документом ознакомлен(а), с условиями согласен(на).', hint: 'Распишитесь пальцем в рамке ниже.', clear: 'Стереть', sign: 'Подписать', done: 'Спасибо! Документ подписан.', sent: 'Копия придёт вам в WhatsApp.', download: 'Скачать PDF', expired: 'Ссылка больше не действует. Попросите в Jet Mobility новую.', already: 'Документ уже подписан.', failed: 'Не удалось сохранить подпись. Попробуйте ещё раз.', empty: 'Сначала распишитесь в рамке.', mustAgree: 'Отметьте, что вы согласны.' }
};

const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function signPage(doc, token) {
  const lang = doc?.lang === 'ru' ? 'ru' : 'en';
  const T = SIGN_TEXT[lang];
  if (!doc) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Jet Mobility</title>
      <style>body{font-family:system-ui,sans-serif;margin:0;padding:32px 16px;background:#f3f6f9;color:#0f1b2a;text-align:center}</style></head>
      <body><p>${escHtml(SIGN_TEXT.en.expired)}</p><p>${escHtml(SIGN_TEXT.ru.expired)}</p></body></html>`;
  }
  const contract = doc.kind === 'contract' ? doc : getDoc(doc.contract_id);
  const c = rowData(contract);
  const type = docType(c.vehicleType);
  const signed = Boolean(signaturesOf(doc).renter);
  const facts = [[doc.number], [c.renter?.name], [`${c.model || ''} ${c.plate ? `· ${c.plate}` : ''}`], [c.from && c.to ? `${fmtDT(c.from)} – ${fmtDT(c.to)}` : '']]
    .map(([v]) => v && String(v).trim()).filter(Boolean).map((v) => `<li>${escHtml(v)}</li>`).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta name="robots" content="noindex">
<title>Jet Mobility — ${escHtml(T.title)}</title>
<style>
:root{--bg:#f3f6f9;--card:#fff;--text:#0f1b2a;--muted:#5d6b7c;--line:#dde3ea;--brand:#b85200}
@media (prefers-color-scheme:dark){:root{--bg:#0a1420;--card:#111e2d;--text:#e6edf5;--muted:#93a3b8;--line:#22344a;--brand:#ff8a1f}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text)}
main{max-width:560px;margin:0 auto;padding:16px;display:grid;gap:12px}.card{background:var(--card);border-radius:14px;padding:16px;display:grid;gap:10px}
h1{margin:0;font-size:20px}ul{margin:0;padding-left:18px;color:var(--muted)}a.btn,button{font:inherit;border-radius:10px;padding:12px 16px;border:1px solid var(--line);background:var(--card);color:var(--text);text-align:center;text-decoration:none;cursor:pointer}
.primary{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:700}canvas{width:100%;height:200px;border:2px dashed var(--line);border-radius:12px;background:#fff;touch-action:none}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}label{display:flex;gap:10px;align-items:flex-start}.msg{margin:0;color:#c0362c}.ok{color:#16a34a;font-weight:700}
</style></head><body><main>
<div class="card"><h1>${escHtml(docTitle(doc.kind, type, lang))}</h1><ul>${facts}</ul>
<a class="btn" href="/sign/${escHtml(token)}/pdf" target="_blank" rel="noopener">📄 ${escHtml(T.open)}</a></div>
<div class="card" id="box">${signed ? `<p class="ok">${escHtml(T.already)}</p><a class="btn" href="/sign/${escHtml(token)}/pdf?download=1">${escHtml(T.download)}</a>` : `
<p>${escHtml(T.hint)}</p><canvas id="pad"></canvas>
<div class="row"><button type="button" id="clear">${escHtml(T.clear)}</button></div>
<label><input type="checkbox" id="agree"> <span>${escHtml(T.agree)}</span></label>
<button type="button" class="primary" id="sign">${escHtml(T.sign)}</button><p class="msg" id="msg"></p>`}</div>
<p style="color:var(--muted);font-size:13px;text-align:center">${escHtml(COMPANY.name)} · ${escHtml(COMPANY.phone)}</p>
</main>${signed ? '' : `<script>
(function(){var c=document.getElementById('pad'),x=c.getContext('2d'),msg=document.getElementById('msg'),drawn=false,down=false,last=null;
function fit(){var r=c.getBoundingClientRect(),d=window.devicePixelRatio||1;c.width=r.width*d;c.height=r.height*d;x.setTransform(d,0,0,d,0,0);x.lineWidth=2.4;x.lineCap='round';x.lineJoin='round';x.strokeStyle='#0b1f6b';drawn=false}
fit();window.addEventListener('resize',fit);
function pt(e){var r=c.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
c.addEventListener('pointerdown',function(e){down=true;last=pt(e);c.setPointerCapture(e.pointerId);msg.textContent=''});
c.addEventListener('pointermove',function(e){if(!down)return;var p=pt(e);x.beginPath();x.moveTo(last.x,last.y);x.lineTo(p.x,p.y);x.stroke();last=p;drawn=true});
c.addEventListener('pointerup',function(){down=false});c.addEventListener('pointercancel',function(){down=false});
document.getElementById('clear').onclick=function(){x.clearRect(0,0,c.width,c.height);drawn=false};
document.getElementById('sign').onclick=function(){
if(!drawn){msg.textContent=${JSON.stringify(T.empty)};return}
if(!document.getElementById('agree').checked){msg.textContent=${JSON.stringify(T.mustAgree)};return}
var b=this;b.disabled=true;msg.textContent='';
fetch('/api/public/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)},png:c.toDataURL('image/png')})})
.then(function(r){if(!r.ok)throw new Error();return r.json()}).then(function(){
document.getElementById('box').innerHTML='<p class="ok">'+${JSON.stringify(escHtml(T.done))}+'</p><p>'+${JSON.stringify(escHtml(T.sent))}+'</p><a class="btn" href="/sign/'+${JSON.stringify(escHtml(token))}+'/pdf?download=1">'+${JSON.stringify(escHtml(T.download))}+'</a>'})
.catch(function(){b.disabled=false;msg.textContent=${JSON.stringify(T.failed)}})}})();
</script>`}</body></html>`;
}

/** /sign/<token> и /sign/<token>/pdf — страница подписи для клиента (без входа) */
export async function handleSignPage(req, res, url) {
  const [, , token, extra] = url.pathname.split('/');
  if (!signLimiter.hit(clientIp(req))) return sendJson(res, 429, { error: 'too_many_requests' });
  const doc = docByToken(token);
  if (extra === 'pdf') {
    if (!doc) return sendJson(res, 404, { error: 'not_found' });
    try {
      const pdf = await documentPdf(doc);
      res.writeHead(200, {
        'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
        'Content-Disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${fileName(doc)}"`
      });
      return res.end(pdf);
    } catch (err) {
      console.error('Sign page PDF failed:', err.message);
      return sendJson(res, 503, { error: 'pdf_unavailable' });
    }
  }
  if (extra) return sendJson(res, 404, { error: 'not_found' });
  res.writeHead(doc ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  return res.end(signPage(doc, token));
}

/** POST /api/public/sign { token, png } — клиент расписался; PDF с подписью — ему в WhatsApp */
export async function publicSign(req, res) {
  if (!signLimiter.hit(clientIp(req))) throw new HttpError(429, 'too_many_requests');
  const { token, png } = await readJson(req, MAX_SIGN_BYTES * 2);
  const doc = docByToken(token);
  if (!doc) throw new HttpError(404, 'link_expired');
  if (signaturesOf(doc).renter) throw new HttpError(409, 'already_signed');
  checkNotPending(doc);
  await call(() => saveSignature(doc, 'renter', png, 'link'));
  console.log(`Document ${doc.number} (${doc.kind}) signed by the client via link`);
  const fresh = getDoc(doc.id);
  const contract = fresh.kind === 'contract' ? fresh : getDoc(fresh.contract_id);
  const phone = rowData(contract).renter?.phone;
  // Копию с подписью — клиенту в WhatsApp (если бот на связи); не получилось — сотрудник отправит из портала
  if (phone) sendToClient(fresh, phone).catch((err) => console.error(`Signed ${fresh.number} not sent to WhatsApp: ${err.code || err.message}`));
  sendJson(res, 200, { ok: true });
}
