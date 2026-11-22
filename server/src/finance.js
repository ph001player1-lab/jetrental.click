/**
 * ============================================================================
 * Финансы — только просмотр, по отчётам рабочей группы WhatsApp
 * ============================================================================
 * Источник — журнал (сообщения от наблюдателя и из выгрузок), не WS: от WS
 * компания планирует отказаться. Деньги берём из строк отчётов:
 *   «Rent: 3,500 THB / 109 USDT»  — одна сумма в двух валютах (берём THB);
 *   «Received: 300 euro + 2,000 THB» — сумма двух (складываем);
 *   «Booking received: 20,000 RUB (7,400 THB)» — получены рубли, в скобках THB.
 * В отчёте на несколько машин цена бывает и «за одну», и «итого» — по каждой
 * статье берём наибольшую сумму сообщения (итог), чтобы не задвоить.
 * Повтор того же отчёта (исправленный) — считаем один раз, последний.
 * Всё переводим в баты: по курсу дня (open.er-api.com, раз в 12 часов), без
 * связи — по последнему курсу или примерному.
 * ============================================================================
 */

import * as db from './db.js';
import { amountsIn, parseNumber } from './journal/parse.js';
import { sameText, lidPhones, timesheet } from './journal/journal.js';
import { staffRates } from './access.js';
import { groupStatusByPlate } from './journal/reconcile.js';
import { getFleet, plateKey } from './fleet.js';
import { staffPhones } from './staffUsers.js';
import { cashbookMeta, cashbookRows, PURPOSE_GROUP } from './cashbook.js';

const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;
const MONEY_KINDS = ['booking', 'issue', 'extension', 'payment', 'return', 'changed', 'pickup_task'];

/* ---------------------------------------------------------------- Курсы */

// Примерные курсы (батов за единицу) — пока не получили настоящие
const FALLBACK_RATES = { THB: 1, USD: 33, USDT: 33, EUR: 38, GBP: 44, RUB: 0.37, AUD: 22 };
const RATES_URL = 'https://open.er-api.com/v6/latest/THB';
const RATES_MAX_AGE_MS = 12 * 3600000;
let ratesLoading = null;

function storedRates() {
  try {
    return JSON.parse(db.getSetting('fx_rates') || 'null');
  } catch {
    return null;
  }
}

/** Обновить курсы в фоне (не чаще раза в 12 часов); ответ портала не ждёт */
function refreshRates() {
  const saved = storedRates();
  if (ratesLoading || (saved && Date.now() - Date.parse(saved.fetchedAt) < RATES_MAX_AGE_MS)) return;
  ratesLoading = fetch(RATES_URL, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.json())
    .then((data) => {
      if (data?.result !== 'success' || !data.rates) return;
      // В ответе — сколько единиц валюты за 1 бат; нам нужно наоборот
      const rates = { THB: 1 };
      for (const code of ['USD', 'EUR', 'GBP', 'RUB', 'AUD']) if (data.rates[code]) rates[code] = Math.round((1 / data.rates[code]) * 10000) / 10000;
      rates.USDT = rates.USD;
      db.setSetting('fx_rates', JSON.stringify({ fetchedAt: new Date().toISOString(), rates }));
    })
    .catch((err) => console.error('FX rates update failed:', err.message))
    .finally(() => { ratesLoading = null; });
}

export function currentRates() {
  const saved = storedRates();
  return saved ? { rates: { ...FALLBACK_RATES, ...saved.rates }, at: saved.fetchedAt, approximate: false }
    : { rates: FALLBACK_RATES, at: null, approximate: true };
}

/* ------------------------------------------------- Деньги из строки отчёта */

const round = (n) => Math.round(n);

/**
 * Строка «Rent: 3,500 THB / 109 USDT + 500 THB» → { thb, cash: [{ currency, amount }] }.
 * cash — в какой валюте деньги физически (для кассы): у «a / b» — бат, если он
 * есть; у «X (Y THB)» — первая сумма.
 */
export function valueOf(line, rates) {
  const body = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line;
  let thb = 0;
  const cash = [];
  for (const part of body.split('+')) {
    const amounts = amountsIn(part);
    if (!amounts.length) continue;
    const thbAlt = amounts.find((a) => a.currency === 'THB');
    const physical = part.includes('(') ? amounts[0] : thbAlt || amounts[0];
    thb += thbAlt ? thbAlt.amount : physical.amount * (rates[physical.currency] || 0);
    cash.push({ currency: physical.currency, amount: physical.amount });
  }
  return { thb: round(thb), cash };
}

// Статьи: начислено клиенту (выручка), получено, депозиты, возвраты, ожидается
const REVENUE_KEYS = ['rent', 'rent_delivery', 'delivery', 'pickup_fee', 'helmet_fee', 'box', 'child_seat', 'overtime', 'fuel_fee', 'extension'];
const REVENUE_KINDS = new Set(['issue', 'extension', 'payment', 'changed']);
const IN_KEYS = ['booking_received', 'received', 'extra_received'];
const OUT_KEYS = ['returned', 'return_deposit'];

/**
 * Кто принял деньги: «… in cash by @~Weerapap», «by Nick», «transferred to @Alexey».
 * Имя — упоминание (@…) или одно слово после «by». Обрывки фраз не берём.
 */
export function receiverOf(text) {
  const re = /\b(by|to)\s+(@[\u2068]?~?[^\n)(+,@\u2069]+?|[A-Za-z\u0E00-\u0E7F\u0400-\u04FF]{2,20}\b)(?=[\u2069]?\s*(?:\)|\+|,|$|\n|\.(?:\s|$)| (?:usdt|thb|usd|rub|eur|gbp|bank|wallet|account|card|by|in)\b))/gi;
  for (const m of text.matchAll(re)) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length);
    if (!/(received|cash|transfer|paid)/i.test(around)) continue;
    // «by» — кто принял; «to» — только перевод («transferred to …»)
    if (m[1].toLowerCase() === 'to' && !/transfer/i.test(around)) continue;
    // «@Alexey Russian bank» — хвост про счёт к имени не относится
    const name = m[2].replace(/[^\p{L}\p{N}\s.'-]/gu, '').replace(/\s+(russian|thai|usdt|thb|rub|usd|bank|wallet|account|card)\b.*$/i, '').trim();
    if (!m[2].startsWith('@') && /^(cash|bank|transfer|the|customer|client|hotel|office|thb|usd|usdt|rub|eur|gbp|all|him|her|me|us)$/i.test(name)) continue;
    if (name.length >= 2 && name.length <= 40) return name;
  }
  return null;
}

