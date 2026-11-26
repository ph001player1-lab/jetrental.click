/**
 * ============================================================================
 * Трафик сервера: сколько ушло за месяц и на что
 * ============================================================================
 * Сколько — из vnStat на самом сервере (VPS): он считает весь трафик сетевой
 * карты, включая обновления системы и Docker. Его база (SQLite) подключена в
 * контейнер только для чтения: /host/vnstat/vnstat.db. Читаем копию раз в
 * минуту, чтобы не мешать vnStat писать.
 * На что — из журнала Caddy (JSON, том caddy_logs): каждый ответ сайтов,
 * портала и вебхуков. Раз в 30 секунд дочитываем новые строки и складываем
 * в базу бота по дням: домен × вид (страницы, фото, скрипты, API, вебхуки).
 * Лимит трафика за месяц и что считать (исходящий или весь) задаёт админ
 * на вкладке «Сервер»; по умолчанию 500 ГБ исходящего — сверьте с панелью OVH.
 * ============================================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from './db.js';
import { createAcc, addEntry, saveAcc, pruneSiteStats } from './siteStats.js';

const VNSTAT_DB = process.env.VNSTAT_DB || '/host/vnstat/vnstat.db';
const CADDY_LOG = process.env.CADDY_ACCESS_LOG || '/caddy-logs/access.log';
const VNSTAT_EVERY_MS = 60 * 1000;
const CADDY_EVERY_MS = 30 * 1000;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const KEEP_DAYS = 400;
const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;

export const DEFAULT_LIMIT_GB = Number(process.env.TRAFFIC_LIMIT_GB) || 500;
const BASES = ['out', 'total'];

const bangkokDate = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 10);

/* ----------------------------------------------------------- Настройки */

export function trafficSettings() {
  const limitGb = Number(db.getSetting('traffic_limit_gb')) || DEFAULT_LIMIT_GB;
  const basis = BASES.includes(db.getSetting('traffic_basis')) ? db.getSetting('traffic_basis') : 'out';
  return { limitGb, basis };
}

/** null — неверные значения */
export function saveTrafficSettings(body, staff) {
  const limitGb = Math.round(Number(body?.trafficLimitGb));
  const basis = body?.trafficBasis;
  if (!Number.isFinite(limitGb) || limitGb < 1 || limitGb > 100000 || !BASES.includes(basis)) return null;
  db.setSetting('traffic_limit_gb', limitGb);
  db.setSetting('traffic_basis', basis);
  console.log(`Traffic settings changed by ${staff.email}: ${limitGb} GB, ${basis}`);
  return trafficSettings();
}

/* ------------------------------------------------------------- vnStat */

// Служебные интерфейсы Docker и петля — не внешний трафик
const SKIP_INTERFACE = /^(lo|docker|br-|veth|virbr|cni|flannel|tun|tap|wg|ifb)/;

let vnstat = { available: false, reason: 'not_read' };

function readVnstat() {
  if (!fs.existsSync(VNSTAT_DB)) {
    vnstat = { available: false, reason: 'no_vnstat' };
    return;
  }
  const copy = path.join(os.tmpdir(), 'kokon-vnstat.db');
  let base;
  try {
    fs.copyFileSync(VNSTAT_DB, copy);
    base = new DatabaseSync(copy, { readOnly: true });
    const interfaces = base.prepare('SELECT id, name, active, updated, rxtotal, txtotal FROM interface').all()
      .filter((i) => !SKIP_INTERFACE.test(i.name))
      .sort((a, b) => (b.active - a.active) || (b.rxtotal + b.txtotal - a.rxtotal - a.txtotal));
    const main = interfaces[0];
    if (!main) {
      vnstat = { available: false, reason: 'no_interface' };
      return;
    }
    const rows = (table, limit) => base.prepare(`SELECT date, rx, tx FROM ${table} WHERE interface = ? ORDER BY date DESC LIMIT ?`)
      .all(main.id, limit).map((r) => ({ date: String(r.date), rx: Number(r.rx), tx: Number(r.tx) }));
    vnstat = {
      available: true,
      interface: main.name,
      updated: String(main.updated),
      days: rows('day', 62).reverse(),
      months: rows('month', 13).reverse(),
      readAt: Date.now()
    };
  } catch (err) {
    // База могла записываться во время копирования — берём прошлый замер, повторим через минуту
    console.error('vnStat read failed:', err.message);
    if (!vnstat.available) vnstat = { available: false, reason: 'error', error: err.message };
  } finally {
    try { base?.close(); } catch { /* уже закрыта */ }
  }
}

/* ----------------------------------------------------- Журнал Caddy */

