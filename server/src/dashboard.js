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
 * Тексты — на языке сайта сотрудников (dashboardTexts.js), сводка — на английском.
 * ============================================================================
 */

import * as db from './db.js';
import { getWsSnapshot, wsSyncStatus } from './ws/sync.js';
import { wsEnabled } from './ws/api.js';
import { getFleet, fleetStatus, sheetsEnabled, plateKey } from './fleet.js';
import { getCatalog } from './publicApi.js';
import { getStaffChatId, staffGroupFailure } from './staff.js';
import { mailEnabled, mailFailure } from './mail.js';
import { dashboardTranslator } from './dashboardTexts.js';

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

const carName = (car) => `${car.model || car.wsModel || 'Vehicle'} · ${car.plate}`;
const parsed = (car) => car.segments.map((s) => ({ kind: s.kind, from: Date.parse(s.from), to: Date.parse(s.to) }));

/* ---------------------------------------------------------------- Проверки */

/** «29 Oct, 13:27 (12 h ago)»; начало раньше окна снимка — «больше недели назад» */
function since(tx, ms, now, windowFrom) {
  if (ms <= windowFrom + 60000) return tx.t('time.weekAgo');
  const hours = Math.floor((now - ms) / HOUR_MS);
  const ago = hours < 48 ? tx.t('time.hoursAgo', { n: hours }) : tx.t('time.daysAgo', { n: Math.floor(hours / 24) });
  return tx.t('time.at', { date: tx.dateTime(ms), ago });
}

function vehicleProblems(tx, snapshot, now) {
  const problems = [];
  const windowFrom = Date.parse(snapshot.windowFrom);
  const windowTo = Date.parse(snapshot.windowTo);
  for (const car of snapshot.cars) {
    const current = parsed(car).find((s) => s.from <= now && now < s.to);
    if (!current) continue;
    const target = { tab: 'fleet', q: car.plate };
    if (current.kind === 'reserve' && now - current.from >= LIMITS.bookingNotIssuedHours * HOUR_MS) {
      problems.push({
        group: 'bookings', level: 'error', target,
        title: tx.t('bookingNotIssued.title', { car: carName(car) }),
        detail: tx.t('bookingNotIssued.detail', { when: since(tx, current.from, now, windowFrom) })
      });
    }
    if (current.kind === 'service') {
      const noEnd = current.to >= windowTo - 60000;
      const long = now - current.from >= LIMITS.longServiceDays * DAY_MS;
      if (noEnd || long) {
        problems.push({
          group: 'service', level: 'warning', target,
          title: tx.t('longService.title', { car: carName(car) }),
          detail: tx.t('longService.detail', {
            when: since(tx, current.from, now, windowFrom),
            end: noEnd ? tx.t('longService.noEnd') : tx.t('longService.until', { until: tx.dateTime(current.to) })
          })
        });
      }
    }
  }
  return problems;
}

function matchProblems(tx, snapshot, fleet) {
  const problems = [];
  for (const car of snapshot.cars.filter((c) => !c.model)) {
    problems.push({
      group: 'data', level: 'warning', target: { tab: 'fleet', q: car.plate },
      title: tx.t('notInSheet.title', { car: `${car.wsModel || 'Vehicle'} · ${car.plate}` }),
      detail: tx.t('notInSheet.detail')
    });
  }
  if (!fleet) return problems;
  const wsPlates = new Set(snapshot.cars.map((c) => plateKey(c.plate)));
  for (const unit of fleet.units) {
    const key = plateKey(unit.plate);
    if (!key || wsPlates.has(key)) continue;
    problems.push({
      group: 'data', level: 'warning',
      title: tx.t('notInWs.title', { car: `${unit.model || 'Vehicle'} · ${unit.plate}` }),
      detail: tx.t('notInWs.detail')
    });
  }
  return problems;
}

