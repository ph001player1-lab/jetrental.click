/**
 * ============================================================================
 * Утренняя сводка в рабочую группу Telegram
 * ============================================================================
 * Каждый день в 10:00 по Бангкоку: выдачи и возвраты сегодня, брони впереди,
 * парк сейчас и список проблем (те же, что в окне «Проблемы» на сайте
 * сотрудников). День отправки хранится в базе — после перезапуска сервера
 * сводка не повторится. В группе её можно запросить командой /summary.
 * ============================================================================
 */

import { config } from './config.js';
import * as db from './db.js';
import { escapeHtml } from './format.js';
import { todayIso } from './dates.js';
import { collectProblems, bookingOutlook } from './dashboard.js';
import { getStaffChatId, sendToStaffGroup } from './staff.js';
import { getWsSnapshot } from './ws/sync.js';
import { wsEnabled } from './ws/api.js';
import { telegramEnabled } from './telegram/api.js';

const SEND_HOUR = 10;
// Сразу после перезапуска ждём данные Автопроката, но не дольше этой минуты
const WAIT_DATA_UNTIL_MINUTE = 45;
const MAX_PROBLEMS = 15;
const BANGKOK_MS = 7 * 3600000;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Текст сводки (HTML для Telegram) */
export function formatSummary(problems, outlook, snapshot, now = Date.now()) {
  const date = new Date(now + BANGKOK_MS).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const lines = [`☀️ <b>Good morning! ${escapeHtml(date)}</b>`, ''];
  if (outlook) {
    lines.push(`<b>Today:</b> ${plural(outlook.today.pickups, 'pickup')} · ${plural(outlook.today.returns, 'return')}`);
    lines.push(`<b>Bookings ahead:</b> 7 days — ${outlook.next7.bookings} (${plural(outlook.next7.vehicles, 'vehicle')}) · 30 days — ${outlook.next30.bookings} (${plural(outlook.next30.vehicles, 'vehicle')})`);
  }
  if (snapshot?.cars.length) {
    const count = (status) => snapshot.cars.filter((c) => c.status === status).length;
    lines.push(`<b>Fleet now:</b> ${count('free')} free · ${count('rent')} rented · ${count('service')} in service`);
  }
  lines.push('');
  if (!problems.length) {
    lines.push('✅ <b>No problems</b>');
  } else {
    lines.push(`⚠️ <b>Problems: ${problems.length}</b>`);
    for (const p of problems.slice(0, MAX_PROBLEMS)) lines.push(`${p.level === 'error' ? '🔴' : '🟡'} ${escapeHtml(p.title)}`);
    if (problems.length > MAX_PROBLEMS) lines.push(`…and ${problems.length - MAX_PROBLEMS} more`);
  }
  lines.push('', `👉 ${escapeHtml(config.staff.url)}`);
  return lines.join('\n');
}

export async function sendMorningSummary() {
  const text = formatSummary(await collectProblems(), bookingOutlook(), getWsSnapshot());
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
