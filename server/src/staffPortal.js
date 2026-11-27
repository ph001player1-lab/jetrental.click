/**
 * ============================================================================
 * API сайта сотрудников (staff.jetmobility.org)
 * ============================================================================
 * Вход без паролей: сотрудник вводит почту → на неё приходит 6-значный код
 * (действует 10 минут, 5 попыток) → после ввода кода вход действует 7 дней.
 * Пускаем только почты из колонки Email листа Users; если почту удалили —
 * доступ пропадает при следующем запросе (список обновляется раз в 2 минуты).
 *
 *   POST /api/staff/login    { email }        — отправить код
 *   POST /api/staff/verify   { email, code }  — войти (ставит cookie)
 *   POST /api/staff/logout                    — выйти
 *   GET  /api/staff/me                        — кто вошёл
 *   GET  /api/staff/fleet                     — парк из Автопроката + цены
 *   GET  /api/staff/requests                  — заявки из ботов и сайта
 *   GET  /api/staff/dashboard                 — проблемы и брони впереди (dashboard.js)
 *   /api/staff/models…                        — фото, галерея и описания моделей
 *                                               для сайта (staffCatalog.js)
 *   GET  /api/staff/server                    — нагрузка и трафик (только Admin,
 *   POST /api/staff/server/settings             serverStats.js)
 *   /api/staff/journal…                       — журнал рабочей группы WhatsApp,
 *                                               табель, сверка с WS (journal/api.js)
 *   /api/staff/wa…                            — подключение наблюдателя (Admin)
 *   /api/staff/tickets…                       — «Ошибки и предложения» (tickets.js)
 *   /api/staff/agent…                         — кабинет агента, выплаты (agent.js)
 *   /api/staff/investor…                      — кабинет инвестора, выплаты (investor.js)
 *   /api/staff/docs…                          — договоры, акты, квитанции, PDF, подписи (documents.js)
 *   /api/staff/settings…                      — «Настройки» (админ): связь, домены, ключи,
 *                                               сервисы и оплаты, модель ИИ (itSettings.js)
 * Права ролей — в roles.js.
 *
 * В базе храним только хэши кодов и сессий.
 * ============================================================================
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson, readJson, readBody, parseCookies, clientIp, rateLimiter } from './http.js';
import { findStaff, normalizeEmail, isValidEmail, adminList, isAdminEmail } from './staffUsers.js';
import { mailEnabled, sendMail } from './mail.js';
import { getWsSnapshot, wsSyncStatus } from './ws/sync.js';
import { getFleet, sheetsEnabled, plateKey, invalidateFleet, getPortalSnapshot } from './fleet.js';
import { tariffOn, quotePlate } from './pricing.js';
import { priceActive, priceView, applyChanges, revertChange, PriceError } from './price.js';
import { runImport, ImportError } from './priceImport.js';
import { todayIso } from './dates.js';
import { canEdit, listModels, saveDescription, uploadPhoto, uploadThumb, saveGallery } from './staffCatalog.js';
import { resetCatalog } from './publicApi.js';
import { collectProblems, bookingOutlook, requestStats, LIMITS } from './dashboard.js';
import { roleOf, roleNameOf, permissionsOf, can, canAny } from './roles.js';
import { accessOverview, saveRole, deleteRole, saveStaff, deleteStaff, importStaffList, AccessError } from './access.js';
import { financeReport, saveLoans } from './finance.js';
import { soldList, markSold, unmarkSold, markSoldList, isSold, SoldError } from './sold.js';
import { listVehicles, saveVehicle, deleteVehicle, fleetLog, getVehicle, setRepair, FleetError } from './fleetStore.js';
import { addStatusEvent, eventReport, setEventWa, recentEvents, invalidateStatuses, sameModel, addCheck, StatusError } from './vehicleStatus.js';
import { marketingReport, marketingDetails, saveSource, deleteSource, placeSource, saveSettings, allSources, MarketingError } from './marketing.js';
import { crmList, crmClient, saveClient, setTags, addNote, mergeClients, importClients, CrmError, clientOfReport, clientByContact } from './crm.js';
import { importCashbook } from './cashbook.js';
import { serverReport, serverStatusRoute, saveServerSettings, alertAdminsOnce } from './serverStats.js';
import { listTickets, ticketsBadge, createTicket, uploadShot, getShot, setTicketStatus, markSeen, deleteTicket } from './tickets.js';
import { agentCabinet, agentRequest, agentPayout, agentPayoutDelete } from './agent.js';
import { investorCabinet, investorPayout, investorPayoutDelete, investorList } from './investor.js';
import { g } from './groupTexts.js';
import { escapeHtml } from './format.js';
import { getJournal, fixEvent, getTimesheet, getReconcile, getMedia, importHistory } from './journal/api.js';
import { waStatus, waConfig, waPair, waLogout } from './journal/observer.js';
import { wabotPortalStatus, wabotPortalSettings, wabotPortalConfig, wabotPortalPair, wabotPortalLogout, wabotSettings, postFleetEvent } from './wabot.js';
import { groupStatusByPlate } from './journal/reconcile.js';
import { settingsRoute, settingsService, settingsServiceDelete, settingsPaid, settingsPaymentDelete, settingsAi, settingsDomainsCheck } from './itSettings.js';
import { docsList, docsOne, docsPrefill, docsSave, docsDelete, docsPdf, docsSign, docsUnsign, docsLink, docsSend, docsPhotoUpload, docsPhotoGet, docsPhotoDelete, contractFor, contractsOfClient, docsIssue, docsUnissue } from './documents.js';

const COOKIE = 'jr_staff';
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_MS = 60 * 1000;
const MAX_CODES_PER_HOUR = 5;

const loginLimiter = rateLimiter(60 * 60 * 1000, 20);
const verifyLimiter = rateLimiter(60 * 60 * 1000, 40);

/** Секрет для хэшей кодов: создаётся один раз и хранится в базе */
function authSecret() {
  let secret = db.getSetting('auth_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.setSetting('auth_secret', secret);
  }
  return secret;
}

