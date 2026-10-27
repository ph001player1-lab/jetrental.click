/**
 * ============================================================================
 * KOKON BOT — HTTP-сервер
 * ============================================================================
 *   GET  /health             — проверка, что сервер жив (без секретов)
 *   POST /webhooks/telegram  — обновления от Telegram (проверяется секрет)
 *
 * Сюда же позже придёт вебхук WhatsApp.
 * ============================================================================
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { telegramEnabled, webhookSecret, setupTelegram } from './telegram/api.js';
import { handleUpdate } from './telegram/handler.js';
import { getStaffChatId } from './staff.js';

const STARTED_AT = new Date();
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

async function handleTelegramWebhook(req, res) {
  if (!telegramEnabled || !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', webhookSecret)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  let update;
  try {
    update = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  // Отвечаем Telegram сразу, иначе при медленной обработке он пришлёт обновление повторно
  sendJson(res, 200, { ok: true });

  handleUpdate(update).catch((err) => {
    console.error(`Telegram update ${update.update_id} failed:`, err);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'kokon-bot',
      startedAt: STARTED_AT.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      telegram: { enabled: telegramEnabled, staffGroupBound: Boolean(getStaffChatId()) }
    });
  }

  if (req.method === 'POST' && pathname === '/webhooks/telegram') {
    return handleTelegramWebhook(req, res).catch((err) => {
      console.error('Telegram webhook error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(config.port, () => {
  console.log(`kokon-bot listening on port ${config.port}`);

  if (telegramEnabled) {
    setupTelegram()
      .then(() => console.log(`Telegram webhook set to ${config.publicBaseUrl}/webhooks/telegram`))
      .catch((err) => console.error('Telegram setup failed:', err.message));
  } else {
    console.log('Telegram disabled: TELEGRAM_BOT_TOKEN is not set');
  }
});

// Docker останавливает контейнер сигналом SIGTERM — закрываемся аккуратно
process.on('SIGTERM', () => server.close(() => process.exit(0)));