const BOT_UA = /bot|crawl|spider|slurp|preview|scan|python|curl|wget|httpclient|go-http|java\//i;

/** Вид запроса по адресу */
export function categoryOf(uri) {
  const p = String(uri || '').split('?')[0].toLowerCase();
  if (p.startsWith('/webhooks/')) return 'webhooks';
  if (p.startsWith('/api/')) return 'api';
  if (p.startsWith('/uploads/') || p.startsWith('/img/') || /\.(png|jpe?g|webp|avif|gif|svg)$/.test(p)) return 'photos';
  if (/\.(css|js|mjs|woff2?|ttf|ico|webmanifest|json|map|xml|txt)$/.test(p)) return 'assets';
  if (p === '/health') return 'other';
  return 'pages';
}

/** Строки журнала → суммы по ключу «день|домен|вид» */
export function aggregateLines(lines, into = new Map(), site = null) {
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const request = entry.request;
    if (!request || !entry.ts) continue;
    const host = String(request.host || '').toLowerCase().replace(/:\d+$/, '').slice(0, 100) || '—';
    const day = bangkokDate(entry.ts * 1000);
    // Подробности по сайтам (страницы, откуда пришли, посетители) — для «Маркетинга»
    if (site) addEntry(site, entry, day);
    const key = `${day}|${host}|${categoryOf(request.uri)}`;
    let sum = into.get(key);
    if (!sum) into.set(key, (sum = { requests: 0, out: 0, in: 0, botRequests: 0, botOut: 0 }));
    const out = Number(entry.size) || 0;
    sum.requests++;
    sum.out += out;
    sum.in += Number(entry.bytes_read) || 0;
    const ua = request.headers?.['User-Agent']?.[0] || '';
    if (BOT_UA.test(ua)) {
      sum.botRequests++;
      sum.botOut += out;
    }
  }
  return into;
}

function readPosition() {
  try {
    return JSON.parse(db.getSetting('caddy_log_pos') || 'null') || { ino: null, offset: 0 };
  } catch {
    return { ino: null, offset: 0 };
  }
}

/** Новые полные строки файла с offset; возвращает { lines, offset } */
function readFrom(file, offset, size) {
  const length = Math.min(size - offset, MAX_READ_BYTES);
  if (length <= 0) return { lines: [], offset };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    // Недописанная последняя строка останется на следующий раз
    const lastNewline = read > 0 ? buf.lastIndexOf(0x0a, read - 1) : -1;
    if (lastNewline < 0) return { lines: [], offset };
    return {
      lines: buf.subarray(0, lastNewline).toString('utf8').split('\n'),
      offset: offset + lastNewline + 1
    };
  } finally {
    fs.closeSync(fd);
  }
}

let caddy = { available: false, readAt: null };

function readCaddyLog() {
  let stat;
  try {
    stat = fs.statSync(CADDY_LOG);
  } catch {
    caddy = { available: false, readAt: Date.now() };
    return;
  }
  const pos = readPosition();
  const sums = new Map();
  const site = createAcc();

  // Caddy переименовал файл (ротация) — дочитываем хвост старого, потом новый с начала
  if (pos.ino != null && pos.ino !== stat.ino) {
    try {
      const dir = path.dirname(CADDY_LOG);
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const s = fs.statSync(full);
        if (s.ino === pos.ino && s.size > pos.offset) aggregateLines(readFrom(full, pos.offset, s.size).lines, sums, site);
      }
    } catch { /* старый файл уже удалён */ }
    pos.offset = 0;
  }
  if (stat.size < pos.offset) pos.offset = 0;

  // Большой журнал читаем частями — по 32 МБ за раз
  let { offset } = pos;
  for (let i = 0; i < 8 && offset < stat.size; i++) {
    const chunk = readFrom(CADDY_LOG, offset, stat.size);
    if (chunk.offset === offset) break;
    aggregateLines(chunk.lines, sums, site);
    offset = chunk.offset;
  }

  if (sums.size) {
    db.addWebTraffic([...sums].map(([key, s]) => {
      const [day, host, category] = key.split('|');
      return { day, host, category, ...s };
    }));
  }
  try { saveAcc(site); } catch (err) { console.error('Site stats failed:', err.message); }
  db.setSetting('caddy_log_pos', JSON.stringify({ ino: stat.ino, offset }));
  caddy = { available: true, readAt: Date.now() };
}

