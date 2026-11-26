/**
 * ============================================================================
 * Кабинет агента (и партнёра: отеля, компании)
 * ============================================================================
 * Кабинет есть у сотрудника, которого админ в «Доступах» привязал к источнику из
 * «Маркетинга» (код, ссылки, % комиссии). Роль при этом любая: «Агент» (только
 * кабинет) или, например, «Менеджер» — тогда у него и вкладки менеджера, и
 * кабинет (один человек совмещает обе роли). В кабинете:
 *   - свои ссылки (сайт, Telegram, WhatsApp) и QR-коды, переходы по ним;
 *   - свои заявки: имя клиента, последние 4 цифры телефона, что и на какие даты,
 *     путь заявки «новая → взята → бронь → аренда»;
 *   - комиссию: % от суммы аренды без залога. Аренда относится к заявке, если
 *     началась в течение 60 дней после неё (как в «Маркетинге»). Начисляется,
 *     когда аренда закончилась, — и запоминается (потом не пересчитывается);
 *   - выплаты (записывают админ и владелец) и остаток к выплате;
 *   - цены для клиентов (только просмотр);
 *   - форму «＋ Заявка» — заявка уходит в рабочие группы с пометкой агента.
 * Агенту приходят уведомления (Telegram, иначе письмо): заявку взяли,
 * начислена комиссия, записана выплата. Язык — тот, что агент выбрал в портале.
 *
 *   GET  /api/staff/agent?source=&lang=   — кабинет (source — просмотр админом)
 *   POST /api/staff/agent/request         — заявка от агента
 *   POST /api/staff/agent/payout          — записать выплату («Маркетинг: меняет»)
 *   POST /api/staff/agent/payout/delete   — убрать ошибочную выплату
 * ============================================================================
 */

import * as db from './db.js';
import { config } from './config.js';
import { HttpError, sendJson, readJson, rateLimiter } from './http.js';
import { can } from './roles.js';
import { sourceById, sourceByCode, sourceLinks, allSources } from './marketing.js';
import { requestRentals } from './crm.js';
import { agentsOfSource } from './access.js';
import { publishRequest, addTakenListener } from './staff.js';
import { getFleet, plateKey } from './fleet.js';
import { priceActive, priceView, listSeasons } from './price.js';
import { TIER_LABELS } from './pricing.js';
import { telegramEnabled, sendMessage } from './telegram/api.js';
import { mailEnabled, sendMail } from './mail.js';
import { escapeHtml, VEHICLE_TYPES } from './format.js';
import { todayIso } from './dates.js';

const DAY_MS = 86400000;
const ACCRUE_EVERY_MS = 60 * 60 * 1000;
const MAX_RENTAL_DAYS = 365;
const requestLimiter = rateLimiter(60 * 60 * 1000, 30);

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS agent_commissions (
    key        TEXT PRIMARY KEY,
    source_id  INTEGER NOT NULL,
    request_id INTEGER NOT NULL,
    model      TEXT,
    plates     TEXT,
    date_from  TEXT,
    date_to    TEXT,
    sum        REAL NOT NULL,
    percent    REAL NOT NULL,
    amount     REAL NOT NULL,
    accrued_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_commissions_source ON agent_commissions (source_id);
  CREATE TABLE IF NOT EXISTS agent_payouts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id  INTEGER NOT NULL,
    amount     REAL NOT NULL,
    paid_on    TEXT NOT NULL,
    method     TEXT,
    note       TEXT,
    by_email   TEXT,
    by_name    TEXT,
    created_at TEXT NOT NULL
  );
