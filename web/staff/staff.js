/**
 * ============================================================================
 * JetRental Staff — сайт сотрудников
 * ============================================================================
 * Экраны: вход (почта → код) и 4 вкладки: Overview, Fleet, Calendar, Requests.
 * Данные: GET /api/staff/fleet (снимок Автопроката, обновляется на сервере
 * раз в 10 минут) и GET /api/staff/requests. Время показываем по Бангкоку.
 * ============================================================================
 */
(() => {
  'use strict';

  const API = '/api/staff';
  const TZ = 'Asia/Bangkok';
  const TZ_OFFSET_MS = 7 * 3600 * 1000; // Таиланд без перехода на летнее время
  const DAY_MS = 86400000;
  const REFRESH_MS = 2 * 60 * 1000;

  const TYPES = { scooter: 'Scooters', motorcycle: 'Motorbikes', car: 'Cars' };
  const TYPE_ONE = { scooter: 'Scooter', motorcycle: 'Motorbike', car: 'Car' };
  const STATUS = { free: 'Free', rent: 'Rented', reserve: 'Booked', service: 'Service' };
  const CHANNELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', site: 'Website' };
  const LANGS = { en: '🇬🇧 EN', ru: '🇷🇺 RU', th: '🇹🇭 TH', zh: '🇨🇳 ZH' };
  const ERRORS = {
    invalid_email: 'Please enter a valid email.',
    invalid_code: 'Wrong or expired code. Try again or request a new one.',
    too_many_attempts: 'Too many wrong attempts. Request a new code.',
    wait_a_minute: 'A code was just sent. Please wait a minute before requesting another.',
    too_many_codes: 'Too many codes requested. Try again in an hour.',
    too_many_requests: 'Too many attempts. Please try again later.',
    mail_not_configured: 'Email sending is not set up on the server yet.',
    mail_failed: 'Could not send the email. Please try again in a minute.',
    no_access: 'This email no longer has access.'
  };

  const ICONS = {
    overview: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
    fleet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.92 6.01A1.5 1.5 0 0 0 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8l-2.08-5.99zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11H5z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM7 12h5v5H7z"/></svg>',
    requests: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>'
  };
  const TABS = [
    { id: 'overview', title: 'Overview' },
    { id: 'fleet', title: 'Fleet' },
    { id: 'calendar', title: 'Calendar' },
    { id: 'requests', title: 'Requests' }
  ];

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
    timer: null
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

  const fmtDateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short' });
  const fmtWeekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
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
    if (Math.abs(hours) < 1) return 'within an hour';
    if (Math.abs(hours) < 36) return hours > 0 ? `in ${hours} h` : `${-hours} h ago`;
    const days = Math.round(diff / DAY_MS);
    const label = `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'}`;
    return days > 0 ? `in ${label}` : `${label} ago`;
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
      $('#code-email').textContent = state.loginEmail;
      $('#code').value = '';
      $('#code').focus();
      startResendTimer();
    }
  }

  function setLoginError(message) {
    $('#login-error').hidden = !message;
    $('#login-error').textContent = message || '';
  }

  function startResendTimer() {
    const button = $('#resend');
    let left = 60;
    button.disabled = true;
    button.textContent = `Resend code (${left})`;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        button.disabled = false;
        button.textContent = 'Resend code';
      } else {
        button.textContent = `Resend code (${left})`;
      }
    }, 1000);
  }

  async function requestCode(email) {
    state.loginEmail = email.trim().toLowerCase();
    await api('/login', { body: { email: state.loginEmail } });
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
        setLoginError(ERRORS[err.code] || 'Something went wrong. Please try again.');
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
        setLoginError(ERRORS[err.code] || 'Could not send a new code.');
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
    if (TABS.some((t) => t.id === fromHash)) state.tab = fromHash;
    renderTabs();
    render();
    loadData();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) loadData(); }, REFRESH_MS);
  }

  async function loadData() {
    try {
      const [fleet, requests] = await Promise.all([api('/fleet'), api('/requests')]);
      state.fleet = fleet;
      state.requests = requests.requests || [];
      showDataError(fleet.error ? `Avtoprokat sync problem: ${fleet.error}. Showing the last loaded data.` : '');
      render();
    } catch (err) {
      if (err.status === 401) return showLogin('email', err.code === 'no_access' ? ERRORS.no_access : '');
      showDataError('Could not load data. Check your connection — retrying automatically.');
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
    const html = TABS.map((t) => `
      <button type="button" data-tab="${t.id}" ${state.tab === t.id ? 'aria-current="page"' : ''}>
        ${ICONS[t.id]}<span>${t.title}</span>
        ${t.id === 'requests' && count ? `<span class="count">${count}</span>` : ''}
      </button>`).join('');
    document.querySelectorAll('.tabs').forEach((nav) => { nav.innerHTML = html; });
  }

  function setTab(tab) {
    state.tab = tab;
    history.replaceState(null, '', `#${tab}`);
    renderTabs();
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    const fleet = state.fleet;
    $('#updated').innerHTML = fleet?.updatedAt
      ? `Avtoprokat data: <b>${esc(fmtTime.format(new Date(fleet.updatedAt)))}</b> <span class="muted">(${esc(relative(fleet.updatedAt))})</span>`
      : fleet ? (fleet.enabled ? 'Loading data from Avtoprokat…' : 'Avtoprokat is not connected') : 'Loading…';
    renderTabs();
    const view = $('#view');
    if (state.tab === 'overview') view.innerHTML = renderOverview();
    if (state.tab === 'fleet') view.innerHTML = renderFleet();
    if (state.tab === 'calendar') view.innerHTML = renderCalendar();
    if (state.tab === 'requests') view.innerHTML = renderRequests();
  }

  /* --------------------------------------------------------- Данные парка */

  const cars = () => state.fleet?.cars || [];
  const carName = (car) => car.model || car.wsModel || '—';
  const priceOf = (car) => state.fleet?.prices?.[car.model] || null;
  const tariffOf = (car) => state.fleet?.tariffs?.[car.id] || null;
  const SEASON_NAMES = { 'Низкий': 'Low', 'Средний': 'Mid', 'Высокий': 'High', 'Пик': 'Peak' };
  const TIER_LABELS = ['1–2 d', '3–6 d', '7–13 d', '14–30 d', '31+ d'];

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
    if (car.status === 'free') return car.freeWeek ? 'Free now · free next 7 days' : 'Free now';
    if (car.freeFrom === 'later') return 'Busy for 30+ days';
    return `Free from <b>${esc(dateTime(car.freeFrom))}</b> (${esc(relative(car.freeFrom))})`;
  }

  /* -------------------------------------------------------------- Overview */

  function renderOverview() {
    if (!state.fleet) return '<div class="empty">Loading…</div>';
    const all = cars();
    if (!all.length) return `<div class="empty">${state.fleet.enabled ? 'No data from Avtoprokat yet. It refreshes every 10 minutes.' : 'Avtoprokat is not connected on the server.'}</div>`;

    const count = (status, type) => all.filter((c) => (!status || c.status === status) && (!type || c.type === type)).length;
    const stats = ['free', 'rent', 'reserve', 'service'].map((s) => `
      <div class="stat">
        <div class="stat__value">${count(s)}</div>
        <div class="stat__label"><span class="dot dot--${s}"></span>${STATUS[s]}</div>
      </div>`).join('');

    const typeRows = Object.keys(TYPES).map((type) => `
      <tr><td>${TYPES[type]}</td><td>${count('free', type)}</td><td>${count('rent', type)}</td><td>${count('reserve', type)}</td><td>${count('service', type)}</td><td><b>${count(null, type)}</b></td></tr>`).join('');
    const unmatched = all.filter((c) => !c.type).length;

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
      <h2 class="section-title">Right now · ${all.length} vehicles</h2>
      <div class="stats">${stats}</div>

      <h2 class="section-title">By type</h2>
      <div class="card table-wrap">
        <table class="type-table">
          <thead><tr><th></th><th>Free</th><th>Rented</th><th>Booked</th><th>Service</th><th>All</th></tr></thead>
          <tbody>${typeRows}</tbody>
        </table>
      </div>
      ${unmatched ? `<p class="muted" style="font-size:13px">⚠️ ${unmatched} ${unmatched === 1 ? 'vehicle is' : 'vehicles are'} not matched to the Vehicles sheet (no type/model). Fill in “Модель для клиента” by plate.</p>` : ''}

      <h2 class="section-title">New requests</h2>
      <div class="card">
        ${fresh.length ? fresh.slice(0, 5).map((r) => `
          <div class="row" data-goto="requests">
            <div class="row__main">
              <div class="row__title">#${r.id} · ${esc(r.model || TYPE_ONE[r.vehicleType] || 'Question')}</div>
              <div class="row__sub">${esc(r.clientName || '')} · ${esc(CHANNELS[r.channel] || r.channel)}</div>
            </div>
            <div class="row__side">${r.dateFrom ? `${esc(shortDate(r.dateFrom))} – ${esc(shortDate(r.dateTo))}` : ''}</div>
          </div>`).join('') : '<div class="empty">No new requests 👌</div>'}
      </div>

      <h2 class="section-title">Returning in the next 48 h</h2>
      <div class="card">
        ${freeing.length ? freeing.map((c) => carRow(c, `${esc(dateTime(c.freeFrom))}<br><span class="muted">${esc(relative(c.freeFrom))}</span>`)).join('') : '<div class="empty">Nothing is returning in the next 48 hours</div>'}
      </div>

      <h2 class="section-title">Bookings starting in the next 48 h</h2>
      <div class="card">
        ${pickups.length ? pickups.map(({ car, seg }) => carRow(car, `${esc(dateTime(seg.from))}<br><span class="muted">${esc(relative(seg.from))}</span>`)).join('') : '<div class="empty">No bookings start in the next 48 hours</div>'}
      </div>`;
  }

  /* ----------------------------------------------------------------- Fleet */

  function renderFilters({ withStatus }) {
    const f = state.filters;
    const typeChips = [['all', 'All types'], ...Object.entries(TYPES)].map(([id, label]) =>
      `<button type="button" class="chip" data-filter="type" data-value="${id}" aria-pressed="${f.type === id}">${label}</button>`).join('');
    const statusChips = withStatus ? [['all', 'Any status'], ...Object.entries(STATUS)].map(([id, label]) =>
      `<button type="button" class="chip" data-filter="status" data-value="${id}" aria-pressed="${f.status === id}">${id !== 'all' ? `<span class="dot dot--${id}"></span>` : ''}${label}</button>`).join('') : '';
    return `
      <div class="toolbar">
        <input class="search" type="search" placeholder="Search plate or model" value="${esc(f.q)}" data-search autocomplete="off" />
        <div class="chips">${typeChips}</div>
        ${withStatus ? `<div class="chips">${statusChips}</div>` : ''}
      </div>`;
  }

  function renderFleet() {
    if (!state.fleet) return '<div class="empty">Loading…</div>';
    const list = filteredCars();
    return `
      ${renderFilters({ withStatus: true })}
      <div class="result-count">${list.length} of ${cars().length} vehicles</div>
      <div class="list" style="margin-top:10px">
        ${list.length ? list.map(renderCar).join('') : '<div class="empty">Nothing found</div>'}
      </div>`;
  }

  function renderCar(car) {
    const price = priceOf(car);
    // Цена на сегодня — из сезонного прайса по госномеру, иначе «от» из каталога
    const tariff = tariffOf(car);
    const todayPrice = tariff?.tiers?.[0];
    const priceText = todayPrice
      ? `${money(todayPrice)}/day today${tariff.verified ? '' : ' ⚠️'}`
      : price?.perDay ? `${money(price.perDay)}/day` : price?.priceFrom ? `from ${money(price.priceFrom)}/day` : '';
    const deposit = tariff?.deposit || car.deposit || price?.deposit;
    const seasonText = tariff
      ? `${SEASON_NAMES[tariff.season] || tariff.season}${tariff.verified ? '' : ' — ⚠️ prices not verified yet'}${tariff.suspicious ? ' — ⚠️ typo in the price row' : ''}`
      : '';
    const seasonTiers = tariff?.tiers
      ? tariff.tiers.map((v, i) => (v ? `${TIER_LABELS[i]}: ${money(v)}` : null)).filter(Boolean).join(' · ')
      : '';
    const open = state.expanded.has(car.id);
    const upcoming = car.segments.filter((s) => Date.parse(s.to) > Date.now());
    const tariffs = car.tariffs.length
      ? car.tariffs.map((t) => `${t.min}–${t.max >= 999 ? '∞' : t.max} d: ${money(t.cost)}`).join(' · ')
      : '';
    const tiers = price && (price.perDay || price.perDayWeek || price.perDayMonth)
      ? [price.perDay && `1–6 d: ${money(price.perDay)}`, price.perDayWeek && `7–29 d: ${money(price.perDayWeek)}`, price.perDayMonth && `30+ d: ${money(price.perDayMonth)}`].filter(Boolean).join(' · ')
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
          ${priceText ? `<span>Price <b>${esc(priceText)}</b></span>` : ''}
          ${deposit ? `<span>Deposit <b>${esc(money(deposit))}</b></span>` : ''}
        </div>
        ${open ? `
          <div class="car__details">
            <dl>
              <dt>In Avtoprokat</dt><dd>${esc(car.wsModel)} · ID ${esc(car.id)}</dd>
              ${!car.model ? '<dt>Sheet</dt><dd class="warn">Not matched in the Vehicles sheet</dd>' : ''}
              ${seasonText ? `<dt>Season today</dt><dd${tariff.verified && !tariff.suspicious ? '' : ' class="warn"'}>${esc(seasonText)}</dd>` : ''}
              ${seasonTiers ? `<dt>Price list</dt><dd>${esc(seasonTiers)}${tariff.overKm ? ` · over-mileage ${esc(money(tariff.overKm))}/km` : ''}</dd>` : ''}
              ${tariff && !tariff.tiers ? '<dt>Price list</dt><dd class="warn">No row for this plate</dd>' : ''}
              ${tariffs ? `<dt>Tariffs</dt><dd>${esc(tariffs)}</dd>` : ''}
              ${tiers ? `<dt>Catalog</dt><dd>${esc(tiers)}</dd>` : ''}
              <dt>Next 7 days</dt><dd>${car.freeWeek ? 'Free the whole week' : 'Has bookings/rentals'}</dd>
            </dl>
            <div><b>Next 30 days</b>
              ${upcoming.length ? `<ul class="seg-list">${upcoming.map((s) => `
                <li><span class="dot dot--${s.kind}"></span>${STATUS[s.kind]}: ${esc(dateTime(s.from))} → ${esc(dateTime(s.to))}</li>`).join('')}</ul>`
                : '<div class="muted">No rentals, bookings or service</div>'}
            </div>
          </div>` : ''}
      </article>`;
  }

  /* -------------------------------------------------------------- Calendar */

  function renderCalendar() {
    if (!state.fleet) return '<div class="empty">Loading…</div>';
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
        <div class="cal__label">Vehicle</div>
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
      <div class="cal__group" style="width:${width + 128}px">${g.type ? TYPES[g.type] : 'Not matched'} · ${g.cars.length}</div>
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

    const ranges = [7, 14, 30].map((n) => `<button type="button" class="chip" data-days="${n}" aria-pressed="${days === n}">${n} days</button>`).join('');

    return `
      ${renderFilters({ withStatus: false })}
      <div class="chips" style="margin-bottom:10px">${ranges}</div>
      ${list.length ? `<div class="cal"><div class="cal__grid">${header}${rows}</div></div>` : '<div class="empty">Nothing found</div>'}
      <div class="legend">
        <span><i style="background:var(--rent)"></i>Rental</span>
        <span><i style="background:var(--reserve)"></i>Booking</span>
        <span><i style="background:repeating-linear-gradient(135deg,var(--service),var(--service) 3px,transparent 3px,transparent 6px);border:1px solid var(--service)"></i>Service</span>
        <span><i style="background:var(--brand);width:3px"></i>Now</span>
      </div>`;
  }

  /* -------------------------------------------------------------- Requests */

  function renderRequests() {
    const filters = [['all', 'All'], ['new', 'New'], ['taken', 'Taken']].map(([id, label]) =>
      `<button type="button" class="chip" data-req="${id}" aria-pressed="${state.reqFilter === id}">${label}${id === 'new' && newRequestsCount() ? ` · ${newRequestsCount()}` : ''}</button>`).join('');
    const list = state.requests.filter((r) => state.reqFilter === 'all' || r.status === state.reqFilter);

    return `
      <div class="chips" style="margin-bottom:12px">${filters}</div>
      <div class="list">
        ${list.length ? list.map(renderRequest).join('') : '<div class="empty">No requests yet</div>'}
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
          <span class="pill pill--${r.status === 'new' ? 'new' : 'taken'}">${r.status === 'new' ? 'New' : `Taken · ${esc(r.takenBy || '')}`}</span>
          <span class="muted" style="font-size:13px">${esc(CHANNELS[r.channel] || r.channel)}${r.lang ? ` · ${esc(LANGS[r.lang] || r.lang)}` : ''}</span>
          <span class="req__time">${esc(dateTime(r.createdAt))}</span>
        </div>
        ${what ? `<div class="req__line"><b>${esc(what)}</b></div>` : ''}
        ${r.dateFrom ? `<div class="req__line">📅 ${esc(shortDate(r.dateFrom))} – ${esc(shortDate(r.dateTo))} · ${days} ${days === 1 ? 'day' : 'days'}${r.estimateThb ? ` · ≈ ${esc(money(r.estimateThb))}` : ''}</div>` : ''}
        <div class="req__line">👤 ${esc(r.clientName || '—')}${r.clientPhone ? ` · ${esc(r.clientPhone)}` : ''}</div>
        ${r.freeUnits ? `<div class="req__line muted">🔑 Free plates: ${esc(r.freeUnits)}</div>` : ''}
        ${r.comment ? `<div class="req__line">💬 ${esc(r.comment).replace(/\n/g, '<br>')}</div>` : ''}
        ${r.declinedBy.length ? `<div class="req__line muted">🚫 Can't: ${esc(r.declinedBy.join(', '))}</div>` : ''}
        ${phoneDigits ? `
          <div class="req__actions">
            <a class="btn btn--small" href="tel:+${phoneDigits}">📞 Call</a>
            <a class="btn btn--small" href="https://wa.me/${phoneDigits}" target="_blank" rel="noopener">💬 WhatsApp</a>
          </div>` : ''}
      </article>`;
  }

  /* --------------------------------------------------------------- События */

  function bindApp() {
    document.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (tab) return setTab(tab.dataset.tab);
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

    $('#refresh').addEventListener('click', loadData);
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
