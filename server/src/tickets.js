/**
 * ============================================================================
 * Вкладка «Ошибки и предложения»: тикеты от сотрудников
 * ============================================================================
 * Любой сотрудник присылает тикет — ошибку (с готовой причиной на выбор) или
 * предложение, коротко текстом и по желанию со скриншотом. К тикету сами
 * добавляются: кто прислал, на какой вкладке был, время и устройство.
 *
 * Разбирают те, у кого «Ошибки и предложения: меняет» (админ и владелец):
 * статус новый → в работе → сделано / не будем делать и ответ автору.
 * Автору приходит уведомление в Telegram (или письмо), когда статус меняется.
 *
 * Скриншоты лежат НЕ в публичных uploads, а в DATA_DIR/tickets: на них могут
 * быть данные клиентов, поэтому отдаём их только автору и разбирающим.
 *
 *   GET  /api/staff/tickets                 — список (свои или все) и счётчик
 *   GET  /api/staff/tickets/badge           — число для значка на вкладке
 *   POST /api/staff/tickets                 { kind, category, text, tab, device }
 *   POST /api/staff/tickets/shot?id=        — картинка (тело — image/*)
 *   GET  /api/staff/tickets/shot?id=        — картинка
 *   POST /api/staff/tickets/status          { id, status, note }
 *   POST /api/staff/tickets/seen            — автор посмотрел ответы
 *   POST /api/staff/tickets/delete          { id } — убрать (тестовый, дубль)
 * ============================================================================
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, sendJson, readJson, readBody, rateLimiter } from './http.js';
import { can } from './roles.js';
import { activeStaff, getRole } from './access.js';
import { findStaff, adminTelegramIds } from './staffUsers.js';
import { telegramEnabled, sendMessage } from './telegram/api.js';
import { mailEnabled, sendMail } from './mail.js';
import { g } from './groupTexts.js';
import { escapeHtml } from './format.js';

export const KINDS = ['bug', 'idea'];
// Готовые причины для ошибки (утвердил владелец)
export const CATEGORIES = ['not_loading', 'broken_action', 'wrong_data', 'missing_message', 'text', 'slow', 'other'];
export const STATUSES = ['new', 'work', 'done', 'rejected'];
const DEVICE_TYPES = ['phone', 'tablet', 'computer'];

const MAX_TEXT = 2000;
const MAX_NOTE = 1000;
const MAX_SHOT_BYTES = 4 * 1024 * 1024;
const SHOT_WINDOW_MS = 30 * 60 * 1000; // скриншот — сразу после тикета
const LIST_LIMIT = 300;
const SHOTS_DIR = path.join(config.dataDir, 'tickets');
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const createLimiter = rateLimiter(60 * 60 * 1000, 15);

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,
    category       TEXT,
    text           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'new',
    author_email   TEXT NOT NULL,
    author_name    TEXT,
    tab            TEXT,
    device         TEXT,
    user_agent     TEXT,
    shot           TEXT,
    history        TEXT NOT NULL DEFAULT '[]',
    answered_at    TEXT,
    author_seen_at TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tickets_author ON tickets (author_email);
`);

const q = {
  insert: db.raw.prepare(`INSERT INTO tickets (kind, category, text, author_email, author_name, tab, device, user_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  byId: db.raw.prepare('SELECT * FROM tickets WHERE id = ?'),
  all: db.raw.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT ?'),
  mine: db.raw.prepare('SELECT * FROM tickets WHERE author_email = ? ORDER BY id DESC LIMIT ?'),
  setShot: db.raw.prepare('UPDATE tickets SET shot = ?, updated_at = ? WHERE id = ?'),
  setStatus: db.raw.prepare('UPDATE tickets SET status = ?, history = ?, answered_at = ?, updated_at = ? WHERE id = ?'),
  seen: db.raw.prepare('UPDATE tickets SET author_seen_at = ? WHERE author_email = ? AND answered_at IS NOT NULL'),
  remove: db.raw.prepare('DELETE FROM tickets WHERE id = ?'),
  countNew: db.raw.prepare("SELECT COUNT(*) n FROM tickets WHERE status = 'new'"),
  countUnseen: db.raw.prepare(`SELECT COUNT(*) n FROM tickets WHERE author_email = ? AND answered_at IS NOT NULL
    AND (author_seen_at IS NULL OR author_seen_at < answered_at)`)
};

const now = () => new Date().toISOString();
const clip = (value, max) => String(value ?? '').replace(/\s+$/g, '').slice(0, max);
const oneLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const canHandle = (staff) => can(staff, 'tickets.edit');

/** Устройство из того, что прислал портал: только короткие безопасные строки */
function cleanDevice(input) {
  const d = input && typeof input === 'object' ? input : {};
  return {
    type: DEVICE_TYPES.includes(d.type) ? d.type : 'computer',
    os: oneLine(d.os, 40),
    browser: oneLine(d.browser, 40),
    screen: /^\d{2,5}×\d{2,5}$/.test(String(d.screen || '')) ? d.screen : '',
    installed: Boolean(d.installed),
    lang: /^[a-z]{2}$/.test(String(d.lang || '')) ? d.lang : '',
    version: oneLine(d.version, 20)
  };
}

