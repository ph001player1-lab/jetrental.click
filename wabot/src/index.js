/**
 * ============================================================================
 * KOKON — WhatsApp-бот для клиентов (номер компании, например +66 98 227 6467)
 * ============================================================================
 * Подключается к номеру как «связанное устройство» (как WhatsApp Web) через
 * Baileys. Телефон с этим номером остаётся главным: менеджеры отвечают с него
 * или из WhatsApp Web, как обычно.
 *
 * Правила, чтобы номер не заблокировали и бот никому не мешал:
 *   - пишет ТОЛЬКО по команде бота-сервера (POST /send): ответ клиенту, который
 *     написал сам, и карточку заявки в выбранную рабочую группу. Рассылок нет;
 *   - перед ответом «печатает» 1–4 секунды, не чаще 25 сообщений в минуту;
 *   - не ставит «онлайн» (иначе телефон перестанет получать уведомления);
 *   - из групп читает только выбранную рабочую и передаёт боту-серверу только
 *     ответы на сообщения и короткие «+», «+14», «беру», «-» (так берут заявку);
 *   - сообщение, которое менеджер написал клиенту сам, передаёт боту-серверу —
 *     тогда бот в этом чате замолкает.
 *
 * Связь с ботом — только внутри Docker-сети, с общим секретом INTERNAL_SECRET:
 *   wabot → бот:  http://bot:3001/internal/wabot/{message,status}
 *   бот → wabot:  http://wabot:3200/{status,send,react,config,pair,logout}
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, normalizeMessageContent, getContentType, generateMessageIDV2,
  WAMessageStubType
} from 'baileys';
import QRCode from 'qrcode';

const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BOT_URL = (process.env.BOT_INTERNAL_URL || 'http://bot:3001').replace(/\/+$/, '');
const SECRET = process.env.INTERNAL_SECRET || '';
const PORT = Number(process.env.PORT) || 3200;
const HEARTBEAT_MS = 2 * 60 * 1000;
// Сообщения старше этого (бот был выключен) не трогаем — их видят менеджеры на телефоне
const MAX_AGE_MS = 3 * 3600 * 1000;
// «+» в группе, который пришёл, пока бот перезапускался, ещё имеет смысл в течение 30 минут
const GROUP_MAX_AGE_MS = 30 * 60 * 1000;
const RATE_PER_MINUTE = 25;

/* ------------------------------------------------------------ Журнал */

const log = (...args) => console.log(new Date().toISOString(), ...args);

/* ------------------------------------------- Журнал в памяти (диагностика) */

// Последние строки журнала — бот-сервер отдаёт их разработчику (bot.jetmobility.org/diag)
const logLines = [];
for (const [method, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
    // log() уже ставит время первым — уровень пишем после него
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) ?/.exec(text);
    logLines.push(`${m ? m[1] : new Date().toISOString()} ${level} ${m ? text.slice(m[0].length) : text}`);
    if (logLines.length > 3000) logLines.shift();
  };
}
const recentLog = (minutes) => {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  return logLines.filter((l) => l.slice(0, 24) >= since).join('\n');
};

// Baileys ждёт логгер в стиле pino; пишем только предупреждения и ошибки
const quiet = {
  level: 'warn',
  child() { return quiet; },
  trace() {}, debug() {}, info() {},
  warn(obj, msg) { console.warn('[wa]', msg || '', typeof obj === 'string' ? obj : obj?.err?.message || ''); },
  error(obj, msg) { console.error('[wa]', msg || '', typeof obj === 'string' ? obj : obj?.err?.message || ''); },
  fatal(obj, msg) { console.error('[wa:fatal]', msg || '', obj?.err?.message || ''); }
};

/* ---------------------------------------------------------- Настройки */

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { groupId: null, groupSubject: null };
  }
}

function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();

const bangkokDay = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);

const state = {
  status: 'starting', // starting | qr | connected | reconnecting | logged_out
  qrSvg: null,
  pairingCode: null,
  me: null,
  groups: [],
  // Телефоны участников рабочей группы: им бот как клиентам не отвечает
  members: [],
  error: null,
  connectedAt: null,
  lastInboundAt: null,
  today: { date: null, received: 0, sent: 0 },
  // Сообщения, которые WhatsApp не дал расшифровать (обычно досылает сам через минуту)
  undecrypted: []
};

function countToday(field) {
  const day = bangkokDay(Date.now());
  if (state.today.date !== day) state.today = { date: day, received: 0, sent: 0 };
  state.today[field]++;
}

/* ------------------------------------------------------ Связь с ботом */

