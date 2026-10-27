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

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    // Можно жёстко задать группу сотрудников; иначе она привязывается командой /bind
    staffChatId: process.env.TELEGRAM_STAFF_CHAT_ID || ''
  }
};
