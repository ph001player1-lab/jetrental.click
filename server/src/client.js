/**
 * ============================================================================
 * Диалог с клиентом — общий для Telegram и WhatsApp
 * ============================================================================
 * Шаги: язык (EN / RU / TH / ZH, запоминается для чата) → тип техники →
 * даты → свободные модели с ценами → телефон (только в Telegram; в WhatsApp
 * номер уже известен) → заявка в рабочую группу и в Google-таблицу.
 *
 * Канал передаётся объектом chat:
 *   { channel, key (ключ сессии), id (куда отвечать), name, phone, ui }
 * где ui умеет: b(), esc(), send(), choices(), askPhone(), ack(),
 * closeChoices(), restartHint(lang).
 * ============================================================================
 */

import * as db from './db.js';
import { VEHICLE_TYPES, formatShortDate, formatThb, rentalDays } from './format.js';
import { parseDateRange } from './dates.js';
import { findAvailableModels, sheetsEnabled } from './fleet.js';
import { publishRequest } from './staff.js';
import { rememberChatRef, chatRefOf, chatSourceKnown, heardOptions, resolveHeard, rememberHeard } from './marketing.js';
import { LANGUAGES, LANGUAGE_PROMPT, LANGUAGE_LIST_BUTTON, normalizeLanguage, t } from './i18n.js';
import { noteBotChat } from './gameLive.js';

// В списке WhatsApp максимум 10 строк: 9 моделей + «Помогите выбрать»
const MAX_MODEL_OPTIONS = 9;
const RESTART_WORDS = ['/start', 'start', 'старт', 'меню', 'menu', 'начать', 'เมนู', '菜单'];
const LANGUAGE_WORDS = ['/lang', 'lang', 'language', 'язык', 'ภาษา', '语言'];
// «Назад» словом или «0» (в WhatsApp компании так подписан этот вариант)
const BACK_WORDS = ['0', 'назад', 'back', '/back', 'ย้อนกลับ', '返回'];
const DATE_EXAMPLE = '5.11 - 12.11';

const LANGUAGE_OPTIONS = Object.entries(LANGUAGES).map(([code, l]) => ({ id: `lang:${code}`, title: l.title }));

function typeOptions(lang, chat) {
  const list = Object.keys(VEHICLE_TYPES).map((type) => ({ id: `type:${type}`, title: t(lang, `type_${type}`) }));
  // WhatsApp компании: постоянным клиентам (продлить, вопрос) — сразу к менеджеру
  if (chat?.managerOption) list.push({ id: 'manager:1', title: t(lang, 'talk_manager') });
  return list;
}

function firstWord(text) {
  return String(text || '').trim().toLowerCase().split(/\s|@/)[0];
}

/** «меню», «start»… — клиент просит начать заново */
export function isRestartText(text) {
  return RESTART_WORDS.includes(firstWord(text));
}

function isBackText(text) {
  return BACK_WORDS.includes(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}/]+/gu, ' ').trim());
}

/** Вариант «◀️ Назад» — есть на каждом шаге, кроме выбора языка */
const backOption = (lang) => ({ id: 'back:1', title: t(lang, 'back'), back: true });
const withBack = (lang, options) => [...options, backOption(lang)];
// Первое меню: вместо «Назад» — «Язык» (шаг назад отсюда и есть выбор языка)
const withLanguage = (lang, options) => [...options, { ...backOption(lang), title: t(lang, 'change_language') }];

/** Вопрос, на который клиент отвечает текстом (даты, название отеля…), — с «Назад» */
function askText(chat, lang, text) {
  return chat.ui.choices(text, [backOption(lang)]);
}

function askDates(chat, lang, session) {
  db.saveSession(chat.key, { step: 'dates', vehicleType: session.vehicleType });
  return askText(chat, lang, t(lang, 'ask_dates', { example: chat.ui.b(DATE_EXAMPLE) }));
}

function chatLanguage(chat) {
  return db.getChatLanguage(chat.key);
}

