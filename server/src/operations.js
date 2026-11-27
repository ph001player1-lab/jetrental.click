/**
 * ============================================================================
 * «＋ Операция» — сотрудник загружает фото (и пишет пару слов), ИИ понимает, что
 * произошло, портал предлагает готовое действие; человек проверяет и подтверждает.
 * ============================================================================
 *   Выдача  — новый договор с данными с фото («Документы»), дальше «Выдать технику»
 *   Возврат — акт возврата к договору (пробег, топливо, повреждения, удержания,
 *             фото), статус «Свободна», пробег в карточку
 *   Замена  — дополнение к договору, старая техника «Свободна», новая «В аренде»
 *   Сервис  — «В ремонт» / «Из ремонта» / ТО / пробег; чек ремонта — расход
 *   Расход  — чек: сумма, статья, техника → «Финансы» и кабинет инвестора
 *
 * Операция — черновик на сервере: фото с телефона сразу видны на компьютере того же
 * сотрудника; распознать, поправить поля и подтвердить можно с любого устройства.
 * Фото черновика лежат закрыто и удаляются, когда операцию подтвердили или удалили
 * (фото техники переходят в документы, чек — к расходу); незавершённые — через 7 дней.
 *
 * Статусы — как из «Парка» (с отчётом в рабочую группу WhatsApp), документы — как
 * из «Документов». Права: выдача, возврат, замена — «Парк» и «Документы» (меняет);
 * сервис — «Парк» (меняет); расход — «Парк» (меняет) или «Финансы».
 *
 *   GET  /api/staff/op/drafts                 — мои открытые операции
 *   POST /api/staff/op/draft { hint }         — новая · GET /api/staff/op/draft?id=
 *   POST /api/staff/op/draft/photo?id=        — фото (JPEG) · GET …/photo?id=&i= · POST …/photo/delete
 *   POST /api/staff/op/draft/update           — записка, вид, поля формы
 *   POST /api/staff/op/draft/recognize        — ИИ по фото и записке
 *   POST /api/staff/op/draft/apply            — подтвердить · POST …/cancel · POST …/attach (выдача → договор)
 *   GET  /api/staff/op/vehicle?id=            — техника, её статус и договор
 *   GET  /api/staff/expenses?from=&to= · GET /api/staff/expenses/photo?id= · POST /api/staff/expenses/delete
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson, readJson, readBody } from './http.js';
import { can, roleOf } from './roles.js';
import { todayIso } from './dates.js';
import { getVehicle, updateVehicleStats, setRepair } from './fleetStore.js';
import { isSold } from './sold.js';
import { invalidateFleet, getPortalSnapshot } from './fleet.js';
import { addStatusEvent, eventReport, setEventWa, invalidateStatuses, addCheck, StatusError } from './vehicleStatus.js';
import { postFleetEvent } from './wabot.js';
import { saveDocument, contractFor, contractById, addDocPhotos, docBrief, DocError } from './documents.js';
import { currentRates } from './finance.js';
import { recognizeOperation, OP_KINDS, SERVICE_ACTIONS, EXPENSE_CATEGORIES, PAY_METHODS } from './ai/operation.js';
import { AiError } from './ai/claude.js';
import { vehicleByPhoto, carNow, contractProposal, photoList, vehicleName, dayPart, VEHICLE_CAPTION } from './ai/proposal.js';

const EXPENSES_DIR = path.join(config.dataDir, 'expenses');
const DRAFTS_DIR = path.join(config.dataDir, 'op-drafts');
const MAX_DRAFT_PHOTOS = 10;
const DRAFT_DAYS = 7;

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    amount      REAL NOT NULL,
    currency    TEXT NOT NULL,
    thb         INTEGER NOT NULL,
    category    TEXT NOT NULL,
    plate       TEXT,
    vehicle_id  INTEGER,
    method      TEXT,
    vendor      TEXT,
    note        TEXT,
    receipt     TEXT,
    by_email    TEXT,
    by_name     TEXT,
    created_at  TEXT NOT NULL,
    deleted_at  TEXT,
    deleted_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS expenses_date ON expenses (date);
  CREATE TABLE IF NOT EXISTS op_drafts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_email TEXT NOT NULL,
    hint        TEXT,
    note        TEXT,
    photos      TEXT NOT NULL DEFAULT '[]',
    proposal    TEXT,
    form        TEXT,
    status      TEXT NOT NULL DEFAULT 'open',
    result      TEXT,
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS op_drafts_staff ON op_drafts (staff_email, status);
`);

const q = {
  insert: db.raw.prepare(`INSERT INTO expenses (date, amount, currency, thb, category, plate, vehicle_id, method, vendor, note, by_email, by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  setReceipt: db.raw.prepare('UPDATE expenses SET receipt = ? WHERE id = ?'),
  byId: db.raw.prepare('SELECT * FROM expenses WHERE id = ?'),
  between: db.raw.prepare('SELECT * FROM expenses WHERE deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC, id DESC'),
  remove: db.raw.prepare('UPDATE expenses SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL'),
  draftNew: db.raw.prepare('INSERT INTO op_drafts (staff_email, hint, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
  draft: db.raw.prepare('SELECT * FROM op_drafts WHERE id = ?'),
  myOpen: db.raw.prepare("SELECT * FROM op_drafts WHERE staff_email = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 20"),
  oldOpen: db.raw.prepare("SELECT id FROM op_drafts WHERE status = 'open' AND updated_at < ?"),
  draftSave: db.raw.prepare('UPDATE op_drafts SET hint = ?, note = ?, photos = ?, proposal = ?, form = ?, status = ?, result = ?, version = version + 1, updated_at = ? WHERE id = ?')
};

const CATEGORY_RU = {
  fuel: 'Топливо', repair: 'Ремонт и мастерская', wash: 'Мойка', delivery: 'Доставка и такси', office: 'Офис', insurance: 'Страховки',
  tax: 'Налоги', ads: 'Реклама', it: 'IT и подписки', salary: 'Зарплата', owners: 'Выплаты владельцам машин', refunds: 'Возвраты за аренду',
  vehicles: 'Покупка машин и взносы', personal: 'Личные', other: 'Прочее'
};
const CATEGORY_EN = {
  fuel: 'Fuel', repair: 'Repair', wash: 'Wash', delivery: 'Delivery/taxi', office: 'Office', insurance: 'Insurance', tax: 'Tax', ads: 'Ads',
  it: 'IT', salary: 'Salary', owners: 'Owner payout', refunds: 'Refund', vehicles: 'Vehicle purchase', personal: 'Personal', other: 'Other'
};

const isOwnerOrAdmin = (staff) => roleOf(staff) === 'owner' || can(staff, 'access.admin');
const mayKind = (staff, kind) => {
  if (kind === 'issue' || kind === 'return' || kind === 'swap') return can(staff, 'fleet.edit') && can(staff, 'docs.edit');
  if (kind === 'service') return can(staff, 'fleet.edit');
  if (kind === 'expense') return can(staff, 'fleet.edit') || can(staff, 'finance.view');
  return false;
};
const anyKind = (staff) => OP_KINDS.some((k) => mayKind(staff, k));
/** Какие операции доступны сотруднику (для кнопки «＋ Операция») */
export const allowedOps = (staff) => OP_KINDS.filter((k) => mayKind(staff, k));

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const int = (v) => { const n = num(v); return n !== null && n >= 0 && String(v ?? '').trim() !== '' ? Math.round(n) : null; };
const fuel = (v) => (/^[0-8]$/.test(String(v ?? '')) ? Number(v) : null);
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (list) => (Array.isArray(list) ? list : []).slice(0, 20).map((x) => ({ text: text(x?.text, 200), thb: int(x?.thb) || 0 })).filter((x) => x.text || x.thb);
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const bkkNow = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);

