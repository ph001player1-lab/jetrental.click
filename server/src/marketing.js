/**
 * ============================================================================
 * Маркетинг: источники клиентов и сквозная аналитика
 * ============================================================================
 * Источник — канал, откуда приходят клиенты: сайт, соцсеть, реклама, Google
 * Карты, WhatsApp владельца, агент-частник, партнёр... Их заводит и настраивает
 * админ (или тот, кому открыт «Маркетинг: меняет») и ставит на карту по сетке.
 *
 * У каждого источника свой код. Он попадает в заявку:
 *   - сайт: ссылка вида https://jetmobility.org/?ref=КОД (код помнится 30 дней);
 *   - Telegram-бот: https://t.me/<бот>?start=ref_КОД;
 *   - WhatsApp: готовый текст с «[ref:КОД]» в ссылке wa.me.
 * Заявка с сайта без кода относится к сайту по домену.
 * Дальше заявка → клиент в CRM (по телефону) → брони и аренды → выручка.
 * Расходы: бюджет в месяц или комиссия от выручки. Для каналов, которые
 * система не видит (например, личный WhatsApp владельца), — ручные цифры за месяц.
 * ============================================================================
 */

import * as db from './db.js';
import { requestOutcomes } from './crm.js';
import { tg, telegramEnabled } from './telegram/api.js';
import { siteStats } from './siteStats.js';

const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;
export const GRID = { cols: 25, rows: 18, cell: 40 };
// Офис на карте — восток острова, между Пхукет-Тауном и Талангом
export const HQ = { x: 572, y: 375 };

export const KINDS = {
  site: 'Сайт',
  social: 'Соцсеть',
  ads: 'Реклама',
  maps: 'Google Карты',
  messenger: 'Мессенджер или телефон',
  agent: 'Агент-частник',
  partner: 'Партнёр: отель, компания',
  agency: 'Агентство или маркетолог',
  word: 'Сарафан',
  other: 'Другое'
};
export const CHANNELS = ['site', 'tg', 'wa', 'ig', 'fb'];
const COST_TYPES = ['none', 'budget', 'commission'];
export const REF_DAYS = [0, 30, 60, 90, 180, 365];
// Агент и партнёр важнее рекламы и соцсетей: их клиент остаётся за ними
const isAgentKind = (kind) => kind === 'agent' || kind === 'partner';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS marketing_sources (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    code       TEXT NOT NULL UNIQUE,
    host       TEXT,
    contact    TEXT,
    channels   TEXT NOT NULL DEFAULT '[]',
    cost_type  TEXT NOT NULL DEFAULT 'none',
    cost_value REAL NOT NULL DEFAULT 0,
    badge      TEXT,
    color      TEXT,
    notes      TEXT,
    col        INTEGER,
    row        INTEGER,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS marketing_visits (
    day  TEXT NOT NULL,
    code TEXT NOT NULL,
    n    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, code)
  );
  CREATE TABLE IF NOT EXISTS marketing_manual (
    source_id INTEGER NOT NULL,
    month     TEXT NOT NULL,
    leads     INTEGER NOT NULL DEFAULT 0,
    paid      INTEGER NOT NULL DEFAULT 0,
    revenue   REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (source_id, month)
  );
  CREATE TABLE IF NOT EXISTS chat_refs (
    chat_key TEXT PRIMARY KEY,
    code     TEXT NOT NULL,
    at       TEXT NOT NULL
  );
