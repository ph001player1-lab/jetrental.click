/**
 * ============================================================================
 * Доступы сайта сотрудников: роли, права по разделам, сотрудники
 * ============================================================================
 * Админы — только из Google-таблицы (лист Users, роль Admin): так админ не
 * потеряет вход, даже если роли в портале испортят, и никто не может сам
 * сделать себя админом. Остальные сотрудники и роли хранятся здесь, в базе,
 * и настраиваются админом на вкладке «Доступы».
 *
 * У роли по каждому разделу уровень: edit (меняет) / view (смотрит) / none.
 * Из уровней получается список прав вида «раздел.view», «раздел.edit» —
 * их проверяют сервер и портал. Изменения действуют сразу.
 * ============================================================================
 */

import * as db from './db.js';
import { config } from './config.js';

/** Главные админы — из настроек сервера (STAFF_EMAILS): их нельзя снять в портале */
const hasMainAdmins = () => config.staff.extraEmails.length > 0;

/** Разделы и какие уровни у них бывают (edit — только там, где есть что менять) */
export const SECTIONS = [
  { id: 'overview', levels: ['view', 'none'] },
  // «Парк: меняет» — правка карточек техники, архив, удаление (владелец и админ)
  { id: 'fleet', levels: ['edit', 'view', 'none'] },
  { id: 'calendar', levels: ['view', 'none'] },
  { id: 'requests', levels: ['view', 'none'] },
  { id: 'journal', levels: ['edit', 'view', 'none'] },
  { id: 'clients', levels: ['view', 'none'] },
  { id: 'timesheet', levels: ['view', 'none'] },
  { id: 'reconcile', levels: ['view', 'none'] },
  { id: 'whatsapp', levels: ['edit', 'view', 'none'] },
  { id: 'site', levels: ['edit', 'view', 'none'] },
  { id: 'finance', levels: ['view', 'none'] },
  { id: 'crm', levels: ['edit', 'view', 'none'] },
  { id: 'marketing', levels: ['edit', 'view', 'none'] },
  { id: 'price', levels: ['edit', 'view', 'none'] },
  { id: 'server', levels: ['view', 'none'] },
  // «Документы»: договоры, акты, квитанции (смотрит — открыть и распечатать; меняет — составлять, подписывать, отправлять)
  { id: 'docs', levels: ['edit', 'view', 'none'] },
  // «Ошибки и предложения»: присылать могут все (смотрит — свои тикеты), разбирает — «меняет»
  { id: 'tickets', levels: ['edit', 'view'] }
];
const SECTION_IDS = SECTIONS.map((s) => s.id);
const LEVELS = Object.fromEntries(SECTIONS.map((s) => [s.id, s.levels]));

export const ADMIN_ROLE = 'admin';

// Готовые роли для старта; админ может переименовать, перенастроить и удалить
const V = 'view';
const E = 'edit';
const N = 'none';
const preset = (overview, fleet, calendar, requests, journal, clients, timesheet, reconcile, whatsapp, site, finance, server, crm = N, marketing = N, price = N, tickets = V) =>
  ({ overview, fleet, calendar, requests, journal, clients, timesheet, reconcile, whatsapp, site, finance, server, crm, marketing, price, tickets });