/* ------------------------------------------------ Техника и договор */

/** Договор, по которому техника сейчас в аренде (или последний на сегодня) */
function activeContract(vehicle, holder) {
  const today = todayIso();
  const brief = holder?.kind === 'rent' ? contractFor(vehicle.plate, dayPart(holder.from) || today, dayPart(holder.to) || today, holder.docId) : contractFor(vehicle.plate, today, today);
  return brief ? contractById(brief.id) : null;
}

const contractView = (c, lang) => (c ? {
  id: c.id, number: c.number, lang: c.lang, name: c.data.renter?.name || '', phone: c.data.renter?.phone || '',
  from: c.data.from || null, to: c.data.to || null, deposit: c.data.deposit ?? null, returned: c.returned,
  vehicleId: c.data.vehicleId || null,
  equipment: c.equipment.map((e) => ({ key: e.key, given: e.ok, label: e.label[lang] || e.label.en }))
} : null);

/** Техника и что с ней: { vehicle, candidates, status, holder, renter, contract } */
async function vehicleState(read, lang) {
  const { vehicle, candidates } = vehicleByPhoto(read || {});
  if (!vehicle) return { vehicle: null, candidates, status: null, holder: null, renter: null, contract: null };
  const { car, holder, renter } = await carNow(vehicle.id);
  const full = getVehicle(vehicle.id);
  return {
    vehicle: { ...vehicle, mileage: full?.mileage ?? null }, candidates,
    status: car?.status || null, holder: holder ? { kind: holder.kind, from: dayPart(holder.from), to: dayPart(holder.to) } : null,
    renter: renter ? { name: renter.name, phone: renter.phone } : null,
    contract: contractView(activeContract(full, holder), lang)
  };
}

