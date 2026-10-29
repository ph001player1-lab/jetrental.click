/**
 * Тонкая обёртка над Telegram Bot API (https://core.telegram.org/bots/api).
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { LANGUAGES, t } from '../i18n.js';
import { g } from '../groupTexts.js';

export const telegramEnabled = Boolean(config.telegram.token);

/**
 * Секрет вебхука: Telegram присылает его в заголовке каждого запроса, так мы
 * отличаем настоящие обновления от чужих. Выводится из токена, чтобы не
 * заводить ещё одну переменную.
 */
export const webhookSecret = telegramEnabled
  ? crypto.createHash('sha256').update(`webhook:${config.telegram.token}`).digest('hex').slice(0, 48)
  : '';

export async function tg(method, payload = {}) {
  const response = await fetch(`${config.telegram.apiBase}/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
  }
  return data.result;
}

export function sendMessage(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function answerCallback(query, text) {
  return tg('answerCallbackQuery', { callback_query_id: query.id, ...(text ? { text } : {}) });
}

/** Имя пользователя Telegram для показа сотрудникам: «Николай Б.» или @username */
export function displayName(user) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return full || (user.username ? `@${user.username}` : String(user.id));
}

let botUsername = '';

/**
 * '/bind@JetRental_bot extra' → 'bind'. Команды, адресованные другому боту
 * в той же группе, игнорируем.
 */
export function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const [command, mention] = text.trim().split(/\s+/)[0].slice(1).split('@');
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return null;
  return command.toLowerCase();
}

/** Регистрирует вебхук и меню команд при старте сервера. */
export async function setupTelegram() {
  const me = await tg('getMe');
  botUsername = me.username;

  await tg('setWebhook', {
    url: `${config.publicBaseUrl}/webhooks/telegram`,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query', 'my_chat_member']
  });

  // Меню команд в личке: по умолчанию по-английски, для ru/th/zh — на языке приложения Telegram
  for (const lang of [null, ...Object.keys(LANGUAGES)]) {
    await tg('setMyCommands', {
      commands: [
        { command: 'start', description: t(lang, 'cmd_start') },
        { command: 'lang', description: t(lang, 'cmd_lang') }
      ],
      scope: { type: 'all_private_chats' },
      ...(lang ? { language_code: lang } : {})
    });
  }
  await tg('setMyCommands', {
    commands: [
      { command: 'bind', description: g('cmd.bind') },
      { command: 'test', description: g('cmd.test') },
      { command: 'summary', description: g('cmd.summary') }
    ],
    scope: { type: 'all_group_chats' }
  });
}
