/**
 * ============================================================================
 * Jet Mobility Staff — сайт сотрудников
 * ============================================================================
 * Экраны: вход (почта → код) и вкладки: Overview, Fleet, Journal (рабочая
 * группа WhatsApp — journal.js), Calendar, Requests, Website (фото и описания
 * моделей для сайта — менять могут роли Editor/Admin) и Server (нагрузка и
 * трафик сервера — только Admin, рисует cockpit.js).
 * Роль (Admin / Editor / Viewer) и её права приходят с сервера в /api/staff/me.
 * Данные: GET /api/staff/fleet (снимок Автопроката, обновляется на сервере
 * раз в 10 минут), GET /api/staff/requests, GET /api/staff/models.
 * Время показываем по Бангкоку. Языки: английский, русский, тайский, бирманский
 * (тексты — i18n.js; по умолчанию язык браузера, иначе английский).
 * ============================================================================
 */
(() => {
  'use strict';

  const API = '/api/staff';
  const TZ = 'Asia/Bangkok';
  const TZ_OFFSET_MS = 7 * 3600 * 1000; // Таиланд без перехода на летнее время
  const DAY_MS = 86400000;
  const REFRESH_MS = 2 * 60 * 1000;
  // Приборы вкладки «Сервер» — каждые 10 секунд, пока она открыта
  const SERVER_REFRESH_MS = 10 * 1000;

  /* ---------------------------------------------------------------- Языки */

  const I18N = window.STAFF_I18N;
  const LANG_KEY = 'jr_staff_lang';
  const LANG_NAMES = { en: 'English', ru: 'Русский', th: 'ไทย', my: 'မြန်မာ' };
  const LANG_SHORT = { en: 'EN', ru: 'RU', th: 'ไทย', my: 'MY' };
  // Тайская локаль — с обычным календарём (по умолчанию в ней буддийский год);
  // бирманская — с привычными цифрами 0–9 (по умолчанию в ней бирманские ၀–၉)
  const LOCALES = { en: 'en-GB', ru: 'ru-RU', th: 'th-TH-u-ca-gregory', my: 'my-MM-u-nu-latn' };

  /** Язык: выбранный раньше → язык браузера (если он из трёх) → английский */
  function detectLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (I18N[saved]) return saved;
    } catch { /* хранилище недоступно */ }
    for (const code of navigator.languages || [navigator.language || '']) {
      const short = String(code).toLowerCase().slice(0, 2);
      if (I18N[short]) return short;
    }
    return 'en';
  }

  let lang = detectLang();

  /** Текст по ключу; {name} заменяются значениями params (без экранирования) */
  function t(key, params = {}) {
    const text = I18N[lang][key] ?? I18N.en[key] ?? key;
    return String(text).replace(/\{(\w+)\}/g, (m, name) => (name in params ? params[name] : m));
  }

  /** Число с нужной формой слова: tn('n.days', 3) → «3 дня» */
  function tn(key, n) {
    const forms = I18N[lang][key] || I18N.en[key];
    return (forms[new Intl.PluralRules(LOCALES[lang]).select(n)] || forms.other).replace('{n}', n);
  }

  /** Подписи, которые читаются на текущем языке при каждом обращении */
  const labels = (prefix, keys) => Object.defineProperties({}, Object.fromEntries(
    keys.map((key) => [key, { enumerable: true, get: () => t(`${prefix}.${key}`) }])));

  const TYPES = labels('types', ['scooter', 'motorcycle', 'car']);
  const TYPE_ONE = labels('type', ['scooter', 'motorcycle', 'car']);
  const STATUS = labels('status', ['free', 'rent', 'reserve', 'service']);
  const CHANNELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', get site() { return t('channel.site'); }, get agent() { return t('channel.agent'); } };
  const LANGS = { en: '🇬🇧 EN', ru: '🇷🇺 RU', th: '🇹🇭 TH', zh: '🇨🇳 ZH' };
  const ERRORS = labels('err', [
    'invalid_email', 'invalid_code', 'too_many_attempts', 'wait_a_minute', 'too_many_codes', 'too_many_requests',
    'mail_not_configured', 'mail_failed', 'no_access', 'read_only', 'model_not_found', 'bad_image', 'image_required',
    'too_many_uploads', 'body_too_large', 'unknown_photo', 'too_many_photos', 'sheets_not_configured',
    'admin_only', 'invalid_settings', 'no_section_access'
  ]);

  const ICONS = {
    overview: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
    fleet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.92 6.01A1.5 1.5 0 0 0 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8l-2.08-5.99zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11H5z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM7 12h5v5H7z"/></svg>',
    requests: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>',
    site: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>',
    server: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 4a10 10 0 0 0-8.66 15h17.32A10 10 0 0 0 12 4zm0 2a8 8 0 0 1 7.42 11H4.58A8 8 0 0 1 12 6zm-1 1.5v2h2v-2h-2zM6.4 9.2 5 10.6l1.4 1.4 1.4-1.4-1.4-1.4zm11.2 0-4.47 4.47a2 2 0 1 0 1.41 1.41L19 10.6l-1.4-1.4z"/></svg>'
  };
  ICONS.journal = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/></svg>';
  ICONS.install = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 1H7a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2zm0 18H7V5h10v14zm-4-7V7h-2v5H8l4 4 4-4h-3z"/></svg>';
  // Значок «Поделиться» Safari — для подсказки на iPhone
  const SHARE_ICON = '<svg class="install__share" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 7.5 6.5l1.4 1.4L11 5.8V15h2V5.8l2.1 2.1 1.4-1.4L12 2zM5 10v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10h-3v2h1v8H7v-8h1v-2H5z"/></svg>';
  ICONS.more = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
  ICONS.access = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm5.4 10.4A7.06 7.06 0 0 1 12 20.9a7.06 7.06 0 0 1-5.4-3.5c.03-1.8 3.6-2.8 5.4-2.8s5.37 1 5.4 2.8z"/></svg>';
  ICONS.finance = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>';
  ICONS.crm = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
  ICONS.marketing = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"/></svg>';
  ICONS.price = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.41 11.58l-9-9A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7A1.5 1.5 0 1 1 7 5.5 1.5 1.5 0 0 1 5.5 7z"/></svg>';
  // «Ошибки и предложения» — жук; значок вкладки цветной, чтобы был заметнее других (staff.css)
  ICONS.tickets = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 8h-2.81a5.98 5.98 0 0 0-1.82-1.96L17 4.41 15.59 3l-2.17 2.17a6.02 6.02 0 0 0-2.83 0L8.41 3 7 4.41l1.62 1.63A5.98 5.98 0 0 0 6.81 8H4v2h2.09A6.3 6.3 0 0 0 6 11v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81A5.99 5.99 0 0 0 12 21a5.99 5.99 0 0 0 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>';
  ICONS.cabinet = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 6h-4V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 0h-4V4h4v2z"/></svg>';
  // «Кабинет» — первым: у агента это главная вкладка
  // «Сайт» (фото и описания моделей) переехал в карточку техники во вкладке «Парк»
  const ALL_TABS = ['cabinet', 'overview', 'fleet', 'price', 'journal', 'calendar', 'requests', 'crm', 'marketing', 'finance', 'server', 'access', 'tickets'];
  // Внизу на телефоне помещается 6 кнопок; если вкладок больше — последние уходят в «Ещё»
  const BOTTOM_MAX = 6;
  // Вкладка видна, если у роли есть хотя бы одно из этих прав (настраивает админ на вкладке «Доступы»)
  const TAB_PERMISSION = {
    overview: ['overview.view'], fleet: ['fleet.view'], price: ['price.view'], calendar: ['calendar.view'], requests: ['requests.view'],
    journal: ['journal.view', 'timesheet.view', 'reconcile.view', 'whatsapp.view'],
    crm: ['crm.view'], marketing: ['marketing.view'], finance: ['finance.view'], site: ['site.view'], server: ['server.view'], access: ['access.admin'],
    tickets: ['tickets.view'],
    // «Кабинет» — по привязке к источнику агента (не по роли) или просмотр из «Маркетинга»
    cabinet: []
  };
  const can = (perm) => Boolean(state.user?.permissions?.includes(perm));
  /** Вкладки, доступные роли вошедшего сотрудника */
  const cabinetVisible = () => Boolean(state.user?.sourceId || state.cabinetPreview);
  const tabs = () => ALL_TABS.filter((id) => (id === 'cabinet' ? cabinetVisible() : TAB_PERMISSION[id].some(can)))
    .map((id) => ({ id, title: t(`tab.${id}`) }));

  const state = {
    user: null,
    fleet: null,
    requests: [],
    tab: 'overview',
    filters: { q: '', type: 'all', status: 'all' },
    calDays: 14,
    reqFilter: 'all',
    expanded: new Set(),
    loginEmail: '',
    timer: null,
    // Вкладка Website: модели из листа Catalog и правка одной модели
    models: null,
    canEdit: false,
    editing: null,
    // Обзор: проблемы и брони впереди (считает сервер)
    dashboard: null,
    dashboardFailed: false,
    offline: false,
    problemCat: 'all',
    openCats: new Set(),
    // Вкладка «Сервер» (Admin)
    server: null,
    serverFailed: false,
    serverTimer: null,
    serverStatus: null,
    // Меню «Ещё» внизу на телефоне
    moreOpen: false,
    // Плашка «Установить на телефон»: показать подсказку, как установить вручную
    installHelp: false
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ------------------------------------------------------------------ API */

  async function api(path, options = {}) {
    const init = { credentials: 'same-origin', headers: {} };
    if (options.body) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    } else if (options.method) {
      init.method = options.method;
      if (options.method === 'POST') {
        init.headers['Content-Type'] = 'application/json';
        init.body = '{}';
      }
    }
    const response = await fetch(API + path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.error || `HTTP ${response.status}`);
      err.status = response.status;
      err.code = data.error;
      throw err;
    }
    return data;
  }

  /* -------------------------------------------------------------- Форматы */

  let fmtDateTime, fmtTime, fmtDay, fmtWeekday;
  /** Форматы дат на текущем языке */
  function setFormats() {
    const locale = LOCALES[lang];
    fmtDateTime = new Intl.DateTimeFormat(locale, { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmtTime = new Intl.DateTimeFormat(locale, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmtDay = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: '2-digit', month: 'short' });
    fmtWeekday = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' });
  }
  setFormats();
  const fmtMoney = new Intl.NumberFormat('en-US');

  const dateTime = (iso) => (iso ? fmtDateTime.format(new Date(iso)) : '—');
  const money = (n) => (n ? `${fmtMoney.format(n)} ฿` : '—');
  /** '2026-11-05' → '05 Nov' */
  const shortDate = (isoDate) => (isoDate ? fmtDay.format(new Date(`${isoDate}T00:00:00Z`)) : '—');
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

  /** Начало сегодняшнего дня по Бангкоку (мс UTC) */
  function bangkokDayStart(ms = Date.now()) {
    return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
  }

  /**
   * Меньше суток — «через 5 ч»; дальше «завтра», «послезавтра», «через 4 дня» — дни
   * по календарю Бангкока, как считают люди: 01.11 при сегодняшнем 30.10 — «послезавтра»
   */
  function relative(iso) {
    const at = Date.parse(iso);
    const now = Date.now();
    const hours = Math.round((at - now) / 3600000);
    if (Math.abs(hours) < 1) return t('rel.withinHour');
    const days = Math.round((bangkokDayStart(at) - bangkokDayStart(now)) / DAY_MS);
    // Меньше суток — в часах («через 20 ч»), дальше — «завтра», «послезавтра», «через N дней»
    if (Math.abs(at - now) < DAY_MS) return hours > 0 ? t('rel.inHours', { n: hours }) : t('rel.hoursAgo', { n: -hours });
    if (days === 1) return t('rel.tomorrow');
    if (days === 2) return t('rel.dayAfter');
    if (days === -1) return t('rel.yesterday');
    if (days === -2) return t('rel.dayBefore');
    return t(days > 0 ? 'rel.in' : 'rel.ago', { days: tn('n.days', Math.abs(days)) });
  }

  const loadingBox = () => `<div class="empty">${esc(t('app.loading'))}</div>`;
  const nothingFound = () => `<div class="empty">${esc(t('empty.nothing'))}</div>`;

  /* ------------------------------------------------------ Выбор языка */

  /** Переключатели языка: в шапке коротко (EN · RU · ไทย), в подвале — полными названиями */
  function renderLangSwitches() {
    document.querySelectorAll('[data-langs]').forEach((box) => {
      const full = box.dataset.langs === 'full';
      box.setAttribute('aria-label', t('lang.label'));
      box.innerHTML = `${full ? `<span class="langs__label">🌐 ${esc(t('lang.label'))}:</span>` : ''}${Object.keys(LANG_NAMES).map((code) => `
        <button type="button" data-lang="${code}" lang="${code}" aria-pressed="${code === lang}"${full ? '' : ` title="${esc(LANG_NAMES[code])}"`}>${esc(full ? LANG_NAMES[code] : LANG_SHORT[code])}</button>`).join('')}`;
    });
  }

  /** Тексты из index.html: data-i18n — текст, data-i18n-ph — подсказка в поле, data-i18n-aria — подпись кнопки */
  function applyStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
      if (el.hasAttribute('title')) el.title = t(el.dataset.i18nAria);
    });
    renderLangSwitches();
  }

  function setLang(code) {
    if (!I18N[code] || code === lang) return;
    lang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch { /* хранилище недоступно */ }
    setFormats();
    applyStatic();
    if (!$('#code-form').hidden) renderCodeLead();
    resendText();
    if (state.user) {
      render();
      if (state.editing) renderGallery();
      // Тексты проблем собирает сервер — берём их на новом языке
      loadData();
    }
  }

  /* ----------------------------------------------------------------- Вход */

  function showLogin(step = 'email', error = '') {
    clearInterval(state.timer);
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#email-form').hidden = step !== 'email';
    $('#code-form').hidden = step !== 'code';
    setLoginError(error);
    if (step === 'email') $('#email').focus();
    if (step === 'code') {
      renderCodeLead();
      $('#code').value = '';
      $('#code').focus();
      startResendTimer();
    }
  }

  /** «Если у {email} есть доступ…» — почта жирным */
  function renderCodeLead() {
    const lead = $('#code-lead');
    const [before, after = ''] = t('login.checkLead').split('{email}');
    const email = document.createElement('b');
    email.textContent = state.loginEmail;
    lead.replaceChildren(before, email, after);
  }

  function setLoginError(message) {
    $('#login-error').hidden = !message;
    $('#login-error').textContent = message || '';
  }

  let resendLeft = 0;
  let resendTimer = null;
  const resendText = () => ($('#resend').textContent = resendLeft > 0 ? t('login.resendIn', { n: resendLeft }) : t('login.resend'));

  function startResendTimer() {
    const button = $('#resend');
    clearInterval(resendTimer);
    resendLeft = 60;
    button.disabled = true;
    resendText();
    resendTimer = setInterval(() => {
      resendLeft -= 1;
      if (resendLeft <= 0) {
        clearInterval(resendTimer);
        button.disabled = false;
      }
      resendText();
    }, 1000);
  }

  async function requestCode(email) {
    state.loginEmail = email.trim().toLowerCase();
    await api('/login', { body: { email: state.loginEmail, lang } });
    savePending(state.loginEmail);
  }

  // Отправленный код помним 10 минут: ярлык на телефоне может перезагрузить
  // страницу, пока сотрудник смотрит письмо, — тогда сразу открываем ввод кода
  const PENDING_KEY = 'jr_staff_pending_login';
  const PENDING_MS = 10 * 60 * 1000;

  function savePending(email) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ email, at: Date.now() })); } catch { /* хранилище недоступно */ }
  }

  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch { /* хранилище недоступно */ }
  }

  function pendingEmail() {
    try {
      const saved = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
      if (saved?.email && Date.now() - saved.at < PENDING_MS) return saved.email;
    } catch { /* хранилище недоступно */ }
    clearPending();
    return '';
  }

  function withBusy(form, fn) {
    return async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      setLoginError('');
      try {
        await fn();
      } catch (err) {
        setLoginError(ERRORS[err.code] || t('login.failed'));
      } finally {
        button.disabled = false;
      }
    };
  }

  function bindLogin() {
    const emailForm = $('#email-form');
    emailForm.addEventListener('submit', withBusy(emailForm, async () => {
      const email = $('#email').value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw Object.assign(new Error(), { code: 'invalid_email' });
      await requestCode(email);
      showLogin('code');
    }));

    const codeForm = $('#code-form');
    codeForm.addEventListener('submit', withBusy(codeForm, async () => {
      const code = $('#code').value.replace(/\D/g, '');
      if (code.length !== 6) throw Object.assign(new Error(), { code: 'invalid_code' });
      const data = await api('/verify', { body: { email: state.loginEmail, code } });
      clearPending();
      state.user = data.user;
      startApp();
    }));

    $('#code').addEventListener('input', (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
      e.target.value = digits;
      if (digits.length === 6) codeForm.requestSubmit();
    });

    $('#resend').addEventListener('click', async () => {
      try {
        await requestCode(state.loginEmail);
        setLoginError('');
        startResendTimer();
      } catch (err) {
        setLoginError(ERRORS[err.code] || t('login.resendFailed'));
      }
    });
    $('#change-email').addEventListener('click', () => { clearPending(); showLogin('email'); });
  }

  /* ----------------------------------------------------------- Приложение */

  function startApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    renderWho();
    const fromHash = location.hash.slice(1);
    if (tabs().some((tab) => tab.id === fromHash)) state.tab = fromHash;
    if (!tabs().some((tab) => tab.id === state.tab)) state.tab = tabs()[0]?.id || 'overview';
    renderTabs();
    render();
    loadData();
    if (state.tab === 'site') loadModels();
    if (state.tab === 'server') startServerPolling();
    if (state.tab === 'journal') journal.show();
    if (state.tab === 'access') access.load();
    if (state.tab === 'finance') finance.load();
    if (state.tab === 'crm') crm.load();
    if (state.tab === 'marketing') marketing.load();
    if (state.tab === 'price') price.load();
    if (state.tab === 'tickets') tickets.load();
    if (state.tab === 'cabinet') cabinet.load();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) loadData(); }, REFRESH_MS);
    loadServerAlert();
    loadTicketsBadge();
    clearInterval(state.alertTimer);
    state.alertTimer = setInterval(() => { loadServerAlert(); loadTicketsBadge(); }, 30 * 1000);
  }

  async function loadData() {
    try {
      // Загружаем только то, что роли разрешено видеть
      const empty = (value) => Promise.resolve(value);
      const [fleet, requests, dashboard] = await Promise.all([
        can('fleet.view') || can('calendar.view') || can('overview.view') ? api('/fleet') : empty({ cars: [], group: {} }),
        can('requests.view') || can('overview.view') ? api('/requests') : empty({ requests: [] }),
        // Без проблем и прогноза обзор всё равно покажем
        can('overview.view') ? api(`/dashboard?lang=${lang}`).catch((err) => (err.status === 401 ? Promise.reject(err) : null)) : empty(null)
      ]);
      state.fleet = fleet;
      state.requests = requests.requests || [];
      state.canManageRequests = Boolean(requests.canManage);
      if (dashboard) state.dashboard = dashboard;
      state.dashboardFailed = !dashboard;
      state.offline = false;
      showDataError(fleet.error ? t('app.syncProblem', { error: fleet.error }) : '');
      render();
    } catch (err) {
      if (err.status === 401) return showLogin('email', err.code === 'no_access' ? ERRORS.no_access : '');
      // Связи с сервером нет — это проблема IT, показываем её в окне «Проблемы»
      state.offline = true;
      showDataError(t('app.loadFailed'));
      render();
    }
  }

  function showDataError(message) {
    $('#data-error').hidden = !message;
    $('#data-error').textContent = message;
  }

  function newRequestsCount() {
    return state.requests.filter((r) => r.status === 'new' && !r.archived).length;
  }

  /** Имя и роль в строке состояния: «Николай · Админ» */
  function renderWho() {
    const user = state.user;
    if (!user) return;
    const role = user.role === 'admin' ? 'admin' : 'staff';
    const name = user.role === 'admin' ? t('role.admin') : user.roleName || t('role.viewer');
    $('#who').innerHTML = `${esc(user.name || user.email)} <span class="role role--${role}">${esc(name)}</span>`;
  }

  /**
   * Вкладки сверху: подписи у всех, если помещаются; иначе подпись только у открытой;
   * если тесно и так — одни значки (название — во всплывающей подсказке)
   */
  function fitTopTabs() {
    const top = document.querySelector('.tabs--top');
    const bar = top?.closest('.topbar');
    if (!bar || getComputedStyle(top).display === 'none') return;
    const right = bar.querySelector('.topbar__right');
    const brand = bar.querySelector('.brand');
    const fits = () => {
      const last = top.lastElementChild?.getBoundingClientRect();
      const first = top.firstElementChild?.getBoundingClientRect();
      return bar.scrollWidth <= bar.clientWidth + 1 && top.scrollWidth <= top.clientWidth + 1
        && (!last || !right || last.right <= right.getBoundingClientRect().left - 6)
        && (!first || !brand || brand.getBoundingClientRect().right <= first.left - 6);
    };
    top.classList.remove('tabs--compact', 'tabs--icons');
    if (fits()) return;
    top.classList.add('tabs--compact');
    if (!fits()) top.classList.add('tabs--icons');
  }
  let fitTimer = null;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTopTabs, 100); });
  document.fonts?.ready?.then(() => fitTopTabs());

  /** Значок на вкладке «Сервер»: красный — авария, жёлтый — предупреждение */
  function serverDot() {
    const a = state.serverAlert;
    if (!a || (!a.warning && !a.caution)) return '';
    const label = t(a.warning ? 'tab.alertWarning' : 'tab.alertCaution');
    return `<span class="tab-alert tab-alert--${a.warning ? 'warning' : 'caution'}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></span>`;
  }

  /** Состояние ламп сервера — раз в 30 секунд (значок виден на любой вкладке) */
  async function loadServerAlert() {
    if (!can('server.view') || document.hidden) return;
    try {
      const s = await api('/server/status');
      const changed = JSON.stringify(state.serverAlert) !== JSON.stringify({ warning: s.warning, caution: s.caution });
      state.serverAlert = { warning: s.warning, caution: s.caution };
      if (changed) renderTabs();
    } catch { /* нет связи — значок не трогаем */ }
  }

  /** Число на вкладке «Ошибки и предложения»: новые тикеты (разбирающим) или новые ответы (автору) */
  function ticketsCount() {
    const n = state.ticketsBadge?.count || 0;
    if (!n) return '';
    const label = t(state.ticketsBadge.handler ? 'tk.badgeNew' : 'tk.badgeAnswers');
    return `<span class="count count--tickets" title="${esc(label)}" aria-label="${esc(`${label}: ${n}`)}">${n}</span>`;
  }

  /** Счётчик тикетов — раз в 30 секунд вместе с лампами сервера */
  async function loadTicketsBadge() {
    if (!can('tickets.view') || document.hidden) return;
    try {
      const b = await api('/tickets/badge');
      setTicketsBadge(b.count, b.handler);
    } catch { /* нет связи — счётчик не трогаем */ }
  }

  function setTicketsBadge(count, handler) {
    const was = state.ticketsBadge?.count;
    state.ticketsBadge = { count, handler };
    if (was === count) return;
    renderTabs();
    // Разбирающему пришёл новый тикет, пока вкладка открыта — обновляем список
    if (handler && was !== undefined && state.tab === 'tickets' && tickets.canRefresh()) tickets.load();
  }

  function renderTabs() {
    const count = newRequestsCount();
    const list = tabs();
    // Внизу на телефоне — только значки (подпись видна у открытого раздела),
    // поэтому у кнопки есть aria-label и title с названием
    const button = (tab) => `
      <button type="button" data-tab="${tab.id}" aria-label="${esc(tab.title)}" title="${esc(tab.title)}" ${state.tab === tab.id ? 'aria-current="page"' : ''}>
        ${ICONS[tab.id]}<span class="tab__label">${esc(tab.title)}</span>
        ${tab.id === 'requests' && count ? `<span class="count">${count}</span>` : ''}
        ${tab.id === 'server' ? serverDot() : ''}
        ${tab.id === 'tickets' ? ticketsCount() : ''}
      </button>`;
    const html = list.map(button).join('');
    const top = document.querySelector('.tabs--top');
    top.innerHTML = html;
    fitTopTabs();
    const bottom = document.querySelector('.tabs--bottom');
    // «Установить приложение» — пункт меню «Ещё» (пока портал не установлен)
    const extras = installOffered() ? [`
      <button type="button" data-install="menu">${ICONS.install}<span class="tab__label">${esc(t('tab.install'))}</span></button>`] : [];
    if (list.length <= BOTTOM_MAX && !extras.length) {
      bottom.innerHTML = html;
    } else {
      // «Ошибки и предложения» всегда внизу (перед «Ещё») — цветной значок на виду
      const pinned = list.filter((tab) => tab.id === 'tickets');
      const others = list.filter((tab) => tab.id !== 'tickets');
      const main = [...others.slice(0, BOTTOM_MAX - 1 - pinned.length), ...pinned];
      const rest = others.slice(main.length - pinned.length);
      const inRest = rest.some((tab) => tab.id === state.tab);
      const more = t('tab.more');
      // «Сервер» спрятан в «Ещё» — значок тревоги и на кнопке «Ещё»
      const moreDot = (rest.some((tab) => tab.id === 'server') ? serverDot() : '')
        + (rest.some((tab) => tab.id === 'tickets') ? ticketsCount() : '');
      bottom.innerHTML = `${main.map(button).join('')}
        <button type="button" data-more aria-label="${esc(more)}" title="${esc(more)}" aria-expanded="${state.moreOpen}" ${inRest ? 'aria-current="page"' : ''}>${ICONS.more}<span class="tab__label">${esc(more)}</span>${moreDot}</button>
        ${state.moreOpen ? `<div class="tabs-more" role="menu">${rest.map(button).join('')}${extras.join('')}</div>` : ''}`;
    }
  }

  /* ------------------------------------- Установка на телефон как приложение */

  // Chrome / Samsung Internet на Android сами предлагают окно установки —
  // событие ловим заранее и показываем окно по нашей кнопке. На iPhone такого
  // окна нет: показываем подсказку «Поделиться → На экран „Домой“».
  const INSTALL_LATER_KEY = 'jm_staff_install_later';
  const INSTALL_PAUSE_MS = 14 * 24 * 3600 * 1000;
  let installPrompt = null;
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  /** Предлагаем только на телефонах и планшетах, если портал ещё не открыт как приложение */
  const installOffered = () => !isStandalone() && window.matchMedia('(pointer: coarse)').matches;

  function installPaused() {
    try {
      return Date.now() - Number(localStorage.getItem(INSTALL_LATER_KEY) || 0) < INSTALL_PAUSE_MS;
    } catch {
      return false;
    }
  }

  function renderInstall() {
    const box = $('#install');
    if (!box) return;
    // Плашка: окно установки доступно (Android) или это iPhone; «Не сейчас» —
    // прячем на 2 недели. По пункту в «Ещё» плашка открывается с подсказкой всегда.
    const show = state.user && installOffered() && (state.installHelp || (!installPaused() && (installPrompt || isIos())));
    box.hidden = !show;
    if (!show) return;
    const help = state.installHelp || (!installPrompt && isIos());
    const text = help
      ? esc(t(isIos() ? 'install.ios' : 'install.other', { share: '\u0001' })).replace('\u0001', SHARE_ICON)
      : esc(t('install.text'));
    box.innerHTML = `
      <img class="install__icon" src="icon-192.png?v=2" alt="" width="44" height="44" />
      <div class="install__body">
        <b>${esc(t('install.title'))}</b>
        <span>${text}</span>
      </div>
      <div class="install__actions">
        ${help ? '' : `<button type="button" class="btn btn--primary btn--small" data-install="go">${esc(t('install.button'))}</button>`}
        <button type="button" class="btn btn--small" data-install="later">${esc(t(help ? 'install.ok' : 'install.later'))}</button>
      </div>`;
  }

  async function onInstall(action) {
    if (action === 'later') {
      try { localStorage.setItem(INSTALL_LATER_KEY, String(Date.now())); } catch { /* приватный режим */ }
      state.installHelp = false;
      return renderInstall();
    }
    state.moreOpen = false;
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      prompt.prompt();
      await prompt.userChoice.catch(() => null);
      state.installHelp = false;
    } else {
      // Окна установки нет (iPhone или браузер не предложил) — подсказка, как вручную
      state.installHelp = true;
      window.scrollTo(0, 0);
    }
    renderTabs();
    renderInstall();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    state.installHelp = false;
    renderInstall();
    if (state.user) renderTabs();
  });

  function setTab(tab) {
    if (!tabs().some((x) => x.id === tab)) tab = tabs()[0]?.id || 'overview';
    // Для тикета запоминаем, на какой вкладке был сотрудник
    if (tab === 'tickets' && state.tab !== 'tickets') state.prevTab = state.tab;
    state.tab = tab;
    state.moreOpen = false;
    if (tab === 'journal') journal.show();
    if (tab === 'access') access.load();
    if (tab === 'finance') finance.load();
    if (tab === 'crm') crm.load();
    if (tab === 'marketing') marketing.load();
    if (tab === 'price') price.load();
    if (tab === 'tickets') tickets.load();
    if (tab === 'cabinet') cabinet.load(state.cabinetPreview);
    if (tab === 'site' && !state.models) loadModels();
    if (tab === 'server') startServerPolling();
    else stopServerPolling();
    history.replaceState(null, '', `#${tab}`);
    renderTabs();
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    const fleet = state.fleet;
    renderWho();
    renderInstall();
    $('#updated').innerHTML = fleet?.updatedAt
      ? esc(t('app.dataAt', { time: '\u0001' })).replace('\u0001', `<b>${esc(fmtTime.format(new Date(fleet.updatedAt)))}</b>`)
      : esc(fleet ? (fleet.enabled ? t('app.loadingWs') : t('app.wsOff')) : t('app.loading'));
    renderTabs();
    const view = $('#view');
    if (state.tab === 'overview') view.innerHTML = renderOverview();
    if (state.tab === 'fleet') view.innerHTML = renderFleet();
    if (state.tab === 'calendar') view.innerHTML = renderCalendar();
    if (state.tab === 'requests') view.innerHTML = renderRequests();
    if (state.tab === 'site') view.innerHTML = renderSite();
    if (state.tab === 'server') renderServer();
    if (state.tab === 'journal') renderJournal();
    if (state.tab === 'access') view.innerHTML = access.render();
    if (state.tab === 'finance') view.innerHTML = finance.render();
    if (state.tab === 'crm') view.innerHTML = crm.render();
    // Во время правки источника фоновое обновление вкладку не трогает (не теряем введённое)
    if (state.tab === 'marketing' && (!view.querySelector('.mk') || marketing.canRefresh())) { view.innerHTML = marketing.render(); marketing.mount(); }
    // Прайс: пока есть несохранённые правки цен, фоновое обновление вкладку не трогает
    if (state.tab === 'price' && (!view.querySelector('.pr') || price.canRefresh())) view.innerHTML = price.render();
    // Тикеты: пока сотрудник пишет, фоновое обновление вкладку не трогает
    if (state.tab === 'tickets' && (!view.querySelector('.tk') || tickets.canRefresh())) view.innerHTML = tickets.render();
    if (state.tab === 'cabinet' && (!view.querySelector('.cab') || cabinet.canRefresh())) view.innerHTML = cabinet.render();
    // Роли не открыт ни один раздел — подсказка вместо пустого экрана
    if (!tabs().length) view.innerHTML = `<div class="empty">${esc(t('app.noSections'))}</div>`;
  }

  /* ------------------------------------------------------ Вкладка «Финансы» */

  const finance = window.STAFF_FINANCE.create({
    api, t, esc, can,
    locale: () => LOCALES[lang],
    dateTime,
    shortDate: (iso) => shortDate(iso),
    errorText: (err) => ERRORS[err.code] || t('app.loadFailed'),
    rerender: () => { if (state.tab === 'finance') $('#view').innerHTML = finance.render(); }
  });

  /* ---------------------------------------------------- Вкладка «Маркетинг» */

  const marketing = window.STAFF_MARKETING.create({
    api, esc, can,
    openCabinet: (id) => openCabinet(id),
    rerender: () => { if (state.tab === 'marketing') { $('#view').innerHTML = marketing.render(); marketing.mount(); } }
  });

  /* -------------------------------------------------------- Вкладка «Прайс» */

  const price = window.STAFF_PRICE.create({
    api, t, esc, can, money, dateTime,
    locale: () => LOCALES[lang],
    seasonName: (name) => (I18N.en[`season.${name}`] ? t(`season.${name}`) : name),
    rerender: () => { if (state.tab === 'price') $('#view').innerHTML = price.render(); }
  });

  /* ---------------------------------------------- Вкладка «Кабинет» агента */

  const cabinet = window.STAFF_CABINET.create({
    api, t, esc, money, dateTime,
    lang: () => lang,
    today: () => new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10),
    seasonName: (name) => (I18N.en[`season.${name}`] ? t(`season.${name}`) : name),
    // Закрыть просмотр чужого кабинета — вернуться в «Маркетинг»
    closePreview: () => { state.cabinetPreview = null; setTab(state.user?.sourceId ? 'cabinet' : 'marketing'); },
    rerender: () => { if (state.tab === 'cabinet') $('#view').innerHTML = cabinet.render(); }
  });

  /** Из «Маркетинга»: открыть кабинет источника (как его видит агент) */
  function openCabinet(sourceId) {
    state.cabinetPreview = sourceId;
    setTab('cabinet');
  }

  /* ------------------------------------------ Вкладка «Ошибки и предложения» */

  const tickets = window.STAFF_TICKETS.create({
    api, t, esc, dateTime,
    apiBase: API,
    lang: () => lang,
    userName: () => state.user?.name || state.user?.email || '',
    prevTab: () => state.prevTab || null,
    tabTitle: (id) => t(`tab.${id}`),
    uploadImage: (url, blob) => uploadImage(url, blob),
    // Скриншот уменьшаем в браузере (до 2000 px по большей стороне) и сжимаем в JPEG
    prepareShot: async (file) => {
      const canvas = toCanvas(await decodeFile(file), 2000);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    },
    onBadge: (count, handler) => setTicketsBadge(count, handler),
    rerender: () => { if (state.tab === 'tickets') $('#view').innerHTML = tickets.render(); }
  });

  /* ---------------------------------------------------------- Вкладка «CRM» */

  const crm = window.STAFF_CRM.create({
    api, esc, can,
    rerender: () => { if (state.tab === 'crm') $('#view').innerHTML = crm.render(); }
  });

  /* ------------------------------------------------------ Вкладка «Доступы» */

  const access = window.STAFF_ACCESS.create({
    api, t, esc,
    dateTime,
    errorText: (err) => ERRORS[err.code] || t('md.saveFailed'),
    rerender: () => { if (state.tab === 'access') $('#view').innerHTML = access.render(); }
  });

  /* ------------------------------------------------------ Вкладка «Журнал» */

  const bangkokDate = (iso) => new Date(Date.parse(iso) + TZ_OFFSET_MS).toISOString().slice(0, 10);
  const journal = window.STAFF_JOURNAL.create({
    api, t, tn, esc, can,
    locale: () => LOCALES[lang],
    time: (iso) => fmtTime.format(new Date(iso)),
    dateTime,
    shortDate,
    weekday: (isoDate) => fmtWeekday.format(new Date(`${isoDate}T00:00:00Z`)),
    dayLabel: (iso) => { const d = bangkokDate(iso); return `${fmtWeekday.format(new Date(`${d}T00:00:00Z`))}, ${shortDate(d)}`; },
    rerender: () => { if (state.tab === 'journal') renderJournal(); },
    signedOut: (err) => showLogin('email', err.code === 'no_access' ? ERRORS.no_access : ''),
    errorText: (err) => {
      if (ERRORS[err.code]) return ERRORS[err.code];
      const own = t(`jr.err.${err.code}`);
      return own === `jr.err.${err.code}` ? t('md.saveFailed') : own;
    }
  });

  /** Перерисовка журнала с сохранением курсора в поле поиска */
  function renderJournal() {
    const active = document.activeElement;
    const typing = active?.matches?.('[data-jr-search]') ? active.selectionStart : null;
    $('#view').innerHTML = journal.render();
    if (typing !== null) {
      const input = document.querySelector('[data-jr-search]');
      if (input) { input.focus(); input.setSelectionRange(typing, typing); }
    }
  }

  /* -------------------------------------------------- Вкладка «Сервер» */

  const cockpitHelpers = () => ({
    t, tn, esc, lang, locale: LOCALES[lang],
    dateTime, shortDate, time: (iso) => fmtTime.format(new Date(iso))
  });

  /**
   * Приборы перерисовываем целиком, а форму лимита — только если в ней
   * сейчас ничего не вводят (иначе обновление каждые 10 секунд сбивало бы ввод)
   */
  function renderServer() {
    const view = $('#view');
    let panel = view.querySelector('#cockpit');
    let form = view.querySelector('#srv-settings-box');
    if (!panel || !form) {
      view.innerHTML = '<div id="cockpit"></div><div id="srv-settings-box"></div>';
      panel = view.querySelector('#cockpit');
      form = view.querySelector('#srv-settings-box');
    }
    panel.innerHTML = window.STAFF_COCKPIT.render(state.server, { failed: state.serverFailed, helpers: cockpitHelpers() });
    if (!form.contains(document.activeElement) || !form.firstElementChild) {
      form.innerHTML = window.STAFF_COCKPIT.settings(state.server, state.serverStatus, cockpitHelpers());
    }
  }

  async function loadServer() {
    if (!can('server.view')) return;
    try {
      state.server = await api('/server');
      state.serverFailed = false;
      state.serverAlert = { warning: state.server.master.warning, caution: state.server.master.caution };
      renderTabs();
    } catch (err) {
      if (err.status === 401) return showLogin('email', err.code === 'no_access' ? ERRORS.no_access : '');
      state.serverFailed = true;
    }
    if (state.tab === 'server') renderServer();
  }

  function startServerPolling() {
    stopServerPolling();
    loadServer();
    state.serverTimer = setInterval(() => { if (!document.hidden && state.tab === 'server') loadServer(); }, SERVER_REFRESH_MS);
  }

  function stopServerPolling() {
    clearInterval(state.serverTimer);
    state.serverTimer = null;
  }

  async function saveServerSettings(form) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/server/settings', {
        body: { trafficLimitGb: Number(form.elements.limit.value), trafficBasis: form.elements.basis.value }
      });
      if (state.server) state.server.settings = data.settings;
      state.serverStatus = { kind: 'ok', text: t('srv.s.saved') };
    } catch (err) {
      state.serverStatus = { kind: 'error', text: ERRORS[err.code] || t('md.saveFailed') };
    }
    document.activeElement?.blur();
    $('#srv-settings-box').innerHTML = window.STAFF_COCKPIT.settings(state.server, state.serverStatus, cockpitHelpers());
    loadServer();
  }

  /* --------------------------------------------------------- Данные парка */

  const cars = () => state.fleet?.cars || [];
  const carName = (car) => car.model || car.wsModel || '—';
  const priceOf = (car) => state.fleet?.prices?.[car.model] || null;
  const tariffOf = (car) => state.fleet?.tariffs?.[car.id] || null;
  const seasonName = (name) => (I18N.en[`season.${name}`] ? t(`season.${name}`) : name);
  const tierLabels = () => ['1–2', '3–6', '7–13', '14–27', '28+'].map((range) => `${range} ${t('unit.d')}`);

  function filteredCars() {
    const q = state.filters.q.trim().toLowerCase();
    return cars().filter((car) => {
      if (state.filters.type !== 'all' && car.type !== state.filters.type) return false;
      if (state.filters.status !== 'all' && car.status !== state.filters.status) return false;
      if (!q) return true;
      return [car.plate, car.model, car.wsModel].some((v) => String(v || '').toLowerCase().includes(q))
        || String(car.plate).replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000');
    });
  }

  function statusPill(status) {
    return `<span class="pill pill--${status}"><span class="dot dot--${status}"></span>${STATUS[status]}</span>`;
  }

  function freeText(car) {
    if (car.status === 'free') return esc(t(car.freeWeek ? 'free.nowWeek' : 'free.now'));
    if (car.freeFrom === 'later') return esc(t('free.later'));
    return esc(t('free.from', { date: '\u0001', rel: '\u0002' }))
      .replace('\u0001', `<b>${esc(dateTime(car.freeFrom))}</b>`).replace('\u0002', esc(relative(car.freeFrom)));
  }

  /* -------------------------------------------------------------- Overview */

  // Категории проблем — у каждой свой ответственный; порядок — порядок в списке
  const CATEGORIES = ['sales', 'it', 'marketing', 'service'];
  const CATEGORY_ICON = { sales: '💼', it: '🖥', marketing: '🌐', service: '🔧' };
  const PER_CATEGORY = 3;

  /** Проблемы самого портала: нет связи с сервером или список проблем не обновился */
  function clientProblems() {
    if (state.offline) {
      return [{ category: 'it', level: 'error', title: t('it.offline'), detail: t('it.offlineDetail', { time: state.fleet?.updatedAt ? dateTime(state.fleet.updatedAt) : '—' }) }];
    }
    if (state.dashboardFailed) return [{ category: 'it', level: 'warning', title: t('it.dashFailed'), detail: t('it.dashFailedDetail') }];
    return [];
  }

  /**
   * Окно «Проблемы»: счётчики по категориям (продажи, IT, сайт, сервис) и всего,
   * по нажатию на категорию — только она; в каждой сначала ошибки,
   * по нажатию на проблему — нужная машина, заявка или модель
   */
  function renderProblems() {
    if (!state.dashboard && !state.offline && !state.dashboardFailed) return '';
    const problems = [...clientProblems(), ...(state.dashboard?.problems || [])];
    if (!problems.length) return `<div class="ok-line">${esc(t('ov.noProblems'))}</div>`;
    const errors = problems.filter((p) => p.level === 'error').length;
    const byCategory = CATEGORIES.map((c) => [c, problems.filter((p) => (p.category || 'it') === c)]);
    const filter = state.problemCat;
    const chips = [['all', problems.length], ...byCategory.map(([c, list]) => [c, list.length])].map(([id, n]) => `
      <button type="button" class="pchip" data-pcat="${id}" aria-pressed="${filter === id}"${n || id === 'all' ? '' : ' disabled'}>${id === 'all' ? '' : `${CATEGORY_ICON[id]} `}${esc(id === 'all' ? t('ov.allCats') : t(`catShort.${id}`))} <b>${n}</b></button>`).join('');
    const item = (p) => {
      const level = p.level === 'error'
        ? `<span class="problem__level problem__level--error">● ${esc(t('ov.error'))}</span>`
        : `<span class="problem__level problem__level--warning">▲ ${esc(t('ov.warning'))}</span>`;
      const body = `${level}<span class="problem__main"><span class="problem__title">${esc(p.title)}</span><span class="problem__detail">${esc(p.detail || '')}</span></span>`;
      return p.target
        ? `<button type="button" class="problem" data-problem="${esc(p.target.tab)}" data-q="${esc(p.target.q || '')}">${body}<span class="problem__go" aria-hidden="true">›</span></button>`
        : `<div class="problem">${body}</div>`;
    };
    const sections = byCategory.filter(([c, list]) => list.length && (filter === 'all' || filter === c)).map(([c, list]) => {
      const open = filter === c || state.openCats.has(c);
      return `
        <div class="pcat" data-category="${c}">
          <h3 class="pcat__title">${CATEGORY_ICON[c]} ${esc(t(`cat.${c}`))} · ${list.length}</h3>
          ${(open ? list : list.slice(0, PER_CATEGORY)).map(item).join('')}
          ${list.length > PER_CATEGORY && filter !== c ? `<button type="button" class="link pcat__more" data-pmore="${c}">${esc(open ? t('ov.showLess') : t('ov.showAll', { n: list.length }))}</button>` : ''}
        </div>`;
    }).join('');
    return `
      <section class="card problems" aria-labelledby="problems-title">
        <div class="problems__head">
          <h2 id="problems-title">${esc(t('ov.problems', { n: problems.length }))}</h2>
          ${errors ? `<span class="problems__errors">${esc(t('ov.errorsOf', { n: errors }))}</span>` : ''}
        </div>
        <div class="pchips" role="group">${chips}</div>
        ${sections}
      </section>`;
  }

  /** Загрузка парка на 14 дней: доля техники в аренде и в брони по дням */
  function renderLoadChart(load) {
    if (!load?.length) return '';
    const totals = load.map((d) => d.rent + d.reserve);
    const peak = totals.indexOf(Math.max(...totals));
    const cols = load.map((d, i) => {
      const day = new Date(`${d.date}T00:00:00Z`);
      const total = totals[i];
      const label = (i === 0 || i === peak) && total ? `<span class="load__value">${total}%</span>` : '';
      const segments = [['rent', d.rent], ['reserve', d.reserve]].filter(([, v]) => v > 0)
        // Высота столбика — доля парка, внутри него части делятся пропорционально
        .map(([kind, v]) => `<span class="load__seg load__seg--${kind}" style="flex-grow:${v}"></span>`).join('');
      const align = i < 3 ? ' load__tip--left' : i > load.length - 4 ? ' load__tip--right' : '';
      return `
        <div class="load__col" tabindex="0" aria-label="${esc(t('ov.colAria', { day: `${fmtWeekday.format(day)} ${shortDate(d.date)}`, r: d.rent, b: d.reserve }))}">
          <div class="load__area">${label}<div class="load__stack" style="height:${Math.min(100, total)}%">${segments}</div></div>
          <span class="load__x${i === 0 ? ' load__x--today' : ''}"><b>${day.getUTCDate()}</b><span class="load__wd">${esc(fmtWeekday.format(day).slice(0, 2))}</span></span>
          <span class="load__tip${align}" role="tooltip"><b>${esc(`${fmtWeekday.format(day)} ${shortDate(d.date)}`)}</b>
            <span><i class="sw sw--rent"></i>${esc(STATUS.rent)} ${d.rent}%</span><span><i class="sw sw--reserve"></i>${esc(STATUS.reserve)} ${d.reserve}%</span>
            <span class="muted">${esc(t('ov.inService', { s: d.service, f: Math.max(0, 100 - d.rent - d.reserve - d.service) }))}</span></span>
        </div>`;
    }).join('');
    const rows = load.map((d) => `<tr><td>${esc(`${fmtWeekday.format(new Date(`${d.date}T00:00:00Z`))} ${shortDate(d.date)}`)}</td><td>${d.rent}%</td><td>${d.reserve}%</td><td>${d.service}%</td></tr>`).join('');
    return `
      <div class="card load">
        <div class="load__head">
          <b>${esc(t('ov.loadTitle'))}</b>
          <span class="load__legend"><span><i class="sw sw--rent"></i>${esc(STATUS.rent)}</span><span><i class="sw sw--reserve"></i>${esc(STATUS.reserve)}</span></span>
        </div>
        <div class="load__plot">
          <div class="load__grid" aria-hidden="true"><span style="bottom:100%">100%</span><span style="bottom:50%">50%</span><span style="bottom:0">0</span></div>
          <div class="load__cols">${cols}</div>
        </div>
        <details class="load__table">
          <summary>${esc(t('ov.asTable'))}</summary>
          <div class="table-wrap"><table class="type-table"><thead><tr><th>${esc(t('ov.day'))}</th><th>${esc(STATUS.rent)}</th><th>${esc(STATUS.reserve)}</th><th>${esc(STATUS.service)}</th></tr></thead><tbody>${rows}</tbody></table></div>
        </details>
      </div>`;
  }

  const SOURCE_ICON = { telegram: '✈️', site: '🌐', whatsapp: '💬', instagram: '📷', facebook: '👍' };

  /**
   * Заявки: новые (не взяты в работу), взятые сегодня, всего за сегодня;
   * источники — подключённые и ещё не подключённые каналы; список новых
   */
  function renderRequestsBlock(fresh) {
    const stats = state.dashboard?.requests;
    const list = fresh.length ? `
      <h3 class="subsection-title">${esc(t('ov.waitingList'))}</h3>
      <div class="card">
        ${fresh.slice(0, 5).map((r) => `
          <div class="row" data-goto="requests">
            <div class="row__main">
              <div class="row__title">#${r.id} · ${esc(r.model || TYPE_ONE[r.vehicleType] || t('ov.question'))}</div>
              <div class="row__sub">${esc(r.clientName || '')} · ${SOURCE_ICON[r.channel] || ''} ${esc(CHANNELS[r.channel] || r.channel)}</div>
            </div>
            <div class="row__side">${r.dateFrom ? `${esc(shortDate(r.dateFrom))} – ${esc(shortDate(r.dateTo))}` : ''}</div>
          </div>`).join('')}
      </div>` : '';
    if (!stats) return `<h2 class="section-title">${esc(t('req.section'))}</h2>${list || `<p class="muted note">${esc(t('ov.noNew'))}</p>`}`;
    const offline = stats.sources.filter((s) => !s.connected);
    return `
      <h2 class="section-title">${esc(t('req.section'))}</h2>
      <div class="stats stats--3">
        <div class="stat${stats.waiting ? ' stat--alert' : ''}" data-goto="requests"><div class="stat__value">${stats.waiting}</div><div class="stat__label"><span class="dot dot--rent"></span>${esc(t('req.waiting'))}</div></div>
        <div class="stat"><div class="stat__value">${stats.takenToday}</div><div class="stat__label"><span class="dot dot--free"></span>${esc(t('req.takenToday'))}</div></div>
        <div class="stat"><div class="stat__value">${stats.today}</div><div class="stat__label">${esc(t('req.today'))}</div></div>
      </div>
      <div class="card sources">
        <div class="sources__row sources__row--head"><span>${esc(t('src.title'))}</span><span>${esc(t('src.today'))}</span><span>${esc(t('src.days30'))}</span></div>
        ${stats.sources.map((s) => `
          <div class="sources__row${s.connected ? '' : ' is-off'}">
            <span class="sources__name">${SOURCE_ICON[s.id]} ${esc(t(`src.${s.id}`))}<small class="sources__state${s.error ? ' sources__state--error' : ''}">${s.error ? '🔴 ' : s.connected ? '🟢 ' : ''}${esc(t(s.error ? 'src.error' : s.connected ? 'src.connected' : 'src.off'))}</small></span>
            <span>${s.connected ? s.today : '—'}</span>
            <span>${s.connected ? s.days30 : '—'}</span>
          </div>`).join('')}
        ${offline.length ? `<p class="sources__hint">${esc(t('src.offHint'))}</p>` : ''}
      </div>
      ${list}`;
  }

  function renderOverview() {
    if (!state.fleet) return loadingBox();
    const all = cars();
    if (!all.length) return `${renderProblems()}<div class="empty">${esc(t(state.fleet.enabled ? 'ov.noWsData' : 'ov.wsOff'))}</div>`;

    const count = (status, type) => all.filter((c) => (!status || c.status === status) && (!type || c.type === type)).length;
    // «Сейчас»: свободна, в аренде, в сервисе. Брони — отдельным блоком ниже
    const stats = ['free', 'rent', 'service'].map((s) => `
      <div class="stat">
        <div class="stat__value">${count(s)}</div>
        <div class="stat__label"><span class="dot dot--${s}"></span>${esc(STATUS[s])}</div>
      </div>`).join('');

    const weekAhead = Date.now() + 7 * DAY_MS;
    const bookedSoon = (type) => all.filter((c) => c.type === type
      && c.segments.some((seg) => seg.kind === 'reserve' && Date.parse(seg.to) > Date.now() && Date.parse(seg.from) <= weekAhead)).length;
    // На компьютере — таблица, на телефоне — название и «всего» строкой, под ними 4 числа с подписями
    const typeCols = [['free', STATUS.free, (type) => count('free', type)], ['rent', STATUS.rent, (type) => count('rent', type)],
      ['service', STATUS.service, (type) => count('service', type)], ['reserve', t('ov.booked7'), bookedSoon]];
    const typeRows = Object.keys(TYPES).map((type) => `
      <div class="types__row">
        <span class="types__name">${esc(TYPES[type])}</span>
        ${typeCols.map(([kind, label, value]) => `<span class="types__cell"><b>${value(type)}</b><small><i class="dot dot--${kind}"></i>${esc(label)}</small></span>`).join('')}
        <span class="types__total"><b>${count(null, type)}</b><small>${esc(t('ov.all'))}</small></span>
      </div>`).join('');

    const outlook = state.dashboard?.outlook;
    const ahead = outlook ? `
      <h2 class="section-title">${esc(t('ov.bookingsAhead'))}</h2>
      <div class="stats stats--3">
        <div class="stat"><div class="stat__value">${outlook.next7.bookings}</div><div class="stat__label"><span class="dot dot--reserve"></span>${esc(t('ov.next7', { vehicles: tn('n.vehicles', outlook.next7.vehicles) }))}</div></div>
        <div class="stat"><div class="stat__value">${outlook.next30.bookings}</div><div class="stat__label"><span class="dot dot--reserve"></span>${esc(t('ov.next30', { vehicles: tn('n.vehicles', outlook.next30.vehicles) }))}</div></div>
        <div class="stat"><div class="stat__value">${outlook.bookedDays30}</div><div class="stat__label">${esc(t('ov.bookedDays'))}</div></div>
      </div>
      ${outlook.waitingNow ? `<p class="muted note">${esc(t('ov.waiting', { vehicles: tn('n.bookedVehicles', outlook.waitingNow) }))}</p>` : ''}
      ${renderLoadChart(outlook.load)}` : '';

    const now = Date.now();
    const soon = now + 48 * 3600000;
    const freeing = all
      .filter((c) => c.status !== 'free' && c.freeFrom && c.freeFrom !== 'later' && Date.parse(c.freeFrom) <= soon)
      .sort((a, b) => Date.parse(a.freeFrom) - Date.parse(b.freeFrom));
    const pickups = all
      .flatMap((c) => c.segments.filter((s) => s.kind === 'reserve' && Date.parse(s.from) > now && Date.parse(s.from) <= soon).map((s) => ({ car: c, seg: s })))
      .sort((a, b) => Date.parse(a.seg.from) - Date.parse(b.seg.from));
    const fresh = state.requests.filter((r) => r.status === 'new' && !r.archived);

    const carRow = (car, side) => `
      <div class="row">
        <div class="row__main">
          <div class="row__title">${esc(carName(car))}</div>
          <div class="row__sub"><span class="car__plate">${esc(car.plate)}</span>${statusPill(car.status)}</div>
        </div>
        <div class="row__side">${side}</div>
      </div>`;

    return `
      ${renderProblems()}
      ${renderRequestsBlock(fresh)}
      <h2 class="section-title">${esc(t('ov.rightNow', { vehicles: tn('n.vehicles', all.length) }))}</h2>
      <div class="stats stats--3">${stats}</div>
      ${ahead}

      <h2 class="section-title">${esc(t('ov.byType'))}</h2>
      <div class="card types">
        <div class="types__row types__row--head" aria-hidden="true"><span></span>${typeCols.map(([, label]) => `<span>${esc(label)}</span>`).join('')}<span>${esc(t('ov.all'))}</span></div>
        ${typeRows}
      </div>

      <h2 class="section-title">${esc(t('ov.returning'))}</h2>
      <div class="card">
        ${freeing.length ? freeing.map((c) => carRow(c, `${esc(dateTime(c.freeFrom))}<br><span class="muted">${esc(relative(c.freeFrom))}</span>`)).join('') : `<div class="empty">${esc(t('ov.noReturning'))}</div>`}
      </div>

      <h2 class="section-title">${esc(t('ov.pickups'))}</h2>
      <div class="card">
        ${pickups.length ? pickups.map(({ car, seg }) => carRow(car, `${esc(dateTime(seg.from))}<br><span class="muted">${esc(relative(seg.from))}</span>`)).join('') : `<div class="empty">${esc(t('ov.noPickups'))}</div>`}
      </div>`;
  }

  /* ----------------------------------------------------------------- Fleet */

  function renderFilters({ withStatus }) {
    const f = state.filters;
    const typeChips = [['all', t('filter.allTypes')], ...Object.entries(TYPES)].map(([id, label]) =>
      `<button type="button" class="chip" data-filter="type" data-value="${id}" aria-pressed="${f.type === id}">${esc(label)}</button>`).join('');
    const statusChips = withStatus ? [['all', t('filter.anyStatus')], ...Object.entries(STATUS)].map(([id, label]) =>
      `<button type="button" class="chip" data-filter="status" data-value="${id}" aria-pressed="${f.status === id}">${id !== 'all' ? `<span class="dot dot--${id}"></span>` : ''}${esc(label)}</button>`).join('') : '';
    return `
      <div class="toolbar">
        <input class="search" type="search" placeholder="${esc(t('fleet.search'))}" value="${esc(f.q)}" data-search autocomplete="off" />
        <div class="chips">${typeChips}</div>
        ${withStatus ? `<div class="chips">${statusChips}</div>` : ''}
      </div>`;
  }

  function renderFleet() {
    if (!state.fleet) return loadingBox();
    // «Только с проблемами» — кнопкой над списком
    const list = vehicles.filterProblems(filteredCars());
    return `
      ${vehicles.toolbar(cars())}
      ${renderFilters({ withStatus: true })}
      <div class="result-count">${esc(t('fleet.count', { n: list.length, total: cars().length }))}</div>
      ${vehicles.view() === 'table'
        ? (list.length ? vehicles.renderTable(list) : nothingFound())
        : `<div class="list" style="margin-top:10px">${list.length ? list.map(renderCar).join('') : nothingFound()}</div>`}
      ${vehicles.renderArchive()}`;
  }

  /* ------------------------- Карточки техники в портале: правка и архив (vehicles.js) */

  const bkkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const vehicles = window.STAFF_VEHICLES.create({
    api, t, esc, money, dateTime,
    shortDate: (iso) => shortDate(iso),
    today: bkkToday,
    fleet: () => state.fleet,
    catalogModels: () => Object.keys(state.fleet?.prices || {}),
    statusName: (status) => STATUS[status] || status,
    canSetStatus: () => Boolean(state.fleet?.canSetStatus),
    // Фото и описание модели для сайта — бывшая вкладка «Сайт», теперь из карточки техники
    canEditModel: () => can('site.edit'),
    openModel: async (model) => {
      if (!(state.models || []).some((m) => m.model === model)) await loadModels();
      openModel(model);
      $('#model-dialog').addEventListener('close', () => { if (state.tab === 'fleet') loadData(); }, { once: true });
    },
    rerender: () => render(),
    reload: async () => { await loadData(); render(); }
  });



  function renderCar(car) {
    const price = priceOf(car);
    // Цена на сегодня — из сезонного прайса по госномеру, иначе «от» из каталога
    const tariff = tariffOf(car);
    const todayPrice = tariff?.tiers?.[0];
    const priceText = todayPrice
      ? `${t('fleet.perDayToday', { price: money(todayPrice) })}${tariff.verified ? '' : ' ⚠️'}`
      : price?.perDay ? t('fleet.perDay', { price: money(price.perDay) }) : price?.priceFrom ? t('fleet.fromPerDay', { price: money(price.priceFrom) }) : '';
    const deposit = tariff?.deposit || car.deposit || price?.deposit;
    const seasonText = tariff
      ? `${seasonName(tariff.season)}${tariff.verified ? '' : ` — ⚠️ ${t('fleet.notVerified')}`}${tariff.suspicious ? ` — ⚠️ ${t('fleet.typo')}` : ''}`
      : '';
    const seasonTiers = tariff?.tiers
      ? tariff.tiers.map((v, i) => (v ? `${tierLabels()[i]}: ${money(v)}` : null)).filter(Boolean).join(' · ')
      : '';
    const open = state.expanded.has(car.id);
    const upcoming = car.segments.filter((s) => Date.parse(s.to) > Date.now());
    const tariffs = car.tariffs.length
      ? car.tariffs.map((x) => `${x.min}–${x.max >= 999 ? '∞' : x.max} ${t('unit.d')}: ${money(x.cost)}`).join(' · ')
      : '';
    const tiers = price && (price.perDay || price.perDayWeek || price.perDayMonth)
      ? [price.perDay && `1–6 ${t('unit.d')}: ${money(price.perDay)}`, price.perDayWeek && `7–29 ${t('unit.d')}: ${money(price.perDayWeek)}`, price.perDayMonth && `30+ ${t('unit.d')}: ${money(price.perDayMonth)}`].filter(Boolean).join(' · ')
      : '';

    return `
      <article class="card car" data-car="${car.id}">
        <div class="car__head">
          <div class="row__main">
            <div class="car__title">${esc(carName(car))}</div>
            <div><span class="car__plate">${esc(car.plate)}</span><span class="muted" style="font-size:13px">${esc(TYPE_ONE[car.type] || '')}</span></div>
          </div>
          <span class="pill pill--${car.status}"><span class="dot dot--${car.status}"></span>${esc(vehicles.statusText(car))}</span>
        </div>
        ${vehicles.wsLine(car)}
        ${vehicles.problemBadges(car)}
        <div class="car__meta">
          <span>${freeText(car)}</span>
          ${priceText ? `<span>${esc(t('fleet.price'))} <b>${esc(priceText)}</b></span>` : ''}
          ${deposit ? `<span>${esc(t('fleet.deposit'))} <b>${esc(money(deposit))}</b></span>` : ''}
        </div>
        ${open ? `
          <div class="car__details">
            <dl>
              <dt>${esc(t('fleet.inWs'))}</dt><dd>${car.ws ? esc(`${car.ws.model} · ${STATUS[car.ws.status]}`) : '—'}</dd>
              ${!car.model ? `<dt>${esc(t('fleet.sheet'))}</dt><dd class="warn">${esc(t('fleet.notMatched'))}</dd>` : ''}
              ${seasonText ? `<dt>${esc(t('fleet.seasonToday'))}</dt><dd${tariff.verified && !tariff.suspicious ? '' : ' class="warn"'}>${esc(seasonText)}</dd>` : ''}
              ${seasonTiers ? `<dt>${esc(t('fleet.priceList'))}</dt><dd>${esc(seasonTiers)}${tariff.overKm ? ` · ${esc(t('fleet.overKm', { price: money(tariff.overKm) }))}` : ''}</dd>` : ''}
              ${tariff && !tariff.tiers ? `<dt>${esc(t('fleet.priceList'))}</dt><dd class="warn">${esc(t('fleet.noRow'))}</dd>` : ''}
              ${tariffs ? `<dt>${esc(t('fleet.tariffs'))}</dt><dd>${esc(tariffs)}</dd>` : ''}
              ${tiers ? `<dt>${esc(t('fleet.catalog'))}</dt><dd>${esc(tiers)}</dd>` : ''}
              <dt>${esc(t('fleet.next7'))}</dt><dd>${esc(t(car.freeWeek ? 'fleet.freeWeek' : 'fleet.busyWeek'))}</dd>
            </dl>
            <div><b>${esc(t('fleet.next30'))}</b>
              ${upcoming.length ? `<ul class="seg-list">${upcoming.map((s) => `
                <li><span class="dot dot--${s.kind}"></span>${esc(STATUS[s.kind])}: ${esc(dateTime(s.from))} → ${esc(dateTime(s.to))}</li>`).join('')}</ul>`
                : `<div class="muted">${esc(t('fleet.nothing30'))}</div>`}
            </div>
            ${vehicles.lastLine(car)}
            ${vehicles.cardBlock(car)}
          </div>` : ''}
      </article>`;
  }

  /* -------------------------------------------------------------- Calendar */

  function renderCalendar() {
    if (!state.fleet) return loadingBox();
    const days = state.calDays;
    const start = bangkokDayStart();
    const end = start + days * DAY_MS;
    // На телефоне — прокрутка вбок, на компьютере — растягиваем на всю ширину
    const minDay = days <= 7 ? 64 : days <= 14 ? 44 : 30;
    const available = ($('#view').clientWidth || 360) - 32 - 130;
    const dayWidth = Math.max(minDay, Math.floor(available / days));
    const width = days * dayWidth;
    const x = (ms) => ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * width;

    const dayCells = Array.from({ length: days }, (_, i) => {
      const dayMs = start + i * DAY_MS;
      const local = new Date(dayMs + TZ_OFFSET_MS);
      const weekday = local.getUTCDay();
      return { i, local, weekend: weekday === 0 || weekday === 6 };
    });
    const daysBg = dayCells.map((d) => `<div class="cal__day${d.weekend ? ' cal__day--weekend' : ''}" style="left:${d.i * dayWidth}px;width:${dayWidth}px"></div>`).join('');
    const nowX = x(Date.now());

    const header = `
      <div class="cal__row cal__head">
        <div class="cal__label">${esc(t('cal.vehicle'))}</div>
        <div class="cal__track" style="width:${width}px">
          ${dayCells.map((d) => `
            <div class="cal__date${d.i === 0 ? ' cal__date--today' : ''}" style="left:${d.i * dayWidth}px;width:${dayWidth}px">
              <b>${d.local.getUTCDate()}</b><span>${days <= 14 ? esc(fmtWeekday.format(d.local)) : ''}</span>
            </div>`).join('')}
        </div>
      </div>`;

    const list = filteredCars();
    const groups = [...Object.keys(TYPES), null].map((type) => ({ type, cars: list.filter((c) => (c.type || null) === type) })).filter((g) => g.cars.length);

    const rows = groups.map((g) => `
      <div class="cal__group" style="width:${width + 128}px">${esc(g.type ? TYPES[g.type] : t('cal.notMatched'))} · ${g.cars.length}</div>
      ${g.cars.map((car) => `
        <div class="cal__row">
          <div class="cal__label"><b>${esc(carName(car))}</b><span class="muted">${esc(car.plate)}</span></div>
          <div class="cal__track" style="width:${width}px">
            ${daysBg}
            ${car.segments.filter((s) => Date.parse(s.to) > start && Date.parse(s.from) < end).map((s) => {
              const left = x(Date.parse(s.from));
              const w = Math.max(x(Date.parse(s.to)) - left, 4);
              return `<div class="bar bar--${s.kind}" style="left:${left}px;width:${w}px" title="${esc(`${STATUS[s.kind]}: ${dateTime(s.from)} → ${dateTime(s.to)}`)}"></div>`;
            }).join('')}
            <div class="now-line" style="left:${nowX}px"></div>
          </div>
        </div>`).join('')}`).join('');

    const ranges = [7, 14, 30].map((n) => `<button type="button" class="chip" data-days="${n}" aria-pressed="${days === n}">${esc(tn('n.days', n))}</button>`).join('');

    return `
      ${renderFilters({ withStatus: false })}
      <div class="chips" style="margin-bottom:10px">${ranges}</div>
      ${list.length ? `<div class="cal"><div class="cal__grid">${header}${rows}</div></div>` : nothingFound()}
      <div class="legend">
        <span><i style="background:var(--rent)"></i>${esc(t('cal.rental'))}</span>
        <span><i style="background:var(--reserve)"></i>${esc(t('cal.booking'))}</span>
        <span><i style="background:repeating-linear-gradient(135deg,var(--service),var(--service) 3px,transparent 3px,transparent 6px);border:1px solid var(--service)"></i>${esc(t('cal.service'))}</span>
        <span><i style="background:var(--brand);width:3px"></i>${esc(t('cal.now'))}</span>
      </div>`;
  }

  /* -------------------------------------------------------------- Requests */

  function renderRequests() {
    const archivedCount = state.requests.filter((r) => r.archived).length;
    const filters = ['all', 'new', 'taken', ...(archivedCount ? ['archive'] : [])].map((id) =>
      `<button type="button" class="chip" data-req="${id}" aria-pressed="${state.reqFilter === id}">${esc(t(`req.${id}`))}${id === 'new' && newRequestsCount() ? ` · ${newRequestsCount()}` : id === 'archive' ? ` · ${archivedCount}` : ''}</button>`).join('');
    // Архив — отдельно; в остальных списках заявок из архива нет
    const list = state.requests.filter((r) => (state.reqFilter === 'archive'
      ? r.archived
      : !r.archived && (state.reqFilter === 'all' || r.status === state.reqFilter)));

    return `
      <div class="chips" style="margin-bottom:12px">${filters}</div>
      ${state.reqMsg ? `<p class="md-status is-error" role="status">${esc(state.reqMsg)}</p>` : ''}
      ${state.reqFilter === 'archive' ? `<p class="muted" style="margin:0 0 10px">${esc(t('req.archiveHint'))}</p>` : ''}
      <div class="list">
        ${list.length ? list.map(renderRequest).join('') : `<div class="empty">${esc(t('req.none'))}</div>`}
      </div>`;
  }

  function renderRequest(r) {
    const phoneDigits = String(r.clientPhone || '').replace(/\D/g, '');
    const what = r.kind === 'question' ? `💬 ${t('req.questionLine')}` : [TYPE_ONE[r.vehicleType], r.model].filter(Boolean).join(' · ');
    const days = r.dateFrom && r.dateTo ? daysBetween(r.dateFrom, r.dateTo) : null;
    return `
      <article class="card req">
        <div class="req__head">
          <span class="req__id">#${r.id}</span>
          <span class="pill pill--${r.status === 'new' ? 'new' : 'taken'}">${esc(r.status === 'new' ? t('req.newPill') : t('req.takenBy', { name: r.takenBy || '' }))}</span>
          ${r.kind === 'question' ? `<span class="pill">${esc(t('ov.question'))}</span>` : ''}
          ${r.archived ? `<span class="pill">${esc(t('req.archivedPill'))}</span>` : ''}
          <span class="muted" style="font-size:13px">${esc(CHANNELS[r.channel] || r.channel)}${r.lang ? ` · ${esc(LANGS[r.lang] || r.lang)}` : ''}</span>
          <span class="req__time">${esc(dateTime(r.createdAt))}</span>
        </div>
        ${what ? `<div class="req__line"><b>${esc(what)}</b></div>` : ''}
        ${r.dateFrom ? `<div class="req__line">📅 ${esc(shortDate(r.dateFrom))} – ${esc(shortDate(r.dateTo))} · ${esc(tn('n.days', days))}${r.estimateThb ? ` · ≈ ${esc(money(r.estimateThb))}` : ''}</div>` : ''}
        <div class="req__line">👤 ${esc(r.clientName || '—')}${r.clientPhone ? ` · ${esc(r.clientPhone)}` : ''}</div>
        ${r.freeUnits ? `<div class="req__line muted">${esc(t('req.freePlates', { list: r.freeUnits }))}</div>` : ''}
        ${r.comment ? `<div class="req__line">💬 ${esc(r.comment).replace(/\n/g, '<br>')}</div>` : ''}
        ${r.declinedBy.length ? `<div class="req__line muted">${esc(t('req.cant', { names: r.declinedBy.join(', ') }))}</div>` : ''}
        ${phoneDigits || state.canManageRequests ? `
          <div class="req__actions">
            ${phoneDigits ? `<a class="btn btn--small" href="tel:+${phoneDigits}">${esc(t('req.call'))}</a>
            <a class="btn btn--small" href="https://wa.me/${phoneDigits}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
            ${state.canManageRequests ? `
            <button type="button" class="btn btn--small" data-req-archive="${r.id}" data-on="${r.archived ? '0' : '1'}">${esc(r.archived ? t('req.restore') : t('req.toArchive'))}</button>
            <button type="button" class="btn btn--small btn--danger-text" data-req-delete="${r.id}">${esc(t('req.delete'))}</button>` : ''}
          </div>` : ''}
      </article>`;
  }


  /* --------------------------------------------- Website: фото и описания */

  async function loadModels() {
    try {
      const data = await api('/models');
      state.models = data.models || [];
      state.canEdit = Boolean(data.canEdit);
      state.maxGallery = data.maxGallery || 12;
      if (state.tab === 'site') render();
    } catch (err) {
      if (err.status === 401) return showLogin('email', err.code === 'no_access' ? ERRORS.no_access : '');
      showDataError(t('site.loadFailed'));
    }
  }

  const isPhotoFill = (photo) => /\.jpe?g$/i.test(photo || '');
  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };

  function filteredModels() {
    const q = state.filters.q.trim().toLowerCase();
    return (state.models || []).filter((m) => (state.filters.type === 'all' || m.type === state.filters.type)
      && (!q || m.model.toLowerCase().includes(q)));
  }

  function renderSite() {
    if (!state.models) return loadingBox();
    const list = filteredModels();
    const noPhoto = state.models.filter((m) => m.onSite && !m.photo).length;
    const typeChips = [['all', t('filter.allTypes')], ...Object.entries(TYPES)].map(([id, label]) =>
      `<button type="button" class="chip" data-filter="type" data-value="${id}" aria-pressed="${state.filters.type === id}">${esc(label)}</button>`).join('');
    return `
      <div class="toolbar">
        <input class="search" type="search" placeholder="${esc(t('site.search'))}" value="${esc(state.filters.q)}" data-search autocomplete="off" />
        <div class="chips">${typeChips}</div>
      </div>
      <div class="result-count">${esc(tn('n.models', list.length))}${noPhoto ? ` · <span class="warn">${esc(t('site.noPhoto', { n: noPhoto }))}</span>` : ''}${state.canEdit ? '' : ` · ${esc(t('site.viewOnly'))}`}</div>
      <div class="mgrid">${list.length ? list.map(renderModelCard).join('') : nothingFound()}</div>`;
  }

  function renderModelCard(m) {
    const change = m.lastChange ? esc(t('site.editedBy', { name: m.lastChange.by, date: dateTime(m.lastChange.at) })) : '';
    return `
      <article class="card mcard">
        <div class="mframe${isPhotoFill(m.photo) ? ' is-photo' : ''}">
          ${m.photo ? `<img src="${esc(m.photo)}" alt="${esc(m.model)}" loading="lazy" />` : `<span class="mframe__empty">${TYPE_ICON[m.type] || '🚘'}</span>`}
        </div>
        <div class="mcard__body">
          <div class="mcard__title">${esc(m.model)}</div>
          <div class="mcard__desc">${m.descriptions?.[lang] || m.description ? esc(m.descriptions?.[lang] || m.description) : `<span class="muted">${esc(t('site.noDesc'))}</span>`}</div>
          <div class="mcard__meta">${esc(TYPE_ONE[m.type] || '—')} · ${esc(t('site.inFleet', { n: m.units }))}${m.gallery?.length ? ` · 📷 ${esc(tn('n.photos', m.gallery.length + 1))}` : ''}</div>
          ${m.onSite ? '' : `<div><span class="tag">${esc(t('site.notOnSite'))}</span></div>`}
          ${change ? `<div class="mcard__meta">${change}</div>` : ''}
          ${state.canEdit ? `<button type="button" class="btn btn--small" data-edit-model="${esc(m.model)}">${esc(t('site.edit'))}</button>` : ''}
        </div>
      </article>`;
  }

  /* Фото готовим в браузере: уменьшаем, по желанию убираем белый фон,
     обрезаем пустые края. На сервер уходит готовый файл: webp/png — техника
     целиком в рамке, jpg — фото на всю карточку (как на сайте). */

  const MAX_SOURCE = 1600; // сначала уменьшаем огромные фото с телефона (результат — до 1280–1600 px)
  const CUTOUT_BOX = { w: 1280, h: 880 };
  const PHOTO_MAX_W = 1600;
  const MAX_UPLOAD = 4 * 1024 * 1024;

  async function decodeFile(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch { /* ниже — запасной способ */ }
    }
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }

  function toCanvas(source, maxSide) {
    const w = source.width;
    const h = source.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** Есть ли прозрачность и белые ли углы (тогда фото «вырезанное») */
  function analyze(canvas) {
    const { width: w, height: h } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) transparent++;
    const white = (x, y) => { const i = (y * w + x) * 4; return data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238; };
    const corners = [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]].filter(([x, y]) => white(Math.max(0, x), Math.max(0, y))).length;
    return { hasAlpha: transparent > (data.length / 28) * 0.01, whiteCorners: corners >= 3 };
  }

  /** Белый фон, соединённый с краями, становится прозрачным (заливка от краёв) */
  function removeWhite(canvas) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const isBg = (p) => {
      const i = p * 4;
      const max = Math.max(d[i], d[i + 1], d[i + 2]);
      return d[i + 3] > 0 && Math.min(d[i], d[i + 1], d[i + 2]) >= 236 && max - Math.min(d[i], d[i + 1], d[i + 2]) < 14;
    };
    // Очередь на типизированном массиве: каждый пиксель попадает в неё один раз
    const bg = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    const visit = (p) => { if (!bg[p] && isBg(p)) { bg[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p < w * (h - 1)) visit(p + w);
    }
    for (let p = 0; p < w * h; p++) {
      if (bg[p]) { d[p * 4 + 3] = 0; continue; }
      // Мягкий край: светлые пиксели рядом с вырезанным фоном — полупрозрачные
      const x = p % w;
      const nearBg = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (p >= w && bg[p - w]) || (p < w * (h - 1) && bg[p + w]);
      if (nearBg && (d[p * 4] + d[p * 4 + 1] + d[p * 4 + 2]) / 3 > 200) d[p * 4 + 3] = Math.round(d[p * 4 + 3] * 0.5);
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Обрезать прозрачные края и оставить 3% воздуха вокруг техники */
  function trim(canvas) {
    const { width: w, height: h } = canvas;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return canvas;
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1 + pad * 2;
    out.height = y1 - y0 + 1 + pad * 2;
    out.getContext('2d').drawImage(canvas, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
    return out;
  }

  function fitInto(canvas, maxW, maxH) {
    const k = Math.min(1, maxW / canvas.width, maxH / canvas.height);
    if (k === 1) return canvas;
    const out = document.createElement('canvas');
    out.width = Math.round(canvas.width * k);
    out.height = Math.round(canvas.height * k);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  function processPhoto() {
    const ed = state.editing;
    if (!ed?.source) return;
    let result;
    if (ed.mode === 'cutout') {
      const work = toCanvas(ed.source, MAX_SOURCE);
      if (ed.removeWhite && !ed.info.hasAlpha) removeWhite(work);
      result = fitInto(trim(work), CUTOUT_BOX.w, CUTOUT_BOX.h);
    } else {
      // Фото на всю карточку — без прозрачности, на белом фоне
      const work = toCanvas(ed.source, MAX_SOURCE);
      const flat = document.createElement('canvas');
      flat.width = work.width;
      flat.height = work.height;
      const ctx = flat.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(work, 0, 0);
      result = fitInto(flat, PHOTO_MAX_W, PHOTO_MAX_W);
    }
    ed.result = result;
    const preview = $('#md-canvas');
    preview.width = result.width;
    preview.height = result.height;
    preview.getContext('2d').drawImage(result, 0, 0);
    preview.hidden = false;
    $('#md-current').hidden = true;
    $('#md-empty').hidden = true;
    $('#md-frame').classList.toggle('is-photo', ed.mode === 'photo');
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === ed.mode)));
    $('#md-white-wrap').hidden = ed.mode !== 'cutout' || ed.info.hasAlpha;
  }

  function encode(canvas, mode, quality = 0.86) {
    const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
    if (mode === 'photo') return toBlob('image/jpeg', quality);
    // Не все браузеры умеют сохранять webp (старый Safari) — тогда png
    return toBlob('image/webp', 0.88).then((blob) => (blob && blob.type === 'image/webp' ? blob : toBlob('image/png')));
  }

  /* Галерея: обычные фото уменьшаем до 1280 px (jpg), прозрачные — как
     главное фото (webp). К каждому — миниатюра для ряда под каруселью. */

  const GALLERY_MAX = 1280;
  const THUMB_BOX = { w: 320, h: 220 };

  async function galleryItem(file) {
    const source = await decodeFile(file);
    const { hasAlpha } = analyze(toCanvas(source, 400));
    const mode = hasAlpha ? 'cutout' : 'photo';
    let result;
    if (hasAlpha) {
      result = fitInto(trim(toCanvas(source, MAX_SOURCE)), CUTOUT_BOX.w, CUTOUT_BOX.h);
    } else {
      const work = toCanvas(source, GALLERY_MAX);
      result = document.createElement('canvas');
      result.width = work.width;
      result.height = work.height;
      const ctx = result.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, result.width, result.height);
      ctx.drawImage(work, 0, 0);
    }
    source.close?.();
    const blob = await encode(result, mode, 0.82);
    const thumb = await encode(fitInto(result, THUMB_BOX.w, THUMB_BOX.h), mode, 0.8);
    if (!blob) throw new Error('encode');
    return { src: '', blob, thumb, preview: URL.createObjectURL(blob), full: mode === 'photo' };
  }

  const itemImage = (item) => item.preview || item.src;
  const isLocal = (src) => /^\/(img|uploads)\//.test(src || '');

  function renderGallery() {
    const ed = state.editing;
    if (!ed) return;
    const last = ed.gallery.length - 1;
    $('#md-gcount').textContent = t('md.count', { n: ed.gallery.length, max: state.maxGallery || 12 });
    $('#md-ggrid').innerHTML = ed.gallery.map((item, i) => {
      const src = itemImage(item);
      const picture = item.preview || isLocal(src)
        ? `<img src="${esc(src)}" alt="" loading="lazy" />`
        : `<span class="md-gitem__link">🔗 ${esc(src)}</span>`;
      return `
        <div class="md-gitem">
          <div class="mframe${item.full ? ' is-photo' : ''}">${picture}${item.src ? '' : `<span class="md-gitem__new">${esc(t('md.new'))}</span>`}</div>
          <div class="md-gitem__tools">
            <button type="button" data-gmove="-1" data-i="${i}" aria-label="${esc(t('md.left'))}"${i === 0 ? ' disabled' : ''}>◀</button>
            <button type="button" data-gmain data-i="${i}" aria-label="${esc(t('md.main'))}" title="${esc(t('md.main'))}">★</button>
            <button type="button" data-gmove="1" data-i="${i}" aria-label="${esc(t('md.right'))}"${i === last ? ' disabled' : ''}>▶</button>
            <button type="button" data-gdel data-i="${i}" aria-label="${esc(t('md.remove'))}" title="${esc(t('md.remove'))}">✕</button>
          </div>
        </div>`;
    }).join('');
  }

  /** Главное фото в рамке сверху: уже сохранённое или выбранное из галереи */
  function showMain() {
    const ed = state.editing;
    const src = ed.main ? itemImage(ed.main) : '';
    const current = $('#md-current');
    current.hidden = !src;
    if (src) current.src = src;
    $('#md-canvas').hidden = true;
    $('#md-empty').hidden = Boolean(src);
    $('#md-frame').classList.toggle('is-photo', Boolean(ed.main?.full));
  }

  async function addGalleryFiles(files) {
    const ed = state.editing;
    if (!ed || !files.length) return;
    const room = (state.maxGallery || 12) - ed.gallery.length;
    const list = [...files].slice(0, Math.max(0, room));
    let failed = 0;
    for (const [i, file] of list.entries()) {
      setModelStatus(t('md.preparingN', { i: i + 1, n: list.length }));
      try {
        const item = await galleryItem(file);
        if (state.editing !== ed) return URL.revokeObjectURL(item.preview);
        ed.gallery.push(item);
        ed.galleryChanged = true;
        renderGallery();
      } catch {
        failed++;
      }
    }
    const notes = [];
    if (files.length > list.length) notes.push(t('md.onlyFit', { max: state.maxGallery || 12 }));
    if (failed) notes.push(t('md.failedFiles', { n: failed }));
    setModelStatus(notes.join(' ') || t('md.added'), notes.length ? 'error' : '');
  }

  function galleryAction(button) {
    const ed = state.editing;
    const i = Number(button.dataset.i);
    const item = ed?.gallery[i];
    if (!item) return;
    if (button.dataset.gmove) {
      const j = i + Number(button.dataset.gmove);
      if (j < 0 || j >= ed.gallery.length) return;
      [ed.gallery[i], ed.gallery[j]] = [ed.gallery[j], item];
    } else if ('gmain' in button.dataset) {
      // Прежнее главное фото встаёт на место выбранного; новое, ещё не сохранённое главное — отменяется
      ed.gallery.splice(i, 1, ...(ed.main ? [ed.main] : []));
      ed.main = item;
      ed.source = null;
      ed.result = null;
      $('#md-file').value = '';
      $('#md-options').hidden = true;
      showMain();
    } else if ('gdel' in button.dataset) {
      ed.gallery.splice(i, 1);
      if (item.preview) URL.revokeObjectURL(item.preview);
    }
    ed.galleryChanged = true;
    renderGallery();
  }

  async function uploadImage(url, blob) {
    if (blob.size > MAX_UPLOAD) throw Object.assign(new Error(), { code: 'body_too_large' });
    const response = await fetch(`${API}${url}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(), { status: response.status, code: data.error });
    return data;
  }

  /** Новые фото галереи → на сервер (с миниатюрами), у каждого появляется адрес */
  async function uploadNewPhotos(ed) {
    const pending = [ed.main, ...ed.gallery].filter((item) => item && !item.src);
    for (const [i, item] of pending.entries()) {
      setModelStatus(t('md.uploadingN', { i: i + 1, n: pending.length }));
      const model = encodeURIComponent(ed.model);
      const data = await uploadImage(`/models/photo?model=${model}&gallery=1`, item.blob);
      item.src = data.photo;
      // Без миниатюры сайт покажет в ряду само фото — не повод останавливаться
      if (item.thumb) await uploadImage(`/models/thumb?model=${model}&photo=${encodeURIComponent(item.src)}`, item.thumb).catch(() => {});
    }
  }

  /* Описание на 4 языках: пишут на любом, «Перевести» заполняет остальные по словарю (specs.js) */

  const DESC_LANGS = ['en', 'ru', 'th', 'zh'];
  const descInput = (l) => document.querySelector(`[data-desc="${l}"]`);

  function setDescNote(text, kind = '') {
    const note = $('#md-desc-note');
    note.hidden = !text;
    note.textContent = text;
    note.className = `md-desc__note${kind ? ` is-${kind}` : ''}`;
  }

  /** С какого языка переводить: последнее изменённое поле, иначе первое заполненное */
  function descSource(ed) {
    if (ed.descSource && descInput(ed.descSource).value.trim()) return ed.descSource;
    return [lang, ...DESC_LANGS].find((l) => DESC_LANGS.includes(l) && descInput(l).value.trim()) || null;
  }

  function translateDescription() {
    const ed = state.editing;
    const from = ed && descSource(ed);
    if (!from) return setDescNote(t('md.writeFirst'), 'error');
    const text = descInput(from).value.trim();
    const unknown = new Set();
    for (const l of DESC_LANGS.filter((x) => x !== from)) {
      const result = window.SpecTranslate.translate(text, l);
      descInput(l).value = result.text;
      result.unknown.forEach((w) => unknown.add(w));
    }
    ed.descSource = from;
    setDescNote(unknown.size ? t('md.unknown', { words: [...unknown].join(', ') }) : t('md.translated'), unknown.size ? 'warn' : 'ok');
  }

  /** Тексты для сохранения; пустые языки заполняем сами, если словарь знает все слова */
  function collectDescriptions(ed) {
    const values = Object.fromEntries(DESC_LANGS.map((l) => [l, descInput(l).value.trim()]));
    const from = descSource(ed);
    if (from) {
      for (const l of DESC_LANGS.filter((x) => !values[x])) {
        const result = window.SpecTranslate.translate(values[from], l);
        if (!result.unknown.length) values[l] = result.text;
      }
    }
    return values;
  }

  function setModelStatus(text, kind = '') {
    const box = $('#md-status');
    box.textContent = text;
    box.className = `md-status${kind ? ` is-${kind}` : ''}`;
  }

  function openModel(name) {
    const m = (state.models || []).find((x) => x.model === name);
    if (!m) return;
    state.editing = {
      model: m.model, source: null, result: null, mode: 'cutout', removeWhite: true, info: null,
      main: m.photo ? { src: m.photo, full: isPhotoFill(m.photo) } : null,
      gallery: (m.gallery || []).map((src) => ({ src, full: isPhotoFill(src) })),
      galleryChanged: false
    };
    $('#md-title').textContent = m.model;
    $('#md-type').textContent = TYPE_ONE[m.type] || '';
    const descriptions = m.descriptions || { en: m.description };
    document.querySelectorAll('[data-desc]').forEach((input) => { input.value = descriptions[input.dataset.desc] || ''; });
    setDescNote('');
    $('#md-file').value = '';
    $('#md-options').hidden = true;
    $('#md-gfile').value = '';
    showMain();
    renderGallery();
    setModelStatus('');
    $('#model-dialog').showModal();
  }

  async function choosePhoto(file) {
    const ed = state.editing;
    if (!ed || !file) return;
    setModelStatus(t('md.preparing'));
    try {
      ed.source = await decodeFile(file);
      ed.info = analyze(toCanvas(ed.source, 400));
      // Прозрачный или белый фон — техника целиком в рамке, иначе — фото на всю карточку
      ed.mode = ed.info.hasAlpha || ed.info.whiteCorners ? 'cutout' : 'photo';
      ed.removeWhite = true;
      $('#md-white').checked = true;
      $('#md-options').hidden = false;
      processPhoto();
      setModelStatus('');
    } catch {
      ed.source = null;
      setModelStatus(t('md.badFile'), 'error');
    }
  }

  async function saveModel() {
    const ed = state.editing;
    const m = (state.models || []).find((x) => x.model === ed?.model);
    if (!ed || !m) return;
    const button = $('#md-save');
    button.disabled = true;
    try {
      await uploadNewPhotos(ed);
      if (ed.result) {
        setModelStatus(t('md.uploadingMain'));
        const blob = await encode(ed.result, ed.mode);
        if (!blob) throw Object.assign(new Error(), { code: 'bad_image' });
        const data = await uploadImage(`/models/photo?model=${encodeURIComponent(ed.model)}`, blob);
        m.photo = data.photo;
        ed.main = { src: data.photo, full: ed.mode === 'photo' };
        ed.result = null;
      }
      if (ed.galleryChanged) {
        setModelStatus(t('md.savingOrder'));
        const data = await api('/models/gallery', { body: { model: ed.model, photo: ed.main?.src || '', gallery: ed.gallery.map((item) => item.src) } });
        m.photo = data.photo;
        m.gallery = data.gallery;
        ed.galleryChanged = false;
      }
      const descriptions = collectDescriptions(ed);
      const saved = m.descriptions || { en: m.description || '' };
      if (DESC_LANGS.some((l) => descriptions[l] !== (saved[l] || ''))) {
        setModelStatus(t('md.savingDesc'));
        const data = await api('/models/description', { body: { model: ed.model, descriptions } });
        m.descriptions = { ...saved, ...data.descriptions };
        m.description = m.descriptions.en;
      }
      setModelStatus(t('md.saved'), 'ok');
      render();
      loadModels();
      setTimeout(() => { if ($('#model-dialog').open && !state.editing?.result && !state.editing?.galleryChanged) $('#model-dialog').close(); }, 1200);
    } catch (err) {
      if (err.status === 401) { $('#model-dialog').close(); return showLogin('email'); }
      setModelStatus(ERRORS[err.code] || t('md.saveFailed'), 'error');
    } finally {
      button.disabled = false;
    }
  }

  function bindModelDialog() {
    const dialog = $('#model-dialog');
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('[data-close]')) return dialog.close();
      const mode = event.target.closest('[data-mode]');
      if (mode && state.editing?.source) {
        state.editing.mode = mode.dataset.mode;
        processPhoto();
      }
    });
    $('#md-file').addEventListener('change', (event) => choosePhoto(event.target.files[0]));
    $('#md-gfile').addEventListener('change', (event) => {
      const files = [...event.target.files];
      event.target.value = ''; // те же файлы можно будет выбрать ещё раз
      addGalleryFiles(files);
    });
    $('#md-ggrid').addEventListener('click', (event) => {
      const button = event.target.closest('[data-gmove], [data-gmain], [data-gdel]');
      if (button) galleryAction(button);
    });
    $('#md-translate').addEventListener('click', translateDescription);
    document.querySelectorAll('[data-desc]').forEach((input) => input.addEventListener('input', () => {
      if (state.editing) state.editing.descSource = input.dataset.desc;
    }));
    $('#md-white').addEventListener('change', (event) => {
      if (!state.editing) return;
      state.editing.removeWhite = event.target.checked;
      processPhoto();
    });
    $('#model-form').addEventListener('submit', (event) => {
      event.preventDefault();
      saveModel();
    });
    dialog.addEventListener('close', () => {
      for (const item of [state.editing?.main, ...(state.editing?.gallery || [])]) if (item?.preview) URL.revokeObjectURL(item.preview);
      state.editing = null;
    });
  }

  /* --------------------------------------------------------------- События */

  function bindApp() {
    document.addEventListener('click', (event) => {
      if (state.tab === 'journal' && journal.onClick(event)) return;
      if (state.tab === 'access' && access.onClick(event)) return;
      if (state.tab === 'finance' && finance.onClick(event)) return;
      if (state.tab === 'crm' && crm.onClick(event)) return;
      if (state.tab === 'marketing' && marketing.onClick(event)) return;
      if (state.tab === 'price' && price.onClick(event)) return;
      if (state.tab === 'tickets' && tickets.onClick(event)) return;
      if (state.tab === 'cabinet' && cabinet.onClick(event)) return;
      if (event.target.closest('[data-more]')) {
        state.moreOpen = !state.moreOpen;
        return renderTabs();
      }
      const install = event.target.closest('[data-install]');
      if (install) return onInstall(install.dataset.install);
      if (state.moreOpen && !event.target.closest('.tabs-more')) {
        state.moreOpen = false;
        renderTabs();
      }
      const langButton = event.target.closest('[data-lang]');
      if (langButton) return setLang(langButton.dataset.lang);
      const tab = event.target.closest('[data-tab]');
      if (tab) return setTab(tab.dataset.tab);
      const problem = event.target.closest('[data-problem]');
      if (problem) {
        if (problem.dataset.problem === 'journal') {
          setTab('journal');
          return journal.show({ plate: problem.dataset.q || '' });
        }
        if (problem.dataset.problem === 'price') {
          price.show({ q: problem.dataset.q || '' });
          return setTab('price');
        }
        state.filters = { q: problem.dataset.q || '', type: 'all', status: 'all' };
        if (problem.dataset.problem === 'requests') state.reqFilter = 'new';
        return setTab(problem.dataset.problem);
      }
      const pcat = event.target.closest('[data-pcat]');
      if (pcat) {
        state.problemCat = pcat.dataset.pcat;
        return render();
      }
      const pmore = event.target.closest('[data-pmore]');
      if (pmore) {
        const c = pmore.dataset.pmore;
        if (state.openCats.has(c)) state.openCats.delete(c);
        else state.openCats.add(c);
        return render();
      }
      const goto = event.target.closest('[data-goto]');
      if (goto) {
        state.reqFilter = 'new';
        return setTab(goto.dataset.goto);
      }
      const chip = event.target.closest('[data-filter]');
      if (chip) {
        state.filters[chip.dataset.filter] = chip.dataset.value;
        return render();
      }
      const range = event.target.closest('[data-days]');
      if (range) {
        state.calDays = Number(range.dataset.days);
        return render();
      }
      const reqArchive = event.target.closest('[data-req-archive]');
      const reqDelete = event.target.closest('[data-req-delete]');
      if (reqArchive || reqDelete) {
        const id = Number((reqArchive || reqDelete).dataset.reqArchive || (reqArchive || reqDelete).dataset.reqDelete);
        if (reqDelete && !window.confirm(t('req.deleteConfirm', { id }))) return undefined;
        const body = reqDelete ? { id } : { id, archived: reqArchive.dataset.on === '1' };
        api(reqDelete ? '/requests/delete' : '/requests/archive', { body })
          .then(() => { state.reqMsg = null; return loadData(); })
          .catch(() => { state.reqMsg = t('req.actionFailed'); render(); });
        return undefined;
      }
      const req = event.target.closest('[data-req]');
      if (req) {
        state.reqFilter = req.dataset.req;
        return render();
      }
      const edit = event.target.closest('[data-edit-model]');
      if (edit) return openModel(edit.dataset.editModel);
      if (state.tab === 'fleet' && vehicles.onClick(event)) return;
      // Формы внутри карточки машины не сворачивают её
      if (event.target.closest('.vh-actions')) return;
      const car = event.target.closest('[data-car]');
      if (car && !event.target.closest('a')) {
        const id = Number(car.dataset.car);
        if (state.expanded.has(id)) state.expanded.delete(id);
        else state.expanded.add(id);
        return render();
      }
    });

    document.addEventListener('change', (event) => {
      if (state.tab === 'journal') journal.onChange(event);
      if (state.tab === 'access') access.onChange(event);
      if (state.tab === 'finance') finance.onChange(event);
      if (state.tab === 'crm') crm.onChange(event);
      if (state.tab === 'price') price.onChange(event);
      if (state.tab === 'tickets') tickets.onChange(event);
      if (state.tab === 'cabinet') cabinet.onChange(event);
      vehicles.onChange(event);
    });
    // Ctrl+V скриншота на вкладке «Ошибки и предложения»
    document.addEventListener('paste', (event) => {
      if (state.tab === 'tickets') tickets.onPaste(event);
    });
    // Ссылка вида …/#journal или кнопки «назад/вперёд» — открыть эту вкладку
    window.addEventListener('hashchange', () => {
      const id = location.hash.slice(1);
      if (state.user && id !== state.tab && tabs().some((tab) => tab.id === id)) setTab(id);
    });
    setInterval(() => { if (state.tab === 'journal') journal.tick(); }, 5000);
    document.addEventListener('input', (event) => {
      if (state.tab === 'journal' && journal.onInput(event)) return;
      if (state.tab === 'crm' && crm.onInput(event)) return;
      if (state.tab === 'price' && price.onInput(event)) return;
      if (state.tab === 'tickets' && tickets.onInput(event)) return;
      if (state.tab === 'cabinet' && cabinet.onInput(event)) return;
      if (!event.target.matches('[data-search]')) return;
      state.filters.q = event.target.value;
      const caret = event.target.selectionStart;
      render();
      const input = document.querySelector('[data-search]');
      input.focus();
      input.setSelectionRange(caret, caret);
    });

    $('#refresh').addEventListener('click', () => {
      loadData();
      if (state.tab === 'site') loadModels();
      if (state.tab === 'server') loadServer();
      if (state.tab === 'journal') journal.load();
    });
    document.addEventListener('submit', (event) => {
      if (state.tab === 'journal' && journal.onSubmit(event)) return;
      if (state.tab === 'access' && access.onSubmit(event)) return;
      if (state.tab === 'finance' && finance.onSubmit(event)) return;
      if (state.tab === 'crm' && crm.onSubmit(event)) return;
      if (state.tab === 'marketing' && marketing.onSubmit(event)) return;
      if (state.tab === 'price' && price.onSubmit(event)) return;
      if (state.tab === 'tickets' && tickets.onSubmit(event)) return;
      if (state.tab === 'cabinet' && cabinet.onSubmit(event)) return;
      // Окно карточки техники («Парк»)
      if (vehicles.onSubmit(event)) return;
      if (event.target.id !== 'srv-settings') return;
      event.preventDefault();
      saveServerSettings(event.target);
    });
    bindModelDialog();
    $('#logout').addEventListener('click', async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      state.fleet = null;
      state.server = null;
      stopServerPolling();
      showLogin('email');
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) loadData(); });
  }

  /* ----------------------------------------------------------------- Старт */

  async function init() {
    // Нужен, чтобы телефон предлагал установить портал как приложение
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    applyStatic();
    bindLogin();
    bindApp();
    try {
      const data = await api('/me');
      clearPending();
      state.user = data.user;
      startApp();
    } catch {
      state.loginEmail = pendingEmail();
      showLogin(state.loginEmail ? 'code' : 'email');
    }
  }

  init();
})();