/* ---------------------------------------------------------------- Отчёт */

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Трафик сайтов и вебхуков по журналу Caddy с первого числа месяца */
function webReport(monthStart) {
  const rows = db.webTrafficSince(monthStart);
  const group = (field) => {
    const map = new Map();
    for (const r of rows) {
      const k = r[field];
      const sum = map.get(k) || { id: k, requests: 0, out: 0, in: 0 };
      sum.requests += r.requests;
      sum.out += r.bytes_out;
      sum.in += r.bytes_in;
      map.set(k, sum);
    }
    return [...map.values()].sort((a, b) => b.out - a.out);
  };
  const total = (key) => rows.reduce((s, r) => s + r[key], 0);
  return {
    available: caddy.available || rows.length > 0,
    categories: group('category'),
    hosts: group('host'),
    requests: total('requests'),
    out: total('bytes_out'),
    in: total('bytes_in'),
    bots: { requests: total('bot_requests'), out: total('bot_bytes') }
  };
}

export function trafficReport(now = Date.now()) {
  const settings = trafficSettings();
  const today = bangkokDate(now);
  const [year, month] = today.split('-').map(Number);
  const monthKey = today.slice(0, 7);
  const monthStart = `${monthKey}-01`;
  const web = webReport(monthStart);
  const report = { ...settings, month: monthKey, today, web, available: vnstat.available };
  if (!vnstat.available) return { ...report, reason: vnstat.reason };

  const basisOf = (r) => (settings.basis === 'out' ? r.tx : r.rx + r.tx);
  const monthRow = vnstat.months.find((m) => m.date.startsWith(monthKey)) || { rx: 0, tx: 0 };
  const byDate = new Map(vnstat.days.map((d) => [d.date, d]));
  const yesterday = bangkokDate(now - DAY_MS);

  // Дни месяца до сегодня (дни без трафика — нули)
  const days = [];
  for (let d = 1; d <= Number(today.slice(8, 10)); d++) {
    const date = `${monthKey}-${String(d).padStart(2, '0')}`;
    const row = byDate.get(date) || { rx: 0, tx: 0 };
    days.push({ date, rx: row.rx, tx: row.tx });
  }

  // Прогноз: уже ушло + среднее за последние 7 полных дней × оставшиеся дни
  const full = vnstat.days.filter((d) => d.date < today).slice(-7);
  const elapsedToday = ((now + BANGKOK_MS) % DAY_MS) / DAY_MS;
  const perDay = full.length
    ? full.reduce((s, d) => s + basisOf(d), 0) / full.length
    : basisOf(byDate.get(today) || { rx: 0, tx: 0 }) / Math.max(elapsedToday, 1 / 24);
  const total = daysInMonth(year, month);
  const remaining = total - Number(today.slice(8, 10)) + (1 - elapsedToday);
  const used = basisOf(monthRow);
  const forecast = used + perDay * remaining;
  const limit = settings.limitGb * 1e9;

  return {
    ...report,
    interface: vnstat.interface,
    updatedAt: vnstat.updated,
    monthRx: monthRow.rx,
    monthTx: monthRow.tx,
    used,
    usedPercent: Math.round((used / limit) * 1000) / 10,
    forecast: Math.round(forecast),
    forecastPercent: Math.round((forecast / limit) * 1000) / 10,
    perDay: Math.round(perDay),
    dayOfMonth: Number(today.slice(8, 10)),
    daysInMonth: total,
    todayRx: byDate.get(today)?.rx || 0,
    todayTx: byDate.get(today)?.tx || 0,
    yesterdayRx: byDate.get(yesterday)?.rx || 0,
    yesterdayTx: byDate.get(yesterday)?.tx || 0,
    days,
    months: vnstat.months.slice(-6).map((m) => ({ month: m.date.slice(0, 7), rx: m.rx, tx: m.tx })),
    // Не через Caddy: обновления системы и Docker, запросы бота в Telegram, Google, Автопрокат
    otherOut: Math.max(0, monthRow.tx - web.out),
    otherIn: Math.max(0, monthRow.rx - web.in)
  };
}

export function startTraffic() {
  const safe = (fn, name) => () => {
    try { fn(); } catch (err) { console.error(`${name} failed:`, err.message); }
  };
  safe(readVnstat, 'vnStat read')();
  safe(readCaddyLog, 'Caddy log read')();
  db.pruneWebTraffic(bangkokDate(Date.now() - KEEP_DAYS * DAY_MS));
  setInterval(safe(readVnstat, 'vnStat read'), VNSTAT_EVERY_MS).unref();
  setInterval(safe(readCaddyLog, 'Caddy log read'), CADDY_EVERY_MS).unref();
  setInterval(() => {
    db.pruneWebTraffic(bangkokDate(Date.now() - KEEP_DAYS * DAY_MS));
    pruneSiteStats(bangkokDate(Date.now() - KEEP_DAYS * DAY_MS), bangkokDate(Date.now() - 120 * DAY_MS));
  }, DAY_MS).unref();
}
