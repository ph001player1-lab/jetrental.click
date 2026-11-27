/**
 * ============================================================================
 * Скидки (утвердил владелец)
 * ============================================================================
 * Скидку дают в договоре («Документы»): 5 / 10 / 15 / 20 %, свой %, «минус
 * сумма» или своя цена за всё. Причина обязательна (список — в «Настройках»;
 * «Другое» — только с комментарием). Кто дал и когда — записывается само.
 *
 * Больше порога (по умолчанию 10 %) — нужно «Одобрить» владельца или админа:
 * запрос уходит в группу для скидок — Telegram (кнопки «Одобрить / Отклонить»),
 * WhatsApp (ответ «+» или «-» на сообщение) или в обе, как выбрано в
 * «Настройках»; одобрить можно и в портале («Финансы» → «Скидки»). Пока скидку
 * не одобрили, договор не подписать, не отправить и технику по нему не выдать.
 * Скидки больше X % (тоже в «Настройках») — сообщение в ту же группу.
 * Отклонили — в договоре снова цена по прайсу.
 *
 *   GET  /api/staff/discounts?from=&to=   — сделки со скидками, итоги, ждут одобрения
 *   POST /api/staff/discounts/decide       { id, approve } — владелец или админ
 *   POST /api/staff/settings/discounts     — настройки (админ); группа Telegram —
 *     по ссылке t.me/<бот>?startgroup=disc_<код> (выбрать группу в Telegram),
 *     группа WhatsApp — по ссылке-приглашению chat.whatsapp.com/…
 * ============================================================================
 */

import crypto from 'node:crypto';
import * as db from './db.js';
import { HttpError, sendJson, readJson } from './http.js';
import { can, roleOf } from './roles.js';
import { activeStaff, ADMIN_ROLE } from './access.js';
import { telegramEnabled, telegramBotUsername, sendMessage, inlineKeyboard, answerCallback, tg } from './telegram/api.js';
import { getStaffChatId } from './staff.js';
import { wabotSend, syncWatch, wabotJoinGroup } from './wabot.js';
import { escapeHtml } from './format.js';

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS discounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id      INTEGER NOT NULL,
    number      TEXT,
    plate       TEXT,
    model       TEXT,
    client      TEXT,
    base_total  INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    value       REAL NOT NULL,
    final_total INTEGER NOT NULL,
    percent     REAL NOT NULL,
    reason      TEXT NOT NULL,
    comment     TEXT,
    status      TEXT NOT NULL,
    by_email    TEXT,
    by_name     TEXT,
    at          TEXT NOT NULL,
    decided_by  TEXT,
    decided_at  TEXT,
    decided_via TEXT,
    tg_chat     TEXT,
    tg_msg      INTEGER,
    wa_group    TEXT,
    wa_msg      TEXT,
    active      INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS discounts_doc ON discounts (doc_id, active);
  CREATE INDEX IF NOT EXISTS discounts_wa ON discounts (wa_msg);
`);

const q = {
  // Отклонённая скидка остаётся в отчёте («кто просил»), но к договору уже не относится
  active: db.raw.prepare("SELECT * FROM discounts WHERE doc_id = ? AND active = 1 AND status != 'rejected' ORDER BY id DESC LIMIT 1"),
  byId: db.raw.prepare('SELECT * FROM discounts WHERE id = ?'),
  byWa: db.raw.prepare('SELECT * FROM discounts WHERE wa_msg = ? AND active = 1'),
  insert: db.raw.prepare(`INSERT INTO discounts (doc_id, number, plate, model, client, base_total, kind, value, final_total, percent, reason, comment, status, by_email, by_name, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  deactivate: db.raw.prepare("UPDATE discounts SET active = 0 WHERE doc_id = ? AND active = 1 AND status != 'rejected'"),
  dropDoc: db.raw.prepare('UPDATE discounts SET active = 0 WHERE doc_id = ?'),
  decide: db.raw.prepare('UPDATE discounts SET status = ?, decided_by = ?, decided_at = ?, decided_via = ? WHERE id = ? AND status = ?'),
  setTg: db.raw.prepare('UPDATE discounts SET tg_chat = ?, tg_msg = ? WHERE id = ?'),
  setWa: db.raw.prepare('UPDATE discounts SET wa_group = ?, wa_msg = ? WHERE id = ?'),
  between: db.raw.prepare('SELECT * FROM discounts WHERE active = 1 AND at >= ? AND at < ? ORDER BY id DESC'),
  pending: db.raw.prepare("SELECT * FROM discounts WHERE active = 1 AND status = 'pending' ORDER BY id")
};