// «Кабинет» даёт не роль, а привязка к источнику (агент или партнёр) — так менеджер может быть
// и агентом: у него свои вкладки и ещё кабинет. Роль «Агент» — для тех, кто только агент:
// ни парка, ни чужих заявок, только кабинет и свои тикеты
const AGENT_ROLE = ['agent', 'Агент', preset(N, N, N, N, N, N, N, N, N, N, N, N, N, N, N, V)];
// Инвестор: только свой кабинет (машины, загрузка, доход, доля) и свои тикеты
const INVESTOR_ROLE = ['investor', 'Инвестор', preset(N, N, N, N, N, N, N, N, N, N, N, N, N, N, N, V)];
const DEFAULT_ROLES = [
  // CRM по умолчанию — только у владельца (и админа); остальным админ открывает сам
  // Прайс меняют только владелец и админ, менеджеры смотрят (называть цены клиентам)
  ['owner', 'Владелец', preset(V, E, V, V, E, V, V, V, V, E, V, V, E, E, E, E)],
  ['finance', 'Финансист', preset(V, V, V, N, V, V, N, V, N, N, V, N, N, N, V)],
  // Один «Менеджер» без отдела: разные права — разные роли, их админ создаёт сам
  ['manager', 'Менеджер', preset(V, V, V, V, E, V, N, V, N, E, N, N, N, N, V)],
  ['service', 'Работник сервиса', preset(N, V, V, N, V, N, N, N, N, N, N, N)],
  ['courier', 'Курьер', preset(N, V, V, N, V, V, N, N, N, N, N, N)],
  // «Просмотр» — роль по умолчанию (и для прежней роли Viewer из таблицы)
  ['viewer', 'Просмотр', preset(V, V, V, V, V, N, N, V, N, V, N, N, N, N, V)],
  AGENT_ROLE,
  INVESTOR_ROLE
];
export const DEFAULT_ROLE = 'viewer';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS access_roles (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    perms      TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS access_staff (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE,
    telegram_id TEXT,
    whatsapp    TEXT,
    role_id     TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS access_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    by      TEXT NOT NULL,
    action  TEXT NOT NULL,
    details TEXT
  );
`);

// Ставка в час (для зарплаты по табелю в «Финансах») — колонка добавлена позже
if (!db.raw.prepare('PRAGMA table_info(access_staff)').all().some((c) => c.name === 'rate')) {
  db.raw.exec('ALTER TABLE access_staff ADD COLUMN rate REAL');
}
// Агент или партнёр: к какому источнику из «Маркетинга» привязан его кабинет
if (!db.raw.prepare('PRAGMA table_info(access_staff)').all().some((c) => c.name === 'source_id')) {
  db.raw.exec('ALTER TABLE access_staff ADD COLUMN source_id INTEGER');
}
// Инвестор: доля, % от прибыли его машин (null — не инвестор) и с какого месяца считаем
// investor_negative — минус по машине за месяц: 'carry' — учитывать в выплатах, 'zero' — обнулять
for (const [col, type] of [['investor_percent', 'REAL'], ['investor_since', 'TEXT'], ['investor_negative', "TEXT NOT NULL DEFAULT 'carry'"]]) {
  if (!db.raw.prepare('PRAGMA table_info(access_staff)').all().some((c) => c.name === col)) db.raw.exec(`ALTER TABLE access_staff ADD COLUMN ${col} ${type}`);
}

const now = () => new Date().toISOString();

const q = {
  roles: db.raw.prepare('SELECT * FROM access_roles ORDER BY sort, created_at'),
  role: db.raw.prepare('SELECT * FROM access_roles WHERE id = ?'),
  addRole: db.raw.prepare('INSERT INTO access_roles (id, name, perms, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
  updateRole: db.raw.prepare('UPDATE access_roles SET name = ?, perms = ?, updated_at = ? WHERE id = ?'),
  deleteRole: db.raw.prepare('DELETE FROM access_roles WHERE id = ?'),
  roleUse: db.raw.prepare('SELECT COUNT(*) n FROM access_staff WHERE role_id = ?'),
  staff: db.raw.prepare('SELECT * FROM access_staff ORDER BY active DESC, name COLLATE NOCASE'),
  staffById: db.raw.prepare('SELECT * FROM access_staff WHERE id = ?'),
  staffByEmail: db.raw.prepare('SELECT * FROM access_staff WHERE email = ?'),
  addStaff: db.raw.prepare(`INSERT INTO access_staff (name, email, telegram_id, whatsapp, role_id, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  updateStaff: db.raw.prepare(`UPDATE access_staff SET name = ?, email = ?, telegram_id = ?, whatsapp = ?, role_id = ?, active = ?, updated_at = ?
    WHERE id = ?`),
  setRate: db.raw.prepare('UPDATE access_staff SET rate = ? WHERE id = ?'),
  setSource: db.raw.prepare('UPDATE access_staff SET source_id = ? WHERE id = ?'),
  setInvestor: db.raw.prepare('UPDATE access_staff SET investor_percent = ?, investor_since = COALESCE(investor_since, ?) WHERE id = ?'),
  setNegative: db.raw.prepare('UPDATE access_staff SET investor_negative = ? WHERE id = ?'),
  bySource: db.raw.prepare('SELECT * FROM access_staff WHERE source_id = ? AND active = 1'),
  deleteStaff: db.raw.prepare('DELETE FROM access_staff WHERE id = ?'),
  log: db.raw.prepare('INSERT INTO access_log (at, by, action, details) VALUES (?, ?, ?, ?)'),
  lastLog: db.raw.prepare('SELECT * FROM access_log ORDER BY id DESC LIMIT ?')
};

// Готовые роли — один раз, при первом запуске
if (!db.raw.prepare('SELECT COUNT(*) n FROM access_roles').get().n) {
  DEFAULT_ROLES.forEach(([id, name, perms], i) => q.addRole.run(id, name, JSON.stringify(perms), i, now(), now()));
}

// Разделы «CRM» и «Маркетинг» появились позже: в уже созданной роли «Владелец» открываем
// их один раз, у остальных ролей они «нет доступа» (так решил владелец бизнеса)
for (const section of ['crm', 'marketing']) {
  if (db.getSetting(`access_${section}_section`) === '1') continue;
  const owner = q.role.get('owner');
  if (owner) {
    const perms = JSON.parse(owner.perms || '{}');
    if (!perms[section]) q.updateRole.run(owner.name, JSON.stringify({ ...perms, [section]: 'edit' }), now(), owner.id);
  }
  db.setSetting(`access_${section}_section`, '1');
}

// Раздел «Прайс» появился позже: один раз открываем его в уже созданных ролях —
// владельцу «меняет», менеджеру, финансисту и «Просмотру» — «смотрит»
if (db.getSetting('access_price_section') !== '1') {
  for (const [roleId, level] of [['owner', 'edit'], ['manager', 'view'], ['finance', 'view'], ['viewer', 'view']]) {
    const role = q.role.get(roleId);
    if (!role) continue;
    const perms = JSON.parse(role.perms || '{}');
    if (!perms.price) q.updateRole.run(role.name, JSON.stringify({ ...perms, price: level }), now(), role.id);
  }
  db.setSetting('access_price_section', '1');
}

// Роль «Инвестор» появилась позже — добавляем один раз
if (db.getSetting('access_investor_role') !== '1') {
  if (!q.role.get(INVESTOR_ROLE[0])) q.addRole.run(INVESTOR_ROLE[0], INVESTOR_ROLE[1], JSON.stringify(INVESTOR_ROLE[2]), 51, now(), now());
  db.setSetting('access_investor_role', '1');
}

// Правка парка в портале появилась позже: один раз открываем её владельцу
if (db.getSetting('access_fleet_edit') !== '1') {
  const owner = q.role.get('owner');
  if (owner) {
    const perms = JSON.parse(owner.perms || '{}');
    if (perms.fleet !== 'edit') q.updateRole.run(owner.name, JSON.stringify({ ...perms, fleet: 'edit' }), now(), owner.id);
  }
  db.setSetting('access_fleet_edit', '1');
}

// Роль «Агент» появилась позже — добавляем один раз
if (db.getSetting('access_agent_role') !== '1') {
  if (!q.role.get(AGENT_ROLE[0])) q.addRole.run(AGENT_ROLE[0], AGENT_ROLE[1], JSON.stringify(AGENT_ROLE[2]), 50, now(), now());
  db.setSetting('access_agent_role', '1');
}

// Раздел «Документы» появился позже: один раз открываем его — владельцу и менеджеру «меняет»
// (менеджеры составляют договоры), финансисту — «смотрит»
if (db.getSetting('access_docs_section') !== '1') {
  for (const [roleId, level] of [['owner', 'edit'], ['manager', 'edit'], ['finance', 'view']]) {
    const role = q.role.get(roleId);
    if (!role) continue;
    const perms = JSON.parse(role.perms || '{}');
    if (!perms.docs) q.updateRole.run(role.name, JSON.stringify({ ...perms, docs: level }), now(), role.id);
  }
  db.setSetting('access_docs_section', '1');
}

// Раздел «Ошибки и предложения» появился позже: разбирать тикеты один раз открываем владельцу
// (остальным он и так открыт как «смотрит» — присылать тикеты могут все)
if (db.getSetting('access_tickets_section') !== '1') {
  const owner = q.role.get('owner');
  if (owner) {
    const perms = JSON.parse(owner.perms || '{}');
    if (!perms.tickets) q.updateRole.run(owner.name, JSON.stringify({ ...perms, tickets: 'edit' }), now(), owner.id);
  }
  db.setSetting('access_tickets_section', '1');
}

/** Уровни роли по всем разделам (неизвестное и недопустимое — «нет доступа»,
 *  а где «нет доступа» не бывает — самый низкий уровень) */
function cleanPerms(input) {
  const perms = {};
  for (const id of SECTION_IDS) {
    const level = input?.[id];
    const levels = LEVELS[id];
    perms[id] = levels.includes(level) ? level : levels.includes('none') ? 'none' : levels[levels.length - 1];
  }
  return perms;
}

const parseRole = (row) => row && { id: row.id, name: row.name, perms: cleanPerms(JSON.parse(row.perms || '{}')) };

export const getRole = (id) => parseRole(q.role.get(String(id || '')));

/** Права из уровней: «раздел.view», «раздел.edit» и прежние названия, которые уже есть в коде */
export function permissionsFromLevels(perms) {
  const list = [];
  for (const id of SECTION_IDS) {
    const level = perms[id];
    if (level === 'view' || level === 'edit') list.push(`${id}.view`);
    if (level === 'edit') list.push(`${id}.edit`);
  }
  const has = (p) => list.includes(p);
  if (has('clients.view')) list.push('journal.private');
  if (has('timesheet.view')) list.push('journal.timesheet');
  if (has('whatsapp.edit')) list.push('journal.admin');
  return list;
}

/** Все права — у админа: все разделы, настройки сервера и вкладка «Доступы» */
export function adminPermissions() {
  const all = Object.fromEntries(SECTIONS.map((s) => [s.id, s.levels[0]]));
  return [...permissionsFromLevels(all), 'settings', 'access.admin'];
}

/* ----------------------------------------------------------- Сотрудники */

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

// Без почты сотрудник есть в списке, но войти в портал не может («не подключён»)
const publicStaff = (row) => ({
  id: row.id, name: row.name, email: row.email || '', telegramId: row.telegram_id || '', whatsapp: row.whatsapp || '',
  roleId: row.role_id, active: Boolean(row.active), connected: Boolean(row.email), rate: row.rate || 0,
  sourceId: row.source_id || null,
  // Инвестор: доля, % от прибыли машины (null — не инвестор)
  investorPercent: row.investor_percent ?? null, investorSince: row.investor_since || null,
  investorNegative: row.investor_negative === 'zero' ? 'zero' : 'carry'
});

/** Сотрудник по id (кабинет инвестора, уведомления) или null */
export const staffById = (id) => { const r = q.staffById.get(Number(id) || 0); return r ? publicStaff(r) : null; };

/** Инвесторы (для выбора в карточке техники и начислений): активные, с долей */
export const investors = () => q.staff.all().filter((r) => r.active && r.investor_percent !== null && r.investor_percent !== undefined).map(publicStaff);

/** Кабинеты источника: активные агенты, привязанные к нему (для уведомлений) */
export const agentsOfSource = (sourceId) => q.bySource.all(Number(sourceId) || 0).map(publicStaff);

/** Ставки в час для зарплаты по табелю: [{ name, whatsapp, rate }] */
export const staffRates = () => q.staff.all().filter((r) => r.active && r.rate > 0)
  .map((r) => ({ name: r.name, whatsapp: r.whatsapp || '', rate: r.rate }));

/** Активный сотрудник по почте (из базы) или null */
export function staffByEmail(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const row = q.staffByEmail.get(key);
  return row && row.active ? publicStaff(row) : null;
}

// Роль из таблицы при переезде: код, русское название или прежнее Editor
const ROLE_ALIASES = {
  editor: 'manager', admin: 'admin', 'админ': 'admin', 'инвестор': 'investor', 'менеджер': 'manager', 'владелец': 'owner', 'агент': 'agent', 'партнёр': 'agent', 'партнер': 'agent', 'финансист': 'finance', 'курьер': 'courier',
  'сервис': 'service', 'работник сервиса': 'service', 'просмотр': 'viewer'
};

function roleFromText(value) {
  const text = String(value || '').trim().toLowerCase();
  const id = ROLE_ALIASES[text] || text;
  if (id === ADMIN_ROLE || getRole(id)) return id;
  return q.roles.all().find((r) => r.name.toLowerCase() === text)?.id || DEFAULT_ROLE;
}

/** Все активные сотрудники из базы (для имён в журнале по номеру WhatsApp) */
export const activeStaff = () => q.staff.all().filter((r) => r.active).map(publicStaff);

/**
 * Один раз при переезде: сотрудники из таблицы (кроме админов) — в базу.
 * Роль — по колонке «Роль» (Editor → «Менеджер», «Курьер», «Сервис»…, иначе «Просмотр»).
 * Почта необязательна: без неё сотрудник в списке, но «не подключён».
 */
export function importLegacyStaff(rows) {
  if (db.getSetting('access_staff_imported') === '1') return 0;
  let n = 0;
  const known = q.staff.all();
  for (const row of rows) {
    const email = String(row.email || '').trim().toLowerCase() || null;
    const whatsapp = digitsOnly(row.whatsapp) || null;
    const name = String(row.name || '').trim() || email || (whatsapp ? `+${whatsapp}` : '');
    if (!name) continue;
    // Один человек — одна строка: по почте, иначе по номеру WhatsApp, иначе по имени
    if (known.some((k) => (email && k.email === email) || (!email && whatsapp && k.whatsapp === whatsapp) || (!email && !whatsapp && k.name === name))) continue;
    q.addStaff.run(name, email, digitsOnly(row.telegramId) || null, whatsapp, roleFromText(row.role), 1, now(), now());
    known.push({ email, whatsapp, name });
    n++;
  }
  db.setSetting('access_staff_imported', '1');
  if (n) q.log.run(now(), 'system', 'staff.import', JSON.stringify({ count: n }));
  return n;
}

/**
 * Один раз при уходе от Google-таблицы: админы из листа Users → портал (роль «Админ»).
 * rows: [{ name, emails: [...], telegramId, whatsapp }]. Почта уже есть у сотрудника — он становится админом.
 */
export function importLegacyAdmins(rows) {
  if (db.getSetting('access_admins_imported') === '1') return 0;
  let n = 0;
  for (const row of rows) {
    for (const email of row.emails) {
      const old = q.staffByEmail.get(email);
      const name = String(row.name || '').trim() || email;
      if (old) {
        q.updateStaff.run(old.name || name, email, old.telegram_id || digitsOnly(row.telegramId) || null, old.whatsapp || digitsOnly(row.whatsapp) || null,
          ADMIN_ROLE, 1, now(), old.id);
      } else {
        q.addStaff.run(name, email, digitsOnly(row.telegramId) || null, digitsOnly(row.whatsapp) || null, ADMIN_ROLE, 1, now(), now());
      }
      n++;
    }
  }
  db.setSetting('access_admins_imported', '1');
  q.log.run(now(), 'system', 'admins.import', JSON.stringify({ count: n }));
  console.log(`Access: ${n} admin(s) moved from the Users sheet to the portal`);
  return n;
}

/** Сколько активных админов в портале (кроме главных из настроек сервера) */
const portalAdmins = () => q.staff.all().filter((r) => r.active && r.role_id === ADMIN_ROLE && r.email).length;

/* ---------------------------------------------------------- Изменения */

export class AccessError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function logChange(by, action, details) {
  q.log.run(now(), by, action, JSON.stringify(details));
}

/** Создать или изменить роль: { id?, name, perms } */
export function saveRole(input, by) {
  const name = String(input.name || '').trim().slice(0, 40);
  if (!name) throw new AccessError('name_required');
  const perms = cleanPerms(input.perms);
  if (input.id) {
    const old = getRole(input.id);
    if (!old) throw new AccessError('unknown_role');
    q.updateRole.run(name, JSON.stringify(perms), now(), old.id);
    const changed = SECTION_IDS.filter((s) => old.perms[s] !== perms[s]).map((s) => `${s}: ${old.perms[s]} → ${perms[s]}`);
    logChange(by, 'role.update', { role: name, ...(old.name !== name ? { renamed: old.name } : {}), changed });
    return getRole(old.id);
  }
  const id = `r${Date.now().toString(36)}`;
  q.addRole.run(id, name, JSON.stringify(perms), 100, now(), now());
  logChange(by, 'role.create', { role: name });
  return getRole(id);
}

export function deleteRole(id, by) {
  const role = getRole(id);
  if (!role) throw new AccessError('unknown_role');
  if (q.roleUse.get(role.id).n) throw new AccessError('role_in_use');
  q.deleteRole.run(role.id);
  logChange(by, 'role.delete', { role: role.name });
}

/** Создать или изменить сотрудника: { id?, name, email, telegramId, whatsapp, roleId, active } */
export function saveStaff(input, by, { isAdminEmail }) {
  const name = String(input.name || '').trim().slice(0, 60);
  // Почта необязательна: без неё сотрудник «не подключён» (в портал не войдёт)
  const email = String(input.email || '').trim().toLowerCase() || null;
  if (!name) throw new AccessError('name_required');
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)) throw new AccessError('invalid_email');
  // Главного админа (из настроек сервера) сотрудником не сделать — он всегда админ
  if (email && isAdminEmail(email)) throw new AccessError('is_admin');
  // «Админ» — не роль из списка, у него все права; назначает его только админ (вкладка «Доступы»)
  const role = input.roleId === ADMIN_ROLE ? { id: ADMIN_ROLE, name: 'Админ' } : getRole(input.roleId);
  if (!role) throw new AccessError('unknown_role');
  const other = email ? q.staffByEmail.get(email) : null;
  if (other && other.id !== Number(input.id)) throw new AccessError('email_taken');
  const telegramId = digitsOnly(input.telegramId).slice(0, 20) || null;
  const whatsapp = digitsOnly(input.whatsapp).slice(0, 20) || null;
  const active = input.active === false ? 0 : 1;
  // Ставка не передана (вставка списком) — прежняя остаётся
  const rate = input.rate === undefined ? undefined : Math.max(0, Math.min(100000, Math.round(Number(input.rate) || 0)));
  // Кабинет агента — источник из «Маркетинга» (не передан — прежний остаётся)
  const sourceId = input.sourceId === undefined ? undefined : (Number(input.sourceId) > 0 ? Math.round(Number(input.sourceId)) : null);
  // Кабинет инвестора — доля, % от прибыли машин (пусто — не инвестор; не передан — прежняя)
  const rawPct = input.investorPercent === undefined ? undefined : String(input.investorPercent ?? '').replace(',', '.').trim();
  const investorPercent = rawPct === undefined ? undefined : rawPct === '' ? null : Number(rawPct);
  if (investorPercent !== undefined && investorPercent !== null && !(investorPercent >= 0 && investorPercent <= 100)) throw new AccessError('bad_percent');
  // Минус по машине за месяц: учитывать в выплатах или обнулять (не передано — прежнее)
  const investorNegative = ['carry', 'zero'].includes(input.investorNegative) ? input.investorNegative : undefined;
  const month = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
  if (input.id) {
    const old = q.staffById.get(Number(input.id));
    if (!old) throw new AccessError('unknown_staff');
    // Нельзя снять последнего админа (иначе в «Доступы» никто не войдёт)
    const losesAdmin = old.role_id === ADMIN_ROLE && old.active && old.email && (role.id !== ADMIN_ROLE || !active || !email);
    if (losesAdmin && portalAdmins() <= 1 && !hasMainAdmins()) throw new AccessError('last_admin');
    q.updateStaff.run(name, email, telegramId, whatsapp, role.id, active, now(), old.id);
    if (rate !== undefined) q.setRate.run(rate || null, old.id);
    if (sourceId !== undefined) q.setSource.run(sourceId, old.id);
    if (investorPercent !== undefined) q.setInvestor.run(investorPercent, investorPercent === null ? null : month, old.id);
    if (investorNegative !== undefined) q.setNegative.run(investorNegative, old.id);
    const changes = {};
    if (sourceId !== undefined && (old.source_id || null) !== sourceId) changes.source = `${old.source_id || '—'} → ${sourceId || '—'}`;
    if (investorPercent !== undefined && (old.investor_percent ?? null) !== investorPercent) changes.investor = `${old.investor_percent ?? '—'} → ${investorPercent ?? '—'}%`;
    if (investorNegative !== undefined && (old.investor_negative || 'carry') !== investorNegative) changes.negative = `${old.investor_negative || 'carry'} → ${investorNegative}`;
    if (rate !== undefined && (old.rate || 0) !== rate) changes.rate = `${old.rate || 0} → ${rate}`;
    if (old.name !== name) changes.name = `${old.name} → ${name}`;
    if ((old.email || null) !== email) changes.email = `${old.email || '—'} → ${email || '—'}`;
    if (old.role_id !== role.id) changes.role = `${old.role_id === ADMIN_ROLE ? 'Админ' : getRole(old.role_id)?.name || old.role_id} → ${role.name}`;
    if (Boolean(old.active) !== Boolean(active)) changes.active = active ? 'on' : 'off';
    if ((old.telegram_id || null) !== telegramId) changes.telegram = true;
    if ((old.whatsapp || null) !== whatsapp) changes.whatsapp = true;
    logChange(by, 'staff.update', { staff: name, ...changes });
    return publicStaff(q.staffById.get(old.id));
  }
  const info = q.addStaff.run(name, email, telegramId, whatsapp, role.id, active, now(), now());
  if (rate) q.setRate.run(rate, Number(info.lastInsertRowid));
  if (sourceId) q.setSource.run(sourceId, Number(info.lastInsertRowid));
  if (investorPercent !== undefined && investorPercent !== null) q.setInvestor.run(investorPercent, month, Number(info.lastInsertRowid));
  if (investorNegative !== undefined) q.setNegative.run(investorNegative, Number(info.lastInsertRowid));
  logChange(by, 'staff.create', { staff: name, role: role.name });
  return publicStaff(q.staffById.get(Number(info.lastInsertRowid)));
}

