/**
 * ============================================================================
 * Снимок данных WS.Автопрокат (копию в Google-таблицу больше не пишем — всё в портале)
 * ============================================================================
 * Каждые N минут (WS_SYNC_MINUTES, по умолчанию 10): все машины, что с ними
 * сейчас (свободна / аренда / бронь / сервис), когда освободится, залог,
 * тарифы и занятость на 30 дней вперёд. Снимок держим в памяти — его
 * показывает сайт для сотрудников. Модель для клиента и тип подтягиваются
 * из парка портала по госномеру — так видно машины, которых нет в парке.
 * ============================================================================
 */

import { config } from '../config.js';
import * as ws from './api.js';
import { carSegments, statusAt, freeFromAt, isFreeBetween, mapLimit } from './timeline.js';
import { getFleet, plateKey } from '../fleet.js';
import { recordWsSnapshot } from '../journal/wsHistory.js';
import { isSold, rememberSoldModels } from '../sold.js';

const DAY_MS = 86400000;
// 20 дней назад — чтобы видеть, что машина в ремонте дольше 15 дней или давно ждёт выдачи по брони
const WINDOW_BACK_DAYS = 20;
const WINDOW_DAYS = 30;
// Сколько запросов к Автопрокату одновременно (по 3 на машину)
const CONCURRENCY = 4;

const status = { enabled: ws.wsEnabled, lastSyncAt: null, cars: 0, unmatched: 0, error: null };
let snapshot = null;
let running = null;

async function buildSnapshot(now) {
  const windowFrom = now - WINDOW_BACK_DAYS * DAY_MS;
  const windowTo = now + WINDOW_DAYS * DAY_MS;
  const [cars, tariffs, fleet] = await Promise.all([
    ws.getCars(),
    ws.getTariffs(),
    getFleet().catch(() => null)
  ]);
  const unitsByPlate = new Map((fleet?.units || []).map((u) => [plateKey(u.plate), u]));
  // Модель проданной машины запоминаем, пока она есть в WS (саму машину убирает getWsSnapshot)
  rememberSoldModels([], cars);
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

async function runSync() {
  try {
    snapshot = await buildSnapshot(Date.now());
    // Дальше — без проданных машин (отметка в портале; «Вернуть в парк» действует сразу)
    const snap = getWsSnapshot();
    // Когда в WS менялись статусы машин — для сверки с рабочей группой
    try { recordWsSnapshot(snap, Date.parse(snap.updatedAt)); } catch (err) { console.error('WS history failed:', err.message); }
    Object.assign(status, {
      lastSyncAt: snap.updatedAt,
      cars: snap.cars.length,
      unmatched: snap.cars.filter((c) => !c.model).length,
      error: null
    });
    // Копию в лист «Автопрокат» больше не пишем — ушли от Google-таблицы (всё в портале)
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

/** Последний снимок парка из Автопроката (null — ещё не загружен); отмеченные проданными — сразу без них */
export function getWsSnapshot() {
  if (!snapshot || !snapshot.cars.some((c) => isSold(c.plate))) return snapshot;
  return { ...snapshot, cars: snapshot.cars.filter((c) => !isSold(c.plate)) };
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
