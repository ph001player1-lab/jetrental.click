/**
 * ============================================================================
 * KOKON — наблюдатель рабочей группы WhatsApp (ТОЛЬКО ЧТЕНИЕ)
 * ============================================================================
 * Подключается к номеру-наблюдателю как «связанное устройство»
 * (как WhatsApp Web) через библиотеку Baileys. Читает сообщения ОДНОЙ
 * выбранной группы и передаёт их боту (журнал на сайте сотрудников).
 *
 * Правила, которые нельзя нарушать:
 *   - никогда ничего не отправляем (в коде нет ни одного sendMessage);
 *   - не ставим «онлайн», не отмечаем прочитанным;
 *   - сообщения других чатов этого номера не читаем и никуда не передаём.
 *
 * Связь с ботом — только внутри Docker-сети, с общим секретом INTERNAL_SECRET:
 *   наблюдатель → бот:  http://bot:3001/internal/wa/{message,media,status}
 *   бот → наблюдатель:  http://observer:3100/{status,config,pair,logout}
 *                       (админ на сайте сотрудников: QR-код, выбор группы)
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, normalizeMessageContent, getContentType, downloadMediaMessage,
  WAMessageStubType
} from 'baileys';
import QRCode from 'qrcode';

const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BOT_URL = (process.env.BOT_INTERNAL_URL || 'http://bot:3001').replace(/\/+$/, '');
const SECRET = process.env.INTERNAL_SECRET || '';
const PORT = Number(process.env.PORT) || 3100;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const HEARTBEAT_MS = 2 * 60 * 1000;

/* ------------------------------------------------------------ Журнал */

const log = (...args) => console.log(new Date().toISOString(), ...args);

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

const state = {
  status: 'starting', // starting | qr | connected | reconnecting | logged_out
  qrSvg: null,
  pairingCode: null,
  me: null,
  groups: [],
  error: null,
  connectedAt: null,
  lastMessageAt: null,
  forwarded: 0,
  // Сообщения группы, которые не удалось расшифровать (WhatsApp обычно досылает
  // их сам через несколько минут — тогда они отсюда пропадают)
  unreadable: [],
  // Сколько сообщений группы получено за день (по Бангкоку)
  today: { date: null, received: 0 }
};

const MAX_UNREADABLE = 50;
const bangkokDay = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);

function countReceived(ms) {
  const day = bangkokDay(ms);
  if (state.today.date !== day) state.today = { date: day, received: 0 };
  state.today.received++;
}

/* ------------------------------------------------------ Связь с ботом */

// Сообщения передаём строго по очереди: сначала текст, потом его фото
let queue = Promise.resolve();

