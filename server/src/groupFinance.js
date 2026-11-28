/**
 * ============================================================================
 * «Касса по сообщениям группы» (ИИ) — тест перед кабинетом финансиста
 * ============================================================================
 * Наблюдатель кладёт сообщения рабочей группы в wa_messages. Здесь раз в
 * полминуты отбираем те, что похожи на деньги (сдача кассы, закрытие дня,
 * расходы, залоги, оплаты, выплаты — и отчёты о выдаче/возврате с суммами),
 * и ИИ раскладывает каждое на движения «откуда → куда» (ai/groupFinance.js).
 * Деньги из «＋ Операция» берём из портала как есть (в группе они с меткой
 * [portal …] и ИИ не нужны).
 *
 * Из движений считаем остатки: операционный сейф, залоговый сейф, наличные у
 * каждого сотрудника. «Закрытие дня» — снимок: ставит остаток и показывает,
 * насколько он разошёлся с посчитанным. Ошибочную запись финансист отмечает
 * «не учитывать». В общие цифры «Финансов» пока не входит — копим данные.
 * Наблюдатель по-прежнему ничего не пишет в группу.
 * ============================================================================
 */

import * as db from './db.js';
import { HttpError, sendJson, readJson } from './http.js';
import { can } from './roles.js';
import { activeStaff, getRole, ADMIN_ROLE } from './access.js';
import { staffPhones } from './staffUsers.js';
import { lidPhones } from './journal/journal.js';
import { currentRates } from './finance.js';
import { aiSettings } from './itSettings.js';
import { readGroupFinance } from './ai/groupFinance.js';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS fin_ai (
    message_id TEXT PRIMARY KEY,
    ts         TEXT NOT NULL,
    author     TEXT,
    author_name TEXT,
    who        TEXT,
    kind       TEXT,
    text       TEXT,
    status     TEXT NOT NULL,
    result     TEXT,
    model      TEXT,
    usd        REAL,
    error      TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    ignored_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fin_ai_ts ON fin_ai (ts);
  CREATE INDEX IF NOT EXISTS fin_ai_status ON fin_ai (status);
`);

const SCAN_MS = 30 * 1000;
const BACKFILL_DAYS = 3;
const MAX_ATTEMPTS = 3;
const PER_TICK = 3;
const SHIFT_KINDS = ['shift_start', 'shift_end', 'media'];
const MONEY_KINDS = ['booking', 'issue', 'extension', 'payment', 'return', 'changed', 'pickup_task'];
// Похоже на деньги: число + денежное слово (или отчёт об операции)
const MONEY_WORDS = /(касс|сейф|сдал|сдаю|сдач|налич|\bнал\b|перев[оеё]д|перевел|перевёл|залог|депозит|deposit|cash|оплат|опл\b|бат|baht|thb|฿|\$|usdt|руб|расход|приход|закры|итог|остат|выдал|забрал|получил|отдал|взял|зарплат|\bзп\b|аванс|долг|вернул|возврат|чек|купил|заплатил|бенз|топлив|мойк|ремонт|expense|hand ?over|paid|\bpay|transfer|salary|refund|balance|total|เงิน|บาท|มัดจำ|ค่า)/i;
const HAS_NUMBER = /\d[\d\s.,]*\d|\d+\s*[kк]\b|\b\d{2,}\b/i;

const q = {
  candidates: db.raw.prepare(`SELECT m.id, m.ts, m.author, m.author_name, m.text, m.kind, m.quoted_id, f.text AS seen_text, f.status AS seen_status
    FROM wa_messages m LEFT JOIN fin_ai f ON f.message_id = m.id
    WHERE m.ts >= ? AND m.status != 'ignored' AND (f.message_id IS NULL OR (f.text IS NOT m.text AND f.status != 'ignored'))
    ORDER BY m.ts LIMIT 400`),
  quoted: db.raw.prepare('SELECT text FROM wa_messages WHERE id = ?'),
  upsert: db.raw.prepare(`INSERT INTO fin_ai (message_id, ts, author, author_name, who, kind, text, status, created_at, updated_at)
    VALUES (@id, @ts, @author, @author_name, @who, @kind, @text, @status, @now, @now)
    ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, kind = excluded.kind, who = excluded.who, status = excluded.status,
      result = NULL, error = NULL, attempts = 0, updated_at = excluded.updated_at`),
  queued: db.raw.prepare("SELECT * FROM fin_ai WHERE status = 'queued' ORDER BY ts LIMIT ?"),
  done: db.raw.prepare("UPDATE fin_ai SET status = 'done', result = ?, model = ?, usd = ?, error = NULL, updated_at = ? WHERE message_id = ?"),
  failed: db.raw.prepare('UPDATE fin_ai SET status = ?, error = ?, attempts = attempts + 1, updated_at = ? WHERE message_id = ?'),
  one: db.raw.prepare('SELECT * FROM fin_ai WHERE message_id = ?'),
  ignore: db.raw.prepare("UPDATE fin_ai SET status = ?, ignored_by = ?, updated_at = ? WHERE message_id = ? AND status IN ('done', 'ignored')"),
  retry: db.raw.prepare("UPDATE fin_ai SET status = 'queued', attempts = 0, error = NULL, result = NULL, updated_at = ? WHERE message_id = ?"),
  ledger: db.raw.prepare("SELECT * FROM fin_ai WHERE status = 'done' AND ts >= ? ORDER BY ts"),
  log: db.raw.prepare("SELECT * FROM fin_ai WHERE status != 'skip' AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 400"),
  counts: db.raw.prepare("SELECT status, COUNT(*) n, SUM(COALESCE(usd, 0)) usd FROM fin_ai WHERE ts >= ? GROUP BY status"),
  moves: db.raw.prepare('SELECT id, at, dir, kind, category, amount, currency, thb, method, plate, party, note, by_name, by_email FROM cash_moves WHERE deleted_at IS NULL AND at >= ? ORDER BY at'),
  expenses: db.raw.prepare('SELECT id, created_at, date, thb, category, method, vendor, note, plate, by_name, by_email FROM expenses WHERE deleted_at IS NULL AND created_at >= ? ORDER BY created_at')
};

/** С какого момента читаем группу (первый запуск — за последние 3 дня) */
function since() {
  let v = db.getSetting('fin_ai_since');
  if (!v) { v = new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString(); db.setSetting('fin_ai_since', v); }
  return v;
}

export function looksLikeMoney(row) {
  const text = String(row.text || '');
  if (!text.trim() || text.includes('[portal ') || SHIFT_KINDS.includes(row.kind)) return false;
  if (MONEY_KINDS.includes(row.kind)) return HAS_NUMBER.test(text);
  return HAS_NUMBER.test(text) && MONEY_WORDS.test(text);
}

/* ------------------------------------------------------------ Кто есть кто */

const low = (s) => String(s || '').trim().toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');
async function people() {
  const list = activeStaff().filter((s) => s.active !== false);
  const phones = await staffPhones();
  const lids = lidPhones();
  const byPhone = new Map();
  for (const s of list) for (const p of String(s.whatsapp || '').split(/[,;\s]+/).map(digits).filter((x) => x.length >= 8)) byPhone.set(p, s);
  const roleName = (s) => (s.roleId === ADMIN_ROLE ? 'админ' : getRole(s.roleId)?.name || '');
  const nameOf = (author, authorName) => {
    const phone = digits(lids[author] || author);
    const s = byPhone.get(phone);
    if (s && /\p{L}/u.test(s.name)) return { name: s.name, role: roleName(s) };
    const fromPhones = phones.get(phone);
    return { name: fromPhones || authorName || (phone ? `+${phone}` : String(author || '—')), role: s ? roleName(s) : '' };
  };
  const names = list.filter((s) => /\p{L}/u.test(s.name) && !['investor', 'agent'].includes(s.roleId)).map((s) => ({ name: s.name, role: roleName(s) }));
  return { nameOf, names };
}

/* ------------------------------------------------------------ Очередь и ИИ */

let busy = false;
let blocked = null; // нет ключа / лимит — показать в «Финансах»
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = new Date().toISOString();
    const { nameOf, names } = await people();
    for (const row of q.candidates.all(since())) {
      const money = looksLikeMoney(row);
      // Уже разобранное и всё ещё «про деньги» — переразбираем только при правке текста; «не деньги» просто запоминаем
      q.upsert.run({ id: row.id, ts: row.ts, author: row.author, author_name: row.author_name, who: nameOf(row.author, row.author_name).name,
        kind: row.kind, text: row.text || '', status: money ? 'queued' : 'skip', now });
    }
    // Модель: для текста хватает Sonnet (в разы дешевле Opus); Haiku — если её выбрали в «Настройках»
    const chosen = aiSettings().model;
    const model = chosen === 'claude-opus-5-5' ? 'claude-sonnet-5-5' : chosen;
    for (const row of q.queued.all(PER_TICK)) {
      const who = nameOf(row.author, row.author_name);
      const msg = db.raw.prepare('SELECT quoted_id FROM wa_messages WHERE id = ?').get(row.message_id);
      const quoted = msg?.quoted_id ? q.quoted.get(msg.quoted_id)?.text : null;
      const at = new Date(Date.parse(row.ts) + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
      try {
        const out = await readGroupFinance({ text: row.text, author: who.name, authorRole: who.role, at, kind: row.kind, quoted, staffList: names, model });
        q.done.run(JSON.stringify(out.result), out.model, out.usd, new Date().toISOString(), row.message_id);
        blocked = null;
      } catch (err) {
        const code = err.code || 'ai_failed';
        if (code === 'ai_no_key' || code === 'ai_limit') { blocked = code; break; }
        const attempts = (row.attempts || 0) + 1;
        q.failed.run(attempts >= MAX_ATTEMPTS ? 'error' : 'queued', code, new Date().toISOString(), row.message_id);
        console.error(`Group finance AI failed for ${row.message_id}: ${code}`);
      }
    }
  } catch (err) {
    console.error('Group finance scan failed:', err.message);
  } finally {
    busy = false;
  }
}

export function startGroupFinance() {
  since();
  setTimeout(() => { tick(); setInterval(tick, SCAN_MS).unref(); }, 15000).unref();
}

/* ------------------------------------------------------------ Остатки и журнал */

const ACC_RU = { op: 'операционный сейф', dep: 'залоговый сейф', client: 'клиент', owner: 'владелец', bank: 'банк / перевод', expense: 'расход', unknown: '?' };
const PURPOSE_RU = { rent: 'аренда', deposit: 'залог', deposit_return: 'возврат залога', extras: 'доп. услуги', damage: 'ущерб', handover: 'сдача кассы',
  expense: 'расход', salary: 'зарплата', owner: 'владельцу', transfer: 'передача', refund: 'возврат', exchange: 'обмен', other: 'прочее' };
const number = (v) => { const n = Number(String(v || '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };

function canonicalName(name, staffNames) {
  const n = low(name);
  if (!n) return null;
  const exact = staffNames.find((s) => low(s) === n);
  if (exact) return exact;
  const first = staffNames.find((s) => low(s).split(/\s+/)[0] === n.split(/\s+/)[0]);
  return first || String(name).trim();
}

/** Все движения (ИИ + «＋ Операция») с момента since(), по времени */
function allMoves(staffNames, rates) {
  const thbOf = (amount, currency) => {
    const c = String(currency || 'THB').toUpperCase();
    const r = rates[c] ?? (c === 'THB' || c === '' ? 1 : null);
    return r === null ? null : Math.round(number(amount) * r);
  };
  const acc = (type, name, who) => (type === 'staff' ? { type, name: canonicalName(name || who, staffNames) || who } : { type, name: null });
  const items = [];
  for (const row of q.ledger.all(since())) {
    let r;
    try { r = JSON.parse(row.result || '{}'); } catch { continue; }
    if (!r.relevant) continue;
    for (const m of r.moves || []) {
      const thb = thbOf(m.amount, m.currency);
      if (!thb) continue;
      items.push({ at: row.ts, src: row.message_id, from: acc(m.from, m.fromName, row.who), to: acc(m.to, m.toName, row.who), thb, purpose: m.purpose, method: m.method, category: m.category, note: m.note });
    }
    for (const b of r.balances || []) {
      const thb = thbOf(b.amount, b.currency);
      if (thb === null) continue;
      items.push({ at: row.ts, src: row.message_id, balance: acc(b.account, b.name, row.who), thb });
    }
  }
  // «＋ Операция»: деньги внесены в портале — без ИИ
  for (const m of q.moves.all(since())) {
    const who = { type: 'staff', name: canonicalName(m.by_name, staffNames) || m.by_name || m.by_email };
    const cash = m.method === 'cash';
    if (m.dir === 'in') {
      items.push({ at: m.at, src: `pm${m.id}`, portal: true, from: { type: 'client', name: null }, to: cash ? who : { type: 'bank', name: null }, thb: Math.round(m.thb || 0),
        purpose: m.kind === 'extension' ? 'rent' : m.category === 'deposit' ? 'deposit' : ['rent', 'extras', 'damage'].includes(m.category) ? m.category : 'other', method: m.method, note: m.note || '' });
    } else {
      const to = m.kind === 'deposit_refund' ? { type: 'client', name: null }
        : m.category === 'salary' && m.party ? { type: 'staff', name: canonicalName(m.party, staffNames) || m.party }
          : m.category === 'owners' ? { type: 'owner', name: null } : { type: 'expense', name: null };
      items.push({ at: m.at, src: `pm${m.id}`, portal: true, from: cash ? who : { type: 'bank', name: null }, to, thb: Math.round(m.thb || 0),
        purpose: m.kind === 'deposit_refund' ? 'deposit_return' : m.category === 'salary' ? 'salary' : 'expense', method: m.method, note: m.note || m.party || '' });
    }
  }
  for (const e of q.expenses.all(since())) {
    const who = { type: 'staff', name: canonicalName(e.by_name, staffNames) || e.by_name || e.by_email };
    items.push({ at: e.created_at, src: `ex${e.id}`, portal: true, from: e.method === 'cash' ? who : { type: 'bank', name: null }, to: { type: 'expense', name: null },
      thb: Math.round(e.thb || 0), purpose: 'expense', method: e.method, category: e.category, note: [e.vendor, e.note].filter(Boolean).join(' — ') });
  }
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * Остатки: сейф в офисе (операционный, залоговый) и наличные у каждого сотрудника, раздельно
 * «операционные» и «залоги» (у сотрудника в кармане может быть и то, и другое). Итоги:
 * все операционные = сейф + у сотрудников; все залоги = залоговый сейф + у сотрудников.
 * Снимок «закрытия дня» ставит остаток и показывает расхождение с посчитанным.
 */
function balancesOf(items) {
  const office = { op: 0, dep: 0 };
  const staff = new Map(); // имя → { op, dep, last }
  const checks = [];
  const person = (name) => staff.get(name) || staff.set(name, { op: 0, dep: 0, last: null }).get(name);
  const poolOf = (it) => (it.from.type === 'dep' || it.to.type === 'dep' || ['deposit', 'deposit_return'].includes(it.purpose) ? 'dep' : 'op');
  for (const it of items) {
    if (it.balance) {
      const a = it.balance;
      if (a.type === 'op' || a.type === 'dep') {
        if (Math.abs(office[a.type] - it.thb) >= 1) checks.push({ at: it.at, src: it.src, account: a.type, counted: Math.round(office[a.type]), reported: it.thb, diff: Math.round(it.thb - office[a.type]) });
        office[a.type] = it.thb;
      } else if (a.type === 'staff' && a.name) {
        const p = person(a.name);
        const was = p.op + p.dep;
        if (Math.abs(was - it.thb) >= 1) checks.push({ at: it.at, src: it.src, account: `staff:${a.name}`, counted: Math.round(was), reported: it.thb, diff: Math.round(it.thb - was) });
        p.op = it.thb - p.dep; p.last = it.at;
      }
      continue;
    }
    const pool = poolOf(it);
    for (const [side, sign] of [[it.from, -1], [it.to, 1]]) {
      if (side.type === 'op' || side.type === 'dep') office[side.type] += sign * it.thb;
      else if (side.type === 'staff' && side.name) { const p = person(side.name); p[pool] += sign * it.thb; p.last = it.at; }
    }
  }
  const people = [...staff].map(([name, p]) => ({ name, op: Math.round(p.op), dep: Math.round(p.dep), thb: Math.round(p.op + p.dep), last: p.last }))
    .filter((p) => p.op || p.dep).sort((a, b) => b.thb - a.thb);
  return {
    op: Math.round(office.op), dep: Math.round(office.dep), staff: people,
    totals: { op: Math.round(office.op + people.reduce((s2, p) => s2 + p.op, 0)), dep: Math.round(office.dep + people.reduce((s2, p) => s2 + p.dep, 0)) },
    checks: checks.slice(-30).reverse()
  };
}

/** Остатки для «Игры»: сейфы и наличные сотрудников (ready — есть хоть одна разобранная запись) */
export function ledgerSnapshot() {
  const done = q.counts.all(since()).find((c) => c.status === 'done')?.n || 0;
  const staffNames = activeStaff().map((s) => s.name).filter((n) => /\p{L}/u.test(n || ''));
  const b = balancesOf(allMoves(staffNames, currentRates().rates));
  return { ready: done > 0, op: b.op, dep: b.dep, staff: b.staff, totals: b.totals };
}

const accLabel = (a) => (a.type === 'staff' ? a.name || 'сотрудник' : ACC_RU[a.type] || a.type);

/** GET /api/staff/finance/ai-log?from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function financeAiLog(staff, req, res, url) {
  if (!can(staff, 'finance.view')) throw new HttpError(403, 'no_section_access');
  const day = (v, d) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : d);
  const from = day(url.searchParams.get('from'), '2000-01-01');
  const to = day(url.searchParams.get('to'), '2100-01-01');
  const fromIso = new Date(Date.parse(`${from}T00:00:00+07:00`)).toISOString();
  const toIso = new Date(Date.parse(`${to}T00:00:00+07:00`) + 86400000).toISOString();
  const staffNames = activeStaff().map((s) => s.name).filter((n) => /\p{L}/u.test(n || ''));
  const { rates } = currentRates();
  const items = allMoves(staffNames, rates);
  const bySrc = new Map();
  for (const it of items) { if (!bySrc.has(it.src)) bySrc.set(it.src, []); bySrc.get(it.src).push(it); }
  const view = (it) => it.balance
    ? { balance: true, account: accLabel(it.balance), thb: it.thb }
    : { from: accLabel(it.from), to: accLabel(it.to), thb: it.thb, purpose: PURPOSE_RU[it.purpose] || it.purpose || '', method: it.method || '', note: it.note || '' };
  const entries = q.log.all(fromIso, toIso).map((row) => {
    let r = null;
    try { r = row.result ? JSON.parse(row.result) : null; } catch { /* битый ответ */ }
    return {
      id: row.message_id, at: row.ts, who: row.who || row.author_name || row.author, text: row.text, kind: row.kind, status: row.status,
      relevant: r ? Boolean(r.relevant) : null, summary: r?.summary || '', unsure: Boolean(r?.unsure), question: r?.question || '',
      lines: row.status === 'done' ? (bySrc.get(row.message_id) || []).map(view) : (r && row.status === 'ignored' ? (r.moves || []).map((m) => ({ from: m.from === 'staff' ? m.fromName : ACC_RU[m.from], to: m.to === 'staff' ? m.toName : ACC_RU[m.to], thb: number(m.amount), purpose: PURPOSE_RU[m.purpose] || '' })) : []),
      error: row.error, usd: row.usd || 0, ignoredBy: row.ignored_by || null
    };
  });
  const portal = items.filter((it) => it.portal && it.at >= fromIso && it.at < toIso).map((it) => ({ at: it.at, ...view(it) })).reverse();
  const counts = Object.fromEntries(q.counts.all(since()).map((c) => [c.status, { n: c.n, usd: Math.round(c.usd * 100) / 100 }]));
  sendJson(res, 200, { since: since(), blocked, counts, balances: balancesOf(items), entries, portal: portal.slice(0, 100), canEdit: can(staff, 'finance.view') });
}

/** POST /api/staff/finance/ai-log/ignore { id, ignored } — «не учитывать» / «учитывать снова» */
export async function financeAiIgnore(staff, req, res) {
  if (!can(staff, 'finance.view')) throw new HttpError(403, 'no_section_access');
  const { id, ignored } = await readJson(req);
  const row = q.one.get(String(id || ''));
  if (!row) throw new HttpError(404, 'not_found');
  const r = q.ignore.run(ignored ? 'ignored' : 'done', ignored ? (staff.name || staff.email) : null, new Date().toISOString(), row.message_id);
  if (!r.changes) throw new HttpError(409, 'not_ready');
  sendJson(res, 200, { ok: true });
}

/** POST /api/staff/finance/ai-log/retry { id } — распознать заново */
export async function financeAiRetry(staff, req, res) {
  if (!can(staff, 'finance.view')) throw new HttpError(403, 'no_section_access');
  const { id } = await readJson(req);
  const row = q.one.get(String(id || ''));
  if (!row) throw new HttpError(404, 'not_found');
  q.retry.run(new Date().toISOString(), row.message_id);
  setTimeout(tick, 200);
  sendJson(res, 200, { ok: true });
}
