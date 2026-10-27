/**
 * ============================================================================
 * WhatsApp через Kapso: отправка сообщений (формат Cloud API Meta)
 * ============================================================================
 * POST {KAPSO_API_BASE}/{phone_number_id}/messages, заголовок X-API-Key.
 * https://docs.kapso.ai/docs/whatsapp/send-messages
 *
 * Ограничения WhatsApp: до 3 кнопок (название ≤ 20 символов), список до 10
 * строк (название ≤ 24, описание ≤ 72), текст сообщения с кнопками ≤ 1024.
 * ============================================================================
 */

import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';

export const whatsappEnabled = Boolean(config.whatsapp.apiKey && config.whatsapp.webhookSecret);

const LIMITS = { buttonTitle: 20, rowTitle: 24, rowDescription: 72, body: 1024, listButton: 20, rows: 10 };

const cut = (text, max) => {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

let phoneNumberId = config.whatsapp.phoneNumberId || getSetting('wa_phone_number_id') || '';

/** ID номера запоминаем из входящих вебхуков — при смене номера ничего настраивать не нужно */
export function rememberPhoneNumberId(id) {
  if (!id || id === phoneNumberId || config.whatsapp.phoneNumberId) return;
  phoneNumberId = String(id);
  setSetting('wa_phone_number_id', phoneNumberId);
}

export function knownPhoneNumberId() {
  return phoneNumberId;
}

async function send(to, payload) {
  if (!phoneNumberId) throw new Error('WhatsApp phone_number_id is unknown yet (no inbound webhook received)');
  const response = await fetch(`${config.whatsapp.apiBase}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': config.whatsapp.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to), ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`WhatsApp send failed: HTTP ${response.status} ${data.error?.message || ''}`.trim());
  }
  return data;
}

export function sendText(to, text) {
  return send(to, { type: 'text', text: { body: String(text), preview_url: false } });
}

/** options: [{ id, title }] — до 3 кнопок */
export function sendButtons(to, bodyText, options) {
  return send(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: cut(bodyText, LIMITS.body) },
      action: {
        buttons: options.slice(0, 3).map((o) => ({ type: 'reply', reply: { id: o.id, title: cut(o.title, LIMITS.buttonTitle) } }))
      }
    }
  });
}

/** options: [{ id, title, description? }] — до 10 строк одним разделом */
export function sendList(to, bodyText, buttonText, options) {
  return send(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: cut(bodyText, LIMITS.body) },
      action: {
        button: cut(buttonText, LIMITS.listButton),
        sections: [{
          title: 'Варианты',
          rows: options.slice(0, LIMITS.rows).map((o) => ({
            id: o.id,
            title: cut(o.title, LIMITS.rowTitle),
            ...(o.description ? { description: cut(o.description, LIMITS.rowDescription) } : {})
          }))
        }]
      }
    }
  });
}
