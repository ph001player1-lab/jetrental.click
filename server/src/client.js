/**
 * ============================================================================
 * Диалог с клиентом — общий для Telegram и WhatsApp
 * ============================================================================
 * Шаги: тип техники (кнопки) → даты → свободные модели с ценами (кнопки или
 * список) → телефон (только в Telegram; в WhatsApp номер уже известен) →
 * заявка в рабочую группу и в Google-таблицу.
 *
 * Канал передаётся объектом chat:
 *   { channel, key (ключ сессии), id (куда отвечать), name, phone, ui }
 * где ui умеет: b(), esc(), send(), choices(), askPhone(), ack(), closeChoices().
 * ============================================================================
 */

import * as db from './db.js';
import { VEHICLE_TYPES, vehicleTypeLabel, formatShortDate, formatThb, daysBetween } from './format.js';
import { parseDateRange } from './dates.js';
import { findAvailableModels, sheetsEnabled } from './fleet.js';
import { publishRequest } from './staff.js';

// В списке WhatsApp максимум 10 строк: 9 моделей + «Помогите выбрать»
const MAX_MODEL_OPTIONS = 9;
const RESTART_WORDS = ['/start', 'start', 'старт', 'меню', 'menu', 'начать'];

const TYPE_OPTIONS = Object.entries(VEHICLE_TYPES).map(([type, t]) => ({ id: `type:${type}`, title: `${t.icon} ${t.label}` }));

function dateError(ui, code) {
  switch (code) {
    case 'format': return `Не понял даты 🙏 Напишите две даты, например: ${ui.b('5.11 - 12.11')}`;
    case 'invalid': return 'Такой даты нет в календаре 🙂 Проверьте, пожалуйста.';
    case 'past': return 'Эта дата уже прошла. Напишите даты, начиная с сегодняшнего дня.';
    case 'order': return 'Дата возврата должна быть позже даты начала аренды.';
    default: return 'Срок больше года — напишите, пожалуйста, даты покороче.';
  }
}

function isRestart(text) {
  const word = String(text || '').trim().toLowerCase().split(/\s|@/)[0];
  return RESTART_WORDS.includes(word);
}

async function startFlow(chat) {
  db.saveSession(chat.key, { step: 'type' });
  await chat.ui.choices('Здравствуйте! 👋 Помогу подобрать технику в аренду.\n\nЧто хотите арендовать?', TYPE_OPTIONS);
}

function askPhone(chat) {
  return chat.ui.askPhone('📱 Оставьте номер телефона (лучше WhatsApp): нажмите кнопку ниже или напишите номер.');
}

function priceText(option) {
  if (option.price?.total) return `${formatThb(option.price.perDay)}/день, ≈ ${formatThb(option.price.total)}`;
  if (option.price?.fromPerDay) return `от ${formatThb(option.price.fromPerDay)}/день`;
  return 'цену уточнит менеджер';
}

/** После выбора модели: в WhatsApp телефон уже есть — сразу заявка, в Telegram спрашиваем номер */
function afterModel(chat, session) {
  if (chat.phone) return finishRequest(chat, session, chat.phone);
  db.saveSession(chat.key, { ...session, step: 'contact' });
  return askPhone(chat);
}

/**
 * После дат показываем свободные модели. Если таблица не подключена или
 * недоступна — заявку подберёт менеджер.
 */
