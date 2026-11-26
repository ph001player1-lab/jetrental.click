/**
 * ============================================================================
 * WhatsApp-бот для клиентов: связь с контейнером wabot
 * ============================================================================
 * Номер компании подключён в wabot как «связанное устройство». Здесь:
 *   - входящие от клиентов → общий диалог (client.js), ответ — через wabot;
 *   - заявка → карточкой в выбранную рабочую группу WhatsApp; сотрудник
 *     отвечает на неё «+» — заявка его (или «-» — не может);
 *   - бот отвечает всегда: если у клиента открытая заявка (или он просил
 *     менеджера), бот говорит, кто ей занимается, и пересылает сообщение
 *     клиента в рабочую группу; новая заявка — «старт» или «0»;
 *   - молчит только час, если кто-то написал клиенту прямо с телефона бота.
 * Режимы: off — бот молчит; test — отвечает только тестовым номерам;
 * on — всем, кто написал (и сотрудникам тоже — так проще проверять).
 *
 * Внутренний API (порт 3001, общий секрет):
 *   POST /internal/wabot/status   { connected, status, me, groupId, members, … }
 *   POST /internal/wabot/message  { kind: client | manual | group, … }
 * Сайт сотрудников («Маркетинг» → «Офис» → WhatsApp-бот):
 *   GET  /api/staff/wabot, POST /api/staff/wabot/{settings,config,pair,logout}
 * ============================================================================
 */

import { config } from './config.js';
import { HttpError, sendJson, readJson } from './http.js';
import { can } from './roles.js';
import * as db from './db.js';
import { handleClientText, handleClientChoice, isRestartText } from './client.js';
import { wabotUi, pickChoice } from './channels/wabot.js';
import { formatStaffRequest, formatShortDate, escapeHtml } from './format.js';
import { t, normalizeLanguage } from './i18n.js';
import { g } from './groupTexts.js';
import { staffPhones } from './staffUsers.js';
import { marketingSettings, saveSettings as saveMarketingSettings } from './marketing.js';
import { onRequestTaken, refreshStaffMessage, getStaffChatId, sendToStaffGroup } from './staff.js';

export const wabotConfigured = Boolean(config.internal.secret);
const STALE_MS = 6 * 60 * 1000;
// Кто-то написал клиенту прямо с телефона бота — бот молчит час, чтобы не перебивать
const MANUAL_PAUSE_MS = 3600000;
// Заявка «открыта» (бот говорит её статус и пересылает сообщения клиента): новая или взятая за 3 дня
const OPEN_DAYS = 3;
// «Связаться с менеджером» помним сутки
const MANAGER_ASK_MS = 24 * 3600000;
// Полный статус — не чаще раза в 30 минут, между ними «передал менеджеру ✅»
const STATUS_EVERY_MS = 30 * 60000;

const MODES = ['off', 'test', 'on'];

const status = {
  connected: false, status: null, me: null, groupId: null, groupSubject: null,
  members: new Set(), lastSeenAt: null, lastInboundAt: null, today: null, undecrypted: []
};

const digits = (v) => String(v || '').replace(/\D/g, '');
const later = (ms) => new Date(Date.now() + ms).toISOString();

/* ---------------------------------------------------------- Настройки */

export function wabotSettings() {
  let saved = {};
  try { saved = JSON.parse(db.getSetting('wabot_settings') || '{}') || {}; } catch { /* по умолчанию */ }
  return {
    mode: MODES.includes(saved.mode) ? saved.mode : 'off',
    testNumbers: Array.isArray(saved.testNumbers) ? saved.testNumbers : [],
    // Заявки и в Telegram-группу (по умолчанию — только в WhatsApp-группу)
    telegramCopy: saved.telegramCopy === true
  };
}

