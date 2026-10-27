/**
 * Разбор дат аренды из текста клиента: «5.11 - 12.11», «05.11.2026 по 12.11.2026»,
 * «с 5/11 до 12/11». Год можно не писать — подставим ближайший будущий.
 */

import { config } from './config.js';

const DATE_RE = /(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?/g;
const MAX_RENTAL_DAYS = 365;

/** Сегодняшняя дата в Бангкоке как 'YYYY-MM-DD' */
export function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function toIso(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date.toISOString().slice(0, 10) : null;
}

function addYear(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return toIso(y + 1, m, d);
}

/**
 * @param {string} text
 * @param {string} [today] 'YYYY-MM-DD' (для тестов)
 * @return {{from: string, to: string} | {error: string}}
 */
export function parseDateRange(text, today = todayIso()) {
  const matches = [...String(text).matchAll(DATE_RE)].slice(0, 2);
  if (matches.length < 2) return { error: 'format' };

  const currentYear = Number(today.slice(0, 4));
  const dates = matches.map(([, d, m, y]) => {
    let year = y ? Number(y) : currentYear;
    if (y && y.length === 2) year = 2000 + Number(y);
    return { iso: toIso(year, Number(m), Number(d)), explicitYear: Boolean(y) };
  });

  if (dates.some((d) => !d.iso)) return { error: 'invalid' };

  let [from, to] = dates;
  // Дата без года уже прошла в этом году → значит, речь про следующий год
  if (!from.explicitYear && from.iso < today) from = { ...from, iso: addYear(from.iso) };
  if (!to.explicitYear && to.iso < from.iso) to = { ...to, iso: addYear(to.iso) };

  if (!from.iso || !to.iso) return { error: 'invalid' };
  if (from.iso < today) return { error: 'past' };
  if (to.iso <= from.iso) return { error: 'order' };

  const days = Math.round((Date.parse(to.iso) - Date.parse(from.iso)) / 86400000);
  if (days > MAX_RENTAL_DAYS) return { error: 'too_long' };

  return { from: from.iso, to: to.iso };
}
