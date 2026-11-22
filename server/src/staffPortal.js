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
 * Права ролей — в roles.js.
 *
 * В базе храним только хэши кодов и сессий.
 * ============================================================================
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson, readJson, readBody, parseCookies, clientIp, rateLimiter } from './http.js';
import { findStaff, normalizeEmail, isValidEmail, adminList, isAdminEmail } from './staffUsers.js';
import { mailEnabled, sendMail } from './mail.js';
import { getWsSnapshot, wsSyncStatus } from './ws/sync.js';
import { getFleet, sheetsEnabled, plateKey } from './fleet.js';
import { tariffOn } from './pricing.js';
import { todayIso } from './dates.js';
import { canEdit, listModels, saveDescription, uploadPhoto, uploadThumb, saveGallery } from './staffCatalog.js';
import { collectProblems, bookingOutlook, requestStats, LIMITS } from './dashboard.js';
import { roleOf, roleNameOf, permissionsOf, can, canAny } from './roles.js';
import { accessOverview, saveRole, deleteRole, saveStaff, deleteStaff, importStaffList, AccessError } from './access.js';
import { financeReport, saveLoans } from './finance.js';
import { importCashbook } from './cashbook.js';
import { serverReport, saveServerSettings, alertAdminsOnce } from './serverStats.js';
import { g } from './groupTexts.js';
import { escapeHtml } from './format.js';
import { getJournal, fixEvent, getTimesheet, getReconcile, getMedia, importHistory } from './journal/api.js';
import { waStatus, waConfig, waPair, waLogout } from './journal/observer.js';
import { groupStatusByPlate } from './journal/reconcile.js';

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
    permissions: permissionsOf(staff), canEdit: canEdit(staff)
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

async function fleet(req, res) {
  // Парк нужен и обзору, и календарю
  needAny(await requireStaff(req), ['fleet.view', 'calendar.view', 'overview.view']);
  const snapshot = getWsSnapshot();
  const sync = wsSyncStatus();
  sendJson(res, 200, {
    enabled: sync.enabled,
    error: sync.error,
    updatedAt: snapshot?.updatedAt || null,
    windowFrom: snapshot?.windowFrom || null,
    windowTo: snapshot?.windowTo || null,
    cars: snapshot?.cars || [],
    // Статус машин по рабочей группе WhatsApp: госномер → последний отчёт
    group: Object.fromEntries([...groupStatusByPlate()].map(([plate, g]) => [plate, { status: g.status, at: g.at, kind: g.kind }])),
    ...(await priceData(snapshot?.cars || []))
  });
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
    declinedBy: r.declined_by ? r.declined_by.split('\n') : []
  }));
  sendJson(res, 200, { requests: rows });
}

async function dashboard(req, res, url) {
  needAny(await requireStaff(req), ['overview.view']);
  const problems = await collectProblems(Date.now(), url.searchParams.get('lang') || 'en');
  sendJson(res, 200, { problems, outlook: bookingOutlook(), requests: requestStats(), limits: LIMITS });
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
  sendJson(res, 200, accessOverview(await adminList()));
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
  'GET /api/staff/access': signedIn(accessGet),
  'POST /api/staff/access/role': signedIn(accessRole),
  'POST /api/staff/access/role/delete': signedIn(accessRoleDelete),
  'POST /api/staff/access/staff': signedIn(accessStaff),
  'POST /api/staff/access/staff/delete': signedIn(accessStaffDelete),
  'POST /api/staff/access/import': signedIn(accessImport),
  'GET /api/staff/finance': signedIn(finance),
  'POST /api/staff/finance/cashbook': signedIn(financeCashbook),
  'POST /api/staff/finance/loans': signedIn(financeLoans)
};

/** Обработчик для пути /api/staff/*; null — такого маршрута нет */
export function staffRoute(method, pathname) {
  return ROUTES[`${method} ${pathname}`] || null;
}