async function websiteProblems(tx, fleet) {
  const problems = [];
  if (!fleet) return problems;
  const unitModels = new Set(fleet.units.map((u) => u.model).filter(Boolean));
  for (const model of unitModels) {
    if (fleet.catalog.has(model)) continue;
    problems.push({
      group: 'website', level: 'warning', target: { tab: 'site', q: model },
      title: tx.t('notInCatalog.title', { model }),
      detail: tx.t('notInCatalog.detail')
    });
  }
  const { models } = await getCatalog();
  for (const m of models) {
    const missing = [!m.priceFrom && 'price', !m.photo && 'photo', !m.description && 'description'].filter(Boolean);
    if (!missing.length) continue;
    problems.push({
      group: 'website', level: 'warning', target: { tab: 'site', q: m.model },
      title: tx.t('website.title', { model: m.model, missing: missing.map((k) => tx.t(`missing.${k}`)).join(tx.t('list.sep')) }),
      detail: tx.t(missing.includes('price') ? 'website.detailPrice' : 'website.detailOther')
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

function priceProblems(tx, fleet) {
  const problems = [];
  const pricing = fleet?.pricing;
  if (!pricing) return problems;
  const sheets = [...new Set(pricing.seasons.map((s) => s.sheet))];
  const quoted = (list) => list.map((s) => `“${s}”`).join(tx.t('list.sep'));
  for (const unit of fleet.units) {
    const plate = plateKey(unit.plate);
    if (!plate) continue;
    const missing = sheets.filter((sheet) => !pricing.prices.get(sheet)?.has(plate));
    const typos = sheets.filter((sheet) => pricing.prices.get(sheet)?.get(plate)?.suspicious);
    const car = `${unit.model || 'Vehicle'} · ${unit.plate}`;
    if (missing.length) {
      problems.push({
        group: 'prices', level: 'warning', target: { tab: 'fleet', q: unit.plate },
        title: tx.t('noPrice.title', { car }),
        detail: tx.t('noPrice.detail', { sheets: quoted(missing) })
      });
    }
    if (typos.length) {
      problems.push({
        group: 'prices', level: 'warning', target: { tab: 'fleet', q: unit.plate },
        title: tx.t('typo.title', { car }),
        detail: tx.t('typo.detail', { sheets: quoted(typos) })
      });
    }
  }
  for (const name of [...new Set(pricing.seasons.filter((s) => !s.verified).map((s) => s.name))]) {
    const label = tx.t(`season.${name}`);
    problems.push({
      group: 'prices', level: 'warning',
      title: tx.t('unverified.title', { name: label === `season.${name}` ? name : label }),
      detail: tx.t('unverified.detail')
    });
  }
  for (const [from, to] of seasonGaps(pricing.seasons)) {
    problems.push({
      group: 'prices', level: 'warning',
      title: tx.t('seasonGap.title', { range: from === to ? dm(from) : `${dm(from)}–${dm(to)}` }),
      detail: tx.t('seasonGap.detail')
    });
  }
  return problems;
}

function requestProblems(tx, now) {
  const problems = [];
  for (const r of db.listActiveRequests()) {
    if (r.status !== 'new') continue;
    const created = Date.parse(r.created_at);
    const what = `#${r.id}${r.model ? ` · ${r.model}` : ''}${r.client_name ? ` · ${r.client_name}` : ''}`;
    if (!r.staff_message_id) {
      problems.push({
        group: 'requests', level: 'error', target: { tab: 'requests' },
        title: tx.t('notDelivered.title', { what }),
        detail: tx.t('notDelivered.detail', { when: tx.dateTime(created) })
      });
      continue;
    }
    const waited = workingMinutes(created, now);
    if (waited >= LIMITS.requestWaitMinutes) {
      problems.push({
        group: 'requests', level: 'error', target: { tab: 'requests' },
        title: tx.t('noAnswer.title', { what }),
        detail: tx.t('noAnswer.detail', {
          wait: waited >= 120 ? tx.t('wait.hm', { h: Math.floor(waited / 60), m: waited % 60 }) : tx.t('wait.m', { m: waited }),
          when: tx.dateTime(created)
        })
      });
    }
  }
  return problems;
}

function systemProblems(tx, now) {
  const problems = [];
  const add = (level, key, detail) => problems.push({ group: 'system', level, title: tx.t(`${key}.title`, detail?.title), detail: detail?.text ?? tx.t(`${key}.detail`) });
  const failure = (f) => ({ text: tx.t('failure.detail', { when: tx.dateTime(Date.parse(f.at)), error: f.message }) });
  const sync = wsSyncStatus();
  if (!wsEnabled) {
    add('error', 'wsOff');
  } else if (!sync.lastSyncAt) {
    add('error', 'wsNoData', { text: sync.error ? tx.t('wsNoData.error', { error: sync.error }) : tx.t('wsNoData.first') });
  } else {
    const age = Math.round((now - Date.parse(sync.lastSyncAt)) / 60000);
    if (age >= LIMITS.syncStaleMinutes) {
      add('error', 'wsStale', { title: { n: age }, text: sync.error ? tx.t('wsStale.error', { error: sync.error }) : tx.t('wsStale.hint') });
    } else if (sync.error) {
      add('warning', 'wsLastFailed', { text: sync.error });
    }
  }
  const sheets = fleetStatus();
  if (!sheetsEnabled) add('error', 'sheetsOff');
  else if (sheets.error) add('error', 'sheetsError', { text: tx.t('sheetsError.detail', { error: sheets.error }) });
  if (!getStaffChatId()) add('error', 'groupOff');
  else if (staffGroupFailure()) add('error', 'groupFailed', failure(staffGroupFailure()));
  if (!mailEnabled) add('warning', 'mailOff');
  else if (mailFailure()) add('warning', 'mailFailed', failure(mailFailure()));
  return problems;
}

const GROUP_ORDER = ['system', 'requests', 'bookings', 'service', 'data', 'prices', 'website'];

/**
 * Все проблемы, сначала важные: [{ group, level, title, detail, target? }].
 * lang — язык текстов (en / ru / th), сводка в группу — на английском.
 */
export async function collectProblems(now = Date.now(), lang = 'en') {
  const tx = dashboardTranslator(lang);
  const snapshot = getWsSnapshot();
  const fleet = sheetsEnabled ? await getFleet().catch(() => null) : null;
  const problems = [
    ...systemProblems(tx, now),
    ...requestProblems(tx, now),
    ...(snapshot ? vehicleProblems(tx, snapshot, now) : []),
    ...(snapshot ? matchProblems(tx, snapshot, fleet) : []),
    ...priceProblems(tx, fleet),
    ...(await websiteProblems(tx, fleet).catch(() => []))
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