const hmac = (value) => crypto.createHmac('sha256', authSecret()).update(value).digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

// Письмо с кодом — на языке, выбранном на сайте сотрудников
const CODE_EMAIL = {
  en: {
    subject: 'Jet Mobility staff login code: {code}',
    hi: 'Hi {name},',
    lead: 'Your Jet Mobility staff login code:',
    valid: 'It is valid for {minutes} minutes. After you sign in, access lasts {days} days.',
    ignore: 'If you did not request this code, just ignore this email.'
  },
  ru: {
    subject: 'Код входа Jet Mobility Staff: {code}',
    hi: 'Здравствуйте, {name}!',
    lead: 'Ваш код для входа на сайт сотрудников Jet Mobility:',
    valid: 'Код действует {minutes} минут. После входа доступ сохраняется {days} дней.',
    ignore: 'Если вы не запрашивали код, просто проигнорируйте это письмо.'
  },
  my: {
    subject: 'Jet Mobility Staff ဝင်ရောက်ကုဒ်: {code}',
    hi: 'မင်္ဂလာပါ {name}',
    lead: 'Jet Mobility ဝန်ထမ်း ဆိုက်သို့ ဝင်ရောက်ရန် သင့်ကုဒ်:',
    valid: 'ကုဒ်ကို {minutes} မိနစ် အသုံးပြုနိုင်သည်။ ဝင်ရောက်ပြီးနောက် {days} ရက် ဝင်ရောက်ထားနိုင်သည်။',
    ignore: 'ဤကုဒ်ကို သင် မတောင်းခဲ့ပါက ဤအီးမေးလ်ကို လျစ်လျူရှုပါ။'
  },
  th: {
    subject: 'รหัสเข้าสู่ระบบ Jet Mobility Staff: {code}',
    hi: 'สวัสดี {name}',
    lead: 'รหัสเข้าสู่ระบบเว็บไซต์พนักงาน Jet Mobility ของคุณ:',
    valid: 'รหัสใช้ได้ {minutes} นาที หลังเข้าสู่ระบบแล้วจะใช้งานได้ {days} วัน',
    ignore: 'หากคุณไม่ได้ขอรหัสนี้ ไม่ต้องทำอะไร'
  }
};

function codeEmail(code, name, lang) {
  const texts = CODE_EMAIL[lang] || CODE_EMAIL.en;
  const fill = (text, params) => text.replace(/\{(\w+)\}/g, (m, key) => params[key] ?? m);
  const params = { code, name, minutes: config.staff.codeMinutes, days: config.staff.sessionDays };
  const valid = fill(texts.valid, params);
  const text = `${fill(texts.hi, params)}\n\n${texts.lead} ${code}\n\n${valid}\n${texts.ignore}`;
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0f172a">' +
    `<p>${fill(texts.hi, { name: name.replace(/[<>&"]/g, '') })}</p>` +
    `<p>${texts.lead}</p>` +
    `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:16px 0">${code}</p>` +
    `<p>${valid}</p>` +
    `<p style="color:#64748b">${texts.ignore}</p></div>`;
  return { subject: fill(texts.subject, params), text, html };
}

async function login(req, res) {
  const { email: rawEmail, lang } = await readJson(req);
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) throw new HttpError(400, 'invalid_email');
  if (!loginLimiter.hit(clientIp(req))) throw new HttpError(429, 'too_many_requests');
  if (!mailEnabled) throw new HttpError(503, 'mail_not_configured');

  const stats = db.loginCodeStats(email, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  if (stats.last && Date.now() - Date.parse(stats.last) < RESEND_AFTER_MS) throw new HttpError(429, 'wait_a_minute');
  if (stats.count >= MAX_CODES_PER_HOUR) throw new HttpError(429, 'too_many_codes');

  const staff = await findStaff(email);
  const expiresAt = new Date(Date.now() + config.staff.codeMinutes * 60000).toISOString();
  // Ответ и лимиты одинаковые для любой почты — так нельзя подобрать почты сотрудников.
  // Для чужой почты сохраняем «пустой» код, который ничему не соответствует.
  if (!staff) {
    db.saveLoginCode(email, crypto.randomBytes(32).toString('hex'), expiresAt);
    // В журнал сервера — чтобы было видно, почему код не пришёл (почта скрыта частично)
    console.log(`Login code requested for an email not in the Users sheet: ${email.replace(/^(.).*?@/, '$1***@')}`);
  }
  if (staff) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.saveLoginCode(email, hmac(`${email}:${code}`), expiresAt);
    try {
      await sendMail({ to: email, ...codeEmail(code, staff.name || email, lang) });
    } catch (err) {
      console.error('Login code email failed:', err.message);
      alertAdminsOnce('login_mail', g('alert.loginMail', { error: escapeHtml(err.message).slice(0, 300) }))
        .catch((e) => console.error('Admin alert failed:', e.message));
      throw new HttpError(502, 'mail_failed');
    }
  }
  sendJson(res, 200, { ok: true });
}

