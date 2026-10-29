/**
 * ============================================================================
 * API сайта сотрудников (staff.jetrental.click)
 * ============================================================================
 * Вход без паролей: сотрудник вводит почту → на неё приходит 6-значный код
 * (действует 10 минут, 5 попыток) → после ввода кода вход действует 24 часа.
 * Пускаем только почты из колонки Email листа Users; если почту удалили —
 * доступ пропадает при следующем запросе (список обновляется раз в 2 минуты).
 *
 *   POST /api/staff/login    { email }        — отправить код
 *   POST /api/staff/verify   { email, code }  — войти (ставит cookie)
 *   POST /api/staff/logout                    — выйти
 *   GET  /api/staff/me                        — кто вошёл
 *   GET  /api/staff/fleet                     — парк из Автопроката + цены
 *   GET  /api/staff/requests                  — заявки из ботов и сайта
 *   /api/staff/models…                        — фото и описания моделей
 *                                               для сайта (staffCatalog.js)
 *
 * В базе храним только хэши кодов и сессий.
 * ============================================================================
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson, readJson, parseCookies, clientIp, rateLimiter } from './http.js';
import { findStaff, normalizeEmail, isValidEmail } from './staffUsers.js';
import { mailEnabled, sendMail } from './mail.js';
import { getWsSnapshot, wsSyncStatus } from './ws/sync.js';
import { getFleet, sheetsEnabled, plateKey } from './fleet.js';
import { tariffOn } from './pricing.js';
import { todayIso } from './dates.js';
import { canEdit, listModels, saveDescription, uploadPhoto } from './staffCatalog.js';

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

function codeEmail(code, name) {
  const minutes = config.staff.codeMinutes;
  const text =
    `Hi ${name},\n\nYour JetRental staff login code: ${code}\n\n` +
    `It is valid for ${minutes} minutes. After you sign in, access lasts ${config.staff.sessionHours} hours.\n` +
    'If you did not request this code, just ignore this email.';
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0f172a">' +
    `<p>Hi ${name.replace(/[<>&"]/g, '')},</p>` +
    '<p>Your JetRental staff login code:</p>' +
    `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:16px 0">${code}</p>` +
    `<p>It is valid for ${minutes} minutes. After you sign in, access lasts ${config.staff.sessionHours} hours.</p>` +
    '<p style="color:#64748b">If you did not request this code, just ignore this email.</p></div>';
  return { subject: `JetRental staff login code: ${code}`, text, html };
}

async function login(req, res) {
  const { email: rawEmail } = await readJson(req);
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
  if (!staff) db.saveLoginCode(email, crypto.randomBytes(32).toString('hex'), expiresAt);
  if (staff) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.saveLoginCode(email, hmac(`${email}:${code}`), expiresAt);
    try {
      await sendMail({ to: email, ...codeEmail(code, staff.name || email) });
    } catch (err) {
      console.error('Login code email failed:', err.message);
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
  const maxAge = config.staff.sessionHours * 3600;
  db.createStaffSession(sha256(token), email, new Date(Date.now() + maxAge * 1000).toISOString());
  sendJson(res, 200, { ok: true, user: publicUser(staff) }, { 'Set-Cookie': sessionCookie(token, maxAge) });
}

function publicUser(staff) {
  return { email: staff.email, name: staff.name, role: staff.role, canEdit: canEdit(staff) };
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
  await requireStaff(req);
  const snapshot = getWsSnapshot();
  const sync = wsSyncStatus();
  sendJson(res, 200, {
    enabled: sync.enabled,
    error: sync.error,
    updatedAt: snapshot?.updatedAt || null,
    windowFrom: snapshot?.windowFrom || null,
    windowTo: snapshot?.windowTo || null,
    cars: snapshot?.cars || [],
    ...(await priceData(snapshot?.cars || []))
  });
}

async function requests(req, res) {
  await requireStaff(req);
  const rows = db.listRecentRequests(100).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    channel: r.channel,
    clientName: r.client_name,
    clientPhone: r.client_phone,
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

/** Обработчик, которому нужен вошедший сотрудник: handler(staff, req, res, url) */
const signedIn = (handler) => async (req, res, url) => handler(await requireStaff(req), req, res, url);

const ROUTES = {
  'POST /api/staff/login': login,
  'POST /api/staff/verify': verify,
  'POST /api/staff/logout': logout,
  'GET /api/staff/me': me,
  'GET /api/staff/fleet': fleet,
  'GET /api/staff/requests': requests,
  'GET /api/staff/models': signedIn(listModels),
  'POST /api/staff/models/description': signedIn(saveDescription),
  'POST /api/staff/models/photo': signedIn(uploadPhoto)
};

/** Обработчик для пути /api/staff/*; null — такого маршрута нет */
export function staffRoute(method, pathname) {
  return ROUTES[`${method} ${pathname}`] || null;
}