/** GET /api/staff/op/vehicle?id=&lang= — что с техникой сейчас (когда её выбрали вручную) */
export async function opVehicle(staff, req, res, url) {
  if (!anyKind(staff)) throw new HttpError(403, 'no_section_access');
  const v = getVehicle(url.searchParams.get('id'));
  if (!v) throw new HttpError(404, 'not_found');
  sendJson(res, 200, await vehicleState({ plate: v.plate, plateNumber: v.plate.replace(/\D/g, ''), model: vehicleName(v) }, url.searchParams.get('lang') === 'en' ? 'en' : 'ru'));
}

/* ------------------------------------------------------ Черновики */

const draftDir = (id) => path.join(DRAFTS_DIR, String(id));
const removeDraftFiles = (id) => fs.rmSync(draftDir(id), { recursive: true, force: true });

function draftView(row) {
  return {
    id: row.id, hint: row.hint || null, note: row.note || '', status: row.status, version: row.version,
    photos: parse(row.photos, []).map((p, i) => ({ i, at: p.at, key: String(p.file).replace(/\W/g, '').slice(-12) })),
    proposal: parse(row.proposal, null), form: parse(row.form, null), result: parse(row.result, null),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

/** Свой черновик (чужие не видны) */
function myDraft(staff, id, open = true) {
  const row = q.draft.get(Number(id) || 0);
  if (!row || row.staff_email !== staff.email) throw new HttpError(404, 'unknown_draft');
  if (open && row.status !== 'open') throw new HttpError(409, 'draft_closed');
  return row;
}

function saveDraft(row, changes) {
  const next = { ...row, ...changes };
  q.draftSave.run(next.hint || null, next.note || null, next.photos, next.proposal ?? null, next.form ?? null, next.status, next.result ?? null, new Date().toISOString(), row.id);
  return q.draft.get(row.id);
}

/** Незавершённые старше недели — удаляем вместе с фото */
function cleanupDrafts() {
  const old = q.oldOpen.all(new Date(Date.now() - DRAFT_DAYS * 86400000).toISOString());
  for (const { id } of old) {
    const row = q.draft.get(id);
    saveDraft(row, { status: 'cancelled', photos: '[]' });
    removeDraftFiles(id);
  }
  if (old.length) console.log(`Operation drafts: ${old.length} old draft(s) removed`);
}
setInterval(() => { try { cleanupDrafts(); } catch (err) { console.error('Draft cleanup failed:', err.message); } }, 3600000).unref();

export async function opDrafts(staff, req, res) {
  if (!anyKind(staff)) throw new HttpError(403, 'no_section_access');
  cleanupDrafts();
  sendJson(res, 200, { drafts: q.myOpen.all(staff.email).map(draftView), allowed: allowedOps(staff) });
}

export async function opDraftCreate(staff, req, res) {
  if (!anyKind(staff)) throw new HttpError(403, 'no_section_access');
  const body = await readJson(req);
  const hint = OP_KINDS.includes(body.hint) ? body.hint : null;
  const at = new Date().toISOString();
  const id = Number(q.draftNew.run(staff.email, hint, text(body.note, 1000) || null, at, at).lastInsertRowid);
  sendJson(res, 200, { draft: draftView(q.draft.get(id)) });
}

export async function opDraftGet(staff, req, res, url) {
  sendJson(res, 200, { draft: draftView(myDraft(staff, url.searchParams.get('id'), false)) });
}

/** POST /api/staff/op/draft/photo?id= — тело запроса: JPEG (телефон уменьшает фото сам) */
export async function opDraftPhotoAdd(staff, req, res, url) {
  const row = myDraft(staff, url.searchParams.get('id'));
  const photos = parse(row.photos, []);
  if (photos.length >= MAX_DRAFT_PHOTOS) throw new HttpError(400, 'too_many_photos');
  const buffer = await readBody(req, 6 * 1024 * 1024);
  if (buffer.length < 1000 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new HttpError(400, 'bad_photo');
  const file = `p-${crypto.randomBytes(6).toString('hex')}.jpg`;
  fs.mkdirSync(draftDir(row.id), { recursive: true });
  fs.writeFileSync(path.join(draftDir(row.id), file), buffer);
  photos.push({ file, at: new Date().toISOString() });
  sendJson(res, 200, { draft: draftView(saveDraft(row, { photos: JSON.stringify(photos) })) });
}

export async function opDraftPhotoGet(staff, req, res, url) {
  const row = myDraft(staff, url.searchParams.get('id'), false);
  const p = parse(row.photos, [])[Number(url.searchParams.get('i'))];
  if (!p) throw new HttpError(404, 'unknown_photo');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
  fs.createReadStream(path.join(draftDir(row.id), p.file)).on('error', () => res.end()).pipe(res);
}

export async function opDraftPhotoDelete(staff, req, res) {
  const { id, index } = await readJson(req);
  const row = myDraft(staff, id);
  const photos = parse(row.photos, []);
  const [removed] = photos.splice(Number(index), 1);
  if (!removed) throw new HttpError(404, 'unknown_photo');
  fs.rmSync(path.join(draftDir(row.id), removed.file), { force: true });
  // Номера фото сдвинулись — распознанное по фото пересчитаем при следующем «Распознать»
  sendJson(res, 200, { draft: draftView(saveDraft(row, { photos: JSON.stringify(photos) })) });
}

/** Записка, вид операции, поля формы — с любого устройства; version — защита от перезаписи чужой правки */
export async function opDraftUpdate(staff, req, res) {
  const body = await readJson(req, 256 * 1024);
  const row = myDraft(staff, body.id);
  if (body.version && Number(body.version) !== row.version) throw new HttpError(409, 'draft_changed');
  const changes = {};
  if (body.note !== undefined) changes.note = text(body.note, 1000);
  if (body.hint !== undefined) changes.hint = OP_KINDS.includes(body.hint) ? body.hint : null;
  if (body.form !== undefined) changes.form = body.form ? JSON.stringify(body.form).slice(0, 200000) : null;
  sendJson(res, 200, { draft: draftView(saveDraft(row, changes)) });
}

export async function opDraftCancel(staff, req, res) {
  const { id } = await readJson(req);
  const row = myDraft(staff, id);
  removeDraftFiles(row.id);
  saveDraft(row, { status: 'cancelled', photos: '[]' });
  sendJson(res, 200, { ok: true });
}

const draftImages = (row) => parse(row.photos, []).map((p) => {
  try { return { type: 'image/jpeg', data: fs.readFileSync(path.join(draftDir(row.id), p.file)).toString('base64') }; } catch { return null; }
}).filter(Boolean);
const draftBuffers = (row) => parse(row.photos, []).map((p) => {
  try { return fs.readFileSync(path.join(draftDir(row.id), p.file)); } catch { return null; }
});

/* --------------------------------------------------------- Распознать */

/** Предложение по прочитанному: что за операция, техника, договор, поля */
async function proposalFor(r, kind, count, staff, lang) {
  const out = {
    kind, allowed: allowedOps(staff),
    unsure: Array.isArray(r.unsure) ? [...new Set(r.unsure.map(String))] : [],
    warnings: Array.isArray(r.warnings) ? r.warnings.map(String).slice(0, 8) : [],
    photos: photoList(r.photos, count)
  };
  if (kind === 'issue') {
    out.contract = await contractProposal(r, count);
    return out;
  }
  Object.assign(out, await vehicleState(r.vehicle, lang));
  out.fields = {
    mileage: String(r.vehicle?.mileage || '').replace(/\D/g, ''), fuel: fuel(r.vehicle?.fuel),
    damages: money(r.damages), deductions: money(r.deductions),
    refundAmount: String(r.refund?.amount || '').replace(/[^\d.]/g, ''), refundMethod: text(r.refund?.method, 120),
    serviceAction: SERVICE_ACTIONS.includes(r.service?.action) ? r.service.action : '', serviceNote: text(r.service?.note, 300),
    expense: {
      amount: String(r.expense?.amount || '').replace(/[^\d.]/g, ''), currency: /^[A-Z]{3}$/.test(String(r.expense?.currency || '')) ? r.expense.currency : 'THB',
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.expense?.date || '')) ? r.expense.date : todayIso(),
      category: EXPENSE_CATEGORIES.includes(r.expense?.category) ? r.expense.category : '', vendor: text(r.expense?.vendor, 80),
      method: PAY_METHODS.includes(r.expense?.method) ? r.expense.method : '', note: text(r.expense?.note, 300)
    }
  };
  if (kind === 'swap') {
    const n = await vehicleState(r.newVehicle, lang);
    out.newVehicle = n.vehicle;
    out.newCandidates = n.candidates;
    out.newStatus = n.status;
    out.fields.newMileage = String(r.newVehicle?.mileage || '').replace(/\D/g, '');
    out.fields.newFuel = fuel(r.newVehicle?.fuel);
  }
  if ((kind === 'return' || kind === 'swap') && out.vehicle && !out.contract) out.warnings.push('Договор на эту технику не нашёл: будет только статус «Свободна».');
  if (kind === 'return' && out.contract?.returned) out.warnings.push(`По договору ${out.contract.number} акт возврата уже есть.`);
  return out;
}

/** Поля формы по предложению — их правят на любом устройстве, а подтверждают как есть */
function formFrom(p) {
  const f = p.fields || {};
  const receipt = (p.photos || []).find((x) => x.kind === 'receipt')?.index;
  return {
    kind: p.kind, vehicleId: p.vehicle?.id || null, contractId: p.contract?.id || null, newVehicleId: p.newVehicle?.id || null,
    at: bkkNow(), mileage: f.mileage || '', fuel: f.fuel ?? '', newMileage: f.newMileage || '', newFuel: f.newFuel ?? '',
    damages: f.damages || [], deductions: f.deductions || [],
    refundMethod: [f.refundAmount ? `${f.refundAmount} ฿` : '', f.refundMethod].filter(Boolean).join(' · '),
    equipment: (p.contract?.equipment || []).map((e) => e.given),
    action: f.serviceAction || '', note: f.serviceNote || '', reason: '',
    expense: { ...(f.expense || {}), amount: f.expense?.amount || '', vehicleId: p.vehicle?.id || null },
    receipt: receipt ?? (p.kind === 'expense' ? 0 : null)
  };
}

export async function opDraftRecognize(staff, req, res) {
  const body = await readJson(req);
  const row = myDraft(staff, body.id);
  const images = draftImages(row);
  if (!images.length && !row.note) throw new HttpError(400, 'no_photos');
  let ai;
  try {
    ai = await recognizeOperation(images, row.note, row.hint, staff, todayIso());
  } catch (err) {
    if (err instanceof AiError) throw new HttpError(['ai_no_key', 'ai_limit'].includes(err.code) ? 409 : 502, err.code);
    throw err;
  }
  const r = ai.result;
  const kind = OP_KINDS.includes(r.kind) ? r.kind : row.hint || 'unknown';
  const proposal = { ...(await proposalFor(r, kind, images.length, staff, body.lang === 'en' ? 'en' : 'ru')), model: ai.model, usd: Math.round(ai.usd * 1000) / 1000 };
  const form = kind === 'unknown' ? null : formFrom(proposal);
  sendJson(res, 200, { draft: draftView(saveDraft(row, { proposal: JSON.stringify(proposal), form: form ? JSON.stringify(form) : null })) });
}

/** POST /api/staff/op/draft/manual { id, kind } — без ИИ: пустая форма выбранной операции */
export async function opDraftManual(staff, req, res) {
  const body = await readJson(req);
  const row = myDraft(staff, body.id);
  const kind = OP_KINDS.includes(body.kind) ? body.kind : null;
  if (!kind || kind === 'issue') throw new HttpError(400, 'bad_kind');
  const proposal = { kind, allowed: allowedOps(staff), unsure: [], warnings: [], photos: [], manual: true };
  sendJson(res, 200, { draft: draftView(saveDraft(row, { hint: kind, proposal: JSON.stringify(proposal), form: JSON.stringify(formFrom(proposal)) })) });
}

/* --------------------------------------------------------- Применить */

/** Статус техники — как из «Парка»: событие, ремонт в карточке, отчёт в группу */
async function setStatus(vehicle, input, staff) {
  let event;
  try {
    event = addStatusEvent(vehicle, input, staff);
  } catch (err) {
    if (err instanceof StatusError) throw new HttpError(400, err.code);
    throw err;
  }
  if (input.kind === 'service') setRepair(vehicle.id, 'in_repair', staff.email);
  if (input.kind === 'free' && vehicle.repair !== 'ok') setRepair(vehicle.id, 'ok', staff.email);
  invalidateFleet();
  invalidateStatuses();
  const after = (await getPortalSnapshot().catch(() => null))?.cars.find((c) => c.vehicleId === vehicle.id);
  if (after?.needsCheck) addCheck(after, 'portal', staff, 'статус поставлен из «＋ Операция»');
  const wa = await postFleetEvent(eventReport(event, vehicle.clientModel || vehicleName(vehicle)));
  setEventWa(event.id, wa.status, wa.error || null);
  return { type: 'status', kind: input.kind, plate: vehicle.plate, wa: wa.status };
}

const docCall = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DocError) throw new HttpError(400, err.code);
    throw err;
  }
};

