/**
 * ============================================================================
 * WhatsApp-бот для клиентов: связь с контейнером wabot
 * ============================================================================
 * Номер компании подключён в wabot как «связанное устройство». Здесь:
 *   - входящие от клиентов → общий диалог (client.js), ответ — через wabot;
 *   - заявка → карточкой в выбранную рабочую группу WhatsApp; сотрудник
 *     отвечает на неё «+» — заявка его (или «-» — не может);
 *   - менеджер написал клиенту сам → бот молчит в этом чате 12 часов;
 *     после заявки бот молчит сутки (клиент может написать «меню»).
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
import { formatStaffRequest } from './format.js';
import { t } from './i18n.js';
import { g } from './groupTexts.js';
import { staffPhones } from './staffUsers.js';
import { marketingSettings, saveSettings as saveMarketingSettings } from './marketing.js';
import { onRequestTaken, refreshStaffMessage } from './staff.js';

export const wabotConfigured = Boolean(config.internal.secret);
const STALE_MS = 6 * 60 * 1000;
const MANUAL_PAUSE_MS = (config.whatsapp.pauseHours || 12) * 3600000;
const AFTER_REQUEST_PAUSE_MS = 24 * 3600000;
const MODES = ['off', 'test', 'on'];

const status = {
  connected: false, status: null, me: null, groupId: null, groupSubject: null,
  members: new Set(), lastSeenAt: null, lastInboundAt: null, today: null
};

const digits = (v) => String(v || '').replace(/\D/g, '');
const later = (ms) => new Date(Date.now() + ms).toISOString();

/* ---------------------------------------------------------- Настройки */

export function wabotSettings() {
  let saved = {};
  try { saved = JSON.parse(db.getSetting('wabot_settings') || '{}') || {}; } catch { /* по умолчанию */ }
  return {
    mode: MODES.includes(saved.mode) ? saved.mode : 'off',
    testNumbers: Array.isArray(saved.testNumbers) ? saved.testNumbers : []
  };
}

export function saveWabotSettings(input) {
  const cur = wabotSettings();
  const mode = MODES.includes(input.mode) ? input.mode : cur.mode;
  const testNumbers = input.testNumbers === undefined ? cur.testNumbers
    : [...new Set(String(input.testNumbers).split(/[,;\n]+/).map(digits).filter((n) => n.length >= 8 && n.length <= 15))].slice(0, 20);
  db.setSetting('wabot_settings', JSON.stringify({ mode, testNumbers }));
  // «Маркетинг»: отвечает ли бот в WhatsApp — по этому режиму
  saveMarketingSettings({ bots: { wa: mode === 'on' } });
  return { mode, testNumbers };
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
    today: body.today?.date ? { date: String(body.today.date).slice(0, 10), received: Number(body.today.received) || 0, sent: Number(body.today.sent) || 0 } : null
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
export async function wabotSend(to, text, quoted = null) {
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
    // Клиент сам попросил меню — бот снова на связи
    if (!isRestartText(body.text)) return null;
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

async function askManager(c, lang) {
  db.pauseChat(c.key, later(MANUAL_PAUSE_MS));
  if (status.groupId) {
    const who = [c.name, c.phone ? `+${c.phone}` : null].filter(Boolean).join(' · ') || c.jid;
    await wabotSend(status.groupId, g('wa.manager', { who })).catch((err) => console.error('WhatsApp group note failed:', err.message));
  }
  return t(lang, 'manager_soon');
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
    // После заявки бот молчит сутки — дальше с клиентом говорит менеджер
    afterRequest: () => db.pauseChat(c.key, later(AFTER_REQUEST_PAUSE_MS)),
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
    if (!text && body.media) {
      const lang = db.getChatLanguage(c.key);
      if (lang && db.getSession(c.key)) return await ui.send(t(lang, 'media_unsupported'));
    }
    return await handleClientText(chat, text);
  } finally {
    await ui.flush();
  }
}

/* ---------------------------------------------- Рабочая группа WhatsApp */

const TAKE = /^\s*(\+|➕|✋|👍|беру|взял|взяла|возьму|take|taken|mine|รับ)/i;
const DECLINE = /^\s*(-|—|➖|не могу|не смогу|can'?t|cannot)/i;

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
  const id = await wabotSend(status.groupId, `${htmlToWa(formatStaffRequest(request))}\n\n${g('wa.takeHint')}`);
  db.setWaGroupMessage(request.id, status.groupId, id);
  return true;
}

/** Заявку взяли в Telegram или на сайте — пишем об этом и в группу WhatsApp (ответом на карточку) */
export async function noteTakenInWaGroup(request) {
  if (!request.wa_group_id || !request.wa_group_message_id || !wabotStatus().connected) return;
  await wabotSend(request.wa_group_id, g('wa.takenElsewhere', { id: request.id, name: request.taken_by_name }),
    { id: request.wa_group_message_id, fromMe: true, text: g('card.title', { id: request.id }).replace(/<[^>]+>/g, '') });
}

async function handleGroupReply(body) {
  const request = db.requestByWaGroupMessage(String(body.quotedId || ''));
  if (!request) return;
  const text = String(body.text || '');
  const author = digits(body.author);
  let name = body.authorName ? String(body.authorName).slice(0, 80) : author ? `+${author}` : 'WhatsApp';
  try { name = (await staffPhones()).get(author) || name; } catch { /* имя из WhatsApp */ }
  const reply = { id: body.id, participant: body.authorJid || undefined, text };
  const react = (emoji) => wabotCall('POST', '/react', { jid: request.wa_group_id, id: body.id, participant: body.authorJid, emoji })
    .catch((err) => console.error('WhatsApp reaction failed:', err.message));

  if (TAKE.test(text)) {
    if (!db.takeRequest(request.id, `wa:${author}`, name)) {
      const cur = db.getRequest(request.id);
      console.log(`Request #${request.id}: «+» from «${name}» (+${author || '?'}) — already taken by «${cur?.taken_by_name}» (${cur?.taken_by_id})`);
      if (cur?.status === 'taken') await wabotSend(request.wa_group_id, g('wa.alreadyTaken', { id: cur.id, name: cur.taken_by_name }), reply);
      return;
    }
    console.log(`Request #${request.id} taken in the WhatsApp group by «${name}» (number +${author || '?'}, WhatsApp name «${body.authorName || '-'}»)`);
    await react('✅');
    await onRequestTaken(db.getRequest(request.id), 'wa');
    return;
  }
  if (DECLINE.test(text) && request.status === 'new') {
    const updated = db.addDecline(request.id, name);
    await react('👌');
    await refreshStaffMessage(updated).catch((err) => console.error('Telegram card refresh failed:', err.message));
  }
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
  console.log(`WhatsApp bot mode «${result.mode}» set by ${staff.email}`);
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
