/**
 * ============================================================================
 * CRM: клиенты, история аренд и оплат, метки, заметки, чёрный список
 * ============================================================================
 * Откуда клиенты:
 *  - список клиентов WS (.xlsx «Клиенты»: Имя, Телефон) — загружает сотрудник
 *    с правом «CRM: меняет»; повторная загрузка обновляет, а не задваивает;
 *  - отчёты рабочей группы: строка «Contact» (телефон или @telegram) — новый
 *    контакт сам становится клиентом (так со временем можно обойтись без WS);
 *  - заявки с сайта и из ботов.
 * История аренды: отчёты группы (по контакту; продление и возврат той же машины
 * без контакта — к той же аренде) и касса WS (по имени клиента, как в WS).
 * Телефон сравниваем по последним 9 цифрам: «+7 937…», «8 937…» и «937…» — один.
 * Номер, записанный у 4+ клиентов (заглушка), для поиска не используем.
 * Данные клиентов — только в базе сервера (не в git и не в Google-таблице).
 * ============================================================================
 */

import * as db from './db.js';
import { readFirstSheet } from './xlsx.js';
import { moneyOf, withoutRepeats, findDebts, currentRates } from './finance.js';
import { groupStatusByPlate } from './journal/reconcile.js';
import { getFleet, plateKey } from './fleet.js';
import { staffPhones } from './staffUsers.js';

const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;
const LOST_DAYS = 90;
const NEW_DAYS = 30;
const SHARED_PHONE = 4;
const MATCH_MS = 3 * DAY_MS;
const CACHE_MS = 60000;
const REPORT_KINDS = ['booking', 'issue', 'extension', 'payment', 'return', 'changed'];

export const TAGS = [
  ['regular', 'Постоянный'],
  ['vip', 'VIP'],
  ['problem', 'Проблемный'],
  ['blacklist', 'Чёрный список']
];
const TAG_IDS = TAGS.map(([id]) => id);

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS crm_clients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phones      TEXT NOT NULL DEFAULT '[]',
    telegram    TEXT,
    chat        TEXT,
    ws_name     TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',
    source      TEXT NOT NULL,
    merged_into INTEGER,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS crm_clients_ws ON crm_clients (ws_name);
  CREATE TABLE IF NOT EXISTS crm_notes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    at        TEXT NOT NULL,
    by        TEXT NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'note',
    text      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS crm_notes_client ON crm_notes (client_id);
