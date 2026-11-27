/**
 * ============================================================================
 * Кабинет инвестора
 * ============================================================================
 * Инвестор — сотрудник портала, у которого в «Доступах» указана доля, % от
 * прибыли его машин (роль любая: «Инвестор» — только кабинет; или, например,
 * менеджер и инвестор сразу). Чьи машины — поле «Инвестор» в карточке техники
 * («Парк»); там же можно задать особую долю для одной машины.
 *
 * Условия (утвердил владелец):
 *   - доля = % от прибыли машины: выручка − ремонт − прочие расходы − платёж по
 *     кредиту (если машина в кредите) — те же цифры, что во вкладке «Финансы»;
 *   - начисляется за закрытый месяц, 1-го числа за прошлый (и запоминается);
 *     текущий месяц — «ожидается»;
 *   - инвестор видит каждый расход (дата, сумма, что сделали) и аренды —
 *     только даты и суммы, без клиентов;
 *   - выплаты записывают владелец и админ; инвестору — уведомление
 *     (Telegram, иначе письмо) о начислении и о выплате.
 *
 *   GET  /api/staff/investor?month=&staff=&lang=  — кабинет (staff — просмотр владельцем/админом)
 *   POST /api/staff/investor/payout          { staffId, amount, date, method, note }
 *   POST /api/staff/investor/payout/delete   { id }
 * ============================================================================
 */

import * as db from './db.js';
import { config } from './config.js';
import { HttpError, sendJson, readJson } from './http.js';
import { can } from './roles.js';
import { investors, staffById } from './access.js';
import { listVehicles } from './fleetStore.js';
import { financeReport } from './finance.js';
import { rentalsByPlate } from './crm.js';
import { getPortalSnapshot, plateKey } from './fleet.js';
import { isSold } from './sold.js';
import { telegramEnabled, sendMessage } from './telegram/api.js';
import { mailEnabled, sendMail } from './mail.js';
import { escapeHtml } from './format.js';
import { groupLang } from './groupTexts.js';

const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;
const ACCRUE_EVERY_MS = 3 * 3600000;
const REPORT_CACHE_MS = 5 * 60000;

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS investor_accruals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id  INTEGER NOT NULL,
    month     TEXT NOT NULL,
    plate     TEXT NOT NULL,
    model     TEXT,
    revenue   REAL NOT NULL,
    repair    REAL NOT NULL,
    other     REAL NOT NULL,
    loan      REAL NOT NULL,
    profit    REAL NOT NULL,
    percent   REAL NOT NULL,
    amount    REAL NOT NULL,
    at        TEXT NOT NULL,
    UNIQUE (staff_id, month, plate)
  );
  CREATE TABLE IF NOT EXISTS investor_payouts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id   INTEGER NOT NULL,
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
  accruals: db.raw.prepare('SELECT * FROM investor_accruals WHERE staff_id = ? ORDER BY month DESC, plate'),
  monthRows: db.raw.prepare('SELECT * FROM investor_accruals WHERE staff_id = ? AND month = ?'),
  addAccrual: db.raw.prepare(`INSERT OR IGNORE INTO investor_accruals (staff_id, month, plate, model, revenue, repair, other, loan, profit, percent, amount, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  payouts: db.raw.prepare('SELECT * FROM investor_payouts WHERE staff_id = ? ORDER BY paid_on DESC, id DESC'),
  payout: db.raw.prepare('SELECT * FROM investor_payouts WHERE id = ?'),
  addPayout: db.raw.prepare(`INSERT INTO investor_payouts (staff_id, amount, paid_on, method, note, by_email, by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  deletePayout: db.raw.prepare('DELETE FROM investor_payouts WHERE id = ?')
};

const round = (n) => Math.round(Number(n) || 0);
const monthOf = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 7);
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const nextMonth = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7);
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/* ------------------------------------------------------------------ Тексты */

