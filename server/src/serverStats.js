/**
 * ============================================================================
 * Вкладка «Сервер» (только Admin): нагрузка, «двигатель» (бот) и трафик
 * ============================================================================
 * Сервер (VPS) — видно изнутри контейнера: процессор и память из /proc,
 * нагрузка (load average), диск — свободное место на разделе с базой.
 * Двигатель — наш бот: его доля процессора, память, запросы в минуту,
 * время ответа, задержка цикла событий, размеры данных, версия.
 * Трафик — в traffic.js (vnStat на сервере + журнал Caddy).
 * Каждые 10 секунд берём замер, история — средние по минутам за час.
 * Лампы (как табло в кабине) и оповещения админам в Telegram считаются здесь.
 * ============================================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson, readJson } from './http.js';
import { wsEnabled } from './ws/api.js';
import { wsSyncStatus } from './ws/sync.js';
import { fleetStatus, sheetsEnabled } from './fleet.js';
import { telegramEnabled, sendMessage } from './telegram/api.js';
import { getStaffChatId, staffGroupFailure } from './staff.js';
import { mailEnabled, mailFailure } from './mail.js';
import { adminTelegramIds } from './staffUsers.js';
import { can } from './roles.js';
import { trafficReport, startTraffic, trafficSettings, saveTrafficSettings } from './traffic.js';
import { g, groupLocale } from './groupTexts.js';
import { LIMITS } from './dashboard.js';

const SAMPLE_MS = 10 * 1000;
const HISTORY_MINUTES = 60;
const SIZES_MS = 10 * 60 * 1000;
const ALERT_CHECK_MS = 5 * 60 * 1000;
// Сообщение о перезапуске — не чаще раза в 10 минут (если бот падает по кругу)
const RESTART_ALERT_GAP_MS = 10 * 60 * 1000;

/** Пороги ламп: caution — жёлтая, warning — красная */
export const THRESHOLDS = {
  cpu: { caution: 70, warning: 90 },          // % процессора сервера
  memory: { caution: 85, warning: 95 },       // % памяти
  load: { caution: 1, warning: 2 },           // load average (1 мин) на ядро
  diskFree: { caution: 15, warning: 5 },      // % свободного места
  responseMs: { caution: 1000, warning: 3000 }, // среднее время ответа за 5 минут
  traffic: { caution: 70, warning: 90 }       // % месячного лимита трафика
};

export const version = {
  commit: process.env.APP_VERSION || 'dev',
  date: process.env.APP_VERSION_DATE || null
};

const startedAt = Date.now();

/* ------------------------------------------------------------- Замеры */

/** Первая строка /proc/stat: суммарное время процессора всего сервера */
function readCpuTimes() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
    const idleAll = idle + iowait;
    return { total: user + nice + system + idleAll + irq + softirq + steal, idle: idleAll, steal };
  } catch {
    return null;
  }
}

/** Память сервера (кБ из /proc/meminfo → байты) */
function readMemory() {
  try {
    const info = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
      .map((line) => line.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((m) => [m[1], Number(m[2]) * 1024]));
    const total = info.MemTotal;
    const available = info.MemAvailable ?? (info.MemFree + (info.Cached || 0));
    return { total, used: total - available, swapTotal: info.SwapTotal || 0, swapUsed: (info.SwapTotal || 0) - (info.SwapFree || 0) };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 };
  }
}

