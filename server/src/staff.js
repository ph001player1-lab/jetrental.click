/**
 * ============================================================================
 * Рабочая группа сотрудников (бот-ассистент)
 * ============================================================================
 * - /bind  — админ группы подключает её: сюда будут приходить заявки
 * - /test  — тестовая заявка, чтобы проверить кнопки
 * - кнопки «Take» / «Can't» под каждой заявкой (на английском — в группе
 *   работают люди с разными языками)
 *
 * Позже здесь же ассистент будет разбирать сообщения «сдал / выдал / ремонт».
 * ============================================================================
 */

import { config } from './config.js';
import * as db from './db.js';
import { formatStaffRequest, escapeHtml } from './format.js';
import { t } from './i18n.js';
import { todayIso } from './dates.js';
import { mirrorNewRequest, mirrorRequestStatus } from './sheetsSync.js';
import { sendText as waSendText } from './whatsapp/api.js';
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
    { text: '✋ Take', callback_data: `take:${request.id}` },
    { text: "🚫 Can't", callback_data: `decline:${request.id}` }
  ]]);
}

/**
 * Новая заявка уходит в рабочую группу и копией в Google-таблицу.
 * Возвращает false, если группа ещё не подключена.
 */
export async function publishRequest(request) {
  await mirrorNewRequest(request);

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
  if (!request.client_chat_id) return;
  if (request.channel === 'telegram') {
    const name = `<b>${escapeHtml(request.taken_by_name)}</b>`;
    await sendMessage(request.client_chat_id, t(request.lang, 'manager_taken', { id: request.id, name }));
  } else if (request.channel === 'whatsapp') {
    const name = `*${request.taken_by_name}*`;
    await waSendText(request.client_chat_id, t(request.lang, 'manager_taken', { id: request.id, name }));
  }
}

export async function handleStaffCallback(query, action, requestId) {
  if (!isStaffChat(query.message?.chat?.id)) return answerCallback(query);

  const request = db.getRequest(requestId);
  if (!request) return answerCallback(query, 'Request not found');

  const name = displayName(query.from);

  if (action === 'take') {
    if (!db.takeRequest(request.id, query.from.id, name)) {
      return answerCallback(query, `Already taken by ${db.getRequest(request.id).taken_by_name}`);
    }
    const taken = db.getRequest(request.id);
    await refreshStaffMessage(taken);
    await answerCallback(query, `Request #${taken.id} is yours`);
    await notifyClientTaken(taken);
    await mirrorRequestStatus(taken);
    return;
  }

  if (action === 'decline') {
    if (request.status !== 'new') return answerCallback(query, 'Already taken');
    await refreshStaffMessage(db.addDecline(request.id, name));
    return answerCallback(query, 'OK, thanks');
  }

  return answerCallback(query);
}

async function bindGroup(msg) {
  if (config.telegram.staffChatId) {
    return sendMessage(msg.chat.id, 'The staff group is set in the server settings — /bind is not needed here.');
  }

  const member = await tg('getChatMember', { chat_id: msg.chat.id, user_id: msg.from.id });
  if (!['creator', 'administrator'].includes(member.status)) {
    return sendMessage(msg.chat.id, 'Only a group admin can connect this group.');
  }

  db.setSetting('staff_chat_id', msg.chat.id);
  return sendMessage(msg.chat.id, '✅ Done! New requests will come to this group.\nTry the buttons: /test');
}

async function createTestRequest(msg) {
  if (!isStaffChat(msg.chat.id)) {
    return sendMessage(msg.chat.id, 'Connect this group first with /bind.');
  }

  const start = new Date(`${todayIso()}T00:00:00Z`);
  const shift = (days) => new Date(start.getTime() + days * 86400000).toISOString().slice(0, 10);

  const request = db.createRequest({
    channel: 'test',
    clientName: 'Test client',
    clientPhone: '+66 00 000 0000',
    vehicleType: 'scooter',
    dateFrom: shift(3),
    dateTo: shift(10),
    comment: `created by ${displayName(msg.from)}`
  });
  await publishRequest(request);
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
      '👋 Hi! I\'m the rental requests assistant.\nTo receive new requests in this group, an admin sends /bind'
    );
  }
}