const TEXTS = {
  ru: {
    accrued: '💰 <b>Начислено за {month}: {total}</b>', line: '• {car}: прибыль {profit}, ваша доля {pct}% — {amount}',
    payout: '💸 <b>Записана выплата {amount}</b> ({date}). Остаток к выплате: {balance}.',
    subjectAccrued: 'Начислено за {month}: {total}', subjectPayout: 'Выплата {amount}', link: '👉 Ваш кабинет: {url}'
  },
  en: {
    accrued: '💰 <b>Accrued for {month}: {total}</b>', line: '• {car}: profit {profit}, your share {pct}% — {amount}',
    payout: '💸 <b>Payout recorded: {amount}</b> ({date}). Balance to pay: {balance}.',
    subjectAccrued: 'Accrued for {month}: {total}', subjectPayout: 'Payout {amount}', link: '👉 Your cabinet: {url}'
  },
  th: {
    accrued: '💰 <b>ยอดสำหรับ {month}: {total}</b>', line: '• {car}: กำไร {profit}, ส่วนของคุณ {pct}% — {amount}',
    payout: '💸 <b>บันทึกการจ่ายเงิน {amount}</b> ({date}) ยอดคงเหลือ: {balance}',
    subjectAccrued: 'ยอดสำหรับ {month}: {total}', subjectPayout: 'จ่ายเงิน {amount}', link: '👉 หน้าของคุณ: {url}'
  }
};
// Язык уведомлений — тот, что инвестор выбрал в портале; пока не заходил — язык рабочей группы
const langOf = (email) => { const l = db.getSetting(`investor_lang:${email}`); return TEXTS[l] ? l : TEXTS[groupLang] ? groupLang : 'en'; };
const tx = (lang, key, params = {}) => String(TEXTS[lang]?.[key] ?? TEXTS.en[key]).replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
const baht = (n) => `${new Intl.NumberFormat('en-US').format(round(n))} ฿`;
const monthName = (m, lang) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString({ ru: 'ru-RU', th: 'th-TH' }[lang] || 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

async function notify(staffId, build) {
  const person = staffById(staffId);
  if (!person) return;
  const lang = langOf(person.email);
  const { text, subject } = build(lang);
  const body = `${text}\n\n${tx(lang, 'link', { url: `${config.staff.url}/#invest` })}`;
  if (telegramEnabled && person.telegramId) {
    try {
      await sendMessage(person.telegramId, body, { disable_web_page_preview: true });
      return;
    } catch (err) {
      console.error(`Investor notice to ${person.email || person.name} via Telegram failed (${err.message})`);
    }
  }
  if (!mailEnabled || !person.email) return;
  const plain = body.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  await sendMail({ to: person.email, subject, text: plain }).catch((err) => console.error(`Investor mail to ${person.email} failed:`, err.message));
}

/* --------------------------------------------------------- Расчёт по месяцу */

const reports = new Map();
async function monthReport(month) {
  const hit = reports.get(month);
  if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.report;
  const report = await financeReport({ from: `${month}-01`, to: lastDay(month) });
  reports.set(month, { at: Date.now(), report });
  return report;
}

const vehiclesOf = (staffId) => listVehicles().filter((v) => v.investorId === Number(staffId));
const nameOf = (v) => v.clientModel || `${v.brand} ${v.model}`.trim();

/** Машины инвестора за месяц: выручка, загрузка, расходы (по статьям), кредит, прибыль, доля */
async function monthRows(person, month) {
  const report = await monthReport(month);
  const byPlate = new Map((report.vehicles || []).map((r) => [r.plate, r]));
  return vehiclesOf(person.id).map((v) => {
    const r = byPlate.get(plateKey(v.plate)) || {};
    const revenue = round(r.revenue);
    const repair = round(r.repair);
    const other = round(r.otherCosts);
    const loan = round(r.loan);
    const profit = revenue - repair - other - loan;
    const percent = v.investorPercent ?? person.investorPercent ?? 0;
    return {
      vehicleId: v.id, plate: v.plate, model: nameOf(v), type: v.type, sold: isSold(v.plate),
      revenue, repair, other, loan, profit, percent, amount: round((profit * percent) / 100),
      rentedDays: r.rentedDays || 0, utilization: r.utilization || 0,
      costItems: (r.costItems || []).map((x) => ({ at: x.at, sum: x.sum, kind: x.kind, text: x.text }))
    };
  });
}

/* ----------------------------------------------------- Начисление за месяц */

let accruing = null;
export function accrueInvestors(now = Date.now()) {
  if (!accruing) accruing = doAccrue(now).finally(() => { accruing = null; });
  return accruing;
}

async function doAccrue(now) {
  const current = monthOf(now);
  let count = 0;
  for (const person of investors()) {
    let month = isMonth(person.investorSince) ? person.investorSince : current;
    for (; month < current; month = nextMonth(month)) {
      if (db.getSetting(`inv_acc:${person.id}:${month}`) === '1') continue;
      const rows = await monthRows(person, month);
      const at = new Date().toISOString();
      for (const r of rows) {
        q.addAccrual.run(person.id, month, plateKey(r.plate), r.model, r.revenue, r.repair, r.other, r.loan, r.profit, r.percent, r.amount, at);
      }
      db.setSetting(`inv_acc:${person.id}:${month}`, '1');
      count++;
      const total = rows.reduce((s, r) => s + r.amount, 0);
      console.log(`Investor #${person.id}: ${month} accrued ${total} THB for ${rows.length} vehicle(s)`);
      if (!rows.length) continue;
      await notify(person.id, (lang) => ({
        text: [tx(lang, 'accrued', { month: monthName(month, lang), total: baht(total) }), ...rows.slice(0, 15).map((r) => tx(lang, 'line', {
          car: escapeHtml(`${r.model} #${r.plate}`), profit: baht(r.profit), pct: r.percent, amount: baht(r.amount)
        }))].join('\n'),
        subject: tx(lang, 'subjectAccrued', { month: monthName(month, lang), total: baht(total) })
      }));
    }
  }
  return count;
}

export function startInvestors() {
  const run = () => accrueInvestors().catch((err) => console.error('Investor accrual failed:', err.message));
  setTimeout(run, 3 * 60 * 1000).unref();
  setInterval(run, ACCRUE_EVERY_MS).unref();
}

/* ---------------------------------------------------------------- Кабинет */

const canManage = (staff) => can(staff, 'fleet.edit');

function cabinetPerson(staff, url) {
  const asked = Number(url?.searchParams?.get('staff')) || 0;
  if (asked && canManage(staff)) {
    const person = staffById(asked);
    if (!person || person.investorPercent === null) throw new HttpError(404, 'unknown_investor');
    return { person, preview: true };
  }
  if (!staff.staffId || staff.investorPercent === null || staff.investorPercent === undefined) throw new HttpError(403, 'no_cabinet');
  const person = staffById(staff.staffId);
  if (!person || person.investorPercent === null) throw new HttpError(403, 'no_cabinet');
  return { person, preview: false };
}

function balanceOf(staffId) {
  const accruals = q.accruals.all(staffId);
  const payouts = q.payouts.all(staffId);
  const accrued = accruals.reduce((s, a) => s + a.amount, 0);
  const paid = payouts.reduce((s, p) => s + p.amount, 0);
  return { accruals, payouts, accrued: round(accrued), paid: round(paid), balance: round(accrued - paid) };
}

export async function investorCabinet(staff, req, res, url) {
  const { person, preview } = cabinetPerson(staff, url);
  const lang = String(url.searchParams.get('lang') || '');
  if (!preview && TEXTS[lang]) db.setSetting(`investor_lang:${person.email}`, lang);
  const now = Date.now();
  const current = monthOf(now);
  const since = isMonth(person.investorSince) ? person.investorSince : current;
  const months = [];
  // Месяцы для выбора: с начала работы (но не больше двух лет), новые — первыми
  for (let m = since < monthOf(now - 730 * DAY_MS) ? monthOf(now - 730 * DAY_MS) : since; m <= current; m = nextMonth(m)) months.unshift(m);
  const asked = url.searchParams.get('month');
  const month = isMonth(asked) && months.includes(asked) ? asked : current;

  const { accruals, payouts, accrued, paid, balance } = balanceOf(person.id);
  const stored = new Map(q.monthRows.all(person.id, month).map((r) => [r.plate, r]));
  let rows = await monthRows(person, month);
  // Закрытый начисленный месяц — суммы как начислили (дальше не пересчитываем), расходы и аренды — для справки
  const closed = month < current && stored.size > 0;
  if (closed) {
    rows = rows.map((r) => {
      const s = stored.get(plateKey(r.plate));
      return s ? { ...r, revenue: s.revenue, repair: s.repair, other: s.other, loan: s.loan, profit: s.profit, percent: s.percent, amount: s.amount } : r;
    });
  }
  // Аренды за месяц — только даты и суммы
  let rentals = new Map();
  try { rentals = await rentalsByPlate(now); } catch (err) { console.error('Investor rentals failed:', err.message); }
  const monthStart = `${month}-01`;
  const monthEnd = lastDay(month);
  rows = rows.map((r) => ({
    ...r,
    rentals: (rentals.get(plateKey(r.plate)) || []).filter((x) => x.from <= monthEnd && (x.to || x.from) >= monthStart).slice(0, 30)
  }));
  // Сейчас: статус и занятость — из портала
  let portal = null;
  try { portal = await getPortalSnapshot(); } catch { /* без статусов */ }
  const carNow = new Map((portal?.cars || []).map((c) => [plateKey(c.plate), c]));
  const fleetNow = vehiclesOf(person.id).filter((v) => !isSold(v.plate)).map((v) => {
    const c = carNow.get(plateKey(v.plate));
    return { plate: v.plate, model: nameOf(v), type: v.type, status: c?.status || 'free', freeFrom: c?.freeFrom || null, until: c?.until || null, freeWeek: c?.freeWeek ?? true, nextBooking: c?.nextBooking || null };
  });
  // «Ожидается за текущий месяц» — видно всегда, какой бы месяц ни смотрели
  const expected = month === current ? rows.reduce((s, r) => s + r.amount, 0)
    : (await monthRows(person, current)).reduce((s, r) => s + r.amount, 0);
  const byMonth = new Map();
  for (const a of accruals) byMonth.set(a.month, (byMonth.get(a.month) || 0) + a.amount);
  sendJson(res, 200, {
    preview, canPay: preview && canManage(staff),
    investor: { id: person.id, name: person.name, percent: person.investorPercent, since },
    months, month, closed, current,
    fleet: fleetNow,
    rows,
    totals: ['revenue', 'repair', 'other', 'loan', 'profit', 'amount'].reduce((t, k) => ({ ...t, [k]: rows.reduce((s, r) => s + r[k], 0) }), {}),
    money: { accrued, paid, balance, expected: expected === null ? null : round(expected) },
    history: [...byMonth].map(([m, amount]) => ({ month: m, amount: round(amount) })),
    payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, date: p.paid_on, method: p.method || '', note: p.note || '', by: p.by_name || p.by_email || '' }))
  });
}

