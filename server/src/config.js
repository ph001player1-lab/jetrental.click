/**
 * Все настройки бота в одном месте. Секреты приходят только из переменных
 * окружения (на сервере — файл /opt/kokon/.env), в коде их нет.
 */

export const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://bot.jetrental.click').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || '/data',
  timezone: 'Asia/Bangkok',

  google: {
    // ID таблицы — из её адреса: docs.google.com/spreadsheets/d/<ID>/edit
    sheetId: process.env.GOOGLE_SHEET_ID || '',
    serviceAccountFile: process.env.GOOGLE_SA_FILE || '/run/secrets/google-sa.json',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    sheetsBase: (process.env.GOOGLE_SHEETS_BASE || 'https://sheets.googleapis.com/v4/spreadsheets').replace(/\/+$/, '')
  },

  // WS.Автопрокат — основная программа учёта (API-протокол разработчика).
  // Адрес и доступ — только в .env: WS_API_URL, WS_API_USER, WS_API_PASSWORD
  ws: {
    baseUrl: (process.env.WS_API_URL || '').replace(/\/+$/, ''),
    user: process.env.WS_API_USER || '',
    password: process.env.WS_API_PASSWORD || '',
    // Время выдачи/возврата по умолчанию, когда клиент назвал только даты
    rentTime: process.env.WS_RENT_TIME || '12:00',
    syncMinutes: Number(process.env.WS_SYNC_MINUTES) || 10
  },

  // WhatsApp через Kapso (официальный Cloud API Meta, режим coexistence)
  whatsapp: {
    apiKey: process.env.KAPSO_API_KEY || '',
    apiBase: (process.env.KAPSO_API_BASE || 'https://api.kapso.ai/meta/whatsapp/v24.0').replace(/\/+$/, ''),
    // ID номера в Kapso; если не задан — берём из входящих вебхуков
    phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID || '',
    webhookSecret: process.env.KAPSO_WEBHOOK_SECRET || '',
    // Тестовый режим: бот отвечает только этим номерам (через запятую). Пусто — всем.
    allowedNumbers: (process.env.WHATSAPP_ALLOWED_NUMBERS || '')
      .split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean),
    // Если менеджер сам написал клиенту из приложения — бот молчит в этом чате N часов
    pauseHours: Number(process.env.WHATSAPP_PAUSE_HOURS) || 12
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    // Можно жёстко задать группу сотрудников; иначе она привязывается командой /bind
    staffChatId: process.env.TELEGRAM_STAFF_CHAT_ID || ''
  }
};