function readDisk() {
  try {
    const s = fs.statfsSync(config.dataDir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

// Гистограмма считает время между срабатываниями таймера — вычитаем его шаг
const LOOP_RESOLUTION_MS = 10;
const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loop.enable();

let lastCpu = readCpuTimes();
let lastProc = process.cpuUsage();
let lastAt = process.hrtime.bigint();
const current = { cpu: 0, steal: 0, procCpu: 0 };

// Запросы к боту (страницы сайта, API, вебхуки): по минутам
const minutes = new Map();
const minuteKey = (ms) => Math.floor(ms / 60000);

function bucket(key) {
  let b = minutes.get(key);
  if (!b) {
    b = { requests: 0, totalMs: 0, maxMs: 0, errors: 0, cpu: [], procCpu: [], memory: [], loopMs: [] };
    minutes.set(key, b);
    for (const k of minutes.keys()) if (k < key - HISTORY_MINUTES) minutes.delete(k);
  }
  return b;
}

/** Вызывается после каждого ответа (index.js) */
export function recordRequest(ms, status) {
  const b = bucket(minuteKey(Date.now()));
  b.requests++;
  b.totalMs += ms;
  b.maxMs = Math.max(b.maxMs, ms);
  if (status >= 500) b.errors++;
}

function sample() {
  const cpu = readCpuTimes();
  const proc = process.cpuUsage();
  const at = process.hrtime.bigint();
  if (cpu && lastCpu && cpu.total > lastCpu.total) {
    const dTotal = cpu.total - lastCpu.total;
    current.cpu = Math.max(0, Math.min(100, (1 - (cpu.idle - lastCpu.idle) / dTotal) * 100));
    current.steal = Math.max(0, ((cpu.steal - lastCpu.steal) / dTotal) * 100);
  }
  // Доля бота — от всего процессора сервера (всех ядер)
  const wallUs = Number(at - lastAt) / 1000;
  if (wallUs > 0) {
    const used = (proc.user - lastProc.user) + (proc.system - lastProc.system);
    current.procCpu = Math.max(0, Math.min(100, (used / (wallUs * cpuCount())) * 100));
  }
  lastCpu = cpu;
  lastProc = proc;
  lastAt = at;

  const mem = readMemory();
  const b = bucket(minuteKey(Date.now()));
  b.cpu.push(current.cpu);
  b.procCpu.push(current.procCpu);
  b.memory.push(mem.total ? (mem.used / mem.total) * 100 : 0);
  b.loopMs.push(Math.max(0, loop.percentile(99) / 1e6 - LOOP_RESOLUTION_MS));
  loop.reset();
}

const cpuCount = () => (os.availableParallelism?.() || os.cpus().length || 1);
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const round = (n, digits = 1) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/* ------------------------------------------------------ Размеры данных */

async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirSize(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      try {
        bytes += (await fs.promises.stat(full)).size;
        files++;
      } catch { /* файл удалили во время подсчёта */ }
    }
  }
  return { bytes, files };
}

let sizes = null;

async function measureSizes() {
  const dbFiles = ['kokon.db', 'kokon.db-wal', 'kokon.db-shm'].map((f) => path.join(config.dataDir, f));
  let dbBytes = 0;
  for (const file of dbFiles) {
    try { dbBytes += fs.statSync(file).size; } catch { /* нет файла */ }
  }
  sizes = {
    database: dbBytes,
    uploads: await dirSize(config.site.uploadsDir),
    siteImages: await dirSize(path.join(config.site.dir, 'img')),
    measuredAt: new Date().toISOString()
  };
}

/* --------------------------------------------------------------- Лампы */

const levelOf = (value, t, higherIsWorse = true) => {
  if (value == null) return 'off';
  if (higherIsWorse) return value >= t.warning ? 'warning' : value >= t.caution ? 'caution' : 'ok';
  return value <= t.warning ? 'warning' : value <= t.caution ? 'caution' : 'ok';
};

function integrationLamps(now) {
  const sync = wsSyncStatus();
  let ws = 'ok';
  if (!wsEnabled || !sync.lastSyncAt) ws = 'warning';
  else if (now - Date.parse(sync.lastSyncAt) >= LIMITS.syncStaleMinutes * 60000) ws = 'warning';
  else if (sync.error) ws = 'caution';

  const sheets = !sheetsEnabled ? 'warning' : fleetStatus().error ? 'warning' : 'ok';
  const telegram = !telegramEnabled || !getStaffChatId() ? 'warning' : staffGroupFailure() ? 'warning' : 'ok';
  const mail = !mailEnabled ? 'caution' : mailFailure() ? 'caution' : 'ok';
  return { ws, sheets, telegram, mail };
}

/* --------------------------------------------------------------- Отчёт */

// Имя самого сервера (в контейнере os.hostname() — номер контейнера)
const hostName = (() => {
  try {
    return fs.readFileSync('/host/hostname', 'utf8').trim() || os.hostname();
  } catch {
    return os.hostname();
  }
})();

function hostReport() {
  const mem = readMemory();
  const disk = readDisk();
  const cores = cpuCount();
  const [load1, load5, load15] = os.loadavg();
  return {
    hostname: hostName,
    cores,
    cpu: round(current.cpu),
    steal: round(current.steal),
    memory: { total: mem.total, used: mem.used, percent: round((mem.used / mem.total) * 100), swapTotal: mem.swapTotal, swapUsed: mem.swapUsed },
    load: { load1: round(load1, 2), load5: round(load5, 2), load15: round(load15, 2), perCore: round(load1 / cores, 2) },
    disk: disk && { ...disk, percent: round((disk.used / disk.total) * 100), freePercent: round((disk.free / disk.total) * 100) },
    uptimeSeconds: Math.round(os.uptime())
  };
}

function engineReport(now) {
  const nowKey = minuteKey(now);
  // Последние 5 полных минут — для запросов в минуту и времени ответа
  const recent = [1, 2, 3, 4, 5].map((i) => minutes.get(nowKey - i)).filter(Boolean);
  const requests = recent.reduce((s, b) => s + b.requests, 0);
  const totalMs = recent.reduce((s, b) => s + b.totalMs, 0);
  const mem = process.memoryUsage();
  return {
    version,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    cpu: round(current.procCpu),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed },
    requestsPerMinute: round(requests / 5),
    responseMs: requests ? Math.round(totalMs / requests) : null,
    maxResponseMs: recent.length ? Math.round(Math.max(...recent.map((b) => b.maxMs))) : null,
    errors5m: recent.reduce((s, b) => s + b.errors, 0),
    loopDelayMs: round(avg(minutes.get(nowKey)?.loopMs || recent[0]?.loopMs || [])),
    sizes,
    lastSyncAt: wsSyncStatus().lastSyncAt
  };
}

