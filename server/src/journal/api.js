/**
 * ============================================================================
 * API вкладки «Журнал» сайта сотрудников
 * ============================================================================
 *   GET  /api/staff/journal?view=feed|review&kinds=&plate=&q=&before=
 *   POST /api/staff/journal/fix        { id, kind, plate, plateFrom, plateTo, status }
 *   GET  /api/staff/journal/timesheet?month=2026-11 — табель (Admin)
 *   GET  /api/staff/journal/reconcile
 *   GET  /api/staff/journal/media?id=  — фото (Admin, Editor)
 *   POST /api/staff/journal/import     { text } — история из «Экспорта чата» (Admin)
 * Без права journal.private (Viewer) — без фото, контактов клиентов и исходного текста.
 * ============================================================================
 */

import fs from 'node:fs';
import * as db from '../db.js';
import { HttpError, sendJson, readJson } from '../http.js';
import { can } from '../roles.js';
import { staffPhones } from '../staffUsers.js';
import * as journal from './journal.js';
import { reconcile } from './reconcile.js';
import { observerStatus } from './observer.js';
import { blacklisted } from '../crm.js';

const FEED_KINDS = [...journal.OPERATION_KINDS, ...journal.SHIFT_KINDS, 'question', 'note', 'media'];
const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

/** Клиент отчёта в чёрном списке CRM — пометка видна всем (без имени и контакта клиента) */
function withBlacklist(row, event) {
  let contact = null;
  try {
    contact = JSON.parse(row.data || '{}').fields?.contact;
  } catch { /* без разбора — без пометки */ }
  return blacklisted(contact) ? { ...event, blacklist: true } : event;
}

/** Нет права: «только смотреть», «только админ» или раздел закрыт для роли */
function need(staff, perm) {
  if (can(staff, perm)) return;
  throw new HttpError(403, perm === 'journal.edit' ? 'read_only' : perm === 'journal.admin' ? 'admin_only' : 'no_section_access');
}

export async function getJournal(staff, req, res, url) {
  need(staff, 'journal.view');
  const p = url.searchParams;
  const privateOk = can(staff, 'journal.private');
  const phones = await staffPhones();
  // kinds=* — «Весь чат»: все сообщения группы (переписка — только тем, кто видит контакты)
  const kinds = p.get('kinds') === '*'
    ? FEED_KINDS.filter((k) => privateOk || !['note', 'question', 'media'].includes(k))
    : (p.get('kinds') || '').split(',').filter((k) => FEED_KINDS.includes(k));
  const rows = journal.listMessages({
    kinds,
    plate: p.get('plate') || null,
    // Поиск по тексту — только тем, кто видит контакты (иначе можно искать по телефону клиента)
    q: privateOk ? p.get('q') : null,
    before: p.get('before') || null,
    status: p.get('view') === 'review' ? 'review' : null,
    limit: p.get('limit') || 50
  });
  const imported = db.getSetting('journal_import');
  sendJson(res, 200, {
    events: rows.map((row) => withBlacklist(row, journal.toEvent(row, phones, privateOk))),
    counts: journal.counts(),
    live: journal.liveSince() ? new Date(journal.liveSince()).toISOString() : null,
    observer: observerStatus(),
    imported: imported ? JSON.parse(imported) : null
  });
}

export async function fixEvent(staff, req, res) {
  need(staff, 'journal.edit');
  const body = await readJson(req);
  const row = journal.fixMessage(String(body.id || ''), body, staff);
  if (!row) throw new HttpError(404, 'not_found');
  sendJson(res, 200, { event: journal.toEvent(row, await staffPhones(), true) });
}

export async function getTimesheet(staff, req, res, url) {
  need(staff, 'journal.timesheet');
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '')
    ? url.searchParams.get('month')
    : new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
  sendJson(res, 200, journal.timesheet(month, await staffPhones()));
}

export async function getReconcile(staff, req, res) {
  need(staff, 'reconcile.view');
  const result = reconcile();
  const phones = await staffPhones();
  for (const item of result.items) {
    if (item.group) item.group.who = phones.get(item.group.author) || item.group.authorName || item.group.author;
  }
  sendJson(res, 200, result);
}

export async function getMedia(staff, req, res, url) {
  need(staff, 'journal.private');
  const file = journal.mediaFile(url.searchParams.get('id'));
  if (!file) throw new HttpError(404, 'not_found');
  res.writeHead(200, {
    'Content-Type': file.mime || 'image/jpeg',
    'Content-Length': fs.statSync(file.path).size,
    // Только в браузере сотрудника, не в общих кэшах
    'Cache-Control': 'private, max-age=86400'
  });
  fs.createReadStream(file.path).pipe(res);
}

export async function importHistory(staff, req, res) {
  need(staff, 'journal.admin');
  const body = await readJson(req, MAX_IMPORT_BYTES);
  const text = String(body.text || '');
  if (text.length < 20) throw new HttpError(400, 'empty_file');
  const result = journal.importExport(text, staff);
  if (!result.total) throw new HttpError(400, 'not_whatsapp_export');
  console.log(`Journal import by ${staff.email}: ${result.added} new of ${result.total}${result.audit ? `, observer missed ${result.audit.missed} of ${result.audit.checked}` : ''}`);
  sendJson(res, 200, result);
}
