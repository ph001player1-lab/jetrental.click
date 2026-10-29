/**
 * ============================================================================
 * Дашборд сотрудников: проблемы и брони впереди
 * ============================================================================
 * Одни и те же проверки для окна «Проблемы» на сайте сотрудников и для
 * утренней сводки в рабочей группе Telegram (morning.js):
 *   - бронь не выдана: время выдачи прошло больше 3 часов назад;
 *   - долгий сервис: больше 5 дней или без даты окончания;
 *   - машина есть в Автопрокате, но нет в листе Vehicles, и наоборот;
 *   - модель на сайте без цены, фото или описания;
 *   - прайс: госномер без цены, опечатка в строке, сезоны без проверки,
 *     дни года без сезона;
 *   - заявка без ответа дольше 30 минут рабочего времени (10:00–19:00 Бангкок);
 *   - техника: Автопрокат, Google-таблица, рабочая группа, почта.
 * Тексты на английском — как и весь сайт сотрудников.
 * ============================================================================
 */

import * as db from './db.js';
import { getWsSnapshot, wsSyncStatus } from './ws/sync.js';
import { wsEnabled } from './ws/api.js';
import { getFleet, fleetStatus, sheetsEnabled, plateKey } from './fleet.js';
import { getCatalog } from './publicApi.js';
import { getStaffChatId, staffGroupFailure } from './staff.js';
import { mailEnabled, mailFailure } from './mail.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const BANGKOK_MS = 7 * HOUR_MS; // UTC+7, без перехода на летнее время

export const LIMITS = {
  bookingNotIssuedHours: 3,
  longServiceDays: 5,
  requestWaitMinutes: 30,
  workFromHour: 10,
  workToHour: 19,
  syncStaleMinutes: 30
};

const LOAD_DAYS = 14;