// Язык можно и написать словом, а не нажать кнопку
const LANGUAGE_NAMES = {
  en: ['en', 'english', 'eng', 'английский', 'อังกฤษ', '英语', '英文'],
  ru: ['ru', 'russian', 'русский', 'рус', 'รัสเซีย', '俄语', '俄文'],
  th: ['th', 'thai', 'тайский', 'ไทย', 'ภาษาไทย', '泰语', '泰文'],
  zh: ['zh', 'cn', 'chinese', 'китайский', 'จีน', 'ภาษาจีน', '中文', '汉语', '中国']
};

function languageFromText(text) {
  const value = String(text || '').trim().toLowerCase();
  return Object.keys(LANGUAGE_NAMES).find((code) => LANGUAGE_NAMES[code].includes(value)) || null;
}

async function askLanguage(chat) {
  db.saveSession(chat.key, { step: 'lang' });
  await chat.ui.choices(LANGUAGE_PROMPT, LANGUAGE_OPTIONS, { listButton: LANGUAGE_LIST_BUTTON, sectionTitle: 'Languages' });
}

/** Начало диалога: язык спрашиваем один раз, дальше он запомнен для этого чата */
async function startFlow(chat) {
  const lang = chatLanguage(chat);
  if (!lang) return askLanguage(chat);
  db.saveSession(chat.key, { step: 'type' });
  await chat.ui.choices(t(lang, 'greeting'), withLanguage(lang, typeOptions(lang, chat)));
}

function askPhone(chat, lang) {
  return chat.ui.askPhone(t(lang, 'ask_phone'), t(lang, 'phone_button'), t(lang, 'back'));
}

/** Шаг назад: тип → язык, даты → тип, модели → даты, «откуда узнали» → модели или даты… */
async function goBack(chat, lang, session) {
  switch (session?.step) {
    case 'type': return askLanguage(chat);
    case 'dates': return startFlow(chat);
    case 'model': return askDates(chat, lang, session);
    case 'heard': return session.modelShown ? offerModels(chat, lang, session) : askDates(chat, lang, session);
    case 'heard_agent':
    case 'heard_other': return askHeard(chat, lang, session);
    case 'contact':
      if (session.heardAsked) return askHeard(chat, lang, session);
      return session.modelShown ? offerModels(chat, lang, session) : askDates(chat, lang, session);
    default: return startFlow(chat);
  }
}

function priceText(lang, option) {
  if (option.price?.total) {
    return t(lang, 'price_total', { perDay: formatThb(option.price.perDay), total: formatThb(option.price.total) });
  }
  if (option.price?.fromPerDay) return t(lang, 'price_from', { perDay: formatThb(option.price.fromPerDay) });
  return t(lang, 'price_unknown');
}

/** После выбора модели: в WhatsApp телефон уже есть — сразу заявка, в Telegram спрашиваем номер */
/** «Откуда вы о нас узнали?» — один раз, если клиент пришёл не по ссылке с кодом */
async function askHeard(chat, lang, session) {
  db.saveSession(chat.key, { ...session, step: 'heard' });
  const options = heardOptions().map((o) => ({ id: `heard:${o.key}`, title: typeof o.label === 'string' ? o.label : t(lang, o.label.text) }));
  await chat.ui.choices(t(lang, 'ask_heard'), withBack(lang, options), { listButton: t(lang, 'heard_list_button'), sectionTitle: t(lang, 'heard_list_button') });
}

/** Ответ записан — дальше телефон или сразу заявка */
async function afterHeard(chat, lang, session, answer) {
  rememberHeard(chat.key, answer);
  return afterModel(chat, lang, { ...session, heardCode: answer.code, heardText: answer.code ? null : answer.text, heardAsked: true });
}

async function chooseHeard(chat, lang, key) {
  const session = db.getSession(chat.key);
  if (!session || session.step !== 'heard') { await chat.ui.ack(); return startFlow(chat); }
  const option = heardOptions().find((o) => o.key === key);
  if (!option) return chat.ui.ack();
  await chat.ui.ack();
  await chat.ui.closeChoices(t(lang, 'you_chose', { what: typeof option.label === 'string' ? option.label : t(lang, option.label.text) }));
  // Отель или агент — уточняем название; «Другое» — просим написать словами
  if (key === 'agent' || key === 'other') {
    db.saveSession(chat.key, { ...session, step: key === 'agent' ? 'heard_agent' : 'heard_other' });
    return askText(chat, lang, t(lang, key === 'agent' ? 'ask_heard_agent' : 'ask_heard_other'));
  }
  return afterHeard(chat, lang, session, resolveHeard(key));
}