/** Деньги одного сообщения: по каждой статье — наибольшая сумма (итог), в батах */
export function moneyOf(row, rates) {
  const data = JSON.parse(row.data || '{}');
  const fields = data.fields || {};
  const byKey = {};
  const items = (fields.money || []).map((item, idx) => ({ ...item, idx, value: valueOf(item.text || '', rates) }));
  for (const item of items) {
    const v = item.value;
    if (!v.thb) continue;
    const prev = byKey[item.key];
    if (!prev || v.thb > prev.thb) byKey[item.key] = { ...v, idx: item.idx, text: item.text, cash: v.cash, isCash: Boolean(item.cash), transfer: Boolean(item.transfer) };
  }
  // Долг клиента: «Left amount / To collect». Если ниже в отчёте «Received» — это оплата этого остатка
  const debtBase = byKey.left || byKey.to_receive || null;
  let debt = 0;
  if (debtBase) {
    const paidAfter = items.filter((i) => i.idx > debtBase.idx && (i.key === 'received' || i.key === 'extra_received')).reduce((s, i) => s + i.value.thb, 0);
    debt = paidAfter >= debtBase.thb * 0.95 ? 0 : debtBase.thb - paidAfter;
  }
  const sum = (keys) => keys.reduce((s, k) => s + (byKey[k]?.thb || 0), 0);
  // Статьи как в кассе: «Оплата за аренду» (аренда, продление) и «доп. услуги»
  // (доставка, шлемы, детское кресло, бокс, топливо, переработка). «Rent + delivery» — в аренду.
  let rent = 0;
  let extras = 0;
  if (REVENUE_KINDS.has(row.kind)) {
    rent = Math.max(byKey.rent?.thb || 0, byKey.rent_delivery?.thb || 0) + (byKey.extension?.thb || 0);
    extras = sum(['delivery', 'pickup_fee', 'helmet_fee', 'box', 'child_seat', 'overtime', 'fuel_fee'].filter((k) => !(k === 'delivery' && byKey.rent_delivery)));
  }
  const revenue = rent + extras;
  // Получено: «received / booking received / extra»; если их нет — «Total: … (received …)»
  let moneyIn = sum(IN_KEYS);
  let inItems = IN_KEYS.map((k) => byKey[k]).filter(Boolean);
  if (!moneyIn && byKey.total && /received|cash|transfer|paid/i.test(byKey.total.text)) {
    moneyIn = byKey.total.thb;
    inItems = [byKey.total];
  }
  if (['issue', 'booking', 'changed', 'extension', 'payment'].includes(row.kind) && byKey.deposit_received) {
    moneyIn += byKey.deposit_received.thb;
    inItems.push(byKey.deposit_received);
  }
  const plates = (data.plates || []).filter((p) => p.role !== 'mention' && p.role !== 'from').map((p) => ({ plate: p.plate, model: p.model }));
  // Наличными: строки с пометкой «cash»; без пометок — весь приход, если в отчёте наличные и нет перевода
  const cashLike = inItems.some((i) => i.isCash) || /\bcash\b/i.test(row.text);
  const transferLike = inItems.some((i) => i.transfer) || /transfer|bank|wallet/i.test(row.text);
  let cashIn = inItems.filter((i) => i.isCash).reduce((s, i) => s + i.thb, 0);
  if (!cashIn && cashLike && !transferLike) cashIn = moneyIn;
  const outItem = OUT_KEYS.map((k) => byKey[k]).filter(Boolean).sort((a, b) => b.thb - a.thb)[0];
  return {
    revenue,
    rent,
    extras,
    moneyIn,
    inCash: inItems.flatMap((i) => i.cash),
    cashLike,
    transferLike,
    cashIn,
    // «Return deposit» и «Returned» часто про одну и ту же сумму — берём большую
    moneyOut: row.kind === 'return' ? outItem?.thb || 0 : 0,
    outCash: row.kind === 'return' && outItem ? outItem.isCash || (/\bcash\b/i.test(outItem.text) && !outItem.transfer) : false,
    deposit: row.kind === 'issue' || row.kind === 'changed' ? byKey.deposit?.thb || 0 : 0,
    // Залог, названный в самом отчёте о возврате («Deposit: 650 usdt» / «Deposit received: …»)
    returnDeposit: row.kind === 'return' ? byKey.deposit?.thb || byKey.deposit_received?.thb || 0 : 0,
    left: byKey.left?.thb || 0,
    debt,
    // «(will pay tomorrow)», «(at return)» — когда обещали доплатить
    debtNote: debtBase ? /\(([^)]{3,80})\)/.exec(debtBase.text)?.[1]?.trim() || null : null,
    toReceive: byKey.to_receive?.thb || 0,
    toReturn: byKey.to_return?.thb || 0,
    bookingTotal: row.kind === 'booking' ? Math.max(byKey.total?.thb || 0, (byKey.rent?.thb || 0) + (byKey.delivery?.thb || 0)) : 0,
    prepaid: byKey.booking_received?.thb || 0,
    receiver: receiverOf(row.text),
    plates,
    from: fields.from || null,
    to: fields.to || null,
    keys: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v.thb]))
  };
}

/* ------------------------------------------- Расходы и сдача кассы в группе */

// Шаблоны для группы — чтобы со временем вести расходы и кассу без WS:
//   «Expense: 1,200 THB — Fuel — Honda ADV350 #5951 (cash)»
//   «Cash handover: 20,000 THB to @Alexey»
const EXPENSE_RE = /^(expense|расход)\s*[:\-–—]/i;
const HANDOVER_RE = /^(cash\s*)?hand\s?over\s*[:\-–—]|^сдача кассы\b|^сдал[аи]? кассу\b/i;

