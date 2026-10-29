/**
 * Отправка писем через Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Ключ RESEND_API_KEY — только в /opt/kokon/.env на сервере.
 * Домен отправителя (jetrental.click) должен быть подтверждён в Resend.
 */

import { config } from './config.js';

export const mailEnabled = Boolean(config.mail.resendApiKey);

// Последнее неудачное письмо (null — следующее ушло) — для окна «Проблемы»
let lastFailure = null;
export const mailFailure = () => lastFailure;

export async function sendMail({ to, subject, text, html }) {
  if (!mailEnabled) throw new Error('Mail is not configured: RESEND_API_KEY is not set');
  const response = await fetch(`${config.mail.apiBase}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.mail.resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: config.mail.from, to: [to], subject, text, html })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = `Resend failed: HTTP ${response.status} ${data.message || data.name || ''}`.trim();
    lastFailure = { at: new Date().toISOString(), message };
    throw new Error(message);
  }
  lastFailure = null;
  return data;
}