async function verify(req, res) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').replace(/\D/g, '');
  if (!isValidEmail(email) || code.length !== 6) throw new HttpError(400, 'invalid_code');
  if (!verifyLimiter.hit(clientIp(req))) throw new HttpError(429, 'too_many_requests');

  const saved = db.latestLoginCode(email);
  if (!saved) throw new HttpError(400, 'invalid_code');
  if (saved.attempts >= MAX_ATTEMPTS) throw new HttpError(400, 'too_many_attempts');
  if (!safeEqualHex(hmac(`${email}:${code}`), saved.code_hash)) {
    db.addLoginCodeAttempt(saved.id);
    throw new HttpError(400, saved.attempts + 1 >= MAX_ATTEMPTS ? 'too_many_attempts' : 'invalid_code');
  }

  const staff = await findStaff(email);
  if (!staff) throw new HttpError(403, 'no_access');

  db.deleteLoginCodes(email);
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = config.staff.sessionDays * 86400;
  db.createStaffSession(sha256(token), email, new Date(Date.now() + maxAge * 1000).toISOString());
  sendJson(res, 200, { ok: true, user: publicUser(staff) }, { 'Set-Cookie': sessionCookie(token, maxAge) });
}

function publicUser(staff) {
  return {
    email: staff.email, name: staff.name, role: roleOf(staff), roleName: roleNameOf(staff),
    permissions: permissionsOf(staff), canEdit: canEdit(staff),
    // Агент: к какому источнику привязан его «Кабинет»
    sourceId: staff.sourceId || null,
    // Инвестор: есть ли у него кабинет инвестора
    investor: staff.investorPercent !== null && staff.investorPercent !== undefined
  };
}

/** Нет права на раздел — 403 (портал такой раздел и не показывает) */
function needAny(staff, perms) {
  if (!canAny(staff, perms)) throw new HttpError(403, 'no_section_access');
}

/** Сотрудник текущего запроса; 401, если не вошёл или доступ отозван */
async function requireStaff(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) throw new HttpError(401, 'not_signed_in');
  const tokenHash = sha256(token);
  const session = db.getStaffSession(tokenHash);
  if (!session) throw new HttpError(401, 'not_signed_in');
  const staff = await findStaff(session.email);
  if (!staff) {
    db.deleteStaffSession(tokenHash);
    throw new HttpError(401, 'no_access');
  }
  return { ...staff, sessionExpiresAt: session.expires_at };
}

async function logout(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.deleteStaffSession(sha256(token));
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}

async function me(req, res) {
  const staff = await requireStaff(req);
  sendJson(res, 200, { user: publicUser(staff), sessionExpiresAt: staff.sessionExpiresAt });
}

/**
 * Цены моделей из листа Catalog: модель → { priceFrom, perDay, perDayWeek, perDayMonth, deposit }
 * и тариф каждой машины на сегодня из сезонного прайса: id → { season, verified, tiers, deposit, overKm }
 */
async function priceData(cars) {
  if (!sheetsEnabled) return { prices: {}, tariffs: {} };
  try {
    const { catalog, pricing } = await getFleet();
    const today = todayIso();
    const tariffs = {};
    if (pricing) {
      for (const car of cars) {
        const tariff = tariffOn(pricing, plateKey(car.plate), today);
        if (tariff) tariffs[car.id] = tariff;
      }
    }
    const prices = {};
    for (const [model, entry] of catalog) {
      prices[model] = {
        priceFrom: entry.priceFrom,
        perDay: entry.pricePerDay,
        perDayWeek: entry.pricePerDayWeek,
        perDayMonth: entry.pricePerDayMonth,
        deposit: entry.deposit
      };
    }
    return { prices, tariffs };
  } catch {
    return { prices: {}, tariffs: {} };
  }
}

/**
 * Что сделать по технике: [{ code, level }] — видно в карточке, таблице «Парка» и счётчике «с проблемами».
 * WS здесь только для сверки (нет в WS, другая модель, другой статус).
 */
function vehicleIssues(car, { vehicle, entry, tariff, wsOn, today }) {
  const out = [];
  const add = (code, level, params = {}) => out.push({ code, level, ...params });
  if (car.overdue) add('overdue', 'error', { date: car.until });
  if (car.needsRepair) add('needs_repair', 'warning');
  if (priceActive() && !tariff?.tiers?.some(Boolean)) add('no_price', 'error');
  if (vehicle) {
    const byDate = vehicle.nextServiceDate && vehicle.nextServiceDate <= today;
    const byKm = vehicle.nextServiceKm && vehicle.mileage && vehicle.mileage >= vehicle.nextServiceKm;
    if (byDate || byKm) add('service_due', 'warning');
  }
  if (!entry?.photo) add('no_photo', 'warning');
  if (!entry?.description) add('no_description', 'warning');
  if (wsOn) {
    if (!car.ws) add('not_in_ws', 'warning');
    else if (!sameModel(car.ws.model, [car.wsModel, car.model])) add('model_diff', 'warning', { ws: car.ws.model });
  }
  // Портал и WS расходятся (или статус только из WS) — нужна проверка владельцем или админом
  if (car.needsCheck) add('needs_check', 'error', { portal: car.source?.kind === 'ws' ? null : car.portalStatus, ws: car.wsStatus });
  // Проверено, но в WS всё ещё другое — висит, пока WS не исправят
  else if (car.wsMismatch) add('ws_mismatch', 'warning', { ws: car.wsStatus });
  return out;
}

