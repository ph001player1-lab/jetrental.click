/**
 * Кто может входить на сайт сотрудников.
 * Все — в портале, вкладка «Доступы» (access.js): у админа роль «Админ», её
 * назначает только админ. Главные админы — STAFF_EMAILS в .env сервера: их нельзя
 * снять в портале, чтобы никто не остался без входа.
 * Раньше админы были в Google-таблице (лист Users) — при уходе от таблицы они
 * один раз переносятся в портал (как раньше сотрудники), дальше лист не читаем.
 */

import { config } from './config.js';
import * as db from './db.js';
import { getRows, sheetsEnabled } from './google/sheets.js';
import { ADMIN_ROLE, activeStaff, importLegacyStaff, importLegacyAdmins, staffByEmail } from './access.js';

const USERS_SHEET = 'Users';
const CACHE_MS = 2 * 60 * 1000;

let cache = null;

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const phonesOf = (value) => String(value || '').split(/[,;/]+/).map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 8);

/** Один раз: админы и сотрудники из листа Users → портал. false — таблица сейчас недоступна */
async function moveUsersSheet() {
  if (!sheetsEnabled || db.getSetting('access_admins_imported') === '1') return true;
  try {
    const legacy = [];
    const admins = [];
    for (const row of await getRows(USERS_SHEET)) {
      const isAdmin = String(row['Роль'] || '').trim().toLowerCase() === ADMIN_ROLE;
      const name = String(row['Имя'] || row.Username || '').trim();
      const telegramId = String(row['Telegram ID'] || '').replace(/\D/g, '');
      // В одной ячейке можно указать несколько почт через запятую или пробел
      const emails = String(row.Email || '').split(/[\s,;]+/).map(normalizeEmail).filter(isValidEmail);
      const whatsapp = phonesOf(row.WhatsApp)[0] || '';
      if (isAdmin) admins.push({ name, emails, telegramId, whatsapp });
      else for (const email of emails.length ? emails : [null]) legacy.push({ email, name, role: row['Роль'], telegramId, whatsapp });
    }
    const moved = importLegacyStaff(legacy);
    if (moved) console.log(`Access: moved ${moved} staff from the Users sheet to the portal`);
    importLegacyAdmins(admins);
    return true;
  } catch (err) {
    console.error('Users sheet move failed (will retry):', err.message);
    return false;
  }
}

/** Админы: почта → { email, name, role: 'admin', telegramId, main } — главные (.env) и из портала */
async function loadAdmins() {
  // После переезда список собирается из базы при каждом запросе — назначение и снятие админа действуют сразу
  const movedBefore = !sheetsEnabled || db.getSetting('access_admins_imported') === '1';
  if (cache && !movedBefore && Date.now() - cache.loadedAt < CACHE_MS) return cache;
  const moved = await moveUsersSheet();
  const admins = new Map();
  const phones = new Map();
  // Telegram ID админов — для личных оповещений о сервере
  const adminChats = new Set();
  for (const email of config.staff.extraEmails) admins.set(email, { email, name: email, role: ADMIN_ROLE, telegramId: '', main: true });
  for (const s of activeStaff()) {
    if (s.roleId !== ADMIN_ROLE) continue;
    if (s.telegramId) adminChats.add(String(s.telegramId));
    if (s.email && !admins.has(s.email)) {
      admins.set(s.email, { email: s.email, name: s.name || s.email, role: ADMIN_ROLE, telegramId: s.telegramId || '', staffId: s.id, sourceId: s.sourceId, investorPercent: s.investorPercent });
    }
  }
  // Пока перенос не удался, прошлый список не теряем (админы из таблицы ещё могут войти)
  if (!moved && cache) return cache;
  cache = { loadedAt: Date.now(), admins, phones, adminChats: [...adminChats] };
  return cache;
}

/** Сотрудник по почте или null, если доступа нет: сначала админы, потом портал */
export async function findStaff(email) {
  const key = normalizeEmail(email);
  const admin = (await loadAdmins()).admins.get(key);
  if (admin) return admin;
  const staff = staffByEmail(key);
  return staff ? {
    email: staff.email, name: staff.name, role: staff.roleId, telegramId: staff.telegramId, staffId: staff.id, sourceId: staff.sourceId,
    investorPercent: staff.investorPercent
  } : null;
}

/** Имена сотрудников по номеру WhatsApp (только цифры) */
export async function staffPhones() {
  const phones = new Map();
  // Имя-заглушка из одних цифр («+66 90 293 5085») не подменяет имя из самого WhatsApp
  for (const s of activeStaff()) if (/\p{L}/u.test(s.name)) for (const phone of phonesOf(s.whatsapp)) phones.set(phone, s.name);
  return phones;
}

/** Имя сотрудника по Telegram ID — из «Доступов» (и админов из таблицы); null — не нашли */
export async function staffNameByTelegram(telegramId) {
  const id = String(telegramId || '').replace(/\D/g, '');
  if (!id) return null;
  const staff = activeStaff().find((s) => String(s.telegramId) === id && /\p{L}/u.test(s.name));
  if (staff) return staff.name;
  try {
    for (const a of (await loadAdmins()).admins.values()) if (String(a.telegramId) === id && a.name && a.name !== a.email) return a.name;
  } catch { /* без таблицы — только портал */ }
  return null;
}

/** Telegram ID админов (кому слать оповещения о сервере) */
export async function adminTelegramIds() {
  return (await loadAdmins()).adminChats;
}

/** Главные админы (STAFF_EMAILS в .env) — для вкладки «Доступы»: их нельзя снять в портале */
export async function adminList() {
  return config.staff.extraEmails.map((email) => ({ name: email, email, main: true }));
}

/** Главный админ (из настроек сервера) — его нельзя сделать сотрудником портала */
export async function isAdminEmail(email) {
  return config.staff.extraEmails.includes(normalizeEmail(email));
}
