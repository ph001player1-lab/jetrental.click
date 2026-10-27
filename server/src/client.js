/**
 * ============================================================================
 * Диалог с клиентом (пока — в личке Telegram-бота, для теста без WhatsApp)
 * ============================================================================
 * Шаги: тип техники (кнопки) → даты → свободные модели из таблицы с ценами
 * (кнопки) → телефон → заявка в рабочую группу и в Google-таблицу.
 * Позже тот же сценарий заработает в WhatsApp.
 * ============================================================================
 */

import * as db from './db.js';
import { VEHICLE_TYPES, vehicleTypeLabel, formatShortDate, formatThb, daysBetween, escapeHtml } from './format.js';
import { parseDateRange } from './dates.js';
import { findAvailableModels, sheetsEnabled } from './fleet.js';
import { publishRequest } from './staff.js';
import { tg, sendMessage, inlineKeyboard, answerCallback, parseCommand } from './telegram/api.js';

const MAX_MODEL_BUTTONS = 10;

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

function modelLine(option) {
  const name = `• <b>${escapeHtml(option.model)}</b>`;
  if (option.price?.total) return `${name} — ${formatThb(option.price.perDay)}/день, ≈ ${formatThb(option.price.total)}`;
  if (option.price?.fromPerDay) return `${name} — от ${formatThb(option.price.fromPerDay)}/день`;
  return `${name} — цену уточнит менеджер`;
}

/**
 * После дат показываем свободные модели. Если таблица не подключена или
 * недоступна — сразу просим телефон, заявку подберёт менеджер.
 */
async function offerModels(chatId, session) {
  let options = [];
  if (sheetsEnabled) {
    try {
      options = (await findAvailableModels(session.vehicleType, session.dateFrom, session.dateTo)).slice(0, MAX_MODEL_BUTTONS);
    } catch (err) {
      console.error('Fleet lookup failed:', err.message);
      db.saveSession(chatId, { ...session, step: 'contact' });
      return askContact(chatId);
    }
  } else {
    db.saveSession(chatId, { ...session, step: 'contact' });
    return askContact(chatId);
  }

  const period = `${formatShortDate(session.dateFrom)} – ${formatShortDate(session.dateTo)}`;

  if (options.length === 0) {
    db.saveSession(chatId, { ...session, step: 'contact' });
    await sendMessage(
      chatId,
      `😔 На ${period} свободной техники этого типа не нашлось. Оставьте номер — менеджер предложит варианты.`
    );
    return askContact(chatId);
  }

  db.saveSession(chatId, {
    ...session,
    step: 'model',
    options: options.map((o) => ({ model: o.model, total: o.price?.total || null, plates: o.freePlates }))
  });

  const buttons = options.map((o, i) => [{ text: o.model, callback_data: `model:${i}` }]);
  buttons.push([{ text: '🤷 Помогите выбрать', callback_data: 'model:any' }]);

  await sendMessage(
    chatId,
    `✅ Свободно на ${period} (${daysBetween(session.dateFrom, session.dateTo)} дн.):\n\n` +
      `${options.map(modelLine).join('\n')}\n\nВыберите модель 👇`,
    { reply_markup: inlineKeyboard(buttons) }
  );
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
    dateTo: session.dateTo,
    model: session.model,
    estimateThb: session.estimateThb,
    freeUnits: session.freeUnits
  });
  db.clearSession(chatId);

  const days = daysBetween(request.date_from, request.date_to);
  const what = request.model ? `${vehicleTypeLabel(request.vehicle_type)} ${escapeHtml(request.model)}` : vehicleTypeLabel(request.vehicle_type);
  await sendMessage(
    chatId,
    `✅ <b>Заявка #${request.id} принята!</b>\n` +
      `${what}, ${formatShortDate(request.date_from)} – ${formatShortDate(request.date_to)} (${days} дн.)\n\n` +
      'Менеджер скоро свяжется с вами и подтвердит бронь. Новая заявка: /start',
    { reply_markup: { remove_keyboard: true } }
  );

  await publishRequest(request);
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
      return offerModels(chatId, { ...session, dateFrom: result.from, dateTo: result.to });
    }

    case 'model':
      return sendMessage(chatId, 'Выберите модель кнопкой выше 👆 или нажмите «Помогите выбрать».');

    case 'contact': {
      const phone = extractPhone(msg);
      if (!phone) return askContact(chatId);
      return finishRequest(msg, session, phone);
    }

    default:
      return startFlow(chatId);
  }
}

async function chooseType(query, chatId, vehicleType) {
  if (!VEHICLE_TYPES[vehicleType]) return answerCallback(query);

  db.saveSession(chatId, { step: 'dates', vehicleType });
  await answerCallback(query);
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: query.message.message_id,
    text: `Вы выбрали: ${vehicleTypeLabel(vehicleType)}`
  });
  await sendMessage(chatId, '📅 На какие даты? Напишите, например: <b>5.11 - 12.11</b>');
}

async function chooseModel(query, chatId, value) {
  const session = db.getSession(chatId);
  if (!session || session.step !== 'model') return answerCallback(query, 'Начните заново: /start');

  const option = value === 'any' ? null : session.options?.[Number(value)];
  if (value !== 'any' && !option) return answerCallback(query);

  db.saveSession(chatId, {
    ...session,
    step: 'contact',
    options: undefined,
    model: option?.model || null,
    estimateThb: option?.total || null,
    freeUnits: option?.plates?.join(', ') || null
  });
  await answerCallback(query);
  await tg('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: query.message.message_id,
    reply_markup: { inline_keyboard: [] }
  });
  await sendMessage(chatId, option ? `Вы выбрали: <b>${escapeHtml(option.model)}</b>` : 'Хорошо, менеджер поможет подобрать 👌');
  return askContact(chatId);
}

/** Кнопки в личке клиента: type:<тип> и model:<номер|any> */
export async function handleClientCallback(query, action, value) {
  const chatId = query.message?.chat?.id;
  if (!chatId) return answerCallback(query);

  if (action === 'type') return chooseType(query, chatId, value);
  if (action === 'model') return chooseModel(query, chatId, value);
  return answerCallback(query);
}
