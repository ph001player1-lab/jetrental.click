/**
 * ============================================================================
 * Связь бота с наблюдателем рабочей группы WhatsApp (контейнер observer)
 * ============================================================================
 * Внутренний HTTP-сервер бота на порту 3001 — его НЕ видно из интернета
 * (Caddy проксирует только порт 3000). Каждый запрос — с общим секретом
 * INTERNAL_SECRET в заголовке X-Internal-Secret.
 *   POST /internal/wa/message  { op: add | edit | revoke, … } — сообщение группы
 *   POST /internal/wa/media?id=…&mime=…   тело — фото / видео
 *   POST /internal/wa/status   { connected, status, me, groupId, unreadable, today } — раз в 2 минуты
 * Для админа на сайте сотрудников (вкладка «Журнал» → WhatsApp):
 *   GET  /api/staff/wa          — состояние, QR-код, список групп
 *   POST /api/staff/wa/config   { groupId } — какую группу читать
 *   POST /api/staff/wa/pair     { phone }   — вход по коду вместо QR
 *   POST /api/staff/wa/logout                — отвязать номер
 * ============================================================================
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError, sendJson, readJson, readBody } from '../http.js';
import { can } from '../roles.js';
import * as db from '../db.js';
import * as journal from './journal.js';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
// Без вестей от наблюдателя дольше этого — считаем, что он не на связи
const STALE_MS = 6 * 60 * 1000;

export const observerConfigured = Boolean(config.internal.secret);

const status = {
  connected: false, status: null, me: null, groupId: null, groupSubject: null, lastSeenAt: null, lastMessageAt: null,
  // Сообщения группы, которые наблюдатель не смог расшифровать: [{ id, ts, author, reason }]
  unreadable: [],
  today: null
};

/**
 * Непрочитанные сообщения, которые ещё не закрыты выгрузкой чата: после загрузки
 * выгрузки, где они есть, предупреждение пропадает
 */
function openUnreadable(list) {
  let coveredTo = 0;
  try { coveredTo = Date.parse(JSON.parse(db.getSetting('journal_import') || 'null')?.to || '') || 0; } catch { /* нет загрузок */ }
  return (list || []).filter((u) => !(Date.parse(u.ts) <= coveredTo));
}

