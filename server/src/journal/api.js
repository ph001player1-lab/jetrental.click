/**
 * ============================================================================
 * API вкладки «Журнал» сайта сотрудников
 * ============================================================================
 *   GET  /api/staff/journal?view=feed|review&kinds=&plate=&q=&before=
 *   POST /api/staff/journal/fix        { id, kind, plate, plateFrom, plateTo, status }
 *   GET  /api/staff/journal/timesheet?month=2026-11
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

const FEED_KINDS = [...journal.OPERATION_KINDS, ...journal.SHIFT_KINDS, 'question', 'note'];
const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

function need(staff, perm) {
  if (!can(staff, perm)) throw new HttpError(403, perm === 'journal.admin' ? 'admin_only' : 'read_only');
}

export async function getJournal(staff, req, res, url) {
  const p = url.searchParams;
  const privateOk = can(staff, 'journal.private');
  const phones = await staffPhones();
  const kinds = (p.get('kinds') || '').split(',').filter((k) => FEED_KINDS.includes(k));
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
    events: rows.map((row) => journal.toEvent(row, phones, privateOk)),
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
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '')
    ? url.searchParams.get('month')
    : new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
  sendJson(res, 200, journal.timesheet(month, await staffPhones()));
}

export async function getReconcile(staff, req, res) {
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
  console.log(`Journal import by ${staff.email}: ${result.added} new of ${result.total}`);
  sendJson(res, 200, result);
}
