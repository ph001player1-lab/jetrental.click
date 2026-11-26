/**
 * Адаптер WhatsApp-бота (номер компании через контейнер wabot) для общего
 * диалога с клиентом (client.js).
 *
 * В неофициальном WhatsApp нет кнопок, поэтому варианты — нумерованным
 * списком, клиент отвечает цифрой или словом. Всё, что бот хочет сказать в
 * ответ на одно сообщение клиента, уходит ОДНИМ сообщением — как у человека.
 */

import * as db from '../db.js';
import { t } from '../i18n.js';

const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const CHOICE_TTL_MS = 24 * 3600 * 1000;

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS wa_choices (
    chat_key TEXT PRIMARY KEY,
    options  TEXT NOT NULL,
    at       TEXT NOT NULL
  );
`);

const q = {
  get: db.raw.prepare('SELECT options, at FROM wa_choices WHERE chat_key = ?'),
  set: db.raw.prepare(`INSERT INTO wa_choices (chat_key, options, at) VALUES (?, ?, ?)
    ON CONFLICT(chat_key) DO UPDATE SET options = excluded.options, at = excluded.at`),
  del: db.raw.prepare('DELETE FROM wa_choices WHERE chat_key = ?')
};

/** «🛵 Скутер» → «скутер»: без эмодзи и знаков, для сравнения с ответом клиента */
const plain = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** «2», «2.», «2)», «2️⃣», «🔟» → номер варианта (с 1); иначе null */
function numberOf(text) {
  const v = String(text || '').trim();
  if (v === '🔟') return 10;
  const m = /^(\d{1,2})\s*[.)]?$/.exec(v.replace(/️|⃣/g, ''));
  return m ? Number(m[1]) : null;
}

/** Вариант, который выбрал клиент: по номеру или по названию */
export function pickChoice(chatKey, text) {
  const row = q.get.get(chatKey);
  if (!row || Date.now() - Date.parse(row.at) > CHOICE_TTL_MS) return null;
  let options;
  try { options = JSON.parse(row.options); } catch { return null; }
  const n = numberOf(text);
  let found = n ? options[n - 1] : null;
  if (!found && !n) {
    const v = plain(text);
    if (v) {
      found = options.find((o) => plain(o.title) === v) || null;
      if (!found && v.length >= 3) {
        const starts = options.filter((o) => plain(o.title).startsWith(v));
        if (starts.length === 1) [found] = starts;
      }
    }
  }
  if (!found) return null;
  q.del.run(chatKey);
  const at = String(found.id).indexOf(':');
  return { action: String(found.id).slice(0, at), value: String(found.id).slice(at + 1) };
}

export function wabotUi(chatKey, send) {
  const out = [];
  let footer = '';
  const lang = () => db.getChatLanguage(chatKey);
  return {
    // client.js: варианты текстом — не дублировать их в самом сообщении
    textChoices: true,
    b: (text) => `*${String(text ?? '')}*`,
    esc: (text) => String(text ?? ''),
    send: async (text) => { out.push(String(text)); },
    choices: async (text, options) => {
      // «Назад» — всегда «0», остальные варианты по порядку с 1
      const main = options.filter((o) => !o.back);
      const back = options.find((o) => o.back);
      q.set.run(chatKey, JSON.stringify(main.map((o) => ({ id: o.id, title: o.title }))), new Date().toISOString());
      const lines = main.map((o, i) => `${KEYCAPS[i] || `${i + 1}.`} ${o.title}${o.description ? ` — ${o.description}` : ''}`);
      if (back) lines.push(`0️⃣ ${back.title}`);
      // До выбора языка подсказка на двух языках
      const hint = lang() ? t(lang(), 'reply_number') : `${t('en', 'reply_number').replace(/\s*👆$/u, '')} · ${t('ru', 'reply_number')}`;
      out.push([text, lines.join('\n'), main.length ? hint : ''].filter(Boolean).join('\n\n'));
    },
    // Номер телефона в WhatsApp обычно известен; если нет — клиент пишет его сообщением
    askPhone: async (text, buttonText, backText) => { out.push(backText ? `${text}\n\n0️⃣ ${backText}` : String(text)); },
    ack: async () => {},
    // «Вы выбрали: …» — подтверждение в начале следующего ответа
    closeChoices: async (note) => { if (note) out.push(String(note)); },
    restartHint: (l) => t(l, 'restart_whatsapp'),
    setFooter: (text) => { footer = text; },
    /** Отправить накопленное одним сообщением */
    flush: async () => {
      if (!out.length) return;
      const message = [...out.splice(0), footer].filter(Boolean).join('\n\n');
      footer = '';
      await send(message);
    }
  };
}
