/**
 * ============================================================================
 * Живые счётчики для вкладки «Игра»: кто сейчас на сайте и кто пишет ботам
 * ============================================================================
 * Только в памяти сервера и без личных данных: обезличенный ключ (хеш), время,
 * откуда пришёл посетитель и канал бота. После перезапуска — с нуля.
 *   — посетители: из журнала Caddy (traffic.js читает его раз в 30 секунд);
 *     «сейчас на сайте» — открывал страницы за последние 5 минут;
 *   — чаты: каждое сообщение клиента боту (WhatsApp, Telegram), последний час.
 * ============================================================================
 */

import crypto from 'node:crypto';

const ONLINE_MS = 5 * 60 * 1000;
const CHAT_KEEP_MS = 60 * 60 * 1000;
const CHAT_ACTIVE_MS = 10 * 60 * 1000;

const visitors = new Map(); // ключ → { at, site, source, device }
const chats = [];           // { at, channel, key }

function pruneVisitors(now) {
  for (const [key, v] of visitors) if (now - v.at > ONLINE_MS * 2) visitors.delete(key);
}

/** Страница сайта открыта (строка журнала Caddy); source — откуда пришёл (домен, utm, код ссылки) */
export function noteSiteHit({ key, site, source = null, device = null, at = Date.now() }) {
  if (!key) return;
  const v = visitors.get(key);
  if (v) {
    if (at > v.at) v.at = at;
    if (!v.source && source) v.source = source;
  } else visitors.set(key, { at, site, source, device });
  if (visitors.size > 5000) pruneVisitors(Date.now());
}

/** Сейчас на сайтах: сколько и откуда (без личных данных) */
export function siteOnline(now = Date.now()) {
  pruneVisitors(now);
  const list = [...visitors.values()].filter((v) => now - v.at < ONLINE_MS);
  const count = (field, empty) => {
    const map = new Map();
    for (const v of list) { const k = v[field] || empty; map.set(k, (map.get(k) || 0) + 1); }
    return [...map].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  };
  return { online: list.length, sources: count('source', 'прямой заход'), sites: count('site', '—'), devices: count('device', '—') };
}

const hashKey = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);

/** Клиент написал боту (chat — из client.js: { channel, key }) */
export function noteBotChat(chat) {
  if (!chat?.key) return;
  const now = Date.now();
  chats.push({ at: now, channel: String(chat.channel || 'bot'), key: hashKey(chat.key) });
  while (chats.length && (now - chats[0].at > CHAT_KEEP_MS || chats.length > 500)) chats.shift();
}

/** Сообщения клиентов ботам после момента sinceMs (для анимации) */
export const botChatsSince = (sinceMs) => chats.filter((c) => c.at > sinceMs);

/** Сколько разных клиентов пишут ботам сейчас (за 10 минут), по каналам */
export function botChatsActive(now = Date.now()) {
  const keys = new Map();
  for (const c of chats) if (now - c.at < CHAT_ACTIVE_MS) keys.set(c.key, c.channel);
  const byChannel = {};
  for (const ch of keys.values()) byChannel[ch] = (byChannel[ch] || 0) + 1;
  return { active: keys.size, byChannel };
}
