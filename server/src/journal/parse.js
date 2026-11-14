/**
 * ============================================================================
 * Разбор сообщений рабочей группы WhatsApp → операции журнала
 * ============================================================================
 * Сотрудники пишут отчёты по шаблонам (на английском), например:
 *   Rented / Royal Enfield Meteor350 #3652 / Location / Fuel / Mileage /
 *   From–To / 550 thb per day / Rent / Deposit / Received / Contact
 * Есть второй шаблон менеджера продаж: RENT / BOOKING, Date / Return / Day,
 * Price: 1.250 * 3 = 3.750 thb, Number, Received (получено).
 * Машина определяется по госномеру после «#» (только цифры — как в Автопрокате).
 * Функция чистая: текст → { kind, plates, fields, status }. Что не похоже на
 * операцию — kind 'note' (обычная переписка), её не показываем как операцию.
 * ============================================================================
 */

/** Виды операций в порядке проверки первой строки */
const KINDS = [
  ['booking', /^booking\b/],
  ['issue', /^rent(ed)?\b(?!\s*(out\b|:))/],
  ['return', /^accept(ed)?\b/],
  ['pickup_task', /^to pick ?up\b/],
  ['change_task', /^to change\b/],
  ['reschedule', /^change(d)? the (date|time)s?\b/],
  ['changed', /^change(d)?\b/],
  ['extension', /^extension\b/],
  ['payment', /^(monthly |extra )?payment\b/],
  ['service', /^need(s)? (a )?service\b|^service\b/]
];

// Отметки смены: «Morning», «Good morning 🌞», «Good night 😴», «Evening»
const SHIFT_START = /^(good )?morning\b/;
// Виды, где вторая строка без «#» — это модель («Booking & delivery / Honda CB650R»)
const MODEL_KINDS = new Set(['booking', 'issue', 'return', 'extension', 'payment', 'service']);
const SHIFT_END = /^(good )?(night|evening)\b/;

const CURRENCIES = {
  thb: 'THB', baht: 'THB', '฿': 'THB', usdt: 'USDT', usd: 'USD', '$': 'USD', rub: 'RUB', '₽': 'RUB',
  gbp: 'GBP', '£': 'GBP', eur: 'EUR', '€': 'EUR', aud: 'AUD'
};
const AMOUNT = /(\d[\d,.\s]*?\d|\d)\s*(thb|baht|usdt|usd|rub|gbp|eur|aud|[$€£฿₽])(?![a-z])/gi;

// Подписи строк с деньгами → единые ключи
const MONEY_LABELS = [
  ['booking_received', /^booking (payment )?received/],
  ['deposit_received', /^deposit received/],
  ['return_deposit', /^return deposit/],
  ['extra_received', /^extra payment received|^extra paid|^extra payment/],
  ['received', /^(total )?received|^payment received|^monthly payment received/],
  ['returned', /^returned|^retured|^refunded|^return(ed)? (in )?cash/],
  ['to_receive', /^to receive|^to collect/],
  ['to_return', /^to return|^to refund/],
  ['to_deduct', /^to deduct/],
  ['left', /^left amount|^rent left amount/],
  ['rent_delivery', /^rent \+ delivery/],
  ['rent', /^rent\b|^price\b|^\d+(st|nd|rd|th) month/],
  ['deposit', /^deposit\b/],
  ['delivery', /^d[a-z]?livery\b|^deliver\b|^delivery \+ pick ?up/],
  ['pickup_fee', /^pick ?up\b/],
  ['extension', /^extension\b/],
  ['total', /^total\b/],
  ['overtime', /^overtime\b/],
  ['fuel_fee', /^fuel\b|^gas\b/],
  ['helmet_fee', /^helmets?\b/],
  ['box', /^box\b/],
  ['child_seat', /^child seat\b/]
];

