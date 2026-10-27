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

// Уже обработанные вебхуки (защита от повторной доставки)
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_events (
    key          TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
  );
`);

// Колонки, добавленные после первого запуска: дописываем в существующую базу
const requestColumns = db.prepare('PRAGMA table_info(requests)').all().map((c) => c.name);
for (const [name, type] of [['model', 'TEXT'], ['estimate_thb', 'INTEGER'], ['free_units', 'TEXT'], ['sheet_row', 'INTEGER']]) {
  if (!requestColumns.includes(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
}

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
      (created_at, channel, client_chat_id, client_name, client_phone, vehicle_type, date_from, date_to, comment,
       model, estimate_thb, free_units)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nowIso(),
    data.channel,
    data.clientChatId != null ? String(data.clientChatId) : null,
    data.clientName || null,
    data.clientPhone || null,
    data.vehicleType || null,
    data.dateFrom || null,
    data.dateTo || null,
    data.comment || null,
    data.model || null,
    data.estimateThb || null,
    data.freeUnits || null
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

export function setSheetRow(id, row) {
  db.prepare('UPDATE requests SET sheet_row = ? WHERE id = ?').run(Number(row), Number(id));
}

/** Заявки, которые ещё «держат» технику: новые и взятые в работу */
export function listActiveRequests() {
  return db.prepare("SELECT * FROM requests WHERE status IN ('new', 'taken') AND channel != 'test'").all();
}

/** Отмечает событие обработанным. false — если оно уже было (повтор доставки). */
export function markEventProcessed(key) {
  const result = db.prepare('INSERT OR IGNORE INTO processed_events (key, processed_at) VALUES (?, ?)').run(String(key), nowIso());
  if (Math.random() < 0.01) {
    db.prepare("DELETE FROM processed_events WHERE processed_at < datetime('now', '-3 days')").run();
  }
  return result.changes === 1;
}

/* --- Пауза бота в конкретном чате (менеджер отвечает сам) --- */

export function pauseChat(chatKey, untilIso) {
  setSetting(`pause:${chatKey}`, untilIso);
}

export function isChatPaused(chatKey) {
  const until = getSetting(`pause:${chatKey}`);
  return Boolean(until) && until > nowIso();
}

export function moveStaffChat(oldChatId, newChatId) {
  db.prepare('UPDATE requests SET staff_chat_id = ? WHERE staff_chat_id = ?')
    .run(String(newChatId), String(oldChatId));
}
