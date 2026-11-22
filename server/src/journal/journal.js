/**
 * ============================================================================
 * Журнал рабочей группы WhatsApp: сообщения → операции, фото, табель смен
 * ============================================================================
 * Источники сообщений:
 *   live   — наблюдатель (observer/) читает группу через WhatsApp Web;
 *   export — история из файла «Экспорт чата» (загружает админ в портале).
 * Каждое сообщение разбирается (parse.js) и хранится вместе с разбором:
 * вид операции, госномера, поля. Ошибку разбора сотрудник может исправить
 * в портале — исправленное больше не перезаписывается.
 * Фото (только live) привязываются к отчёту: сотрудники сначала шлют альбом,
 * потом отвечают на него текстом. Фото к броням, выдачам и заменам могут
 * содержать паспорт и договор — их удаляем через 90 дней после возврата
 * машины; остальные храним год.
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as db from '../db.js';
import { parseMessage } from './parse.js';
import { parseExport } from './exportImport.js';

// Увеличивайте при изменении parse.js — при старте сервер переразберёт старые сообщения
export const PARSER_VERSION = 1;

export const OPERATION_KINDS = ['booking', 'issue', 'return', 'pickup_task', 'change_task', 'changed', 'reschedule', 'extension', 'payment', 'service'];
export const SHIFT_KINDS = ['shift_start', 'shift_end'];
// Отчёты, к фото которых могут попасть паспорт и договор
const SENSITIVE_KINDS = new Set(['booking', 'issue', 'changed']);
const SENSITIVE_KEEP_DAYS = 90;
const MEDIA_KEEP_DAYS = 365;
const DAY_MS = 86400000;
const BANGKOK_MS = 7 * 3600000;

export const mediaDir = path.join(config.dataDir, 'wa-media');

const q = {
  insert: db.raw.prepare(`
    INSERT OR IGNORE INTO wa_messages (id, source, ts, author, author_name, text, media_count, quoted_id, album_id, kind, status, data, parser)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  plate: db.raw.prepare('INSERT OR IGNORE INTO wa_message_plates (message_id, plate, role) VALUES (?, ?, ?)'),
  clearPlates: db.raw.prepare('DELETE FROM wa_message_plates WHERE message_id = ?'),
  get: db.raw.prepare('SELECT * FROM wa_messages WHERE id = ?'),
  stale: db.raw.prepare('SELECT id, ts, text FROM wa_messages WHERE parser < ? AND edited_by IS NULL'),
  update: db.raw.prepare('UPDATE wa_messages SET kind = ?, status = ?, data = ?, parser = ? WHERE id = ?'),
  fix: db.raw.prepare('UPDATE wa_messages SET kind = ?, status = ?, data = ?, edited_by = ?, edited_at = ? WHERE id = ?'),
  media: db.raw.prepare('SELECT id, message_id, report_id, mime, sensitive FROM wa_media WHERE report_id = ? OR message_id = ? ORDER BY id'),
  mediaById: db.raw.prepare('SELECT * FROM wa_media WHERE id = ?'),
  addMedia: db.raw.prepare('INSERT INTO wa_media (message_id, report_id, file, mime, bytes, created_at, sensitive, delete_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  linkQuoted: db.raw.prepare(`
    UPDATE wa_media SET report_id = ?, sensitive = ?, delete_after = CASE WHEN ? = 1 THEN NULL ELSE delete_after END
    WHERE report_id IS NULL AND (message_id = ? OR message_id IN (SELECT id FROM wa_messages WHERE album_id = ?))`),
  linkRecent: db.raw.prepare(`
    UPDATE wa_media SET report_id = ?, sensitive = ?, delete_after = CASE WHEN ? = 1 THEN NULL ELSE delete_after END
    WHERE report_id IS NULL AND message_id IN (
      SELECT id FROM wa_messages WHERE author = ? AND kind = 'media' AND ts BETWEEN ? AND ?)`),
  waitingReport: db.raw.prepare(`
    SELECT id, kind FROM wa_messages WHERE (quoted_id = ? OR quoted_id = ?) AND kind != 'media' ORDER BY ts LIMIT 1`)
};

const sha = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 24);

const stripPlaceholders = (text) => String(text || '')
  .replace(/<(image|video|audio|sticker|document|gif) omitted>|<attached:[^>]*>/gi, '')
  // «<Без медиафайлов>», «<Media omitted>», «<Сообщение изменено>» (Android, другие языки)
  // и прочие пометки выгрузки: «<album message>», «<unknown message>», «<Без медиафайлов>»…
  .replace(/<[^<>\n]{2,40}>/g, '')
  .trim();

/**
 * «Отпечаток» текста для поиска одного и того же сообщения в живых данных и в
 * выгрузке. Тексты там отличаются мелочами: упоминания («@~Nic» в выгрузке,
 * «@66…» у наблюдателя), служебные пометки, пробелы и знаки — их не учитываем.
 */