`);

const q = {
  all: db.raw.prepare('SELECT * FROM crm_clients ORDER BY id'),
  byId: db.raw.prepare('SELECT * FROM crm_clients WHERE id = ?'),
  insert: db.raw.prepare(`INSERT INTO crm_clients (name, phones, telegram, chat, ws_name, tags, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)`),
  update: db.raw.prepare('UPDATE crm_clients SET name = ?, phones = ?, telegram = ?, ws_name = ?, updated_at = ? WHERE id = ?'),
  setTags: db.raw.prepare('UPDATE crm_clients SET tags = ?, updated_at = ? WHERE id = ?'),
  setTelegram: db.raw.prepare('UPDATE crm_clients SET telegram = ?, updated_at = ? WHERE id = ?'),
  merge: db.raw.prepare('UPDATE crm_clients SET merged_into = ?, updated_at = ? WHERE id = ?'),
  notes: db.raw.prepare('SELECT * FROM crm_notes WHERE client_id = ? ORDER BY id DESC LIMIT 200'),
  addNote: db.raw.prepare('INSERT INTO crm_notes (client_id, at, by, kind, text) VALUES (?, ?, ?, ?, ?)'),
  moveNotes: db.raw.prepare('UPDATE crm_notes SET client_id = ? WHERE client_id = ?'),
  noteCounts: db.raw.prepare("SELECT client_id, COUNT(*) n FROM crm_notes WHERE kind = 'note' GROUP BY client_id")
};

export class CrmError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/* ---------------------------------------------------------- Телефоны и страны */

const nowIso = () => new Date().toISOString();
const digits = (s) => String(s || '').replace(/\D/g, '');
export const phoneKey = (s) => {
  const d = digits(s);
  return d.length >= 8 ? d.slice(-9) : null;
};
const normName = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

/** «+7 937 350-05-00, +66 81…» → ['+79373500500', '+6681…'] */
export function splitPhones(text) {
  return String(text || '').split(/[,;/\n]|\s{2,}/)
    .map((p) => p.trim())
    .filter((p) => digits(p).length >= 6)
    .map((p) => `${/^\s*\+/.test(p) ? '+' : ''}${digits(p)}`);
}

/** Телефоны и @telegram из строки «Contact» отчёта */
export function contactKeys(text) {
  const raw = String(text || '');
  const phones = (raw.match(/\+?\d[\d\s\-‑–()]{6,}\d/g) || []).map((p) => `${p.trim().startsWith('+') ? '+' : ''}${digits(p)}`).filter((p) => digits(p).length >= 8);
  const tg = /(?:t\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,31})/.exec(raw)?.[1];
  return { phones, telegram: tg ? `@${tg.toLowerCase()}` : null };
}

// Код страны → [ISO, название] (Казахстан: +7 7xx)
const COUNTRIES = {
  7: ['RU', 'Россия'], 66: ['TH', 'Таиланд'], 44: ['GB', 'Великобритания'], 971: ['AE', 'ОАЭ'], 33: ['FR', 'Франция'],
  49: ['DE', 'Германия'], 61: ['AU', 'Австралия'], 380: ['UA', 'Украина'], 31: ['NL', 'Нидерланды'], 1: ['US', 'США / Канада'],
  375: ['BY', 'Беларусь'], 972: ['IL', 'Израиль'], 86: ['CN', 'Китай'], 91: ['IN', 'Индия'], 46: ['SE', 'Швеция'],
  48: ['PL', 'Польша'], 420: ['CZ', 'Чехия'], 39: ['IT', 'Италия'], 34: ['ES', 'Испания'], 65: ['SG', 'Сингапур'],
  60: ['MY', 'Малайзия'], 62: ['ID', 'Индонезия'], 82: ['KR', 'Корея'], 81: ['JP', 'Япония'], 998: ['UZ', 'Узбекистан'],
  996: ['KG', 'Киргизия'], 994: ['AZ', 'Азербайджан'], 995: ['GE', 'Грузия'], 374: ['AM', 'Армения'], 41: ['CH', 'Швейцария'],
  43: ['AT', 'Австрия'], 45: ['DK', 'Дания'], 47: ['NO', 'Норвегия'], 358: ['FI', 'Финляндия'], 32: ['BE', 'Бельгия'],
  353: ['IE', 'Ирландия'], 351: ['PT', 'Португалия'], 30: ['GR', 'Греция'], 90: ['TR', 'Турция'], 64: ['NZ', 'Новая Зеландия'],
  27: ['ZA', 'ЮАР'], 55: ['BR', 'Бразилия'], 52: ['MX', 'Мексика'], 54: ['AR', 'Аргентина'], 84: ['VN', 'Вьетнам'],
  63: ['PH', 'Филиппины'], 95: ['MM', 'Мьянма'], 855: ['KH', 'Камбоджа'], 852: ['HK', 'Гонконг'], 886: ['TW', 'Тайвань'],
  966: ['SA', 'Саудовская Аравия'], 974: ['QA', 'Катар'], 965: ['KW', 'Кувейт'], 373: ['MD', 'Молдова'], 370: ['LT', 'Литва'],
  371: ['LV', 'Латвия'], 372: ['EE', 'Эстония'], 36: ['HU', 'Венгрия'], 40: ['RO', 'Румыния'], 359: ['BG', 'Болгария'],
  381: ['RS', 'Сербия'], 385: ['HR', 'Хорватия'], 386: ['SI', 'Словения'], 421: ['SK', 'Словакия'], 992: ['TJ', 'Таджикистан'],
  993: ['TM', 'Туркменистан'], 976: ['MN', 'Монголия'], 20: ['EG', 'Египет'], 212: ['MA', 'Марокко'], 357: ['CY', 'Кипр']
};

/** Страна по номеру: { code: 'RU', name: 'Россия' } или null (номер без «+» или неизвестный код) */
export function countryOf(phone) {
  if (!String(phone || '').startsWith('+')) return null;
  const d = digits(phone);
  if (d.startsWith('77') && d.length === 11) return { code: 'KZ', name: 'Казахстан' };
  for (const len of [3, 2, 1]) {
    const c = COUNTRIES[d.slice(0, len)];
    if (c) return { code: c[0], name: c[1] };
  }
  return null;
}

/* ------------------------------------------------------------ Строки базы */

const rowOf = (r) => r && {
  id: r.id, name: r.name, phones: parseJson(r.phones, []), telegram: r.telegram || null, chat: r.chat || null,
  wsName: r.ws_name || null, tags: parseJson(r.tags, []).filter((t) => TAG_IDS.includes(t)), source: r.source,
  mergedInto: r.merged_into || null, createdAt: r.created_at
};

function addClient({ name, phones = [], telegram = null, chat = null, wsName = null, source }) {
  const info = q.insert.run(String(name || '').slice(0, 120) || '—', JSON.stringify(phones), telegram, chat, wsName, source, nowIso(), nowIso());
  return Number(info.lastInsertRowid);
}

/** Номера (ключи), записанные у 4+ клиентов, — заглушки, для поиска не берём */
function sharedKeys(rows) {
  const count = new Map();
  for (const r of rows) {
    if (r.mergedInto) continue;
    for (const key of new Set(r.phones.map(phoneKey).filter(Boolean))) count.set(key, (count.get(key) || 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n >= SHARED_PHONE).map(([k]) => k));
}

/** Поиск клиента по телефону / telegram / чату бота (с учётом объединённых) */
function lookupMaps(rows) {
  const shared = sharedKeys(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const finalId = (id) => {
    let r = byId.get(id);
    for (let i = 0; r?.mergedInto && i < 10; i++) r = byId.get(r.mergedInto);
    return r?.id ?? id;
  };
  const byPhone = new Map();
  const byTg = new Map();
  const byChat = new Map();
  const byWsName = new Map();
  // Сначала живые клиенты, потом объединённые: ключ ведёт на того, в кого объединили
  for (const r of [...rows].sort((a, b) => Boolean(a.mergedInto) - Boolean(b.mergedInto) || a.id - b.id)) {
    const id = finalId(r.id);
    for (const p of r.phones) {
      const key = phoneKey(p);
      if (key && !shared.has(key) && !byPhone.has(key)) byPhone.set(key, id);
    }
    if (r.telegram && !byTg.has(r.telegram)) byTg.set(r.telegram, id);
    if (r.chat && !byChat.has(r.chat)) byChat.set(r.chat, id);
    if (r.wsName && !byWsName.has(normName(r.wsName))) byWsName.set(normName(r.wsName), id);
  }
  const match = ({ phones = [], telegram = null, chat = null }) => {
    for (const p of phones) {
      const id = byPhone.get(phoneKey(p));
      if (id) return id;
    }
    return (telegram && byTg.get(telegram)) || (chat && byChat.get(chat)) || null;
  };
  return { shared, finalId, byPhone, byTg, byChat, byWsName, match };
}

/* ------------------------------------------------- Новые клиенты из группы */

/** Контакты отчётов группы и заявок, которых ещё нет в CRM, — новые клиенты */
function syncContacts() {
  const rows = q.all.all().map(rowOf);
  const maps = lookupMaps(rows);
  const reports = db.raw.prepare(`SELECT data FROM wa_messages WHERE kind IN (${REPORT_KINDS.map(() => '?').join(',')}) AND status != 'ignored' ORDER BY ts`).all(...REPORT_KINDS);
  let added = 0;
  const remember = (id, keys) => {
    for (const p of keys.phones) { const k = phoneKey(p); if (k && !maps.shared.has(k) && !maps.byPhone.has(k)) maps.byPhone.set(k, id); }
    if (keys.telegram && !maps.byTg.has(keys.telegram)) maps.byTg.set(keys.telegram, id);
    if (keys.chat && !maps.byChat.has(keys.chat)) maps.byChat.set(keys.chat, id);
  };
  for (const r of reports) {
    const contact = parseJson(r.data, {}).fields?.contact;
    if (!contact) continue;
    const keys = contactKeys(contact);
    if (!keys.phones.length && !keys.telegram) continue;
    const found = maps.match(keys);
    if (found) {
      // Нашли по телефону, а в отчёте ещё и telegram — запомним его у клиента
      const row = rows.find((x) => x.id === found);
      if (keys.telegram && row && !row.telegram && !maps.byTg.has(keys.telegram)) {
        q.setTelegram.run(keys.telegram, nowIso(), found);
        row.telegram = keys.telegram;
        maps.byTg.set(keys.telegram, found);
      }
      continue;
    }
    const id = addClient({ name: keys.telegram || keys.phones[0], phones: keys.phones, telegram: keys.telegram, source: 'group' });
    remember(id, keys);
    added++;
  }
  // Заявки с сайта и из ботов
  for (const r of db.raw.prepare('SELECT client_name, client_phone, channel, client_chat_id FROM requests ORDER BY id').all()) {
    const keys = { phones: splitPhones(r.client_phone).filter((p) => digits(p).length >= 8), telegram: null, chat: r.client_chat_id ? `${r.channel}:${r.client_chat_id}` : null };
    if (!keys.phones.length && !keys.chat) continue;
    if (maps.match(keys)) continue;
    const id = addClient({ name: r.client_name || keys.phones[0] || 'Клиент из заявки', phones: keys.phones, chat: keys.chat, source: 'request' });
    remember(id, keys);
    added++;
  }
  if (added) console.log(`CRM: ${added} new client(s) from group reports and requests`);
  return added;
}

/* ------------------------------------------------------- Загрузка из WS */

/** Список клиентов WS (.xlsx): { rows, added, updated } */
export function importClients(buffer, by) {
  let table;
  try {
    table = readFirstSheet(buffer);
  } catch {
    throw new CrmError('not_clients');
  }
  const h = table.findIndex((r) => r.includes('Имя') && r.includes('Телефон'));
  if (h < 0) throw new CrmError('not_clients');
  const nameCol = table[h].indexOf('Имя');
  const phoneCol = table[h].indexOf('Телефон');
  const rows = q.all.all().map(rowOf);
  // Тот же клиент WS — то же имя и те же номера
  const wsKey = (name, phones) => `${normName(name)}|${phones.map(digits).sort().join(',')}`;
  const known = new Map(rows.filter((r) => r.wsName).map((r) => [wsKey(r.wsName, r.phones), r]));
  const maps = lookupMaps(rows);
  let added = 0;
  let updated = 0;
  let total = 0;
  db.raw.exec('BEGIN');
  try {
    for (const r of table.slice(h + 1)) {
      const name = String(r[nameCol] ?? '').trim();
      if (!name) continue;
      total++;
      const phones = splitPhones(r[phoneCol]);
      const key = wsKey(name, phones);
      if (known.has(key)) continue;
      // Клиент уже есть из группы или заявки (тот же телефон) — дописываем ему имя из WS
      const same = maps.match({ phones });
      const row = same && rows.find((x) => x.id === same);
      if (row && !row.wsName) {
        const merged = [...new Set([...row.phones, ...phones])];
        q.update.run(row.source === 'ws' ? row.name : name, JSON.stringify(merged), row.telegram, name, nowIso(), row.id);
        row.wsName = name;
        known.set(key, row);
        updated++;
        continue;
      }
      const id = addClient({ name, phones, wsName: name, source: 'ws' });
      known.set(key, { id });
      added++;
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  db.setSetting('crm_import', JSON.stringify({ at: nowIso(), by, rows: total, added, updated }));
  console.log(`CRM import by ${by}: ${total} rows, ${added} added, ${updated} updated`);
  invalidate();
  return { rows: total, added, updated };
}

/* --------------------------------------------------- Сбор истории клиентов */

let cache = null;
const invalidate = () => { cache = null; };
const bangkokIso = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 10);
const dayStart = (iso) => Date.parse(`${iso}T00:00:00+07:00`);

/**
 * Все клиенты с историей. Аренда из группы: выдача (с контактом) + продления,
 * оплаты и возврат той же машины. Аренда из кассы WS: оплаты одной брони (н/д).
 * Если у клиента бронь WS и аренда из группы на ту же машину ±3 дня — одна аренда.
 */
async function buildIndex(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache;
  syncContacts();
  const rows = q.all.all().map(rowOf);
  const maps = lookupMaps(rows);
  const clients = new Map(rows.filter((r) => !r.mergedInto).map((r) => [r.id, {
    ...r, rentals: [], bookings: [], requests: [], debts: []
  }]));
  const { rates } = currentRates();
  const phones = await staffPhones();
  const who = (row) => phones.get(row.author) || row.author_name || (/^\d{8,}$/.test(row.author) ? `+${row.author}` : row.author);
  let models = new Map();
  try {
    models = new Map(((await getFleet()).units || []).map((u) => [plateKey(u.plate), u.model || `${u.brand || ''} ${u.modelName || ''}`.trim()]));
  } catch { /* без таблицы — модели из отчётов */ }

  // Отчёты группы
  const reports = withoutRepeats(db.raw.prepare(`SELECT id, ts, kind, author, author_name, text, data FROM wa_messages
    WHERE kind IN (${REPORT_KINDS.map(() => '?').join(',')}) AND status != 'ignored' ORDER BY ts`).all(...REPORT_KINDS));
  const parsed = [];
  const open = new Map(); // госномер → аренда, которая сейчас идёт
  const reportClient = new Map();
  for (const row of reports) {
    const m = moneyOf(row, rates);
    parsed.push({ row, m });
    const contact = parseJson(row.data, {}).fields?.contact;
    const cid = contact ? maps.finalId(maps.match(contactKeys(contact)) || 0) : null;
    const client = cid ? clients.get(cid) : null;
    const plates = m.plates.map((p) => p.plate);
    const model = m.plates[0]?.model || models.get(plates[0]) || null;
    if (row.kind === 'booking') {
      if (client) {
        client.bookings.push({ id: row.id, ts: row.ts, plates, model, from: m.from, to: m.to, total: Math.round(m.bookingTotal), prepaid: Math.round(m.prepaid) });
        reportClient.set(row.id, client.id);
      }
      continue;
    }
    let rental = null;
    // Новая выдача машины закрывает прошлую аренду этой машины (даже если возврат не написали)
    if (row.kind === 'issue') {
      for (const p of plates) {
        const prev = open.get(p);
        if (prev) { prev.rental.active = false; open.delete(p); }
      }
    }
    if (row.kind === 'issue' && client) {
      rental = {
        clientId: client.id, source: 'group', plates, model, from: m.from, to: m.to, startTs: row.ts, revenue: 0, paid: 0, deposit: 0, returned: 0,
        withheld: 0, issuedBy: who(row), active: true, reports: []
      };
      client.rentals.push(rental);
      for (const p of plates) open.set(p, { rental, client });
    } else {
      // Продление, оплата, замена, возврат: к аренде этой машины (контакт может не повторяться)
      const chain = plates.map((p) => open.get(p)).find(Boolean);
      if (chain && (!client || chain.client.id === client.id)) rental = chain.rental;
      else if (client && plates.length) {
        // Выдача была до начала журнала — аренда начинается с этого отчёта
        rental = { clientId: client.id, source: 'group', plates, model, from: m.from, to: m.to, startTs: row.ts, revenue: 0, paid: 0, deposit: 0, returned: 0, withheld: 0, issuedBy: null, active: true, reports: [] };
        client.rentals.push(rental);
        // Последний отчёт по машине главнее: прошлая аренда этой машины закончилась
        for (const p of plates) {
          const prev = open.get(p);
          if (prev) prev.rental.active = false;
          open.set(p, { rental, client });
        }
      }
    }
    if (!rental) continue;
    reportClient.set(row.id, rental.clientId);
    rental.reports.push({ id: row.id, ts: row.ts, kind: row.kind });
    rental.revenue += m.revenue;
    rental.paid += m.moneyIn;
    if (m.deposit) rental.deposit = Math.max(rental.deposit, m.deposit);
    if (m.to && (!rental.to || m.to > rental.to)) rental.to = m.to;
    if (!rental.from && m.from) rental.from = m.from;
    if (row.kind === 'return') {
      rental.returned += m.moneyOut;
      const dep = m.returnDeposit || rental.deposit;
      if (dep && m.moneyOut && dep - m.moneyOut >= 100) rental.withheld += dep - m.moneyOut;
      rental.active = false;
      rental.returnedAt = row.ts;
      for (const p of rental.plates) if (open.get(p)?.rental === rental) open.delete(p);
    }
  }
  // Долги — тот же расчёт, что в «Финансах»
  for (const d of findDebts(parsed, now, who)) {
    const cid = reportClient.get(d.id);
    if (cid && clients.has(cid)) clients.get(cid).debts.push(d);
  }
  // Сейчас в аренде — только если по группе машина и правда в аренде
  const rentNow = new Set([...groupStatusByPlate().entries()].filter(([, g]) => g.status === 'rent').map(([plate]) => plate));
  for (const c of clients.values()) for (const r of c.rentals) if (r.active && !r.plates.some((p) => rentNow.has(p))) r.active = false;

  // Касса WS: оплаты по броням (н/д), клиент — по имени из WS
  const ws = db.raw.prepare("SELECT * FROM fin_cashbook WHERE client IS NOT NULL AND client != '' ORDER BY ts").all();
  const wsRentals = new Map();
  for (const r of ws) {
    const cid = maps.byWsName.get(normName(r.client));
    const client = cid ? clients.get(maps.finalId(cid)) : null;
    if (!client) continue;
    const key = `${client.id}|${r.booking || `${r.plate}|${r.ts.slice(0, 10)}`}`;
    let w = wsRentals.get(key);
    if (!w) {
      w = { client, booking: r.booking, vehicle: r.vehicle, plate: r.plate, first: r.ts, last: r.ts, rent: 0, extras: 0, prepaid: 0, depositIn: 0, depositOut: 0, refund: 0 };
      wsRentals.set(key, w);
    }
    w.last = r.ts;
    if (r.purpose === 'Оплата за аренду') w.rent += r.income;
    else if (r.purpose === 'Оплата за доп. услуги' || r.purpose === 'Delivery to client') w.extras += r.income;
    else if (r.purpose === 'Предоплата за заявку/бронь') w.prepaid += r.income;
    else if (r.purpose === 'Внесение залога') w.depositIn += r.income;
    else if (r.purpose === 'Возврат залога') w.depositOut += r.expense;
    else if (r.purpose === 'Возврат за аренду') w.refund += r.expense;
  }
  for (const w of wsRentals.values()) {
    const sum = w.rent + w.extras + w.prepaid - w.refund;
    if (!sum && !w.depositIn) continue;
    const t0 = Date.parse(w.first);
    const t1 = Date.parse(w.last);
    // Та же аренда в группе: та же машина, оплаты в её даты ±3 дня
    const same = w.plate && w.client.rentals.find((r) => r.source !== 'ws' && r.plates.includes(w.plate) && !r.ws && (() => {
      const a = r.from ? dayStart(r.from) : Date.parse(r.startTs);
      const b = r.to ? dayStart(r.to) + DAY_MS : Date.parse(r.returnedAt || r.startTs);
      return t0 <= b + MATCH_MS && t1 >= a - MATCH_MS;
    })());
    const info = { booking: w.booking, vehicle: w.vehicle, sum: Math.round(sum), deposit: Math.round(w.depositIn), depositBack: Math.round(w.depositOut) };
    if (same) same.ws = info;
    else {
      w.client.rentals.push({
        source: 'ws', plates: w.plate ? [w.plate] : [], model: w.vehicle?.replace(/\s*\(\d+\)\s*$/, '') || models.get(w.plate) || null,
        from: bangkokIso(t0), to: bangkokIso(t1), startTs: w.first, revenue: 0, paid: 0, deposit: 0, returned: 0, withheld: 0, active: false, reports: [], ws: info
      });
    }
  }

  // Заявки
  // Откуда пришёл клиент (вкладка «Маркетинг»): источник по коду или ответ «откуда узнали»
  let sourceName = () => null;
  try {
    const names = new Map(db.raw.prepare('SELECT code, name FROM marketing_sources').all().map((x) => [x.code, x.name]));
    sourceName = (code) => names.get(code) || null;
  } catch { /* «Маркетинг» ещё не создан */ }
  // Вопросы («Связаться с менеджером») — не заявки: аренды им не приписываем
  for (const r of db.raw.prepare("SELECT id, created_at, channel, client_name, client_phone, client_chat_id, model, date_from, date_to, status, source_ref, site_host, heard_from FROM requests WHERE kind IS NULL OR kind != 'question' ORDER BY id").all()) {
    const cid = maps.match({ phones: splitPhones(r.client_phone), chat: r.client_chat_id ? `${r.channel}:${r.client_chat_id}` : null });
    const client = cid ? clients.get(maps.finalId(cid)) : null;
    const from = (r.source_ref && sourceName(r.source_ref)) || r.heard_from || (r.site_host ? `сайт ${r.site_host}` : null);
    if (client) client.requests.push({ id: r.id, at: r.created_at, channel: r.channel, model: r.model, from: r.date_from, to: r.date_to, status: r.status, source: from });
  }

  // Итоги по клиенту
  const today = bangkokIso(now);
  const noteCount = new Map(q.noteCounts.all().map((r) => [r.client_id, r.n]));
  for (const c of clients.values()) {
    c.rentals.sort((a, b) => Date.parse(b.startTs) - Date.parse(a.startTs));
    const paidOf = (r) => (r.ws ? r.ws.sum : Math.round(r.revenue));
    c.stats = {
      rentals: c.rentals.length,
      paid: c.rentals.reduce((s, r) => s + paidOf(r), 0),
      days: c.rentals.reduce((s, r) => s + (r.from && r.to ? Math.max(1, Math.round((dayStart(r.to) - dayStart(r.from)) / DAY_MS)) : 0), 0),
      firstAt: c.rentals.length ? c.rentals[c.rentals.length - 1].startTs : null,
      lastAt: c.rentals.reduce((m, r) => {
        const end = r.to ? `${r.to}T12:00:00+07:00` : r.startTs;
        return !m || Date.parse(end) > Date.parse(m) ? new Date(Date.parse(end)).toISOString() : m;
      }, null),
      debt: c.debts.reduce((s, d) => s + d.amount, 0),
      overdue: c.debts.filter((d) => d.overdue).reduce((s, d) => s + d.amount, 0),
      notes: noteCount.get(c.id) || 0
    };
    c.active = c.rentals.find((r) => r.active) || null;
    c.upcoming = c.bookings.filter((b) => b.from && b.from >= today).sort((a, b) => a.from.localeCompare(b.from));
    const firstContact = [c.stats.firstAt, ...c.requests.map((r) => r.at)].filter(Boolean).sort()[0] || null;
    c.flags = {
      rent: Boolean(c.active),
      booking: c.upcoming.length > 0,
      debt: c.stats.debt > 0,
      regular: c.stats.rentals >= 2 || c.tags.includes('regular'),
      lost: !c.active && !c.upcoming.length && Boolean(c.stats.lastAt) && now - Date.parse(c.stats.lastAt) > LOST_DAYS * DAY_MS,
      new: Boolean(firstContact) && now - Date.parse(firstContact) <= NEW_DAYS * DAY_MS && c.stats.rentals <= 1,
      badPhone: !c.phones.length ? !c.telegram && !c.chat : c.phones.some((p) => !countryOf(p) || digits(p).length < 10 || maps.shared.has(phoneKey(p)))
    };
  }

  // Возможные дубли: один и тот же (не общий) номер у разных клиентов или одинаковое имя
  const groups = new Map();
  const addTo = (key, id) => (groups.get(key) || groups.set(key, new Set()).get(key)).add(id);
  for (const c of clients.values()) {
    for (const p of c.phones) { const k = phoneKey(p); if (k && !maps.shared.has(k)) addTo(`p:${k}`, c.id); }
    const n = normName(c.name);
    if (n.length >= 5 && /\p{L}/u.test(n)) addTo(`n:${n}`, c.id);
  }
  const dupes = new Map();
  for (const [key, ids] of groups) {
    if (ids.size < 2) continue;
    for (const id of ids) {
      const set = dupes.get(id) || dupes.set(id, new Map()).get(id);
      for (const other of ids) if (other !== id) set.set(other, key.startsWith('p:') ? 'phone' : 'name');
    }
  }
  for (const c of clients.values()) c.dupes = [...(dupes.get(c.id) || new Map())].map(([id, reason]) => ({ id, reason }));

  cache = { at: now, clients, shared: maps.shared, reportClient, maps };
  return cache;
}

const clientBrief = (c) => (c ? { id: c.id, name: c.name, phone: c.phones?.[0] || null } : null);

/** Клиент отчёта группы (по строке Contact): { id, name, phone } или null — для «Арендатора» в «Парке» */
export async function clientOfReport(reportId, now = Date.now()) {
  const idx = await buildIndex(now);
  return clientBrief(idx.clients.get(idx.reportClient.get(reportId)));
}

/** Клиент по телефону или @telegram: { id, name, phone } или null */
export async function clientByContact(contact, now = Date.now()) {
  if (!contact) return null;
  const idx = await buildIndex(now);
  const id = idx.maps.finalId(idx.maps.match(contactKeys(contact)) || 0);
  return clientBrief(idx.clients.get(id));
}

/* ---------------------------------------------------------------- Список */

export const FILTERS = ['all', 'rent', 'booking', 'debt', 'regular', 'lost', 'new', 'vip', 'problem', 'blacklist', 'dupes', 'badPhone'];
const inFilter = (c, f) => {
  if (f === 'all') return true;
  if (['vip', 'problem', 'blacklist'].includes(f)) return c.tags.includes(f);
  if (f === 'dupes') return c.dupes.length > 0;
  return Boolean(c.flags[f]);
};

const autoTags = (c) => [...new Set([...c.tags, ...(c.flags.regular ? ['regular'] : [])])];

function listItem(c) {
  const phone = c.phones[0] || null;
  return {
    id: c.id, name: c.name, phone, telegram: c.telegram, country: countryOf(phone), source: c.source,
    tags: autoTags(c), rentals: c.stats.rentals, paid: c.stats.paid, lastAt: c.stats.lastAt, debt: c.stats.debt, overdue: c.stats.overdue,
    rent: c.active ? { plates: c.active.plates, model: c.active.model, to: c.active.to } : null,
    booking: c.upcoming[0] ? { from: c.upcoming[0].from, plates: c.upcoming[0].plates, model: c.upcoming[0].model } : null,
    dupes: c.dupes.length, badPhone: c.flags.badPhone, notes: c.stats.notes
  };
}

/** Список для вкладки: фильтр, поиск (имя, телефон, telegram, госномер, № брони WS) */
export async function crmList({ filter = 'all', q: query = '' } = {}, now = Date.now()) {
  const { clients } = await buildIndex(now);
  const all = [...clients.values()];
  const counts = Object.fromEntries(FILTERS.map((f) => [f, all.filter((c) => inFilter(c, f)).length]));
  const text = normName(query);
  const qd = digits(query);
  const found = all.filter((c) => inFilter(c, FILTERS.includes(filter) ? filter : 'all')).filter((c) => {
    if (!text && !qd) return true;
    if (text && normName(c.name).includes(text)) return true;
    if (text && c.telegram?.includes(text.replace(/\s/g, ''))) return true;
    if (qd.length >= 3 && c.phones.some((p) => digits(p).includes(qd))) return true;
    if (qd.length >= 2 && c.rentals.some((r) => r.plates.includes(qd) || r.ws?.booking === qd)) return true;
    return false;
  });
  // Сначала те, кто сейчас в аренде или с бронью, потом по последней аренде
  const rank = (c) => (c.active ? 2 : c.upcoming.length ? 1 : 0);
  found.sort((a, b) => rank(b) - rank(a) || String(b.stats.lastAt || '').localeCompare(String(a.stats.lastAt || '')) || a.name.localeCompare(b.name));
  const withRentals = all.filter((c) => c.stats.rentals > 0);
  const countries = new Map();
  for (const c of withRentals) {
    const country = countryOf(c.phones[0]);
    const key = country?.name || 'Не определена';
    countries.set(key, { name: key, code: country?.code || null, n: (countries.get(key)?.n || 0) + 1 });
  }
  return {
    counts,
    summary: {
      total: all.length,
      withRentals: withRentals.length,
      newMonth: counts.new,
      regularShare: withRentals.length ? Math.round((withRentals.filter((c) => c.flags.regular).length / withRentals.length) * 100) : 0,
      countries: [...countries.values()].sort((a, b) => b.n - a.n).slice(0, 6)
    },
    imported: parseJson(db.getSetting('crm_import'), null),
    items: found.slice(0, 300).map(listItem),
    more: Math.max(0, found.length - 300),
    tags: TAGS
  };
}

/* ---------------------------------------------------------------- Карточка */

export async function crmClient(id, now = Date.now()) {
  const { clients } = await buildIndex(now);
  const target = q.byId.get(Number(id));
  if (!target) throw new CrmError('not_found');
  const c = clients.get(target.merged_into ? (rowOf(target).mergedInto) : target.id) || clients.get(Number(id));
  if (!c) throw new CrmError('not_found');
  const models = new Map();
  for (const r of c.rentals) if (r.model) models.set(r.model, (models.get(r.model) || 0) + 1);
  return {
    client: {
      id: c.id, name: c.name, telegram: c.telegram, chat: c.chat, wsName: c.wsName, source: c.source, createdAt: c.createdAt,
      phones: c.phones.map((p) => ({ phone: p, country: countryOf(p), bad: !countryOf(p) || digits(p).length < 10 })),
      tags: c.tags, autoRegular: c.stats.rentals >= 2
    },
    flags: c.flags,
    stats: { ...c.stats, avg: c.stats.rentals ? Math.round(c.stats.paid / c.stats.rentals) : 0, models: [...models].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => ({ model: m, n })) },
    now: {
      rent: c.active ? { plates: c.active.plates, model: c.active.model, from: c.active.from, to: c.active.to, deposit: Math.round(c.active.deposit) } : null,
      bookings: c.upcoming,
      debts: c.debts
    },
    rentals: c.rentals.slice(0, 100).map((r) => ({
      source: r.ws && r.source !== 'ws' ? 'both' : r.source, plates: r.plates, model: r.model, from: r.from, to: r.to, startTs: r.startTs,
      revenue: Math.round(r.revenue), paid: Math.round(r.paid), deposit: Math.round(r.deposit), returned: Math.round(r.returned),
      withheld: Math.round(r.withheld), active: r.active, issuedBy: r.issuedBy || null, ws: r.ws || null, reports: r.reports.length
    })),
    requests: c.requests.slice(-20).reverse(),
    notes: q.notes.all(c.id).map((n) => ({ id: n.id, at: n.at, by: n.by, kind: n.kind, text: n.text })),
    dupes: c.dupes.map((d) => {
      const o = clients.get(d.id);
      return o ? { id: o.id, name: o.name, phone: o.phones[0] || o.telegram || null, rentals: o.stats.rentals, reason: d.reason } : null;
    }).filter(Boolean)
  };
}

/* ------------------------------------------------------------- Изменения */

const active = (id) => {
  const row = rowOf(q.byId.get(Number(id)));
  if (!row || row.mergedInto) throw new CrmError('not_found');
  return row;
};

/** Новый клиент или изменение контакта: { id?, name, phones (текст), telegram } */
export function saveClient(input, by) {
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw new CrmError('name_required');
  const phones = splitPhones(input.phones);
  const tgRaw = String(input.telegram || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  const telegram = tgRaw ? `@${tgRaw.toLowerCase().replace(/[^a-z0-9_]/g, '')}` : null;
  if (input.id) {
    const old = active(input.id);
    q.update.run(name, JSON.stringify(phones), telegram, old.wsName, nowIso(), old.id);
    const changed = [];
    if (old.name !== name) changed.push(`имя: ${old.name} → ${name}`);
    if (old.phones.join(', ') !== phones.join(', ')) changed.push(`телефоны: ${old.phones.join(', ') || '—'} → ${phones.join(', ') || '—'}`);
    if ((old.telegram || null) !== telegram) changed.push(`telegram: ${old.telegram || '—'} → ${telegram || '—'}`);
    if (changed.length) q.addNote.run(old.id, nowIso(), by, 'system', `Изменён контакт: ${changed.join('; ')}`);
    invalidate();
    return old.id;
  }
  const id = addClient({ name, phones, telegram, source: 'manual' });
  q.addNote.run(id, nowIso(), by, 'system', 'Клиент добавлен вручную');
  invalidate();
  return id;
}

export function setTags(id, tags, by) {
  const row = active(id);
  const next = TAG_IDS.filter((t) => (tags || []).includes(t));
  const label = (t) => TAGS.find(([x]) => x === t)?.[1] || t;
  const added = next.filter((t) => !row.tags.includes(t)).map(label);
  const removed = row.tags.filter((t) => !next.includes(t)).map(label);
  q.setTags.run(JSON.stringify(next), nowIso(), row.id);
  if (added.length || removed.length) {
    q.addNote.run(row.id, nowIso(), by, 'system', [added.length ? `Метки добавлены: ${added.join(', ')}` : '', removed.length ? `Метки сняты: ${removed.join(', ')}` : ''].filter(Boolean).join('. '));
  }
  invalidate();
  blacklistCache = null;
  return next;
}

export function addNote(id, text, by) {
  const row = active(id);
  const body = String(text || '').trim().slice(0, 2000);
  if (!body) throw new CrmError('note_required');
  q.addNote.run(row.id, nowIso(), by, 'note', body);
  invalidate();
}

/** Объединить дубль from в клиента into: телефоны, telegram, метки, заметки; имя WS — тоже */
export function mergeClients(intoId, fromId, by) {
  const into = active(intoId);
  const from = active(fromId);
  if (into.id === from.id) throw new CrmError('same_client');
  const phones = [...new Set([...into.phones, ...from.phones])];
  // Вместо имени номер или @telegram, а у дубля настоящее имя — берём имя дубля
  const name = !/\p{L}{2}/u.test(into.name.replace(/^@\S+$/, '')) && /\p{L}{2}/u.test(from.name.replace(/^@\S+$/, '')) ? from.name : into.name;
  db.raw.exec('BEGIN');
  try {
    q.update.run(name, JSON.stringify(phones), into.telegram || from.telegram, into.wsName || from.wsName, nowIso(), into.id);
    q.setTags.run(JSON.stringify([...new Set([...into.tags, ...from.tags])]), nowIso(), into.id);
    q.moveNotes.run(into.id, from.id);
    q.merge.run(into.id, nowIso(), from.id);
    q.addNote.run(into.id, nowIso(), by, 'system', `Объединён с дублем «${from.name}»${from.phones.length ? ` (${from.phones.join(', ')})` : ''}`);
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  invalidate();
  blacklistCache = null;
  return into.id;
}

/* ----------------------------------------------------------- Чёрный список */

let blacklistCache = null;

function blacklistMaps() {
  if (blacklistCache && Date.now() - blacklistCache.at < CACHE_MS) return blacklistCache;
  const rows = q.all.all().map(rowOf);
  const shared = sharedKeys(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listed = (r) => {
    let x = r;
    for (let i = 0; x?.mergedInto && i < 10; i++) x = byId.get(x.mergedInto);
    return x?.tags.includes('blacklist') ? x : null;
  };
  const phones = new Map();
  const tgs = new Map();
  for (const r of rows) {
    const target = listed(r);
    if (!target) continue;
    for (const p of r.phones) { const k = phoneKey(p); if (k && !shared.has(k)) phones.set(k, target); }
    if (r.telegram) tgs.set(r.telegram, target);
  }
  blacklistCache = { at: Date.now(), phones, tgs };
  return blacklistCache;
}

/** Клиент из чёрного списка по строке «Contact»: { id, name } или null */
export function blacklisted(contact) {
  if (!contact) return null;
  const { phones, tgs } = blacklistMaps();
  if (!phones.size && !tgs.size) return null;
  const keys = contactKeys(contact);
  const hit = keys.phones.map((p) => phones.get(phoneKey(p))).find(Boolean) || (keys.telegram && tgs.get(keys.telegram));
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** Брони и выдачи клиентам из чёрного списка: свежие (3 дня) и брони на будущее */
export function blacklistReports(now = Date.now()) {
  const { phones, tgs } = blacklistMaps();
  if (!phones.size && !tgs.size) return [];
  const today = bangkokIso(now);
  const rows = db.raw.prepare(`SELECT id, ts, kind, data FROM wa_messages WHERE kind IN ('booking', 'issue', 'extension') AND status != 'ignored' AND ts >= ? ORDER BY ts DESC`)
    .all(new Date(now - 60 * DAY_MS).toISOString());
  const out = [];
  for (const row of rows) {
    const data = parseJson(row.data, {});
    const hit = blacklisted(data.fields?.contact);
    if (!hit) continue;
    const fresh = now - Date.parse(row.ts) <= 3 * DAY_MS;
    const future = row.kind === 'booking' && data.fields?.from && data.fields.from >= today;
    if (!fresh && !future) continue;
    const plates = (data.plates || []).filter((p) => p.role !== 'mention' && p.role !== 'from');
    out.push({ id: row.id, ts: row.ts, kind: row.kind, plate: plates[0]?.plate || null, model: plates[0]?.model || data.fields?.model || null, from: data.fields?.from || null, client: hit });
  }
  return out;
}

/* ------------------------------------------- Итог заявок (для «Маркетинга») */

/**
 * Чем закончилась каждая заявка: { booked, paid, revenue } по id заявки.
 * Аренда клиента относится к его последней заявке, сделанной не раньше чем
 * за 60 дней до начала аренды (и не позже дня начала), — без двойного счёта.
 */
/**
 * Аренды по госномеру (для кабинета инвестора): plate → [{ from, to, sum, active }] —
 * только даты и суммы, без клиентов.
 */
export async function rentalsByPlate(now = Date.now()) {
  const { clients } = await buildIndex(now);
  const out = new Map();
  for (const c of clients.values()) {
    for (const r of c.rentals) {
      const sum = r.ws ? r.ws.sum : Math.round(r.revenue);
      for (const plate of r.plates) {
        if (!out.has(plate)) out.set(plate, []);
        out.get(plate).push({ from: r.from || bangkokIso(Date.parse(r.startTs)), to: r.to || null, sum, active: Boolean(r.active) });
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => String(b.from).localeCompare(String(a.from)));
  return out;
}

export async function requestOutcomes(now = Date.now()) {
  const out = new Map();
  for (const [id, x] of await requestRentals(now)) {
    out.set(id, {
      booked: x.booked || x.rentals.length > 0,
      paid: x.rentals.length > 0,
      revenue: x.rentals.reduce((sum, r) => sum + r.sum, 0)
    });
  }
  return out;
}

/**
 * Аренды и брони по каждой заявке (для кабинета агента): requestId →
 * { booked, rentals: [{ key, model, plates, from, to, startTs, sum, active, ended }] }.
 * Сумма — без залога; аренда «закончилась», когда машину вернули или прошёл её последний день.
 */
export async function requestRentals(now = Date.now()) {
  const { clients } = await buildIndex(now);
  const today = bangkokIso(now);
  const out = new Map();
  const ownerOf = (requests, ts) => {
    let best = null;
    for (const r of requests) {
      const at = Date.parse(r.at);
      if (at <= ts + DAY_MS && at >= ts - 60 * DAY_MS && (!best || at > Date.parse(best.at))) best = r;
    }
    return best;
  };
  for (const c of clients.values()) {
    if (!c.requests.length) continue;
    for (const r of c.requests) out.set(r.id, { booked: false, rentals: [] });
    for (const rental of c.rentals) {
      const owner = ownerOf(c.requests, Date.parse(rental.startTs));
      if (!owner) continue;
      const from = rental.from || bangkokIso(Date.parse(rental.startTs));
      out.get(owner.id).rentals.push({
        key: `${rental.plates[0] || rental.model || 'unit'}|${from}`,
        model: rental.model || null, plates: rental.plates, from, to: rental.to || null, startTs: rental.startTs,
        sum: rental.ws ? rental.ws.sum : Math.round(rental.revenue),
        active: Boolean(rental.active),
        ended: !rental.active && Boolean(rental.returnedAt || !rental.to || rental.to < today)
      });
    }
    for (const b of c.bookings) {
      const owner = ownerOf(c.requests, Date.parse(b.ts));
      if (owner) out.get(owner.id).booked = true;
    }
  }
  return out;
}
