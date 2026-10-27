/**
 * Копия заявок в Google-таблице (лист Requests), чтобы их видели люди.
 * Ошибки Google не ломают работу бота — заявка всё равно сохранена в SQLite.
 */

import * as db from './db.js';
import { sheetsEnabled, ensureSheet, appendRow, updateRange } from './google/sheets.js';
import { VEHICLE_TYPES, daysBetween } from './format.js';
import { config } from './config.js';

const REQUESTS_SHEET = 'Requests';
const HEADERS = [
  '№', 'Создана', 'Канал', 'Клиент', 'Телефон', 'Тип', 'Модель',
  'С', 'По', 'Дней', 'Оценка ฿', 'Статус', 'Взял(а)', 'Взята'
];
const STATUS_LABELS = { new: 'Новая', taken: 'В работе' };
const CHANNEL_LABELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', site: 'Сайт', test: 'Тест' };

let sheetReady = false;

/** '2026-11-05' → '05.11.2026' (таблица в русской локали поймёт это как дату) */
const sheetDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

function sheetDateTime(isoDateTime) {
  if (!isoDateTime) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(isoDateTime)).map((p) => [p.type, p.value])
  );
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

async function prepareSheet() {
  if (sheetReady) return;
  await ensureSheet(REQUESTS_SHEET, HEADERS);
  sheetReady = true;
}

export async function mirrorNewRequest(request) {
  if (!sheetsEnabled) return;
  try {
    await prepareSheet();
    const days = request.date_from && request.date_to ? daysBetween(request.date_from, request.date_to) : '';
    const row = await appendRow(REQUESTS_SHEET, [
      request.id,
      sheetDateTime(request.created_at),
      CHANNEL_LABELS[request.channel] || request.channel,
      request.client_name || '',
      // Апостроф — чтобы таблица не превратила «+66...» в число
      request.client_phone ? `'${request.client_phone}` : '',
      VEHICLE_TYPES[request.vehicle_type]?.label || '',
      request.model || '',
      sheetDate(request.date_from),
      sheetDate(request.date_to),
      days,
      request.estimate_thb || '',
      STATUS_LABELS[request.status] || request.status,
      request.taken_by_name || '',
      sheetDateTime(request.taken_at)
    ]);
    if (row) db.setSheetRow(request.id, row);
  } catch (err) {
    console.error(`Request #${request.id}: sheet mirror failed:`, err.message);
  }
}

export async function mirrorRequestStatus(request) {
  if (!sheetsEnabled || !request.sheet_row) return;
  try {
    await updateRange(`'${REQUESTS_SHEET}'!L${request.sheet_row}:N${request.sheet_row}`, [[
      STATUS_LABELS[request.status] || request.status,
      request.taken_by_name || '',
      sheetDateTime(request.taken_at)
    ]]);
  } catch (err) {
    console.error(`Request #${request.id}: sheet status update failed:`, err.message);
  }
}
