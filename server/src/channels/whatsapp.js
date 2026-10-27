/**
 * Адаптер WhatsApp для общего диалога с клиентом (client.js): как в этом
 * канале выделять текст, отправлять кнопки и списки.
 */

import * as wa from '../whatsapp/api.js';

export function whatsappUi(phone) {
  return {
    b: (text) => `*${String(text ?? '')}*`,
    esc: (text) => String(text ?? ''),
    send: (text) => wa.sendText(phone, text),
    choices: (text, options, { listButton = 'Выбрать' } = {}) => (
      options.length <= 3 ? wa.sendButtons(phone, text, options) : wa.sendList(phone, text, listButton, options)
    ),
    // Номер клиента в WhatsApp известен, отдельно его не спрашиваем
    askPhone: (text) => wa.sendText(phone, text),
    // Выбор клиента WhatsApp сам показывает его ответом в чате
    ack: async () => {},
    closeChoices: async () => {},
    restartHint: 'напишите «меню»'
  };
}