/** Начало дня по Бангкоку, в который попадает ms */
export const bangkokDayStart = (ms) => Math.floor((ms + BANGKOK_MS) / DAY_MS) * DAY_MS - BANGKOK_MS;
const bangkokIso = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 10);
const bangkokTime = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(11, 16);
const bangkokDateTime = (ms) => {
  const d = new Date(ms + BANGKOK_MS);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}, ${bangkokTime(ms)}`;
};

/** Минуты рабочего времени (10:00–19:00 по Бангкоку) между from и to */
export function workingMinutes(from, to) {
  let total = 0;
  // Дальше двух недель не считаем: такая заявка и так давно просрочена
  for (let day = bangkokDayStart(Math.max(from, to - 14 * DAY_MS)); day < to; day += DAY_MS) {
    const start = Math.max(from, day + LIMITS.workFromHour * HOUR_MS);
    const end = Math.min(to, day + LIMITS.workToHour * HOUR_MS);
    if (end > start) total += end - start;
  }
  return Math.floor(total / 60000);
}

function ago(ms, now) {
  const hours = Math.floor((now - ms) / HOUR_MS);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const carName = (car) => `${car.model || car.wsModel || 'Vehicle'} · ${car.plate}`;
const parsed = (car) => car.segments.map((s) => ({ kind: s.kind, from: Date.parse(s.from), to: Date.parse(s.to) }));

/* ---------------------------------------------------------------- Проверки */

function vehicleProblems(snapshot, now) {
  const problems = [];
  const windowFrom = Date.parse(snapshot.windowFrom);
  const windowTo = Date.parse(snapshot.windowTo);
  for (const car of snapshot.cars) {
    const current = parsed(car).find((s) => s.from <= now && now < s.to);
    if (!current) continue;
    const target = { tab: 'fleet', q: car.plate };
    // Начало раньше окна снимка — значит, давно (точную дату Автопрокат не отдал)
    const since = current.from <= windowFrom + 60000 ? 'more than a week ago' : ago(current.from, now);
    if (current.kind === 'reserve' && now - current.from >= LIMITS.bookingNotIssuedHours * HOUR_MS) {
      problems.push({
        group: 'bookings', level: 'error', target,
        title: `Booking not issued: ${carName(car)}`,
        detail: `Pickup time was ${current.from <= windowFrom + 60000 ? since : `${bangkokDateTime(current.from)} (${since})`}, but the vehicle is not rented out in Avtoprokat.`
      });
    }
    if (current.kind === 'service') {
      const noEnd = current.to >= windowTo - 60000;
      const long = now - current.from >= LIMITS.longServiceDays * DAY_MS;
      if (noEnd || long) {
        problems.push({
          group: 'service', level: 'warning', target,
          title: `Long service: ${carName(car)}`,
          detail: `In service since ${current.from <= windowFrom + 60000 ? since : `${bangkokDateTime(current.from)} (${since})`}${noEnd ? ', no end date' : `, until ${bangkokDateTime(current.to)}`}.`
        });
      }
    }
  }
  return problems;
}

function matchProblems(snapshot, fleet) {
  const problems = [];
  for (const car of snapshot.cars.filter((c) => !c.model)) {
    problems.push({
      group: 'data', level: 'warning', target: { tab: 'fleet', q: car.plate },
      title: `Not in the Vehicles sheet: ${car.wsModel || 'vehicle'} · ${car.plate}`,
      detail: 'Avtoprokat has this vehicle, but the Vehicles sheet has no row with this plate — it is not on the website and the bots do not offer it.'
    });
  }
  if (!fleet) return problems;
  const wsPlates = new Set(snapshot.cars.map((c) => plateKey(c.plate)));
  for (const unit of fleet.units) {
    const key = plateKey(unit.plate);
    if (!key || wsPlates.has(key)) continue;
    problems.push({
      group: 'data', level: 'warning',
      title: `Not in Avtoprokat: ${unit.model || 'vehicle'} · ${unit.plate}`,
      detail: 'The Vehicles sheet has this plate, but Avtoprokat does not — check the plate or remove the row.'
    });
  }
  return problems;
}

async function websiteProblems(fleet) {
  const problems = [];
  if (!fleet) return problems;
  const unitModels = new Set(fleet.units.map((u) => u.model).filter(Boolean));
  for (const model of unitModels) {
    if (fleet.catalog.has(model)) continue;
    problems.push({
      group: 'website', level: 'warning', target: { tab: 'site', q: model },
      title: `Not in the Catalog sheet: ${model}`,
      detail: 'Vehicles of this model are in the fleet, but the Catalog sheet has no row for it — it is not on the website.'
    });
  }
  const { models } = await getCatalog();
  for (const m of models) {
    const missing = [!m.priceFrom && 'price', !m.photo && 'photo', !m.description && 'description'].filter(Boolean);
    if (!missing.length) continue;
    problems.push({
      group: 'website', level: 'warning', target: { tab: 'site', q: m.model },
      title: `${m.model}: no ${missing.join(', ')} on the website`,
      detail: missing.includes('price') ? 'Clients see “price on request”. Add the price in the Catalog sheet or the price lists.' : 'Add it in the Website tab.'
    });
  }
  return problems;
}

/** Дни года (ММ-ДД) без сезона, подряд идущие — одним диапазоном */
function seasonGaps(seasons) {
  const covered = (md) => seasons.some((s) => (s.from <= s.to ? s.from <= md && md <= s.to : md >= s.from || md <= s.to));
  const gaps = [];
  let start = null;
  let prev = null;
  // 2024 — високосный: проверяем и 29 февраля
  for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2025, 0, 1); ms += DAY_MS) {
    const md = new Date(ms).toISOString().slice(5, 10);
    if (!covered(md)) {
      if (!start) start = md;
      prev = md;
    } else if (start) {
      gaps.push([start, prev]);
      start = null;
    }
  }
  if (start) gaps.push([start, prev]);
  return gaps;
}

const dm = (md) => `${md.slice(3)}.${md.slice(0, 2)}`;

function priceProblems(fleet) {
  const problems = [];
  const pricing = fleet?.pricing;
  if (!pricing) return problems;
  const sheets = [...new Set(pricing.seasons.map((s) => s.sheet))];
  for (const unit of fleet.units) {
    const plate = plateKey(unit.plate);
    if (!plate) continue;
    const missing = sheets.filter((sheet) => !pricing.prices.get(sheet)?.has(plate));
    const typos = sheets.filter((sheet) => pricing.prices.get(sheet)?.get(plate)?.suspicious);
    const name = `${unit.model || 'vehicle'} · ${unit.plate}`;
    if (missing.length) {
      problems.push({
        group: 'prices', level: 'warning', target: { tab: 'fleet', q: unit.plate },
        title: `No price: ${name}`,
        detail: `This plate is missing in ${missing.map((s) => `“${s}”`).join(', ')}.`
      });
    }
    if (typos.length) {
      problems.push({
        group: 'prices', level: 'warning', target: { tab: 'fleet', q: unit.plate },
        title: `Typo in the price row: ${name}`,
        detail: `In ${typos.map((s) => `“${s}”`).join(', ')} the daily price grows with a longer rental or drops more than 3 times — the bots do not use this row.`
      });
    }
  }
  for (const name of [...new Set(pricing.seasons.filter((s) => !s.verified).map((s) => s.name))]) {
    problems.push({
      group: 'prices', level: 'warning',
      title: `Prices not verified: ${name} season`,
      detail: 'For these dates clients see “from …” prices only. Put “Да” in “Цены проверены” on the Сезоны sheet when the prices are checked.'
    });
  }
  for (const [from, to] of seasonGaps(pricing.seasons)) {
    problems.push({
      group: 'prices', level: 'warning',
      title: `No season for ${from === to ? dm(from) : `${dm(from)}–${dm(to)}`}`,
      detail: 'These days are not covered on the Сезоны sheet — exact prices cannot be calculated for them.'
    });
  }
  return problems;
}

function requestProblems(now) {
  const problems = [];
  for (const r of db.listActiveRequests()) {
    if (r.status !== 'new') continue;
    const created = Date.parse(r.created_at);
    const what = `#${r.id}${r.model ? ` · ${r.model}` : ''}${r.client_name ? ` · ${r.client_name}` : ''}`;
    if (!r.staff_message_id) {
      problems.push({
        group: 'requests', level: 'error', target: { tab: 'requests' },
        title: `Request not delivered to the staff group: ${what}`,
        detail: `Received ${bangkokDateTime(created)}. Open the Requests tab and answer the client.`
      });
      continue;
    }
    const waited = workingMinutes(created, now);
    if (waited >= LIMITS.requestWaitMinutes) {
      problems.push({
        group: 'requests', level: 'error', target: { tab: 'requests' },
        title: `No answer to request ${what}`,
        detail: `Waiting ${waited >= 120 ? `${Math.floor(waited / 60)} h ${waited % 60} min` : `${waited} min`} of working time (since ${bangkokDateTime(created)}). Press “Take” in the staff group.`
      });
    }
  }
  return problems;
}