export class DiscountError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/* -------------------------------------------------------------- Настройки */

export const DEFAULT_REASONS = [
  'Постоянный клиент', 'Долгая аренда', 'Техника простаивает / низкий сезон', 'Через агента или партнёра',
  'Компенсация (замена, неудобство)', 'Реклама / блогер', 'Свои (сотрудники, знакомые)'
];
export const OTHER = 'Другое';
const CHANNELS = ['tg', 'wa', 'both'];

const num = (key, fallback) => {
  const v = Number(db.getSetting(key));
  return db.getSetting(key) !== null && Number.isFinite(v) ? v : fallback;
};

export function discountSettings() {
  let reasons = DEFAULT_REASONS;
  try { reasons = JSON.parse(db.getSetting('disc_reasons') || 'null') || DEFAULT_REASONS; } catch { /* по умолчанию */ }
  return {
    approvePct: num('disc_approve_pct', 10),
    notifyPct: num('disc_notify_pct', 10),
    channels: CHANNELS.includes(db.getSetting('disc_channels')) ? db.getSetting('disc_channels') : 'tg',
    tgChat: db.getSetting('disc_tg_chat') || null,
    tgTitle: db.getSetting('disc_tg_title') || null,
    waGroup: db.getSetting('disc_wa_group') || null,
    reasons: reasons.filter((r) => r && r !== OTHER)
  };
}