/** Расход: в базу (бат по курсу), чек — файлом; в группу — строкой «Expense:» с меткой портала */
async function addExpense(e, staff, receipt = null) {
  const amount = num(e.amount);
  if (!(amount > 0)) throw new HttpError(400, 'bad_amount');
  const currency = /^[A-Z]{3}$/.test(String(e.currency || '')) ? e.currency : 'THB';
  const rate = currency === 'THB' ? 1 : currentRates().rates[currency];
  if (!rate) throw new HttpError(400, 'bad_currency');
  const category = EXPENSE_CATEGORIES.includes(e.category) ? e.category : 'other';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) && e.date <= todayIso() ? e.date : todayIso();
  const vehicle = e.vehicleId ? getVehicle(e.vehicleId) : null;
  const method = PAY_METHODS.includes(e.method) ? e.method : null;
  const thb = Math.round(amount * rate);
  const id = Number(q.insert.run(date, amount, currency, thb, category, vehicle?.plate || null, vehicle?.id || null, method,
    text(e.vendor, 80) || null, text(e.note, 300) || null, staff.email, staff.name || staff.email, new Date().toISOString()).lastInsertRowid);
  if (receipt) {
    fs.mkdirSync(EXPENSES_DIR, { recursive: true });
    fs.writeFileSync(path.join(EXPENSES_DIR, `${id}.jpg`), receipt);
    q.setReceipt.run(`${id}.jpg`, id);
  }
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount);
  const line = [`Expense: ${fmt} ${currency}`, CATEGORY_EN[category], vehicle ? `${vehicle.clientModel || vehicleName(vehicle)} #${vehicle.plate}` : null].filter(Boolean).join(' — ')
    + (method ? ` (${method})` : '');
  const wa = await postFleetEvent([line, text(e.note, 200) || null, `[portal expense #${id} · ${staff.name || staff.email}]`].filter(Boolean).join('\n'));
  console.log(`Expense #${id}: ${fmt} ${currency} (${thb} THB) ${category}${vehicle ? ` #${vehicle.plate}` : ''} by ${staff.email}`);
  return { type: 'expense', id, thb, category, wa: wa.status };
}

