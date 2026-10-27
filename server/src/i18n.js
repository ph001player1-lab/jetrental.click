/**
 * ============================================================================
 * Тексты для клиентов на 4 языках: английский, русский, тайский, китайский
 * ============================================================================
 * t(lang, key, params) — подставляет {параметры}. Сотрудники всегда видят
 * заявки по-русски; язык клиента в карточке заявки помечен.
 * ============================================================================
 */

export const LANGUAGES = {
  en: { title: '🇬🇧 English', short: 'EN' },
  ru: { title: '🇷🇺 Русский', short: 'RU' },
  th: { title: '🇹🇭 ไทย', short: 'TH' },
  zh: { title: '🇨🇳 中文', short: 'ZH' }
};

export const DEFAULT_LANGUAGE = 'en';

/** Вопрос о языке сразу на всех языках — до выбора мы не знаем, на каком писать */
export const LANGUAGE_PROMPT = '🌐 Please choose your language\nВыберите язык\nกรุณาเลือกภาษา\n请选择语言';
export const LANGUAGE_LIST_BUTTON = 'Language / Язык';

const TEXTS = {
  // Описания команд в меню Telegram
  cmd_start: { en: 'New rental request', ru: 'Новая заявка на аренду', th: 'คำขอเช่าใหม่', zh: '新的租车申请' },
  cmd_lang: { en: 'Change language', ru: 'Сменить язык', th: 'เปลี่ยนภาษา', zh: '更换语言' },
  greeting: {
    en: 'Hello! 👋 I\'ll help you find a vehicle to rent.\n\nWhat would you like to rent?',
    ru: 'Здравствуйте! 👋 Помогу подобрать технику в аренду.\n\nЧто хотите арендовать?',
    th: 'สวัสดีค่ะ! 👋 เราช่วยคุณเลือกรถเช่าได้\n\nต้องการเช่าอะไรคะ?',
    zh: '您好！👋 我来帮您挑选租赁车辆。\n\n您想租什么？'
  },
  type_scooter: { en: '🛵 Scooter', ru: '🛵 Скутер', th: '🛵 สกู๊ตเตอร์', zh: '🛵 踏板车' },
  type_motorcycle: { en: '🏍 Motorcycle', ru: '🏍 Мотоцикл', th: '🏍 มอเตอร์ไซค์', zh: '🏍 摩托车' },
  type_car: { en: '🚗 Car', ru: '🚗 Автомобиль', th: '🚗 รถยนต์', zh: '🚗 汽车' },
  ask_dates: {
    en: '📅 Which dates? Write for example: {example} (day.month)',
    ru: '📅 На какие даты? Напишите, например: {example}',
    th: '📅 ต้องการเช่าวันที่เท่าไหร่คะ? พิมพ์ เช่น {example} (วัน.เดือน)',
    zh: '📅 租用日期是？请这样输入：{example}（日.月）'
  },
  date_format: {
    en: 'Sorry, I couldn\'t read the dates 🙏 Please write two dates, e.g. {example}',
    ru: 'Не понял даты 🙏 Напишите две даты, например: {example}',
    th: 'ขออภัย อ่านวันที่ไม่ออก 🙏 กรุณาพิมพ์สองวันที่ เช่น {example}',
    zh: '抱歉，没看懂日期 🙏 请输入两个日期，例如：{example}'
  },
  date_invalid: {
    en: 'That date doesn\'t exist 🙂 Please check it.',
    ru: 'Такой даты нет в календаре 🙂 Проверьте, пожалуйста.',
    th: 'ไม่มีวันที่นี้ในปฏิทิน 🙂 กรุณาตรวจสอบอีกครั้ง',
    zh: '日历中没有这个日期 🙂 请检查一下。'
  },
  date_past: {
    en: 'That date has already passed. Please choose dates from today onwards.',
    ru: 'Эта дата уже прошла. Напишите даты, начиная с сегодняшнего дня.',
    th: 'วันที่นี้ผ่านไปแล้ว กรุณาเลือกวันที่ตั้งแต่วันนี้เป็นต้นไป',
    zh: '这个日期已经过去了，请选择今天或之后的日期。'
  },
  date_order: {
    en: 'The return date must be after the start date.',
    ru: 'Дата возврата должна быть позже даты начала аренды.',
    th: 'วันคืนรถต้องอยู่หลังวันเริ่มเช่า',
    zh: '还车日期必须晚于开始日期。'
  },
  date_too_long: {
    en: 'That\'s more than a year — please choose a shorter period.',
    ru: 'Срок больше года — напишите, пожалуйста, даты покороче.',
    th: 'ระยะเวลาเกินหนึ่งปี กรุณาเลือกช่วงที่สั้นลง',
    zh: '超过一年了，请选择更短的租期。'
  },
  available: {
    en: '✅ Available for {period} ({days} days):',
    ru: '✅ Свободно на {period} ({days} дн.):',
    th: '✅ ว่างช่วง {period} ({days} วัน):',
    zh: '✅ {period}（{days}天）可租车辆：'
  },
  choose_model: { en: 'Choose a model 👇', ru: 'Выберите модель 👇', th: 'เลือกรุ่นได้เลยค่ะ 👇', zh: '请选择车型 👇' },
  model_list_button: { en: 'Choose model', ru: 'Выбрать модель', th: 'เลือกรุ่น', zh: '选择车型' },
  help_choose: { en: '🤷 Help me choose', ru: '🤷 Помогите выбрать', th: '🤷 ช่วยแนะนำ', zh: '🤷 帮我挑选' },
  price_total: {
    en: '{perDay}/day, ≈ {total}',
    ru: '{perDay}/день, ≈ {total}',
    th: '{perDay}/วัน, ≈ {total}',
    zh: '{perDay}/天，约 {total}'
  },
  price_from: { en: 'from {perDay}/day', ru: 'от {perDay}/день', th: 'เริ่มต้น {perDay}/วัน', zh: '{perDay}/天起' },
  price_unknown: {
    en: 'price on request',
    ru: 'цену уточнит менеджер',
    th: 'สอบถามราคากับเจ้าหน้าที่',
    zh: '价格请咨询客服'
  },
  none_available: {
    en: '😔 Nothing of this type is available for {period}. A manager will suggest options.',
    ru: '😔 На {period} свободной техники этого типа не нашлось. Менеджер предложит варианты.',
    th: '😔 ช่วง {period} ไม่มีรถประเภทนี้ว่าง เจ้าหน้าที่จะแนะนำตัวเลือกอื่นให้ค่ะ',
    zh: '😔 {period} 期间该类车辆已租满，客服会为您推荐其他选择。'
  },
  ask_phone: {
    en: '📱 Please share your phone number (WhatsApp preferred): tap the button below or type it.',
    ru: '📱 Оставьте номер телефона (лучше WhatsApp): нажмите кнопку ниже или напишите номер.',
    th: '📱 กรุณาแจ้งเบอร์โทร (WhatsApp จะดีที่สุด): กดปุ่มด้านล่างหรือพิมพ์เบอร์',
    zh: '📱 请留下您的电话（最好是 WhatsApp）：点击下方按钮或直接输入号码。'
  },
  phone_button: { en: '📱 Share my number', ru: '📱 Отправить мой номер', th: '📱 ส่งเบอร์ของฉัน', zh: '📱 发送我的号码' },
  you_chose: { en: 'You chose: {what}', ru: 'Вы выбрали: {what}', th: 'คุณเลือก: {what}', zh: '您选择了：{what}' },
  help_ok: {
    en: 'Sure, a manager will help you choose 👌',
    ru: 'Хорошо, менеджер поможет подобрать 👌',
    th: 'ได้เลยค่ะ เจ้าหน้าที่จะช่วยแนะนำ 👌',
    zh: '好的，客服会帮您挑选 👌'
  },
  request_title: {
    en: 'Request #{id} received!',
    ru: 'Заявка #{id} принята!',
    th: 'ได้รับคำขอ #{id} แล้ว!',
    zh: '已收到申请 #{id}！'
  },
  request_summary: {
    en: '{what}, {period} ({days} days)',
    ru: '{what}, {period} ({days} дн.)',
    th: '{what}, {period} ({days} วัน)',
    zh: '{what}，{period}（{days}天）'
  },
  request_next: {
    en: 'A manager will contact you shortly to confirm the booking. New request: {restart}',
    ru: 'Менеджер скоро свяжется с вами и подтвердит бронь. Новая заявка: {restart}',
    th: 'เจ้าหน้าที่จะติดต่อกลับเพื่อยืนยันการจองเร็วๆ นี้ค่ะ คำขอใหม่: {restart}',
    zh: '客服会尽快联系您确认预订。新申请：{restart}'
  },
  restart_whatsapp: { en: 'type “menu”', ru: 'напишите «меню»', th: 'พิมพ์ “menu”', zh: '输入“menu”' },
  choose_please: {
    en: 'Please choose an option 👇',
    ru: 'Выберите, пожалуйста, вариант 👇',
    th: 'กรุณาเลือกตัวเลือกด้านล่างค่ะ 👇',
    zh: '请选择一个选项 👇'
  },
  choose_model_above: {
    en: 'Please choose a model from the list above 👆 or tap “Help me choose”.',
    ru: 'Выберите модель в списке выше 👆 или нажмите «Помогите выбрать».',
    th: 'กรุณาเลือกรุ่นจากรายการด้านบน 👆 หรือกด “ช่วยแนะนำ”',
    zh: '请在上方列表中选择车型 👆，或点击“帮我挑选”。'
  },
  media_unsupported: {
    en: 'For now I understand only text and buttons 🙏 Please type a message or write “menu”.',
    ru: 'Пока я понимаю только текст и кнопки 🙏 Напишите, пожалуйста, сообщением или напишите «меню».',
    th: 'ตอนนี้บอทเข้าใจเฉพาะข้อความและปุ่มค่ะ 🙏 กรุณาพิมพ์ข้อความ หรือพิมพ์ “menu”',
    zh: '目前我只能识别文字和按钮 🙏 请发送文字消息，或输入“menu”。'
  },
  manager_taken: {
    en: '👋 Manager {name} is handling your request #{id}. We\'ll contact you soon!',
    ru: '👋 Вашей заявкой #{id} занимается менеджер {name}. Скоро свяжемся с вами!',
    th: '👋 เจ้าหน้าที่ {name} กำลังดูแลคำขอ #{id} ของคุณ จะติดต่อกลับเร็วๆ นี้ค่ะ',
    zh: '👋 客服 {name} 正在处理您的申请 #{id}，我们会尽快联系您！'
  }
};

export function normalizeLanguage(lang) {
  return LANGUAGES[lang] ? lang : DEFAULT_LANGUAGE;
}

export function t(lang, key, params = {}) {
  const entry = TEXTS[key];
  if (!entry) return key;
  const template = entry[normalizeLanguage(lang)] ?? entry[DEFAULT_LANGUAGE];
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}
