/**
 * Отправка писем через Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Ключ RESEND_API_KEY — только в /opt/kokon/.env на сервере.
 * Домен отправителя (jetmobility.org) должен быть подтверждён в Resend. Пока не
 * подтверждён — пробуем запасного отправителя (MAIL_FROM_FALLBACK).
 */

import { config } from './config.js';

export const mailEnabled = Boolean(config.mail.resendApiKey);

// Последнее неудачное письмо (null — следующее ушло) — для окна «Проблемы»
let lastFailure = null;
export const mailFailure = () => lastFailure;

function post(from, { to, subject, text, html }) {
  return fetch(`${config.mail.apiBase}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.mail.resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, text, html })
  });
}

export async function sendMail(message) {
  if (!mailEnabled) throw new Error('Mail is not configured: RESEND_API_KEY is not set');
  let response = await post(config.mail.from, message);
  let data = await response.json().catch(() => ({}));
  // Домен отправителя ещё не подтверждён в Resend — отправляем со старого адреса
  if (!response.ok && config.mail.fallbackFrom && /domain/i.test(data.message || '') && /verif/i.test(data.message || '')) {
    console.error(`Resend: ${data.message} — sending from the fallback address`);
    response = await post(config.mail.fallbackFrom, message);
    data = await response.json().catch(() => ({}));
  }
  if (!response.ok) {
    const message = `Resend failed: HTTP ${response.status} ${data.message || data.name || ''}`.trim();
    lastFailure = { at: new Date().toISOString(), message };
    throw new Error(message);
  }
  lastFailure = null;
  return data;
}