function afterModel(chat, lang, session) {
  if (!session.heardAsked && !chatSourceKnown(chat.key)) return askHeard(chat, lang, session);
  if (chat.phone) return finishRequest(chat, lang, session, chat.phone);
  db.saveSession(chat.key, { ...session, step: 'contact' });
  return askPhone(chat, lang);
}

/**
 * После дат показываем свободные модели. Если таблица не подключена или
 * недоступна — заявку подберёт менеджер.
 */
async function offerModels(chat, lang, session) {
  const { ui } = chat;
  let options = [];
  if (sheetsEnabled) {
    try {
      options = (await findAvailableModels(session.vehicleType, session.dateFrom, session.dateTo)).slice(0, MAX_MODEL_OPTIONS);
    } catch (err) {
      console.error('Fleet lookup failed:', err.message);
      return afterModel(chat, lang, session);
    }
  } else {
    return afterModel(chat, lang, session);
  }

  const period = `${formatShortDate(session.dateFrom)} – ${formatShortDate(session.dateTo)}`;

  if (options.length === 0) {
    await ui.send(t(lang, 'none_available', { period }));
    return afterModel(chat, lang, session);
  }

  db.saveSession(chat.key, {
    ...session,
    step: 'model',
    // Модели показывали — «Назад» с вопроса «откуда узнали» вернёт к ним
    modelShown: true,
    options: options.map((o) => ({ model: o.model, total: o.price?.total || null, plates: o.freePlates }))
  });

  const lines = options.map((o) => `• ${ui.b(o.model)} — ${priceText(lang, o)}`);
  const choices = options.map((o, i) => ({ id: `model:${i}`, title: o.model, description: priceText(lang, o) }));
  choices.push({ id: 'model:any', title: t(lang, 'help_choose') });

  // Варианты текстом (WhatsApp компании) уже содержат модель и цену — не повторяем их
  await ui.choices(
    `${t(lang, 'available', { period, days: rentalDays(session.dateFrom, session.dateTo) })}\n\n` +
      `${ui.textChoices ? '' : `${lines.join('\n')}\n\n`}${t(lang, 'choose_model')}`,
    withBack(lang, choices),
    { listButton: t(lang, 'model_list_button') }
  );
}

function extractPhone(text) {
  const value = String(text || '').trim();
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? value : null;
}

async function finishRequest(chat, lang, session, phone, name = chat.name) {
  const request = db.createRequest({
    channel: chat.channel,
    clientChatId: chat.id,
    clientName: name,
    clientPhone: phone,
    vehicleType: session.vehicleType,
    dateFrom: session.dateFrom,
    dateTo: session.dateTo,
    model: session.model,
    estimateThb: session.estimateThb,
    freeUnits: session.freeUnits,
    lang,
    sourceRef: chatRefOf(chat.key) || session.heardCode || null,
    heardFrom: session.heardText || null
  });
  db.clearSession(chat.key);

  const { ui } = chat;
  const typeLabel = t(lang, `type_${request.vehicle_type}`);
  const what = request.model ? `${typeLabel} ${ui.esc(request.model)}` : typeLabel;
  const period = `${formatShortDate(request.date_from)} – ${formatShortDate(request.date_to)}`;
  await ui.send(
    `✅ ${ui.b(t(lang, 'request_title', { id: request.id }))}\n` +
      `${t(lang, 'request_summary', { what, period, days: rentalDays(request.date_from, request.date_to) })}\n\n` +
      t(lang, 'request_next', { restart: ui.restartHint(lang) }),
    { removeKeyboard: true }
  );

  await chat.afterRequest?.(request);
  await publishRequest(request);
}

/**
 * Текст от клиента. contact — номер, присланный кнопкой «Отправить мой
 * номер» в Telegram: { phone, name }.
 */