/** Для вкладки «Сервер», журнала и предупреждений */
export function observerStatus(now = Date.now()) {
  const fresh = status.lastSeenAt && now - Date.parse(status.lastSeenAt) < STALE_MS;
  return {
    configured: observerConfigured,
    connected: Boolean(fresh && status.connected),
    status: fresh ? status.status : status.lastSeenAt ? 'silent' : null,
    groupSubject: status.groupSubject,
    lastSeenAt: status.lastSeenAt,
    lastMessageAt: status.lastMessageAt,
    groupChosen: Boolean(status.groupId),
    unreadable: openUnreadable(status.unreadable),
    today: status.today,
    // Подключали ли хоть раз (тогда «не на связи» — это авария, а не «ещё не настроен»)
    everLinked: Boolean(journal.liveSince())
  };
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-internal-secret'] || ''));
  const expected = Buffer.from(config.internal.secret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function handleInternal(req, res) {
  const url = new URL(req.url, 'http://bot');
  if (req.method !== 'POST' || !authorized(req)) return sendJson(res, 403, { error: 'forbidden' });

  if (url.pathname === '/internal/wa/message') {
    const body = await readJson(req, MAX_MESSAGE_BYTES);
    if (body.op === 'revoke') return sendJson(res, 200, { ok: journal.revokeMessage(String(body.id)) });
    if (body.op === 'edit') return sendJson(res, 200, { ok: journal.editMessage(String(body.id), String(body.text || '')) });
    if (!body.id || !body.ts) throw new HttpError(400, 'bad_message');
    journal.storeMessage({
      id: String(body.id), source: 'live', ts: new Date(body.ts).toISOString(),
      author: String(body.author || 'unknown').slice(0, 40), authorName: body.authorName ? String(body.authorName).slice(0, 80) : null,
      text: String(body.text || '').slice(0, 20000), mediaCount: Number(body.mediaCount) || 0,
      quotedId: body.quotedId ? String(body.quotedId) : null, albumId: body.albumId ? String(body.albumId) : null
    });
    status.lastMessageAt = new Date().toISOString();
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/internal/wa/media') {
    const buffer = await readBody(req, MAX_MEDIA_BYTES);
    const mime = String(url.searchParams.get('mime') || 'image/jpeg');
    if (!/^(image|video)\/[\w.+-]+$/.test(mime)) throw new HttpError(400, 'bad_mime');
    try {
      return sendJson(res, 200, { id: journal.saveMedia(String(url.searchParams.get('id')), buffer, mime) });
    } catch (err) {
      if (err.message === 'unknown_message') throw new HttpError(404, 'unknown_message');
      throw err;
    }
  }

  if (url.pathname === '/internal/wa/lids') {
    const body = await readJson(req);
    journal.saveLidPhones(Array.isArray(body.pairs) ? body.pairs : []);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/internal/wa/status') {
    const body = await readJson(req);
    Object.assign(status, {
      connected: Boolean(body.connected), status: String(body.status || ''), me: body.me || null,
      groupId: body.groupId || null, groupSubject: body.groupSubject || null, lastSeenAt: new Date().toISOString(),
      unreadable: Array.isArray(body.unreadable) ? body.unreadable.slice(-50).map((u) => ({
        id: String(u.id || '').slice(0, 64), ts: String(u.ts || ''), author: String(u.author || '').slice(0, 40), reason: String(u.reason || '').slice(0, 80)
      })) : [],
      today: body.today?.date ? { date: String(body.today.date).slice(0, 10), received: Number(body.today.received) || 0 } : null
    });
    // Наблюдение «без перерыва» считаем только когда выбрана группа
    journal.setObserverConnected(status.connected && Boolean(status.groupId));
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

export function startInternalServer() {
  if (!observerConfigured) {
    console.log('WhatsApp observer link disabled: INTERNAL_SECRET is not set (update.sh creates it)');
    return;
  }
  http.createServer((req, res) => {
    handleInternal(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code });
      console.error('Internal request failed:', err);
      sendJson(res, 500, { error: 'internal_error' });
    });
  }).listen(config.internal.port, () => console.log(`Internal API for the observer on port ${config.internal.port}`));
  // Наблюдатель замолчал (контейнер упал, нет интернета) — отмечаем перерыв
  setInterval(() => {
    if (status.lastSeenAt && Date.now() - Date.parse(status.lastSeenAt) > STALE_MS) journal.setObserverConnected(false);
  }, 60 * 1000).unref();
}

/* ---------------------------------------------------- Админ: подключение */

async function observerCall(method, pathname, body) {
  if (!observerConfigured) throw new HttpError(503, 'observer_not_configured');
  let response;
  try {
    response = await fetch(`${config.internal.observerUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': config.internal.secret },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new HttpError(503, 'observer_unreachable');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 400 ? 400 : 502, data.error || 'observer_failed');
  return data;
}

function needAdmin(staff) {
  if (!can(staff, 'journal.admin')) throw new HttpError(403, 'admin_only');
}

export async function waStatus(staff, req, res) {
  // Смотреть состояние наблюдателя — право «WhatsApp: смотрит»; менять — «меняет»
  if (!can(staff, 'whatsapp.view')) throw new HttpError(403, 'admin_only');
  let observer = null;
  try {
    observer = await observerCall('GET', '/status');
  } catch (err) {
    return sendJson(res, 200, { reachable: false, error: err.code, ...observerStatus() });
  }
  sendJson(res, 200, {
    reachable: true,
    status: observer.status,
    // QR-код — картинкой (SVG), чтобы показать в <img> без скриптов
    qr: observer.qrSvg ? `data:image/svg+xml;base64,${Buffer.from(observer.qrSvg).toString('base64')}` : null,
    pairingCode: observer.pairingCode,
    me: observer.me,
    unreadable: openUnreadable(observer.unreadable),
    // Из базы бота: счёт не сбрасывается при перезапуске наблюдателя
    today: journal.liveToday(),
    groups: observer.groups,
    groupId: observer.groupId,
    groupSubject: observer.groupSubject,
    lastMessageAt: observer.lastMessageAt,
    live: journal.liveSince() ? new Date(journal.liveSince()).toISOString() : null
  });
}

export async function waConfig(staff, req, res) {
  needAdmin(staff);
  const { groupId } = await readJson(req);
  sendJson(res, 200, await observerCall('POST', '/config', { groupId: String(groupId || '') }));
}

export async function waPair(staff, req, res) {
  needAdmin(staff);
  const { phone } = await readJson(req);
  sendJson(res, 200, await observerCall('POST', '/pair', { phone: String(phone || '') }));
}

export async function waLogout(staff, req, res) {
  needAdmin(staff);
  console.log(`WhatsApp observer unlinked by ${staff.email}`);
  sendJson(res, 200, await observerCall('POST', '/logout'));
}