/** Статьи расходов: ключ, название, слова в сообщении «Expense:» */
const CATEGORIES = [
  ['salary', 'Зарплата', /salary|overtime|зарплат|аванс|переработ/i],
  ['tax', 'Налоги', /\btax|налог/i],
  ['insurance', 'Страховки', /insur|страхов/i],
  ['ads', 'Реклама', /\bads?\b|advert|promo|facebook|google|instagram|tiktok|реклам/i],
  ['office', 'Офис', /office|electric|water bill|internet|офис|электр|интернет/i],
  ['wash', 'Мойка', /wash|мойк/i],
  ['fuel', 'Топливо', /fuel|\bgas\b|petrol|бензин|топлив/i],
  ['delivery', 'Доставка и такси', /taxi|grab|bolt|delivery|доставк|такси/i],
  ['repair', 'Ремонт и мастерская', /repair|workshop|mechanic|spare|parts?\b|tyres?\b|tires?\b|\boil\b|battery|brake|service|ремонт|запчаст|мастерск/i],
  ['owners', 'Выплаты владельцам машин', /owner|владел/i],
  ['refunds', 'Возвраты за аренду', /refund|возврат за аренду/i],
  ['vehicles', 'Покупка машин и взносы', /vehicle buy|purchase|down ?payment|покупк/i],
  ['personal', 'Личные (Алексей)', /personal|личн/i],
  ['other', 'Прочее', /[\s\S]/]
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(([k, l]) => [k, l]));
// Не расходы бизнеса (в прибыль не входят): покупка машин — вложения, личные — деньги владельца
const NOT_OPERATING = new Set(['vehicles', 'personal']);
// Статьи кассы WS → те же статьи
const PURPOSE_CATEGORY = {
  Salary: 'salary', 'Sstaff Overtime': 'salary', Tax: 'tax', 'Compulsory Insuarance': 'insurance', 'Fix Office': 'office',
  'car wash': 'wash', Fuel: 'fuel', TAXI: 'delivery', 'Workshop expences': 'repair', 'Workshop Tuning expences': 'repair',
  'payment to the owner': 'owners', 'Vehicle buy/deposit': 'vehicles', 'Indevidual Alex Money': 'personal', 'Возврат за аренду': 'refunds'
};
const categoryOfText = (text) => CATEGORIES.find(([, , re]) => re.test(text))[0];
const isoOf = (ms) => new Date(ms).toISOString();