`);

const q = {
  requests: db.raw.prepare(`SELECT * FROM requests WHERE source_ref = ? AND (kind IS NULL OR kind != 'question')
    ORDER BY id DESC LIMIT 500`),
  accruals: db.raw.prepare('SELECT * FROM agent_commissions WHERE source_id = ? ORDER BY date_to DESC, accrued_at DESC'),
  accrue: db.raw.prepare(`INSERT OR IGNORE INTO agent_commissions (key, source_id, request_id, model, plates, date_from, date_to, sum, percent, amount, accrued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  payouts: db.raw.prepare('SELECT * FROM agent_payouts WHERE source_id = ? ORDER BY paid_on DESC, id DESC'),
  payout: db.raw.prepare('SELECT * FROM agent_payouts WHERE id = ?'),
  addPayout: db.raw.prepare(`INSERT INTO agent_payouts (source_id, amount, paid_on, method, note, by_email, by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  deletePayout: db.raw.prepare('DELETE FROM agent_payouts WHERE id = ?'),
  visits: db.raw.prepare('SELECT COALESCE(SUM(n), 0) n FROM marketing_visits WHERE code = ? AND day >= ?')
};

const nowIso = () => new Date().toISOString();
const round = (n) => Math.round(Number(n) || 0);
const percentOf = (s) => (s?.costType === 'commission' ? Number(s.costValue) || 0 : 0);
const phoneTail = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));

/* ------------------------------------------------- Тексты уведомлений агенту */

const TEXTS = {
  ru: {
    taken: '✅ <b>Заявку #{id} взяли в работу</b> ({client}). Менеджер {name} свяжется с клиентом.',
    accrued: '💰 <b>Начислена комиссия {total}</b>',
    accruedLine: '• {model} {from}–{to}: аренда {sum}, комиссия {amount}',
    payout: '💸 <b>Записана выплата {amount}</b> ({date}). Остаток к выплате: {balance}.',
    subjectTaken: 'Заявка #{id} взята в работу', subjectAccrued: 'Начислена комиссия {total}', subjectPayout: 'Выплата {amount}',
    link: '👉 Ваш кабинет: {url}'
  },
  en: {
    taken: '✅ <b>Request #{id} was taken</b> ({client}). Manager {name} will contact the client.',
    accrued: '💰 <b>Commission accrued: {total}</b>',
    accruedLine: '• {model} {from}–{to}: rental {sum}, commission {amount}',
    payout: '💸 <b>Payout recorded: {amount}</b> ({date}). Balance to pay: {balance}.',
    subjectTaken: 'Request #{id} was taken', subjectAccrued: 'Commission accrued: {total}', subjectPayout: 'Payout {amount}',
    link: '👉 Your cabinet: {url}'
  },
  th: {
    taken: '✅ <b>รับคำขอ #{id} แล้ว</b> ({client}) ผู้จัดการ {name} จะติดต่อลูกค้า',
    accrued: '💰 <b>ได้รับค่าคอมมิชชั่น {total}</b>',
    accruedLine: '• {model} {from}–{to}: ค่าเช่า {sum}, ค่าคอมมิชชั่น {amount}',
    payout: '💸 <b>บันทึกการจ่ายเงิน {amount}</b> ({date}) ยอดคงเหลือ: {balance}',
    subjectTaken: 'รับคำขอ #{id} แล้ว', subjectAccrued: 'ค่าคอมมิชชั่น {total}', subjectPayout: 'จ่ายเงิน {amount}',
    link: '👉 หน้าของคุณ: {url}'
  }
};
const langOf = (email) => {
  const lang = db.getSetting(`agent_lang:${email}`);
  return TEXTS[lang] ? lang : 'en';
};
const tx = (lang, key, params = {}) => String(TEXTS[lang]?.[key] ?? TEXTS.en[key]).replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
const baht = (n) => `${new Intl.NumberFormat('en-US').format(round(n))} ฿`;
const dm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '?');

/** Сообщение всем агентам источника: Telegram, если не дошло — письмо */
async function notifyAgents(sourceId, build) {
  for (const agent of agentsOfSource(sourceId)) {
    const lang = langOf(agent.email);
    const { text, subject } = build(lang);
    const body = `${text}\n\n${tx(lang, 'link', { url: `${config.staff.url}/#cabinet` })}`;
    if (telegramEnabled && agent.telegramId) {
      try {
        await sendMessage(agent.telegramId, body, { disable_web_page_preview: true });
        continue;
      } catch (err) {
        console.error(`Agent notice to ${agent.email || agent.name} via Telegram failed (${err.message})`);
      }
    }
    if (!mailEnabled || !agent.email) continue;
    const plain = body.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    await sendMail({ to: agent.email, subject, text: plain })
      .catch((err) => console.error(`Agent notice mail to ${agent.email} failed:`, err.message));
  }
}

/** Заявку агента взяли в работу (Telegram-кнопка, «+» в WhatsApp-группе) */
addTakenListener(async (request) => {
  const source = request.source_ref ? sourceByCode(request.source_ref) : null;
  if (!source) return;
  const client = escapeHtml(request.client_name || '—');
  await notifyAgents(source.id, (lang) => ({
    text: tx(lang, 'taken', { id: request.id, client, name: escapeHtml(request.taken_by_name || '—') }),
    subject: tx(lang, 'subjectTaken', { id: request.id })
  }));
});

/* ------------------------------------------------------ Начисление комиссии */

let accruing = null;

/**
 * Закончившиеся аренды клиентов агентов → запись комиссии (один раз на аренду).
 * Первый запуск записывает прошлые аренды молча, дальше — с уведомлением агенту.
 */
export function accrueCommissions(now = Date.now()) {
  if (!accruing) accruing = doAccrue(now).finally(() => { accruing = null; });
  return accruing;
}

async function doAccrue(now) {
  const sources = allSources().filter((s) => percentOf(s) > 0);
  if (!sources.length) return 0;
  const rentals = await requestRentals(now);
  const silent = db.getSetting('agent_commissions_init') !== '1';
  const fresh = new Map();
  for (const s of sources) {
    for (const r of q.requests.all(s.code)) {
      for (const rental of rentals.get(r.id)?.rentals || []) {
        if (!rental.ended || rental.sum <= 0) continue;
        const percent = percentOf(s);
        const amount = round((rental.sum * percent) / 100);
        const key = `${s.id}|${rental.key}`;
        const info = q.accrue.run(key, s.id, r.id, rental.model, rental.plates.join(', '), rental.from, rental.to, rental.sum, percent, amount, nowIso());
        if (!info.changes) continue;
        if (!fresh.has(s.id)) fresh.set(s.id, []);
        fresh.get(s.id).push({ ...rental, amount });
      }
    }
  }
  db.setSetting('agent_commissions_init', '1');
  let count = 0;
  for (const [sourceId, list] of fresh) {
    count += list.length;
    const total = list.reduce((sum, x) => sum + x.amount, 0);
    console.log(`Agent source #${sourceId}: commission accrued for ${list.length} rental(s), ${total} THB${silent ? ' (first run, no notice)' : ''}`);
    if (silent) continue;
    await notifyAgents(sourceId, (lang) => ({
      text: [tx(lang, 'accrued', { total: baht(total) }), ...list.slice(0, 10).map((x) => tx(lang, 'accruedLine', {
        model: escapeHtml(x.model || '—'), from: dm(x.from), to: dm(x.to), sum: baht(x.sum), amount: baht(x.amount)
      }))].join('\n'),
      subject: tx(lang, 'subjectAccrued', { total: baht(total) })
    }));
  }
  return count;
}