function needVehicle(id) {
  const v = getVehicle(id);
  if (!v || isSold(v.plate)) throw new HttpError(400, 'no_vehicle');
  return v;
}

const VEHICLE_KINDS = new Set(Object.keys(VEHICLE_CAPTION));

/** Выполнить операцию по форме; buffers — фото черновика по порядку, kinds — что на каждом (от ИИ) */
async function applyOp(kind, f, buffers, kinds, staff) {
  const done = [];
  const today = todayIso();
  const receiptOf = () => (Number.isInteger(f.receipt) && buffers[f.receipt] ? buffers[f.receipt] : null);

  if (kind === 'return') {
    const vehicle = needVehicle(f.vehicleId);
    const contract = f.contractId ? contractById(f.contractId) : null;
    if (f.contractId && !contract) throw new HttpError(400, 'unknown_contract');
    if (contract) {
      const id = docCall(() => saveDocument({
        kind: 'return', contractId: contract.id, lang: contract.lang,
        data: {
          at: f.at || bkkNow(), mileage: f.mileage, fuel: f.fuel,
          equipment: Array.isArray(f.equipment) ? f.equipment : undefined,
          damages: money(f.damages), deductions: money(f.deductions), refundMethod: text(f.refundMethod, 120)
        }
      }, staff));
      // К акту — фото техники (документы клиента и чеки — нет)
      const photos = buffers.map((buffer, i) => ({ buffer, kind: kinds[i] })).filter((p) => p.buffer && (!p.kind || VEHICLE_KINDS.has(p.kind) || p.kind === 'other'))
        .map((p) => ({ buffer: p.buffer, caption: VEHICLE_CAPTION[p.kind] || 'other' }));
      const added = addDocPhotos(id, photos, staff);
      done.push({ type: 'doc', kind: 'return', ...docBrief(id), photos: added });
    }
    const { holder } = await carNow(vehicle.id);
    if (holder || vehicle.repair !== 'ok') done.push(await setStatus(vehicle, { kind: 'free', note: contract ? contract.number : 'Return' }, staff));
    if (updateVehicleStats(vehicle.id, { mileage: int(f.mileage) }, staff.email)) done.push({ type: 'mileage', plate: vehicle.plate, mileage: int(f.mileage) });
  }

  if (kind === 'swap') {
    const contract = contractById(f.contractId);
    if (!contract) throw new HttpError(400, 'unknown_contract');
    const oldV = needVehicle(f.vehicleId);
    const newV = needVehicle(f.newVehicleId);
    if (oldV.id === newV.id) throw new HttpError(400, 'same_vehicle');
    const to = dayPart(contract.data.to);
    if (!to) throw new HttpError(400, 'date_required');
    const id = docCall(() => saveDocument({
      kind: 'addendum', contractId: contract.id, lang: contract.lang,
      data: { date: today, swap: { vehicleId: newV.id, oldMileage: f.mileage, newMileage: f.newMileage, oldFuel: f.fuel, newFuel: f.newFuel, reason: text(f.reason, 200) } }
    }, staff));
    const add = docBrief(id);
    done.push({ type: 'doc', kind: 'addendum', ...add });
    done.push(await setStatus(oldV, { kind: 'free', note: `${contract.number} · ${add.number}` }, staff));
    done.push(await setStatus(newV, { kind: 'rent', to, clientName: contract.data.renter?.name, clientPhone: contract.data.renter?.phone, note: `${contract.number} · ${add.number}`, docId: contract.id }, staff));
    updateVehicleStats(oldV.id, { mileage: int(f.mileage) }, staff.email);
    updateVehicleStats(newV.id, { mileage: int(f.newMileage) }, staff.email);
  }

  if (kind === 'service') {
    const vehicle = needVehicle(f.vehicleId);
    const action = SERVICE_ACTIONS.includes(f.action) ? f.action : null;
    if (!action) throw new HttpError(400, 'bad_action');
    const note = text(f.note, 300);
    if (action === 'to_repair') done.push(await setStatus(vehicle, { kind: 'service', note }, staff));
    if (action === 'from_repair') done.push(await setStatus(vehicle, { kind: 'free', note: note || 'Из ремонта' }, staff));
    const stats = updateVehicleStats(vehicle.id, action === 'maintenance'
      ? { mileage: int(f.mileage), serviceDate: today, serviceKm: int(f.mileage) }
      : { mileage: int(f.mileage) }, staff.email);
    if (stats) done.push({ type: action === 'maintenance' ? 'maintenance' : 'mileage', plate: vehicle.plate, mileage: int(f.mileage) });
    if (num(f.expense?.amount) > 0) {
      done.push(await addExpense({ ...f.expense, category: f.expense.category || 'repair', vehicleId: vehicle.id, note: f.expense.note || note }, staff, receiptOf()));
    }
  }

  if (kind === 'expense') done.push(await addExpense(f.expense || {}, staff, receiptOf()));

  if (!done.length) throw new HttpError(400, 'nothing_to_do');
  return done;
}

