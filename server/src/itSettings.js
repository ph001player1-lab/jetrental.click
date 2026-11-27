/**
 * ============================================================================
 * Вкладка «Настройки» (только админ)
 * ============================================================================
 *   - Связь: Telegram-бот и группа, кому приходят оповещения (WhatsApp-бот и
 *     наблюдатель — их адреса /wabot и /wa, вкладка берёт оттуда);
 *   - Домены и сайты: срок регистрации домена (RDAP — открытый реестр, раз в
 *     сутки) и срок SSL-сертификата каждого адреса;
 *   - Ключи и доступы: только «задан / не задан» — сами ключи остаются в
 *     /opt/kokon/.env (set-secret.sh) и сюда не попадают;
 *   - Сервисы и оплаты: что, сколько, как часто, когда следующая оплата, как
 *     платить, кто отвечает. «Оплачено» записывает оплату и переносит дату;
 *     оплаты идут во «Финансы» отдельной статьёй «IT и подписки»;
 *   - Напоминания админам в Telegram: за 7 дней, за день и в день оплаты,
 *     пока просрочено — каждый день. С автопродлением в день оплаты оплата
 *     записывается сама (её можно поправить или удалить);
 *   - Модель ИИ для «＋ Операция» и месячный лимит расходов на неё.
 *
 *   GET  /api/staff/settings                 — всё для вкладки
 *   POST /api/staff/settings/service         { id?, name, kind, cost, currency, period, nextDate, … }
 *   POST /api/staff/settings/service/delete  { id }
 *   POST /api/staff/settings/service/paid    { id, amount?, currency?, paidOn?, note? }
 *   POST /api/staff/settings/payment/delete  { id }
 *   POST /api/staff/settings/ai              { model, limitUsd }
 *   POST /api/staff/settings/domains/check   — проверить домены и сертификаты сейчас
 * ============================================================================
 */

import tls from 'node:tls';
import fs from 'node:fs';
import * as db from './db.js';
import { config } from './config.js';
import { HttpError, sendJson, readJson } from './http.js';
import { can } from './roles.js';
import { currentRates } from './finance.js';
import { notifyAdmins } from './serverStats.js';
import { telegramEnabled, telegramBotUsername, tg } from './telegram/api.js';
import { getStaffChatId } from './staff.js';
import { activeStaff, ADMIN_ROLE } from './access.js';
import { discountSettingsView } from './discounts.js';

const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;
const bangkokToday = (now = Date.now()) => new Date(now + BANGKOK_MS).toISOString().slice(0, 10);
const daysBetween = (fromIso, toIso) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS it_services (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'service',
    cost        REAL,
    currency    TEXT NOT NULL DEFAULT 'USD',
    period      TEXT NOT NULL DEFAULT 'month',
    next_date   TEXT,
    how_to_pay  TEXT,
    auto_renew  INTEGER NOT NULL DEFAULT 0,
    responsible TEXT,
    note        TEXT,
    url         TEXT,
    domain      TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    created_by  TEXT,
    updated_at  TEXT,
    updated_by  TEXT
  );
  CREATE TABLE IF NOT EXISTS it_payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id   INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    amount       REAL NOT NULL,
    currency     TEXT NOT NULL,
    thb          REAL NOT NULL,
    paid_on      TEXT NOT NULL,
    for_date     TEXT,
    prev_next    TEXT,
    auto         INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    by_email     TEXT,
    by_name      TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS it_payments_paid ON it_payments (paid_on);
  CREATE TABLE IF NOT EXISTS it_reminders (
    key TEXT PRIMARY KEY,
    at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    usd           REAL NOT NULL DEFAULT 0,
    purpose       TEXT,
    by_email      TEXT
  );
  CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage (at);