export function startAgents() {
  const run = () => accrueCommissions().catch((err) => console.error('Agent commissions failed:', err.message));
  setTimeout(run, 2 * 60 * 1000).unref();
  setInterval(run, ACCRUE_EVERY_MS).unref();
}

/* ----------------------------------------------------------------- Кабинет */

/** Какой источник смотрит сотрудник: свой (агент) или выбранный (просмотр админом) */
function cabinetSource(staff, url) {
  const asked = Number(url?.searchParams?.get('source')) || 0;
  if (asked && (can(staff, 'marketing.view') || can(staff, 'access.admin'))) {
    const s = sourceById(asked);
    if (!s) throw new HttpError(404, 'unknown_source');
    return { source: s, preview: true };
  }
  // Кабинет — у любого сотрудника, которого админ привязал к источнику (агент, менеджер-агент)
  if (!staff.sourceId) throw new HttpError(403, 'no_cabinet');
  const s = sourceById(staff.sourceId);
  if (!s) throw new HttpError(404, 'unknown_source');
  return { source: s, preview: false };
}

function balanceOf(sourceId) {
  const accruals = q.accruals.all(sourceId);
  const payouts = q.payouts.all(sourceId);
  const accrued = accruals.reduce((sum, a) => sum + a.amount, 0);
  const paid = payouts.reduce((sum, p) => sum + p.amount, 0);
  return { accruals, payouts, accrued: round(accrued), paid: round(paid), balance: round(accrued - paid) };
}

