/**
 * ============================================================================
 * Статистика сайтов для вкладки «Маркетинг»
 * ============================================================================
 * Из того же журнала Caddy, что и трафик (traffic.js): только сайты
 * (jetmobility.org, kokoncar.com), только открытые страницы (GET, ответ 200),
 * без поисковых роботов. По дням и домену считаем:
 *   page    — просмотры страниц по адресу;
 *   ref     — откуда пришли (домен ссылки: google.com, instagram.com…;
 *             «прямой заход» — без ссылки); переходы внутри сайта не считаем;
 *   utm     — метка рекламы utm_source;
 *   device  — телефон / компьютер / планшет (по уникальным посетителям);
 * и уникальных посетителей (обезличенно: хеш адреса и браузера за день).
 * ============================================================================
 */

import crypto from 'node:crypto';
import * as db from './db.js';

export const SITE_HOSTS = ['jetmobility.org', 'kokoncar.com'];
const BOT_UA = /bot|crawl|spider|slurp|preview|scan|python|curl|wget|httpclient|go-http|java\/|headless|lighthouse/i;

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS web_stats (
    day   TEXT NOT NULL,
    host  TEXT NOT NULL,
    dim   TEXT NOT NULL,
    value TEXT NOT NULL,
    n     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, host, dim, value)
  );
  CREATE TABLE IF NOT EXISTS web_visitors (
    day  TEXT NOT NULL,
    host TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (day, host, hash)
  );
`);

const q = {
  add: db.raw.prepare(`INSERT INTO web_stats (day, host, dim, value, n) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, host, dim, value) DO UPDATE SET n = n + excluded.n`),
  visitor: db.raw.prepare('INSERT OR IGNORE INTO web_visitors (day, host, hash) VALUES (?, ?, ?)'),
  pruneStats: db.raw.prepare('DELETE FROM web_stats WHERE day < ?'),
  pruneVisitors: db.raw.prepare('DELETE FROM web_visitors WHERE day < ?')
};

const siteOf = (host) => {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  return SITE_HOSTS.includes(h) ? h : null;
};

/** Домен ссылки без «www.», «m.», «l.» (l.facebook.com → facebook.com) */
function refDomain(referer, site) {
  if (!referer) return 'прямой заход';
  let host;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return 'прямой заход';
  }
  host = host.replace(/^(www|m|l|lm|mobile)\./, '');
  if (host === site || host.endsWith(`.${site}`)) return null;
  // google.co.th, google.ru → google
  if (/(^|\.)google\./.test(host)) return 'google';
  if (/(^|\.)yandex\./.test(host)) return 'yandex';
  return host.slice(0, 60);
}

const deviceOf = (ua) => (/ipad|tablet/i.test(ua) ? 'планшет' : /mobi|android|iphone/i.test(ua) ? 'телефон' : 'компьютер');

/** Накопитель для одной порции журнала */
export const createAcc = () => ({ stats: new Map(), visitors: new Map() });

/** Одна строка журнала Caddy (уже разобранный JSON) → в накопитель */
export function addEntry(acc, entry, day) {
  const request = entry.request;
  const site = siteOf(request?.host);
  if (!site || request.method !== 'GET' || Number(entry.status) !== 200) return;
  const uri = String(request.uri || '');
  const path = uri.split('?')[0].toLowerCase();
  if (path.startsWith('/api/') || path.startsWith('/img/') || path.startsWith('/uploads/') || /\.[a-z0-9]{2,5}$/.test(path)) return;
  const ua = request.headers?.['User-Agent']?.[0] || '';
  if (!ua || BOT_UA.test(ua)) return;
  const bump = (dim, value) => {
    const key = `${day}|${site}|${dim}|${value}`;
    acc.stats.set(key, (acc.stats.get(key) || 0) + 1);
  };
  bump('page', path.slice(0, 120) || '/');
  const ref = refDomain(request.headers?.Referer?.[0], site);
  if (ref) bump('ref', ref);
  const params = new URLSearchParams(uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '');
  const utm = params.get('utm_source');
  if (utm) bump('utm', utm.toLowerCase().slice(0, 40));
  const ip = request.client_ip || request.remote_ip || '';
  const hash = crypto.createHash('sha1').update(`${day}|${site}|${ip}|${ua}`).digest('hex').slice(0, 16);
  acc.visitors.set(`${day}|${site}|${hash}`, deviceOf(ua));
}

/** Записать накопленное; устройство считаем по новым за день посетителям */
export function saveAcc(acc) {
  if (!acc.stats.size && !acc.visitors.size) return;
  db.raw.exec('BEGIN');
  try {
    for (const [key, n] of acc.stats) {
      const [day, host, dim, value] = key.split('|');
      q.add.run(day, host, dim, value, n);
    }
    for (const [key, device] of acc.visitors) {
      const [day, host, hash] = key.split('|');
      if (Number(q.visitor.run(day, host, hash).changes)) q.add.run(day, host, 'device', device, 1);
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}

export function pruneSiteStats(statsBefore, visitorsBefore) {
  q.pruneStats.run(statsBefore);
  q.pruneVisitors.run(visitorsBefore);
}

/** Сводка за дни [fromDay, toDay]: просмотры и посетители по дням и сайтам, страницы, откуда, метки, устройства */
export function siteStats(fromDay, toDay) {
  const rows = db.raw.prepare('SELECT day, host, dim, value, n FROM web_stats WHERE day >= ? AND day <= ?').all(fromDay, toDay);
  const visitors = db.raw.prepare('SELECT day, host, COUNT(*) n FROM web_visitors WHERE day >= ? AND day <= ? GROUP BY day, host').all(fromDay, toDay);
  const top = (dim) => {
    const m = new Map();
    for (const r of rows.filter((x) => x.dim === dim)) {
      const key = `${r.host}|${r.value}`;
      m.set(key, (m.get(key) || 0) + r.n);
    }
    return [...m].map(([k, n]) => { const [host, value] = k.split('|'); return { host, value, n }; }).sort((a, b) => b.n - a.n);
  };
  const views = new Map();
  for (const r of rows.filter((x) => x.dim === 'page')) {
    const key = `${r.day}|${r.host}`;
    views.set(key, (views.get(key) || 0) + r.n);
  }
  return {
    views: [...views].map(([k, n]) => { const [day, host] = k.split('|'); return { day, host, n }; }),
    visitors: visitors.map((v) => ({ day: v.day, host: v.host, n: v.n })),
    pages: top('page').slice(0, 20),
    refs: top('ref').slice(0, 20),
    utm: top('utm').slice(0, 20),
    devices: top('device')
  };
}
