/**
 * Маршрутизация обновлений Telegram: личка → диалог с клиентом,
 * группа → ассистент сотрудников, кнопки → соответствующий обработчик.
 */

import { handleTelegramPrivateMessage, handleTelegramClientCallback } from '../channels/telegram.js';
import { handleGroupMessage, handleStaffCallback, handleMyChatMember } from '../staff.js';
import { answerCallback } from './api.js';

export async function handleUpdate(update) {
  if (update.callback_query) return handleCallbackQuery(update.callback_query);
  if (update.my_chat_member) return handleMyChatMember(update.my_chat_member);

  const msg = update.message;
  if (!msg || !msg.from) return;

  const chatType = msg.chat.type;
  if (chatType === 'private') return handleTelegramPrivateMessage(msg);
  if (chatType === 'group' || chatType === 'supergroup') return handleGroupMessage(msg);
}

async function handleCallbackQuery(query) {
  const [action, value] = String(query.data || '').split(':');

  if (action === 'type' || action === 'model') return handleTelegramClientCallback(query, action, value);
  if (action === 'take' || action === 'decline') return handleStaffCallback(query, action, Number(value));

  return answerCallback(query);
}