let queue = Promise.resolve();

/** Запрос к боту-серверу; ответ — JSON или null */
async function botRequest(pathname, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${BOT_URL}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      if (response.ok) return await response.json().catch(() => ({}));
      if (response.status < 500) {
        log(`bot ${pathname}: HTTP ${response.status}`);
        return null;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      // Бот перезапускается при обновлении — ждём до ~3 минут
      if (attempt >= 12) {
        log(`bot ${pathname} failed: ${err.message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * attempt)));
    }
  }
}

// Входящие передаём строго по очереди — так бот получает сообщения клиента в том же порядке
const enqueue = (task) => {
  queue = queue.then(task).catch((err) => log('queue task failed:', err.message));
  return queue;
};

function reportStatus() {
  enqueue(() => botRequest('/internal/wabot/status', {
    connected: state.status === 'connected',
    status: state.status,
    me: state.me,
    groupId: config.groupId,
    groupSubject: config.groupSubject,
    members: state.members,
    lastInboundAt: state.lastInboundAt,
    today: state.today,
    undecrypted: state.undecrypted
  }));
}

/* ------------------------------------------------------- Номера */

const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const lidToPhone = new Map();

async function phoneOfLid(lidJid) {
  try {
    const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID(lidJid);
    if (mapped) return digits(mapped);
  } catch { /* нет соответствия */ }
  return lidToPhone.get(digits(lidJid)) || null;
}

/** Телефон собеседника в личном чате (или автора в группе); null — WhatsApp его не сообщил */
async function phoneOf(...jids) {
  const list = jids.filter(Boolean).map(String);
  const pn = list.find((j) => j.endsWith('@s.whatsapp.net'));
  if (pn) return digits(pn);
  const lid = list.find((j) => j.endsWith('@lid'));
  return lid ? phoneOfLid(lid) : null;
}

/* ------------------------------------------------------- Сообщения */

function textOf(content) {
  if (!content) return '';
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || content.documentWithCaptionMessage?.message?.documentMessage?.caption
    || content.buttonsResponseMessage?.selectedDisplayText
    || content.listResponseMessage?.title
    || '';
}

const SKIP_TYPES = new Set([
  'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'protocolMessage',
  'pinInChatMessage', 'messageContextInfo', 'encReactionMessage', 'stickerSyncRmrMessage', 'callLogMesssage'
]);
const MEDIA_NAMES = {
  imageMessage: 'photo', videoMessage: 'video', audioMessage: 'voice', documentMessage: 'document', stickerMessage: 'sticker',
  locationMessage: 'location', liveLocationMessage: 'location', contactMessage: 'contact', contactsArrayMessage: 'contact'
};

const toMs = (ts) => (typeof ts === 'number' ? ts : Number(ts?.toNumber?.() ?? ts)) * 1000;
const isPersonal = (jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

// ID сообщений, которые отправил сам бот, — чтобы не принять их за ответ менеджера
const sentIds = new Set();
function rememberSent(id) {
  sentIds.add(id);
  if (sentIds.size > 2000) sentIds.delete(sentIds.values().next().value);
}
// WhatsApp иногда доставляет одно сообщение дважды — второй раз не передаём
const seenIds = new Set();
function firstTime(id) {
  if (!id || seenIds.has(id)) return false;
  seenIds.add(id);
  if (seenIds.size > 2000) seenIds.delete(seenIds.values().next().value);
  return true;
}

// Похоже на «взять / не могу»: «+», «+14», «беру», «-», «не могу 14»… — такие сообщения
// группы передаём боту-серверу и без ответа на карточку
const TAKE_LIKE = /^\s*(\+|➕|✋|👍|-|—|➖|беру|взял|взяла|возьму|take|taken|mine|รับ|не могу|не смогу|can'?t|cannot)/i;
const where = (jid) => (jid === config.groupId ? 'work group' : jid.endsWith('@g.us') ? 'other group' : 'client chat');

async function handleMessage(msg, type) {
  const jid = msg.key.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
  // Не расшифровалось: Baileys сам попросит отправителя прислать ещё раз — тогда обработаем
  if (msg.messageStubType === WAMessageStubType.CIPHERTEXT && !msg.message) {
    if (jid !== config.groupId && !isPersonal(jid)) return;
    if (!state.undecrypted.some((u) => u.id === msg.key.id)) {
      state.undecrypted.push({ id: msg.key.id, ts: new Date().toISOString(), where: where(jid) });
      if (state.undecrypted.length > 30) state.undecrypted.shift();
      log(`${where(jid)}: message ${msg.key.id} could not be decrypted (${msg.messageStubParameters?.[0] || 'no reason'}) — waiting for WhatsApp to resend`);
      reportStatus();
    }
    return;
  }
  const waiting = state.undecrypted.findIndex((u) => u.id === msg.key.id);
  if (waiting >= 0 && msg.message) {
    state.undecrypted.splice(waiting, 1);
    log(`${where(jid)}: message ${msg.key.id} decrypted after resend`);
    reportStatus();
  }
  const content = normalizeMessageContent(msg.message);
  if (!content) return;
  const kind = getContentType(content);
  if (!kind || SKIP_TYPES.has(kind)) return;
  const ts = toMs(msg.messageTimestamp) || Date.now();
  const inner = content[kind] || {};

  // Рабочая группа: ответы на сообщения и короткие «+», «+14», «беру», «-»
  if (jid.endsWith('@g.us')) {
    if (jid !== config.groupId) return;
    if (msg.key.fromMe) {
      if (!sentIds.has(msg.key.id)) log(`work group: own message ${msg.key.id} (from the company phone) — ignored`);
      return;
    }
    // «append» — сообщение пришло, пока бот был не на связи (перезапуск): свежие тоже берём
    if (type !== 'notify' && Date.now() - ts > GROUP_MAX_AGE_MS) {
      log(`work group: old message ${msg.key.id} delivered after reconnect — ignored`);
      return;
    }
    if (!firstTime(msg.key.id)) return;
    const quotedId = inner.contextInfo?.stanzaId || null;
    const text = textOf(content);
    const author = await phoneOf(msg.key.participantAlt, msg.key.participant, msg.participant);
    const takeLike = TAKE_LIKE.test(text) && text.length <= 40;
    log(`work group: message from +${author || '?'} (${msg.pushName || '-'}), ${quotedId ? 'reply' : 'not a reply'}, ${kind}${takeLike ? `, «${text.trim().slice(0, 20)}»` : ''}${quotedId || takeLike ? ' → bot' : ''}`);
    if (!quotedId && !takeLike) return;
    enqueue(() => botRequest('/internal/wabot/message', {
      kind: 'group', id: msg.key.id, ts: new Date(ts).toISOString(), author, authorJid: msg.key.participant || null,
      authorName: msg.pushName || null, text: textOf(content).slice(0, 500), quotedId
    }));
    return;
  }
  if (!isPersonal(jid)) return;

  // Менеджер написал клиенту сам (с телефона или из WhatsApp Web) — бот в этом чате замолкает
  if (msg.key.fromMe) {
    if (sentIds.has(msg.key.id)) return;
    const phone = await phoneOf(jid, msg.key.remoteJidAlt);
    enqueue(() => botRequest('/internal/wabot/message', { kind: 'manual', jid, phone }));
    return;
  }
  // «append» без fromMe — сообщение клиента, пришедшее, пока бот был не на связи
  if (Date.now() - ts > MAX_AGE_MS) return;
  if (!firstTime(msg.key.id)) {
    log(`duplicate delivery of ${msg.key.id} skipped`);
    return;
  }

  const phone = await phoneOf(jid, msg.key.remoteJidAlt);
  state.lastInboundAt = new Date().toISOString();
  countToday('received');
  const message = {
    kind: 'client', id: msg.key.id, ts: new Date(ts).toISOString(), jid, phone,
    name: msg.pushName || null, text: textOf(content).slice(0, 4000), media: MEDIA_NAMES[kind] || null
  };
  enqueue(async () => {
    const answer = await botRequest('/internal/wabot/message', message);
    // Синие галочки — только если бот сам отвечает этому клиенту; иначе непрочитанное
    // остаётся непрочитанным на телефоне менеджера
    if (answer?.read) {
      try { await sock.readMessages([msg.key]); } catch { /* не страшно */ }
    }
  });
}

/* -------------------------------------------------------- Отправка */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sentTimes = [];

/** Не больше RATE_PER_MINUTE сообщений в минуту на весь номер */
async function rateLimit() {
  for (;;) {
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 60000) sentTimes.shift();
    if (sentTimes.length < RATE_PER_MINUTE) { sentTimes.push(now); return; }
    await sleep(60000 - (now - sentTimes[0]) + 50);
  }
}

const toJid = (to) => (String(to).includes('@') ? String(to) : `${digits(to)}@s.whatsapp.net`);

async function sendText(to, text, quoted = null) {
  if (state.status !== 'connected' || !sock) throw Object.assign(new Error('not connected'), { code: 'not_connected' });
  const jid = toJid(to);
  const body = String(text || '').slice(0, 4000);
  if (!body.trim()) throw Object.assign(new Error('empty'), { code: 'empty' });
  await rateLimit();
  const personal = isPersonal(jid);
  // «Печатает…» как человек: дольше для длинных ответов, но не больше 4 секунд
  if (personal) {
    try { await sock.sendPresenceUpdate('composing', jid); } catch { /* не важно */ }
    await sleep(Math.min(4000, 900 + body.length * 18));
  }
  const messageId = generateMessageIDV2(sock.user?.id);
  rememberSent(messageId);
  const options = { messageId };
  if (quoted?.id) {
    options.quoted = { key: { remoteJid: jid, id: String(quoted.id), fromMe: Boolean(quoted.fromMe), participant: quoted.participant || undefined }, message: { conversation: String(quoted.text || '') } };
  }
  await sock.sendMessage(jid, { text: body }, options);
  if (personal) {
    try { await sock.sendPresenceUpdate('paused', jid); } catch { /* не важно */ }
  }
  // Не держим номер «в сети», иначе телефон перестанет получать уведомления
  try { await sock.sendPresenceUpdate('unavailable'); } catch { /* не важно */ }
  countToday('sent');
  return messageId;
}

/** Реакция на сообщение в группе (✅ — «заявку взял(а)») */
async function react(jid, id, participant, emoji) {
  if (state.status !== 'connected' || !sock) throw Object.assign(new Error('not connected'), { code: 'not_connected' });
  await sock.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id, fromMe: false, participant: participant || undefined } } });
}

/* ---------------------------------------------------------- Группы */

// Список групп WhatsApp отдаёт не чаще раза в несколько секунд («rate-overlimit»):
// события групп собираем в один запрос, при отказе — повтор через минуту
// Данные групп (участники) — кэш: без него Baileys спрашивает их у WhatsApp при каждой
// отправке в группу, и WhatsApp отвечает «rate-overlimit»
const groupCache = new Map();
let groupsTimer = null;
let groupsRetryMs = 60000;
function scheduleGroups(delayMs = 5000) {
  clearTimeout(groupsTimer);
  groupsTimer = setTimeout(async () => {
    if (state.status !== 'connected') return;
    if (await refreshGroups()) reportStatus();
  }, delayMs);
}

async function refreshGroups() {
  try {
    const all = await sock.groupFetchAllParticipating();
    const members = [];
    for (const g of Object.values(all)) {
      groupCache.set(g.id, g);
      for (const p of g.participants || []) {
        const lid = [p.id, p.lid].find((j) => String(j || '').endsWith('@lid'));
        const phone = [p.phoneNumber, p.id].find((j) => String(j || '').endsWith('@s.whatsapp.net'));
        if (lid && phone) lidToPhone.set(digits(lid), digits(phone));
        if (g.id === config.groupId && phone) members.push(digits(phone));
      }
    }
    state.members = [...new Set(members)];
    state.groups = Object.values(all).map((g) => ({ id: g.id, subject: g.subject, size: g.participants?.length || 0 }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
    const current = state.groups.find((g) => g.id === config.groupId);
    if (current && current.subject !== config.groupSubject) {
      config.groupSubject = current.subject;
      saveConfig();
    }
    groupsRetryMs = 60000;
    return true;
  } catch (err) {
    log(`groups fetch failed: ${err.message} — retry in ${Math.round(groupsRetryMs / 1000)} s`);
    scheduleGroups(groupsRetryMs);
    groupsRetryMs = Math.min(groupsRetryMs * 2, 30 * 60000);
    return false;
  }
}

/* ---------------------------------------------------- Подключение */

let sock = null;
let retryMs = 2000;

async function start() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({
    auth,
    logger: quiet,
    browser: Browsers.ubuntu('Jet Mobility Bot'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    getMessage: async () => undefined
  });
  const current = sock;

  current.ev.on('creds.update', saveCreds);

  current.ev.on('connection.update', async (update) => {
    if (current !== sock) return;
    if (update.qr) {
      state.status = 'qr';
      state.qrSvg = await QRCode.toString(update.qr, { type: 'svg', margin: 1 });
      reportStatus();
    }
    if (update.connection === 'open') {
      retryMs = 2000;
      Object.assign(state, {
        status: 'connected', qrSvg: null, pairingCode: null, error: null,
        connectedAt: new Date().toISOString(),
        me: { id: digits(current.user?.id), name: current.user?.name || null }
      });
      log(`connected as ${state.me.id}`);
      try { await current.sendPresenceUpdate('unavailable'); } catch { /* не важно */ }
      reportStatus();
      // Сразу после входа WhatsApp сам синхронизирует группы — свой запрос чуть позже
      scheduleGroups(15000);
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      state.error = update.lastDisconnect?.error?.message || null;
      if (code === DisconnectReason.loggedOut) {
        log('logged out — waiting for a new link');
        state.status = 'logged_out';
        state.me = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        reportStatus();
        setTimeout(start, 3000);
        return;
      }
      state.status = 'reconnecting';
      reportStatus();
      log(`connection closed (${code || 'no code'}), retry in ${Math.round(retryMs / 1000)} s`);
      setTimeout(start, retryMs);
      retryMs = Math.min(retryMs * 2, 5 * 60 * 1000);
    }
  });

  current.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      // Диагностика: что пришло из рабочей группы (без текста)
      if (msg.key?.remoteJid && msg.key.remoteJid === config.groupId && !sentIds.has(msg.key.id)) {
        log(`work group upsert ${type}: ${msg.key.id} fromMe=${Boolean(msg.key.fromMe)} stub=${msg.messageStubType || 0} content=${Object.keys(msg.message || {}).join(',') || '-'}`);
      }
      handleMessage(msg, type).catch((err) => log('message failed:', err.message));
    }
  });

  current.ev.on('groups.upsert', (list) => { for (const g of list || []) if (g?.id) groupCache.set(g.id, g); scheduleGroups(); });
  current.ev.on('groups.update', (list) => {
    for (const u of list || []) if (u?.id && groupCache.has(u.id)) groupCache.set(u.id, { ...groupCache.get(u.id), ...u });
    scheduleGroups();
  });
  // Состав группы поменялся — данные из кэша устарели
  current.ev.on('group-participants.update', ({ id }) => { if (id) groupCache.delete(id); scheduleGroups(); });
}

/* ----------------------------------------------- HTTP для бота (внутри) */

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-internal-secret'] || ''));
  const expected = Buffer.from(SECRET);
  return SECRET && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, 'http://wabot');
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, { ...state, groupId: config.groupId, groupSubject: config.groupSubject });
    }
    if (req.method === 'GET' && url.pathname === '/logs') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(recentLog(Math.min(10080, Number(url.searchParams.get('minutes')) || 60)));
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      const { to, text, quoted } = await readJson(req);
      if (!to) return send(res, 400, { error: 'no_recipient' });
      return send(res, 200, { id: await sendText(to, text, quoted) });
    }
    if (req.method === 'POST' && url.pathname === '/react') {
      const { jid, id, participant, emoji } = await readJson(req);
      if (!jid || !id) return send(res, 400, { error: 'bad_reaction' });
      await react(String(jid), String(id), participant, String(emoji || '✅'));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const { groupId } = await readJson(req);
      if (!groupId) {
        config = { groupId: null, groupSubject: null };
      } else {
        const group = state.groups.find((g) => g.id === groupId);
        if (!group) return send(res, 400, { error: 'unknown_group' });
        config = { groupId: group.id, groupSubject: group.subject };
      }
      saveConfig();
      log(config.groupId ? `requests go to «${config.groupSubject}»` : 'no work group');
      reportStatus();
      scheduleGroups(2000);
      return send(res, 200, { ok: true, groupId: config.groupId, groupSubject: config.groupSubject });
    }
    if (req.method === 'POST' && url.pathname === '/pair') {
      // Вход по коду вместо QR: «Связанные устройства → Связать по номеру телефона»
      const { phone } = await readJson(req);
      const number = String(phone || '').replace(/\D/g, '');
      if (state.status !== 'qr' || number.length < 8) return send(res, 400, { error: 'not_waiting_for_link' });
      state.pairingCode = await sock.requestPairingCode(number);
      return send(res, 200, { code: state.pairingCode });
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      log('logout requested by admin');
      try { await sock.logout(); } catch { /* уже отключён */ }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err.code === 'not_connected' || err.code === 'empty') return send(res, 409, { error: err.code });
    log(`${url.pathname} failed:`, err.message);
    return send(res, 500, { error: 'internal_error' });
  }
}).listen(PORT, () => log(`wabot listening on ${PORT}`));

if (!SECRET) log('WARNING: INTERNAL_SECRET is not set — the bot will not accept messages');
setInterval(reportStatus, HEARTBEAT_MS).unref();
// Раз в полчаса — свежий список групп и участников
setInterval(() => scheduleGroups(0), 30 * 60000).unref();
start().catch((err) => {
  log('start failed:', err.message);
  process.exit(1);
});
process.on('SIGTERM', () => process.exit(0));