function history(now) {
  const nowKey = minuteKey(now);
  const rows = [];
  for (let k = nowKey - HISTORY_MINUTES + 1; k <= nowKey; k++) {
    const b = minutes.get(k);
    rows.push({
      at: new Date(k * 60000).toISOString(),
      cpu: round(avg(b?.cpu || [])),
      procCpu: round(avg(b?.procCpu || [])),
      memory: round(avg(b?.memory || [])),
      requests: b ? b.requests : 0,
      responseMs: b?.requests ? Math.round(b.totalMs / b.requests) : null
    });
  }
  return rows;
}

function lampsFor(host, engine, traffic, now) {
  const integrations = integrationLamps(now);
  const lamps = [
    { id: 'disk', level: levelOf(host.disk?.freePercent, THRESHOLDS.diskFree, false) },
    { id: 'cpu', level: levelOf(host.cpu, THRESHOLDS.cpu) },
    { id: 'memory', level: levelOf(host.memory.percent, THRESHOLDS.memory) },
    { id: 'load', level: levelOf(host.load.perCore, THRESHOLDS.load) },
    { id: 'response', level: engine.responseMs == null ? 'ok' : levelOf(engine.responseMs, THRESHOLDS.responseMs) },
    { id: 'traffic', level: traffic.available ? levelOf(traffic.usedPercent, THRESHOLDS.traffic) : 'off' },
    { id: 'ws', level: integrations.ws },
    { id: 'sheets', level: integrations.sheets },
    { id: 'telegram', level: integrations.telegram },
    { id: 'mail', level: integrations.mail }
  ];
  // Прогноз выше лимита — жёлтая, даже если сейчас мало
  const t = lamps.find((l) => l.id === 'traffic');
  if (t.level === 'ok' && traffic.forecastPercent >= 100) t.level = 'caution';
  return lamps;
}

export function collectServerReport(now = Date.now()) {
  const host = hostReport();
  const engine = engineReport(now);
  const traffic = trafficReport(now);
  const lamps = lampsFor(host, engine, traffic, now);
  return {
    at: new Date(now).toISOString(),
    host,
    engine,
    traffic,
    lamps,
    master: {
      warning: lamps.some((l) => l.level === 'warning'),
      caution: lamps.some((l) => l.level === 'caution')
    },
    thresholds: THRESHOLDS,
    history: history(now)
  };
}

/* ------------------------------------------------------- API для портала */

function requireAdmin(staff, perm) {
  if (!can(staff, perm)) throw new HttpError(403, 'admin_only');
}

/** GET /api/staff/server */
export function serverReport(staff, req, res) {
  requireAdmin(staff, 'server.view');
  sendJson(res, 200, { ...collectServerReport(), settings: trafficSettings() });
}

