/**
 * Адаптер WhatsApp для общего диалога с клиентом (client.js): как в этом
 * канале выделять текст, отправлять кнопки и списки.
 */

import * as wa from '../whatsapp/api.js';
import { t } from '../i18n.js';

export function whatsappUi(phone) {
  return {
    b: (text) => `*${String(text ?? '')}*`,
    esc: (text) => String(text ?? ''),
    send: (text) => wa.sendText(phone, text),
    choices: (text, options, { listButton = 'Choose', sectionTitle } = {}) => (
      options.length <= 3
        ? wa.sendButtons(phone, text, options)
        : wa.sendList(phone, text, listButton, options, sectionTitle)
    ),
    // Номер клиента в WhatsApp известен, отдельно его не спрашиваем
    askPhone: (text) => wa.sendText(phone, text),
    // Выбор клиента WhatsApp сам показывает его ответом в чате
    ack: async () => {},
    closeChoices: async () => {},
    restartHint: (lang) => t(lang, 'restart_whatsapp')
  };
}