async function fleet(req, res) {
  // Парк нужен и обзору, и календарю. Статусы — из портала, WS — только для сверки
  const staff = await requireStaff(req);
  needAny(staff, ['fleet.view', 'calendar.view', 'overview.view']);
  const sync = wsSyncStatus();
  const ws = getWsSnapshot();
  const portal = await getPortalSnapshot().catch((err) => { console.error('Portal statuses failed:', err.message); return null; });
  const wsByPlate = new Map((ws?.cars || []).map((c) => [plateKey(c.plate), c]));
  const editFleet = can(staff, 'fleet.edit');
  const fleetView = can(staff, 'fleet.view');
  const vehicles = listVehicles().filter((v) => !isSold(v.plate));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  let cars = (portal?.cars || []).map((car) => {
    const w = wsByPlate.get(plateKey(car.plate));
    return { ...car, ws: w ? { id: w.id, status: w.status, model: w.wsModel, freeFrom: w.freeFrom } : null };
  });
  const prices = await priceData(cars);
  let catalog = new Map();
  try { catalog = (await getFleet()).catalog; } catch { /* без каталога — без проверок фото */ }
  const today = todayIso();
  const wsOn = Boolean(sync.enabled && ws);
  // Арендатор (текущая аренда или бронь): договор → клиент в событии портала → клиент отчёта группы (CRM)
  const contacts = can(staff, 'clients.view');
  const renters = fleetView ? await Promise.all(cars.map((car) => renterOf(car).catch(() => null))) : [];
  cars = cars.map((car, i) => ({
    ...car,
    renter: renters[i] ? { ...renters[i], phone: contacts ? renters[i].phone : null } : null,
    problems: fleetView ? vehicleIssues(car, { vehicle: vehicleById.get(car.vehicleId), entry: catalog.get(car.model), tariff: prices.tariffs?.[car.id], wsOn, today }) : []
  }));
  sendJson(res, 200, {
    // Данные парка — портал (всегда есть); WS — отдельно, для сверки
    enabled: true,
    error: null,
    source: 'portal',
    ws: { enabled: sync.enabled, error: sync.error, updatedAt: ws?.updatedAt || null },
    updatedAt: portal?.updatedAt || null,
    windowFrom: portal?.windowFrom || null,
    windowTo: portal?.windowTo || null,
    cars,
    canEditFleet: editFleet,
    // Менять статус вручную (позже — и менеджерам: бронь, приём машины)
    canSetStatus: editFleet,
    // Проверять расхождения портала и WS — только владелец и админ
    canCheck: editFleet,
    eventsToGroup: Boolean(wabotSettings().eventsGroup),
    // Карточки техники из портала (первоисточник) — тем, кому открыт «Парк»
    ...(fleetView ? { vehicles } : {}),
    // Архив (продана, списана, другое) — тем, кто правит парк: поправить или вернуть в парк
    // Инвесторы — для поля «Инвестор» в карточке и просмотра их кабинетов
    ...(editFleet ? { sold: soldList(), fleetLog: fleetLog(20), investors: investorList() } : {}),
    // Статус по рабочей группе WhatsApp: госномер → последний отчёт (сверка в «Журнале»)
    group: Object.fromEntries([...groupStatusByPlate()].map(([plate, g]) => [plate, { status: g.status, at: g.at, kind: g.kind }])),
    ...prices
  });
}

/** Кто арендует (или забронировал) технику: { name, phone, source, clientId, contract } или null */
async function renterOf(car) {
  const h = car.holder;
  if (!h) return null;
  const contract = contractFor(car.plate, h.from, h.to, h.docId);
  let client = null;
  if (h.client) client = await clientByContact(h.client.phone).catch(() => null);
  else if (h.src === 'group') client = await clientOfReport(h.ref).catch(() => null);
  const name = contract?.name || h.client?.name || client?.name || '';
  const phone = contract?.phone || h.client?.phone || client?.phone || '';
  if (!name && !phone) return contract ? { name: '', phone: '', source: 'contract', clientId: null, contract: { id: contract.id, number: contract.number }, kind: h.kind } : null;
  return {
    name, phone, kind: h.kind, clientId: client?.id || null,
    source: contract ? 'contract' : h.client ? 'portal' : 'group',
    contract: contract ? { id: contract.id, number: contract.number } : null
  };
}

/** POST /api/staff/fleet/check { vehicleId, choice: portal|ws, note? } — проверка расхождения (владелец, админ) */
async function fleetCheckRoute(staff, req, res) {
  if (!can(staff, 'fleet.edit')) throw new HttpError(403, 'read_only');
  const body = await readJson(req);
  const car = (await getPortalSnapshot())?.cars.find((c) => c.vehicleId === Number(body.vehicleId));
  if (!car) throw new HttpError(404, 'not_found');
  if (!car.needsCheck) throw new HttpError(409, 'nothing_to_check');
  let status;
  try {
    status = addCheck(car, body.choice, staff, body.note);
  } catch (err) {
    if (err instanceof StatusError) throw new HttpError(400, err.code);
    throw err;
  }
  invalidateFleet();
  sendJson(res, 200, { ok: true, status });
}

/**
 * POST /api/staff/fleet/status { vehicleId, kind: rent|free|reserve|service, from?, to?, note? } —
 * ручная смена статуса: событие в портале + сообщение ботом в рабочую группу (если включено)
 */
async function fleetStatusRoute(staff, req, res) {
  if (!can(staff, 'fleet.edit')) throw new HttpError(403, 'read_only');
  const body = await readJson(req);
  const vehicle = getVehicle(body.vehicleId);
  if (!vehicle || isSold(vehicle.plate)) throw new HttpError(404, 'not_found');
  let event;
  try {
    event = addStatusEvent(vehicle, body, staff);
  } catch (err) {
    if (err instanceof StatusError) throw new HttpError(400, err.code);
    throw err;
  }
  // «В ремонт» — состояние в карточке; «Свободна» снимает ремонт
  if (body.kind === 'service') setRepair(vehicle.id, 'in_repair', staff.email);
  if (body.kind === 'free' && vehicle.repair !== 'ok') setRepair(vehicle.id, 'ok', staff.email);
  invalidateFleet();
  invalidateStatuses();
  // Статус поставил владелец или админ — это и есть проверка: портал верен (WS исправят отдельно)
  const after = (await getPortalSnapshot().catch(() => null))?.cars.find((c) => c.vehicleId === vehicle.id);
  if (after?.needsCheck) addCheck(after, 'portal', staff, 'статус поставлен вручную');
  const name = vehicle.clientModel || `${vehicle.brand} ${vehicle.model}`.trim();
  const wa = await postFleetEvent(eventReport(event, name));
  setEventWa(event.id, wa.status, wa.error || null);
  sendJson(res, 200, { ok: true, event: { id: event.id, kind: event.kind }, wa: wa.status, events: recentEvents(vehicle.plate) });
}