/**
 * Добавить или обновить сотрудников списком (вставка на вкладке «Доступы»).
 * Строка: «Имя; Роль; Почта; WhatsApp» (можно через табуляцию). Пустые поля не
 * трогают уже записанное. Тот же человек — по почте, иначе по WhatsApp, иначе по имени.
 */
export function importStaffList(text, by, { isAdminEmail }) {
  const result = { added: 0, updated: 0, errors: [] };
  const lines = String(text || '').split(/\r?\n/).slice(0, 300);
  lines.forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const [name = '', roleText = '', emailRaw = '', phone = ''] = line.split(/\t|;/).map((x) => x.trim());
    const email = emailRaw.toLowerCase() || null;
    const whatsapp = digitsOnly(phone) || null;
    const role = roleText ? roleFromText(roleText) : null;
    if (roleText && role === DEFAULT_ROLE && !/^(просмотр|viewer)$/i.test(roleText)) {
      result.errors.push({ line: i + 1, error: 'unknown_role', text: roleText });
      return;
    }
    const all = q.staff.all();
    const same = (email && all.find((r) => r.email === email))
      || (whatsapp && all.find((r) => r.whatsapp === whatsapp))
      || (name && all.find((r) => r.name.toLowerCase() === name.toLowerCase()));
    try {
      if (same) {
        const old = publicStaff(same);
        saveStaff({
          ...old, name: name || old.name, email: email || old.email, whatsapp: whatsapp || old.whatsapp, roleId: role || old.roleId
        }, by, { isAdminEmail });
        result.updated++;
      } else {
        saveStaff({ name, email, whatsapp, roleId: role || DEFAULT_ROLE, active: true }, by, { isAdminEmail });
        result.added++;
      }
    } catch (err) {
      result.errors.push({ line: i + 1, error: err.code || 'failed', text: line.slice(0, 80) });
    }
  });
  return result;
}