`);

const q = {
  all: db.raw.prepare('SELECT * FROM marketing_sources ORDER BY id'),
  byId: db.raw.prepare('SELECT * FROM marketing_sources WHERE id = ?'),
  byCode: db.raw.prepare('SELECT * FROM marketing_sources WHERE code = ?'),
  insert: db.raw.prepare(`INSERT INTO marketing_sources (name, kind, code, host, contact, channels, cost_type, cost_value, badge, color, notes, col, row, active, created_at, updated_at)
    VALUES (@name, @kind, @code, @host, @contact, @channels, @cost_type, @cost_value, @badge, @color, @notes, @col, @row, @active, @at, @at)`),
  update: db.raw.prepare(`UPDATE marketing_sources SET name = @name, kind = @kind, code = @code, host = @host, contact = @contact, channels = @channels,
    cost_type = @cost_type, cost_value = @cost_value, badge = @badge, color = @color, notes = @notes, active = @active, updated_at = @at WHERE id = @id`),
  place: db.raw.prepare('UPDATE marketing_sources SET col = ?, row = ?, updated_at = ? WHERE id = ?'),
  remove: db.raw.prepare('DELETE FROM marketing_sources WHERE id = ?'),
  visit: db.raw.prepare(`INSERT INTO marketing_visits (day, code, n) VALUES (?, ?, 1)
    ON CONFLICT(day, code) DO UPDATE SET n = n + 1`),
  visits: db.raw.prepare('SELECT code, SUM(n) n FROM marketing_visits WHERE day >= ? AND day <= ? GROUP BY code'),
  pageViews: db.raw.prepare("SELECT day, host, SUM(requests - bot_requests) n FROM web_traffic WHERE category = 'pages' AND day >= ? AND day <= ? GROUP BY day, host"),
  visitsByDay: db.raw.prepare('SELECT day, code, n FROM marketing_visits WHERE day >= ? AND day <= ?'),
  requestsFull: db.raw.prepare(`SELECT id, created_at, taken_at, channel, status, client_name, model, source_ref, site_host, heard_from
    FROM requests WHERE created_at >= ? AND created_at <= ? AND (kind IS NULL OR kind != 'question') ORDER BY id DESC`),
  manual: db.raw.prepare('SELECT * FROM marketing_manual WHERE month = ?'),
  setManual: db.raw.prepare(`INSERT INTO marketing_manual (source_id, month, leads, paid, revenue) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, month) DO UPDATE SET leads = excluded.leads, paid = excluded.paid, revenue = excluded.revenue`),
  setChatRef: db.raw.prepare(`INSERT INTO chat_refs (chat_key, code, at) VALUES (?, ?, ?)
    ON CONFLICT(chat_key) DO UPDATE SET code = excluded.code, at = excluded.at`),
  chatRef: db.raw.prepare('SELECT code, at FROM chat_refs WHERE chat_key = ?'),
  // Вопросы («Связаться с менеджером») — не заявки: в статистику не идут
  requests: db.raw.prepare("SELECT id, created_at, channel, status, source_ref, site_host, heard_from FROM requests WHERE created_at >= ? AND (kind IS NULL OR kind != 'question') ORDER BY id")
};

// Стартовый список (по словам владельца); агентов-частников админ добавляет сам
if (db.getSetting('marketing_seeded') !== '1') {
  const at = new Date().toISOString();
  const seed = [
    { name: 'jetmobility.org', kind: 'site', code: 'jetmobility', host: 'jetmobility.org', channels: ['site', 'tg', 'wa'], col: 12, row: 9 },
    { name: 'kokoncar.com', kind: 'site', code: 'kokoncar', host: 'kokoncar.com', channels: ['site', 'tg', 'wa'], col: 13, row: 6 },
    { name: 'WhatsApp владельца', kind: 'messenger', code: 'ownerwa', contact: 'Владелец', channels: ['wa'], badge: 'WA', color: '#25d366', col: 13, row: 3 },
    { name: 'Google Карты', kind: 'maps', code: 'gmaps', channels: ['site', 'wa'], col: 10, row: 16 },
    { name: 'Страница Facebook', kind: 'social', code: 'facebook', channels: ['fb'], badge: 'FB', color: '#4b7bec', col: 5, row: 10 },
    { name: 'Страница Instagram', kind: 'social', code: 'instagram', channels: ['ig'], badge: 'IG', color: '#e2557d', col: 6, row: 7 }
  ];
  for (const s of seed) {
    q.insert.run({
      name: s.name, kind: s.kind, code: s.code, host: s.host || null, contact: s.contact || null, channels: JSON.stringify(s.channels),
      cost_type: 'none', cost_value: 0, badge: s.badge || null, color: s.color || null, notes: null, col: s.col, row: s.row, active: 1, at
    });
  }
  db.setSetting('marketing_seeded', '1');
}

export class MarketingError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

const rowOf = (r) => r && {
  id: r.id, name: r.name, kind: r.kind, code: r.code, host: r.host || '', contact: r.contact || '',
  channels: parseJson(r.channels, []).filter((c) => CHANNELS.includes(c)),
  costType: r.cost_type, costValue: r.cost_value || 0, badge: r.badge || '', color: r.color || '', notes: r.notes || '',
  col: r.col, row: r.row, active: Boolean(r.active)
};

export const sourceByCode = (code) => rowOf(q.byCode.get(String(code || '').toLowerCase()));
export const sourceById = (id) => rowOf(q.byId.get(Number(id) || 0));
export const allSources = () => q.all.all().map(rowOf);
/** Ссылки источника: сайт, Telegram-бот, WhatsApp (для кабинета агента) */
export const sourceLinks = (s) => linksOf(s, marketingSettings());
const validCode = (code) => /^[a-z0-9_-]{3,24}$/.test(code);

/* --------------------------------------------------------------- Настройки */

/** Какие каналы ведёт ИИ-бот и данные для ссылок (номер WhatsApp, имя Telegram-бота) */
export function marketingSettings() {
  const saved = parseJson(db.getSetting('marketing_settings') || 'null', {}) || {};
  return {
    bots: { tg: true, wa: false, ig: false, fb: false, ...(saved.bots || {}) },
    // Сколько дней помнить код ссылки; 0 — бессрочно (так решил владелец)
    refDays: REF_DAYS.includes(saved.refDays) ? saved.refDays : 0,
    waNumber: saved.waNumber || '',
    tgBot: saved.tgBot || db.getSetting('tg_bot_username') || '',
    siteHost: saved.siteHost || 'jetmobility.org'
  };
}

export function saveSettings(input) {
  const cur = marketingSettings();
  const bots = { ...cur.bots };
  for (const c of ['tg', 'wa', 'ig', 'fb']) if (typeof input.bots?.[c] === 'boolean') bots[c] = input.bots[c];
  const days = Number(input.refDays);
  const next = {
    bots,
    refDays: input.refDays !== undefined && REF_DAYS.includes(days) ? days : cur.refDays,
    waNumber: input.waNumber !== undefined ? String(input.waNumber).replace(/\D/g, '').slice(0, 15) : cur.waNumber,
    tgBot: input.tgBot !== undefined ? String(input.tgBot).replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) : cur.tgBot,
    siteHost: ['jetmobility.org', 'kokoncar.com'].includes(input.siteHost) ? input.siteHost : cur.siteHost
  };
  db.setSetting('marketing_settings', JSON.stringify(next));
  return next;
}

// Имя Telegram-бота — один раз у самого Telegram, чтобы собирать ссылки t.me
let botNameAsked = false;
function learnBotName() {
  if (botNameAsked || !telegramEnabled || db.getSetting('tg_bot_username')) return;
  botNameAsked = true;
  tg('getMe').then((me) => { if (me?.username) db.setSetting('tg_bot_username', me.username); }).catch(() => {});
}

/** Ссылки источника: сайт, Telegram-бот, WhatsApp */
function linksOf(s, settings) {
  const host = s.kind === 'site' && s.host ? s.host : settings.siteHost;
  const greeting = `Hello! I'd like to rent a vehicle. [ref:${s.code}]`;
  return {
    site: `https://${host}/?ref=${s.code}`,
    tg: settings.tgBot ? `https://t.me/${settings.tgBot}?start=ref_${s.code}` : null,
    wa: settings.waNumber ? `https://wa.me/${settings.waNumber}?text=${encodeURIComponent(greeting)}` : null
  };
}