`);

const q = {
  services: db.raw.prepare('SELECT * FROM it_services ORDER BY active DESC, next_date IS NULL, next_date, name'),
  service: db.raw.prepare('SELECT * FROM it_services WHERE id = ?'),
  insert: db.raw.prepare(`INSERT INTO it_services (name, kind, cost, currency, period, next_date, how_to_pay, auto_renew, responsible, note, url, domain, active, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  update: db.raw.prepare(`UPDATE it_services SET name = ?, kind = ?, cost = ?, currency = ?, period = ?, next_date = ?, how_to_pay = ?, auto_renew = ?,
    responsible = ?, note = ?, url = ?, domain = ?, active = ?, updated_at = ?, updated_by = ? WHERE id = ?`),
  setNext: db.raw.prepare('UPDATE it_services SET next_date = ?, active = ?, updated_at = ?, updated_by = ? WHERE id = ?'),
  remove: db.raw.prepare('DELETE FROM it_services WHERE id = ?'),
  payments: db.raw.prepare('SELECT * FROM it_payments ORDER BY paid_on DESC, id DESC LIMIT ?'),
  paymentsOf: db.raw.prepare('SELECT * FROM it_payments WHERE service_id = ? ORDER BY paid_on DESC, id DESC LIMIT 5'),
  payment: db.raw.prepare('SELECT * FROM it_payments WHERE id = ?'),
  lastPayment: db.raw.prepare('SELECT id FROM it_payments WHERE service_id = ? ORDER BY id DESC LIMIT 1'),
  addPayment: db.raw.prepare(`INSERT INTO it_payments (service_id, service_name, amount, currency, thb, paid_on, for_date, prev_next, auto, note, by_email, by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  removePayment: db.raw.prepare('DELETE FROM it_payments WHERE id = ?'),
  between: db.raw.prepare('SELECT * FROM it_payments WHERE paid_on >= ? AND paid_on < ? ORDER BY paid_on'),
  reminded: db.raw.prepare('SELECT 1 FROM it_reminders WHERE key = ?'),
  remind: db.raw.prepare('INSERT OR IGNORE INTO it_reminders (key, at) VALUES (?, ?)'),
  aiMonth: db.raw.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM ai_usage WHERE at >= ? AND at < ?')
};

export class SettingsError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const KINDS = ['server', 'domain', 'subscription', 'service', 'other'];
const PERIODS = { month: 1, quarter: 3, half: 6, year: 12, once: 0 };
const CURRENCIES = ['THB', 'USD', 'USDT', 'EUR', 'RUB'];

/** Дата через N месяцев: 31.01 + 1 месяц → 28/29.02 (конец месяца не «перескакивает») */
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;

function toThb(amount, currency) {
  if (currency === 'THB') return amount;
  const { rates } = currentRates();
  return amount * (rates[currency] || rates.USD || 33);
}

/* ------------------------------------------------------------ Сервисы */

/** Состояние оплаты: сколько дней осталось и насколько срочно */
function dueOf(row, today) {
  if (!row.active || !row.next_date) return { days: null, state: row.active ? 'nodate' : 'off' };
  const days = daysBetween(today, row.next_date);
  return { days, state: days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 7 ? 'soon' : 'ok' };
}

function serviceView(row, today) {
  return {
    id: row.id, name: row.name, kind: row.kind, cost: row.cost, currency: row.currency, period: row.period,
    nextDate: row.next_date, howToPay: row.how_to_pay, autoRenew: Boolean(row.auto_renew), responsible: row.responsible,
    note: row.note, url: row.url, domain: row.domain, active: Boolean(row.active),
    updatedAt: row.updated_at || row.created_at, updatedBy: row.updated_by || row.created_by,
    ...dueOf(row, today),
    payments: q.paymentsOf.all(row.id).map(paymentView)
  };
}

const paymentView = (p) => ({
  id: p.id, serviceId: p.service_id, service: p.service_name, amount: p.amount, currency: p.currency, thb: Math.round(p.thb),
  paidOn: p.paid_on, forDate: p.for_date, auto: Boolean(p.auto), note: p.note, by: p.by_name || p.by_email, at: p.created_at
});

/** В месяц в батах: годовая подписка — 1/12 и т. д. (разовые не считаем) */
function monthlyThb(services) {
  let sum = 0;
  for (const s of services) {
    if (!s.active || !s.cost || !PERIODS[s.period]) continue;
    sum += toThb(s.cost, s.currency) / PERIODS[s.period];
  }
  return Math.round(sum);
}

export function saveService(body, staff) {
  const name = text(body.name, 80);
  if (!name) throw new SettingsError('name_required');
  const kind = KINDS.includes(body.kind) ? body.kind : 'service';
  const period = Object.hasOwn(PERIODS, body.period) ? body.period : 'month';
  const currency = CURRENCIES.includes(body.currency) ? body.currency : 'USD';
  let cost = null;
  if (body.cost !== null && body.cost !== undefined && String(body.cost).trim() !== '') {
    cost = Number(String(body.cost).replace(/[\s,]/g, ''));
    if (!Number.isFinite(cost) || cost < 0 || cost > 1e9) throw new SettingsError('bad_cost');
  }
  const nextDate = body.nextDate ? String(body.nextDate) : null;
  if (nextDate && !isDate(nextDate)) throw new SettingsError('bad_date');
  const url = text(body.url, 300);
  if (url && !/^https?:\/\//i.test(url)) throw new SettingsError('bad_url');
  const domain = text(body.domain, 100)?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
  const values = [name, kind, cost, currency, period, nextDate, text(body.howToPay, 300), body.autoRenew ? 1 : 0,
    text(body.responsible, 80), text(body.note, 500), url, domain, body.active === false ? 0 : 1];
  const now = new Date().toISOString();
  const by = staff?.name || staff?.email || null;
  if (body.id) {
    if (!q.service.get(Number(body.id))) throw new SettingsError('unknown_service');
    q.update.run(...values, now, by, Number(body.id));
    return Number(body.id);
  }
  return Number(q.insert.run(...values, now, by).lastInsertRowid);
}

export function deleteService(id) {
  if (!q.service.get(Number(id))) throw new SettingsError('unknown_service');
  // Записанные оплаты остаются во «Финансах» (с названием сервиса)
  q.remove.run(Number(id));
}

/**
 * «Оплачено»: запись оплаты (по умолчанию — стоимость сервиса) и перенос даты
 * следующей оплаты на период вперёд от прошлой даты (не от сегодня — график не сдвигается)
 */
export function markPaid(body, staff, { auto = false, now = Date.now() } = {}) {
  const row = q.service.get(Number(body.id));
  if (!row) throw new SettingsError('unknown_service');
  const currency = CURRENCIES.includes(body.currency) ? body.currency : row.currency;
  const amount = body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== ''
    ? Number(String(body.amount).replace(/[\s,]/g, '')) : row.cost;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new SettingsError('bad_amount');
  const paidOn = body.paidOn ? String(body.paidOn) : bangkokToday(now);
  if (!isDate(paidOn)) throw new SettingsError('bad_date');
  const months = PERIODS[row.period];
  const base = row.next_date || paidOn;
  const next = months ? addMonths(base, months) : null;
  const at = new Date(now).toISOString();
  db.raw.exec('BEGIN');
  try {
    q.addPayment.run(row.id, row.name, amount, currency, toThb(amount, currency), paidOn, row.next_date, row.next_date, auto ? 1 : 0,
      text(body.note, 300), auto ? null : staff?.email || null, auto ? 'автосписание' : staff?.name || staff?.email || null, at);
    // Разовая оплата — сервис больше не ждёт оплат
    q.setNext.run(next, months ? row.active : 0, at, auto ? 'автосписание' : staff?.name || staff?.email || null, row.id);
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  return next;
}

/** Удалить ошибочную оплату; если она последняя у сервиса — вернуть прежнюю дату оплаты */
export function deletePayment(id, staff) {
  const p = q.payment.get(Number(id));
  if (!p) throw new SettingsError('unknown_payment');
  const row = q.service.get(p.service_id);
  const isLast = q.lastPayment.get(p.service_id)?.id === p.id;
  db.raw.exec('BEGIN');
  try {
    q.removePayment.run(p.id);
    if (row && isLast && p.prev_next) q.setNext.run(p.prev_next, 1, new Date().toISOString(), staff?.name || staff?.email || null, row.id);
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}

/** Оплаты за период — для «Финансов» (статья «IT и подписки»): [from, to) по датам Бангкока */
export function itPaymentsBetween(fromMs, toMs) {
  return q.between.all(bangkokToday(fromMs), bangkokToday(toMs)).map((p) => ({
    at: Date.parse(`${p.paid_on}T05:00:00Z`), thb: p.thb, text: p.service_name + (p.note ? ` — ${p.note}` : '')
  }));
}

/* ---------------------------------------------------- Домены и сертификаты */

/** Адреса сайтов из настроек сервера: публичные сайты, сайт сотрудников, бот */
function siteHosts() {
  const hosts = new Set([...config.site.jetmobilityHosts, ...config.site.kokonHosts]);
  for (const u of [config.staff.url, config.publicBaseUrl]) {
    try { hosts.add(new URL(u).host.toLowerCase()); } catch { /* пропускаем */ }
  }
  return [...hosts].filter((h) => h && h !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(h) && h.includes('.'));
}

/** jetmobility.org из staff.jetmobility.org (для .com/.org/.net — последние две части) */
const registrable = (host) => host.split('.').slice(-2).join('.');

const RDAP_BASE = (process.env.RDAP_BASE || 'https://rdap.org').replace(/\/+$/, '');

async function rdapDomain(domain) {
  const response = await fetch(`${RDAP_BASE}/domain/${encodeURIComponent(domain)}`, {
    headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const event = (action) => (data.events || []).find((e) => e.eventAction === action)?.eventDate || null;
  const registrar = (data.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const vcardName = registrar?.vcardArray?.[1]?.find((f) => f[0] === 'fn')?.[3] || null;
  return {
    expires: event('expiration'), registered: event('registration'), registrar: vcardName,
    status: (data.status || []).slice(0, 6)
  };
}

function sslOf(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      resolve({
        validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
        ok: socket.authorized, error: socket.authorized ? null : String(socket.authorizationError || '')
      });
      socket.end();
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ validTo: null, issuer: null, ok: false, error: 'timeout' }); });
    socket.on('error', (err) => resolve({ validTo: null, issuer: null, ok: false, error: err.code || err.message }));
  });
}

const DOMAINS_KEY = 'it_domains';
const DOMAINS_EVERY_MS = 24 * 3600000;
let checking = null;

function storedDomains() {
  try { return JSON.parse(db.getSetting(DOMAINS_KEY) || 'null'); } catch { return null; }
}

/** Проверка доменов (RDAP) и сертификатов; прошлый ответ не теряем, если сейчас не ответили */
export function checkDomains() {
  if (checking) return checking;
  checking = (async () => {
    const prev = storedDomains() || { domains: {}, hosts: {} };
    const hosts = siteHosts();
    const domains = {};
    for (const d of [...new Set(hosts.map(registrable))]) {
      try {
        domains[d] = { ...(await rdapDomain(d)), checkedAt: new Date().toISOString(), error: null };
      } catch (err) {
        domains[d] = { ...(prev.domains?.[d] || {}), error: err.message };
      }
    }
    const certs = {};
    for (const h of hosts) {
      const ssl = await sslOf(h);
      certs[h] = ssl.validTo ? { ...ssl, checkedAt: new Date().toISOString() } : { ...(prev.hosts?.[h] || {}), ok: false, error: ssl.error };
    }
    const result = { checkedAt: new Date().toISOString(), domains, hosts: certs };
    db.setSetting(DOMAINS_KEY, JSON.stringify(result));
    syncDomainServices(result);
    return result;
  })().catch((err) => {
    console.error('Domain check failed:', err.message);
    return storedDomains();
  }).finally(() => { checking = null; });
  return checking;
}

/** Сервис-домен без даты (или с прошедшей) берёт дату окончания из реестра */
function syncDomainServices(result) {
  for (const row of q.services.all()) {
    if (row.kind !== 'domain' || !row.active) continue;
    const info = result.domains[row.domain || ''] || result.domains[registrable(row.domain || row.name.toLowerCase().split(/\s+/).find((w) => w.includes('.')) || '')];
    const expires = info?.expires?.slice(0, 10);
    if (expires && (!row.next_date || row.next_date < expires)) q.setNext.run(expires, 1, new Date().toISOString(), 'реестр доменов', row.id);
  }
}

function domainsView(today) {
  const saved = storedDomains();
  const hosts = siteHosts();
  const days = (iso) => (iso ? daysBetween(today, iso.slice(0, 10)) : null);
  return {
    checkedAt: saved?.checkedAt || null,
    domains: [...new Set(hosts.map(registrable))].map((d) => {
      const info = saved?.domains?.[d] || {};
      return { domain: d, expires: info.expires || null, days: days(info.expires), registrar: info.registrar || null, error: info.error || null, checkedAt: info.checkedAt || null };
    }),
    hosts: hosts.map((h) => {
      const c = saved?.hosts?.[h] || {};
      return { host: h, validTo: c.validTo || null, days: days(c.validTo), issuer: c.issuer || null, ok: c.ok ?? null, error: c.error || null };
    })
  };
}

/* ------------------------------------------------------- Ключи и связь */

// Что за ключ и зачем — без значений (они только в /opt/kokon/.env)
const KEYS = [
  ['TELEGRAM_BOT_TOKEN', 'Telegram-бот', 'заявки, оповещения, утренняя сводка', true],
  ['RESEND_API_KEY', 'Почта (Resend)', 'коды входа в портал, письма инвесторам', true],
  ['WS_API_URL', 'WS.Автопрокат — адрес', 'сверка статусов и кассы', false],
  ['WS_API_USER', 'WS.Автопрокат — логин', 'сверка статусов и кассы', false],
  ['WS_API_PASSWORD', 'WS.Автопрокат — пароль', 'сверка статусов и кассы', false],
  ['ANTHROPIC_API_KEY', 'ИИ (Claude, Anthropic)', '«＋ Операция»: распознавание фото и документов', false],
  ['INTERNAL_SECRET', 'Связь между частями сервера', 'наблюдатель и WhatsApp-бот (создаётся сам)', true],
  ['DIAG_TOKEN', 'Диагностика для разработчика', 'только чтение журналов и состояния', false],
  ['STAFF_EMAILS', 'Главные админы портала', 'почты, которые нельзя снять в «Доступах»', true]
];

function keysView() {
  const list = KEYS.map(([name, label, purpose, required]) => ({ name, label, purpose, required, set: Boolean(process.env[name]) }));
  // Google-таблица больше не нужна, но файл ключа мог остаться
  let googleFile = false;
  try { googleFile = fs.existsSync(config.google.serviceAccountFile); } catch { /* нет доступа */ }
  if (googleFile || config.google.sheetId) list.push({ name: 'GOOGLE_SA_FILE', label: 'Google-таблица (старое)', purpose: 'больше не используется — можно удалить', required: false, set: true });
  return list;
}

let chatTitle = { id: null, title: null, at: 0 };
async function staffGroupTitle(chatId) {
  if (!telegramEnabled || !chatId) return null;
  if (chatTitle.id === chatId && Date.now() - chatTitle.at < 3600000) return chatTitle.title;
  try {
    const chat = await tg('getChat', { chat_id: chatId });
    chatTitle = { id: chatId, title: chat?.title || null, at: Date.now() };
  } catch {
    chatTitle = { id: chatId, title: null, at: Date.now() };
  }
  return chatTitle.title;
}

async function telegramView() {
  const chatId = getStaffChatId();
  const admins = activeStaff().filter((s) => s.roleId === ADMIN_ROLE);
  return {
    tokenSet: telegramEnabled,
    bot: telegramBotUsername() || null,
    groupBound: Boolean(chatId),
    groupFixed: Boolean(config.telegram.staffChatId),
    groupTitle: await staffGroupTitle(chatId),
    groupLang: config.telegram.groupLang,
    alertsTo: admins.filter((s) => s.telegramId).map((s) => s.name || s.email),
    adminsWithoutTelegram: admins.filter((s) => !s.telegramId).map((s) => s.name || s.email),
    mainAdmins: config.staff.extraEmails.length
  };
}

/* ------------------------------------------------------------ Модель ИИ */

export const AI_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'самая точная — по умолчанию' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'быстрее и дешевле, почти так же точна' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'самая быстрая и дешёвая, для простых фото' }
];
const DEFAULT_LIMIT_USD = 50;

export function aiSettings() {
  const model = db.getSetting('ai_model');
  const limit = Number(db.getSetting('ai_limit_usd'));
  return {
    model: AI_MODELS.some((m) => m.id === model) ? model : AI_MODELS[0].id,
    limitUsd: Number.isFinite(limit) && limit >= 0 && db.getSetting('ai_limit_usd') !== null ? limit : DEFAULT_LIMIT_USD
  };
}

/** Расход на ИИ за текущий месяц (по Бангкоку) */
export function aiMonth(now = Date.now()) {
  const month = bangkokToday(now).slice(0, 7);
  const from = new Date(Date.parse(`${month}-01T00:00:00Z`) - BANGKOK_MS).toISOString();
  const to = new Date(Date.parse(`${addMonths(`${month}-01`, 1)}T00:00:00Z`) - BANGKOK_MS).toISOString();
  const r = q.aiMonth.get(from, to);
  return { month, requests: r.n, usd: Math.round(r.usd * 100) / 100, inputTokens: r.input, outputTokens: r.output };
}

export function saveAi(body) {
  const model = String(body.model || '');
  if (!AI_MODELS.some((m) => m.id === model)) throw new SettingsError('bad_model');
  const limit = Number(String(body.limitUsd ?? '').replace(/[\s,]/g, ''));
  if (!Number.isFinite(limit) || limit < 0 || limit > 100000) throw new SettingsError('bad_limit');
  db.setSetting('ai_model', model);
  db.setSetting('ai_limit_usd', String(limit));
  return aiSettings();
}

/* ------------------------------------------------------ Напоминания админам */

const money = (n, currency) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)} ${currency}`;
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const REMIND_DAYS = new Set([7, 1, 0]);
const REMIND_HOUR = 10;

/** Строки напоминания на сегодня: оплаты, домены, сертификаты (у каждой — свой ключ «уже напомнили») */
export function dueItems(now = Date.now()) {
  const today = bangkokToday(now);
  const items = [];
  for (const row of q.services.all()) {
    const due = dueOf(row, today);
    if (due.days === null || (!REMIND_DAYS.has(due.days) && due.days >= 0)) continue;
    // С автопродлением в просрочку не попадает — оплата записывается сама
    if (row.auto_renew && due.days < 0) continue;
    const when = due.days < 0 ? `просрочено на ${-due.days} дн. (с ${dmy(row.next_date)})` : due.days === 0 ? 'сегодня' : due.days === 1 ? 'завтра' : `через ${due.days} дн. (${dmy(row.next_date)})`;
    const parts = [`${due.days < 0 ? '🔴' : due.days === 0 ? '🟠' : '🟡'} <b>${esc(row.name)}</b> — ${when}`];
    if (row.cost) parts.push(money(row.cost, row.currency));
    if (row.auto_renew) parts.push('спишется автоматически — проверьте карту');
    else if (row.how_to_pay) parts.push(`как: ${esc(row.how_to_pay)}`);
    if (row.responsible) parts.push(`отвечает: ${esc(row.responsible)}`);
    items.push({ key: `svc:${row.id}:${row.next_date}:${due.days < 0 ? today : due.days}`, line: parts.join(' · ') });
  }
  const view = domainsView(today);
  for (const d of view.domains) {
    if (d.days === null || !(d.days <= 30)) continue;
    if (d.days > 7 && d.days !== 30) continue;
    if (d.days >= 0 && d.days <= 7 && !REMIND_DAYS.has(d.days)) continue;
    const when = d.days < 0 ? 'срок истёк!' : d.days === 0 ? 'истекает сегодня' : `истекает через ${d.days} дн. (${dmy(d.expires.slice(0, 10))})`;
    items.push({ key: `dom:${d.domain}:${d.expires}:${d.days < 0 ? today : d.days}`, line: `🌐 Домен <b>${esc(d.domain)}</b> — ${when}${d.registrar ? ` · регистратор: ${esc(d.registrar)}` : ''}` });
  }
  for (const h of view.hosts) {
    // Caddy продлевает сертификаты сам за ~30 дней — меньше 10 дней значит, что продление не идёт
    if (h.days === null || h.days > 10) continue;
    items.push({ key: `ssl:${h.host}:${today}`, line: `🔒 Сертификат <b>${esc(h.host)}</b> — ${h.days < 0 ? 'истёк' : `осталось ${h.days} дн.`}: сам не продлился, нужно проверить сервер` });
  }
  return items;
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Автопродление: в день оплаты (и позже, если сервер был выключен) записываем оплату сами */
function autoRenew(now) {
  const today = bangkokToday(now);
  const lines = [];
  for (const row of q.services.all()) {
    if (!row.active || !row.auto_renew || !row.next_date || row.next_date > today || !row.cost) continue;
    try {
      const next = markPaid({ id: row.id, paidOn: row.next_date }, null, { auto: true, now });
      lines.push(`✅ <b>${esc(row.name)}</b> — списано автоматически ${money(row.cost, row.currency)}${next ? `, следующая оплата ${dmy(next)}` : ''}`);
    } catch (err) {
      console.error(`IT auto-renew ${row.id} failed:`, err.message);
    }
  }
  return lines;
}

export async function runReminders(now = Date.now(), notify = notifyAdmins) {
  const hour = new Date(now + BANGKOK_MS).getUTCHours();
  if (hour < REMIND_HOUR) return { sent: false };
  const renewed = autoRenew(now);
  const fresh = dueItems(now).filter((i) => !q.reminded.get(i.key));
  if (!fresh.length && !renewed.length) return { sent: false };
  const text = ['🔔 <b>Оплаты и сроки</b>', ...fresh.map((i) => i.line), ...renewed, '', `👉 ${config.staff.url}/#settings`].join('\n');
  // Никому не дошло (нет Telegram ID у админов) — не отмечаем, попробуем в следующий раз
  const delivered = await notify(text);
  if (!delivered) return { sent: false, text };
  const at = new Date(now).toISOString();
  for (const i of fresh) q.remind.run(i.key, at);
  return { sent: true, text };
}

export function startItSettings() {
  const domains = () => {
    const saved = storedDomains();
    if (!saved || Date.now() - Date.parse(saved.checkedAt) > DOMAINS_EVERY_MS) checkDomains();
  };
  const remind = () => runReminders().catch((err) => console.error('IT reminders failed:', err.message));
  setTimeout(() => { domains(); remind(); }, 2 * 60 * 1000).unref();
  setInterval(() => { domains(); remind(); }, 30 * 60 * 1000).unref();
}

/* ------------------------------------------------------------- Маршруты */

function needAdmin(staff) {
  if (!can(staff, 'access.admin')) throw new HttpError(403, 'admin_only');
}

async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SettingsError) throw new HttpError(400, err.code);
    throw err;
  }
}

