/**
 * Кто может входить на сайт сотрудников: почты из колонки «Email» листа
 * Users (плюс необязательный список STAFF_EMAILS в .env), роль — из колонки
 * «Роль» (права — в roles.js). Лист читается не чаще раза в 2 минуты; если
 * Google недоступен — работаем по последней загруженной версии, а без неё
 * никого не пускаем.
 */

import { config } from './config.js';
import { getRows, sheetsEnabled } from './google/sheets.js';
import { roleOf } from './roles.js';

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

async function loadStaff() {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;

  const byEmail = new Map();
  // Telegram ID админов — для личных оповещений о сервере (почта для них не нужна)
  const adminChats = new Set();
  for (const email of config.staff.extraEmails) byEmail.set(email, { email, name: email, role: 'Admin', telegramId: '' });

  if (sheetsEnabled) {
    try {
      for (const row of await getRows(USERS_SHEET)) {
        const role = String(row['Роль'] || '').trim();
        const telegramId = String(row['Telegram ID'] || '').replace(/\D/g, '');
        if (telegramId && roleOf({ role }) === 'admin') adminChats.add(telegramId);
        // В одной ячейке можно указать несколько почт через запятую или пробел
        for (const email of String(row.Email || '').split(/[\s,;]+/).map(normalizeEmail).filter(isValidEmail)) {
          byEmail.set(email, { email, name: String(row['Имя'] || row.Username || email).trim(), role, telegramId });
        }
      }
    } catch (err) {
      console.error('Staff list load failed:', err.message);
      if (cache) return cache;
      throw err;
    }
  }

  cache = { loadedAt: Date.now(), byEmail, adminChats: [...adminChats] };
  return cache;
}

/** Сотрудник по почте или null, если доступа нет */
export async function findStaff(email) {
  return (await loadStaff()).byEmail.get(normalizeEmail(email)) || null;
}

/** Telegram ID сотрудников с ролью Admin (кому слать оповещения о сервере) */
export async function adminTelegramIds() {
  return (await loadStaff()).adminChats;
}