async function botRequest(pathname, body, contentType = 'application/json') {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${BOT_URL}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'X-Internal-Secret': SECRET },
        body: contentType === 'application/json' ? JSON.stringify(body) : body
      });
      if (response.ok) return true;
      // 4xx — повторять бесполезно (например, неверный секрет)
      if (response.status < 500) {
        log(`bot ${pathname}: HTTP ${response.status}`);
        return false;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      // Бот перезапускается при обновлении — ждём до ~3 минут
      if (attempt >= 12) {
        log(`bot ${pathname} failed: ${err.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * attempt)));
    }
  }
}

const enqueue = (task) => {
  queue = queue.then(task).catch((err) => log('queue task failed:', err.message));
  return queue;
};

function reportStatus() {
  enqueue(() => botRequest('/internal/wa/status', {
    connected: state.status === 'connected',
    status: state.status,
    me: state.me,
    groupId: config.groupId,
    groupSubject: config.groupSubject,
    unreadable: state.unreadable,
    today: state.today
  }));
}

/* ------------------------------------------------------- Сообщения */

const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// Внутренний номер WhatsApp (LID) → телефон: из списка участников группы
// (на случай, если Baileys ещё не знает соответствия)
const lidToPhone = new Map();

/** Телефон по LID ('7302065160246@lid' → '66…'); null — если неизвестен */
async function phoneOfLid(lidJid) {
  try {
    const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID(lidJid);
    if (mapped) return digits(mapped);
  } catch { /* нет соответствия */ }
  return lidToPhone.get(digits(lidJid)) || null;
}

/** Упоминания в тексте приходят как «@7302065160246» (LID) — заменяем на телефон */
async function mentionsToPhones(text, mentioned) {
  let out = text;
  for (const jid of mentioned || []) {
    if (!String(jid).endsWith('@lid')) continue;
    const phone = await phoneOfLid(jid);
    if (phone) out = out.split(`@${digits(jid)}`).join(`@${phone}`);
  }
  return out;
}

/** Номер автора: из @s.whatsapp.net; если пришёл только LID — спрашиваем соответствие у Baileys */
async function authorOf(msg) {
  // Своё сообщение (с телефона этого номера) — автор сам номер наблюдателя
  if (msg.key.fromMe && sock?.user?.id) return digits(sock.user.id);
  const candidates = [msg.key.participantAlt, msg.key.participant, msg.participant].filter(Boolean);
  const pn = candidates.find((j) => j.endsWith('@s.whatsapp.net'));
  if (pn) return digits(pn);
  const lid = candidates.find((j) => j.endsWith('@lid'));
  if (lid) return (await phoneOfLid(lid)) || `lid:${digits(lid)}`;
  return digits(candidates[0]) || 'unknown';
}

function textOf(content) {
  if (!content) return '';
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || content.documentWithCaptionMessage?.message?.documentMessage?.caption
    || '';
}

const SKIP_TYPES = new Set([
  'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage',
  'pinInChatMessage', 'messageContextInfo', 'encReactionMessage', 'stickerSyncRmrMessage'
]);

const toMs = (ts) => (typeof ts === 'number' ? ts : Number(ts?.toNumber?.() ?? ts)) * 1000;

async function handleMessage(msg) {
  // Только выбранная рабочая группа. Сообщения «от себя» тоже берём: если
  // наблюдатель подключён к номеру сотрудника, его сообщения — часть журнала
  if (!config.groupId || msg.key.remoteJid !== config.groupId) return;
  const id = msg.key.id;
  // Не расшифровалось: Baileys сам попросит отправителя прислать ещё раз.
  // Запоминаем — если так и не придёт, админ увидит это в журнале и предупреждениях
  if (msg.messageStubType === WAMessageStubType.CIPHERTEXT && !msg.message) {
    if (id && !state.unreadable.some((u) => u.id === id)) {
      const ts = new Date(toMs(msg.messageTimestamp) || Date.now()).toISOString();
      const reason = String(msg.messageStubParameters?.[0] || '').slice(0, 80);
      state.unreadable.push({ id, ts, author: await authorOf(msg), reason });
      if (state.unreadable.length > MAX_UNREADABLE) state.unreadable.shift();
      log(`unreadable message ${id} at ${ts} (${reason}) — waiting for WhatsApp to resend`);
      reportStatus();
    }
    return;
  }
  const waiting = state.unreadable.findIndex((u) => u.id === id);
  if (waiting >= 0 && msg.message) {
    state.unreadable.splice(waiting, 1);
    log(`message ${id} recovered`);
    reportStatus();
  }
  const content = normalizeMessageContent(msg.message);
  if (!content) return;
  const type = getContentType(content);
  if (!type || SKIP_TYPES.has(type)) return;

  // Удаление и правка сообщения
  if (type === 'protocolMessage') {
    const pm = content.protocolMessage;
    if (pm?.type === 0 && pm.key?.id) enqueue(() => botRequest('/internal/wa/message', { op: 'revoke', id: pm.key.id }));
    if (pm?.type === 14 && pm.key?.id) {
      const text = textOf(normalizeMessageContent(pm.editedMessage));
      enqueue(() => botRequest('/internal/wa/message', { op: 'edit', id: pm.key.id, text }));
    }
    return;
  }

  const inner = content[type] || {};
  const media = type === 'imageMessage' || type === 'videoMessage';
  const message = {
    op: 'add',
    id: msg.key.id,
    ts: new Date(toMs(msg.messageTimestamp) || Date.now()).toISOString(),
    author: await authorOf(msg),
    authorName: msg.pushName || (msg.key.fromMe ? sock?.user?.name : null) || null,
    text: await mentionsToPhones(textOf(content), inner.contextInfo?.mentionedJid),
    mediaCount: media ? 1 : 0,
    quotedId: inner.contextInfo?.stanzaId || null,
    // Фото альбома ссылаются на «родителя» — по нему отчёт найдёт все фото
    albumId: content.messageContextInfo?.messageAssociation?.parentMessageKey?.id || null
  };
  state.lastMessageAt = message.ts;
  countReceived(Date.parse(message.ts));
  enqueue(async () => {
    const ok = await botRequest('/internal/wa/message', message);
    if (ok) state.forwarded++;
    if (!ok || !media) return;
    const size = Number(inner.fileLength?.toNumber?.() ?? inner.fileLength ?? 0);
    if (size > MAX_MEDIA_BYTES) return;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: quiet, reuploadRequest: sock.updateMediaMessage });
      const mime = inner.mimetype || (type === 'imageMessage' ? 'image/jpeg' : 'video/mp4');
      await botRequest(`/internal/wa/media?id=${encodeURIComponent(message.id)}&mime=${encodeURIComponent(mime.split(';')[0])}`, buffer, 'application/octet-stream');
    } catch (err) {
      log('media download failed:', err.message);
    }
  });
}

/* ---------------------------------------------------------- Группы */

async function refreshGroups() {
  try {
    const all = await sock.groupFetchAllParticipating();
    const watched = [];
    for (const g of Object.values(all)) {
      for (const p of g.participants || []) {
        const lid = [p.id, p.lid].find((j) => String(j || '').endsWith('@lid'));
        const phone = [p.phoneNumber, p.id].find((j) => String(j || '').endsWith('@s.whatsapp.net'));
        if (lid && phone) {
          lidToPhone.set(digits(lid), digits(phone));
          if (g.id === config.groupId) watched.push([digits(lid), digits(phone)]);
        }
      }
    }
    // Боту — соответствие внутренних номеров и телефонов только участников рабочей группы:
    // так упоминания «@7302065160246» в старых сообщениях и выгрузках станут именами
    if (watched.length) enqueue(() => botRequest('/internal/wa/lids', { pairs: watched }));
    state.groups = Object.values(all).map((g) => ({ id: g.id, subject: g.subject, size: g.participants?.length || 0 }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
    // Название группы могли сменить — обновим, но выбор оставим тем же
    const current = state.groups.find((g) => g.id === config.groupId);
    if (current && current.subject !== config.groupSubject) {
      config.groupSubject = current.subject;
      saveConfig();
    }
  } catch (err) {
    log('groups fetch failed:', err.message);
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
    browser: Browsers.ubuntu('JetRental Journal'),
    markOnlineOnConnect: false,
    // Полную историю не тянем. Начальную синхронизацию оставляем: без неё Baileys
    // не узнаёт соответствие номеров и LID (сессия становится нестабильной).
    // Сами сообщения истории (событие messaging-history.set) мы не читаем —
    // историю админ загружает из «Экспорта чата».
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined
  });
  const current = sock;

  current.ev.on('creds.update', saveCreds);

  current.ev.on('connection.update', async (update) => {
    if (current !== sock) return;
    if (update.qr) {
      state.status = 'qr';
      state.qrSvg = await QRCode.toString(update.qr, { type: 'svg', margin: 1 });
    }
    if (update.connection === 'open') {
      retryMs = 2000;
      Object.assign(state, {
        status: 'connected', qrSvg: null, pairingCode: null, error: null,
        connectedAt: new Date().toISOString(),
        me: { id: digits(current.user?.id), name: current.user?.name || null }
      });
      log(`connected as ${state.me.id}`);
      await refreshGroups();
      reportStatus();
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      state.error = update.lastDisconnect?.error?.message || null;
      if (code === DisconnectReason.loggedOut) {
        // Устройство отвязали на телефоне — начинаем заново с новым QR-кодом
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
      handleMessage(msg).catch((err) => log('message failed:', err.message));
    }
  });

  current.ev.on('groups.upsert', () => refreshGroups());
  current.ev.on('groups.update', () => refreshGroups());
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
    req.on('data', (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, 'http://observer');
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, { ...state, groupId: config.groupId, groupSubject: config.groupSubject });
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const { groupId } = await readJson(req);
      const group = state.groups.find((g) => g.id === groupId);
      if (!group) return send(res, 400, { error: 'unknown_group' });
      config = { groupId: group.id, groupSubject: group.subject };
      saveConfig();
      log(`watching group «${group.subject}»`);
      reportStatus();
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
    log(`${url.pathname} failed:`, err.message);
    return send(res, 500, { error: 'internal_error' });
  }
}).listen(PORT, () => log(`observer listening on ${PORT}`));

if (!SECRET) log('WARNING: INTERNAL_SECRET is not set — the bot will not accept messages');
setInterval(reportStatus, HEARTBEAT_MS).unref();
start().catch((err) => {
  log('start failed:', err.message);
  process.exit(1);
});
process.on('SIGTERM', () => process.exit(0));
