/**
 * ============================================================================
 * Вкладка «Игра» — режим наблюдателя (владелец и админ)
 * ============================================================================
 * Ничего не меняет — только читает то, что уже есть в портале, и отдаёт
 * «снимок мира» для анимации:
 *   — сотрудники: кто на работе (отметки «на месте» / «ушёл» в группе WhatsApp —
 *     как табель), когда было последнее действие (группа, статусы, документы,
 *     деньги, «＋ Операция»), кошелёк (наличные на руках — из «Финансов»);
 *   — техника и статусы (как «Парк» и «Обзор»);
 *   — открытые заявки (без имён и телефонов клиентов);
 *   — касса: наличный приход за сегодня и залоги на руках (из «Финансов»);
 *   — кто сейчас на сайте и откуда, кто пишет ботам (gameLive.js, без личных данных);
 *   — события после прошлого запроса — для анимаций («кто что сделал»).
 * Портал опрашивает раз в несколько секунд: GET /api/staff/game/state?since=…
 * ============================================================================
 */

import * as db from './db.js';
import { HttpError, sendJson } from './http.js';
import { can } from './roles.js';
import { activeStaff, getRole, ADMIN_ROLE } from './access.js';
import { staffPhones } from './staffUsers.js';
import { getPortalSnapshot } from './fleet.js';
import { listVehicles } from './fleetStore.js';
import { isSold } from './sold.js';
import { financeReport } from './finance.js';
import { allSources } from './marketing.js';
import { lidPhones, OPERATION_KINDS } from './journal/journal.js';
import { siteOnline, botChatsSince, botChatsActive } from './gameLive.js';

const BANGKOK_MS = 7 * 3600000;
const EVENTS_BACK_MS = 30 * 60000;
const FINANCE_CACHE_MS = 60000;

const iso = (ms) => new Date(ms).toISOString();
const bangkokDay = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 10);
const dayStartMs = (ms) => Date.parse(`${bangkokDay(ms)}T00:00:00+07:00`);
const low = (s) => String(s || '').trim().toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');

/** Роль в игре по роли в «Доступах» (свои роли — по названию); null — не персонаж */
function gameRole(roleId) {
  if (roleId === ADMIN_ROLE) return 'admin';
  const text = `${roleId} ${getRole(roleId)?.name || ''}`.toLowerCase();
  if (/owner|владел/.test(text)) return 'owner';
  if (/financ|финанс|бухг/.test(text)) return 'finance';
  if (/service|сервис|механ|ремонт/.test(text)) return 'service';
  if (/market|маркет|smm|реклам/.test(text)) return 'marketing';
  if (/courier|курьер|достав|выдач/.test(text)) return 'delivery';
  if (/agent|агент|invest|инвест|viewer|просмотр/.test(text)) return null;
  return 'manager';
}

const normType = (t) => {
  const v = low(t);
  if (/car|авто|машин/.test(v)) return 'car';
  if (/moto|мото|bike/.test(v)) return 'moto';
  return 'scooter';
};

/* ------------------------------------------------------------ Финансы (кэш) */

let finCache = null;
async function financeNow(now) {
  if (finCache && now - finCache.at < FINANCE_CACHE_MS) return finCache.data;
  let data = null;
  try {
    const day = bangkokDay(now);
    const r = await financeReport({ from: day, to: day }, now, {});
    data = {
      cashToday: Math.round(r.summary?.inCash || 0),
      revenueToday: Math.round(r.summary?.revenue || 0),
      depositsHeld: Math.round(r.deposits?.held || 0),
      depositCars: r.deposits?.cars || 0,
      holders: (r.cash?.holders || []).map((h) => ({ name: h.name, onHand: h.onHand, received: h.received, spent: h.spent, lastHandover: h.lastHandover }))
    };
  } catch (err) {
    console.error('Game finance failed:', err.message);
  }
  finCache = { at: now, data };
  return data;
}

/* ------------------------------------------------------------ Сотрудники */

