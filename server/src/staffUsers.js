/**
 * Кто может входить на сайт сотрудников: почты из колонки «Email» листа
 * Users (плюс необязательный список STAFF_EMAILS в .env). Лист читается не
 * чаще раза в 2 минуты; если Google недоступен — работаем по последней
 * загруженной версии, а без неё никого не пускаем.
 */

import { config } from './config.js';
import { getRows, sheetsEnabled } from './google/sheets.js';

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
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache.byEmail;

  const byEmail = new Map();
  for (const email of config.staff.extraEmails) byEmail.set(email, { email, name: email, role: 'Admin' });

  if (sheetsEnabled) {
    try {
      for (const row of await getRows(USERS_SHEET)) {
        // В одной ячейке можно указать несколько почт через запятую или пробел
        for (const email of String(row.Email || '').split(/[\s,;]+/).map(normalizeEmail).filter(isValidEmail)) {
          byEmail.set(email, { email, name: String(row['Имя'] || row.Username || email).trim(), role: String(row['Роль'] || '').trim() });
        }
      }
    } catch (err) {
      console.error('Staff list load failed:', err.message);
      if (cache) return cache.byEmail;
      throw err;
    }
  }

  cache = { loadedAt: Date.now(), byEmail };
  return byEmail;
}

/** Сотрудник по почте или null, если доступа нет */
export async function findStaff(email) {
  return (await loadStaff()).get(normalizeEmail(email)) || null;
}