async function offerModels(chat, session) {
  const { ui } = chat;
  let options = [];
  if (sheetsEnabled) {
    try {
      options = (await findAvailableModels(session.vehicleType, session.dateFrom, session.dateTo)).slice(0, MAX_MODEL_OPTIONS);
    } catch (err) {
      console.error('Fleet lookup failed:', err.message);
      return afterModel(chat, session);
    }
  } else {
    return afterModel(chat, session);
  }

  const period = `${formatShortDate(session.dateFrom)} – ${formatShortDate(session.dateTo)}`;

  if (options.length === 0) {
    await ui.send(`😔 На ${period} свободной техники этого типа не нашлось. Менеджер предложит варианты.`);
    return afterModel(chat, session);
  }

  db.saveSession(chat.key, {
    ...session,
    step: 'model',
    options: options.map((o) => ({ model: o.model, total: o.price?.total || null, plates: o.freePlates }))
  });

  const lines = options.map((o) => `• ${ui.b(o.model)} — ${priceText(o)}`);
  const choices = options.map((o, i) => ({ id: `model:${i}`, title: o.model, description: priceText(o) }));
  choices.push({ id: 'model:any', title: '🤷 Помогите выбрать' });

  await ui.choices(
    `✅ Свободно на ${period} (${daysBetween(session.dateFrom, session.dateTo)} дн.):\n\n${lines.join('\n')}\n\nВыберите модель 👇`,
    choices,
    { listButton: 'Выбрать модель' }
  );
}

function extractPhone(text) {
  const value = String(text || '').trim();
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? value : null;
}

async function finishRequest(chat, session, phone, name = chat.name) {
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
    freeUnits: session.freeUnits
  });
  db.clearSession(chat.key);

  const { ui } = chat;
  const days = daysBetween(request.date_from, request.date_to);
  const what = request.model ? `${vehicleTypeLabel(request.vehicle_type)} ${ui.esc(request.model)}` : vehicleTypeLabel(request.vehicle_type);
  await ui.send(
    `✅ ${ui.b(`Заявка #${request.id} принята!`)}\n` +
      `${what}, ${formatShortDate(request.date_from)} – ${formatShortDate(request.date_to)} (${days} дн.)\n\n` +
      `Менеджер скоро свяжется с вами и подтвердит бронь. Новая заявка: ${ui.restartHint}`,
    { removeKeyboard: true }
  );

  await publishRequest(request);
}

/**
 * Текст от клиента. contact — номер, присланный кнопкой «Отправить мой
 * номер» в Telegram: { phone, name }.
 */
export async function handleClientText(chat, text, contact = null) {
  const session = db.getSession(chat.key);
  if (isRestart(text) || !session) return startFlow(chat);

  switch (session.step) {
    case 'type':
      return chat.ui.choices('Выберите, пожалуйста, вариант 👇', TYPE_OPTIONS);

    case 'dates': {
      const result = parseDateRange(text);
      if (result.error) return chat.ui.send(dateError(chat.ui, result.error));
      return offerModels(chat, { ...session, dateFrom: result.from, dateTo: result.to });
    }

    case 'model':
      return chat.ui.send('Выберите модель в списке выше 👆 или нажмите «Помогите выбрать».');

    case 'contact': {
      const phone = contact?.phone || extractPhone(text);
      if (!phone) return askPhone(chat);
      return finishRequest(chat, session, phone, contact?.name || chat.name);
    }

    default:
      return startFlow(chat);
  }
}

async function chooseType(chat, vehicleType) {
  if (!VEHICLE_TYPES[vehicleType]) return chat.ui.ack();

  db.saveSession(chat.key, { step: 'dates', vehicleType });
  await chat.ui.ack();
  await chat.ui.closeChoices(`Вы выбрали: ${vehicleTypeLabel(vehicleType)}`);
  await chat.ui.send(`📅 На какие даты? Напишите, например: ${chat.ui.b('5.11 - 12.11')}`);
}

async function chooseModel(chat, value) {
  const session = db.getSession(chat.key);
  if (!session || session.step !== 'model') {
    await chat.ui.ack('Начните заново');
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
  await chat.ui.closeChoices(option ? `Вы выбрали: ${chat.ui.b(option.model)}` : 'Хорошо, менеджер поможет подобрать 👌');
  return afterModel(chat, next);
}

/** Нажатие кнопки или выбор в списке: type:<тип>, model:<номер|any> */
export async function handleClientChoice(chat, action, value) {
  if (action === 'type') return chooseType(chat, value);
  if (action === 'model') return chooseModel(chat, value);
  return chat.ui.ack();
}