const q = {
  shifts: db.raw.prepare(`SELECT id, ts, author, author_name, kind FROM wa_messages
    WHERE kind IN ('shift_start', 'shift_end') AND status != 'ignored' AND ts >= ? ORDER BY ts`),
  groupLast: db.raw.prepare(`SELECT author, author_name, MAX(ts) ts FROM wa_messages WHERE ts >= ? AND kind != 'media' GROUP BY author`),
  eventsBy: db.raw.prepare('SELECT by_email email, by_name name, MAX(at) at FROM vehicle_events WHERE at >= ? GROUP BY by_email, by_name'),
  docsBy: db.raw.prepare('SELECT created_by email, created_name name, MAX(created_at) at FROM documents WHERE created_at >= ? GROUP BY created_by, created_name'),
  movesBy: db.raw.prepare('SELECT by_email email, by_name name, MAX(at) at FROM cash_moves WHERE at >= ? AND deleted_at IS NULL GROUP BY by_email, by_name'),
  expensesBy: db.raw.prepare('SELECT by_email email, by_name name, MAX(created_at) at FROM expenses WHERE created_at >= ? AND deleted_at IS NULL GROUP BY by_email, by_name'),
  draftsBy: db.raw.prepare('SELECT staff_email email, NULL name, MAX(updated_at) at FROM op_drafts WHERE updated_at >= ? GROUP BY staff_email'),
  takenBy: db.raw.prepare("SELECT NULL email, taken_by_name name, MAX(taken_at) at FROM requests WHERE taken_at >= ? GROUP BY taken_by_name"),
  // события для анимаций
  evStatus: db.raw.prepare('SELECT id, plate, kind, by_email, by_name, at FROM vehicle_events WHERE at > ? ORDER BY at LIMIT 200'),
  evGroup: db.raw.prepare(`SELECT m.id, m.ts, m.kind, m.author, m.author_name, GROUP_CONCAT(p.plate) plates FROM wa_messages m
    LEFT JOIN wa_message_plates p ON p.message_id = m.id AND p.role IN ('main', 'to')
    WHERE m.ts > ? AND m.status != 'ignored' AND m.kind IN (${[...OPERATION_KINDS, 'shift_start', 'shift_end'].map((k) => `'${k}'`).join(',')})
      AND instr(COALESCE(m.text, ''), '[portal ') = 0
    GROUP BY m.id ORDER BY m.ts LIMIT 200`),
  evDocs: db.raw.prepare('SELECT id, kind, number, created_at, created_by, created_name FROM documents WHERE created_at > ? ORDER BY created_at LIMIT 100'),
  evMoves: db.raw.prepare('SELECT id, at, dir, kind, thb, method, by_email, by_name FROM cash_moves WHERE at > ? AND deleted_at IS NULL ORDER BY at LIMIT 100'),
  evExpenses: db.raw.prepare('SELECT id, created_at, thb, category, method, by_email, by_name FROM expenses WHERE created_at > ? AND deleted_at IS NULL ORDER BY created_at LIMIT 100'),
  evRequests: db.raw.prepare("SELECT id, created_at, channel, kind, model, vehicle_type FROM requests WHERE created_at > ? AND channel != 'test' ORDER BY created_at LIMIT 100"),
  evTaken: db.raw.prepare("SELECT id, taken_at, taken_by_name, channel FROM requests WHERE taken_at > ? AND channel != 'test' ORDER BY taken_at LIMIT 100"),
  openRequests: db.raw.prepare(`SELECT id, created_at, channel, kind, model, vehicle_type, date_from, date_to, source_ref, site_host, status, taken_by_name, taken_at
    FROM requests WHERE channel != 'test' AND archived_at IS NULL AND (status = 'new' OR (status = 'taken' AND taken_at >= ?)) ORDER BY created_at DESC LIMIT 60`)
};

const waNameQ = db.raw.prepare("SELECT author_name FROM wa_messages WHERE author = ? AND author_name IS NOT NULL AND author_name != '' ORDER BY ts DESC LIMIT 1");
const phonesOf = (value) => String(value || '').split(/[,;\s]+/).map(digits).filter((x) => x.length >= 8);
/** Имя для игры: из «Доступов»; если там только номер — имя из WhatsApp (как подписан в группе) */
function displayName(s, lids) {
  if (/\p{L}/u.test(s.name || '')) return s.name;
  for (const phone of phonesOf(s.whatsapp)) {
    const keys = [phone, ...Object.entries(lids).filter(([, p]) => digits(p) === phone).map(([lid]) => lid)];
    for (const key of keys) {
      const name = waNameQ.get(key)?.author_name;
      if (name && /\p{L}/u.test(name)) return name;
    }
  }
  return s.name || s.email || `#${s.id}`;
}

