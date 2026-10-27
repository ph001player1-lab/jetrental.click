/**
 * Все настройки бота в одном месте. Секреты приходят только из переменных
 * окружения (на сервере — файл /opt/kokon/.env), в коде их нет.
 */

export const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://bot.jetrental.click').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || '/data',
  timezone: 'Asia/Bangkok',

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    // Можно жёстко задать группу сотрудников; иначе она привязывается командой /bind
    staffChatId: process.env.TELEGRAM_STAFF_CHAT_ID || ''
  }
};
