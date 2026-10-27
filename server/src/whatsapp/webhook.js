/**
 * ============================================================================
 * Входящие вебхуки WhatsApp от Kapso
 * ============================================================================
 * События: whatsapp.message.received (сообщения клиентов) и
 * whatsapp.message.sent (из них берём сообщения, которые менеджер написал
 * сам из приложения WhatsApp Business, — тогда бот в этом чате замолкает).
 * Подпись: X-Webhook-Signature = HMAC-SHA256(сырое тело, секрет вебхука), hex.
 * https://docs.kapso.ai/docs/platform/webhooks/overview
 * ============================================================================
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import * as db from '../db.js';
import { rememberPhoneNumberId, sendText } from './api.js';
import { whatsappUi } from '../channels/whatsapp.js';
import { handleClientText, handleClientChoice } from '../client.js';

let lastInboundAt = null;

export function verifySignature(rawBody, signature) {
  if (typeof signature !== 'string' || !config.whatsapp.webhookSecret) return false;
  const expected = crypto.createHmac('sha256', config.whatsapp.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAllowed(phone) {
  const allowed = config.whatsapp.allowedNumbers;
  return allowed.length === 0 || allowed.includes(phone);
}

async function handleMessage(payload) {
  const msg = payload.message;
  if (!msg) return;
  rememberPhoneNumberId(payload.phone_number_id || payload.conversation?.phone_number_id);

  const direction = msg.kapso?.direction;
  const origin = msg.kapso?.origin;

  // Менеджер ответил клиенту сам из приложения — не мешаем ему
  if (direction === 'outbound' && origin === 'business_app') {
    const to = String(msg.to || payload.conversation?.phone_number || '').replace(/\D/g, '');
    if (to) db.pauseChat(`wa:${to}`, new Date(Date.now() + config.whatsapp.pauseHours * 3600000).toISOString());
    return;
  }
  if (direction !== 'inbound') return;

  // Без номера телефона (только BSUID) пока не отвечаем — это редкий случай
  const phone = String(msg.from || payload.conversation?.phone_number || '').replace(/\D/g, '');
  if (!phone || !isAllowed(phone)) return;

  const key = `wa:${phone}`;
  if (db.isChatPaused(key)) return;
  lastInboundAt = new Date().toISOString();

  const chat = {
    channel: 'whatsapp',
    key,
    id: phone,
    name: payload.conversation?.contact_name || '',
    phone: `+${phone}`,
    ui: whatsappUi(phone)
  };

  if (msg.type === 'interactive') {
    const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
    if (!reply?.id) return;
    const [action, value] = String(reply.id).split(':');
    return handleClientChoice(chat, action, value);
  }

  if (msg.type === 'text') return handleClientText(chat, msg.text?.body || '');

  // Голосовые, фото и прочее пока не разбираем
  return sendText(phone, 'Пока я понимаю только текст и кнопки 🙏 Напишите, пожалуйста, сообщением или нажмите «меню».');
}

/**
 * Обработка уже проверенного запроса. Возвращает true, если событие новое.
 * Повторные доставки (тот же X-Idempotency-Key) пропускаем.
 */
export async function processWebhook(headers, body) {
  const idempotencyKey = headers['x-idempotency-key'];
  if (idempotencyKey && !db.markEventProcessed(`kapso:${idempotencyKey}`)) return false;

  const event = headers['x-webhook-event'];
  if (event !== 'whatsapp.message.received' && event !== 'whatsapp.message.sent') return true;

  const isBatch = headers['x-webhook-batch'] === 'true' || body.batch === true;
  const payloads = isBatch ? body.data || [] : [body];
  for (const payload of payloads) {
    try {
      await handleMessage(payload);
    } catch (err) {
      console.error('WhatsApp message handling failed:', err.message);
    }
  }
  return true;
}

export function whatsappStatus() {
  return { lastInboundAt };
}