/** Кто есть кто: сотрудник по почте, имени или номеру WhatsApp */
async function staffIndex() {
  const list = activeStaff();
  const phones = await staffPhones();
  const lids = lidPhones();
  const byEmail = new Map(), byName = new Map(), byPhone = new Map();
  for (const s of list) {
    if (s.email) byEmail.set(low(s.email), s);
    if (s.name) byName.set(low(s.name), s);
    for (const p of phonesOf(s.whatsapp)) byPhone.set(p, s);
  }
  const byAuthor = (author, authorName) => {
    const a = String(author || '');
    const phone = digits(lids[a] || a);
    return byPhone.get(phone) || byName.get(low(phones.get(phone) || phones.get(a))) || byName.get(low(authorName)) || null;
  };
  const byWho = (email, name) => byEmail.get(low(email)) || byName.get(low(name)) || null;
  return { list, byAuthor, byWho, lids };
}

function staffView(idx, now, finance) {
  const start = iso(dayStartMs(now));
  const shifts = new Map();
  for (const row of q.shifts.all(start)) {
    const s = idx.byAuthor(row.author, row.author_name);
    if (!s) continue;
    const st = shifts.get(s.id) || { since: null, left: null, present: false };
    if (row.kind === 'shift_start') { if (!st.since) st.since = row.ts; st.present = true; st.left = null; }
    else { st.present = false; st.left = row.ts; }
    shifts.set(s.id, st);
  }
  const last = new Map();
  const bump = (s, at) => { if (s && at && (!last.has(s.id) || at > last.get(s.id))) last.set(s.id, at); };
  for (const row of q.groupLast.all(start)) bump(idx.byAuthor(row.author, row.author_name), row.ts);
  for (const stmt of [q.eventsBy, q.docsBy, q.movesBy, q.expensesBy, q.draftsBy, q.takenBy]) {
    for (const row of stmt.all(start)) bump(idx.byWho(row.email, row.name), row.at);
  }
  const wallets = new Map();
  for (const h of finance?.holders || []) {
    if (h.onHand === null || h.onHand === undefined) continue;
    const s = idx.byWho(null, h.name);
    if (s) wallets.set(s.id, h.onHand);
  }
  return idx.list.map((s) => {
    const sh = shifts.get(s.id);
    let role = gameRole(s.roleId);
    // Владелец, админ и роли без персонажа — в игре только если отметились на смене
    if (!role || role === 'owner' || role === 'admin') { if (!sh) return null; role = role === 'owner' ? 'owner' : 'manager'; }
    return {
      id: s.id, name: displayName(s, idx.lids), role, roleName: s.roleId === ADMIN_ROLE ? 'Админ' : getRole(s.roleId)?.name || s.roleId,
      present: Boolean(sh?.present), since: sh?.since || null, left: sh?.left || null,
      lastAction: last.get(s.id) || null, wallet: wallets.has(s.id) ? wallets.get(s.id) : null
    };
  }).filter(Boolean);
}

/* ------------------------------------------------------------ Техника */

async function fleetView() {
  let snap = null;
  try { snap = await getPortalSnapshot(); } catch (err) { console.error('Game fleet failed:', err.message); }
  const colors = new Map(listVehicles().map((v) => [v.id, v.color || '']));
  return (snap?.cars || []).filter((c) => !isSold(c.plate)).map((c) => ({
    id: c.id, plate: c.plate || '', model: c.model || c.wsModel || '', type: normType(c.type), status: c.status || 'free',
    until: c.holder?.to || c.until || null, client: c.holder?.client || null, holderKind: c.holder?.kind || null,
    overdue: Boolean(c.overdue), needsRepair: Boolean(c.needsRepair), color: colors.get(c.vehicleId) || ''
  }));
}

/* ------------------------------------------------------------ Сайт и боты */

function siteView(now) {
  const live = siteOnline(now);
  const names = new Map(allSources().map((s) => [low(s.code), s.name]));
  const label = (src) => {
    if (src.startsWith('ref:')) return names.get(low(src.slice(4))) || `ссылка ${src.slice(4)}`;
    if (src.startsWith('utm:')) return `реклама: ${src.slice(4)}`;
    return src;
  };
  const merged = new Map();
  for (const s of live.sources) { const k = label(s.name); merged.set(k, (merged.get(k) || 0) + s.n); }
  return { online: live.online, sources: [...merged].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n), sites: live.sites, devices: live.devices };
}