/** Список инвесторов — владельцу и админу (выбор в карточке техники, просмотр кабинетов) */
export const investorList = () => investors().map((p) => ({ id: p.id, name: p.name, percent: p.investorPercent }));

export async function investorPayout(staff, req, res) {
  if (!canManage(staff)) throw new HttpError(403, 'read_only');
  const body = await readJson(req);
  const person = staffById(body.staffId);
  if (!person || person.investorPercent === null) throw new HttpError(404, 'unknown_investor');
  const amount = round(String(body.amount ?? '').replace(/[\s,]/g, ''));
  if (!(amount > 0) || amount > 100000000) throw new HttpError(400, 'bad_amount');
  const date = isIso(body.date) ? body.date : new Date(Date.now() + BANGKOK_MS).toISOString().slice(0, 10);
  q.addPayout.run(person.id, amount, date, clean(body.method, 60) || null, clean(body.note, 300) || null, staff.email, staff.name || staff.email, new Date().toISOString());
  console.log(`Investor payout ${amount} THB to #${person.id} by ${staff.email}`);
  const { balance } = balanceOf(person.id);
  notify(person.id, (lang) => ({
    text: tx(lang, 'payout', { amount: baht(amount), date: `${date.slice(8, 10)}.${date.slice(5, 7)}`, balance: baht(balance) }),
    subject: tx(lang, 'subjectPayout', { amount: baht(amount) })
  })).catch((err) => console.error('Investor payout notice failed:', err.message));
  sendJson(res, 200, { ok: true });
}

export async function investorPayoutDelete(staff, req, res) {
  if (!canManage(staff)) throw new HttpError(403, 'read_only');
  const { id } = await readJson(req);
  const row = q.payout.get(Number(id) || 0);
  if (!row) throw new HttpError(404, 'unknown_payout');
  q.deletePayout.run(row.id);
  console.log(`Investor payout #${row.id} (${row.amount} THB) deleted by ${staff.email}`);
  sendJson(res, 200, { ok: true });
}