/** Сообщения «Expense:» и «Cash handover:» из группы (по разбору это обычная переписка) */
function groupCashNotes(rates) {
  const rows = db.raw.prepare(`SELECT id, ts, kind, author, author_name, text FROM wa_messages
    WHERE kind = 'note' AND status != 'ignored'
      AND (text LIKE '%expense%' OR text LIKE '%hand%over%' OR text LIKE '%расход%' OR text LIKE '%Расход%' OR text LIKE '%сда%' OR text LIKE '%Сда%')
    ORDER BY ts`).all();
  const notes = [];
  for (const row of withoutRepeats(rows)) {
    const body = String(row.text || '').replace(/[\p{Extended_Pictographic}️‎‏⁨⁩]/gu, '').trim();
    const first = body.split('\n')[0].trim();
    const type = EXPENSE_RE.test(first) ? 'expense' : HANDOVER_RE.test(first) ? 'handover' : null;
    if (!type) continue;
    let value = valueOf(first, rates);
    if (!value.thb) {
      const lines = body.split('\n').slice(1).map((l) => valueOf(`x: ${l}`, rates));
      value = { thb: lines.reduce((s, v) => s + v.thb, 0), cash: lines.flatMap((v) => v.cash) };
    }
    if (!value.thb) continue;
    notes.push({
      id: row.id, at: row.at, type, author: row.author, author_name: row.author_name, thb: value.thb,
      inCash: type === 'handover' || /\bcash\b|наличн/i.test(body),
      plate: /#\s?(\d{2,5})\b/.exec(body)?.[1] || null,
      category: type === 'expense' ? categoryOfText(`${first.replace(EXPENSE_RE, '')} ${body}`) : null,
      to: /\bto\s+@?[⁨]?~?([^\n,()⁩@]{2,40}?)(?=\s*(?:$|\n|,|\(|\.|\s+(?:in|by|for)\b))/i.exec(first)?.[1]?.trim() || null
    });
  }
  return notes;
}

/**
 * Расходы за [a, b): из кассы WS там, где она загружена, а вне её — из сообщений
 * «Expense:» в группе (чтобы не задвоить, пока пишут и туда, и туда).
 */
function expensesFor(a, b, cashMeta, notes) {
  const cashA = cashMeta ? Math.max(a, Date.parse(cashMeta.coveredFrom)) : 0;
  const cashB = cashMeta ? Math.min(b, Date.parse(cashMeta.coveredTo) + 60000) : 0;
  const hasCash = Boolean(cashMeta) && cashB > cashA;
  const cats = new Map();
  const add = (key, sum, source) => {
    const c = cats.get(key) || cats.set(key, { key, label: CATEGORY_LABEL[key], sum: 0, count: 0, ws: 0, group: 0 }).get(key);
    c.sum += sum;
    c.count++;
    c[source] += sum;
  };
  // Расходы по машине: ремонт отдельно, остальное (топливо, мойка, страховка, налог, такси, владельцу) — «прочие»
  const byPlate = new Map();
  const plateCost = (plate, key, sum) => {
    if (!plate || NOT_OPERATING.has(key) || key === 'salary' || key === 'office' || key === 'ads') return;
    const p = byPlate.get(plate) || byPlate.set(plate, { repair: 0, other: 0 }).get(plate);
    p[key === 'repair' ? 'repair' : 'other'] += sum;
  };
  const ws = { income: 0, depositsIn: 0, depositsOut: 0, transfers: 0, salaryPaid: 0, officeIn: 0, officeOut: 0, officeToOwner: 0, officeFromOwner: 0 };
  if (hasCash) {
    for (const r of cashbookRows(isoOf(cashA), isoOf(cashB))) {
      const group = PURPOSE_GROUP[r.purpose];
      // Касса офиса (счёт Office) — наличные: приход, расход, снято Алексею
      if (/^office$/i.test(String(r.account || '').trim())) {
        if (group === 'transfer') { ws.officeToOwner += r.expense; ws.officeFromOwner += r.income; } else { ws.officeIn += r.income; ws.officeOut += r.expense; }
      }
      if (group === 'transfer') { ws.transfers += r.expense - r.income; continue; }
      if (group === 'depositIn') { ws.depositsIn += r.income; continue; }
      if (group === 'depositOut') { ws.depositsOut += r.expense; continue; }
      ws.income += r.income;
      if (!r.expense) continue;
      const key = PURPOSE_CATEGORY[r.purpose] || 'other';
      add(key, r.expense, 'ws');
      if (key === 'salary') ws.salaryPaid += r.expense;
      plateCost(r.plate, key, r.expense);
    }
  }
  let groupReports = 0;
  for (const n of notes) {
    if (n.type !== 'expense' || n.at < a || n.at >= b || (hasCash && n.at >= cashA && n.at < cashB)) continue;
    groupReports++;
    add(n.category, n.thb, 'group');
    plateCost(n.plate, n.category, n.thb);
  }
  const list = [...cats.values()].map((c) => ({ ...c, sum: round(c.sum), ws: round(c.ws), group: round(c.group) })).sort((x, y) => y.sum - x.sum);
  const categories = list.filter((c) => !NOT_OPERATING.has(c.key));
  return {
    cashFrom: hasCash ? isoOf(cashA) : null,
    cashTo: hasCash ? isoOf(cashB) : null,
    categories,
    notOperating: list.filter((c) => NOT_OPERATING.has(c.key)),
    total: categories.reduce((s, c) => s + c.sum, 0),
    groupReports,
    ws: hasCash ? Object.fromEntries(Object.entries(ws).map(([k, v]) => [k, round(v)])) : null,
    byPlate
  };
}

/* ------------------------------------------------------ Кредиты по машинам */

/** Платёж по кредиту в месяц по госномеру: { '5257': 12000 } (вводит админ) */
export function loans() {
  try {
    return JSON.parse(db.getSetting('fin_loans') || '{}') || {};
  } catch {
    return {};
  }
}

/** Список «госномер — платёж в месяц» по строке: «5257 12000», «#7836 — 9 500» */
export function saveLoans(text, by) {
  const map = {};
  for (const line of String(text || '').split(/\r?\n/).slice(0, 300)) {
    const m = /^\s*#?\s*(\d{2,5})\D+?(\d[\d\s,.]*)\s*(?:thb|฿|бат)?\s*$/i.exec(line);
    const amount = m ? parseNumber(m[2]) : null;
    if (m && amount > 0) map[m[1]] = Math.round(amount);
  }
  db.setSetting('fin_loans', JSON.stringify(map));
  console.log(`Finance loans saved by ${by}: ${Object.keys(map).length} vehicles`);
  return map;
}

/* --------------------------------------------------- Зарплата по табелю */

function monthsBetween(fromDate, toDate) {
  const list = [];
  let [y, m] = fromDate.slice(0, 7).split('-').map(Number);
  const last = toDate.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    list.push(key);
    if (key >= last) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return list;
}

/** Часы из табеля × ставка из «Доступов», по дням периода */
function salaryByTimesheet(from, to, phones) {
  const rates = staffRates();
  if (!rates.length) return { people: [], total: 0, ratesSet: 0 };
  const shownName = db.raw.prepare("SELECT author_name FROM wa_messages WHERE author = ? AND author_name IS NOT NULL AND author_name != '' ORDER BY ts DESC LIMIT 1");
  // В табеле человек — под именем из «Доступов» или из WhatsApp (если в «Доступах» имя — номер)
  const rateOf = new Map();
  for (const r of rates) {
    rateOf.set(r.name, r);
    if (r.whatsapp) rateOf.set(phones.get(r.whatsapp) || shownName.get(r.whatsapp)?.author_name || `+${r.whatsapp}`, r);
  }
  const people = new Map();
  for (const month of monthsBetween(from, to)) {
    for (const p of timesheet(month, phones).people) {
      const r = rateOf.get(p.name);
      if (!r) continue;
      const hours = Object.entries(p.days).filter(([d, v]) => d >= from && d <= to && v.hours).reduce((s, [, v]) => s + v.hours, 0);
      const row = people.get(r.name) || people.set(r.name, { name: r.name, hours: 0, rate: r.rate, sum: 0 }).get(r.name);
      row.hours += hours;
    }
  }
  const list = [...people.values()].map((p) => ({ ...p, hours: Math.round(p.hours * 10) / 10, sum: round(p.hours * p.rate) })).sort((a, b) => b.sum - a.sum);
  return { people: list, total: list.reduce((s, p) => s + p.sum, 0), ratesSet: rates.length };
}

/* -------------------------------------------------------------- Отчёт */

const bangkokIso = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 10);
const dayStart = (isoDate) => Date.parse(`${isoDate}T00:00:00+07:00`);
const PAY_KINDS = new Set(['issue', 'extension', 'payment', 'return', 'changed']);
// Хозяин денег, а не сотрудник: его наличные «на руках» не считаем
const isOwner = (name) => /alex|boss|kokon/i.test(name || '');

/** Повтор того же отчёта тем же автором в течение 6 часов — оставляем последний */
export function withoutRepeats(rows) {
  const kept = [];
  for (const row of rows) {
    const at = Date.parse(row.ts);
    // Строки идут по времени: смотрим назад только последние 6 часов
    for (let i = kept.length - 1; i >= 0 && (!kept[i] || at - kept[i].at < 6 * 3600000); i--) {
      const k = kept[i];
      if (k && k.author === row.author && k.kind === row.kind && sameText(k.text, row.text)) { kept[i] = null; break; }
    }
    kept.push({ ...row, at });
  }
  return kept.filter(Boolean);
}

/**
 * Долги клиентов на сегодня: «Left amount / To collect» в выдаче, продлении, оплате —
 * пока после них по той же машине не пришёл отчёт с полученными деньгами.
 * parsed — [{ row, m }] по времени (m — moneyOf). Общий расчёт для «Финансов» и CRM.
 */