/** Цены для клиентов: все сезоны, по моделям (без особых цен отдельных машин) */
async function pricesForAgent() {
  if (!priceActive()) return null;
  try {
    const { units, catalog } = await getFleet();
    const view = priceView(units, (model) => catalog.get(model)?.type || null, plateKey);
    const md = todayIso().slice(5);
    const current = listSeasons().find((s) => s.periods.some((p) => (p.from <= p.to ? p.from <= md && md <= p.to : md >= p.from || md <= p.to)));
    return {
      tiers: TIER_LABELS,
      currentSeason: current?.id ?? null,
      seasons: view.seasons.map((s) => ({ id: s.id, name: s.name, color: s.color, periods: s.periods })),
      models: view.models.filter((m) => !m.noUnits && Object.values(m.rates).some(Boolean)).map((m) => ({
        model: m.model, type: m.type,
        rates: Object.fromEntries(Object.entries(m.rates).filter(([, r]) => r).map(([id, r]) => [id, { tiers: r.tiers, deposit: r.deposit }]))
      }))
    };
  } catch (err) {
    console.error('Agent prices failed:', err.message);
    return null;
  }
}

export async function agentCabinet(staff, req, res, url) {
  const { source: s, preview } = cabinetSource(staff, url);
  const lang = String(url.searchParams.get('lang') || '');
  if (!preview && TEXTS[lang]) db.setSetting(`agent_lang:${staff.email}`, lang);

  let rentals = new Map();
  try {
    rentals = await requestRentals();
  } catch (err) {
    console.error('Agent cabinet rentals failed:', err.message);
  }
  const { accruals, payouts, accrued, paid, balance } = balanceOf(s.id);
  const accruedKeys = new Set(accruals.map((a) => a.key));
  const percent = percentOf(s);
  let pending = 0;
  const requests = q.requests.all(s.code).map((r) => {
    const x = rentals.get(r.id) || { booked: false, rentals: [] };
    const list = x.rentals.map((rental) => {
      const done = accruedKeys.has(`${s.id}|${rental.key}`);
      const amount = round((rental.sum * percent) / 100);
      if (!done && !rental.ended) pending += amount;
      return { model: rental.model, from: rental.from, to: rental.to, sum: rental.sum, active: rental.active, ended: rental.ended, accrued: done, commission: amount };
    });
    const stage = list.length ? 'rental' : x.booked ? 'booked' : r.status === 'taken' ? 'taken' : 'new';
    return {
      id: r.id, createdAt: r.created_at, channel: r.channel, clientName: r.client_name || '', phoneTail: phoneTail(r.client_phone),
      vehicleType: r.vehicle_type, model: r.model, dateFrom: r.date_from, dateTo: r.date_to,
      stage, takenBy: r.status === 'taken' ? r.taken_by_name : null, rentals: list
    };
  });
  const since30 = new Date(Date.now() - 30 * DAY_MS + 7 * 3600000).toISOString().slice(0, 10);
  sendJson(res, 200, {
    preview,
    canPay: preview && can(staff, 'marketing.edit'),
    canRequest: !preview,
    agents: preview ? agentsOfSource(s.id).map((a) => ({ name: a.name, email: a.email, telegram: Boolean(a.telegramId) })) : undefined,
    source: { id: s.id, name: s.name, kind: s.kind, code: s.code, active: s.active },
    links: sourceLinks(s),
    visits: { days30: q.visits.get(s.code, since30).n, total: q.visits.get(s.code, '0000-00-00').n },
    commission: { percent, accrued, paid, balance, pending: round(pending) },
    accruals: accruals.map((a) => ({ requestId: a.request_id, model: a.model, from: a.date_from, to: a.date_to, sum: a.sum, percent: a.percent, amount: a.amount, at: a.accrued_at })),
    payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, date: p.paid_on, method: p.method || '', note: p.note || '', by: p.by_name || p.by_email || '' })),
    requests,
    prices: await pricesForAgent()
  });
}

