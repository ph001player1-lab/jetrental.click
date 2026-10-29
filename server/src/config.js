/**
 * Все настройки бота в одном месте. Секреты приходят только из переменных
 * окружения (на сервере — файл /opt/kokon/.env), в коде их нет.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 'a.com, B.com' → ['a.com', 'b.com'] */
function hostList(value, fallback) {
  return String(value || fallback).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

const dataDir = process.env.DATA_DIR || '/data';

export const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://bot.jetrental.click').replace(/\/+$/, ''),
  dataDir,
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

  // Письма (коды входа на сайт сотрудников) через Resend
  mail: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    apiBase: (process.env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, ''),
    from: process.env.MAIL_FROM || 'JetRental Staff <noreply@jetrental.click>'
  },

  // Сайт сотрудников (staff.jetrental.click): вход по коду из письма
  staff: {
    url: (process.env.STAFF_URL || 'https://staff.jetrental.click').replace(/\/+$/, ''),
    // Вход по коду из письма действует неделю
    sessionDays: Number(process.env.STAFF_SESSION_DAYS) || 7,
    codeMinutes: 10,
    // Почты с доступом помимо листа Users (через запятую) — на случай, если таблица недоступна
    extraEmails: (process.env.STAFF_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  },

  // Публичный сайт: страницы собирает сервер (site/), картинки, стили и
  // скрипты отдаёт Caddy из папки web/site. Бренд выбирается по домену.
  site: {
    dir: process.env.SITE_DIR || fileURLToPath(new URL('../../web/site/', import.meta.url)),
    // Фото, загруженные через сайт сотрудников (отдаёт Caddy по адресу /uploads/…)
    uploadsDir: process.env.UPLOADS_DIR || path.join(dataDir, 'uploads'),
    jetrentalHosts: hostList(process.env.JETRENTAL_HOSTS, 'jetrental.click,www.jetrental.click'),
    kokonHosts: hostList(process.env.KOKON_HOSTS, 'www.kokoncar.com,kokoncar.com'),
    // Тестовая копия KokonCar до переезда домена — закрыта от поисковиков
    kokonPreviewHosts: hostList(process.env.KOKON_PREVIEW_HOSTS, 'kokon.jetrental.click'),
    // Дизайн kokoncar.com после переезда: classic (как на Wix) или modern
    kokonTheme: process.env.KOKON_THEME === 'modern' ? 'modern' : 'classic',
    // Коды подтверждения Яндекс.Вебмастера / Google Search Console (через запятую)
    yandexVerification: (process.env.YANDEX_VERIFICATION || '').split(',').map((s) => s.trim()).filter(Boolean),
    googleVerification: (process.env.GOOGLE_VERIFICATION || '').split(',').map((s) => s.trim()).filter(Boolean)
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    // Можно жёстко задать группу сотрудников; иначе она привязывается командой /bind
    staffChatId: process.env.TELEGRAM_STAFF_CHAT_ID || '',
    // Язык рабочей группы: ru (по умолчанию) или en
    groupLang: (process.env.STAFF_GROUP_LANG || 'ru').toLowerCase()
  }
};