async function requests(req, res) {
  const staff = await requireStaff(req);
  needAny(staff, ['requests.view', 'overview.view']);
  // Телефон клиента — только тем, кому открыты контакты клиентов
  const contacts = can(staff, 'clients.view');
  const rows = db.listRecentRequests(100).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    channel: r.channel,
    clientName: r.client_name,
    clientPhone: contacts ? r.client_phone : null,
    vehicleType: r.vehicle_type,
    model: r.model,
    dateFrom: r.date_from,
    dateTo: r.date_to,
    estimateThb: r.estimate_thb,
    freeUnits: r.free_units,
    comment: r.comment,
    lang: r.lang,
    status: r.status,
    takenBy: r.taken_by_name,
    takenAt: r.taken_at,
    declinedBy: r.declined_by ? r.declined_by.split('\n') : [],
    archived: Boolean(r.archived_at),
    // 'question' — клиент просил связаться с менеджером (не заявка на аренду)
    kind: r.kind || null
  }));
  // Убрать в архив или удалить тестовую — только админ
  sendJson(res, 200, { requests: rows, canManage: can(staff, 'access.admin') });
}

/* ------------------------------------------------------------- Прайс */

async function priceRoute(staff, req, res) {
  needAny(staff, ['price.view']);
  if (!priceActive()) return sendJson(res, 200, { active: false, canEdit: can(staff, 'price.edit') });
  const { units, catalog } = await getFleet();
  sendJson(res, 200, {
    active: true,
    canEdit: can(staff, 'price.edit'),
    ...priceView(units, (model) => catalog.get(model)?.type || null, plateKey)
  });
}

/** Сохранить подтверждённые изменения цен и сезонов — только «Прайс: меняет» */
async function priceSave(staff, req, res) {
  if (!can(staff, 'price.edit')) throw new HttpError(403, 'read_only');
  const body = await readJson(req, 512 * 1024);
  try {
    const result = applyChanges(body, { email: staff.email, name: staff.name || staff.email });
    invalidateFleet();
    console.log(`Price changed by ${staff.email}: ${result.count} change(s) — ${result.summary}`);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err instanceof PriceError) throw new HttpError(400, err.code);
    throw err;
  }
}

/** Цены из файлов тарифов WS (Excel): предпросмотр, затем «Применить» — только «Прайс: меняет» */
async function priceImport(staff, req, res) {
  if (!can(staff, 'price.edit')) throw new HttpError(403, 'read_only');
  if (!priceActive()) throw new HttpError(400, 'price_not_active');
  const body = await readJson(req, 12 * 1024 * 1024);
  const { units } = await getFleet();
  try {
    const result = runImport(body, units, plateKey, { email: staff.email, name: staff.name || staff.email });
    if (result.applied) {
      invalidateFleet();
      console.log(`Price imported from tariff files by ${staff.email}: ${result.count} change(s) — ${result.summary}`);
    }
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof ImportError || err instanceof PriceError) throw new HttpError(400, err.code);
    throw err;
  }
}

async function priceRevert(staff, req, res) {
  if (!can(staff, 'price.edit')) throw new HttpError(403, 'read_only');
  const { id } = await readJson(req);
  try {
    const result = revertChange(Number(id), { email: staff.email, name: staff.name || staff.email });
    invalidateFleet();
    console.log(`Price change #${id} reverted by ${staff.email}`);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err instanceof PriceError) throw new HttpError(400, err.code);
    throw err;
  }
}

/** Калькулятор: модель и даты → цена (самая дешёвая машина модели), как считает бот */
async function priceQuote(staff, req, res, url) {
  needAny(staff, ['price.view']);
  const model = String(url.searchParams.get('model') || '');
  const from = String(url.searchParams.get('from') || '');
  const to = String(url.searchParams.get('to') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) throw new HttpError(400, 'bad_dates');
  const { units, pricing } = await getFleet();
  const quotes = units.filter((u) => u.model === model)
    .map((u) => quotePlate(pricing, plateKey(u.plate), from, to)).filter(Boolean)
    .sort((a, b) => a.total - b.total);
  sendJson(res, 200, { model, from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1, quote: quotes[0] || null });
}

/** Админ: заявку в архив (убрать из работы, в статистике остаётся) или обратно */
async function requestArchive(staff, req, res) {
  if (!can(staff, 'access.admin')) throw new HttpError(403, 'admin_only');
  const { id, archived } = await readJson(req);
  if (!db.archiveRequest(Number(id), archived !== false, staff.email)) throw new HttpError(404, 'not_found');
  console.log(`Request #${Number(id)} ${archived !== false ? 'archived' : 'restored from the archive'} by ${staff.email}`);
  sendJson(res, 200, { ok: true });
}

/** Админ: удалить заявку насовсем (тестовую) — копия остаётся в /data/deleted-requests.jsonl */
async function requestDelete(staff, req, res) {
  if (!can(staff, 'access.admin')) throw new HttpError(403, 'admin_only');
  const { id } = await readJson(req);
  const row = db.getRequest(Number(id));
  if (!row) throw new HttpError(404, 'not_found');
  fs.appendFileSync(path.join(config.dataDir, 'deleted-requests.jsonl'), `${JSON.stringify({ deletedAt: new Date().toISOString(), by: staff.email, request: row })}\n`);
  db.deleteRequests([row.id]);
  console.log(`Request #${row.id} deleted by ${staff.email}`);
  sendJson(res, 200, { ok: true });
}