const clean = (text) => String(text || '')
  .replace(/<(image|video|audio|sticker|document|gif) omitted>|<attached:[^>]*>|<album message>|<unknown message>|<this message was edited>/gi, '')
  .replace(/^\s*\[forwarded\]\s*/i, '')
  .replace(/[‎‏‪-‮]/g, '')
  .trim();

/** '8,250' → 8250; '3.750' → 3750 (точка — разделитель тысяч); '303.5' → 303.5 */
export function parseNumber(raw) {
  const s = String(raw).replace(/\s+/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Все суммы в строке: [{ amount, currency }] — после «=» берём итог, а не множители */
export function amountsIn(line) {
  const tail = line.includes('=') ? line.slice(line.lastIndexOf('=')) : line;
  const found = [];
  for (const m of tail.matchAll(AMOUNT)) {
    const amount = parseNumber(m[1]);
    if (amount == null) continue;
    found.push({ amount, currency: CURRENCIES[m[2].toLowerCase()] });
  }
  return found;
}

/** '12.11.26' / '4.10.26' / '10.10 26' / '12.11.2026' → '2026-11-12'; без года — по ref */
export function parseDate(raw, ref = new Date()) {
  const m = String(raw || '').match(/\b(\d{1,2})[./](\d{1,2})(?:[./\s](\d{2,4}))?\b/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let year = m[3] ? Number(m[3]) : ref.getUTCFullYear();
  if (year < 100) year += 2000;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const plateOf = (line) => line.match(/#\s?(\d{2,5})\b/)?.[1] || null;

/** «🏍️Royal Enfield Meteor350 #3652» → «Royal Enfield Meteor350» */
const modelOf = (line) => line.replace(/#\s?\d{2,5}\b.*$/, '').replace(/^\s*\d+\.\s*/, '')
  .replace(/^(from|to|fron)\s*:/i, '').replace(/[\p{Extended_Pictographic}️]/gu, '').trim() || null;

const labelOf = (line) => {
  // «https://…» — ссылка, а не подпись поля
  const m = line.match(/^\s*([^:;]{1,40}?)\s*[:;](?!\/\/)\s*(.*)$/);
  return m ? { label: m[1].trim().toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').trim(), value: m[2].trim() } : null;
};

/** Вид операции по первой строке; null — не операция */
export function kindOf(text) {
  const body = clean(text);
  if (!body) return null;
  const first = body.split('\n')[0].replace(/[\p{Extended_Pictographic}️]/gu, '').trim().toLowerCase();
  // «Changed the bikes & Extension» — замена (продление учтём по датам)
  for (const [kind, re] of KINDS) if (re.test(first)) return kind;
  const short = body.replace(/[\p{Extended_Pictographic}️.!]/gu, '').trim().toLowerCase();
  if (short.length <= 24 && SHIFT_START.test(short)) return 'shift_start';
  if (short.length <= 24 && SHIFT_END.test(short)) return 'shift_end';
  if (/\bavailable\b/.test(first) && !/^(yes|no|not)\b/.test(first)) return 'question';
  return null;
}

/**
 * Полный разбор: { kind, status, plates: [{ plate, model, role }], fields }
 * role: 'main' — машина операции, 'from' / 'to' — при замене.
 * status: 'ok' — распознано; 'review' — операция, но не хватает главного.
 */
export function parseMessage(text, ref = new Date()) {
  const body = clean(text);
  // Фото или видео без подписи — их привяжем к отчёту, на который ответили
  if (!body) return { kind: 'media', status: 'ok', plates: [], fields: {} };
  const kind = kindOf(body);
  if (!kind) return { kind: 'note', status: 'ok', plates: platesMentioned(body), fields: {} };
  if (kind === 'shift_start' || kind === 'shift_end' || kind === 'question') {
    return { kind, status: 'ok', plates: platesMentioned(body), fields: kind === 'question' ? { text: body.slice(0, 300) } : {} };
  }

  const lines = body.split('\n').map((l) => l.trim());
  const fields = { money: [], notes: [], assignees: [] };
  const plates = [];
  // Госномер прямо в первой строке: «Rented #6907»
  const firstPlate = plateOf(lines[0]);
  if (firstPlate) plates.push({ plate: firstPlate, model: null, role: 'main' });
  let noteMode = false;
  let lastLabel = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { lastLabel = null; continue; }
    if (/^_{3,}$|^-{3,}$/.test(line) || /^note\s*!?:?$/i.test(line)) { noteMode = true; continue; }
    if (/^@/.test(line)) {
      fields.assignees.push(...line.split('@').slice(1).map((s) => s.replace(/^~/, '').split(/[,!]|\s+pls\b|\s+please\b/i)[0].trim()).filter(Boolean));
      const rest = line.replace(/^(@~?[^@,]+?)(,|\s+(?=pls|please))/i, '').trim();
      if (rest !== line && rest) fields.notes.push(rest);
      continue;
    }
    if (noteMode) { fields.notes.push(line); continue; }

    const lv = labelOf(line);
    const plate = plateOf(line);

    // Машины: строки «Модель #1234» до полей, «From: X #1» / «To: Y #2» при замене, «1. 🏍️ ADV 350 #1124»
    if (plate && (!lv || /^(from|to|fron)$/.test(lv.label))) {
      const role = lv?.label === 'to' ? 'to' : lv && /^(from|fron)$/.test(lv.label) ? 'from' : 'main';
      if (!plates.some((p) => p.plate === plate && p.role === role)) plates.push({ plate, model: modelOf(line), role });
      continue;
    }
    if (MODEL_KINDS.has(kind) && !plate && !lv && (plates.length === 0 || (plates.length === 1 && !plates[0].model && i === 1)) && !fields.model && i <= 3 && !/^(contact|telegram|whatsapp)$/i.test(line) && !/\d+\s*(days?|months?)\b/i.test(line)) {
      // Бронь без госномера: «Honda CB650R», «🏍️XADV 750»
      const model = modelOf(line);
      if (model && /[a-z]/i.test(model) && model.length <= 40) {
        if (plates.length === 1 && !plates[0].model) plates[0].model = model;
        else fields.model = model;
        continue;
      }
    }

    if (/^contact$/i.test(line) || /^contact\s*:/i.test(line)) {
      const inline = line.split(':')[1]?.trim();
      const next = inline || lines.slice(i + 1).find((l) => l);
      if (next) fields.contact = next.replace(/\s+/g, ' ').trim();
      if (!inline) i = lines.indexOf(next, i + 1);
      continue;
    }

    // Суммы на отдельной строке после подписи («Mileage: 27994 (#7376)\n 24896 (#7037)»)
    if (!lv) {
      if (lastLabel === 'fuel' && /%/.test(line)) { pushPercent(fields, line); continue; }
      if (lastLabel === 'mileage' && /\d/.test(line)) { pushMileage(fields, line); continue; }
      if (lastLabel === 'location' && !fields.location) { fields.location = line; continue; }
      const days = line.match(/^(\d+)\s*days?\b/i);
      const months = line.match(/^(\d+)\s*months?\b/i);
      if (days) { fields.days = Number(days[1]); continue; }
      if (months) { fields.months = Number(months[1]); continue; }
      const perDay = line.match(/([\d,.]+)\s*(thb|baht|usd|usdt|€|\$)\s*per day/i);
      if (perDay) { fields.perDay = { amount: parseNumber(perDay[1]), currency: CURRENCIES[perDay[2].toLowerCase()] }; continue; }
      if (/^no helmets?\b/i.test(line)) { fields.helmets = 0; continue; }
      if (/^no booking payments? received/i.test(line)) { fields.bookingPaid = false; continue; }
      if (/^(telegram|whatsapp|line)$/i.test(line)) continue;
      const amounts = amountsIn(line);
      if (amounts.length) { fields.money.push({ key: 'other', label: line.slice(0, 60), amounts, text: line }); continue; }
      fields.notes.push(line);
      continue;
    }

    const { label, value } = lv;
    lastLabel = null;
    if (label === 'location' || label === 'location https') {
      fields.location = value || null;
      if (!value) lastLabel = 'location';
      continue;
    }
    if (label === 'fuel' && /%/.test(value)) { pushPercent(fields, value); lastLabel = 'fuel'; continue; }
    if (label === 'mileage') { pushMileage(fields, value); lastLabel = 'mileage'; continue; }
    if (/^(from|fron|date|rental start(ed)?)$/.test(label)) { fields.from = parseDate(value, ref) || fields.from; continue; }
    if (/^(to|return|rental end(s)?|rental ends)$/.test(label)) { fields.to = parseDate(value, ref) || fields.to; continue; }
    if (label === 'day' || label === 'days') { const n = parseInt(value, 10); if (n) fields.days = n; continue; }
    if (label === 'next payment' || label === 'next pay' || label === 'payment next month') { fields.nextPayment = parseDate(value, ref); continue; }
    if (/^(time|delivery time|pick up time)$/.test(label)) { fields.time = value; continue; }
    if (label === 'number') { fields.contact = value.replace(/^tg:\s*@?/i, '@').replace(/\s+/g, ' ').trim(); continue; }
    if (/^helmets?$/.test(label) && !amountsIn(value).length) {
      const n = value.match(/\d+/);
      fields.helmets = n ? Number(n[0]) : fields.helmets;
      continue;
    }

    const amounts = amountsIn(value);
    if (amounts.length) {
      const key = MONEY_LABELS.find(([, re]) => re.test(label))?.[0] || 'other';
      fields.money.push({
        key, label: label.slice(0, 40), amounts, text: line,
        cash: /\bcash\b/i.test(value) || undefined,
        transfer: /transfer|bank|wallet/i.test(value) || undefined
      });
      continue;
    }
    fields.notes.push(line);
  }

  if (!fields.money.length) delete fields.money;
  if (!fields.notes.length) delete fields.notes;
  if (!fields.assignees.length) delete fields.assignees;

  // Шаблон менеджера «change: 🏍️Rebel #4407 … RENT … 🚘MG #744»: первая машина — старая, последняя — новая
  if ((kind === 'changed' || kind === 'change_task') && !plates.some((p) => p.role !== 'main')) {
    const mains = plates.filter((p) => p.role === 'main');
    if (mains.length >= 2) {
      mains[0].role = 'from';
      mains[mains.length - 1].role = 'to';
    }
  }

  // Без госномера нормальны только бронь (машину выберут позже) и общие оплаты
  const needsPlate = !['booking', 'payment', 'service'].includes(kind);
  const changeOk = kind !== 'changed' && kind !== 'change_task' || plates.some((p) => p.role === 'to');
  const status = (needsPlate && !plates.length) || !changeOk ? 'review' : 'ok';
  return { kind, status, plates, fields };
}

function pushPercent(fields, text) {
  for (const m of text.matchAll(/(\d{1,3})\s*%\s*(?:\(#?(\d{2,5})\))?/g)) {
    (fields.fuel ||= []).push({ percent: Number(m[1]), plate: m[2] || null });
  }
}

function pushMileage(fields, text) {
  for (const m of text.matchAll(/(\d[\d,.\s]*\d|\d)\s*(?:km|thb)?\s*(?:\(#?(\d{2,5})\))?/gi)) {
    const value = parseNumber(m[1]);
    if (value && value >= 10) (fields.mileage ||= []).push({ km: value, plate: m[2] || null });
  }
}

/** Госномера, упомянутые в обычной переписке («MG3 #2474 не заводится») */
function platesMentioned(body) {
  return [...new Set([...body.matchAll(/#\s?(\d{2,5})\b/g)].map((m) => m[1]))].map((plate) => ({ plate, model: null, role: 'mention' }));
}