export function saveDiscountSettings(body) {
  const pct = (v) => {
    const n = Number(String(v ?? '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new DiscountError('bad_percent');
    return n;
  };
  if (body.approvePct !== undefined) db.setSetting('disc_approve_pct', String(pct(body.approvePct)));
  if (body.notifyPct !== undefined) db.setSetting('disc_notify_pct', String(pct(body.notifyPct)));
  if (body.channels !== undefined) {
    if (!CHANNELS.includes(body.channels)) throw new DiscountError('bad_channels');
    db.setSetting('disc_channels', body.channels);
  }
  if (body.waGroup !== undefined) db.setSetting('disc_wa_group', body.waGroup ? String(body.waGroup).slice(0, 80) : '');
  // Рабочая группа Telegram — тоже для скидок
  if (body.tgUseStaff) {
    const chat = getStaffChatId();
    if (!chat) throw new DiscountError('no_tg_group');
    db.setSetting('disc_tg_chat', String(chat));
    db.setSetting('disc_tg_title', '');
  }
  // Ссылка «выбрать группу в Telegram»: одноразовый код на 30 минут
  if (body.tgLink) {
    if (!telegramEnabled || !telegramBotUsername()) throw new DiscountError('telegram_off');
    db.setSetting('disc_tg_token', `${crypto.randomBytes(9).toString('base64url')}|${Date.now() + LINK_MS}`);
  }
  if (body.tgUnbind) { db.setSetting('disc_tg_chat', ''); db.setSetting('disc_tg_title', ''); }
  if (body.reasons !== undefined) {
    const list = String(body.reasons).split('\n').map((r) => r.replace(/\s+/g, ' ').trim().slice(0, 60)).filter((r) => r && r !== OTHER);
    if (!list.length) throw new DiscountError('no_reasons');
    db.setSetting('disc_reasons', JSON.stringify([...new Set(list)].slice(0, 20)));
  }
  syncWatch();
  return discountSettings();
}

const LINK_MS = 30 * 60000;
const linkToken = () => {
  const [token, until] = String(db.getSetting('disc_tg_token') || '').split('|');
  return token && Number(until) > Date.now() ? { token, until: Number(until) } : null;
};

/** Названия групп Telegram — у Telegram, раз в 10 минут (группу могли переименовать) */
const titles = new Map();
async function chatTitle(chatId) {
  if (!telegramEnabled || !chatId) return null;
  const hit = titles.get(String(chatId));
  if (hit && Date.now() - hit.at < 600000) return hit.title;
  let title = null;
  try { title = (await tg('getChat', { chat_id: chatId }))?.title || null; } catch { /* бот не в группе */ }
  titles.set(String(chatId), { title, at: Date.now() });
  return title;
}

/** Настройки для портала: с настоящими названиями групп и ссылкой привязки */
export async function discountSettingsView() {
  const s = discountSettings();
  const staffChat = getStaffChatId();
  const [tgTitle, staffTitle] = await Promise.all([chatTitle(s.tgChat), chatTitle(staffChat)]);
  if (tgTitle && tgTitle !== s.tgTitle) db.setSetting('disc_tg_title', tgTitle);
  const link = linkToken();
  const bot = telegramBotUsername();
  return {
    ...s, tgTitle: tgTitle || s.tgTitle, tgFound: Boolean(tgTitle),
    tgIsStaff: Boolean(s.tgChat && staffChat && String(s.tgChat) === String(staffChat)),
    staffTgGroup: Boolean(staffChat), staffTgTitle: staffTitle,
    telegram: telegramEnabled && Boolean(bot),
    tgLink: link && bot ? { url: `https://t.me/${bot}?startgroup=disc_${link.token}`, until: new Date(link.until).toISOString() } : null
  };
}

/** /start disc_<код> в группе (пришло по ссылке из портала) — эта группа для скидок */
export async function bindDiscountGroupByLink(msg, token) {
  const link = linkToken();
  if (!link || !token || token !== link.token) {
    return sendMessage(msg.chat.id, 'Ссылка для привязки устарела. Создайте новую в портале: «Настройки» → «💸 Скидки».');
  }
  db.setSetting('disc_tg_token', '');
  db.setSetting('disc_tg_chat', String(msg.chat.id));
  db.setSetting('disc_tg_title', String(msg.chat.title || '').slice(0, 80));
  titles.delete(String(msg.chat.id));
  console.log(`Discount group bound by link: ${msg.chat.title || msg.chat.id}`);
  return sendMessage(msg.chat.id, '✅ Сюда будут приходить запросы на скидки и сообщения о больших скидках. Одобрять могут владелец и админы (их Telegram ID — в «Доступах» портала).');
}

/** /discounts в группе Telegram — эта группа для запросов на скидки (только админ группы) */
export async function bindDiscountGroup(msg) {
  const member = await tg('getChatMember', { chat_id: msg.chat.id, user_id: msg.from.id });
  if (!['creator', 'administrator'].includes(member.status)) return sendMessage(msg.chat.id, 'Привязать группу для скидок может только админ этой группы.');
  db.setSetting('disc_tg_chat', String(msg.chat.id));
  db.setSetting('disc_tg_title', String(msg.chat.title || 'группа').slice(0, 80));
  return sendMessage(msg.chat.id, '✅ Сюда будут приходить запросы на скидки и сообщения о больших скидках. Одобрять могут владелец и админы (их Telegram ID — в «Доступах» портала).');
}

/* ------------------------------------------------------------- Расчёт */

export const KINDS = ['percent', 'amount', 'price'];

/** База (цена по прайсу) и скидка → { final, off, percent } */
export function computeDiscount(base, kind, value) {
  const b = Math.round(Number(base) || 0);
  const v = Number(value);
  if (!(b > 0)) throw new DiscountError('no_base_price');
  if (!KINDS.includes(kind) || !Number.isFinite(v) || v <= 0) throw new DiscountError('bad_discount');
  let final;
  if (kind === 'percent') {
    if (v >= 100) throw new DiscountError('bad_discount');
    final = Math.round(b * (1 - v / 100));
  } else if (kind === 'amount') final = Math.round(b - v);
  else final = Math.round(v);
  if (final < 0 || final >= b) throw new DiscountError('not_a_discount');
  return { final, off: b - final, percent: Math.round(((b - final) / b) * 1000) / 10 };
}

export const canApprove = (staff) => roleOf(staff) === 'owner' || can(staff, 'access.admin');

const view = (r) => (r ? {
  id: r.id, docId: r.doc_id, number: r.number, plate: r.plate, model: r.model, client: r.client,
  base: r.base_total, kind: r.kind, value: r.value, final: r.final_total, off: r.base_total - r.final_total, percent: r.percent,
  reason: r.reason, comment: r.comment, status: r.status, by: r.by_name || r.by_email, at: r.at,
  decidedBy: r.decided_by, decidedAt: r.decided_at, decidedVia: r.decided_via
} : null);

export const activeDiscount = (docId) => view(q.active.get(Number(docId) || 0));

/** Договор удалили — его скидки уходят из отчёта */
export const dropDocDiscounts = (docId) => { q.dropDoc.run(Number(docId) || 0); };

/**
 * Скидка договора после сохранения: input — { base, kind, value, reason, comment } или null.
 * Та же скидка — статус не меняем; новая — заново (сверх порога — на одобрение).
 * Возвращает скидку (view) или null.
 */
export function syncContractDiscount(doc, contract, input, staff) {
  const current = q.active.get(doc.id);
  if (!input) {
    if (current) q.deactivate.run(doc.id);
    return null;
  }
  const reason = String(input.reason || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const comment = String(input.comment || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  if (!reason) throw new DiscountError('reason_required');
  if (reason === OTHER && !comment) throw new DiscountError('comment_required');
  const { final, percent } = computeDiscount(input.base, input.kind, input.value);
  if (current && current.base_total === Math.round(input.base) && current.kind === input.kind && Number(current.value) === Number(input.value)
    && current.reason === reason && (current.comment || null) === comment && current.status !== 'rejected') return view(current);
  q.deactivate.run(doc.id);
  const s = discountSettings();
  const status = percent > s.approvePct && !canApprove(staff) ? 'pending' : 'approved';
  const at = new Date().toISOString();
  const id = Number(q.insert.run(doc.id, doc.number, contract.plate || '', contract.model || '', contract.renter?.name || '', Math.round(input.base), input.kind, Number(input.value),
    final, percent, reason, comment, status, staff?.email || null, staff?.name || staff?.email || null, at).lastInsertRowid);
  const row = q.byId.get(id);
  console.log(`Discount ${percent}% on ${doc.number} by ${staff?.email} — ${status}`);
  if (status === 'pending') announce(row, true).catch((err) => console.error('Discount request not sent:', err.message));
  else if (percent > s.notifyPct) announce(row, false).catch((err) => console.error('Discount notice not sent:', err.message));
  return view(row);
}

/* ------------------------------------------------------- Сообщения в группы */

const money = (n) => `${new Intl.NumberFormat('ru-RU').format(n)} ฿`;
const KIND_TEXT = (r) => (r.kind === 'percent' ? `${r.value}%` : r.kind === 'amount' ? `−${money(r.value)}` : `своя цена ${money(r.value)}`);

function messageText(r, request, html) {
  const e = html ? escapeHtml : (s) => String(s ?? '');
  const b = (s) => (html ? `<b>${e(s)}</b>` : s);
  const head = request ? `💸 ${b(`Запрос скидки ${r.percent}%`)} — нужно одобрение` : `💸 ${b(`Скидка ${r.percent}%`)}`;
  const lines = [
    head,
    `Договор ${e(r.number)} · ${e(r.client || '—')}`,
    `${e(r.model || '')}${r.plate ? ` #${e(r.plate)}` : ''}`,
    `По прайсу ${money(r.base_total)} → ${b(money(r.final_total))} (${e(KIND_TEXT(r))}, −${money(r.base_total - r.final_total)})`,
    `Причина: ${e(r.reason)}${r.comment ? ` — «${e(r.comment)}»` : ''}`,
    `Дал(а): ${e(r.by_name || r.by_email || '—')}`
  ];
  if (r.status === 'approved' && r.decided_by) lines.push(`✅ Одобрил(а): ${e(r.decided_by)}`);
  if (r.status === 'rejected') lines.push(`❌ Отклонил(а): ${e(r.decided_by)} — в договоре цена по прайсу`);
  return lines.join('\n');
}

async function announce(r, request) {
  const s = discountSettings();
  if ((s.channels === 'tg' || s.channels === 'both') && s.tgChat && telegramEnabled) {
    const markup = request ? { reply_markup: inlineKeyboard([[{ text: '✅ Одобрить', callback_data: `disc:ok:${r.id}` }, { text: '❌ Отклонить', callback_data: `disc:no:${r.id}` }]]) } : {};
    const sent = await sendMessage(s.tgChat, messageText(r, request, true), markup).catch((err) => { console.error('Discount to Telegram failed:', err.message); return null; });
    if (sent?.message_id) q.setTg.run(String(s.tgChat), sent.message_id, r.id);
  }
  if ((s.channels === 'wa' || s.channels === 'both') && s.waGroup) {
    const text = messageText(r, request, false) + (request ? '\n\nОтветьте на это сообщение «+» — одобрить, «-» — отклонить (владелец или админ).' : '');
    const id = await wabotSend(s.waGroup, text).catch((err) => { console.error('Discount to WhatsApp failed:', err.code || err.message); return null; });
    if (id) q.setWa.run(s.waGroup, String(id), r.id);
  }
}

/** После решения — обновить сообщение в Telegram (без кнопок) и ответить в WhatsApp */
async function announceDecision(r) {
  if (r.tg_chat && r.tg_msg && telegramEnabled) {
    await tg('editMessageText', { chat_id: r.tg_chat, message_id: r.tg_msg, text: messageText(r, true, true), parse_mode: 'HTML' }).catch(() => null);
  }
  if (r.wa_group && r.wa_msg) {
    await wabotSend(r.wa_group, r.status === 'approved' ? `✅ Скидку по ${r.number} одобрил(а) ${r.decided_by}` : `❌ Скидку по ${r.number} отклонил(а) ${r.decided_by} — в договоре цена по прайсу`,
      { id: r.wa_msg, fromMe: true, text: `Запрос скидки ${r.percent}%` }).catch(() => null);
  }
}

/* ------------------------------------------------------------- Решение */

let onDecided = null;
/** Что сделать с договором после решения (documents.js: отклонили — цена по прайсу) */
export const setDecisionHandler = (fn) => { onDecided = fn; };

export async function decideDiscount(id, approve, who, via) {
  const r = q.byId.get(Number(id) || 0);
  if (!r || !r.active) throw new DiscountError('unknown_discount');
  if (r.status !== 'pending') throw new DiscountError('already_decided');
  const status = approve ? 'approved' : 'rejected';
  if (!q.decide.run(status, who, new Date().toISOString(), via, r.id, 'pending').changes) throw new DiscountError('already_decided');
  const fresh = q.byId.get(r.id);
  console.log(`Discount #${r.id} (${r.number}) ${status} by ${who} via ${via}`);
  if (onDecided) await Promise.resolve(onDecided(view(fresh))).catch((err) => console.error('Discount decision handler failed:', err.message));
  await announceDecision(fresh);
  return view(fresh);
}

/** Владелец или админ по Telegram ID / номеру WhatsApp (из «Доступов») */
function approverBy(match) {
  const s = activeStaff().find((x) => (x.roleId === ADMIN_ROLE || x.roleId === 'owner') && match(x));
  return s ? s.name || s.email : null;
}

/** Кнопка в Telegram: disc:ok:12 / disc:no:12 */
export async function handleDiscountCallback(query, action, value) {
  const who = approverBy((x) => x.telegramId && String(x.telegramId) === String(query.from.id));
  if (!who) return answerCallback(query, 'Одобрять скидки могут только владелец и админ (Telegram ID — в «Доступах»).');
  try {
    const r = await decideDiscount(value, action === 'ok', who, 'telegram');
    return answerCallback(query, r.status === 'approved' ? 'Скидка одобрена' : 'Скидка отклонена');
  } catch (err) {
    return answerCallback(query, err.code === 'already_decided' ? 'Уже решено' : 'Не получилось');
  }
}

/** Ответ в WhatsApp на запрос скидки: «+» — одобрить, «-» — отклонить. true — это был ответ про скидку */
export async function handleDiscountWaReply(body, say) {
  const r = body.quotedId ? q.byWa.get(String(body.quotedId)) : null;
  if (!r) return false;
  const text = String(body.text || '').trim();
  // \b в JS не видит границу кириллических слов — проверяем «не буква дальше»
  const yes = /^(\+|➕|👍|✅|(ок|ok|да)(?!\p{L})|одобр)/iu.test(text);
  const no = /^(-|—|➖|❌|(нет|no)(?!\p{L})|отклон)/iu.test(text);
  if (!yes && !no) return true;
  const phone = String(body.author || '').replace(/\D/g, '');
  const who = approverBy((x) => String(x.whatsapp || '').replace(/\D/g, '').endsWith(phone.slice(-9)) && phone.length >= 8);
  if (!who) {
    await say('Одобрять скидки могут только владелец и админ (номер WhatsApp — в «Доступах» портала).');
    return true;
  }
  try {
    await decideDiscount(r.id, yes, who, 'whatsapp');
  } catch (err) {
    if (err.code === 'already_decided') await say('По этой скидке уже решили.');
  }
  return true;
}

/** Группа WhatsApp для скидок — wabot читает ответы и в ней */
export const discountWaGroup = () => {
  const s = discountSettings();
  return s.channels === 'wa' || s.channels === 'both' ? s.waGroup : null;
};

/* ------------------------------------------------------------ Маршруты */

const call = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DiscountError) throw new HttpError(400, err.code);
    throw err;
  }
};

/** Сделки со скидками за период, итоги по причинам и сотрудникам, ждут одобрения */
export async function discountsReport(staff, req, res, url) {
  if (!can(staff, 'finance.view') && !canApprove(staff)) throw new HttpError(403, 'no_section_access');
  const to = String(url.searchParams.get('to') || '');
  const from = String(url.searchParams.get('from') || '');
  const a = /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(Date.parse(`${from}T00:00:00+07:00`)).toISOString() : '0000';
  const b = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(Date.parse(`${to}T00:00:00+07:00`) + 86400000).toISOString() : '9999';
  const list = q.between.all(a, b).map(view);
  const given = list.filter((x) => x.status === 'approved');
  const group = (key) => {
    const m = new Map();
    for (const x of given) {
      const k = x[key] || '—';
      const g = m.get(k) || { name: k, count: 0, off: 0 };
      g.count++;
      g.off += x.off;
      m.set(k, g);
    }
    return [...m.values()].sort((x, y) => y.off - x.off);
  };
  sendJson(res, 200, {
    list, canApprove: canApprove(staff), settings: { approvePct: discountSettings().approvePct },
    totals: { count: given.length, off: given.reduce((s, x) => s + x.off, 0), base: given.reduce((s, x) => s + x.base, 0) },
    byReason: group('reason'), byStaff: group('by'),
    pending: q.pending.all().map(view)
  });
}

export async function discountsDecide(staff, req, res) {
  if (!canApprove(staff)) throw new HttpError(403, 'owner_or_admin_only');
  const { id, approve } = await readJson(req);
  sendJson(res, 200, { discount: await call(() => decideDiscount(id, Boolean(approve), staff.name || staff.email, 'portal')) });
}

export async function discountsSettingsRoute(staff, req, res) {
  if (!can(staff, 'access.admin')) throw new HttpError(403, 'admin_only');
  const body = await readJson(req);
  let joined = null;
  if (body.waInvite) {
    // Бот вступает в группу по ссылке-приглашению, и она становится группой для скидок
    joined = await wabotJoinGroup(body.waInvite);
    body.waGroup = joined.id;
    if (!body.channels) body.channels = discountSettings().channels === 'tg' ? 'both' : undefined;
  }
  await call(() => saveDiscountSettings(body));
  sendJson(res, 200, { settings: await discountSettingsView(), joined });
}

