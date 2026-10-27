/**
 * ============================================================================
 * Локальная база бота (SQLite, файл /data/kokon.db в Docker-томе)
 * ============================================================================
 * Здесь живёт то, что нужно боту для работы: заявки, состояние диалогов,
 * настройки (например, какая Telegram-группа — рабочая). Позже заявки будут
 * дублироваться в Google Sheets, чтобы их видели люди.
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'kokon.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    chat_id    TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       TEXT NOT NULL,
    channel          TEXT NOT NULL,
    client_chat_id   TEXT,
    client_name      TEXT,
    client_phone     TEXT,
    vehicle_type     TEXT,
    date_from        TEXT,
    date_to          TEXT,
    comment          TEXT,
    status           TEXT NOT NULL DEFAULT 'new',
    taken_by_id      TEXT,
    taken_by_name    TEXT,
    taken_at         TEXT,
    declined_by      TEXT NOT NULL DEFAULT '',
    staff_chat_id    TEXT,
    staff_message_id INTEGER
  );
`);

const nowIso = () => new Date().toISOString();

/* --- Настройки --- */

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

/* --- Состояние диалога с клиентом --- */

export function getSession(chatId) {
  const row = db.prepare('SELECT state FROM sessions WHERE chat_id = ?').get(String(chatId));
  return row ? JSON.parse(row.state) : null;
}

export function saveSession(chatId, state) {
  db.prepare(`
    INSERT INTO sessions (chat_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
  `).run(String(chatId), JSON.stringify(state), nowIso());
}

export function clearSession(chatId) {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(String(chatId));
}

/* --- Заявки --- */

export function createRequest(data) {
  const result = db.prepare(`
    INSERT INTO requests
      (created_at, channel, client_chat_id, client_name, client_phone, vehicle_type, date_from, date_to, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowIso(),
    data.channel,
    data.clientChatId != null ? String(data.clientChatId) : null,
    data.clientName || null,
    data.clientPhone || null,
    data.vehicleType || null,
    data.dateFrom || null,
    data.dateTo || null,
    data.comment || null
  );
  return getRequest(Number(result.lastInsertRowid));
}

export function getRequest(id) {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(id)) || null;
}

export function setStaffMessage(id, chatId, messageId) {
  db.prepare('UPDATE requests SET staff_chat_id = ?, staff_message_id = ? WHERE id = ?')
    .run(String(chatId), Number(messageId), Number(id));
}

/**
 * Атомарно закрепляет заявку за сотрудником. Возвращает true, только если
 * заявка была свободна — два человека не могут взять одну заявку.
 */
export function takeRequest(id, userId, userName) {
  const result = db.prepare(`
    UPDATE requests SET status = 'taken', taken_by_id = ?, taken_by_name = ?, taken_at = ?
    WHERE id = ? AND status = 'new'
  `).run(String(userId), userName, nowIso(), Number(id));
  return result.changes === 1;
}

export function addDecline(id, userName) {
  const request = getRequest(id);
  if (!request) return null;
  const names = request.declined_by ? request.declined_by.split('\n') : [];
  if (!names.includes(userName)) names.push(userName);
  db.prepare('UPDATE requests SET declined_by = ? WHERE id = ?').run(names.join('\n'), Number(id));
  return getRequest(id);
}

export function moveStaffChat(oldChatId, newChatId) {
  db.prepare('UPDATE requests SET staff_chat_id = ? WHERE staff_chat_id = ?')
    .run(String(newChatId), String(oldChatId));
}
