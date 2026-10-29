/**
 * ============================================================================
 * JetRental Staff — сайт сотрудников
 * ============================================================================
 * Экраны: вход (почта → код) и 5 вкладок: Overview, Fleet, Calendar, Requests,
 * Website (фото и описания моделей для сайта — менять могут роли Editor/Admin).
 * Данные: GET /api/staff/fleet (снимок Автопроката, обновляется на сервере
 * раз в 10 минут), GET /api/staff/requests, GET /api/staff/models.
 * Время показываем по Бангкоку. Языки: английский, русский, тайский
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

  /* ---------------------------------------------------------------- Языки */

  const I18N = window.STAFF_I18N;
  const LANG_KEY = 'jr_staff_lang';
  const LANG_NAMES = { en: 'English', ru: 'Русский', th: 'ไทย' };
  const LANG_SHORT = { en: 'EN', ru: 'RU', th: 'ไทย' };
  // Тайская локаль — с обычным календарём (по умолчанию в ней буддийский год)
  const LOCALES = { en: 'en-GB', ru: 'ru-RU', th: 'th-TH-u-ca-gregory' };

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
  const CHANNELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', get site() { return t('channel.site'); } };
  const LANGS = { en: '🇬🇧 EN', ru: '🇷🇺 RU', th: '🇹🇭 TH', zh: '🇨🇳 ZH' };
  const ERRORS = labels('err', [
    'invalid_email', 'invalid_code', 'too_many_attempts', 'wait_a_minute', 'too_many_codes', 'too_many_requests',
    'mail_not_configured', 'mail_failed', 'no_access', 'read_only', 'model_not_found', 'bad_image', 'image_required',
    'too_many_uploads', 'body_too_large', 'unknown_photo', 'too_many_photos', 'sheets_not_configured'
  ]);

  const ICONS = {
    overview: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
    fleet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.92 6.01A1.5 1.5 0 0 0 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8l-2.08-5.99zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11H5z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM7 12h5v5H7z"/></svg>',
    requests: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>',
    site: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>'
  };
  const TABS = ['overview', 'fleet', 'calendar', 'requests', 'site'].map((id) => ({ id, get title() { return t(`tab.${id}`); } }));

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
    allProblems: false
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

  function relative(iso) {
    const diff = Date.parse(iso) - Date.now();
    const hours = Math.round(diff / 3600000);
    if (Math.abs(hours) < 1) return t('rel.withinHour');
    if (Math.abs(hours) < 36) return hours > 0 ? t('rel.inHours', { n: hours }) : t('rel.hoursAgo', { n: -hours });
    const days = Math.round(diff / DAY_MS);
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
    $('#who').textContent = state.user?.name || state.user?.email || '';
    const fromHash = location.hash.slice(1);
    if (TABS.some((tab) => tab.id === fromHash)) state.tab = fromHash;
    renderTabs();
    render();
    loadData();
    if (state.tab === 'site') loadModels();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) loadData(); }, REFRESH_MS);
  }

  async function loadData() {
    try {
      const [fleet, requests, dashboard] = await Promise.all([
        api('/fleet'), api('/requests'),
        // Без проблем и прогноза обзор всё равно покажем
        api(`/dashboard?lang=${lang}`).catch((err) => (err.status === 401 ? Promise.reject(err) : null))
      ]);
      state.fleet = fleet;
      state.requests = requests.requests || [];
      if (dashboard) state.dashboard = dashboard;
      showDataError(fleet.error ? t('app.syncProblem', { error: fleet.error }) : '');
      render();
    } catch (err) {
      if (err.status === 401) return showLogin('email', err.code === 'no_access' ? ERRORS.no_access : '');
      showDataError(t('app.loadFailed'));
    }
  }

  function showDataError(message) {
    $('#data-error').hidden = !message;
    $('#data-error').textContent = message;
  }

  function newRequestsCount() {
    return state.requests.filter((r) => r.status === 'new').length;
  }

  function renderTabs() {
    const count = newRequestsCount();
    const html = TABS.map((tab) => `
      <button type="button" data-tab="${tab.id}" ${state.tab === tab.id ? 'aria-current="page"' : ''}>
        ${ICONS[tab.id]}<span>${esc(tab.title)}</span>
        ${tab.id === 'requests' && count ? `<span class="count">${count}</span>` : ''}
      </button>`).join('');
    document.querySelectorAll('.tabs').forEach((nav) => { nav.innerHTML = html; });
  }

  function setTab(tab) {
    state.tab = tab;
    if (tab === 'site' && !state.models) loadModels();
    history.replaceState(null, '', `#${tab}`);
    renderTabs();
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    const fleet = state.fleet;
    $('#updated').innerHTML = fleet?.updatedAt
      ? `${esc(t('app.dataAt'))} <b>${esc(fmtTime.format(new Date(fleet.updatedAt)))}</b> <span class="muted">(${esc(relative(fleet.updatedAt))})</span>`
      : esc(fleet ? (fleet.enabled ? t('app.loadingWs') : t('app.wsOff')) : t('app.loading'));
    renderTabs();
    const view = $('#view');
    if (state.tab === 'overview') view.innerHTML = renderOverview();
    if (state.tab === 'fleet') view.innerHTML = renderFleet();
    if (state.tab === 'calendar') view.innerHTML = renderCalendar();
    if (state.tab === 'requests') view.innerHTML = renderRequests();
    if (state.tab === 'site') view.innerHTML = renderSite();
  }

  /* --------------------------------------------------------- Данные парка */

  const cars = () => state.fleet?.cars || [];
  const carName = (car) => car.model || car.wsModel || '—';
  const priceOf = (car) => state.fleet?.prices?.[car.model] || null;
  const tariffOf = (car) => state.fleet?.tariffs?.[car.id] || null;
  const seasonName = (name) => (I18N.en[`season.${name}`] ? t(`season.${name}`) : name);
  const tierLabels = () => ['1–2', '3–6', '7–13', '14–30', '31+'].map((range) => `${range} ${t('unit.d')}`);

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

  /** Окно «Проблемы»: сначала ошибки, по нажатию — нужная машина, заявка или модель */
  function renderProblems() {
    const problems = state.dashboard?.problems;
    if (!problems) return '';
    if (!problems.length) return `<div class="ok-line">${esc(t('ov.noProblems'))}</div>`;
    const errors = problems.filter((p) => p.level === 'error').length;
    const shown = state.allProblems ? problems : problems.slice(0, 6);
    const item = (p) => {
      const level = p.level === 'error'
        ? `<span class="problem__level problem__level--error">● ${esc(t('ov.error'))}</span>`
        : `<span class="problem__level problem__level--warning">▲ ${esc(t('ov.warning'))}</span>`;
      const body = `${level}<span class="problem__main"><span class="problem__title">${esc(p.title)}</span><span class="problem__detail">${esc(p.detail || '')}</span></span>`;
      return p.target
        ? `<button type="button" class="problem" data-problem="${esc(p.target.tab)}" data-q="${esc(p.target.q || '')}">${body}<span class="problem__go" aria-hidden="true">›</span></button>`
        : `<div class="problem">${body}</div>`;
    };
    return `
      <section class="card problems" aria-labelledby="problems-title">
        <div class="problems__head">
          <h2 id="problems-title">${esc(t('ov.problems', { n: problems.length }))}</h2>
          <span class="muted">${errors ? `${esc(tn('n.errors', errors))} · ` : ''}${esc(tn('n.warnings', problems.length - errors))}</span>
        </div>
        <div class="problems__list">${shown.map(item).join('')}</div>
        ${problems.length > 6 ? `<button type="button" class="btn btn--small problems__more" data-problems-toggle>${esc(state.allProblems ? t('ov.showLess') : t('ov.showAll', { n: problems.length }))}</button>` : ''}
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
    const typeRows = Object.keys(TYPES).map((type) => `
      <tr><td>${esc(TYPES[type])}</td><td>${count('free', type)}</td><td>${count('rent', type)}</td><td>${count('service', type)}</td><td>${bookedSoon(type)}</td><td><b>${count(null, type)}</b></td></tr>`).join('');

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
    const fresh = state.requests.filter((r) => r.status === 'new');

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
      <h2 class="section-title">${esc(t('ov.rightNow', { vehicles: tn('n.vehicles', all.length) }))}</h2>
      <div class="stats stats--3">${stats}</div>
      ${ahead}

      <h2 class="section-title">${esc(t('ov.byType'))}</h2>
      <div class="card table-wrap">
        <table class="type-table">
          <thead><tr><th></th><th>${esc(STATUS.free)}</th><th>${esc(STATUS.rent)}</th><th>${esc(STATUS.service)}</th><th>${esc(t('ov.booked7'))}</th><th>${esc(t('ov.all'))}</th></tr></thead>
          <tbody>${typeRows}</tbody>
        </table>
      </div>

      <h2 class="section-title">${esc(t('ov.newRequests'))}</h2>
      <div class="card">
        ${fresh.length ? fresh.slice(0, 5).map((r) => `
          <div class="row" data-goto="requests">
            <div class="row__main">
              <div class="row__title">#${r.id} · ${esc(r.model || TYPE_ONE[r.vehicleType] || t('ov.question'))}</div>
              <div class="row__sub">${esc(r.clientName || '')} · ${esc(CHANNELS[r.channel] || r.channel)}</div>
            </div>
            <div class="row__side">${r.dateFrom ? `${esc(shortDate(r.dateFrom))} – ${esc(shortDate(r.dateTo))}` : ''}</div>
          </div>`).join('') : `<div class="empty">${esc(t('ov.noNew'))}</div>`}
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
    const list = filteredCars();
    return `
      ${renderFilters({ withStatus: true })}
      <div class="result-count">${esc(t('fleet.count', { n: list.length, total: cars().length }))}</div>
      <div class="list" style="margin-top:10px">
        ${list.length ? list.map(renderCar).join('') : nothingFound()}
      </div>`;
  }

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
          ${statusPill(car.status)}
        </div>
        <div class="car__meta">
          <span>${freeText(car)}</span>
          ${priceText ? `<span>${esc(t('fleet.price'))} <b>${esc(priceText)}</b></span>` : ''}
          ${deposit ? `<span>${esc(t('fleet.deposit'))} <b>${esc(money(deposit))}</b></span>` : ''}
        </div>
        ${open ? `
          <div class="car__details">
            <dl>
              <dt>${esc(t('fleet.inWs'))}</dt><dd>${esc(car.wsModel)} · ID ${esc(car.id)}</dd>
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
    const filters = ['all', 'new', 'taken'].map((id) =>
      `<button type="button" class="chip" data-req="${id}" aria-pressed="${state.reqFilter === id}">${esc(t(`req.${id}`))}${id === 'new' && newRequestsCount() ? ` · ${newRequestsCount()}` : ''}</button>`).join('');
    const list = state.requests.filter((r) => state.reqFilter === 'all' || r.status === state.reqFilter);

    return `
      <div class="chips" style="margin-bottom:12px">${filters}</div>
      <div class="list">
        ${list.length ? list.map(renderRequest).join('') : `<div class="empty">${esc(t('req.none'))}</div>`}
      </div>`;
  }

  function renderRequest(r) {
    const phoneDigits = String(r.clientPhone || '').replace(/\D/g, '');
    const what = [TYPE_ONE[r.vehicleType], r.model].filter(Boolean).join(' · ');
    const days = r.dateFrom && r.dateTo ? daysBetween(r.dateFrom, r.dateTo) : null;
    return `
      <article class="card req">
        <div class="req__head">
          <span class="req__id">#${r.id}</span>
          <span class="pill pill--${r.status === 'new' ? 'new' : 'taken'}">${esc(r.status === 'new' ? t('req.newPill') : t('req.takenBy', { name: r.takenBy || '' }))}</span>
          <span class="muted" style="font-size:13px">${esc(CHANNELS[r.channel] || r.channel)}${r.lang ? ` · ${esc(LANGS[r.lang] || r.lang)}` : ''}</span>
          <span class="req__time">${esc(dateTime(r.createdAt))}</span>
        </div>
        ${what ? `<div class="req__line"><b>${esc(what)}</b></div>` : ''}
        ${r.dateFrom ? `<div class="req__line">📅 ${esc(shortDate(r.dateFrom))} – ${esc(shortDate(r.dateTo))} · ${esc(tn('n.days', days))}${r.estimateThb ? ` · ≈ ${esc(money(r.estimateThb))}` : ''}</div>` : ''}
        <div class="req__line">👤 ${esc(r.clientName || '—')}${r.clientPhone ? ` · ${esc(r.clientPhone)}` : ''}</div>
        ${r.freeUnits ? `<div class="req__line muted">${esc(t('req.freePlates', { list: r.freeUnits }))}</div>` : ''}
        ${r.comment ? `<div class="req__line">💬 ${esc(r.comment).replace(/\n/g, '<br>')}</div>` : ''}
        ${r.declinedBy.length ? `<div class="req__line muted">${esc(t('req.cant', { names: r.declinedBy.join(', ') }))}</div>` : ''}
        ${phoneDigits ? `
          <div class="req__actions">
            <a class="btn btn--small" href="tel:+${phoneDigits}">${esc(t('req.call'))}</a>
            <a class="btn btn--small" href="https://wa.me/${phoneDigits}" target="_blank" rel="noopener">💬 WhatsApp</a>
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
          <div class="mcard__desc">${m.description ? esc(m.description) : `<span class="muted">${esc(t('site.noDesc'))}</span>`}</div>
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
    $('#md-desc').value = m.description || '';
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
      const description = $('#md-desc').value.trim();
      if (description !== (m.description || '')) {
        setModelStatus(t('md.savingDesc'));
        const data = await api('/models/description', { body: { model: ed.model, description } });
        m.description = data.description;
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
      const langButton = event.target.closest('[data-lang]');
      if (langButton) return setLang(langButton.dataset.lang);
      const tab = event.target.closest('[data-tab]');
      if (tab) return setTab(tab.dataset.tab);
      const problem = event.target.closest('[data-problem]');
      if (problem) {
        state.filters = { q: problem.dataset.q || '', type: 'all', status: 'all' };
        if (problem.dataset.problem === 'requests') state.reqFilter = 'new';
        return setTab(problem.dataset.problem);
      }
      if (event.target.closest('[data-problems-toggle]')) {
        state.allProblems = !state.allProblems;
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
      const req = event.target.closest('[data-req]');
      if (req) {
        state.reqFilter = req.dataset.req;
        return render();
      }
      const edit = event.target.closest('[data-edit-model]');
      if (edit) return openModel(edit.dataset.editModel);
      const car = event.target.closest('[data-car]');
      if (car && !event.target.closest('a')) {
        const id = Number(car.dataset.car);
        if (state.expanded.has(id)) state.expanded.delete(id);
        else state.expanded.add(id);
        return render();
      }
    });

    document.addEventListener('input', (event) => {
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
    });
    bindModelDialog();
    $('#logout').addEventListener('click', async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      state.fleet = null;
      showLogin('email');
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) loadData(); });
  }

  /* ----------------------------------------------------------------- Старт */

  async function init() {
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