export function findDebts(parsed, now, who) {
  const today = bangkokIso(now);
  const debtList = [];
  for (let i = 0; i < parsed.length; i++) {
    const { row, m } = parsed[i];
    if (row.at < now - 90 * DAY_MS || row.at > now || !['issue', 'extension', 'payment', 'changed'].includes(row.kind)) continue;
    const amount = m.debt;
    if (amount < 100 || !m.plates.length) continue;
    const plates = m.plates.map((p) => p.plate);
    const paid = parsed.slice(i + 1).some((x) => x.row.at <= now && PAY_KINDS.has(x.row.kind) && x.m.moneyIn > 0 && x.m.plates.some((p) => plates.includes(p.plate)));
    if (paid) continue;
    // Срок: «at return» — конец аренды, «tomorrow» — следующий день, «end of the month» — конец месяца
    const promise = `${m.debtNote || ''} ${row.text}`;
    const reportDay = bangkokIso(row.at);
    let due = reportDay;
    if (/\b(at|on|upon|when|after|before)\s+(the\s+)?(return|drop ?off|pick ?up)|при возврате/i.test(promise) && m.to) due = m.to;
    else if (/tomorrow|завтра/i.test(m.debtNote || '')) due = bangkokIso(row.at + DAY_MS);
    else if (/end of (the )?month|конце месяца/i.test(promise)) {
      const [y, mo] = reportDay.split('-').map(Number);
      due = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    }
    const late = Math.round((dayStart(today) - dayStart(due)) / DAY_MS);
    debtList.push({ id: row.id, ts: row.ts, kind: row.kind, author: who(row), plates, amount: round(amount), due, note: m.debtNote, late: Math.max(0, late), overdue: late > 0 });
  }
  return debtList.sort((a, b) => b.overdue - a.overdue || b.late - a.late || b.amount - a.amount);
}

/**
 * Финансовый отчёт за период [from, to] (даты по Бангкоку, включительно).
 * Всё в батах (округлено), плюс наличные по валютам у тех, кто принял.
 */