function systemProblems(now) {
  const problems = [];
  const sync = wsSyncStatus();
  if (!wsEnabled) {
    problems.push({ group: 'system', level: 'error', title: 'Avtoprokat is not connected', detail: 'WS_API_URL / WS_API_USER / WS_API_PASSWORD are not set on the server.' });
  } else if (!sync.lastSyncAt) {
    problems.push({ group: 'system', level: 'error', title: 'No data from Avtoprokat yet', detail: sync.error ? `Last error: ${sync.error}` : 'The first sync is still running.' });
  } else {
    const age = Math.round((now - Date.parse(sync.lastSyncAt)) / 60000);
    if (age >= LIMITS.syncStaleMinutes) {
      problems.push({ group: 'system', level: 'error', title: `Avtoprokat data is ${age} min old`, detail: sync.error ? `Sync error: ${sync.error}` : 'The sync runs every 10 minutes — check the server.' });
    } else if (sync.error) {
      problems.push({ group: 'system', level: 'warning', title: 'Last Avtoprokat sync failed', detail: sync.error });
    }
  }
  const sheets = fleetStatus();
  if (!sheetsEnabled) problems.push({ group: 'system', level: 'error', title: 'Google Sheets is not connected', detail: 'GOOGLE_SHEET_ID / service account are not set on the server.' });
  else if (sheets.error) problems.push({ group: 'system', level: 'error', title: 'Google Sheets error', detail: `${sheets.error} — the server works on the last loaded data.` });
  if (!getStaffChatId()) {
    problems.push({ group: 'system', level: 'error', title: 'Staff group is not connected', detail: 'New requests do not reach Telegram. Send /bind in the staff group.' });
  } else if (staffGroupFailure()) {
    const f = staffGroupFailure();
    problems.push({ group: 'system', level: 'error', title: 'Could not send to the staff group', detail: `${bangkokDateTime(Date.parse(f.at))}: ${f.message}` });
  }
  if (!mailEnabled) problems.push({ group: 'system', level: 'warning', title: 'Email is not set up', detail: 'Login codes for this site cannot be sent (RESEND_API_KEY).' });
  else if (mailFailure()) problems.push({ group: 'system', level: 'warning', title: 'Last login email failed', detail: `${bangkokDateTime(Date.parse(mailFailure().at))}: ${mailFailure().message}` });
  return problems;
}