export function saveWabotSettings(input) {
  const cur = wabotSettings();
  const mode = MODES.includes(input.mode) ? input.mode : cur.mode;
  const testNumbers = input.testNumbers === undefined ? cur.testNumbers
    : [...new Set(String(input.testNumbers).split(/[,;\n]+/).map(digits).filter((n) => n.length >= 8 && n.length <= 15))].slice(0, 20);
  const telegramCopy = typeof input.telegramCopy === 'boolean' ? input.telegramCopy : cur.telegramCopy;
  db.setSetting('wabot_settings', JSON.stringify({ mode, testNumbers, telegramCopy }));
  // «Маркетинг»: отвечает ли бот в WhatsApp — по этому режиму
  saveMarketingSettings({ bots: { wa: mode === 'on' } });
  return { mode, testNumbers, telegramCopy };
}

/* ------------------------------------------------------------ Состояние */

/** Для «Маркетинга», вкладки «Сервер» и оповещений */
export function wabotStatus(now = Date.now()) {
  const fresh = status.lastSeenAt && now - Date.parse(status.lastSeenAt) < STALE_MS;
  const lastOk = db.getSetting('wabot_last_ok');
  return {
    configured: wabotConfigured,
    connected: Boolean(fresh && status.connected),
    status: fresh ? status.status : status.lastSeenAt ? 'silent' : null,
    me: status.me,
    groupId: status.groupId,
    groupSubject: status.groupSubject,
    lastInboundAt: status.lastInboundAt,
    // Не расшифровались (WhatsApp досылает сам) — для диагностики
    undecrypted: status.undecrypted,
    // С какого времени WhatsApp отвечает «rate-overlimit» (null — не ограничивает)
    limitedAt: status.limitedAt || null,
    // Последний раз на связи (для оповещения «бот молчит»); null — ещё не подключали
    lastOkAt: lastOk || null
  };
}

function saveStatus(body) {
  Object.assign(status, {
    connected: Boolean(body.connected), status: String(body.status || ''),
    me: body.me?.id ? { id: digits(body.me.id), name: body.me.name ? String(body.me.name).slice(0, 80) : null } : null,
    groupId: body.groupId ? String(body.groupId) : null, groupSubject: body.groupSubject ? String(body.groupSubject).slice(0, 120) : null,
    members: new Set((Array.isArray(body.members) ? body.members : []).map(digits).filter(Boolean)),
    lastSeenAt: new Date().toISOString(), lastInboundAt: body.lastInboundAt || null,
    today: body.today?.date ? { date: String(body.today.date).slice(0, 10), received: Number(body.today.received) || 0, sent: Number(body.today.sent) || 0 } : null,
    undecrypted: Array.isArray(body.undecrypted) ? body.undecrypted.slice(-30) : [],
    limitedAt: body.limitedAt || null
  });
  if (status.connected) {
    db.setSetting('wabot_last_ok', status.lastSeenAt);
    // Номер для ссылок wa.me во вкладке «Маркетинг» — номер бота, если ещё не задан
    if (status.me?.id && !marketingSettings().waNumber) saveMarketingSettings({ waNumber: status.me.id });
  }
}

/* --------------------------------------------------- Запросы к wabot */