/* ------------------------------------------------------------- Изменения */

// Кириллица → латиница для кода ссылки («Агент Сергей» → agentsergey)
const TRANSLIT = Object.fromEntries('а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:ts ч:ch ш:sh щ:sch ъ: ы:y ь: э:e ю:yu я:ya'
  .split(' ').map((pair) => pair.split(':')));

function slugCode(name) {
  const base = String(name || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[а-яё]/g, (ch) => TRANSLIT[ch] ?? '')
    .replace(/[^a-z0-9]+/g, '').slice(0, 14);
  let code = base.length >= 3 ? base : `src${Math.random().toString(36).slice(2, 7)}`;
  for (let i = 2; q.byCode.get(code); i++) code = `${base || 'src'}${i}`;
  return code;
}

/** Создать или изменить источник */
export function saveSource(input) {
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw new MarketingError('name_required');
  const kind = KINDS[input.kind] ? input.kind : 'other';
  const old = input.id ? rowOf(q.byId.get(Number(input.id))) : null;
  if (input.id && !old) throw new MarketingError('not_found');
  let code = String(input.code ?? '').trim().toLowerCase();
  if (!code) code = old?.code || slugCode(name);
  if (!validCode(code)) throw new MarketingError('invalid_code');
  const taken = q.byCode.get(code);
  if (taken && taken.id !== old?.id) throw new MarketingError('code_taken');
  const costType = COST_TYPES.includes(input.costType) ? input.costType : 'none';
  const costValue = Math.max(0, Math.min(costType === 'commission' ? 100 : 1e9, Number(input.costValue) || 0));
  const row = {
    name, kind, code,
    host: kind === 'site' ? String(input.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 80) || null : null,
    contact: String(input.contact || '').trim().slice(0, 120) || null,
    channels: JSON.stringify((Array.isArray(input.channels) ? input.channels : []).filter((c) => CHANNELS.includes(c))),
    cost_type: costType, cost_value: costType === 'none' ? 0 : costValue,
    badge: String(input.badge || '').trim().slice(0, 3) || null,
    color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : null,
    notes: String(input.notes || '').trim().slice(0, 1000) || null,
    active: input.active === false ? 0 : 1,
    at: new Date().toISOString()
  };
  let id = old?.id;
  if (old) q.update.run({ ...row, id: old.id });
  else id = Number(q.insert.run({ ...row, col: null, row: null }).lastInsertRowid);
  if (input.manual && typeof input.manual === 'object') setManual(id, input.manual);
  return id;
}

