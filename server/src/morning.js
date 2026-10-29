/**
 * ============================================================================
 * Утренняя сводка в рабочую группу Telegram
 * ============================================================================
 * Каждый день в 10:00 по Бангкоку: выдачи и возвраты сегодня, брони впереди,
 * парк сейчас и список проблем (те же, что в окне «Проблемы» на сайте
 * сотрудников). День отправки хранится в базе — после перезапуска сервера
 * сводка не повторится. В группе её можно запросить командой /summary.
 * Язык — как у всей рабочей группы (STAFF_GROUP_LANG, по умолчанию русский).
 * ============================================================================
 */

import { config } from './config.js';
import * as db from './db.js';
import { escapeHtml } from './format.js';
import { todayIso } from './dates.js';
import { collectProblems, bookingOutlook, CATEGORIES } from './dashboard.js';
import { getStaffChatId, sendToStaffGroup } from './staff.js';
import { getWsSnapshot } from './ws/sync.js';
import { wsEnabled } from './ws/api.js';
import { telegramEnabled } from './telegram/api.js';
import { g, gn, groupLang, groupLocale } from './groupTexts.js';

const SEND_HOUR = 10;
// Сразу после перезапуска ждём данные Автопроката, но не дольше этой минуты
const WAIT_DATA_UNTIL_MINUTE = 45;
// В каждой категории показываем первые 5, остальные — на сайте сотрудников
const MAX_PER_CATEGORY = 5;
const CATEGORY_ICON = { sales: '💼', it: '🖥', marketing: '🌐', service: '🔧' };
const BANGKOK_MS = 7 * 3600000;

/** Текст сводки (HTML для Telegram) на языке рабочей группы */
export function formatSummary(problems, outlook, snapshot, now = Date.now()) {
  const date = new Date(now + BANGKOK_MS).toLocaleDateString(groupLocale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const lines = [g('sum.title', { date: escapeHtml(date.charAt(0).toUpperCase() + date.slice(1)) }), ''];
  if (outlook) {
    lines.push(g('sum.today', { pickups: gn('sum.pickups', outlook.today.pickups), returns: gn('sum.returns', outlook.today.returns) }));
    lines.push(g('sum.ahead', {
      b7: outlook.next7.bookings, v7: gn('sum.vehicles', outlook.next7.vehicles),
      b30: outlook.next30.bookings, v30: gn('sum.vehicles', outlook.next30.vehicles)
    }));
  }
  if (snapshot?.cars.length) {
    const count = (status) => snapshot.cars.filter((c) => c.status === status).length;
    lines.push(g('sum.fleet', { free: count('free'), rent: count('rent'), service: count('service') }));
  }
  lines.push('');
  if (!problems.length) {
    lines.push(g('sum.none'));
  } else {
    const byCategory = CATEGORIES.map((c) => [c, problems.filter((p) => p.category === c)]);
    lines.push(g('sum.problems', { n: problems.length, counts: byCategory.map(([c, list]) => `${g(`cat.${c}`)} ${list.length}`).join(' · ') }));
    for (const [c, list] of byCategory.filter(([, l]) => l.length)) {
      lines.push('', `${CATEGORY_ICON[c]} <b>${g(`cat.${c}`)} — ${list.length}</b>`);
      for (const p of list.slice(0, MAX_PER_CATEGORY)) lines.push(`${p.level === 'error' ? '🔴' : '🟡'} ${escapeHtml(p.title)}`);
      if (list.length > MAX_PER_CATEGORY) lines.push(g('sum.more', { n: list.length - MAX_PER_CATEGORY }));
    }
  }
  lines.push('', `👉 ${escapeHtml(config.staff.url)}`);
  return lines.join('\n');
}

export async function sendMorningSummary() {
  const now = Date.now();
  const text = formatSummary(await collectProblems(now, groupLang), bookingOutlook(now), getWsSnapshot(), now);
  return sendToStaffGroup(text, { disable_web_page_preview: true });
}

let sending = false;

async function tick() {
  if (sending || !getStaffChatId()) return;
  const now = Date.now();
  const local = new Date(now + BANGKOK_MS);
  if (local.getUTCHours() !== SEND_HOUR) return;
  const day = todayIso(new Date(now));
  if (db.getSetting('morning_summary_day') === day) return;
  if (wsEnabled && !getWsSnapshot() && local.getUTCMinutes() < WAIT_DATA_UNTIL_MINUTE) return;
  sending = true;
  try {
    await sendMorningSummary();
    db.setSetting('morning_summary_day', day);
  } catch (err) {
    // Повторим через минуту (в пределах часа); сбой виден в окне «Проблемы»
    console.error('Morning summary failed:', err.message);
  } finally {
    sending = false;
  }
}

export function startMorningSummary() {
  if (!telegramEnabled) return;
  setInterval(() => { tick().catch((err) => console.error('Morning summary tick failed:', err)); }, 60 * 1000).unref();
}
