/**
 * ============================================================================
 * Служебная диагностика для разработчика (только чтение)
 * ============================================================================
 * Адреса — только на домене бота (bot.jetmobility.org), с ключом DIAG_TOKEN
 * из /opt/kokon/.env в заголовке «Authorization: Bearer …». Нет ключа на
 * сервере — адресов как будто нет (404). Ничего не меняют.
 *   GET /diag/status                        — версия, WhatsApp-бот, наблюдатель, группы
 *   GET /diag/logs?service=bot|wabot|observer&minutes=60&q=текст&limit=500
 *   GET /diag/requests?limit=10             — последние заявки: кто и как взял
 *   GET /diag/chat?key=wa:66…               — состояние диалога бота с клиентом
 *   GET /diag/media?days=60&kind=issue&q=текст&limit=50 — фото наблюдателя (список)
 *   GET /diag/media/file?id=N               — само фото (для поиска образцов документов)
 * ============================================================================
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';
import { sendJson } from './http.js';
import * as db from './db.js';
import { LOG_FILE } from './logCapture.js';
import { wabotStatus, wabotSettings } from './wabot.js';
import { observerStatus } from './journal/observer.js';
import { getStaffChatId } from './staff.js';
import { version } from './serverStats.js';
import { mediaFile } from './journal/journal.js';

const TOKEN = process.env.DIAG_TOKEN || '';
const botHost = (() => { try { return new URL(config.publicBaseUrl).host.toLowerCase(); } catch { return ''; } })();
const hits = [];

function allowed(req) {
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(TOKEN);
  return TOKEN.length >= 16 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Не чаще 60 запросов в минуту — на случай подбора ключа */
function tooMany() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60000) hits.shift();
  hits.push(now);
  return hits.length > 60;
}

const sendText = (res, text) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
};

/** Строки журнала сервера за последние minutes минут (с подстрокой q) */
function serverLog(minutes, q, limit) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const lines = [];
  for (const file of [`${LOG_FILE}.1`, LOG_FILE]) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // Продолжение многострочной записи начинается с пробелов — держится своей записи
    for (const entry of text.split(/\n(?=\d{4}-\d{2}-\d{2}T)/)) {
      if (entry.slice(0, 24) >= since && (!q || entry.toLowerCase().includes(q))) lines.push(entry.trimEnd());
    }
  }
  return lines.slice(-limit).join('\n');
}

