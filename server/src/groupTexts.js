/**
 * Тексты для рабочей группы Telegram: карточка заявки, кнопки, ответы бота,
 * утренняя сводка. Язык группы — STAFF_GROUP_LANG (ru — по умолчанию, en).
 * {name} — подстановка; формы для чисел — { one, few, many, other }.
 */

import { config } from './config.js';

const TEXTS = {
  ru: {
    'card.title': '🆕 <b>Заявка #{id}</b>',
    'card.question': '💬 <b>Вопрос #{id}</b> — клиент просит связаться',
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
    // Рабочая группа WhatsApp (пишет WhatsApp-бот компании)
    'wa.takeHint': '👉 Взять — напишите «+{id}» (или просто «+», если новая заявка одна). Не можете — «-{id}».',
    'wa.taken': '✅ {what} #{id} — {name}',
    'wa.pickOne': 'Новых заявок несколько: {list}. Напишите «+номер», например «+{first}», или ответьте «+» на нужную карточку.',
    'wa.notFound': 'Заявки #{id} нет. Новые заявки: {list}.',
    'wa.noneOpen': 'Новых заявок нет.',
    'wa.alreadyTaken': '{what} #{id} уже взял(а): {name}',
    'wa.takenElsewhere': '✅ {what} #{id} взял(а): {name} (в Telegram)',
    'word.requestAcc': 'Заявку', 'word.questionAcc': 'Вопрос', 'word.request': 'Заявка', 'word.question': 'Вопрос',
    'wa.clientWrote': '💬 #{id} {who}: {text}',
    'wa.mediaFailed': '⚠️ Вложение к #{id} переслать не удалось — попросите клиента прислать ещё раз.',
    'wa.media.photo': '📷 фото', 'wa.media.video': '🎬 видео', 'wa.media.voice': '🎤 голосовое',
    'wa.media.document': '📄 файл', 'wa.media.sticker': 'стикер', 'wa.media.location': '📍 геопозиция',
    'wa.media.contact': '👤 контакт', 'wa.media.other': 'вложение',
    'cmd.test': 'Тестовая заявка',
    'cmd.summary': 'Сводка: брони и предупреждения',

    'sum.title': '☀️ <b>Доброе утро! {date}</b>',
    'sum.today': '<b>Сегодня:</b> {pickups} · {returns}',
    'sum.pickups': { one: '{n} выдача', few: '{n} выдачи', many: '{n} выдач', other: '{n} выдачи' },
    'sum.returns': { one: '{n} возврат', few: '{n} возврата', many: '{n} возвратов', other: '{n} возврата' },
    'sum.ahead': '<b>Брони впереди:</b> 7 дней — {b7} ({v7}) · 30 дней — {b30} ({v30})',
    'sum.vehicles': { one: '{n} ед.', other: '{n} ед.' },
    'sum.fleet': '<b>Парк сейчас:</b> {free} свободно · {rent} в аренде · {service} в сервисе',
    'sum.none': '✅ <b>Предупреждений нет</b>',
    'sum.problems': '⚠️ <b>Предупреждения: {n}</b> — {counts}',
    'sum.more': '…и ещё {n}',
    'cat.sales': 'Продажи', 'cat.it': 'IT', 'cat.marketing': 'Сайт', 'cat.service': 'Сервис',

    // Личные оповещения админам (вкладка «Сервер»)
    'alert.traffic70': '🟡 <b>Трафик сервера: {percent}% лимита</b>\nУшло {used} из {limit} ГБ за месяц. Прогноз до конца месяца — {forecast} ГБ.',
    'alert.traffic90': '🔴 <b>Трафик сервера: {percent}% лимита!</b>\nУшло {used} из {limit} ГБ за месяц. Прогноз — {forecast} ГБ. Проверьте лимит в панели OVH.',
    'alert.disk': '🔴 <b>Мало места на сервере: свободно {percent}%</b> ({free} ГБ).\nПора чистить старые файлы или увеличивать диск.',
    'alert.loginMail': '🔴 <b>Коды входа на сайт сотрудников не отправляются</b>\nОтвет почтового сервиса: {error}\nПроверьте resend.com → Domains (домен подтверждён?) и API Keys (ключ с правом отправки для jetmobility.org).',
    'alert.waUnreadable': '🟠 <b>Наблюдатель WhatsApp не смог прочитать сообщений из рабочей группы: {n}</b>. WhatsApp их не дослал. Чтобы журнал был полным, загрузите выгрузку чата: «Журнал → WhatsApp → Загрузить историю».',
    'alert.waDown': '🔴 <b>Наблюдатель WhatsApp не на связи</b> больше 15 минут — журнал рабочей группы не пополняется. Проверьте телефон с номером-наблюдателем (интернет, WhatsApp) и вкладку «Журнал → WhatsApp».',
    'alert.wabotDown': '🔴 <b>WhatsApp-бот для клиентов не на связи</b> больше 15 минут — клиентам в WhatsApp компании бот не отвечает. Проверьте телефон с номером компании (интернет, WhatsApp) и «Маркетинг → Офис → WhatsApp-бот».',
    // Тревога в рабочую группу: лампа на вкладке «Сервер» горит больше минуты
    'lamp.warning': '🔴 <b>Сервер: {name}</b> — авария уже больше минуты.\n{detail}',
    'lamp.caution': '🟡 <b>Сервер: {name}</b> — предупреждение уже больше минуты.\n{detail}',
    'lamp.ok': '✅ <b>Сервер: {name}</b> — снова в норме.',
    'lamp.n.disk': 'место на диске', 'lamp.n.cpu': 'процессор', 'lamp.n.memory': 'память', 'lamp.n.load': 'нагрузка',
    'lamp.n.response': 'скорость ответа', 'lamp.n.traffic': 'трафик', 'lamp.n.ws': 'Автопрокат', 'lamp.n.sheets': 'Google-таблица',
    'lamp.n.telegram': 'Telegram', 'lamp.n.mail': 'почта', 'lamp.n.whatsapp': 'наблюдатель WhatsApp', 'lamp.n.wabot': 'WhatsApp-бот',
    'lamp.d.disk': 'Свободно {percent}% ({free} ГБ).',
    'lamp.d.cpu': 'Процессор загружен на {v}%.',
    'lamp.d.memory': 'Занято {v}% памяти.',
    'lamp.d.load': 'Нагрузка {v} на ядро.',
    'lamp.d.response': 'Портал и сайт отвечают в среднем за {v} мс.',
    'lamp.d.traffic': 'Израсходовано {percent}% лимита {limit} ГБ, прогноз на месяц — {forecast} ГБ.',
    'lamp.d.ws': 'Нет свежих данных из Автопроката.',
    'lamp.d.sheets': 'Google-таблица не читается — работаем на последних данных.',
    'lamp.d.telegram': 'Telegram-бот не может писать в рабочую группу.',
    'lamp.d.mail': 'Письма с кодом входа не уходят.',
    'lamp.d.whatsapp': 'Журнал рабочей группы не пополняется. Проверьте телефон с номером-наблюдателем.',
    'lamp.d.wabot': 'Клиентам в WhatsApp бот не отвечает. Проверьте телефон бота и «Маркетинг → Офис → WhatsApp-бот».',
    'alert.first': '✅ <b>Оповещения о сервере включены</b> (версия {version}). Сюда придут сообщения о трафике, месте на диске и перезапусках бота.',
    'alert.updated': '✅ <b>Обновление установлено</b>: версия {version} (была {previous}). Бот работает.',
    'alert.rebooted': '🔄 <b>Сервер перезагрузился</b>, бот снова работает (версия {version}).',
    'alert.restarted': '⚠️ <b>Бот перезапустился</b> без обновления (версия {version}) — возможно, был сбой. Если повторится — смотрите журнал: docker compose logs bot'
  },
  en: {
    'card.title': '🆕 <b>Request #{id}</b>',
    'card.question': '💬 <b>Question #{id}</b> — a client asks to be contacted',
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
    'wa.takeHint': '👉 To take it, write “+{id}” (or just “+” if it is the only new request). Can’t — “-{id}”.',
    'wa.taken': '✅ {what} #{id} — {name}',
    'wa.pickOne': 'There are several new requests: {list}. Write “+number”, e.g. “+{first}”, or reply “+” to the card.',
    'wa.notFound': 'There is no request #{id}. New requests: {list}.',
    'wa.noneOpen': 'No new requests.',
    'wa.alreadyTaken': '{what} #{id} is already taken by {name}',
    'wa.takenElsewhere': '✅ {what} #{id} taken by {name} (in Telegram)',
    'word.requestAcc': 'Request', 'word.questionAcc': 'Question', 'word.request': 'Request', 'word.question': 'Question',
    'wa.clientWrote': '💬 #{id} {who}: {text}',
    'wa.mediaFailed': '⚠️ The attachment for #{id} could not be forwarded — ask the client to send it again.',
    'wa.media.photo': '📷 photo', 'wa.media.video': '🎬 video', 'wa.media.voice': '🎤 voice message',
    'wa.media.document': '📄 file', 'wa.media.sticker': 'sticker', 'wa.media.location': '📍 location',
    'wa.media.contact': '👤 contact', 'wa.media.other': 'attachment',
    'cmd.test': 'Test request',
    'cmd.summary': 'Summary: bookings and warnings',

    'sum.title': '☀️ <b>Good morning! {date}</b>',
    'sum.today': '<b>Today:</b> {pickups} · {returns}',
    'sum.pickups': { one: '{n} pickup', other: '{n} pickups' },
    'sum.returns': { one: '{n} return', other: '{n} returns' },
    'sum.ahead': '<b>Bookings ahead:</b> 7 days — {b7} ({v7}) · 30 days — {b30} ({v30})',
    'sum.vehicles': { one: '{n} vehicle', other: '{n} vehicles' },
    'sum.fleet': '<b>Fleet now:</b> {free} free · {rent} rented · {service} in service',
    'sum.none': '✅ <b>No warnings</b>',
    'sum.problems': '⚠️ <b>Warnings: {n}</b> — {counts}',
    'sum.more': '…and {n} more',
    'cat.sales': 'Sales', 'cat.it': 'IT', 'cat.marketing': 'Website', 'cat.service': 'Service',

    'alert.traffic70': '🟡 <b>Server traffic: {percent}% of the limit</b>\n{used} of {limit} GB used this month. Forecast to month end: {forecast} GB.',
    'alert.traffic90': '🔴 <b>Server traffic: {percent}% of the limit!</b>\n{used} of {limit} GB used this month. Forecast: {forecast} GB. Check the limit in the OVH control panel.',
    'alert.disk': '🔴 <b>Low disk space: {percent}% free</b> ({free} GB).\nTime to clean old files or enlarge the disk.',
    'alert.loginMail': '🔴 <b>Staff login codes are not being sent</b>\nMail service response: {error}\nCheck resend.com → Domains (is the domain verified?) and API Keys (sending access for jetmobility.org).',
    'alert.waUnreadable': '🟠 <b>The WhatsApp observer could not read {n} message(s) from the work group</b>, and WhatsApp did not re-send them. To keep the journal complete, upload a chat export: Journal → WhatsApp → Upload history.',
    'alert.waDown': '🔴 <b>WhatsApp observer offline</b> for more than 15 minutes — the work group journal is not updating. Check the observer phone (internet, WhatsApp) and Journal → WhatsApp.',
    'alert.wabotDown': '🔴 <b>The WhatsApp client bot is offline</b> for more than 15 minutes — clients writing to the company WhatsApp get no bot replies. Check the company phone (internet, WhatsApp) and Marketing → Office → WhatsApp bot.',
    'lamp.warning': '🔴 <b>Server: {name}</b> — failure for over a minute.\n{detail}',
    'lamp.caution': '🟡 <b>Server: {name}</b> — warning for over a minute.\n{detail}',
    'lamp.ok': '✅ <b>Server: {name}</b> — back to normal.',
    'lamp.n.disk': 'disk space', 'lamp.n.cpu': 'CPU', 'lamp.n.memory': 'memory', 'lamp.n.load': 'load',
    'lamp.n.response': 'response time', 'lamp.n.traffic': 'traffic', 'lamp.n.ws': 'Avtoprokat', 'lamp.n.sheets': 'Google sheet',
    'lamp.n.telegram': 'Telegram', 'lamp.n.mail': 'email', 'lamp.n.whatsapp': 'WhatsApp observer', 'lamp.n.wabot': 'WhatsApp bot',
    'lamp.d.disk': '{percent}% free ({free} GB).',
    'lamp.d.cpu': 'CPU at {v}%.',
    'lamp.d.memory': '{v}% of memory used.',
    'lamp.d.load': 'Load {v} per core.',
    'lamp.d.response': 'The portal and the site answer in {v} ms on average.',
    'lamp.d.traffic': '{percent}% of the {limit} GB limit used, forecast for the month — {forecast} GB.',
    'lamp.d.ws': 'No fresh data from Avtoprokat.',
    'lamp.d.sheets': 'The Google sheet cannot be read — working on the last data.',
    'lamp.d.telegram': 'The Telegram bot cannot post to the staff group.',
    'lamp.d.mail': 'Login code emails are not being sent.',
    'lamp.d.whatsapp': 'The work group journal is not updating. Check the observer phone.',
    'lamp.d.wabot': 'The WhatsApp bot does not answer clients. Check the bot phone and Marketing → Office → WhatsApp bot.',
    'alert.first': '✅ <b>Server alerts are on</b> (version {version}). Messages about traffic, disk space and bot restarts will come here.',
    'alert.updated': '✅ <b>Update installed</b>: version {version} (was {previous}). The bot is running.',
    'alert.rebooted': '🔄 <b>The server rebooted</b>, the bot is running again (version {version}).',
    'alert.restarted': '⚠️ <b>The bot restarted</b> without an update (version {version}) — possibly a crash. If it repeats, check the log: docker compose logs bot'
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
