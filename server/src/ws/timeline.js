/**
 * ============================================================================
 * Занятость машины по видам: аренда, бронь, сервис
 * ============================================================================
 * API отдаёт только СВОБОДНЫЕ окна (car_period_list) с флагами «учитывая
 * брони» и «учитывая сервисы». Запрашиваем три раза с разными флагами и
 * вычитаем одно из другого:
 *   аренды  = всё, что не свободно без учёта броней и сервисов;
 *   брони   = занято с учётом броней, но не арендами;
 *   сервисы = остальное занятое.
 * ============================================================================
 */

import * as ws from './api.js';

/** '2026-11-01 05:00' / '2026-11-01 05:00:00Z' / ISO → миллисекунды (время API — UTC) */
export function parseWsTime(value) {
  const text = String(value || '').trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const ms = Date.parse(text.replace(' ', 'T'));
    if (!Number.isNaN(ms)) return ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
}

function toIntervals(periods, from, to) {
  return periods
    .map((p) => [Math.max(parseWsTime(p.begin), from), Math.min(parseWsTime(p.end), to)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
}

/** Занятые интервалы = окно минус свободные */
function complement(free, from, to) {
  const busy = [];
  let cursor = from;
  for (const [a, b] of free) {
    if (a > cursor) busy.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < to) busy.push([cursor, to]);
  return busy;
}

/** Интервалы A без пересечений с B */
function subtract(a, b) {
  const result = [];
  for (const [start, end] of a) {
    let pieces = [[start, end]];
    for (const [bs, be] of b) {
      pieces = pieces.flatMap(([ps, pe]) => {
        if (be <= ps || bs >= pe) return [[ps, pe]];
        return [[ps, bs], [be, pe]].filter(([x, y]) => y > x);
      });
    }
    result.push(...pieces);
  }
  return result;
}

/**
 * Занятость машины в окне [from, to] (мс): отсортированный список
 * { kind: 'rent' | 'reserve' | 'service', from, to } (мс).
 */
export async function carSegments(carId, from, to) {
  const begin = ws.formatUtc(new Date(from));
  const end = ws.formatUtc(new Date(to));
  const [freeAll, freeNoServices, freeRentsOnly] = await Promise.all([
    ws.getCarFreePeriods(carId, begin, end, { reserves: true, idles: true }),
    ws.getCarFreePeriods(carId, begin, end, { reserves: true, idles: false }),
    ws.getCarFreePeriods(carId, begin, end, { reserves: false, idles: false })
  ]);

  const busyAll = complement(toIntervals(freeAll, from, to), from, to);
  const busyRentReserve = complement(toIntervals(freeNoServices, from, to), from, to);
  const rents = complement(toIntervals(freeRentsOnly, from, to), from, to);
  const reserves = subtract(busyRentReserve, rents);
  const services = subtract(busyAll, busyRentReserve);

  return [
    ...rents.map(([a, b]) => ({ kind: 'rent', from: a, to: b })),
    ...reserves.map(([a, b]) => ({ kind: 'reserve', from: a, to: b })),
    ...services.map(([a, b]) => ({ kind: 'service', from: a, to: b }))
  ]
    // Кусочки короче минуты — артефакты округления границ, не показываем
    .filter((s) => s.to - s.from >= 60000)
    .sort((x, y) => x.from - y.from);
}

/** Что с машиной в момент now: 'free' или вид занятости */
export function statusAt(segments, now) {
  return segments.find((s) => s.from <= now && now < s.to)?.kind || 'free';
}

/**
 * Когда машина освободится, если занята в момент now: конец цепочки
 * идущих подряд занятостей. null — свободна сейчас; Infinity — занята
 * до конца окна.
 */
export function freeFromAt(segments, now, windowEnd) {
  if (statusAt(segments, now) === 'free') return null;
  let until = now;
  for (const s of segments) {
    if (s.to <= until) continue;
    if (s.from > until + 60000) break;
    until = Math.max(until, s.to);
  }
  return until >= windowEnd - 60000 ? Infinity : until;
}

export function isFreeBetween(segments, from, to) {
  return !segments.some((s) => s.from < to && s.to > from);
}

/** Выполняет fn для элементов списка, не больше limit одновременно */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