async function containerLog(base, minutes, q, limit) {
  try {
    const response = await fetch(`${base}/logs?minutes=${minutes}`, {
      headers: { 'X-Internal-Secret': config.internal.secret }, signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return `(не отвечает: HTTP ${response.status})`;
    const lines = (await response.text()).split('\n').filter((l) => l && (!q || l.toLowerCase().includes(q)));
    return lines.slice(-limit).join('\n');
  } catch (err) {
    return `(не отвечает: ${err.message})`;
  }
}

/** Номер без последних 4 цифр: «+66 81 999 0000» → «+•• •• ••• 0000» */
function mask(phone) {
  if (!phone) return null;
  const text = String(phone);
  const total = (text.match(/\d/g) || []).length;
  let i = 0;
  return text.replace(/\d/g, (d) => (++i <= total - 4 ? '•' : d));
}

export async function handleDiag(req, res, url) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!TOKEN || req.method !== 'GET' || (botHost && host !== botHost && host !== 'localhost' && host !== '127.0.0.1')) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (tooMany()) return sendJson(res, 429, { error: 'too_many_requests' });
  if (!allowed(req)) return sendJson(res, 404, { error: 'Not found' });

  const minutes = Math.min(7 * 24 * 60, Math.max(1, Number(url.searchParams.get('minutes')) || 60));
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
  const q = String(url.searchParams.get('q') || '').toLowerCase().slice(0, 100);

  switch (url.pathname) {
    case '/diag/status':
      return sendJson(res, 200, {
        version: version.commit, uptimeSeconds: Math.round(process.uptime()),
        telegramGroupBound: Boolean(getStaffChatId()),
        wabot: { ...wabotStatus(), settings: wabotSettings() },
        observer: observerStatus()
      });
    case '/diag/logs': {
      const service = url.searchParams.get('service') || 'bot';
      if (service === 'bot') return sendText(res, serverLog(minutes, q, limit));
      if (service === 'wabot') return sendText(res, await containerLog(config.internal.wabotUrl, minutes, q, limit));
      if (service === 'observer') return sendText(res, await containerLog(config.internal.observerUrl, minutes, q, limit));
      return sendJson(res, 400, { error: 'unknown_service' });
    }
    case '/diag/requests': {
      const rows = db.raw.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT ?').all(Math.min(50, limit));
      return sendJson(res, 200, rows.map((r) => ({
        id: r.id, createdAt: r.created_at, channel: r.channel, status: r.status, lang: r.lang,
        client: r.client_name, phone: mask(r.client_phone), clientChat: r.client_chat_id ? mask(r.client_chat_id.split('@')[0]) + (r.client_chat_id.includes('@') ? `@${r.client_chat_id.split('@')[1]}` : '') : null,
        takenById: r.taken_by_id, takenByName: r.taken_by_name, takenAt: r.taken_at, declinedBy: r.declined_by || null,
        sourceRef: r.source_ref, heardFrom: r.heard_from,
        inTelegram: Boolean(r.staff_message_id), inWhatsAppGroup: Boolean(r.wa_group_message_id)
      })));
    }
    case '/diag/chat': {
      const key = String(url.searchParams.get('key') || '');
      if (!/^(wa|tg):/.test(key)) return sendJson(res, 400, { error: 'bad_key' });
      const setting = (k) => db.getSetting(k);
      const choices = db.raw.prepare('SELECT options, at FROM wa_choices WHERE chat_key = ?').get(key) || null;
      const ref = db.raw.prepare('SELECT * FROM chat_refs WHERE chat_key = ?').get(key) || null;
      return sendJson(res, 200, {
        key, language: db.getChatLanguage(key), session: db.getSession(key), pausedUntil: setting(`pause:${key}`) || null,
        pendingChoices: choices, source: ref
      });
    }
    case '/diag/media': {
      // Список фото из рабочей группы: когда, к какому отчёту, начало подписи
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 60));
      const kind = String(url.searchParams.get('kind') || '').replace(/[^a-z_]/g, '').slice(0, 30);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = db.raw.prepare(`
        SELECT m.id, m.created_at, m.mime, m.bytes, m.sensitive, m.report_id,
               w.ts, w.kind, w.text, r.kind AS report_kind, r.text AS report_text
        FROM wa_media m
        LEFT JOIN wa_messages w ON w.id = m.message_id
        LEFT JOIN wa_messages r ON r.id = m.report_id
        WHERE COALESCE(w.ts, m.created_at) >= ?
        ORDER BY m.id DESC`).all(since);
      const list = rows
        .filter((r) => !kind || r.kind === kind || r.report_kind === kind)
        .filter((r) => !q || `${r.text || ''} ${r.report_text || ''}`.toLowerCase().includes(q))
        .slice(0, Math.min(200, limit))
        .map((r) => ({
          id: r.id, ts: r.ts || r.created_at, mime: r.mime, kb: Math.round((r.bytes || 0) / 1024),
          kind: r.report_kind || r.kind || null, sensitive: Boolean(r.sensitive),
          text: String(r.report_text || r.text || '').replace(/\+?\d[\d\s-]{7,}\d/g, '…').slice(0, 120)
        }));
      return sendJson(res, 200, list);
    }
    case '/diag/media/file': {
      const file = mediaFile(url.searchParams.get('id'));
      if (!file) return sendJson(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': file.mime || 'image/jpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file.path).pipe(res);
    }
    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}