async function dashboard(req, res, url) {
  needAny(await requireStaff(req), ['overview.view']);
  const problems = await collectProblems(Date.now(), url.searchParams.get('lang') || 'en');
  sendJson(res, 200, { problems, outlook: bookingOutlook(), requests: requestStats(), limits: LIMITS });
}

/* ------------------------------------------------- Проданные машины (админ) */

/** POST /api/staff/fleet/sold { plate, date?, price?, model?, wsModel? } | { text } | { plate, restore: true } */
async function fleetSold(staff, req, res) {
  if (!can(staff, 'fleet.edit')) throw new HttpError(403, 'read_only');
  const body = await readJson(req);
  let result = {};
  try {
    if (body.restore) unmarkSold(body.plate, staff.email);
    else if (typeof body.text === 'string') result = markSoldList(body.text, staff.email);
    else markSold(body, staff.email);
  } catch (err) {
    if (err instanceof SoldError) throw new HttpError(400, err.code);
    throw err;
  }
  // Сайт сразу показывает модель без проданной машины
  invalidateFleet();
  resetCatalog();
  sendJson(res, 200, { ...result, sold: soldList() });
}

/** Ошибки правки парка — 400 (404 — нет такой карточки) с понятным кодом */
function fleetCall(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FleetError) throw new HttpError(err.code === 'not_found' ? 404 : 400, err.code);
    throw err;
  }
}

/** POST /api/staff/fleet/vehicle { id?, plate, type, brand, model, clientModel, … } — «Парк: меняет» */
async function fleetVehicle(staff, req, res) {
  if (!can(staff, 'fleet.edit')) throw new HttpError(403, 'read_only');
  const body = await readJson(req);
  const vehicle = fleetCall(() => saveVehicle(body, staff.email));
  invalidateFleet();
  resetCatalog();
  sendJson(res, 200, { vehicle });
}

/** POST /api/staff/fleet/vehicle/delete { id } — убрать ошибочную карточку */
async function fleetVehicleDelete(staff, req, res) {
  if (!can(staff, 'fleet.edit')) throw new HttpError(403, 'read_only');
  const { id } = await readJson(req);
  fleetCall(() => deleteVehicle(id, staff.email));
  invalidateFleet();
  resetCatalog();
  sendJson(res, 200, { ok: true });
}

/* ----------------------------------------------------- Вкладка «Финансы» */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/staff/finance?from=2026-11-01&to=2026-11-30 — только просмотр */
async function finance(staff, req, res, url) {
  needAny(staff, ['finance.view']);
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  let from = url.searchParams.get('from');
  let to = url.searchParams.get('to');
  if (!ISO_DATE.test(from || '')) from = `${today.slice(0, 8)}01`;
  if (!ISO_DATE.test(to || '')) to = today;
  if (from > to) [from, to] = [to, from];
  // Не больше года за раз
  if (Date.parse(to) - Date.parse(from) > 366 * 86400000) from = new Date(Date.parse(to) - 366 * 86400000).toISOString().slice(0, 10);
  // Имена клиентов в сверке — только тем, кому открыты контакты клиентов
  // Зарплата по людям — только тем, кому открыт табель
  sendJson(res, 200, await financeReport({ from, to }, Date.now(), {
    clientsVisible: can(staff, 'clients.view'), timesheetVisible: can(staff, 'timesheet.view')
  }));
}

/** POST /api/staff/finance/loans { text } — платежи по кредитам машин, только админ */
async function financeLoans(staff, req, res) {
  if (!can(staff, 'access.admin')) throw new HttpError(403, 'admin_only');
  const { text } = await readJson(req);
  sendJson(res, 200, { loans: saveLoans(String(text || '').slice(0, 20000), staff.email) });
}

/** POST /api/staff/finance/cashbook — загрузить «Кассу» из WS (.xlsx), только админ */
async function financeCashbook(staff, req, res) {
  if (!can(staff, 'access.admin')) throw new HttpError(403, 'admin_only');
  const buffer = await readBody(req, 20 * 1024 * 1024);
  try {
    sendJson(res, 200, importCashbook(buffer, staff.email));
  } catch (err) {
    if (err.code === 'not_cashbook') throw new HttpError(400, 'not_cashbook');
    throw err;
  }
}

/* ------------------------------------------------------------ Вкладка «CRM» */

/** Ошибки CRM — 400 (или 404 для неизвестного клиента) с понятным кодом */
async function crmCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CrmError) throw new HttpError(err.code === 'not_found' ? 404 : 400, err.code);
    throw err;
  }
}

/** GET /api/staff/crm?filter=&q= — список клиентов */
async function crmListRoute(staff, req, res, url) {
  needAny(staff, ['crm.view']);
  sendJson(res, 200, await crmList({ filter: url.searchParams.get('filter') || 'all', q: (url.searchParams.get('q') || '').slice(0, 100) }));
}

/** GET /api/staff/crm/client?id= — карточка клиента */
async function crmClientRoute(staff, req, res, url) {
  needAny(staff, ['crm.view']);
  const card = await crmCall(() => crmClient(url.searchParams.get('id')));
  // Договоры клиента из «Документов» (по телефону или имени)
  if (can(staff, 'docs.view') || can(staff, 'docs.edit')) card.contracts = contractsOfClient(card.client?.phones || [], card.client?.name);
  sendJson(res, 200, card);
}

/** Изменения в CRM — только с правом «CRM: меняет» */
function crmEdit(handler) {
  return async (staff, req, res) => {
    if (!can(staff, 'crm.edit')) throw new HttpError(403, 'read_only');
    const body = await readJson(req);
    const id = await crmCall(() => handler(body, staff.email));
    sendJson(res, 200, await crmCall(() => crmClient(id)));
  };
}