function publicTicket(row, viewer) {
  const history = JSON.parse(row.history || '[]');
  const own = row.author_email === viewer.email;
  return {
    id: row.id,
    kind: row.kind,
    category: row.category || null,
    text: row.text,
    status: row.status,
    author: { name: row.author_name || row.author_email, email: canHandle(viewer) ? row.author_email : undefined },
    own,
    tab: row.tab || null,
    device: JSON.parse(row.device || '{}'),
    hasShot: Boolean(row.shot),
    history: history.map((h) => ({ at: h.at, by: h.byName || h.by, status: h.status || null, note: h.note || '' })),
    unseen: own && Boolean(row.answered_at) && (!row.author_seen_at || row.author_seen_at < row.answered_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ticketFor(staff, id) {
  const row = q.byId.get(Number(id) || 0);
  if (!row) throw new HttpError(404, 'ticket_not_found');
  if (!canHandle(staff) && row.author_email !== staff.email) throw new HttpError(404, 'ticket_not_found');
  return row;
}

/** Число на значке вкладки: разбирающим — новые тикеты, автору — непрочитанные ответы */
function badge(staff) {
  return canHandle(staff) ? q.countNew.get().n : q.countUnseen.get(staff.email).n;
}

/* ---------------------------------------------------------------- Маршруты */

export function listTickets(staff, req, res) {
  const rows = canHandle(staff) ? q.all.all(LIST_LIMIT) : q.mine.all(staff.email, LIST_LIMIT);
  sendJson(res, 200, {
    canHandle: canHandle(staff),
    kinds: KINDS, categories: CATEGORIES, statuses: STATUSES,
    tickets: rows.map((r) => publicTicket(r, staff)),
    badge: badge(staff)
  });
}

export function ticketsBadge(staff, req, res) {
  sendJson(res, 200, { count: badge(staff), handler: canHandle(staff) });
}

export async function createTicket(staff, req, res) {
  const body = await readJson(req);
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) throw new HttpError(400, 'ticket_kind_required');
  const category = kind === 'bug' ? (CATEGORIES.includes(body.category) ? body.category : null) : null;
  if (kind === 'bug' && !category) throw new HttpError(400, 'ticket_category_required');
  const text = clip(body.text, MAX_TEXT).trim();
  if (text.length < 3) throw new HttpError(400, 'ticket_text_required');
  if (!createLimiter.hit(staff.email)) throw new HttpError(429, 'too_many_requests');

  const tab = /^[a-z]{2,20}$/.test(String(body.tab || '')) ? body.tab : null;
  const device = cleanDevice(body.device);
  const at = now();
  const { lastInsertRowid } = q.insert.run(kind, category, text, staff.email, staff.name || staff.email, tab,
    JSON.stringify(device), oneLine(req.headers['user-agent'], 300), at, at);
  const row = q.byId.get(Number(lastInsertRowid));
  console.log(`Ticket #${row.id} (${kind}${category ? `/${category}` : ''}) from ${staff.email}`);
  // Скриншот догружается отдельным запросом — оповещаем, когда тикет уже есть
  notifyHandlers(row, staff).catch((err) => console.error(`Ticket #${row.id} notify failed:`, err.message));
  sendJson(res, 200, { ticket: publicTicket(row, staff) });
}

/** Первые байты файла совпадают с заявленным типом картинки */
function looksLike(buffer, ext) {
  if (ext === 'jpg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === 'png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

/** POST …/shot?id= — скриншот к своему только что созданному тикету (один раз) */
export async function uploadShot(staff, req, res, url) {
  const row = ticketFor(staff, url.searchParams.get('id'));
  if (row.author_email !== staff.email) throw new HttpError(403, 'not_author');
  if (row.shot) throw new HttpError(409, 'shot_exists');
  if (Date.now() - Date.parse(row.created_at) > SHOT_WINDOW_MS) throw new HttpError(409, 'shot_too_late');
  const ext = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw new HttpError(415, 'image_required');
  const body = await readBody(req, MAX_SHOT_BYTES);
  if (body.length < 100 || !looksLike(body, ext)) throw new HttpError(400, 'bad_image');

  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const name = `${row.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(SHOTS_DIR, name), body);
  q.setShot.run(name, now(), row.id);
  sendJson(res, 200, { ok: true });
}

/** GET …/shot?id= — скриншот только автору и разбирающим */
export function getShot(staff, req, res, url) {
  const row = ticketFor(staff, url.searchParams.get('id'));
  if (!row.shot || !/^\d+-[0-9a-f]{12}\.(jpg|png|webp)$/.test(row.shot)) throw new HttpError(404, 'no_shot');
  const file = path.join(SHOTS_DIR, row.shot);
  if (!fs.existsSync(file)) throw new HttpError(404, 'no_shot');
  const ext = row.shot.split('.').pop();
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext], 'Content-Length': fs.statSync(file).size,
    'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(file).pipe(res);
}

/** POST …/status { id, status, note } — новый статус и/или ответ автору */
export async function setTicketStatus(staff, req, res) {
  if (!canHandle(staff)) throw new HttpError(403, 'read_only');
  const body = await readJson(req);
  const row = ticketFor(staff, body.id);
  const status = body.status ? (STATUSES.includes(body.status) ? body.status : null) : row.status;
  if (!status) throw new HttpError(400, 'bad_status');
  const note = clip(body.note, MAX_NOTE).trim();
  const statusChanged = status !== row.status;
  if (!statusChanged && !note) throw new HttpError(400, 'nothing_to_save');

  const at = now();
  const history = JSON.parse(row.history || '[]');
  history.push({ at, by: staff.email, byName: staff.name || staff.email, status: statusChanged ? status : null, note });
  q.setStatus.run(status, JSON.stringify(history), at, at, row.id);
  console.log(`Ticket #${row.id}: ${statusChanged ? `${row.status} → ${status}` : 'note'} by ${staff.email}`);
  const updated = q.byId.get(row.id);
  if (updated.author_email !== staff.email) {
    notifyAuthor(updated, { status: statusChanged ? status : null, note, by: staff.name || staff.email })
      .catch((err) => console.error(`Ticket #${row.id} author notify failed:`, err.message));
  }
  sendJson(res, 200, { ticket: publicTicket(updated, staff) });
}

export function markSeen(staff, req, res) {
  q.seen.run(now(), staff.email);
  sendJson(res, 200, { ok: true });
}

/** POST …/delete { id } — убрать тикет (тестовый, дубль); скриншот тоже */
export async function deleteTicket(staff, req, res) {
  if (!canHandle(staff)) throw new HttpError(403, 'read_only');
  const { id } = await readJson(req);
  const row = ticketFor(staff, id);
  if (row.shot) fs.rmSync(path.join(SHOTS_DIR, row.shot), { force: true });
  q.remove.run(row.id);
  console.log(`Ticket #${row.id} deleted by ${staff.email}`);
  sendJson(res, 200, { ok: true });
}

/* -------------------------------------------------------------- Оповещения */

const link = () => `${config.staff.url}/#tickets`;
const short = (text, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const what = (row) => (row.kind === 'bug' ? g(`tk.cat.${row.category || 'other'}`) : g('tk.idea'));

/** Кто разбирает: админы из таблицы и сотрудники с правом «меняет» — у кого есть Telegram */
async function handlerChats(exceptEmail) {
  const chats = new Set(await adminTelegramIds().catch(() => []));
  for (const s of activeStaff()) {
    if (!s.telegramId || s.email === exceptEmail) continue;
    if (getRole(s.roleId)?.perms.tickets === 'edit') chats.add(String(s.telegramId));
  }
  const author = exceptEmail ? await findStaff(exceptEmail).catch(() => null) : null;
  if (author?.telegramId) chats.delete(String(author.telegramId));
  return [...chats];
}

async function notifyHandlers(row, author) {
  if (!telegramEnabled) return;
  const device = JSON.parse(row.device || '{}');
  const text = [
    g(row.kind === 'bug' ? 'tk.newBug' : 'tk.newIdea', { id: row.id, name: escapeHtml(author.name || author.email), what: escapeHtml(what(row)) }),
    `«${escapeHtml(short(row.text))}»`,
    [row.tab ? g('tk.where', { tab: g(`tk.tab.${row.tab}`) }) : '', g(`tk.device.${device.type || 'computer'}`)].filter(Boolean).join(' · '),
    '',
    `👉 ${link()}`
  ].join('\n');
  for (const chatId of await handlerChats(row.author_email)) {
    await sendMessage(chatId, text, { disable_web_page_preview: true })
      .catch((err) => console.error(`Ticket #${row.id} alert to ${chatId} failed:`, err.message));
  }
}

async function notifyAuthor(row, { status, note, by }) {
  const lines = [g('tk.answer', { id: row.id, what: escapeHtml(what(row)) })];
  if (status) lines.push(g('tk.statusNow', { status: g(`tk.st.${status}`) }));
  if (note) lines.push(g('tk.note', { name: escapeHtml(by), note: escapeHtml(short(note, 800)) }));
  lines.push(`«${escapeHtml(short(row.text, 200))}»`, '', `👉 ${link()}`);
  const text = lines.join('\n');

  const author = await findStaff(row.author_email).catch(() => null);
  if (telegramEnabled && author?.telegramId) {
    try {
      await sendMessage(author.telegramId, text, { disable_web_page_preview: true });
      return;
    } catch (err) {
      // Бот может написать только тому, кто хоть раз нажал у него «Старт» — тогда письмом
      console.error(`Ticket #${row.id}: Telegram to the author failed (${err.message}), sending e-mail`);
    }
  }
  if (!mailEnabled) return;
  const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  await sendMail({ to: row.author_email, subject: g('tk.mailSubject', { id: row.id, status: g(`tk.st.${row.status}`) }), text: plain });
}