export async function handleClientText(chat, text, contact = null) {
  noteBotChat(chat);
  // Код источника из ссылки на бота («/start ref_КОД», «[ref:КОД]») — для вкладки «Маркетинг»
  try { rememberChatRef(chat.key, text); } catch (err) { console.error('Chat ref failed:', err.message); }
  const word = firstWord(text);
  if (LANGUAGE_WORDS.includes(word)) return askLanguage(chat);

  const session = db.getSession(chat.key);
  if (session?.step === 'lang') {
    const code = languageFromText(text);
    return code ? chooseLanguage(chat, code) : askLanguage(chat);
  }
  if (RESTART_WORDS.includes(word) || !session || !chatLanguage(chat)) return startFlow(chat);

  const lang = normalizeLanguage(chatLanguage(chat));
  if (isBackText(text)) return goBack(chat, lang, session);

  switch (session.step) {

    case 'type':
      return chat.ui.choices(t(lang, 'choose_please'), withLanguage(lang, typeOptions(lang, chat)));

    case 'dates': {
      const result = parseDateRange(text);
      if (result.error) {
        return chat.ui.send(t(lang, `date_${result.error}`, { example: chat.ui.b(DATE_EXAMPLE) }));
      }
      return offerModels(chat, lang, { ...session, dateFrom: result.from, dateTo: result.to });
    }

    case 'model':
      return chat.ui.send(t(lang, 'choose_model_above'));

    case 'heard':
      return askHeard(chat, lang, session);

    case 'heard_agent':
    case 'heard_other':
      if (!String(text || '').trim()) return askText(chat, lang, t(lang, session.step === 'heard_agent' ? 'ask_heard_agent' : 'ask_heard_other'));
      return afterHeard(chat, lang, session, resolveHeard(session.step === 'heard_agent' ? 'agent' : 'other', text));

    case 'contact': {
      const phone = contact?.phone || extractPhone(text);
      if (!phone) return askPhone(chat, lang);
      return finishRequest(chat, lang, session, phone, contact?.name || chat.name);
    }

    default:
      return startFlow(chat);
  }
}

async function chooseLanguage(chat, code) {
  if (!LANGUAGES[code]) return chat.ui.ack();
  db.setChatLanguage(chat.key, code);
  await chat.ui.ack();
  await chat.ui.closeChoices(LANGUAGES[code].title);
  return startFlow(chat);
}

async function chooseType(chat, lang, vehicleType) {
  if (!VEHICLE_TYPES[vehicleType]) return chat.ui.ack();

  db.saveSession(chat.key, { step: 'dates', vehicleType });
  await chat.ui.ack();
  await chat.ui.closeChoices(t(lang, 'you_chose', { what: t(lang, `type_${vehicleType}`) }));
  await askText(chat, lang, t(lang, 'ask_dates', { example: chat.ui.b(DATE_EXAMPLE) }));
}

async function chooseModel(chat, lang, value) {
  const session = db.getSession(chat.key);
  if (!session || session.step !== 'model') {
    await chat.ui.ack();
    return startFlow(chat);
  }

  const option = value === 'any' ? null : session.options?.[Number(value)];
  if (value !== 'any' && !option) return chat.ui.ack();

  const next = {
    ...session,
    options: undefined,
    model: option?.model || null,
    estimateThb: option?.total || null,
    freeUnits: option?.plates?.join(', ') || null
  };
  await chat.ui.ack();
  await chat.ui.closeChoices(option ? t(lang, 'you_chose', { what: chat.ui.b(option.model) }) : t(lang, 'help_ok'));
  return afterModel(chat, lang, next);
}

/** Нажатие кнопки или выбор в списке: lang:<код>, type:<тип>, model:<номер|any>, heard:<ответ>, manager:1, back:1 */
export async function handleClientChoice(chat, action, value) {
  noteBotChat(chat);
  if (action === 'lang') return chooseLanguage(chat, value);

  const lang = chatLanguage(chat);
  if (!lang) return askLanguage(chat);

  if (action === 'type') return chooseType(chat, lang, value);
  if (action === 'model') return chooseModel(chat, lang, value);
  if (action === 'heard') return chooseHeard(chat, lang, value);
  if (action === 'back') {
    await chat.ui.ack();
    await chat.ui.closeChoices();
    return goBack(chat, lang, db.getSession(chat.key));
  }
  if (action === 'manager' && chat.onManager) {
    db.clearSession(chat.key);
    return chat.onManager(lang);
  }
  return chat.ui.ack();
}
