/**
 * ============================================================================
 * Копия данных WS.Автопрокат в Google-таблицу (лист «Автопрокат»)
 * ============================================================================
 * Каждые N минут (WS_SYNC_MINUTES, по умолчанию 10): все машины, свободна ли
 * сейчас, с какого момента освободится, залог и тарифы. Модель для клиента и
 * тип подтягиваются из листа Vehicles по госномеру — так видно машины,
 * которые ещё не сопоставлены (пустые колонки D–E).
 * ============================================================================
 */

import { config } from '../config.js';
import * as ws from './api.js';
import { getFleet, plateKey } from '../fleet.js';
import { sheetsEnabled, ensureSheet, updateRange, clearRange } from '../google/sheets.js';

const SHEET = 'Автопрокат';
const HEADERS = [
  'ID в Автопрокате', 'Госномер', 'Модель в Автопрокате', 'Модель для клиента', 'Тип',
  'Сейчас', 'Свободна с', 'Свободна ближайшие 7 дней', 'Залог ฿', 'Тарифы ฿/день', 'Обновлено'
];
const LOOKAHEAD_DAYS = 60;
const TYPE_LABELS = { scooter: 'Скутер', motorcycle: 'Мотоцикл', car: 'Авто' };

const status = { enabled: ws.wsEnabled, lastSyncAt: null, cars: 0, unmatched: 0, error: null };
let sheetReady = false;

/** Дата-время в часовом поясе Бангкока: '27.10.2026 14:05' */
function bangkokDateTime(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

function formatTariffs(entry) {
  if (!entry || entry.tariffs.length === 0) return '';
  return entry.tariffs
    .filter((t) => !t.is_hours)
    .map((t) => `${t.min}–${t.max >= 999 ? '∞' : t.max} дн: ${t.cost}`)
    .join('; ');
}

/** Когда освободится занятая сейчас машина (первое свободное окно в ближайшие 60 дней) */
async function freeSince(carId, now) {
  const periods = await ws.getCarFreePeriods(
    carId,
    ws.formatUtc(now),
    ws.formatUtc(new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000))
  );
  const first = periods.map((p) => new Date(p.begin)).filter((d) => !isNaN(d)).sort((a, b) => a - b)[0];
  return first ? bangkokDateTime(first) : `позже ${LOOKAHEAD_DAYS} дней`;
}

export async function syncWsToSheet() {
  if (!ws.wsEnabled || !sheetsEnabled) return;

  try {
    const now = new Date();
    const [cars, tariffs, freeNow, freeWeek, fleet] = await Promise.all([
      ws.getCars(),
      ws.getTariffs(),
      ws.getFreeCarIds(ws.formatUtc(now), ws.formatUtc(new Date(now.getTime() + 2 * 3600000))),
      ws.getFreeCarIds(ws.formatUtc(now), ws.formatUtc(new Date(now.getTime() + 7 * 86400000))),
      getFleet()
    ]);
    const unitsByPlate = new Map(fleet.units.map((u) => [plateKey(u.plate), u]));

    const rows = [];
    let unmatched = 0;
    for (const car of [...cars].sort((a, b) => String(a.model).localeCompare(String(b.model)))) {
      const unit = unitsByPlate.get(plateKey(car.number));
      if (!unit) unmatched++;
      const isFree = freeNow.has(car.car_id);
      const entry = tariffs.get(car.car_id);
      rows.push([
        car.car_id,
        `'${car.number || ''}`,
        car.model || '',
        unit?.model || '',
        TYPE_LABELS[unit?.type] || '',
        isFree ? 'Свободна' : 'Занята',
        isFree ? '' : await freeSince(car.car_id, now),
        freeWeek.has(car.car_id) ? 'Да' : 'Нет',
        entry?.deposit || '',
        formatTariffs(entry),
        bangkokDateTime(now)
      ]);
    }

    if (!sheetReady) {
      await ensureSheet(SHEET, HEADERS);
      sheetReady = true;
    }
    if (rows.length) await updateRange(`'${SHEET}'!A2`, rows);
    await clearRange(`'${SHEET}'!A${rows.length + 2}:K`);

    Object.assign(status, { lastSyncAt: now.toISOString(), cars: cars.length, unmatched, error: null });
  } catch (err) {
    status.error = err.message;
    console.error('WS → sheet sync failed:', err.message);
  }
}

export function startWsSync() {
  if (!ws.wsEnabled) {
    console.log('WS.Avtoprokat disabled: WS_API_URL / WS_API_USER / WS_API_PASSWORD are not set');
    return;
  }
  syncWsToSheet();
  setInterval(syncWsToSheet, config.ws.syncMinutes * 60 * 1000).unref();
}

export function wsSyncStatus() {
  return { ...status };
}