export async function financeReport({ from, to }, now = Date.now(), { clientsVisible = false, timesheetVisible = false } = {}) {
  refreshRates();
  const { rates, at: ratesAt, approximate } = currentRates();
  const start = dayStart(from);
  const end = dayStart(to) + DAY_MS;
  const days = Math.max(1, Math.round((end - start) / DAY_MS));
  // Все отчёты с деньгами: для периода, для загрузки машин (аренды до периода),
  // для наличных «на руках» и долгов (на сегодня)
  const rows = withoutRepeats(db.raw.prepare(`
    SELECT id, ts, kind, author, author_name, text, data FROM wa_messages
    WHERE kind IN (${MONEY_KINDS.map(() => '?').join(',')}) AND status != 'ignored' AND ts < ?
    ORDER BY ts`).all(...MONEY_KINDS, isoOf(Math.max(end, now + DAY_MS))));
  const phones = await staffPhones();
  const who = (row) => phones.get(row.author) || row.author_name || (/^\d{8,}$/.test(row.author) ? `+${row.author}` : row.author);
  // Упоминание номером («@66…» или внутренний номер WhatsApp) → имя, под которым он пишет в группу
  const nameOf = db.raw.prepare("SELECT author_name FROM wa_messages WHERE author IN (?, ?) AND author_name IS NOT NULL AND author_name != '' ORDER BY ts DESC LIMIT 1");
  const lids = lidPhones();
  const receiverName = (name) => {
    if (!name || !/^\d{8,}$/.test(name)) return name;
    const phone = lids[name] || name;
    return phones.get(phone) || nameOf.get(phone, `lid:${name}`)?.author_name || (lids[name] ? `+${phone}` : `@${name}`);
  };

  // Сверка с кассой WS — там, где есть и касса, и отчёты группы
  const dataFrom = rows[0]?.ts || null;
  const cashMeta = cashbookMeta();
  const recStart = cashMeta && dataFrom ? Math.max(start, Date.parse(cashMeta.coveredFrom), Date.parse(dataFrom)) : null;
  const recEnd = cashMeta ? Math.min(end, Date.parse(cashMeta.coveredTo) + 60000) : null;
  const recOps = [];
  const notes = groupCashNotes(rates);

  const summary = { revenue: 0, rent: 0, extras: 0, prepaid: 0, moneyIn: 0, moneyOut: 0, depositsTaken: 0, reports: 0, inCash: 0, inTransfer: 0 };
  const months = new Map();
  const accounts = new Map();
  const monthOf = (at) => bangkokIso(at).slice(0, 7);
  const receivers = new Map();
  const operations = [];
  const revenueByPlate = new Map();
  const rentals = new Map();
  const forecast = { bookings: 0, total: 0, prepaid: 0, left: 0 };
  const today = bangkokIso(now);
  const in30 = bangkokIso(now + 30 * DAY_MS);
  const parsed = [];
  // Залоги: последний взятый по машине (для возврата без суммы залога в отчёте) и удержанное
  const lastDeposit = new Map();
  const withheld = { sum: 0, count: 0, noAmount: 0, list: [] };
  // Наличные у сотрудников: за период и за всё время (для «на руках»)
  const holders = new Map();
  const holder = (name) => holders.get(name) || holders.set(name, {
    name, received: 0, paidOut: 0, spent: 0, handed: 0, events: [], lastHandover: null, currencies: {}
  }).get(name);

  for (const row of rows) {
    const at = row.at;
    const m = moneyOf(row, rates);
    parsed.push({ row, m });
    const inPeriod = at >= start && at < end;
    // Периоды аренды по отчётам (для загрузки машин): выдача, продление, замена «куда»
    if (['issue', 'extension', 'changed', 'payment'].includes(row.kind) && m.from && m.to) {
      for (const p of m.plates) (rentals.get(p.plate) || rentals.set(p.plate, []).get(p.plate)).push([dayStart(m.from), dayStart(m.to)]);
    }
    // Брони на 30 дней вперёд — прогноз (по дате начала аренды, не по дате отчёта)
    if (row.kind === 'booking' && m.from && m.from >= today && m.from <= in30 && at >= now - 60 * DAY_MS) {
      forecast.bookings++;
      forecast.total += m.bookingTotal;
      forecast.prepaid += m.prepaid;
      forecast.left += m.left || Math.max(0, m.bookingTotal - m.prepaid);
    }
    // Наличные: кто принял (или автор отчёта), кто вернул залог наличными
    // (кто — «by @…» в отчёте, иначе автор отчёта; одинаково для принятого и выданного)
    const cashHolder = receiverName(m.receiver) || who(row);
    if (m.cashIn && at <= now && !isOwner(cashHolder)) {
      const h = holder(cashHolder);
      h.events.push([at, m.cashIn]);
      if (inPeriod) {
        h.received += m.cashIn;
        for (const c of m.inCash) h.currencies[c.currency] = (h.currencies[c.currency] || 0) + c.amount;
      }
    }
    if (m.moneyOut && m.outCash && at <= now && !isOwner(cashHolder)) {
      const h = holder(cashHolder);
      h.events.push([at, -m.moneyOut]);
      if (inPeriod) h.paidOut += m.moneyOut;
    }
    // Удержано из залога: залог (из отчёта о возврате или из выдачи) минус возвращённое
    if (row.kind === 'return' && m.plates.length) {
      const dep = m.returnDeposit || m.plates.reduce((s, p) => s + (lastDeposit.get(p.plate) || 0), 0);
      if (inPeriod && dep) {
        if (!m.moneyOut) withheld.noAmount++;
        else if (dep - m.moneyOut >= 100) {
          withheld.sum += dep - m.moneyOut;
          withheld.count++;
          withheld.list.push({ id: row.id, ts: row.ts, plates: m.plates.map((p) => p.plate), deposit: round(dep), returned: round(m.moneyOut), withheld: round(dep - m.moneyOut), author: who(row) });
        }
      }
      for (const p of m.plates) lastDeposit.delete(p.plate);
    }
    if (m.deposit) for (const p of m.plates) lastDeposit.set(p.plate, m.deposit / m.plates.length);

    if (!inPeriod) continue;
    const prepaid = row.kind === 'booking' || row.kind === 'issue' ? m.prepaid : 0;
    if (recStart !== null && at >= recStart && at < recEnd && (m.revenue || prepaid || m.deposit || m.moneyOut)) {
      recOps.push({ id: row.id, at, kind: row.kind, author: who(row), plates: m.plates.map((p) => p.plate), rent: m.rent, extras: m.extras, prepaid, deposit: m.deposit, out: m.moneyOut });
    }
    if (!m.revenue && !m.moneyIn && !m.moneyOut && !m.deposit && !prepaid) continue;
    summary.reports++;
    summary.revenue += m.revenue;
    summary.rent += m.rent;
    summary.extras += m.extras;
    summary.prepaid += prepaid;
    summary.moneyIn += m.moneyIn;
    summary.moneyOut += m.moneyOut;
    summary.depositsTaken += m.deposit;
    const month = months.get(monthOf(at)) || { month: monthOf(at), rent: 0, extras: 0, prepaid: 0, depositIn: 0, depositOut: 0, moneyIn: 0 };
    month.rent += m.rent;
    month.extras += m.extras;
    month.prepaid += prepaid;
    month.depositIn += m.deposit;
    month.depositOut += m.moneyOut;
    month.moneyIn += m.moneyIn;
    months.set(month.month, month);
    // Куда поступили деньги — как счета в кассе: наличные в офисе, счета Алексея по валютам
    if (m.moneyIn) {
      const receiver = receiverName(m.receiver) || '';
      const parts = m.inCash.map((c) => ({ ...c, thb: c.currency === 'THB' ? c.amount : c.amount * (rates[c.currency] || 0) }));
      const partsTotal = parts.reduce((s, p) => s + p.thb, 0) || 1;
      for (const p of parts.length ? parts : [{ currency: 'THB', thb: m.moneyIn }]) {
        const share = parts.length ? (p.thb / partsTotal) * m.moneyIn : m.moneyIn;
        let account;
        if (/alex|boss/i.test(receiver)) account = `Alexey ${p.currency === 'USD' ? 'USDT/USD' : p.currency}`;
        else if (/kokon company|company/i.test(receiver)) account = 'Kokon Company THB';
        else if (receiver) account = 'Касса (наличные у сотрудников)';
        else if (m.transferLike && !m.cashLike) account = 'Переводы — счёт не указан';
        else account = 'Не указано';
        const a = accounts.get(account) || { account, thb: 0, currencies: {} };
        a.thb += share;
        a.currencies[p.currency] = (a.currencies[p.currency] || 0) + (p.amount || 0);
        accounts.set(account, a);
      }
    }
    if (m.moneyIn) {
      if (m.cashLike) summary.inCash += m.moneyIn;
      else if (m.transferLike) summary.inTransfer += m.moneyIn;
      const name = receiverName(m.receiver) || null;
      const r = receivers.get(name) || { name, thb: 0, count: 0, currencies: {} };
      r.thb += m.moneyIn;
      r.count++;
      for (const c of m.inCash) r.currencies[c.currency] = (r.currencies[c.currency] || 0) + c.amount;
      receivers.set(name, r);
    }
    // Выручка машины: поровну между машинами сообщения
    if (m.revenue && m.plates.length) {
      for (const p of m.plates) revenueByPlate.set(p.plate, (revenueByPlate.get(p.plate) || 0) + m.revenue / m.plates.length);
    }
    operations.push({
      id: row.id, ts: row.ts, kind: row.kind, author: who(row), plates: m.plates.map((p) => p.plate),
      revenue: m.revenue, moneyIn: m.moneyIn, moneyOut: m.moneyOut, deposit: m.deposit, receiver: receiverName(m.receiver),
      cash: m.cashLike, transfer: m.transferLike, keys: m.keys
    });
  }

  // Сдача кассы и расходы наличными из группы («Cash handover:», «Expense: … cash»)
  for (const n of notes) {
    if (n.at > now) continue;
    const name = who(n);
    if (isOwner(name)) continue;
    if (n.type === 'handover') {
      const h = holder(name);
      h.events.push([n.at, null]);
      if (n.at >= start && n.at < end) h.handed += n.thb;
      h.lastHandover = Math.max(h.lastHandover || 0, n.at);
    } else if (n.inCash) {
      const h = holder(name);
      h.events.push([n.at, -n.thb]);
      if (n.at >= start && n.at < end) h.spent += n.thb;
    }
  }

  const debtList = findDebts(parsed, now, who);
  const overdue = debtList.filter((d) => d.overdue);
  const upcoming = debtList.filter((d) => !d.overdue);

  // Депозиты на руках сейчас: машины в аренде по группе → депозит из их последней выдачи
  let depositsHeld = 0;
  let depositsHeldCars = 0;
  for (const g of groupStatusByPlate().values()) {
    if (g.status !== 'rent') continue;
    const row = db.raw.prepare('SELECT id, kind, author, text, data, ts FROM wa_messages WHERE id = ?').get(g.id);
    if (!row) continue;
    const m = moneyOf(row, rates);
    if (!m.deposit) continue;
    depositsHeld += m.deposit / Math.max(1, m.plates.length);
    depositsHeldCars++;
  }

  // Расходы за период и за окно прибыли (где есть отчёты группы — выручка считается только там)
  const expenses = expensesFor(start, end, cashMeta, notes);
  const profitStart = dataFrom ? Math.max(start, dayStart(bangkokIso(Date.parse(dataFrom)))) : start;
  const profitExpenses = profitStart < end ? (profitStart === start ? expenses : expensesFor(profitStart, end, cashMeta, notes)) : null;
  const expensesKnown = Boolean(profitExpenses && (profitExpenses.cashFrom || profitExpenses.groupReports));
  const salary = salaryByTimesheet(from, to, phones);

  // Машины: выручка, загрузка, ремонт и прочие расходы (касса WS, «Expense:»), кредит
  let fleetUnits = [];
  try {
    fleetUnits = (await getFleet()).units || [];
  } catch { /* без таблицы — только машины из отчётов */ }
  const loanMap = loans();
  const vehicles = new Map();
  for (const u of fleetUnits) {
    const plate = plateKey(u.plate);
    if (plate) vehicles.set(plate, { plate, model: u.model || `${u.brand || ''} ${u.modelName || ''}`.trim() || null, type: u.type || null });
  }
  for (const plate of new Set([...revenueByPlate.keys(), ...rentals.keys(), ...expenses.byPlate.keys(), ...Object.keys(loanMap)])) {
    if (!vehicles.has(plate)) vehicles.set(plate, { plate, model: null, type: null });
  }
  const vehicleRows = [...vehicles.values()].map((v) => {
    // Дни аренды в периоде: объединяем пересекающиеся периоды
    const spans = (rentals.get(v.plate) || []).map(([a, b]) => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    let rented = 0;
    let cursor = -Infinity;
    for (const [a, b] of spans) {
      const fromMs = Math.max(a, cursor);
      if (b > fromMs) rented += b - fromMs;
      cursor = Math.max(cursor, b);
    }
    const rentedDays = Math.round(rented / DAY_MS);
    const costs = expenses.byPlate.get(v.plate) || { repair: 0, other: 0 };
    const loanMonthly = loanMap[v.plate] || 0;
    const loan = round((loanMonthly * days) / 30.44);
    const revenue = round(revenueByPlate.get(v.plate) || 0);
    return {
      ...v, revenue, rentedDays, utilization: Math.min(100, Math.round((rentedDays / days) * 100)),
      repair: round(costs.repair), otherCosts: round(costs.other), loanMonthly, loan,
      result: revenue - round(costs.repair) - round(costs.other) - loan
    };
  }).sort((a, b) => b.revenue - a.revenue || b.rentedDays - a.rentedDays);

  // «На руках» — с последней сдачи кассы (считаем, что сдают всё). Кто сдачу ещё не
  // отмечает — цифры нет: без сдачи сумма только растёт и ничего не значит
  const holderRows = [...holders.values()].map((h) => {
    let onHand = null;
    if (h.lastHandover) {
      onHand = h.events.filter(([at, d]) => at > h.lastHandover && d !== null).reduce((s, [, d]) => s + d, 0);
    }
    return {
      name: h.name, received: round(h.received), paidOut: round(h.paidOut), spent: round(h.spent), handed: round(h.handed),
      currencies: h.currencies, lastHandover: h.lastHandover ? isoOf(h.lastHandover) : null, onHand: onHand === null ? null : round(onHand)
    };
  }).filter((h) => h.received || h.paidOut || h.spent || h.handed || h.onHand)
    .sort((a, b) => (b.onHand ?? -Infinity) - (a.onHand ?? -Infinity) || b.received - a.received);
  const team = holderRows.reduce((t, h) => ({
    received: t.received + h.received, paidOut: t.paidOut + h.paidOut, spent: t.spent + h.spent, handed: t.handed + h.handed
  }), { received: 0, paidOut: 0, spent: 0, handed: 0 });

  for (const k of Object.keys(summary)) summary[k] = round(summary[k]);
  const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v]));
  const { byPlate, ...expensesOut } = expenses;
  return {
    period: { from, to, days },
    // Данные группы есть не с начала года — портал покажет, с какой даты
    dataFrom,
    cashbook: cashMeta,
    profit: {
      from: isoOf(profitStart), to: isoOf(end),
      revenue: summary.revenue,
      expenses: expensesKnown ? profitExpenses.total : null,
      result: expensesKnown ? summary.revenue - profitExpenses.total : null,
      expensesFrom: profitExpenses?.cashFrom || null,
      expensesTo: profitExpenses?.cashTo || null
    },
    wsCheck: recStart !== null && recEnd > recStart ? wsCheck(recStart, recEnd, recOps, clientsVisible) : null,
    expenses: { ...expensesOut, salary: { ...salary, people: timesheetVisible ? salary.people : [] } },
    cash: {
      holders: holderRows,
      team: { ...team, net: team.received - team.paidOut - team.spent - team.handed },
      handoverReports: notes.filter((n) => n.type === 'handover').length,
      expenseReports: notes.filter((n) => n.type === 'expense').length,
      office: expenses.ws ? { in: expenses.ws.officeIn, out: expenses.ws.officeOut, toOwner: expenses.ws.officeToOwner, fromOwner: expenses.ws.officeFromOwner } : null
    },
    months: [...months.values()].map(roundAll).sort((a, b) => a.month.localeCompare(b.month)),
    accounts: [...accounts.values()].map((a) => ({ ...a, thb: round(a.thb) })).sort((a, b) => b.thb - a.thb),
    rates: { rates, at: ratesAt, approximate },
    summary,
    receivers: [...receivers.values()].map((r) => ({ ...r, thb: round(r.thb) })).sort((a, b) => (a.name === null) - (b.name === null) || b.thb - a.thb),
    deposits: {
      held: round(depositsHeld), cars: depositsHeldCars, taken: summary.depositsTaken, returned: summary.moneyOut,
      withheld: round(withheld.sum), withheldCount: withheld.count, noAmount: withheld.noAmount,
      withheldList: withheld.list.sort((a, b) => b.withheld - a.withheld).slice(0, 30)
    },
    debts: {
      overdueSum: overdue.reduce((s, d) => s + d.amount, 0), overdueCount: overdue.length,
      upcomingSum: upcoming.reduce((s, d) => s + d.amount, 0), upcomingCount: upcoming.length,
      list: debtList.slice(0, 60)
    },
    forecast: { ...forecast, total: round(forecast.total), prepaid: round(forecast.prepaid), left: round(forecast.left) },
    vehicles: vehicleRows,
    loans: loanMap,
    operations: operations.reverse().slice(0, 300)
  };
}

