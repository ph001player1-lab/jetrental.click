/**
 * Адаптер Telegram для общего диалога с клиентом (client.js) и разбор
 * личных сообщений и нажатий кнопок в контекст чата.
 */

import { escapeHtml } from '../format.js';
import { tg, sendMessage, inlineKeyboard, answerCallback } from '../telegram/api.js';
import { handleClientText, handleClientChoice } from '../client.js';

function contactKeyboard(buttonText) {
  return {
    keyboard: [[{ text: buttonText, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

function telegramUi(chatId, query = null) {
  return {
    b: (text) => `<b>${escapeHtml(text)}</b>`,
    esc: escapeHtml,
    send: (text, { removeKeyboard = false } = {}) => (
      sendMessage(chatId, text, removeKeyboard ? { reply_markup: { remove_keyboard: true } } : {})
    ),
    choices: (text, options) => sendMessage(chatId, text, {
      reply_markup: inlineKeyboard(options.map((o) => [{ text: o.title, callback_data: o.id }]))
    }),
    askPhone: (text, buttonText) => sendMessage(chatId, text, { reply_markup: contactKeyboard(buttonText) }),
    ack: (text) => (query ? answerCallback(query, text) : Promise.resolve()),
    // Убираем кнопки у сообщения, на котором нажали, и пишем, что выбрано
    closeChoices: async (note) => {
      if (query?.message) {
        await tg('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] }
        });
      }
      if (note) await sendMessage(chatId, note);
    },
    restartHint: () => '/start'
  };
}

function telegramChat(chatId, from, query = null) {
  return {
    channel: 'telegram',
    key: `tg:${chatId}`,
    id: chatId,
    name: from?.first_name || '',
    phone: null,
    ui: telegramUi(chatId, query)
  };
}

export function handleTelegramPrivateMessage(msg) {
  const chat = telegramChat(msg.chat.id, msg.from);
  // Telegram присылает номер контакта без «+»: 66944688871 → +66944688871
  const contact = msg.contact?.phone_number
    ? { phone: msg.contact.phone_number.replace(/^(?!\+)/, '+'), name: msg.contact.first_name }
    : null;
  return handleClientText(chat, msg.text || '', contact);
}

export function handleTelegramClientCallback(query, action, value) {
  const chatId = query.message?.chat?.id;
  if (!chatId) return answerCallback(query);
  return handleClientChoice(telegramChat(chatId, query.from, query), action, value);
}