/** POST /api/staff/op/draft/apply { id, form } — подтвердить: выполнить, черновик закрыть, фото удалить */
export async function opDraftApply(staff, req, res) {
  const body = await readJson(req, 256 * 1024);
  const row = myDraft(staff, body.id);
  const form = body.form || parse(row.form, null);
  const kind = OP_KINDS.includes(form?.kind) ? form.kind : null;
  if (!kind || kind === 'issue') throw new HttpError(400, 'bad_kind');
  if (!mayKind(staff, kind)) throw new HttpError(403, 'read_only');
  const proposal = parse(row.proposal, {});
  const kinds = [];
  for (const p of proposal.photos || []) kinds[p.index] = p.kind;
  const done = await applyOp(kind, form, draftBuffers(row), kinds, staff);
  removeDraftFiles(row.id);
  const saved = saveDraft(row, { status: 'done', form: JSON.stringify(form), result: JSON.stringify(done), photos: '[]' });
  console.log(`Operation «${kind}» #${row.id} by ${staff.email}: ${done.map((d) => d.type).join(', ')}`);
  sendJson(res, 200, { ok: true, kind, done, draft: draftView(saved) });
}

/**
 * POST /api/staff/op/draft/attach { id, contractId, photos: [{ index, caption }] } — выдача: договор
 * создан из черновика; фото техники — в «Фото при выдаче», черновик закрыт, остальные фото удалены
 */
