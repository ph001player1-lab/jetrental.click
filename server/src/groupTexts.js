/**
 * Тексты для рабочей группы Telegram: карточка заявки, кнопки, ответы бота,
 * утренняя сводка. Язык группы — STAFF_GROUP_LANG (ru — по умолчанию, en).
 * {name} — подстановка; формы для чисел — { one, few, many, other }.
 */

import { config } from './config.js';

const TEXTS = {
  ru: {
    'card.title': '🆕 <b>Заявка #{id}</b>',
    'card.test': ' <i>(тест)</i>',
    'card.days': { one: '{n} день', few: '{n} дня', many: '{n} дней', other: '{n} дня' },
    'card.total': '💰 ≈ {sum} за весь срок',
    'card.free': '🔑 Свободны (госномер): {plates}',
    'card.source': '📲 Источник: {channel}',
    'card.clientLang': ' · язык клиента {lang}',
    'card.taken': '✅ <b>Взял(а): {name}</b> · {time}',
    'card.cant': '🚫 Не могут: {names}',
    'channel.site': 'Сайт',
    'channel.test': 'тестовая заявка',
    'btn.take': '✋ Беру',
    'btn.cant': '🚫 Не могу',
    'cb.notFound': 'Заявка не найдена',
    'cb.alreadyTaken': 'Уже взял(а): {name}',
    'cb.yours': 'Заявка #{id} ваша',
    'cb.inWork': 'Заявка уже в работе',
    'cb.thanks': 'Понятно, спасибо',
    'bind.fromEnv': 'Рабочая группа задана в настройках сервера — /bind здесь не нужен.',
    'bind.adminOnly': 'Подключить группу может только её администратор.',
    'bind.done': '✅ Готово! Новые заявки будут приходить в эту группу.\nПроверьте кнопки: /test',
    'test.bindFirst': 'Сначала подключите группу командой /bind.',
    'test.client': 'Тестовый клиент',
    'test.by': 'создал(а) {name}',
    'hello': '👋 Здравствуйте! Я помощник по заявкам на аренду.\nЧтобы заявки приходили в эту группу, администратор отправляет /bind',
    'cmd.bind': 'Получать заявки в эту группу',
    'cmd.test': 'Тестовая заявка',
    'cmd.summary': 'Сводка: брони и проблемы',

    'sum.title': '☀️ <b>Доброе утро! {date}</b>',
    'sum.today': '<b>Сегодня:</b> {pickups} · {returns}',
    'sum.pickups': { one: '{n} выдача', few: '{n} выдачи', many: '{n} выдач', other: '{n} выдачи' },
    'sum.returns': { one: '{n} возврат', few: '{n} возврата', many: '{n} возвратов', other: '{n} возврата' },
    'sum.ahead': '<b>Брони впереди:</b> 7 дней — {b7} ({v7}) · 30 дней — {b30} ({v30})',
    'sum.vehicles': { one: '{n} ед.', other: '{n} ед.' },
    'sum.fleet': '<b>Парк сейчас:</b> {free} свободно · {rent} в аренде · {service} в сервисе',
    'sum.none': '✅ <b>Проблем нет</b>',
    'sum.problems': '⚠️ <b>Проблемы: {n}</b> — {counts}',
    'sum.more': '…и ещё {n}',
    'cat.sales': 'Продажи', 'cat.it': 'IT', 'cat.marketing': 'Сайт', 'cat.service': 'Сервис'
  },
  en: {
    'card.title': '🆕 <b>Request #{id}</b>',
    'card.test': ' <i>(test)</i>',
    'card.days': { one: '{n} day', other: '{n} days' },
    'card.total': '💰 ≈ {sum} total',
    'card.free': '🔑 Free (plate): {plates}',
    'card.source': '📲 Source: {channel}',
    'card.clientLang': ' · client language {lang}',
    'card.taken': '✅ <b>Taken by: {name}</b> · {time}',
    'card.cant': '🚫 Can’t: {names}',
    'channel.site': 'Website',
    'channel.test': 'test request',
    'btn.take': '✋ Take',
    'btn.cant': '🚫 Can’t',
    'cb.notFound': 'Request not found',
    'cb.alreadyTaken': 'Already taken by {name}',
    'cb.yours': 'Request #{id} is yours',
    'cb.inWork': 'Already taken',
    'cb.thanks': 'OK, thanks',
    'bind.fromEnv': 'The staff group is set in the server settings — /bind is not needed here.',
    'bind.adminOnly': 'Only a group admin can connect this group.',
    'bind.done': '✅ Done! New requests will come to this group.\nTry the buttons: /test',
    'test.bindFirst': 'Connect this group first with /bind.',
    'test.client': 'Test client',
    'test.by': 'created by {name}',
    'hello': '👋 Hi! I’m the rental requests assistant.\nTo receive new requests in this group, an admin sends /bind',
    'cmd.bind': 'Receive requests in this group',
    'cmd.test': 'Test request',
    'cmd.summary': 'Summary: bookings and problems',

    'sum.title': '☀️ <b>Good morning! {date}</b>',
    'sum.today': '<b>Today:</b> {pickups} · {returns}',
    'sum.pickups': { one: '{n} pickup', other: '{n} pickups' },
    'sum.returns': { one: '{n} return', other: '{n} returns' },
    'sum.ahead': '<b>Bookings ahead:</b> 7 days — {b7} ({v7}) · 30 days — {b30} ({v30})',
    'sum.vehicles': { one: '{n} vehicle', other: '{n} vehicles' },
    'sum.fleet': '<b>Fleet now:</b> {free} free · {rent} rented · {service} in service',
    'sum.none': '✅ <b>No problems</b>',
    'sum.problems': '⚠️ <b>Problems: {n}</b> — {counts}',
    'sum.more': '…and {n} more',
    'cat.sales': 'Sales', 'cat.it': 'IT', 'cat.marketing': 'Website', 'cat.service': 'Service'
  }
};

const LOCALES = { ru: 'ru-RU', en: 'en-GB' };

/** Язык рабочей группы */
export const groupLang = TEXTS[config.telegram.groupLang] ? config.telegram.groupLang : 'ru';

/** Текст для группы; params подставляются как есть (экранирует вызывающий) */
export function g(key, params = {}) {
  const text = TEXTS[groupLang][key] ?? TEXTS.en[key] ?? key;
  return String(text).replace(/\{(\w+)\}/g, (m, name) => (name in params ? params[name] : m));
}

/** Число с нужной формой слова: gn('sum.pickups', 3) → «3 выдачи» */
export function gn(key, n) {
  const forms = TEXTS[groupLang][key] || TEXTS.en[key];
  return (forms[new Intl.PluralRules(LOCALES[groupLang]).select(n)] || forms.other).replace('{n}', n);
}

export const groupLocale = LOCALES[groupLang];