/* ------------------------------------------------------- Сверка с кассой WS */

const CHECK_KEYS = [
  ['rent', 'Оплата за аренду'],
  ['extras', 'Оплата за доп. услуги'],
  ['prepaid', 'Предоплата за заявку/бронь'],
  ['depositIn', 'Внесение залога'],
  ['depositOut', 'Возврат залога']
];
const MATCH_MS = 3 * DAY_MS;
const roundValues = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

/**
 * Сверка за окно [a, b): по статьям, месяцам, машинам и операциям.
 * Операции: оплата в кассе по брони (н/д) ↔ отчёт в группе по той же машине ±3 дня.
 */
function wsCheck(a, b, groupOps, clientsVisible) {
  const ws = cashbookRows(new Date(a).toISOString(), new Date(b).toISOString());
  const empty = () => Object.fromEntries(CHECK_KEYS.map(([k]) => [k, 0]));
  const wsSum = empty();
  const grSum = empty();
  const months = new Map();
  const monthRow = (m) => months.get(m) || months.set(m, { month: m, ws: empty(), group: empty() }).get(m);
  const plates = new Map();
  const plateRow = (p, vehicle) => plates.get(p) || plates.set(p, { plate: p, vehicle: vehicle || null, ws: 0, group: 0 }).get(p);

  for (const r of ws) {
    const key = PURPOSE_GROUP[r.purpose];
    if (!key || !(key in wsSum)) continue;
    const value = key === 'depositOut' ? r.expense : r.income;
    wsSum[key] += value;
    monthRow(bangkokIso(Date.parse(r.ts)).slice(0, 7)).ws[key] += value;
    if (r.plate && ['rent', 'extras', 'prepaid'].includes(key)) plateRow(r.plate, r.vehicle).ws += value;
  }
  for (const o of groupOps) {
    const vals = { rent: o.rent, extras: o.extras, prepaid: o.prepaid, depositIn: o.deposit, depositOut: o.out };
    const mr = monthRow(bangkokIso(o.at).slice(0, 7));
    for (const [k] of CHECK_KEYS) { grSum[k] += vals[k]; mr.group[k] += vals[k]; }
    // Выручка машины по группе: аренда + доп. услуги (предоплата входит в аренду при выдаче)
    for (const p of o.plates) plateRow(p).group += (o.rent + o.extras) / Math.max(1, o.plates.length);
  }

  // Операции: брони кассы (аренда, залог, предоплата) ↔ отчёты группы по той же машине
  const bookings = new Map();
  for (const r of ws) {
    const key = PURPOSE_GROUP[r.purpose];
    if (!['rent', 'prepaid', 'depositIn', 'extras'].includes(key) || !r.income) continue;
    const id = r.booking || `${r.plate || r.vehicle}|${r.ts.slice(0, 10)}`;
    const bk = bookings.get(id) || bookings.set(id, { booking: r.booking, plate: r.plate, vehicle: r.vehicle, client: r.client, ts: r.ts, times: [], sum: 0 }).get(id);
    bk.times.push(Date.parse(r.ts));
    bk.sum += r.income;
  }
  const usedGroup = new Set();
  const wsOnly = [];
  for (const bk of bookings.values()) {
    const match = groupOps.find((o) => o.plates.includes(bk.plate) && bk.times.some((t) => Math.abs(t - o.at) <= MATCH_MS));
    if (match) {
      for (const o of groupOps) if (o.plates.includes(bk.plate) && bk.times.some((t) => Math.abs(t - o.at) <= MATCH_MS)) usedGroup.add(o.id);
      continue;
    }
    wsOnly.push({ ts: bk.ts, plate: bk.plate, vehicle: bk.vehicle, booking: bk.booking, client: clientsVisible ? bk.client : null, sum: round(bk.sum) });
  }
  const groupOnly = groupOps
    .filter((o) => !usedGroup.has(o.id) && (o.rent + o.extras + o.prepaid + o.deposit) > 0)
    .filter((o) => !o.plates.length || !ws.some((r) => r.plate && o.plates.includes(r.plate) && Math.abs(Date.parse(r.ts) - o.at) <= MATCH_MS))
    .map((o) => ({ id: o.id, ts: new Date(o.at).toISOString(), kind: o.kind, author: o.author, plates: o.plates, sum: round(o.rent + o.extras + o.prepaid + o.deposit) }));

  const byDiff = (x, y) => Math.abs(y.ws - y.group) - Math.abs(x.ws - x.group);
  return {
    from: new Date(a).toISOString(),
    to: new Date(b).toISOString(),
    categories: CHECK_KEYS.map(([k, label]) => ({ key: k, label, ws: round(wsSum[k]), group: round(grSum[k]) })),
    months: [...months.values()].sort((x, y) => x.month.localeCompare(y.month))
      .map((m) => ({ month: m.month, ws: roundValues(m.ws), group: roundValues(m.group) })),
    vehicles: [...plates.values()].map((v) => ({ ...v, ws: round(v.ws), group: round(v.group) }))
      .filter((v) => Math.abs(v.ws - v.group) >= 500).sort(byDiff).slice(0, 25),
    wsOnly: wsOnly.sort((x, y) => y.sum - x.sum).slice(0, 60),
    wsOnlyCount: wsOnly.length,
    wsOnlySum: round(wsOnly.reduce((s, x) => s + x.sum, 0)),
    groupOnly: groupOnly.sort((x, y) => y.sum - x.sum).slice(0, 60),
    groupOnlyCount: groupOnly.length,
    groupOnlySum: round(groupOnly.reduce((s, x) => s + x.sum, 0))
  };
}