export async function opDraftAttach(staff, req, res) {
  const body = await readJson(req);
  const row = myDraft(staff, body.id);
  if (!can(staff, 'docs.edit')) throw new HttpError(403, 'read_only');
  const contract = contractById(body.contractId);
  if (!contract) throw new HttpError(400, 'unknown_contract');
  const buffers = draftBuffers(row);
  const captions = new Set(Object.values(VEHICLE_CAPTION));
  const list = (Array.isArray(body.photos) ? body.photos : []).filter((p) => captions.has(p?.caption) && buffers[p.index])
    .map((p) => ({ buffer: buffers[p.index], caption: p.caption }));
  let added = 0;
  if (list.length) {
    const docId = docCall(() => saveDocument({ kind: 'photos', contractId: contract.id, lang: contract.lang, data: {} }, staff));
    added = addDocPhotos(docId, list, staff);
  }
  removeDraftFiles(row.id);
  saveDraft(row, { status: 'done', result: JSON.stringify([{ type: 'doc', kind: 'contract', id: contract.id, number: contract.number, photos: added }]), photos: '[]' });
  sendJson(res, 200, { ok: true, photos: added });
}

/* ------------------------------------------------- Расходы из портала */

const expenseView = (r) => ({
  id: r.id, date: r.date, amount: r.amount, currency: r.currency, thb: r.thb, category: r.category, label: CATEGORY_RU[r.category] || r.category,
  plate: r.plate, method: r.method, vendor: r.vendor, note: r.note, receipt: Boolean(r.receipt), by: r.by_name || r.by_email, byEmail: r.by_email, at: r.created_at
});