export async function settingsRoute(staff, req, res) {
  needAdmin(staff);
  const today = bangkokToday();
  const services = q.services.all();
  sendJson(res, 200, {
    today,
    telegram: await telegramView(),
    domains: domainsView(today),
    keys: keysView(),
    services: services.map((s) => serviceView(s, today)),
    monthlyThb: monthlyThb(services),
    payments: q.payments.all(30).map(paymentView),
    ai: { ...aiSettings(), models: AI_MODELS, keySet: Boolean(process.env.ANTHROPIC_API_KEY), month: aiMonth() },
    discounts: await discountSettingsView(),
    options: { kinds: KINDS, periods: Object.keys(PERIODS), currencies: CURRENCIES }
  });
}

export const settingsService = async (staff, req, res) => {
  needAdmin(staff);
  const body = await readJson(req);
  sendJson(res, 200, { id: await call(() => saveService(body, staff)) });
};
export const settingsServiceDelete = async (staff, req, res) => {
  needAdmin(staff);
  const { id } = await readJson(req);
  await call(() => deleteService(id));
  sendJson(res, 200, { ok: true });
};
export const settingsPaid = async (staff, req, res) => {
  needAdmin(staff);
  const body = await readJson(req);
  sendJson(res, 200, { nextDate: await call(() => markPaid(body, staff)) });
};
export const settingsPaymentDelete = async (staff, req, res) => {
  needAdmin(staff);
  const { id } = await readJson(req);
  await call(() => deletePayment(id, staff));
  sendJson(res, 200, { ok: true });
};
export const settingsAi = async (staff, req, res) => {
  needAdmin(staff);
  const body = await readJson(req);
  sendJson(res, 200, { ai: await call(() => saveAi(body)) });
};
export const settingsDomainsCheck = async (staff, req, res) => {
  needAdmin(staff);
  await checkDomains();
  sendJson(res, 200, { domains: domainsView(bangkokToday()) });
};