export function deleteStaff(id, by) {
  const row = q.staffById.get(Number(id));
  if (!row) throw new AccessError('unknown_staff');
  if (row.role_id === ADMIN_ROLE && row.active && row.email && portalAdmins() <= 1 && !hasMainAdmins()) throw new AccessError('last_admin');
  q.deleteStaff.run(row.id);
  logChange(by, 'staff.delete', { staff: row.name });
}

/** Имя, под которым номер пишет в рабочей группе (из журнала наблюдателя) */
function whatsappName(phone) {
  if (!phone) return null;
  try {
    return db.raw.prepare("SELECT author_name FROM wa_messages WHERE author = ? AND author_name IS NOT NULL AND author_name != '' ORDER BY ts DESC LIMIT 1")
      .get(phone)?.author_name || null;
  } catch {
    return null;
  }
}

/** Всё для вкладки «Доступы» */
export function accessOverview(admins, sources = []) {
  const roleRows = q.roles.all();
  const order = new Map(roleRows.map((r, i) => [r.id, i]));
  // Порядок: по ролям (владелец, финансист, менеджер, …), внутри — по имени
  const staff = q.staff.all().map(publicStaff).map((s) => ({ ...s, waName: whatsappName(s.whatsapp) }))
    .sort((a, b) => (a.roleId === ADMIN_ROLE ? -1 : order.get(a.roleId) ?? 99) - (b.roleId === ADMIN_ROLE ? -1 : order.get(b.roleId) ?? 99) || a.name.localeCompare(b.name));
  const roles = roleRows.map(parseRole).map((r) => ({ ...r, staffCount: staff.filter((s) => s.roleId === r.id).length }));
  const log = q.lastLog.all(40).map((r) => ({ at: r.at, by: r.by, action: r.action, details: JSON.parse(r.details || '{}') }));
  return { sections: SECTIONS, roles, staff, admins, log, sources };
}