/** POST /api/staff/crm/import — список клиентов из WS (.xlsx) */
async function crmImport(staff, req, res) {
  if (!can(staff, 'crm.edit')) throw new HttpError(403, 'read_only');
  const buffer = await readBody(req, 20 * 1024 * 1024);
  sendJson(res, 200, await crmCall(() => importClients(buffer, staff.email)));
}

/* ------------------------------------------------------- Вкладка «Маркетинг» */

/** GET /api/staff/marketing?period=today|week|month */
async function marketingRoute(staff, req, res, url) {
  needAny(staff, ['marketing.view']);
  const report = await marketingReport(url.searchParams.get('period') || 'month');
  sendJson(res, 200, { ...report, canEdit: can(staff, 'marketing.edit') });
}

/** Изменения в «Маркетинге» — только с уровнем «меняет» */
function marketingEdit(handler) {
  return async (staff, req, res) => {
    if (!can(staff, 'marketing.edit')) throw new HttpError(403, 'read_only');
    const body = await readJson(req);
    try {
      const result = handler(body);
      console.log(`Marketing change by ${staff.email}: ${req.url}`);
      sendJson(res, 200, { ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof MarketingError) throw new HttpError(err.code === 'not_found' ? 404 : 400, err.code);
      throw err;
    }
  };
}

/* ------------------------------------------------- Вкладка «Доступы» (админ) */

function needAccessAdmin(staff) {
  if (!can(staff, 'access.admin')) throw new HttpError(403, 'admin_only');
}

/** Ошибки проверки ролей и сотрудников — 400 с понятным кодом */
async function accessCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AccessError) throw new HttpError(400, err.code);
    throw err;
  }
}

async function accessGet(staff, req, res) {
  needAccessAdmin(staff);
  // Источники из «Маркетинга» — чтобы привязать агента к его кабинету
  const sources = allSources().map((x) => ({ id: x.id, name: x.name, kind: x.kind, active: x.active }));
  sendJson(res, 200, accessOverview(await adminList(), sources));
}

async function accessRole(staff, req, res) {
  needAccessAdmin(staff);
  const body = await readJson(req);
  sendJson(res, 200, { role: await accessCall(() => saveRole(body, staff.email)) });
}

async function accessRoleDelete(staff, req, res) {
  needAccessAdmin(staff);
  const { id } = await readJson(req);
  await accessCall(() => deleteRole(id, staff.email));
  sendJson(res, 200, { ok: true });
}

async function accessStaff(staff, req, res) {
  needAccessAdmin(staff);
  const body = await readJson(req);
  const admin = await isAdminEmail(body.email);
  sendJson(res, 200, { staff: await accessCall(() => saveStaff(body, staff.email, { isAdminEmail: () => admin })) });
}

async function accessImport(staff, req, res) {
  needAccessAdmin(staff);
  const { text } = await readJson(req);
  // Почты админов из таблицы нельзя занять сотрудником
  const admins = new Set((await adminList()).map((a) => a.email));
  sendJson(res, 200, importStaffList(text, staff.email, { isAdminEmail: (email) => admins.has(String(email || '').toLowerCase()) }));
}

async function accessStaffDelete(staff, req, res) {
  needAccessAdmin(staff);
  const { id } = await readJson(req);
  await accessCall(() => deleteStaff(id, staff.email));
  sendJson(res, 200, { ok: true });
}

/** Обработчик, которому нужен вошедший сотрудник: handler(staff, req, res, url) */
const signedIn = (handler) => async (req, res, url) => handler(await requireStaff(req), req, res, url);