export function placeSource(id, col, row) {
  const s = rowOf(q.byId.get(Number(id)));
  if (!s) throw new MarketingError('not_found');
  const c = Math.round(Number(col));
  const r = Math.round(Number(row));
  if (!(c >= 0 && c < GRID.cols && r >= 0 && r < GRID.rows)) throw new MarketingError('bad_cell');
  q.place.run(c, r, new Date().toISOString(), s.id);
}

export function deleteSource(id) {
  if (!q.byId.get(Number(id))) throw new MarketingError('not_found');
  q.remove.run(Number(id));
}

const monthOf = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 7);

/** Ручные цифры за текущий месяц (для каналов, которые система не видит сама) */
function setManual(id, m) {
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  q.setManual.run(id, monthOf(Date.now()), n(m.leads), n(m.paid), n(m.revenue));
}

/* ------------------------------------------------- Метки заявок и переходы */

/** Переход по реферальной ссылке (с сайта, один раз за посещение) */
export function countVisit(code) {
  const s = sourceByCode(code);
  if (!s || !s.active) return false;
  q.visit.run(new Date(Date.now() + BANGKOK_MS).toISOString().slice(0, 10), s.code);
  return true;
}

/** Код из первого сообщения боту: «/start ref_КОД» (Telegram) или «[ref:КОД]» (WhatsApp) */
export function refFromText(text) {
  return refsFromText(text)[0] || null;
}

