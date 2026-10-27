/**
 * ============================================================================
 * Рабочая группа сотрудников (бот-ассистент)
 * ============================================================================
 * - /bind  — админ группы подключает её: сюда будут приходить заявки
 * - /test  — тестовая заявка, чтобы проверить кнопки
 * - кнопки «Беру» / «Не могу» под каждой заявкой
 *
 * Позже здесь же ассистент будет разбирать сообщения «сдал / выдал / ремонт».
 * ============================================================================
 */

import { config } from './config.js';
import * as db from './db.js';
import { formatStaffRequest, escapeHtml } from './format.js';
import { todayIso } from './dates.js';
import { tg, sendMessage, inlineKeyboard, answerCallback, displayName, parseCommand } from './telegram/api.js';

export function getStaffChatId() {
  return config.telegram.staffChatId || db.getSetting('staff_chat_id');
}

function isStaffChat(chatId) {
  const staffChatId = getStaffChatId();
  return Boolean(staffChatId) && String(staffChatId) === String(chatId);
}

function staffButtons(request) {
  if (request.status !== 'new') return { inline_keyboard: [] };
  return inlineKeyboard([[
    { text: '✋ Беру', callback_data: `take:${request.id}` },
    { text: '🚫 Не могу', callback_data: `decline:${request.id}` }
  ]]);
}

/** Публикует заявку в рабочей группе. Возвращает false, если группа не подключена. */
export async function postRequestToStaff(request) {
  const chatId = getStaffChatId();
  if (!chatId) {
    console.warn(`Request #${request.id}: staff group is not bound yet (send /bind in the group)`);
    return false;
  }
  const message = await sendMessage(chatId, formatStaffRequest(request), { reply_markup: staffButtons(request) });
  db.setStaffMessage(request.id, chatId, message.message_id);
  return true;
}

async function refreshStaffMessage(request) {
  if (!request.staff_chat_id || !request.staff_message_id) return;
  try {
    await tg('editMessageText', {
      chat_id: request.staff_chat_id,
      message_id: request.staff_message_id,
      text: formatStaffRequest(request),
      parse_mode: 'HTML',
      reply_markup: staffButtons(request)
    });
  } catch (err) {
    // Повторное нажатие той же кнопки не меняет текст — это не ошибка
    if (!String(err.message).includes('message is not modified')) throw err;
  }
}

async function notifyClientTaken(request) {
  if (request.channel !== 'telegram' || !request.client_chat_id) return;
  await sendMessage(
    request.client_chat_id,
    `👋 Вашей заявкой #${request.id} занимается менеджер <b>${escapeHtml(request.taken_by_name)}</b>. Скоро свяжемся с вами!`
  );
}

export async function handleStaffCallback(query, action, requestId) {
  if (!isStaffChat(query.message?.chat?.id)) return answerCallback(query);

  const request = db.getRequest(requestId);
  if (!request) return answerCallback(query, 'Заявка не найдена');

  const name = displayName(query.from);

  if (action === 'take') {
    if (!db.takeRequest(request.id, query.from.id, name)) {
      return answerCallback(query, `Уже взял(а): ${db.getRequest(request.id).taken_by_name}`);
    }
    const taken = db.getRequest(request.id);
    await refreshStaffMessage(taken);
    await answerCallback(query, `Заявка #${taken.id} ваша`);
    await notifyClientTaken(taken);
    return;
  }

  if (action === 'decline') {
    if (request.status !== 'new') return answerCallback(query, 'Заявка уже в работе');
    await refreshStaffMessage(db.addDecline(request.id, name));
    return answerCallback(query, 'Понятно, спасибо');
  }

  return answerCallback(query);
}

async function bindGroup(msg) {
  if (config.telegram.staffChatId) {
    return sendMessage(msg.chat.id, 'Рабочая группа задана в настройках сервера — /bind здесь не нужен.');
  }

  const member = await tg('getChatMember', { chat_id: msg.chat.id, user_id: msg.from.id });
  if (!['creator', 'administrator'].includes(member.status)) {
    return sendMessage(msg.chat.id, 'Подключить группу может только её администратор.');
  }

  db.setSetting('staff_chat_id', msg.chat.id);
  return sendMessage(msg.chat.id, '✅ Готово! Новые заявки будут приходить в эту группу.\nПроверить кнопки: /test');
}

async function createTestRequest(msg) {
  if (!isStaffChat(msg.chat.id)) {
    return sendMessage(msg.chat.id, 'Сначала подключите эту группу командой /bind.');
  }

  const start = new Date(`${todayIso()}T00:00:00Z`);
  const shift = (days) => new Date(start.getTime() + days * 86400000).toISOString().slice(0, 10);

  const request = db.createRequest({
    channel: 'test',
    clientName: 'Тестовый клиент',
    clientPhone: '+66 00 000 0000',
    vehicleType: 'scooter',
    dateFrom: shift(3),
    dateTo: shift(10),
    comment: `создал(а) ${displayName(msg.from)}`
  });
  await postRequestToStaff(request);
}

export async function handleGroupMessage(msg) {
  // Группа стала супергруппой — у неё новый ID, переносим привязку
  if (msg.migrate_to_chat_id && isStaffChat(msg.chat.id) && !config.telegram.staffChatId) {
    db.setSetting('staff_chat_id', msg.migrate_to_chat_id);
    db.moveStaffChat(msg.chat.id, msg.migrate_to_chat_id);
    return;
  }

  const command = parseCommand(msg.text);
  if (command === 'bind') return bindGroup(msg);
  if (command === 'test') return createTestRequest(msg);
}

export async function handleMyChatMember(update) {
  const isGroup = ['group', 'supergroup'].includes(update.chat.type);
  const wasOut = ['left', 'kicked'].includes(update.old_chat_member.status);
  const isIn = ['member', 'administrator'].includes(update.new_chat_member.status);

  if (isGroup && wasOut && isIn && !isStaffChat(update.chat.id)) {
    await sendMessage(
      update.chat.id,
      '👋 Привет! Я ассистент по заявкам.\nЧтобы новые заявки приходили в эту группу, администратор отправляет /bind'
    );
  }
}
