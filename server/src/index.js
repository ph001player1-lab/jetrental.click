/**
 * ============================================================================
 * KOKON BOT — HTTP-сервер
 * ============================================================================
 *   GET  /health             — проверка, что сервер жив (без секретов):
 *                              Telegram, рабочая группа, Google-таблица,
 *                              WS.Автопрокат
 *   POST /webhooks/telegram  — обновления от Telegram (проверяется секрет)
 *   POST /webhooks/whatsapp  — сообщения WhatsApp от Kapso (проверяется подпись)
 *   /api/staff/*             — сайт сотрудников (staffPortal.js)
 *   /api/public/*            — открытое API сайта (publicApi.js)
 *   остальные GET на доменах сайта (jetrental.click, kokoncar.com) — страницы
 *                              сайта, sitemap.xml, robots.txt (site/index.js)
 * ============================================================================
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError, sendJson, readBody } from './http.js';
import { staffRoute } from './staffPortal.js';
import { publicRoute } from './publicApi.js';
import { handleSite } from './site/index.js';
import { mailEnabled } from './mail.js';
import { telegramEnabled, webhookSecret, setupTelegram } from './telegram/api.js';
import { handleUpdate } from './telegram/handler.js';
import { getStaffChatId } from './staff.js';
import { fleetStatus, warmUpFleet } from './fleet.js';
import { startWsSync, wsSyncStatus } from './ws/sync.js';
import { startMorningSummary } from './morning.js';
import { whatsappEnabled, knownPhoneNumberId } from './whatsapp/api.js';
import { verifySignature, processWebhook, whatsappStatus } from './whatsapp/webhook.js';

const STARTED_AT = new Date();

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
    update = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  // Отвечаем Telegram сразу, иначе при медленной обработке он пришлёт обновление повторно
  sendJson(res, 200, { ok: true });

  handleUpdate(update).catch((err) => {
    console.error(`Telegram update ${update.update_id} failed:`, err);
  });
}

async function handleWhatsAppWebhook(req, res) {
  if (!whatsappEnabled) return sendJson(res, 404, { error: 'Not found' });

  const rawBody = await readBody(req);
  if (!verifySignature(rawBody, req.headers['x-webhook-signature'])) {
    return sendJson(res, 401, { error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  // Kapso ждёт ответ в течение 10 секунд — отвечаем сразу, обрабатываем после
  sendJson(res, 200, { ok: true });
  processWebhook(req.headers, body).catch((err) => console.error('WhatsApp webhook failed:', err));
}

/** Обработчик API: ошибки HttpError превращаются в JSON { error: код } */
async function handleApi(handler, req, res, url) {
  try {
    await handler(req, res, url);
  } catch (err) {
    if (res.headersSent) return;
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code });
    console.error(`${req.method} ${url.pathname} failed:`, err);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname.startsWith('/api/staff/') || pathname.startsWith('/api/public/')) {
    const handler = pathname.startsWith('/api/staff/') ? staffRoute(req.method, pathname) : publicRoute(req.method, pathname);
    if (!handler) return sendJson(res, 404, { error: 'not_found' });
    return handleApi(handler, req, res, url);
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'kokon-bot',
      startedAt: STARTED_AT.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      telegram: { enabled: telegramEnabled, staffGroupBound: Boolean(getStaffChatId()) },
      sheets: fleetStatus(),
      avtoprokat: wsSyncStatus(),
      mail: { enabled: mailEnabled },
      whatsapp: {
        enabled: whatsappEnabled,
        phoneNumberKnown: Boolean(knownPhoneNumberId()),
        testMode: config.whatsapp.allowedNumbers.length > 0,
        ...whatsappStatus()
      }
    });
  }

  if (req.method === 'POST' && pathname === '/webhooks/whatsapp') {
    return handleWhatsAppWebhook(req, res).catch((err) => {
      console.error('WhatsApp webhook error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  }

  if (req.method === 'POST' && pathname === '/webhooks/telegram') {
    return handleTelegramWebhook(req, res).catch((err) => {
      console.error('Telegram webhook error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return handleSite(req, res, url)
      .then((handled) => { if (!handled) sendJson(res, 404, { error: 'Not found' }); })
      .catch((err) => {
        console.error(`Site page ${pathname} failed:`, err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      });
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(config.port, () => {
  console.log(`kokon-bot listening on port ${config.port}`);
  warmUpFleet();
  startWsSync();
  startMorningSummary();

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