/** Все коды из сообщения по порядку: сайт пишет «[ref:сайт] [ref:агент]…» (от старого к новому) */
export function refsFromText(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:^\/start\s+ref_|\[?\bref[:_#\s-]+)([a-z0-9_-]{3,24})/gi)) {
    const code = m[1].toLowerCase();
    if (sourceByCode(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Код источника «Сайт» для домена (jetmobility.org → jetmobility) — метка в кнопках WhatsApp сайта */
export function siteSourceCode(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const s = q.all.all().map(rowOf).find((x) => x.active && x.kind === 'site' && String(x.host || '').toLowerCase().replace(/^www\./, '') === h);
  return s ? s.code : null;
}

const fresh = (at) => {
  const days = marketingSettings().refDays;
  return !days || Date.now() - Date.parse(at) <= days * DAY_MS;
};

/** Записать источник чата: код (агент не перебивается рекламой) или ответ «откуда узнали» с «~» */
function setChatSource(chatKey, value) {
  const cur = q.chatRef.get(chatKey);
  if (cur && fresh(cur.at) && !value.startsWith('~')) {
    const old = sourceByCode(cur.code);
    const next = sourceByCode(value);
    if (old && isAgentKind(old.kind) && next && !isAgentKind(next.kind)) return;
  }
  q.setChatRef.run(chatKey, value, new Date().toISOString());
}

/**
 * Запомнить код источника для чата бота (из первого сообщения). Кодов может
 * быть несколько — по порядку, как с сайта: агент не перебивается остальными,
 * иначе засчитывается последний.
 */
export function rememberChatRef(chatKey, text) {
  const codes = refsFromText(text);
  for (const code of codes) setChatSource(chatKey, code);
  return codes[codes.length - 1] || null;
}

/** Код источника чата (с учётом срока из настроек); ответы «откуда узнали» кодом не считаются */
export function chatRefOf(chatKey) {
  const r = q.chatRef.get(chatKey);
  return r && fresh(r.at) && !r.code.startsWith('~') && sourceByCode(r.code) ? r.code : null;
}

/** Спрашивали ли уже этот чат «откуда узнали» (или он пришёл по ссылке) */
export const chatSourceKnown = (chatKey) => { const r = q.chatRef.get(chatKey); return Boolean(r && fresh(r.at)); };

/**
 * Коды с сайта: [{ code, at }] — что сайт запомнил. Берём свежие (по сроку из
 * настроек); если среди них есть агент или партнёр — его, иначе последний переход.
 */
export function resolveSiteRefs(refs) {
  const list = (Array.isArray(refs) ? refs : []).slice(0, 20)
    .map((r) => ({ code: String(r?.code || '').toLowerCase(), at: Number(r?.at) || 0 }))
    .map((r) => ({ ...r, s: sourceByCode(r.code) }))
    .filter((r) => r.s && r.s.active && r.at && fresh(new Date(r.at).toISOString()));
  if (!list.length) return null;
  const agents = list.filter((r) => isAgentKind(r.s.kind));
  return (agents.length ? agents : list).sort((a, b) => b.at - a.at)[0].code;
}

/* ------------------------------------------ Вопрос бота «Откуда узнали?» */

const PLATFORMS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['telegram', 'Telegram'], ['vk', 'VK']];
const platformOf = (s) => PLATFORMS.find(([key]) => `${s.code} ${s.name} ${s.badge}`.toLowerCase().includes(key))?.[1] || null;

/**
 * Варианты ответа — из источников «Маркетинга» (добавили источник — появилась кнопка).
 * key: «@код» — конкретный источник; maps / site / ads / agent / friends / repeat / other.
 * label: строка (название площадки) или ключ перевода бота.
 */
export function heardOptions() {
  const list = q.all.all().map(rowOf).filter((s) => s.active);
  const out = [];
  const has = (kind) => list.some((s) => s.kind === kind);
  if (has('maps')) out.push({ key: 'maps', label: { text: 'heard_maps' } });
  const seen = new Set();
  for (const s of list.filter((x) => x.kind === 'social')) {
    const name = platformOf(s);
    if (!name || seen.has(name) || seen.size >= 3) continue;
    seen.add(name);
    out.push({ key: `@${s.code}`, label: name });
  }
  if (has('site')) out.push({ key: 'site', label: { text: 'heard_site' } });
  if (has('ads')) out.push({ key: 'ads', label: { text: 'heard_ads' } });
  out.push({ key: 'agent', label: { text: 'heard_agent' } });
  out.push({ key: 'friends', label: { text: 'heard_friends' } });
  out.push({ key: 'repeat', label: { text: 'heard_repeat' } });
  out.push({ key: 'other', label: { text: 'heard_other' } });
  return out;
}

const normName = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Ответ клиента → { code, text }: code — источник (если нашёлся), text — ответ
 * словами для «без источника» (друзья, уже брали, другое, агент не из списка).
 */
export function resolveHeard(key, typed = '') {
  const list = q.all.all().map(rowOf).filter((s) => s.active);
  const first = (pred) => list.find(pred)?.code || null;
  const settings = marketingSettings();
  if (key.startsWith('@') && sourceByCode(key.slice(1))) return { code: key.slice(1), text: null };
  if (key === 'maps') return { code: first((s) => s.kind === 'maps'), text: 'Google Карты' };
  if (key === 'site') return { code: first((s) => s.kind === 'site' && s.host === settings.siteHost) || first((s) => s.kind === 'site'), text: 'сайт' };
  if (key === 'ads') return { code: first((s) => s.kind === 'ads'), text: 'реклама' };
  if (key === 'friends') return { code: first((s) => s.kind === 'word'), text: 'друзья, знакомые' };
  if (key === 'repeat') return { code: null, text: 'уже брал(а) у нас' };
  if (key === 'agent') {
    const name = normName(typed);
    const hit = name.length >= 3 && list.find((s) => isAgentKind(s.kind) && (normName(s.name).includes(name) || name.includes(normName(s.name).replace(/^агент /, ''))));
    return { code: hit ? hit.code : null, text: `отель или агент: ${String(typed).trim().slice(0, 80)}` };
  }
  return { code: null, text: `другое: ${String(typed).trim().slice(0, 120)}` };
}

/** Запомнить ответ «откуда узнали» для чата, чтобы не спрашивать снова */
export function rememberHeard(chatKey, { code, text }) {
  setChatSource(chatKey, code || `~${String(text || '').slice(0, 60)}`);
}

/* ---------------------------------------------------------------- Отчёт */

function rangeOf(period, now) {
  const today = new Date(now + BANGKOK_MS).toISOString().slice(0, 10);
  const startOf = (iso) => Date.parse(`${iso}T00:00:00+07:00`);
  if (period === 'today') return { from: startOf(today), to: now, days: 1, fromDay: today, toDay: today };
  if (period === 'week') {
    const from = startOf(today) - 6 * DAY_MS;
    return { from, to: now, days: 7, fromDay: new Date(from + BANGKOK_MS).toISOString().slice(0, 10), toDay: today };
  }
  const fromDay = `${today.slice(0, 8)}01`;
  return { from: startOf(fromDay), to: now, days: Number(today.slice(8, 10)), fromDay, toDay: today };
}

const zero = () => ({ visits: 0, refVisits: 0, views: 0, visitors: 0, leads: 0, answered: 0, booked: 0, paid: 0, revenue: 0, cost: 0 });

/**
 * Просмотры сайтов по дням: подробная статистика (только открытые страницы, без
 * перенаправлений) там, где она уже собрана, иначе — прежний подсчёт по журналу.
 */
function siteViews(fromDay, toDay) {
  const stats = siteStats(fromDay, toDay);
  const fresh = new Map(stats.views.map((v) => [`${v.day}|${v.host}`, v.n]));
  const days = new Map();
  for (const r of q.pageViews.all(fromDay, toDay)) days.set(`${r.day}|${r.host}`, fresh.get(`${r.day}|${r.host}`) ?? r.n);
  for (const [key, n] of fresh) days.set(key, n);
  const byHost = new Map();
  const byDay = new Map();
  for (const [key, n] of days) {
    const [day, host] = key.split('|');
    byHost.set(host, (byHost.get(host) || 0) + n);
    byDay.set(day, (byDay.get(day) || 0) + n);
  }
  const visitors = new Map();
  const visitorsByDay = new Map();
  for (const v of stats.visitors) {
    visitors.set(v.host, (visitors.get(v.host) || 0) + v.n);
    visitorsByDay.set(v.day, (visitorsByDay.get(v.day) || 0) + v.n);
  }
  return { byHost, byDay, visitors, visitorsByDay, stats };
}

/** Источник заявки: по коду, иначе сайт по домену; null — без метки */
function attribute(req, byCode, byHost) {
  if (req.source_ref && byCode.has(req.source_ref)) return byCode.get(req.source_ref);
  if (req.channel === 'site' && req.site_host && byHost.has(req.site_host)) return byHost.get(req.site_host);
  return null;
}

export async function marketingReport(period = 'month', now = Date.now()) {
  learnBotName();
  const settings = marketingSettings();
  const range = rangeOf(['today', 'week', 'month'].includes(period) ? period : 'month', now);
  const month = rangeOf('month', now);
  const today = rangeOf('today', now);
  const sources = q.all.all().map(rowOf);
  const byCode = new Map(sources.map((s) => [s.code, s]));
  const byHost = new Map(sources.filter((s) => s.kind === 'site' && s.host).map((s) => [s.host, s]));
  const since = Math.min(range.from, month.from, now - 90 * DAY_MS);
  const requests = q.requests.all(new Date(since).toISOString());
  let outcomes = new Map();
  try {
    outcomes = await requestOutcomes(now);
  } catch (err) {
    console.error('Marketing outcomes failed:', err.message);
  }

  const m = new Map(sources.map((s) => [s.id, {
    period: zero(), today: { leads: 0 }, month: { leads: 0, revenue: 0, paid: 0 }, week: { leads: 0, answered: 0 }, sales90: 0
  }]));
  const unattributed = { leads: 0, answers: {} };
  for (const r of requests) {
    const at = Date.parse(r.created_at);
    const s = attribute(r, byCode, byHost);
    const o = outcomes.get(r.id) || { booked: false, paid: false, revenue: 0 };
    if (!s) {
      if (at >= range.from && at <= range.to) {
        unattributed.leads++;
        // Что ответил клиент на «откуда узнали» (без «: подробности»)
        const answer = r.heard_from ? r.heard_from.split(':')[0] : 'не спрашивали';
        unattributed.answers[answer] = (unattributed.answers[answer] || 0) + 1;
      }
      continue;
    }
    const x = m.get(s.id);
    if (at >= range.from && at <= range.to) {
      x.period.leads++;
      if (r.status !== 'new') x.period.answered++;
      if (o.booked) x.period.booked++;
      if (o.paid) x.period.paid++;
      x.period.revenue += o.revenue;
    }
    if (at >= today.from) x.today.leads++;
    if (at >= month.from) { x.month.leads++; x.month.revenue += o.revenue; if (o.paid) x.month.paid++; }
    if (at >= now - 7 * DAY_MS) { x.week.leads++; if (r.status !== 'new') x.week.answered++; }
    if (o.paid && at >= now - 90 * DAY_MS) x.sales90++;
  }
  // Переходы: по реферальным ссылкам; у сайтов — ещё и просмотры страниц их домена
  const visits = new Map(q.visits.all(range.fromDay, range.toDay).map((r) => [r.code, r.n]));
  const { byHost: views, visitors } = siteViews(range.fromDay, range.toDay);
  // Ручные цифры — только за месяц (их вводят по месяцам)
  const manual = new Map(q.manual.all(monthOf(now)).map((r) => [r.source_id, r]));

  const out = sources.map((s) => {
    const x = m.get(s.id);
    const p = x.period;
    p.refVisits = visits.get(s.code) || 0;
    p.views = s.kind === 'site' && s.host ? views.get(s.host) || 0 : 0;
    p.visitors = s.kind === 'site' && s.host ? visitors.get(s.host) || 0 : 0;
    p.visits = p.refVisits + p.views;
    const man = manual.get(s.id);
    if (man) {
      x.month.leads += man.leads;
      x.month.paid += man.paid;
      x.month.revenue += man.revenue;
      if (range.from === month.from) {
        p.leads += man.leads; p.answered += man.leads; p.booked += man.paid; p.paid += man.paid; p.revenue += man.revenue;
      }
    }
    if (s.costType === 'budget') p.cost = (s.costValue * range.days) / 30;
    if (s.costType === 'commission') p.cost = (p.revenue * s.costValue) / 100;
    const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]));
    return {
      ...s,
      links: linksOf(s, settings),
      metrics: round(p),
      today: x.today,
      month: round(x.month),
      // «Здоровье» — доля заявок с ответом за 7 дней; «уровень» — по продажам за 90 дней
      health: x.week.leads ? Math.round((x.week.answered / x.week.leads) * 100) : null,
      level: 1 + Math.floor(Math.log2(1 + x.sales90)),
      manual: man ? { leads: man.leads, paid: man.paid, revenue: man.revenue } : null
    };
  });
  const totals = zero();
  for (const s of out) if (s.active) for (const k of Object.keys(totals)) totals[k] += s.metrics[k];
  return {
    period, range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), days: range.days },
    sources: out, totals, unattributed, settings, kinds: KINDS, grid: GRID, hq: HQ, month: monthOf(now)
  };
}

