/**
 * ============================================================================
 * Снимок данных WS.Автопрокат + копия в Google-таблицу (лист «Автопрокат»)
 * ============================================================================
 * Каждые N минут (WS_SYNC_MINUTES, по умолчанию 10): все машины, что с ними
 * сейчас (свободна / аренда / бронь / сервис), когда освободится, залог,
 * тарифы и занятость на 30 дней вперёд. Снимок держим в памяти — его
 * показывает сайт для сотрудников; в таблицу пишем краткую версию.
 * Модель для клиента и тип подтягиваются из листа Vehicles по госномеру —
 * так видно машины, которые ещё не сопоставлены (пустые колонки D–E).
 * ============================================================================
 */

import { config } from '../config.js';
import * as ws from './api.js';
import { carSegments, statusAt, freeFromAt, isFreeBetween, mapLimit } from './timeline.js';
import { getFleet, plateKey } from '../fleet.js';
import { sheetsEnabled, ensureSheet, updateRange, clearRange } from '../google/sheets.js';

const SHEET = 'Автопрокат';
const HEADERS = [
  'ID в Автопрокате', 'Госномер', 'Модель в Автопрокате', 'Модель для клиента', 'Тип',
  'Сейчас', 'Свободна с', 'Свободна ближайшие 7 дней', 'Залог ฿', 'Тарифы ฿/день', 'Обновлено'
];
const DAY_MS = 86400000;
// 20 дней назад — чтобы видеть, что машина в ремонте дольше 15 дней или давно ждёт выдачи по брони
const WINDOW_BACK_DAYS = 20;
const WINDOW_DAYS = 30;
// Сколько запросов к Автопрокату одновременно (по 3 на машину)
const CONCURRENCY = 4;
const TYPE_LABELS = { scooter: 'Скутер', motorcycle: 'Мотоцикл', car: 'Авто' };
const STATUS_LABELS = { free: 'Свободна', rent: 'Аренда', reserve: 'Бронь', service: 'Сервис' };

const status = { enabled: ws.wsEnabled, lastSyncAt: null, cars: 0, unmatched: 0, error: null };
let sheetReady = false;
let snapshot = null;
let running = null;

/** Дата-время в часовом поясе Бангкока: '27.10.2026 14:05' */
function bangkokDateTime(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

function formatTariffs(tariffs) {
  return tariffs.map((t) => `${t.min}–${t.max >= 999 ? '∞' : t.max} дн: ${t.cost}`).join('; ');
}

async function buildSnapshot(now) {
  const windowFrom = now - WINDOW_BACK_DAYS * DAY_MS;
  const windowTo = now + WINDOW_DAYS * DAY_MS;
  const [cars, tariffs, fleet] = await Promise.all([
    ws.getCars(),
    ws.getTariffs(),
    sheetsEnabled ? getFleet().catch(() => null) : null
  ]);
  const unitsByPlate = new Map((fleet?.units || []).map((u) => [plateKey(u.plate), u]));
  const sorted = [...cars].sort((a, b) => String(a.model).localeCompare(String(b.model)));
  const timelines = await mapLimit(sorted, CONCURRENCY, (car) => carSegments(car.car_id, windowFrom, windowTo));

  const items = sorted.map((car, i) => {
    const unit = unitsByPlate.get(plateKey(car.number));
    const segments = timelines[i];
    const entry = tariffs.get(car.car_id);
    const freeFrom = freeFromAt(segments, now, windowTo);
    return {
      id: car.car_id,
      plate: String(car.number || ''),
      wsModel: String(car.model || ''),
      model: unit?.model || '',
      type: unit?.type || null,
      status: statusAt(segments, now),
      // null — свободна сейчас; 'later' — занята дольше окна
      freeFrom: freeFrom === null ? null : freeFrom === Infinity ? 'later' : new Date(freeFrom).toISOString(),
      freeWeek: isFreeBetween(segments, now, now + 7 * DAY_MS),
      deposit: entry?.deposit || null,
      tariffs: (entry?.tariffs || []).filter((t) => !t.is_hours).map(({ min, max, cost }) => ({ min, max, cost })),
      segments: segments.map((s) => ({ kind: s.kind, from: new Date(s.from).toISOString(), to: new Date(s.to).toISOString() }))
    };
  });

  return {
    updatedAt: new Date(now).toISOString(),
    windowFrom: new Date(windowFrom).toISOString(),
    windowTo: new Date(windowTo).toISOString(),
    cars: items
  };
}

function sheetRows(snap) {
  const updated = bangkokDateTime(new Date(snap.updatedAt));
  return snap.cars.map((car) => [
    car.id,
    `'${car.plate}`,
    car.wsModel,
    car.model,
    TYPE_LABELS[car.type] || '',
    STATUS_LABELS[car.status],
    car.freeFrom === null ? '' : car.freeFrom === 'later' ? `позже ${WINDOW_DAYS} дней` : bangkokDateTime(new Date(car.freeFrom)),
    car.freeWeek ? 'Да' : 'Нет',
    car.deposit || '',
    formatTariffs(car.tariffs),
    updated
  ]);
}

async function writeSheet(snap) {
  if (!sheetReady) {
    await ensureSheet(SHEET, HEADERS);
    sheetReady = true;
  }
  const rows = sheetRows(snap);
  if (rows.length) await updateRange(`'${SHEET}'!A2`, rows);
  await clearRange(`'${SHEET}'!A${rows.length + 2}:K`);
}

async function runSync() {
  try {
    const snap = await buildSnapshot(Date.now());
    snapshot = snap;
    Object.assign(status, {
      lastSyncAt: snap.updatedAt,
      cars: snap.cars.length,
      unmatched: snap.cars.filter((c) => !c.model).length,
      error: null
    });
    if (sheetsEnabled) await writeSheet(snap);
  } catch (err) {
    status.error = err.message;
    console.error('WS sync failed:', err.message);
  }
}

/** Синхронизация; если она уже идёт — ждём её же, а не запускаем вторую */
export function syncWs() {
  if (!ws.wsEnabled) return Promise.resolve();
  if (!running) running = runSync().finally(() => { running = null; });
  return running;
}

/** Последний снимок парка из Автопроката (null — ещё не загружен) */
export function getWsSnapshot() {
  return snapshot;
}

export function startWsSync() {
  if (!ws.wsEnabled) {
    console.log('WS.Avtoprokat disabled: WS_API_URL / WS_API_USER / WS_API_PASSWORD are not set');
    return;
  }
  syncWs();
  setInterval(syncWs, config.ws.syncMinutes * 60 * 1000).unref();
}

export function wsSyncStatus() {
  return { ...status };
}