/* ------------------------------------------------------------ События */

function eventsSince(idx, sinceIso, sinceMs) {
  const out = [];
  const who = (s) => (s ? { staffId: s.id, who: s.name } : { staffId: null, who: null });
  for (const r of q.evStatus.all(sinceIso)) out.push({ id: `ve${r.id}`, at: r.at, type: 'status', status: r.kind, plate: r.plate, ...who(idx.byWho(r.by_email, r.by_name)) });
  for (const r of q.evGroup.all(sinceIso)) {
    const s = idx.byAuthor(r.author, r.author_name);
    out.push({ id: `wa${r.id}`, at: r.ts, type: r.kind === 'shift_start' || r.kind === 'shift_end' ? r.kind : 'group', kind: r.kind, plates: r.plates ? String(r.plates).split(',') : [], ...who(s), who: s?.name || r.author_name || null });
  }
  for (const r of q.evDocs.all(sinceIso)) out.push({ id: `dc${r.id}`, at: r.created_at, type: 'doc', kind: r.kind, number: r.number, ...who(idx.byWho(r.created_by, r.created_name)) });
  for (const r of q.evMoves.all(sinceIso)) out.push({ id: `cm${r.id}`, at: r.at, type: 'money', dir: r.dir, kind: r.kind, thb: Math.round(r.thb || 0), method: r.method, ...who(idx.byWho(r.by_email, r.by_name)) });
  for (const r of q.evExpenses.all(sinceIso)) out.push({ id: `ex${r.id}`, at: r.created_at, type: 'expense', thb: Math.round(r.thb || 0), category: r.category, method: r.method, ...who(idx.byWho(r.by_email, r.by_name)) });
  for (const r of q.evRequests.all(sinceIso)) out.push({ id: `rq${r.id}`, at: r.created_at, type: 'request', requestId: r.id, channel: r.channel, kind: r.kind || null, what: r.model || r.vehicle_type || '' });
  for (const r of q.evTaken.all(sinceIso)) out.push({ id: `rt${r.id}`, at: r.taken_at, type: 'request_taken', requestId: r.id, channel: r.channel, ...who(idx.byWho(null, r.taken_by_name)), who: r.taken_by_name || null });
  for (const c of botChatsSince(sinceMs)) out.push({ id: `ch${c.at}${c.key}`, at: iso(c.at), type: 'chat', channel: c.channel, key: c.key });
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** GET /api/staff/game/state?since=ISO */
export async function gameState(staff, req, res, url) {
  if (!can(staff, 'game.view')) throw new HttpError(403, 'no_section_access');
  const now = Date.now();
  const sinceParam = Date.parse(url.searchParams.get('since') || '');
  const sinceMs = Number.isFinite(sinceParam) ? Math.max(sinceParam, now - EVENTS_BACK_MS) : now - EVENTS_BACK_MS;
  const idx = await staffIndex();
  const [finance, cars] = await Promise.all([financeNow(now), fleetView()]);
  const todayStart = iso(dayStartMs(now));
  sendJson(res, 200, {
    now: iso(now),
    cursor: iso(now),
    day: bangkokDay(now),
    staff: staffView(idx, now, finance),
    cars,
    requests: q.openRequests.all(todayStart).map((r) => ({
      id: r.id, at: r.created_at, channel: r.channel, kind: r.kind || null, what: r.model || r.vehicle_type || '',
      from: r.date_from, to: r.date_to, status: r.status, takenBy: r.taken_by_name || null, takenAt: r.taken_at || null, site: r.site_host || null
    })),
    finance: finance ? {
      cashToday: finance.cashToday, revenueToday: finance.revenueToday, depositsHeld: finance.depositsHeld, depositCars: finance.depositCars,
      wallets: finance.holders.filter((h) => h.onHand !== null && h.onHand !== undefined && Math.round(h.onHand) !== 0)
        .map((h) => ({ name: h.name, staffId: idx.byWho(null, h.name)?.id || null, thb: Math.round(h.onHand) }))
    } : null,
    site: siteView(now),
    chats: botChatsActive(now),
    events: eventsSince(idx, iso(sinceMs), sinceMs)
  });
}

