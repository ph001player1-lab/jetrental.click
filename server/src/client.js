/**
 * ============================================================================
 * Диалог с клиентом (пока — в личке Telegram-бота, для теста без WhatsApp)
 * ============================================================================
 * Шаги: тип техники (кнопки) → даты → телефон → заявка в рабочую группу.
 * Позже тот же сценарий заработает в WhatsApp, а свободную технику и цены
 * бот будет брать из базы.
 * ============================================================================
 */

import * as db from './db.js';
import { VEHICLE_TYPES, vehicleTypeLabel, formatShortDate, daysBetween } from './format.js';
import { parseDateRange } from './dates.js';
import { postRequestToStaff } from './staff.js';
import { tg, sendMessage, inlineKeyboard, answerCallback, parseCommand } from './telegram/api.js';

const TYPE_KEYBOARD = inlineKeyboard(
  Object.entries(VEHICLE_TYPES).map(([type, t]) => [{ text: `${t.icon} ${t.label}`, callback_data: `type:${type}` }])
);

const CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Отправить мой номер', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true
};

const DATE_ERRORS = {
  format: 'Не понял даты 🙏 Напишите две даты, например: <b>5.11 - 12.11</b>',
  invalid: 'Такой даты нет в календаре 🙂 Проверьте, пожалуйста.',
  past: 'Эта дата уже прошла. Напишите даты, начиная с сегодняшнего дня.',
  order: 'Дата возврата должна быть позже даты начала аренды.',
  too_long: 'Срок больше года — напишите, пожалуйста, даты покороче.'
};

async function startFlow(chatId) {
  db.saveSession(chatId, { step: 'type' });
  await sendMessage(chatId, 'Здравствуйте! 👋 Помогу подобрать технику в аренду.\n\nЧто хотите арендовать?', {
    reply_markup: TYPE_KEYBOARD
  });
}

async function askContact(chatId) {
  await sendMessage(chatId, '📱 Оставьте номер телефона (лучше WhatsApp): нажмите кнопку ниже или напишите номер.', {
    reply_markup: CONTACT_KEYBOARD
  });
}

function extractPhone(msg) {
  // Telegram присылает номер контакта без «+»: 66944688871 → +66944688871
  if (msg.contact?.phone_number) return msg.contact.phone_number.replace(/^(?!\+)/, '+');
  const text = (msg.text || '').trim();
  const digits = text.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? text : null;
}

async function finishRequest(msg, session, phone) {
  const chatId = msg.chat.id;
  const name = msg.contact?.first_name || msg.from.first_name || '';

  const request = db.createRequest({
    channel: 'telegram',
    clientChatId: chatId,
    clientName: name,
    clientPhone: phone,
    vehicleType: session.vehicleType,
    dateFrom: session.dateFrom,
    dateTo: session.dateTo
  });
  db.clearSession(chatId);

  const days = daysBetween(request.date_from, request.date_to);
  await sendMessage(
    chatId,
    `✅ <b>Заявка #${request.id} принята!</b>\n` +
      `${vehicleTypeLabel(request.vehicle_type)}, ${formatShortDate(request.date_from)} – ${formatShortDate(request.date_to)} (${days} дн.)\n\n` +
      'Менеджер скоро свяжется с вами. Новая заявка: /start',
    { reply_markup: { remove_keyboard: true } }
  );

  await postRequestToStaff(request);
}

export async function handlePrivateMessage(msg) {
  const chatId = msg.chat.id;
  const session = db.getSession(chatId);

  if (parseCommand(msg.text) === 'start' || !session) return startFlow(chatId);

  switch (session.step) {
    case 'type':
      return sendMessage(chatId, 'Выберите, пожалуйста, кнопкой 👇', { reply_markup: TYPE_KEYBOARD });

    case 'dates': {
      const result = parseDateRange(msg.text || '');
      if (result.error) return sendMessage(chatId, DATE_ERRORS[result.error]);
      db.saveSession(chatId, { ...session, step: 'contact', dateFrom: result.from, dateTo: result.to });
      return askContact(chatId);
    }

    case 'contact': {
      const phone = extractPhone(msg);
      if (!phone) return askContact(chatId);
      return finishRequest(msg, session, phone);
    }

    default:
      return startFlow(chatId);
  }
}

export async function handleClientCallback(query, vehicleType) {
  const chatId = query.message?.chat?.id;
  if (!chatId || !VEHICLE_TYPES[vehicleType]) return answerCallback(query);

  db.saveSession(chatId, { step: 'dates', vehicleType });
  await answerCallback(query);
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: query.message.message_id,
    text: `Вы выбрали: ${vehicleTypeLabel(vehicleType)}`
  });
  await sendMessage(chatId, '📅 На какие даты? Напишите, например: <b>5.11 - 12.11</b>');
}