/** Расходы из портала за [fromMs, toMs) — для «Финансов» (по дате чека, полдень по Бангкоку) */
export function portalExpensesBetween(fromMs, toMs) {
  const day = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
  return q.between.all(day(fromMs), day(toMs - 1)).map((r) => ({
    at: Date.parse(`${r.date}T05:00:00Z`), thb: r.thb, category: r.category, plate: r.plate, method: r.method, by: r.by_name || r.by_email,
    text: [CATEGORY_RU[r.category], r.vendor, r.note].filter(Boolean).join(' — ')
  })).filter((e) => e.at >= fromMs && e.at < toMs);
}

export async function expensesList(staff, req, res, url) {
  if (!can(staff, 'finance.view') && !can(staff, 'fleet.edit')) throw new HttpError(403, 'no_section_access');
  const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '0000-01-01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '9999-12-31';
  // Без доступа к «Финансам» — только свои
  const rows = q.between.all(from, to).filter((r) => can(staff, 'finance.view') || r.by_email === staff.email);
  sendJson(res, 200, { items: rows.slice(0, 300).map(expenseView), canDelete: isOwnerOrAdmin(staff) });
}

export async function expensePhoto(staff, req, res, url) {
  const r = q.byId.get(Number(url.searchParams.get('id')) || 0);
  if (!r || !r.receipt || r.deleted_at) throw new HttpError(404, 'not_found');
  if (!can(staff, 'finance.view') && r.by_email !== staff.email) throw new HttpError(403, 'no_section_access');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
  fs.createReadStream(path.join(EXPENSES_DIR, r.receipt)).on('error', () => res.end()).pipe(res);
}

/** Удалить ошибочный расход: владелец, админ или кто внёс — в тот же день */
export async function expenseDelete(staff, req, res) {
  const { id } = await readJson(req);
  const r = q.byId.get(Number(id) || 0);
  if (!r || r.deleted_at) throw new HttpError(404, 'not_found');
  const own = r.by_email === staff.email && Date.now() - Date.parse(r.created_at) < 24 * 3600000;
  if (!isOwnerOrAdmin(staff) && !own) throw new HttpError(403, 'owner_or_admin_only');
  q.remove.run(new Date().toISOString(), staff.email, r.id);
  console.log(`Expense #${r.id} deleted by ${staff.email}`);
  sendJson(res, 200, { ok: true });
}