const GROUP_ORDER = ['system', 'requests', 'bookings', 'service', 'data', 'prices', 'website'];

/** Все проблемы, сначала важные: [{ group, level, title, detail, target? }] */
export async function collectProblems(now = Date.now()) {
  const snapshot = getWsSnapshot();
  const fleet = sheetsEnabled ? await getFleet().catch(() => null) : null;
  const problems = [
    ...systemProblems(now),
    ...requestProblems(now),
    ...(snapshot ? vehicleProblems(snapshot, now) : []),
    ...(snapshot ? matchProblems(snapshot, fleet) : []),
    ...priceProblems(fleet),
    ...(await websiteProblems(fleet).catch(() => []))
  ];
  return problems.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)
    || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

/* ------------------------------------------------------------ Брони впереди */

/**
 * Брони и загрузка парка по снимку Автопроката. Две брони одной машины встык
 * Автопрокат отдаёт одним куском — поэтому считаем и машины, и дни.
 */
export function bookingOutlook(now = Date.now()) {
  const snapshot = getWsSnapshot();
  if (!snapshot) return null;
  const cars = snapshot.cars.map((car) => ({ car, segments: parsed(car) }));
  const ahead = (days) => {
    const until = now + days * DAY_MS;
    const found = cars.flatMap(({ car, segments }) => segments
      .filter((s) => s.kind === 'reserve' && s.from > now && s.from <= until).map(() => car.id));
    return { bookings: found.length, vehicles: new Set(found).size };
  };
  const overlap = (s, from, to) => Math.max(0, Math.min(s.to, to) - Math.max(s.from, from));
  const until30 = now + 30 * DAY_MS;
  const bookedMs = cars.reduce((sum, { segments }) => sum + segments
    .filter((s) => s.kind === 'reserve').reduce((acc, s) => acc + overlap(s, now, until30), 0), 0);

  const todayStart = bangkokDayStart(now);
  const todayEnd = todayStart + DAY_MS;
  const today = { pickups: 0, returns: 0 };
  for (const { segments } of cars) {
    for (const s of segments) {
      if (s.kind === 'reserve' && s.from >= todayStart && s.from < todayEnd) today.pickups++;
      if (s.kind === 'rent' && s.to >= todayStart && s.to < todayEnd) today.returns++;
    }
  }

  // Загрузка по дням: доля «машино-часов» в аренде, в брони и в сервисе
  const capacity = Math.max(1, cars.length) * DAY_MS;
  const load = Array.from({ length: LOAD_DAYS }, (_, i) => {
    const from = todayStart + i * DAY_MS;
    const to = from + DAY_MS;
    const share = (kind) => Math.round((cars.reduce((sum, { segments }) => sum + segments
      .filter((s) => s.kind === kind).reduce((acc, s) => acc + overlap(s, from, to), 0), 0) / capacity) * 100);
    return { date: bangkokIso(from), rent: share('rent'), reserve: share('reserve'), service: share('service') };
  });

  return {
    vehicles: cars.length,
    waitingNow: cars.filter(({ segments }) => segments.some((s) => s.kind === 'reserve' && s.from <= now && now < s.to)).length,
    next7: ahead(7),
    next30: ahead(30),
    bookedDays30: Math.round(bookedMs / DAY_MS),
    today,
    load
  };
}