async function wabotCall(method, pathname, body) {
  if (!wabotConfigured) throw new HttpError(503, 'wabot_not_configured');
  let response;
  try {
    response = await fetch(`${config.internal.wabotUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': config.internal.secret },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90000)
    });
  } catch {
    throw new HttpError(503, 'wabot_unreachable');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 400 ? 400 : response.status === 409 ? 409 : 502, data.error || 'wabot_failed');
  return data;
}

/** Сообщение в WhatsApp от номера компании: клиенту (jid или номер) или в группу */
// Последняя неудачная отправка в группу (null — после неё всё ушло) — для «Обзора»
let groupFailure = null;
export const wabotGroupFailure = () => groupFailure;
/** Выбрана ли группа WhatsApp для заявок (по последнему отчёту бота) */
export const waGroupChosen = () => Boolean(status.groupId);

export async function wabotSend(to, text, quoted = null) {
  if (String(to).endsWith('@g.us')) {
    try {
      const id = (await wabotCall('POST', '/send', { to, text, quoted })).id;
      groupFailure = null;
      return id;
    } catch (err) {
      groupFailure = { at: new Date().toISOString(), message: err.code || err.message };
      throw err;
    }
  }
  return (await wabotCall('POST', '/send', { to, text, quoted })).id;
}

/* ------------------------------------------------- Диалог с клиентом */

function detectLanguage(text) {
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';
  if (/[฀-๿]/.test(text)) return 'th';
  if (/[一-鿿]/.test(text)) return 'zh';
  // Латиницу не угадываем: это может быть и не английский — спросим язык
  return null;
}

/** Отвечает ли бот этому клиенту; null — нет (тогда отвечают люди с телефона) */
function acceptClient(body) {
  const phone = digits(body.phone);
  const jid = String(body.jid || '');
  if (!jid) return null;
  const key = phone ? `wa:${phone}` : `wa:${jid}`;
  const { mode, testNumbers } = wabotSettings();
  if (mode === 'off') return null;
  if (mode === 'test' && !(phone && testNumbers.includes(phone))) return null;
  if (db.isChatPaused(key)) {
    // Клиент сам попросил меню или пришёл по ссылке с сайта / от агента ([ref:…]) —
    // это новое обращение, бот снова на связи
    if (!isRestartText(body.text) && !/\[ref:/i.test(String(body.text || ''))) return null;
    console.log(`WhatsApp bot: ${key} was quiet, woke up on a ${isRestartText(body.text) ? '«menu»' : 'link'} message`);
    db.pauseChat(key, new Date(0).toISOString());
  }
  return { key, phone, jid, name: body.name ? String(body.name).slice(0, 80) : '' };
}

// Последний ответ в чате: тот же вопрос второй раз подряд (клиент написал два
// сообщения, пока бот «печатал») не повторяем
const lastReply = new Map();
const REPEAT_MS = 90 * 1000;

// Сообщения одного клиента обрабатываем по очереди (он может написать два подряд)
const chains = new Map();
function inChat(key, task) {
  const next = (chains.get(key) || Promise.resolve()).then(task).catch((err) => console.error('WhatsApp bot chat failed:', err.message));
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}

const whoOf = (c) => [c.name, c.phone ? `+${c.phone}` : null].filter(Boolean).join(' · ') || c.jid;

async function askManager(c, lang) {
  db.setSetting(`wa_manager:${c.key}`, new Date().toISOString());
  if (status.groupId) {
    await wabotSend(status.groupId, g('wa.manager', { who: whoOf(c) })).catch((err) => console.error('WhatsApp group note failed:', err.message));
  }
  return `${t(lang, 'manager_soon')}\n\n${t(lang, 'new_request_hint')}`;
}

/** Открытое обращение клиента: заявка (новая или взятая за 3 дня) или «Связаться с менеджером» за сутки */
function openThread(c) {
  const since = new Date(Date.now() - OPEN_DAYS * 86400000).toISOString();
  const request = db.openRequestForClient(c.jid, c.phone ? `+${c.phone}` : null, since);
  if (request) return { kind: 'request', request };
  const asked = db.getSetting(`wa_manager:${c.key}`);
  if (asked && Date.now() - Date.parse(asked) < MANAGER_ASK_MS) return { kind: 'manager', at: asked };
  return null;
}

const MEDIA_KEYS = { photo: 'wa.media.photo', video: 'wa.media.video', voice: 'wa.media.voice', document: 'wa.media.document', sticker: 'wa.media.sticker', location: 'wa.media.location', contact: 'wa.media.contact' };

/** Сообщение клиента — в рабочую группу (ответом на карточку заявки, если она там есть) */
async function forwardToGroup(c, thread, body) {
  const text = String(body.text || '').trim();
  const what = text ? `«${text.slice(0, 1000)}»` : g(MEDIA_KEYS[body.media] || 'wa.media.other');
  const r = thread.request;
  const line = r ? g('wa.clientWrote', { id: r.id, who: whoOf(c), text: what }) : g('wa.clientWroteManager', { who: whoOf(c), text: what });
  if (status.groupId && wabotStatus().connected) {
    const quoted = r && r.wa_group_id === status.groupId && r.wa_group_message_id
      ? { id: r.wa_group_message_id, fromMe: true, text: g('card.title', { id: r.id }).replace(/<[^>]+>/g, '') } : null;
    return wabotSend(status.groupId, line, quoted);
  }
  // WhatsApp-группы нет — в Telegram-группу, чтобы сообщение не потерялось
  if (getStaffChatId()) return sendToStaffGroup(escapeHtml(line));
  return null;
}

/** Клиенту: кто занимается заявкой + «передал менеджеру»; полный статус — не чаще раза в 30 минут */
async function statusReply(c, ui, thread, body) {
  const lang = normalizeLanguage(db.getChatLanguage(c.key) || thread.request?.lang);
  let forwarded = true;
  try {
    await forwardToGroup(c, thread, body);
  } catch (err) {
    forwarded = false;
    console.error(`WhatsApp bot: forwarding ${c.key} to the group failed:`, err.message);
  }
  const lastAt = Number(db.getSetting(`wa_status:${c.key}`) || 0);
  const parts = [];
  if (Date.now() - lastAt > STATUS_EVERY_MS) {
    const r = thread.request;
    if (!r) parts.push(t(lang, 'status_manager'));
    else {
      const what = [t(lang, `type_${r.vehicle_type}`), r.date_from && r.date_to ? `${formatShortDate(r.date_from)} – ${formatShortDate(r.date_to)}` : null].filter(Boolean).join(', ');
      parts.push(r.status === 'taken'
        ? t(lang, 'status_taken', { id: r.id, what, name: `*${r.taken_by_name}*` })
        : t(lang, 'status_new', { id: r.id, what }));
    }
    db.setSetting(`wa_status:${c.key}`, String(Date.now()));
  }
  if (forwarded) parts.push(t(lang, 'forwarded'));
  parts.push(t(lang, 'new_request_hint'));
  console.log(`WhatsApp bot: ${c.key} has an open ${thread.request ? `request #${thread.request.id} (${thread.request.status})` : 'manager ask'} — status sent, message ${forwarded ? 'forwarded' : 'NOT forwarded'}`);
  await ui.send(parts.join('\n\n'));
}

async function handleClient(c, body) {
  const ui = wabotUi(c.key, async (text) => {
    const last = lastReply.get(c.key);
    if (last && last.text === text && Date.now() - last.at < REPEAT_MS) {
      console.log(`WhatsApp bot: same reply to ${c.key} not repeated`);
      return;
    }
    lastReply.set(c.key, { text, at: Date.now() });
    if (lastReply.size > 2000) lastReply.delete(lastReply.keys().next().value);
    await wabotSend(c.jid, text);
  });
  const chat = {
    channel: 'whatsapp', key: c.key, id: c.jid, name: c.name, phone: c.phone ? `+${c.phone}` : null, ui,
    managerOption: true,
    // Новая заявка — «Связаться с менеджером» больше не висит
    afterRequest: () => db.setSetting(`wa_manager:${c.key}`, ''),
    onManager: async (lang) => ui.send(await askManager(c, lang))
  };
  const text = String(body.text || '').trim();
  try {
    const choice = text ? pickChoice(c.key, text) : null;
    if (choice) return await handleClientChoice(chat, choice.action, choice.value);
    // Язык — по первому сообщению (кириллица, тайский, китайский)
    if (text && !db.getChatLanguage(c.key)) {
      const lang = detectLanguage(text);
      if (lang) {
        db.setChatLanguage(c.key, lang);
        if (db.getSession(c.key)?.step === 'lang') db.clearSession(c.key);
        ui.setFooter(t(lang, 'lang_hint'));
      }
    }
    // Открытая заявка и не начат новый диалог: статус + сообщение — менеджеру.
    // «старт», «0» или ссылка с сайта ([ref:…]) — новая заявка
    const session = db.getSession(c.key);
    const fresh = isRestartText(text) || text === '0' || /\[ref:/i.test(text);
    if (!session && !fresh) {
      const thread = openThread(c);
      if (thread) return await statusReply(c, ui, thread, body);
    }
    if (!text && body.media) {
      const lang = db.getChatLanguage(c.key);
      if (lang && session) return await ui.send(t(lang, 'media_unsupported'));
    }
    return await handleClientText(chat, text);
  } finally {
    await ui.flush();
  }
}

/* ---------------------------------------------- Рабочая группа WhatsApp */

// «Взять»: «+», «+14», «беру 14», «#14 беру»… Без ответа на карточку сообщение должно быть
// ТОЛЬКО этим (иначе «+66 81…» с номером телефона приняли бы за заявку #66)
const TAKE_WORD = '(?:\\+|➕|беру|взял|взяла|возьму|take|taken|mine|รับ)';
// 👍 и ✋ — «взять» только в ответ на карточку: просто 👍 в группе — обычное «ок»
const TAKE_REPLY_WORD = '(?:\\+|➕|✋|👍|беру|взял|взяла|возьму|take|taken|mine|รับ)';
const DECLINE_WORD = '(?:-|—|➖|не могу|не смогу|can\'?t|cannot)';
const NUM = '\\s*#?\\s*(\\d{1,6})?\\s*[!.)]*\\s*';
const TAKE_START = new RegExp(`^\\s*${TAKE_REPLY_WORD}`, 'i');
const DECLINE_START = new RegExp(`^\\s*${DECLINE_WORD}`, 'i');
const TAKE_ONLY = new RegExp(`^\\s*${TAKE_WORD}${NUM}$`, 'i');
const DECLINE_ONLY = new RegExp(`^\\s*${DECLINE_WORD}${NUM}$`, 'i');
const OPEN_HOURS = 3;

/** Карточка заявки из HTML Telegram → разметка WhatsApp */
function htmlToWa(html) {
  return String(html)
    .replace(/<b>([\s\S]*?)<\/b>/g, '*$1*')
    .replace(/<i>([\s\S]*?)<\/i>/g, '_$1_')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Новая заявка → карточкой в рабочую группу WhatsApp; false — группа не выбрана или бот не на связи */
export async function postRequestToWaGroup(request) {
  if (!wabotConfigured || !status.groupId || !wabotStatus().connected) return false;
  const id = await wabotSend(status.groupId, `${htmlToWa(formatStaffRequest(request))}\n\n${g('wa.takeHint', { id: request.id })}`);
  db.setWaGroupMessage(request.id, status.groupId, id);
  return true;
}

/** Заявку взяли в Telegram или на сайте — пишем об этом и в группу WhatsApp (ответом на карточку) */
export async function noteTakenInWaGroup(request) {
  if (!request.wa_group_id || !request.wa_group_message_id || !wabotStatus().connected) return;
  await wabotSend(request.wa_group_id, g('wa.takenElsewhere', { id: request.id, name: request.taken_by_name }),
    { id: request.wa_group_message_id, fromMe: true, text: g('card.title', { id: request.id }).replace(/<[^>]+>/g, '') });
}

/**
 * Сообщение рабочей группы (wabot передаёт только ответы на сообщения и короткие
 * «+», «+14», «беру», «-»). Какая заявка: ответ на карточку → её; «+14» → №14;
 * просто «+» → единственная невзятая за последние 3 часа (несколько — спросим номер).
 */
async function handleGroupReply(body) {
  const groupId = status.groupId;
  const text = String(body.text || '').trim();
  const author = digits(body.author);
  let name = body.authorName ? String(body.authorName).slice(0, 80) : author ? `+${author}` : 'WhatsApp';
  try { name = (await staffPhones()).get(author) || name; } catch { /* имя из WhatsApp */ }
  const who = `«${name}» (+${author || '?'}, WhatsApp name «${body.authorName || '-'}»)`;
  const reply = { id: body.id, participant: body.authorJid || undefined, text };
  const say = (key, params) => wabotSend(groupId, g(key, params), reply).catch((err) => console.error('WhatsApp group reply failed:', err.message));

  const carded = body.quotedId ? db.requestByWaGroupMessage(String(body.quotedId)) : null;
  // Ответ на карточку: «+» или «беру…» в начале. Без ответа: сообщение — только «+» / «+14» / «-14»
  const only = text.match(TAKE_ONLY) || text.match(DECLINE_ONLY);
  const isTake = carded ? TAKE_START.test(text) : TAKE_ONLY.test(text);
  const isDecline = !isTake && (carded ? DECLINE_START.test(text) : DECLINE_ONLY.test(text));
  if (!isTake && !isDecline) {
    if (body.quotedId) console.log(`WhatsApp group: reply from ${who} is not «+» / «-» — ignored`);
    return;
  }
  const number = only?.[1] ? Number(only[1]) : null;
  const since = new Date(Date.now() - OPEN_HOURS * 3600000).toISOString();
  const open = groupId ? db.openRequestsInWaGroup(groupId, since) : [];
  const list = open.map((r) => `#${r.id}`).join(', ');

  let request = carded;
  if (!request && number) {
    request = db.getRequest(number);
    if (!request || request.channel === 'test') {
      console.log(`WhatsApp group: ${who} wrote «${text}» — no request #${number}`);
      if (isTake) await say(open.length ? 'wa.notFound' : 'wa.noneOpen', { id: number, list });
      return;
    }
  }
  if (!request) {
    if (open.length === 1) [request] = open;
    else if (open.length > 1) {
      console.log(`WhatsApp group: ${who} wrote «${text}» — several new requests (${list}), asked which one`);
      if (isTake) await say('wa.pickOne', { list, first: open[0].id });
      return;
    } else {
      // Невзятых нет: если заявку только что взяли — скажем кто, иначе молчим («+» мог быть о другом)
      const recent = isTake && groupId ? db.recentlyTakenInWaGroup(groupId, new Date(Date.now() - 15 * 60000).toISOString())[0] : null;
      console.log(`WhatsApp group: ${who} wrote «${text}» — no new requests${recent ? `, #${recent.id} taken by «${recent.taken_by_name}»` : ''}`);
      if (recent) await say('wa.alreadyTaken', { id: recent.id, name: recent.taken_by_name });
      return;
    }
  }

  if (isTake) {
    if (!db.takeRequest(request.id, `wa:${author}`, name)) {
      const cur = db.getRequest(request.id);
      console.log(`Request #${request.id}: «${text}» from ${who} — already taken by «${cur?.taken_by_name}» (${cur?.taken_by_id})`);
      if (cur?.status === 'taken') await say('wa.alreadyTaken', { id: cur.id, name: cur.taken_by_name });
      return;
    }
    console.log(`Request #${request.id} taken in the WhatsApp group by ${who}, ${carded ? 'reply to the card' : number ? `by number «${text}»` : `plain «${text}» (the only new request)`}`);
    await say('wa.taken', { id: request.id, name });
    await onRequestTaken(db.getRequest(request.id), 'wa');
    return;
  }
  if (request.status !== 'new') return;
  const updated = db.addDecline(request.id, name);
  console.log(`Request #${request.id}: ${who} can't take it`);
  await wabotCall('POST', '/react', { jid: groupId, id: body.id, participant: body.authorJid, emoji: '👌' })
    .catch((err) => console.error('WhatsApp reaction failed:', err.message));
  await refreshStaffMessage(updated).catch((err) => console.error('Telegram card refresh failed:', err.message));
}

/* ---------------------------------------------------- Внутренний API */

export async function handleWabotInternal(req, res, url) {
  if (url.pathname === '/internal/wabot/status') {
    saveStatus(await readJson(req));
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/internal/wabot/message') {
    const body = await readJson(req);
    if (body.kind === 'manual') {
      // Менеджер ответил клиенту сам — бот в этом чате молчит
      const phone = digits(body.phone);
      db.pauseChat(phone ? `wa:${phone}` : `wa:${body.jid}`, later(MANUAL_PAUSE_MS));
      return sendJson(res, 200, { ok: true });
    }
    if (body.kind === 'group') {
      sendJson(res, 200, { ok: true });
      handleGroupReply(body).catch((err) => console.error('WhatsApp group reply failed:', err.message));
      return undefined;
    }
    if (body.kind === 'client') {
      // Повторная доставка того же сообщения — уже ответили
      if (body.id && !db.markEventProcessed(`wabot:${body.id}`)) {
        console.log(`WhatsApp bot: message ${body.id} already handled`);
        return sendJson(res, 200, { ok: true, read: false });
      }
      const c = acceptClient(body);
      // Отвечаем сразу: что бот ответит клиенту, решено; сам ответ — следом
      sendJson(res, 200, { ok: true, read: Boolean(c) });
      if (c) inChat(c.key, () => handleClient(c, body));
      return undefined;
    }
    return sendJson(res, 400, { error: 'bad_kind' });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

/* ------------------------------------------- Сайт сотрудников (Маркетинг) */

function needEdit(staff) {
  if (!can(staff, 'marketing.edit')) throw new HttpError(403, 'read_only');
}

export async function wabotPortalStatus(staff, req, res) {
  if (!can(staff, 'marketing.view')) throw new HttpError(403, 'no_section_access');
  const base = { settings: wabotSettings(), canEdit: can(staff, 'marketing.edit'), members: status.members.size, today: status.today };
  let live;
  try {
    live = await wabotCall('GET', '/status');
  } catch (err) {
    return sendJson(res, 200, { ...base, ...wabotStatus(), reachable: false, error: err.code });
  }
  sendJson(res, 200, {
    ...base,
    reachable: true,
    status: live.status,
    qr: live.qrSvg ? `data:image/svg+xml;base64,${Buffer.from(live.qrSvg).toString('base64')}` : null,
    pairingCode: live.pairingCode,
    me: live.me,
    groups: live.groups,
    groupId: live.groupId,
    groupSubject: live.groupSubject,
    lastInboundAt: live.lastInboundAt,
    today: live.today
  });
}

export async function wabotPortalSettings(staff, req, res) {
  needEdit(staff);
  const result = saveWabotSettings(await readJson(req));
  console.log(`WhatsApp bot mode «${result.mode}», Telegram copy ${result.telegramCopy ? 'on' : 'off'} set by ${staff.email}`);
  sendJson(res, 200, { ok: true, settings: result });
}

export async function wabotPortalConfig(staff, req, res) {
  needEdit(staff);
  const { groupId } = await readJson(req);
  const result = await wabotCall('POST', '/config', { groupId: groupId ? String(groupId) : null });
  status.groupId = result.groupId || null;
  status.groupSubject = result.groupSubject || null;
  sendJson(res, 200, result);
}

export async function wabotPortalPair(staff, req, res) {
  needEdit(staff);
  const { phone } = await readJson(req);
  sendJson(res, 200, await wabotCall('POST', '/pair', { phone: String(phone || '') }));
}

export async function wabotPortalLogout(staff, req, res) {
  needEdit(staff);
  console.log(`WhatsApp bot unlinked by ${staff.email}`);
  // Отвязали нарочно — оповещение «бот не на связи» не нужно
  db.setSetting('wabot_last_ok', '');
  sendJson(res, 200, await wabotCall('POST', '/logout'));
}