const ROUTES = {
  'POST /api/staff/login': login,
  'POST /api/staff/verify': verify,
  'POST /api/staff/logout': logout,
  'GET /api/staff/me': me,
  'GET /api/staff/fleet': fleet,
  'GET /api/staff/requests': requests,
  'POST /api/staff/requests/archive': signedIn(requestArchive),
  'GET /api/staff/price': signedIn(priceRoute),
  'GET /api/staff/server/status': signedIn(serverStatusRoute),
  'POST /api/staff/price/save': signedIn(priceSave),
  'POST /api/staff/price/revert': signedIn(priceRevert),
  'POST /api/staff/price/import': signedIn(priceImport),
  'GET /api/staff/price/quote': signedIn(priceQuote),
  'POST /api/staff/requests/delete': signedIn(requestDelete),
  'GET /api/staff/dashboard': dashboard,
  'GET /api/staff/models': signedIn(listModels),
  'POST /api/staff/models/description': signedIn(saveDescription),
  'POST /api/staff/models/photo': signedIn(uploadPhoto),
  'POST /api/staff/models/thumb': signedIn(uploadThumb),
  'POST /api/staff/models/gallery': signedIn(saveGallery),
  'GET /api/staff/server': signedIn(serverReport),
  'POST /api/staff/server/settings': signedIn(saveServerSettings),
  'GET /api/staff/journal': signedIn(getJournal),
  'POST /api/staff/journal/fix': signedIn(fixEvent),
  'GET /api/staff/journal/timesheet': signedIn(getTimesheet),
  'GET /api/staff/journal/reconcile': signedIn(getReconcile),
  'GET /api/staff/journal/media': signedIn(getMedia),
  'POST /api/staff/journal/import': signedIn(importHistory),
  'GET /api/staff/wa': signedIn(waStatus),
  'POST /api/staff/wa/config': signedIn(waConfig),
  'POST /api/staff/wa/pair': signedIn(waPair),
  'POST /api/staff/wa/logout': signedIn(waLogout),
  // WhatsApp-бот для клиентов (номер компании) — «Маркетинг» → «Офис»
  'GET /api/staff/wabot': signedIn(wabotPortalStatus),
  'POST /api/staff/wabot/settings': signedIn(wabotPortalSettings),
  'POST /api/staff/wabot/config': signedIn(wabotPortalConfig),
  'POST /api/staff/wabot/pair': signedIn(wabotPortalPair),
  'POST /api/staff/wabot/logout': signedIn(wabotPortalLogout),
  'GET /api/staff/access': signedIn(accessGet),
  'POST /api/staff/access/role': signedIn(accessRole),
  'POST /api/staff/access/role/delete': signedIn(accessRoleDelete),
  'POST /api/staff/access/staff': signedIn(accessStaff),
  'POST /api/staff/access/staff/delete': signedIn(accessStaffDelete),
  'POST /api/staff/access/import': signedIn(accessImport),
  'GET /api/staff/finance': signedIn(finance),
  'POST /api/staff/finance/cashbook': signedIn(financeCashbook),
  'POST /api/staff/fleet/sold': signedIn(fleetSold),
  'POST /api/staff/fleet/vehicle': signedIn(fleetVehicle),
  'POST /api/staff/fleet/status': signedIn(fleetStatusRoute),
  'POST /api/staff/fleet/check': signedIn(fleetCheckRoute),
  'POST /api/staff/fleet/vehicle/delete': signedIn(fleetVehicleDelete),
  'POST /api/staff/finance/loans': signedIn(financeLoans),
  'GET /api/staff/marketing': signedIn(marketingRoute),
  'GET /api/staff/marketing/details': signedIn(async (staff, req, res, url) => {
    needAny(staff, ['marketing.view']);
    sendJson(res, 200, await marketingDetails(url.searchParams.get('metric') || 'visits', url.searchParams.get('period') || 'month'));
  }),
  'POST /api/staff/marketing/source': signedIn(marketingEdit((b) => saveSource(b))),
  'POST /api/staff/marketing/source/delete': signedIn(marketingEdit((b) => deleteSource(b.id))),
  'POST /api/staff/marketing/place': signedIn(marketingEdit((b) => placeSource(b.id, b.col, b.row))),
  'POST /api/staff/marketing/settings': signedIn(marketingEdit((b) => saveSettings(b))),
  'GET /api/staff/crm': signedIn(crmListRoute),
  'GET /api/staff/crm/client': signedIn(crmClientRoute),
  'POST /api/staff/crm/client': signedIn(crmEdit((b, by) => saveClient(b, by))),
  'POST /api/staff/crm/tags': signedIn(crmEdit((b, by) => { setTags(b.id, b.tags, by); return b.id; })),
  'POST /api/staff/crm/note': signedIn(crmEdit((b, by) => { addNote(b.id, b.text, by); return b.id; })),
  'POST /api/staff/crm/merge': signedIn(crmEdit((b, by) => mergeClients(b.into, b.from, by))),
  'POST /api/staff/crm/import': signedIn(crmImport),
  'GET /api/staff/tickets': signedIn(listTickets),
  'GET /api/staff/tickets/badge': signedIn(ticketsBadge),
  'POST /api/staff/tickets': signedIn(createTicket),
  'GET /api/staff/tickets/shot': signedIn(getShot),
  'POST /api/staff/tickets/shot': signedIn(uploadShot),
  'POST /api/staff/tickets/status': signedIn(setTicketStatus),
  'POST /api/staff/tickets/seen': signedIn(markSeen),
  'POST /api/staff/tickets/delete': signedIn(deleteTicket),
  'GET /api/staff/agent': signedIn(agentCabinet),
  'POST /api/staff/agent/request': signedIn(agentRequest),
  'POST /api/staff/agent/payout': signedIn(agentPayout),
  'POST /api/staff/agent/payout/delete': signedIn(agentPayoutDelete),
  'GET /api/staff/investor': signedIn(investorCabinet),
  'POST /api/staff/investor/payout': signedIn(investorPayout),
  'POST /api/staff/investor/payout/delete': signedIn(investorPayoutDelete),
  'GET /api/staff/docs': signedIn(docsList),
  'GET /api/staff/docs/one': signedIn(docsOne),
  'GET /api/staff/docs/prefill': signedIn(docsPrefill),
  'POST /api/staff/docs/save': signedIn(docsSave),
  'POST /api/staff/docs/delete': signedIn(docsDelete),
  'GET /api/staff/docs/pdf': signedIn(docsPdf),
  'POST /api/staff/docs/sign': signedIn(docsSign),
  'POST /api/staff/docs/unsign': signedIn(docsUnsign),
  'POST /api/staff/docs/link': signedIn(docsLink),
  'POST /api/staff/docs/send': signedIn(docsSend),
  'POST /api/staff/docs/photo': signedIn(docsPhotoUpload),
  'GET /api/staff/docs/photo': signedIn(docsPhotoGet),
  'POST /api/staff/docs/photo/delete': signedIn(docsPhotoDelete),
  'POST /api/staff/docs/issue': signedIn(docsIssue),
  'POST /api/staff/docs/unissue': signedIn(docsUnissue),
  'GET /api/staff/settings': signedIn(settingsRoute),
  'POST /api/staff/settings/service': signedIn(settingsService),
  'POST /api/staff/settings/service/delete': signedIn(settingsServiceDelete),
  'POST /api/staff/settings/service/paid': signedIn(settingsPaid),
  'POST /api/staff/settings/payment/delete': signedIn(settingsPaymentDelete),
  'POST /api/staff/settings/ai': signedIn(settingsAi),
  'POST /api/staff/settings/domains/check': signedIn(settingsDomainsCheck)
};

/** Обработчик для пути /api/staff/*; null — такого маршрута нет */
export function staffRoute(method, pathname) {
  return ROUTES[`${method} ${pathname}`] || null;
}