/** POST /api/staff/server/settings { trafficLimitGb, trafficBasis } */
export async function saveServerSettings(staff, req, res) {
  requireAdmin(staff, 'settings');
  const body = await readJson(req);
  const saved = saveTrafficSettings(body, staff);
  if (!saved) throw new HttpError(400, 'invalid_settings');
  sendJson(res, 200, { ok: true, settings: saved });
}

/* ------------------------------------------------ Оповещения в Telegram */

async function notifyAdmins(text) {
  if (!telegramEnabled) return;
  let chats = [];
  try {
    chats = await adminTelegramIds();
  } catch (err) {
    console.error('Admin list for alerts failed:', err.message);
    return;
  }
  for (const chatId of chats) {
    // Бот может написать только тому, кто хотя бы раз нажал у него «Старт»
    await sendMessage(chatId, text, { disable_web_page_preview: true })
      .catch((err) => console.error(`Admin alert to ${chatId} failed:`, err.message));
  }
}

const gb = (bytes) => new Intl.NumberFormat(groupLocale, { maximumFractionDigits: bytes >= 100e9 ? 0 : 1 }).format(bytes / 1e9);

async function checkAlerts(now = Date.now()) {
  const host = hostReport();
  const traffic = trafficReport(now);
  const link = `\n\n👉 ${config.staff.url}/#server`;

  // Трафик: 70% и 90% месячного лимита — по одному разу в месяц
  if (traffic.available && traffic.month) {
    const key = `alert_traffic_${traffic.month}`;
    const sent = Number(db.getSetting(key) || 0);
    const level = [THRESHOLDS.traffic.warning, THRESHOLDS.traffic.caution].find((p) => traffic.usedPercent >= p);
    if (level && level > sent) {
      await notifyAdmins(g(level >= THRESHOLDS.traffic.warning ? 'alert.traffic90' : 'alert.traffic70', {
        percent: Math.floor(traffic.usedPercent), used: gb(traffic.used), limit: traffic.limitGb,
        forecast: gb(traffic.forecast)
      }) + link);
      db.setSetting(key, level);
    }
  }

  // Мало места: меньше 15% — один раз, снова — когда освободится больше 20%
  if (host.disk) {
    const low = host.disk.freePercent < THRESHOLDS.diskFree.caution;
    const sent = db.getSetting('alert_disk_low') === '1';
    if (low && !sent) {
      await notifyAdmins(g('alert.disk', { percent: Math.floor(host.disk.freePercent), free: gb(host.disk.free) }) + link);
      db.setSetting('alert_disk_low', '1');
    } else if (!low && sent && host.disk.freePercent > THRESHOLDS.diskFree.caution + 5) {
      db.setSetting('alert_disk_low', '0');
    }
  }
}

/** После запуска: «обновление установлено» или «бот перезапустился» */
async function startupAlert() {
  const last = Number(db.getSetting('alert_start_at') || 0);
  const previous = db.getSetting('app_version');
  db.setSetting('app_version', version.commit);
  if (Date.now() - last < RESTART_ALERT_GAP_MS) return;
  db.setSetting('alert_start_at', Date.now());
  const params = { version: version.commit };
  let text;
  // Первый запуск с этой вкладкой — заодно админ видит, что оповещения доходят
  if (!previous) text = g('alert.first', params);
  else if (previous !== version.commit) text = g('alert.updated', { ...params, previous });
  else if (os.uptime() < 15 * 60) text = g('alert.rebooted', params);
  else text = g('alert.restarted', params);
  await notifyAdmins(text);
}

export function startServerStats() {
  setInterval(sample, SAMPLE_MS).unref();
  measureSizes().catch(() => {});
  setInterval(() => measureSizes().catch(() => {}), SIZES_MS).unref();
  startTraffic();
  // Первая проверка — через минуту: трафик успеет прочитаться
  setTimeout(() => {
    startupAlert().catch((err) => console.error('Startup alert failed:', err.message));
    checkAlerts().catch((err) => console.error('Server alerts failed:', err.message));
    setInterval(() => checkAlerts().catch((err) => console.error('Server alerts failed:', err.message)), ALERT_CHECK_MS).unref();
  }, 60 * 1000).unref();
}