export function textKey(text) {
  return String(text || '')
    .replace(/<[^<>\n]{2,40}>/g, ' ')
    .replace(/@\u2068[^\u2069]*\u2069/g, ' ')
    .replace(/@\S+/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Один и тот же ли это текст. Разные выгрузки по-разному пишут упоминания
 * («@~Rungchai Bum», «@Kokon Car») — поэтому допускаем одно небольшое различие
 * внутри текста. Сообщения из одних эмодзи, знаков и упоминаний — без упоминаний.
 */
export function sameText(a, b) {
  const ka = textKey(a);
  const kb = textKey(b);
  if (!ka || !kb) {
    // Одни эмодзи, знаки или упоминания: сравниваем то, что осталось без упоминаний
    const raw = (t) => String(t || '').replace(/<[^<>\n]{2,40}>/g, '').replace(/@\u2068[^\u2069]*\u2069/g, '').replace(/@\S+/g, '').replace(/\s+/g, '');
    return !ka && !kb && raw(a) === raw(b);
  }
  if (ka === kb) return true;
  if (Math.min(ka.length, kb.length) < 24) return false;
  // Отличаются только в одном месте и не больше чем на 16 знаков (остаток упоминания)
  const n = Math.min(ka.length, kb.length);
  let head = 0;
  while (head < n && ka[head] === kb[head]) head++;
  let tail = 0;
  while (tail < n - head && ka[ka.length - 1 - tail] === kb[kb.length - 1 - tail]) tail++;
  if (Math.max(ka.length, kb.length) - (head + tail) <= 16) return true;
  // Длинные отчёты: несколько мелких различий (упоминания вида «@Alexey Kokon Car»,
  // ссылки в другом виде) — сравниваем по парам соседних знаков
  return n >= 60 && dice(ka, kb) >= 0.9;
}

/** Похожесть строк 0…1 по парам соседних знаков (коэффициент Дайса) */
function dice(a, b) {
  const pairs = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const p = a.slice(i, i + 2);
    pairs.set(p, (pairs.get(p) || 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const p = b.slice(i, i + 2);
    const left = pairs.get(p);
    if (left) { common++; pairs.set(p, left - 1); }
  }
  return (2 * common) / (a.length + b.length - 2);
}

const WINDOW_MS = 180000;

/** Автор для сравнения выгрузок: номер — цифрами, имя — строчными буквами */
const authorKey = (author) => {
  const digits = String(author || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : String(author || '').trim().toLowerCase();
};

/** Уже есть то же сообщение того же автора из выгрузки (±90 секунд: в выгрузке Android время до минуты) */
function exportTwin(ts, author, text, batch) {
  const at = Date.parse(ts);
  const who = authorKey(author);
  // Сообщения из этой же выгрузки не сравниваем: повтор отчёта с исправлением — отдельное сообщение
  return db.raw.prepare("SELECT id, author, author_name, text FROM wa_messages WHERE source = 'export' AND ts BETWEEN ? AND ?")
    .all(new Date(at - 90000).toISOString(), new Date(at + 90000).toISOString())
    .some((row) => !batch.has(row.id) && sameText(row.text, text) && (authorKey(row.author) === who || authorKey(row.author_name) === who));
}
// Такие строки выгрузки наблюдатель передаёт без текста (место, опрос, контакт,
// файл) — по ним проверку не делаем, иначе будут ложные «пропущено»
const NOT_AUDITED = /^(location:|live location|poll:|contact card|.*\.vcf\b|.*\(file attached\)|<attached:)/i;
/** Авторы совместимы: если у обоих номер — номера совпадают; имя из контактов сверить нельзя */
const sameAuthor = (a, b) => {
  const ka = authorKey(a);
  const kb = authorKey(b);
  return !/^\d+$/.test(ka) || !/^\d+$/.test(kb) || ka === kb;
};

const twinsOf = (source, ts, text, author = null) => {
  const at = Date.parse(ts);
  return db.raw.prepare('SELECT id, author, text FROM wa_messages WHERE source = ? AND ts BETWEEN ? AND ?')
    .all(source, new Date(at - WINDOW_MS).toISOString(), new Date(at + WINDOW_MS).toISOString())
    .filter((row) => sameText(row.text, text) && (!author || sameAuthor(row.author, author)));
};

function savePlates(id, plates) {
  q.clearPlates.run(id);
  for (const p of plates || []) q.plate.run(id, p.plate, p.role);
}

/**
 * Сохранить сообщение. msg: { id, source, ts, author, authorName, text,
 * mediaCount, quotedId, albumId }. Возвращает разбор или null, если уже было.
 */
export function storeMessage(msg) {
  const parsed = parseMessage(msg.text, new Date(msg.ts));
  // Живое сообщение главнее копии из выгрузки (у живого есть фото): копию убираем
  if (msg.source === 'live' && msg.text) {
    for (const twin of twinsOf('export', msg.ts, msg.text, msg.author)) {
      q.clearPlates.run(twin.id);
      db.raw.prepare('DELETE FROM wa_messages WHERE id = ?').run(twin.id);
    }
  }
  const data = JSON.stringify({ plates: parsed.plates, fields: parsed.fields });
  const result = q.insert.run(
    msg.id, msg.source, msg.ts, String(msg.author || ''), msg.authorName || null, msg.text || '',
    msg.mediaCount || 0, msg.quotedId || null, msg.albumId || null, parsed.kind, parsed.status, data, PARSER_VERSION
  );
  if (!result.changes) return null;
  savePlates(msg.id, parsed.plates);
  if (msg.source === 'live' && parsed.kind !== 'media') linkMedia({ ...msg, kind: parsed.kind });
  return parsed;
}

/** Сотрудник отредактировал сообщение в WhatsApp — переразбираем (если его не исправляли вручную) */
export function editMessage(id, text) {
  const row = q.get.get(id);
  if (!row || row.edited_by) return false;
  const parsed = parseMessage(text, new Date(row.ts));
  db.raw.prepare('UPDATE wa_messages SET text = ?, kind = ?, status = ?, data = ?, parser = ? WHERE id = ?')
    .run(text, parsed.kind, parsed.status, JSON.stringify({ plates: parsed.plates, fields: parsed.fields }), PARSER_VERSION, id);
  savePlates(id, parsed.plates);
  return true;
}

/** Сообщение удалили в группе — в журнале оно больше не считается */
export function revokeMessage(id) {
  return Number(db.raw.prepare("UPDATE wa_messages SET status = 'ignored' WHERE id = ?").run(id).changes) > 0;
}

/* --------------------------------------------------------- Фото */

/** Отчёт пришёл: привязываем фото, на которые он ответил, или альбом того же автора за 15 минут до */
function linkMedia(report) {
  const sensitive = SENSITIVE_KINDS.has(report.kind) ? 1 : 0;
  let linked = 0;
  if (report.quotedId) linked = Number(q.linkQuoted.run(report.id, sensitive, sensitive, report.quotedId, report.quotedId).changes);
  if (!linked && OPERATION_KINDS.includes(report.kind)) {
    const at = Date.parse(report.ts);
    linked = Number(q.linkRecent.run(report.id, sensitive, sensitive, report.author,
      new Date(at - 15 * 60000).toISOString(), report.ts).changes);
  }
  // Подпись прямо под фото: само сообщение и есть фото отчёта
  db.raw.prepare('UPDATE wa_media SET report_id = ?, sensitive = ?, delete_after = CASE WHEN ? = 1 THEN NULL ELSE delete_after END WHERE message_id = ? AND report_id IS NULL')
    .run(report.id, sensitive, sensitive, report.id);
  return linked;
}

/** Фото от наблюдателя: файл на диск, запись в базу; если отчёт уже пришёл — сразу к нему */
export function saveMedia(messageId, buffer, mime) {
  const message = q.get.get(messageId);
  if (!message) throw new Error('unknown_message');
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime?.startsWith('video/') ? 'mp4' : 'jpg';
  const month = message.ts.slice(0, 7);
  const name = `${sha(`${messageId}:${Date.now()}:${Math.random()}`)}.${ext}`;
  fs.mkdirSync(path.join(mediaDir, month), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, month, name), buffer);
  const report = q.waitingReport.get(messageId, message.album_id || messageId);
  const sensitive = report && SENSITIVE_KINDS.has(report.kind) ? 1 : 0;
  const deleteAfter = sensitive ? null : new Date(Date.parse(message.ts) + MEDIA_KEEP_DAYS * DAY_MS).toISOString();
  const info = q.addMedia.run(messageId, report?.id || null, `${month}/${name}`, mime || 'image/jpeg', buffer.length,
    new Date().toISOString(), sensitive, deleteAfter);
  return Number(info.lastInsertRowid);
}

export function mediaFile(id) {
  const row = q.mediaById.get(Number(id));
  if (!row) return null;
  const file = path.join(mediaDir, row.file);
  return file.startsWith(mediaDir + path.sep) && fs.existsSync(file) ? { ...row, path: file } : null;
}

/**
 * Сроки хранения: фото к выдаче / брони / замене удаляем через 90 дней после
 * возврата этой машины (паспорта, договоры), остальные — через год.
 */
export function applyMediaRetention(now = Date.now()) {
  const pending = db.raw.prepare(`
    SELECT wa_media.id, m.ts, p.plate FROM wa_media
    JOIN wa_messages m ON m.id = wa_media.report_id
    JOIN wa_message_plates p ON p.message_id = m.id AND p.role IN ('main', 'to')
    WHERE wa_media.sensitive = 1 AND wa_media.delete_after IS NULL`).all();
  const returned = db.raw.prepare(`
    SELECT m.ts FROM wa_messages m JOIN wa_message_plates p ON p.message_id = m.id
    WHERE p.plate = ? AND m.ts > ? AND (m.kind = 'return' OR (m.kind = 'changed' AND p.role = 'from'))
    ORDER BY m.ts LIMIT 1`);
  const setDelete = db.raw.prepare('UPDATE wa_media SET delete_after = ? WHERE id = ?');
  for (const row of pending) {
    const ret = returned.get(row.plate, row.ts);
    if (ret) setDelete.run(new Date(Date.parse(ret.ts) + SENSITIVE_KEEP_DAYS * DAY_MS).toISOString(), row.id);
  }
  const expired = db.raw.prepare('SELECT id, file FROM wa_media WHERE delete_after IS NOT NULL AND delete_after < ?')
    .all(new Date(now).toISOString());
  const remove = db.raw.prepare('DELETE FROM wa_media WHERE id = ?');
  for (const row of expired) {
    try { fs.rmSync(path.join(mediaDir, row.file), { force: true }); } catch { /* уже нет */ }
    remove.run(row.id);
  }
  return expired.length;
}

/* ------------------------------------------------- История из выгрузки */

/** Загрузка «Экспорта чата»: повторная загрузка того же файла ничего не задвоит */
export function importExport(rawText, staff, now = Date.now()) {
  const { messages } = parseExport(rawText);
  // Период выгрузки — по самим сообщениям (по нему же закрываются «не прочитано»)
  const times = messages.map((m) => m.ts).sort();
  const from = times[0] || null;
  const to = times[times.length - 1] || null;
  let added = 0;
  let skipped = 0;
  let operations = 0;
  // Проверка наблюдателя: сообщения выгрузки за время, когда он читал группу
  // (с небольшим запасом по краям), должны найтись среди живых
  const since = liveSince();
  const auditFrom = since ? since + 5 * 60000 : null;
  const auditTo = now - 5 * 60000;
  let checked = 0;
  const missed = [];
  const batch = new Set();
  // Выгрузка с Android «без медиа» теряет подписи к фото (а отчёты — почти всегда подписи)
  const bareMedia = messages.filter((m) => /^<[^<>\n]{2,40}>$/.test(m.text.trim())).length;
  const withCaption = messages.filter((m) => /^<[^<>\n]{2,40}>\s*\S/.test(m.text.trim())).length;
  const captionsLost = bareMedia >= 30 && withCaption === 0;
  db.raw.exec('BEGIN');
  try {
    for (const m of messages) {
      const text = stripPlaceholders(m.text);
      const mediaCount = (m.text.match(/<(image|video) omitted>|<attached:/gi) || []).length;
      // Фото без подписи в выгрузке бесполезны: самих файлов в ней нет
      if (!text) { skipped++; continue; }
      // То же сообщение уже пришло от наблюдателя
      const at = Date.parse(m.ts);
      const audited = auditFrom && at >= auditFrom && at <= auditTo && textKey(text) && !NOT_AUDITED.test(text);
      if (audited) checked++;
      if (twinsOf('live', m.ts, text, m.author).length) { skipped++; continue; }
      if (audited) missed.push(m.ts);
      // То же сообщение из другой выгрузки (другое устройство — время до минуты, другой id)
      if (exportTwin(m.ts, m.author, text, batch)) { skipped++; continue; }
      const id = `x:${sha(`${m.ts}|${m.author}|${text}`)}`;
      batch.add(id);
      const parsed = storeMessage({
        id, source: 'export', ts: m.ts,
        author: /^\+?[\d\s()-]{8,}$/.test(m.author) ? m.author.replace(/\D/g, '') : m.author,
        authorName: /^\+?[\d\s()-]{8,}$/.test(m.author) ? null : m.author,
        text, mediaCount
      });
      if (!parsed) { skipped++; continue; }
      added++;
      if (OPERATION_KINDS.includes(parsed.kind)) operations++;
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  const audit = auditFrom && checked ? { from: new Date(auditFrom).toISOString(), checked, missed: missed.length, missedAt: missed.slice(-20) } : null;
  const result = { added, skipped, operations, from, to, total: messages.length, audit, captionsLost };
  db.setSetting('journal_import', JSON.stringify({ ...result, at: new Date().toISOString(), by: staff?.email || null }));
  return result;
}

/** После улучшения разбора — переразобрать старые сообщения (кроме исправленных вручную) */
export function reparseStale() {
  const rows = q.stale.all(PARSER_VERSION);
  if (!rows.length) return 0;
  db.raw.exec('BEGIN');
  try {
    for (const row of rows) {
      const parsed = parseMessage(row.text, new Date(row.ts));
      q.update.run(parsed.kind, parsed.status, JSON.stringify({ plates: parsed.plates, fields: parsed.fields }), PARSER_VERSION, row.id);
      savePlates(row.id, parsed.plates);
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

/* ----------------------------------------------------------- Чтение */

const displayAuthor = (row, phones) => phones.get(row.author) || row.author_name || (/^\d{8,}$/.test(row.author) ? `+${row.author}` : row.author);

/** Сообщение для портала; без права journal.private — без фото, контакта и исходного текста */
export function toEvent(row, phones, privateOk) {
  const data = JSON.parse(row.data || '{}');
  const fields = { ...(data.fields || {}) };
  if (!privateOk) delete fields.contact;
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    status: row.status,
    source: row.source,
    author: displayAuthor(row, phones),
    plates: data.plates || [],
    fields,
    text: privateOk ? row.text : undefined,
    edited: row.edited_by ? { by: row.edited_by, at: row.edited_at } : undefined,
    media: privateOk ? q.media.all(row.id, row.id).map((m) => ({ id: m.id, mime: m.mime })) : [],
    mediaCount: row.media_count
  };
}

/**
 * Лента: операции (или выбранные виды), новые сверху.
 * filter: { kinds, plate, author, q, before, limit, status }
 */
export function listMessages(filter = {}) {
  const where = [];
  const params = [];
  const kinds = filter.kinds?.length ? filter.kinds : OPERATION_KINDS;
  where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
  params.push(...kinds);
  if (filter.status) { where.push('status = ?'); params.push(filter.status); } else where.push("status != 'ignored'");
  // Фото из выгрузки — без самих файлов, в ленте от них толку нет
  if (kinds.includes('media')) where.push("NOT (kind = 'media' AND source = 'export')");
  if (filter.plate) { where.push('id IN (SELECT message_id FROM wa_message_plates WHERE plate = ?)'); params.push(String(filter.plate).replace(/\D/g, '')); }
  if (filter.author) { where.push('(author = ? OR author_name = ?)'); params.push(filter.author, filter.author); }
  if (filter.q) { where.push('text LIKE ?'); params.push(`%${String(filter.q).slice(0, 60)}%`); }
  if (filter.before) { where.push('ts < ?'); params.push(filter.before); }
  if (filter.from) { where.push('ts >= ?'); params.push(filter.from); }
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  return db.raw.prepare(`SELECT * FROM wa_messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`).all(...params);
}

export function counts() {
  const rows = db.raw.prepare(`SELECT kind, status, COUNT(*) n FROM wa_messages GROUP BY kind, status`).all();
  const result = { review: 0, operations: 0, shifts: 0, messages: 0 };
  for (const r of rows) {
    result.messages += r.n;
    if (OPERATION_KINDS.includes(r.kind) && r.status !== 'ignored') result.operations += r.n;
    if (OPERATION_KINDS.includes(r.kind) && r.status === 'review') result.review += r.n;
    if (SHIFT_KINDS.includes(r.kind)) result.shifts += r.n;
  }
  const range = db.raw.prepare('SELECT MIN(ts) a, MAX(ts) b FROM wa_messages').get();
  return { ...result, from: range.a, to: range.b };
}

/**
 * Исправление разбора сотрудником: вид, госномер (для замены — откуда и куда),
 * статус ('ok' или 'ignored' — «не операция»). Исправленное сообщение больше
 * не переразбирается автоматически.
 */
export function fixMessage(id, change, staff) {
  const row = q.get.get(id);
  if (!row) return null;
  const data = JSON.parse(row.data || '{}');
  const kind = [...OPERATION_KINDS, ...SHIFT_KINDS, 'note'].includes(change.kind) ? change.kind : row.kind;
  const digits = (v) => String(v || '').replace(/\D/g, '').slice(0, 5);
  let plates = data.plates || [];
  if (kind === 'changed' || kind === 'change_task') {
    if (change.plateFrom !== undefined || change.plateTo !== undefined) {
      plates = [
        digits(change.plateFrom) && { plate: digits(change.plateFrom), role: 'from', model: null },
        digits(change.plateTo) && { plate: digits(change.plateTo), role: 'to', model: null }
      ].filter(Boolean);
    }
  } else if (change.plate !== undefined) {
    const model = plates.find((p) => p.role === 'main')?.model || null;
    plates = digits(change.plate) ? [{ plate: digits(change.plate), role: 'main', model }] : [];
  }
  const status = change.status === 'ignored' ? 'ignored' : 'ok';
  q.fix.run(kind, status, JSON.stringify({ plates, fields: data.fields || {} }), staff.email, new Date().toISOString(), id);
  savePlates(id, plates);
  return q.get.get(id);
}

/* ------------------------------------------------------------- Табель */

const bangkokDate = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(0, 10);

/**
 * Табель за месяц ('2026-11'): по каждому сотруднику и дню — первая отметка
 * «Morning» и последняя «Good night / Evening». Отметка конца смены до 05:00
 * относится к предыдущему дню.
 */
export function timesheet(month, phones) {
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) - BANGKOK_MS;
  const end = Date.UTC(y, m, 1) - BANGKOK_MS + 5 * 3600000;
  const rows = db.raw.prepare(`SELECT ts, author, author_name, kind FROM wa_messages
    WHERE kind IN ('shift_start', 'shift_end') AND status != 'ignored' AND ts >= ? AND ts < ? ORDER BY ts`)
    .all(new Date(start).toISOString(), new Date(end).toISOString());
  const people = new Map();
  for (const row of rows) {
    const at = Date.parse(row.ts);
    const local = new Date(at + BANGKOK_MS);
    let date = bangkokDate(at);
    if (row.kind === 'shift_end' && local.getUTCHours() < 5) date = bangkokDate(at - DAY_MS);
    if (!date.startsWith(month)) continue;
    const name = displayAuthor(row, phones);
    if (!people.has(name)) people.set(name, {});
    const day = people.get(name)[date] ||= { start: null, end: null };
    if (row.kind === 'shift_start' && (!day.start || row.ts < day.start)) day.start = row.ts;
    if (row.kind === 'shift_end' && (!day.end || row.ts > day.end)) day.end = row.ts;
  }
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    month,
    days: Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
    people: [...people].map(([name, days]) => {
      let hours = 0;
      let full = 0;
      for (const d of Object.values(days)) {
        if (d.start && d.end && d.end > d.start) {
          d.hours = Math.round(((Date.parse(d.end) - Date.parse(d.start)) / 3600000) * 10) / 10;
          hours += d.hours;
          full++;
        }
      }
      return { name, days, daysMarked: Object.keys(days).length, daysFull: full, hours: Math.round(hours * 10) / 10 };
    }).sort((a, b) => b.daysMarked - a.daysMarked || a.name.localeCompare(b.name))
  };
}

/* ------------------------------------------------- Состояние наблюдателя */

/**
 * С какого момента наблюдатель читает группу без перерыва: сверку с WS по
 * отчётам раньше этого времени не делаем (за перерыв в журнале могут быть дыры)
 */
/** Сколько сообщений группы наблюдатель передал сегодня (по Бангкоку) */
export function liveToday(now = Date.now()) {
  const dayStart = Math.floor((now + 7 * 3600000) / 86400000) * 86400000 - 7 * 3600000;
  const row = db.raw.prepare("SELECT COUNT(*) n FROM wa_messages WHERE source = 'live' AND ts >= ?").get(new Date(dayStart).toISOString());
  return { date: new Date(now + 7 * 3600000).toISOString().slice(0, 10), received: row?.n || 0 };
}

/** Время последнего сообщения, полученного наблюдателем (не из выгрузки) */
export function lastLiveAt() {
  const row = db.raw.prepare("SELECT MAX(ts) ts FROM wa_messages WHERE source = 'live'").get();
  return row?.ts ? Date.parse(row.ts) : null;
}

export function liveSince() {
  const value = db.getSetting('wa_live_since');
  return value ? Date.parse(value) : null;
}

export function setObserverConnected(connected, now = Date.now()) {
  const wasDown = db.getSetting('wa_down_since');
  if (connected) {
    // Перерыв больше 30 минут — начинаем отсчёт заново
    if (!liveSince() || (wasDown && now - Date.parse(wasDown) > 30 * 60000)) db.setSetting('wa_live_since', new Date(now).toISOString());
    if (wasDown) db.setSetting('wa_down_since', '');
  } else if (!wasDown) {
    db.setSetting('wa_down_since', new Date(now).toISOString());
  }
}