/** POST …/agent/request { name, phone, type, model, from, to, comment } — заявка от агента */
export async function agentRequest(staff, req, res, url) {
  const { source: s, preview } = cabinetSource(staff, url);
  if (preview) throw new HttpError(403, 'preview_only');
  const body = await readJson(req);
  const name = clean(body.name, 80);
  const phone = clean(body.phone, 30);
  const digits = phone.replace(/\D/g, '');
  const type = body.type ? String(body.type) : null;
  const model = clean(body.model, 80) || null;
  const comment = clean(body.comment, 1000);
  if (!name) throw new HttpError(400, 'name_required');
  if (digits.length < 7 || digits.length > 15) throw new HttpError(400, 'invalid_phone');
  if (type && !VEHICLE_TYPES[type]) throw new HttpError(400, 'invalid_type');
  const hasDates = Boolean(body.from || body.to);
  if (hasDates) {
    if (!isIsoDate(body.from) || !isIsoDate(body.to)) throw new HttpError(400, 'invalid_dates');
    if (body.from < todayIso()) throw new HttpError(400, 'date_past');
    const days = Math.round((Date.parse(body.to) - Date.parse(body.from)) / DAY_MS);
    if (days < 1) throw new HttpError(400, 'date_order');
    if (days > MAX_RENTAL_DAYS) throw new HttpError(400, 'too_long');
  }
  if (!type && !model && !hasDates && !comment) throw new HttpError(400, 'message_required');
  if (!requestLimiter.hit(staff.email)) throw new HttpError(429, 'too_many_requests');

  const request = db.createRequest({
    channel: 'agent',
    clientName: name,
    clientPhone: phone,
    vehicleType: type,
    dateFrom: hasDates ? body.from : null,
    dateTo: hasDates ? body.to : null,
    model,
    comment: [`🤝 ${staff.name || staff.email} (${s.name})`, comment].filter(Boolean).join('\n'),
    sourceRef: s.code
  });
  console.log(`Request #${request.id} from agent ${staff.email} (source ${s.code})`);
  await publishRequest(request);
  sendJson(res, 200, { ok: true, id: request.id });
}

/** POST …/agent/payout { sourceId, amount, date, method, note } — только «Маркетинг: меняет» */
export async function agentPayout(staff, req, res) {
  if (!can(staff, 'marketing.edit')) throw new HttpError(403, 'read_only');
  const body = await readJson(req);
  const s = sourceById(body.sourceId);
  if (!s) throw new HttpError(404, 'unknown_source');
  const amount = round(String(body.amount ?? '').replace(/[\s,]/g, ''));
  if (!(amount > 0) || amount > 10000000) throw new HttpError(400, 'bad_amount');
  const date = isIsoDate(body.date) ? body.date : todayIso();
  q.addPayout.run(s.id, amount, date, clean(body.method, 60) || null, clean(body.note, 300) || null, staff.email, staff.name || staff.email, nowIso());
  console.log(`Agent payout ${amount} THB to source #${s.id} by ${staff.email}`);
  const { balance } = balanceOf(s.id);
  notifyAgents(s.id, (lang) => ({
    text: tx(lang, 'payout', { amount: baht(amount), date: dm(date), balance: baht(balance) }),
    subject: tx(lang, 'subjectPayout', { amount: baht(amount) })
  })).catch((err) => console.error('Agent payout notice failed:', err.message));
  sendJson(res, 200, { ok: true });
}

export async function agentPayoutDelete(staff, req, res) {
  if (!can(staff, 'marketing.edit')) throw new HttpError(403, 'read_only');
  const { id } = await readJson(req);
  const row = q.payout.get(Number(id) || 0);
  if (!row) throw new HttpError(404, 'unknown_payout');
  q.deletePayout.run(row.id);
  console.log(`Agent payout #${row.id} (${row.amount} THB, source #${row.source_id}) deleted by ${staff.email}`);
  sendJson(res, 200, { ok: true });
}
