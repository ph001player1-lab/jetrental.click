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
 *   /diag/*                  — служебная диагностика по ключу DIAG_TOKEN (diag.js)
 *   /api/public/*            — открытое API сайта (publicApi.js)
 *   остальные GET на доменах сайта (jetmobility.org, kokoncar.com) — страницы
 *                              сайта, sitemap.xml, robots.txt (site/index.js)
 * ============================================================================
 */

// Первым: журнал сервера пишется и в файл (для диагностики)
import './logCapture.js';
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
import { startServerStats, recordRequest, version } from './serverStats.js';
import { startAgents } from './agent.js';
import { startInvestors } from './investor.js';
import { startJournal } from './journal/start.js';
import { whatsappEnabled, knownPhoneNumberId } from './whatsapp/api.js';
import { verifySignature, processWebhook, whatsappStatus } from './whatsapp/webhook.js';
import { handleDiag } from './diag.js';

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
  // Запросы в минуту и время ответа — для вкладки «Сервер»
  const started = process.hrtime.bigint();
  res.on('finish', () => recordRequest(Number(process.hrtime.bigint() - started) / 1e6, res.statusCode));

  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname.startsWith('/api/staff/') || pathname.startsWith('/api/public/')) {
    const handler = pathname.startsWith('/api/staff/') ? staffRoute(req.method, pathname) : publicRoute(req.method, pathname);
    if (!handler) return sendJson(res, 404, { error: 'not_found' });
    return handleApi(handler, req, res, url);
  }

  if (pathname.startsWith('/diag/')) {
    return handleDiag(req, res, url).catch((err) => {
      console.error('Diag failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'kokon-bot',
      version: version.commit,
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
  startServerStats();
  startAgents();
  startInvestors();
  startJournal();

  if (telegramEnabled) {
    // Сразу после запуска контейнера сеть бывает ещё не готова — пробуем ещё 5 раз
    const trySetup = (attempt = 1) => setupTelegram()
      .then(() => console.log(`Telegram webhook set to ${config.publicBaseUrl}/webhooks/telegram${attempt > 1 ? ` (attempt ${attempt})` : ''}`))
      .catch((err) => {
        if (attempt >= 6) return console.error('Telegram setup failed:', err.message);
        console.warn(`Telegram setup failed (${err.message}), retry in 30 s`);
        setTimeout(() => trySetup(attempt + 1), 30000);
      });
    trySetup();
  } else {
    console.log('Telegram disabled: TELEGRAM_BOT_TOKEN is not set');
  }
});

// Docker останавливает контейнер сигналом SIGTERM — закрываемся аккуратно
process.on('SIGTERM', () => server.close(() => process.exit(0)));