/* ------------------------------------------------- Подробности по блокам */

const STATUS = { new: 'ждёт ответа', taken: 'взята в работу', declined: 'отклонена' };

/**
 * Подробности для верхних блоков вкладки: visits — переходы и сайты;
 * leads / answered / paid — заявки за период с источником и итогом.
 */
export async function marketingDetails(metric, period = 'month', now = Date.now()) {
  const range = rangeOf(['today', 'week', 'month'].includes(period) ? period : 'month', now);
  const sources = q.all.all().map(rowOf);
  const byCode = new Map(sources.map((s) => [s.code, s]));
  const byHost = new Map(sources.filter((s) => s.kind === 'site' && s.host).map((s) => [s.host, s]));
  if (metric === 'visits') {
    const sv = siteViews(range.fromDay, range.toDay);
    const refByDay = new Map();
    const refBySource = new Map();
    for (const r of q.visitsByDay.all(range.fromDay, range.toDay)) {
      refByDay.set(r.day, (refByDay.get(r.day) || 0) + r.n);
      refBySource.set(r.code, (refBySource.get(r.code) || 0) + r.n);
    }
    const days = [];
    for (let t = range.from; t <= range.to; t += DAY_MS) {
      const day = new Date(t + BANGKOK_MS).toISOString().slice(0, 10);
      if (!days.some((d) => d.day === day)) days.push({ day, views: sv.byDay.get(day) || 0, visitors: sv.visitorsByDay.get(day) || 0, refVisits: refByDay.get(day) || 0 });
    }
    const since = db.raw.prepare('SELECT MIN(day) d FROM web_stats').get()?.d || null;
    return {
      metric, range: { from: range.fromDay, to: range.toDay }, since,
      bySource: sources.map((s) => ({
        id: s.id, name: s.name, kind: s.kind, refVisits: refBySource.get(s.code) || 0,
        views: s.kind === 'site' && s.host ? sv.byHost.get(s.host) || 0 : 0,
        visitors: s.kind === 'site' && s.host ? sv.visitors.get(s.host) || 0 : 0
      })).sort((a, b) => (b.views + b.refVisits) - (a.views + a.refVisits)),
      byDay: days.reverse(),
      pages: sv.stats.pages, refs: sv.stats.refs, utm: sv.stats.utm, devices: sv.stats.devices
    };
  }
  let outcomes = new Map();
  try {
    outcomes = await requestOutcomes(now);
  } catch { /* без CRM — без продаж */ }
  const rows = q.requestsFull.all(new Date(range.from).toISOString(), new Date(range.to).toISOString()).map((r) => {
    const s = attribute(r, byCode, byHost);
    const o = outcomes.get(r.id) || { booked: false, paid: false, revenue: 0 };
    return {
      id: r.id, at: r.created_at, client: r.client_name || '—', channel: r.channel, model: r.model || null,
      source: s ? s.name : r.heard_from ? `без источника: ${r.heard_from}` : 'без источника',
      sourceId: s ? s.id : null, status: STATUS[r.status] || r.status,
      answerMin: r.taken_at ? Math.max(0, Math.round((Date.parse(r.taken_at) - Date.parse(r.created_at)) / 60000)) : null,
      booked: o.booked, paid: o.paid, revenue: Math.round(o.revenue)
    };
  });
  const list = metric === 'paid' ? rows.filter((r) => r.paid) : rows;
  // Время ответа по источникам (для «Ответили»)
  const speed = new Map();
  for (const r of rows) {
    if (r.answerMin === null) continue;
    const x = speed.get(r.source) || { source: r.source, n: 0, total: 0 };
    x.n++; x.total += r.answerMin;
    speed.set(r.source, x);
  }
  return {
    metric, range: { from: range.fromDay, to: range.toDay },
    rows: list.slice(0, 500),
    speed: [...speed.values()].map((x) => ({ source: x.source, n: x.n, avgMin: Math.round(x.total / x.n) })).sort((a, b) => a.avgMin - b.avgMin)
  };
}
