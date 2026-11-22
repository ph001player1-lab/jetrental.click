/**
 * Кто может входить на сайт сотрудников.
 * Админы — из Google-таблицы (лист Users, роль Admin; плюс STAFF_EMAILS в .env):
 * лист читается не чаще раза в 2 минуты, без Google — по последней версии.
 * Остальные сотрудники — в портале, вкладка «Доступы» (access.js); при переезде
 * сотрудники из таблицы один раз переносятся в портал с прежней ролью.
 */

import { config } from './config.js';
import { getRows, sheetsEnabled } from './google/sheets.js';
import { ADMIN_ROLE, activeStaff, importLegacyStaff, staffByEmail } from './access.js';

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

/** Админы из таблицы: почта → { email, name, role: 'admin', telegramId } */
async function loadAdmins() {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;

  const admins = new Map();
  const phones = new Map();
  // Telegram ID админов — для личных оповещений о сервере
  const adminChats = new Set();
  for (const email of config.staff.extraEmails) admins.set(email, { email, name: email, role: ADMIN_ROLE, telegramId: '' });

  if (sheetsEnabled) {
    try {
      const legacy = [];
      for (const row of await getRows(USERS_SHEET)) {
        const isAdmin = String(row['Роль'] || '').trim().toLowerCase() === ADMIN_ROLE;
        const name = String(row['Имя'] || row.Username || '').trim();
        const telegramId = String(row['Telegram ID'] || '').replace(/\D/g, '');
        // В одной ячейке можно указать несколько почт через запятую или пробел
        const emails = String(row.Email || '').split(/[\s,;]+/).map(normalizeEmail).filter(isValidEmail);
        if (!isAdmin) {
          const whatsapp = phonesOf(row.WhatsApp)[0] || '';
          for (const email of emails.length ? emails : [null]) legacy.push({ email, name, role: row['Роль'], telegramId, whatsapp });
          continue;
        }
        if (telegramId) adminChats.add(telegramId);
        for (const phone of phonesOf(row.WhatsApp)) if (name) phones.set(phone, name);
        for (const email of emails) admins.set(email, { email, name: name || email, role: ADMIN_ROLE, telegramId });
      }
      // Переезд: сотрудники (не админы) из таблицы — один раз в портал
      const moved = importLegacyStaff(legacy);
      if (moved) console.log(`Access: moved ${moved} staff from the Users sheet to the portal`);
    } catch (err) {
      console.error('Staff list load failed:', err.message);
      if (cache) return cache;
    }
  }

  cache = { loadedAt: Date.now(), admins, phones, adminChats: [...adminChats] };
  return cache;
}

/** Сотрудник по почте или null, если доступа нет: сначала админы, потом портал */
export async function findStaff(email) {
  const key = normalizeEmail(email);
  const admin = (await loadAdmins()).admins.get(key);
  if (admin) return admin;
  const staff = staffByEmail(key);
  return staff ? { email: staff.email, name: staff.name, role: staff.roleId, telegramId: staff.telegramId, staffId: staff.id } : null;
}

/** Имена сотрудников по номеру WhatsApp (только цифры) */
export async function staffPhones() {
  const phones = new Map();
  // Имя-заглушка из одних цифр («+66 90 293 5085») не подменяет имя из самого WhatsApp
  for (const s of activeStaff()) if (/\p{L}/u.test(s.name)) for (const phone of phonesOf(s.whatsapp)) phones.set(phone, s.name);
  try {
    for (const [phone, name] of (await loadAdmins()).phones) phones.set(phone, name);
  } catch { /* без таблицы — только сотрудники портала */ }
  return phones;
}

/** Telegram ID админов (кому слать оповещения о сервере) */
export async function adminTelegramIds() {
  return (await loadAdmins()).adminChats;
}

/** Админы из таблицы — для вкладки «Доступы» */
export async function adminList() {
  return [...(await loadAdmins()).admins.values()].map((a) => ({ name: a.name, email: a.email }));
}

export async function isAdminEmail(email) {
  return (await loadAdmins()).admins.has(normalizeEmail(email));
}
