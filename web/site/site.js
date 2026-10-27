/**
 * ============================================================================
 * JetRental — логика сайта
 * ============================================================================
 * - каталог: GET /api/public/catalog (модели, цены и фото — лист Catalog,
 *   «свободно сейчас» — Автопрокат);
 * - подбор по датам: GET /api/public/availability;
 * - заявки (бронь и форма «Contact us»): POST /api/public/request → рабочая
 *   группа в Telegram с кнопками Take / Can't (с пометкой языка клиента);
 * - языки EN / RU / TH / ZH: ?lang=ru в адресе → сохранённый выбор → язык
 *   браузера → английский. Тексты — в i18n.js.
 * ============================================================================
 */
(() => {
  'use strict';

  const API = '/api/public';
  const TZ = 'Asia/Bangkok';
  const WHATSAPP = document.body.dataset.whatsapp;
  const TELEGRAM = `https://t.me/${document.body.dataset.telegram}`;
  const DICT = window.JR_I18N;
  const LANGS = Object.keys(DICT);
  const LOCALES = { en: 'en-GB', ru: 'ru-RU', th: 'th-TH', zh: 'zh-CN' };
  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };
  const DAY_MS = 86400000;
  const STORAGE_KEY = 'jr_lang';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `${new Intl.NumberFormat('en-US').format(n)} ฿`;

  const state = { lang: 'en', models: null, catalog: new Map(), search: null, results: null, booking: null };

  /* ---------------------------------------------------------------- Языки */

  /** Текст по ключу с подстановкой {параметров}; значения параметров не экранируются */
  function t(key, params = {}) {
    const text = DICT[state.lang]?.[key] ?? DICT.en[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  }

  function daysText(n) {
    switch (state.lang) {
      case 'ru': {
        const mod10 = n % 10;
        const mod100 = n % 100;
        const word = mod10 === 1 && mod100 !== 11 ? 'день' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'дня' : 'дней';
        return `${n} ${word}`;
      }
      case 'th': return `${n} วัน`;
      case 'zh': return `${n}天`;
      default: return `${n} ${n === 1 ? 'day' : 'days'}`;
    }
  }

  const typeLabel = (type) => t(`type.${type}`);
  const niceDate = (iso) => new Intl.DateTimeFormat(LOCALES[state.lang], { timeZone: 'UTC', day: 'numeric', month: 'short' })
    .format(new Date(`${iso}T00:00:00Z`));

  function storedLang() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function detectLang() {
    const fromUrl = new URLSearchParams(location.search).get('lang');
    if (LANGS.includes(fromUrl)) return fromUrl;
    const saved = storedLang();
    if (LANGS.includes(saved)) return saved;
    for (const browserLang of navigator.languages || [navigator.language]) {
      const code = String(browserLang || '').slice(0, 2).toLowerCase();
      if (LANGS.includes(code)) return code;
    }
    return 'en';
  }

  function applyStatic() {
    document.documentElement.lang = state.lang;
    document.title = t('meta.title');
    $('#meta-description').setAttribute('content', t('meta.description'));
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    $$('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    $$('[data-type-option]').forEach((el) => { el.textContent = `${TYPE_ICON[el.dataset.typeOption]} ${typeLabel(el.dataset.typeOption)}`; });
    $$('[data-wa]').forEach((el) => { el.href = waLink(t(el.dataset.wa)); });
    $$('[data-lang]').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.lang === state.lang)));
  }

  function setLang(lang, { save = true } = {}) {
    state.lang = LANGS.includes(lang) ? lang : 'en';
    if (save) {
      try { localStorage.setItem(STORAGE_KEY, state.lang); } catch { /* приватный режим — не страшно */ }
      // Ссылкой с ?lang= можно поделиться; при смене языка обновляем адрес
      const url = new URL(location.href);
      url.searchParams.set('lang', state.lang);
      history.replaceState(null, '', url);
    }
    applyStatic();
    if (state.models) renderCatalog();
    if (state.results) renderResults();
    if (dialog.open && state.booking) refreshBookingTexts();
    $$('.form__status').forEach((el) => { el.textContent = ''; });
  }

  /* ------------------------------------------------------------------ API */

  async function api(path, body) {
    const init = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    const response = await fetch(API + path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { code: data.error });
    return data;
  }

  const errorText = (err, fallbackKey) => (err?.code && DICT.en[`err.${err.code}`] ? t(`err.${err.code}`) : t(fallbackKey));

  function waLink(text) {
    return `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;
  }

  const waAnchor = (text) => `<a href="${esc(waLink(text))}" target="_blank" rel="noopener">WhatsApp</a>`;

  /* ---------------------------------------------------------------- Шапка */

  function bindHeader() {
    const burger = $('.burger');
    const nav = $('#nav');
    burger.addEventListener('click', () => {
      const open = !nav.classList.contains('is-open');
      nav.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        nav.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
      }
    });
    $$('[data-lang]').forEach((button) => button.addEventListener('click', () => setLang(button.dataset.lang)));
    $('#year').textContent = new Date().getFullYear();
  }

  /* ------------------------------------------------------------- Карточки */

  const icon = (name, size = 20) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  function media(item, badge = '') {
    const img = item.photo
      ? `<img src="${esc(item.photo)}" alt="${esc(item.model)}" loading="lazy" width="320" height="220" />`
      : `<span class="vcard__placeholder" aria-hidden="true">${TYPE_ICON[item.type] || '🚘'}</span>`;
    return `<div class="vcard__media">${badge}${img}</div>`;
  }

  function availabilityBadge(item) {
    if (item.availableNow === true) return `<span class="badge badge--free">${esc(t('badge.free'))}</span>`;
    if (item.availableNow === false) return `<span class="badge badge--busy">${esc(t('badge.busy'))}</span>`;
    return '';
  }

  function actions(model, type, waText) {
    return `
      <div class="vcard__actions">
        <button class="btn btn--primary btn--sm" type="button" data-book="${esc(model)}"${type ? ` data-type="${esc(type)}"` : ''}>${esc(t('card.book'))}</button>
        <a class="btn btn--wa btn--sm" href="${esc(waLink(waText))}" target="_blank" rel="noopener" aria-label="${esc(model)} — WhatsApp">${icon('wa')}</a>
        <a class="btn btn--tg btn--sm" href="${TELEGRAM}" target="_blank" rel="noopener" aria-label="${esc(model)} — Telegram">${icon('tg')}</a>
      </div>`;
  }

  function catalogCard(item) {
    const price = item.priceFrom
      ? t('card.from', { price: money(item.priceFrom) })
      : `<span class="vcard__ask">${esc(t('card.ask'))}</span>`;
    return `
      <article class="vcard">
        ${media(item, availabilityBadge(item))}
        <div class="vcard__body">
          ${item.description ? `<div class="vcard__spec">${esc(item.description)}</div>` : ''}
          <h3>${esc(item.model)}</h3>
          <div class="vcard__price">${price}</div>
          ${actions(item.model, null, t('wa.model', { model: item.model }))}
        </div>
      </article>`;
  }

  function priceLines(price, days) {
    if (price?.total) {
      const deposit = price.deposit ? ` · ${esc(t('card.deposit', { amount: money(price.deposit) }))}` : '';
      return `<div class="vcard__price">${t('card.perDay', { price: money(price.perDay) })}</div>
              <div class="vcard__total">${t('card.total', { total: money(price.total), days: esc(daysText(days)) })}${deposit}</div>`;
    }
    if (price?.fromPerDay) return `<div class="vcard__price">${t('card.from', { price: money(price.fromPerDay) })}</div>`;
    return `<div class="vcard__price"><span class="vcard__ask">${esc(t('card.ask'))}</span></div>`;
  }

  function resultCard(option, search) {
    const info = state.catalog.get(option.model) || { model: option.model, type: search.type };
    const waText = t('wa.modelDates', { model: option.model, from: niceDate(search.from), to: niceDate(search.to) });
    return `
      <article class="vcard">
        ${media({ ...info, model: option.model }, `<span class="badge badge--free">${esc(t('badge.dates'))}</span>`)}
        <div class="vcard__body">
          ${info.description ? `<div class="vcard__spec">${esc(info.description)}</div>` : ''}
          <h3>${esc(option.model)}</h3>
          ${priceLines(option.price, search.days)}
          ${actions(option.model, search.type, waText)}
        </div>
      </article>`;
  }

  /* --------------------------------------------------------------- Каталог */

  function renderCatalog() {
    for (const grid of $$('[data-catalog]')) {
      if (!state.models) {
        grid.innerHTML = `<p class="muted">${t('catalog.error', { link: waAnchor(t('wa.which')) })}</p>`;
        continue;
      }
      const items = state.models.filter((m) => m.type === grid.dataset.catalog);
      grid.innerHTML = items.length
        ? items.map(catalogCard).join('')
        : `<p class="muted">${t('catalog.empty', { link: waAnchor(t('wa.which')) })}</p>`;
    }
  }

  async function loadCatalog() {
    try {
      const { models } = await api('/catalog');
      state.models = models;
      models.forEach((m) => state.catalog.set(m.model, m));
    } catch {
      state.models = null;
    }
    renderCatalog();
  }

  /* ---------------------------------------------------- Подбор по датам */

  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

  function setupDateInputs(fromInput, toInput, from, to) {
    fromInput.min = todayIso();
    fromInput.value = from;
    toInput.min = addDays(from, 1);
    toInput.value = to;
    fromInput.addEventListener('change', () => {
      if (!fromInput.value) return;
      toInput.min = addDays(fromInput.value, 1);
      if (!toInput.value || toInput.value <= fromInput.value) toInput.value = addDays(fromInput.value, 7);
    });
  }

  function renderResults() {
    const { search, models, error } = state.results;
    const period = `${niceDate(search.from)} – ${niceDate(search.to)}`;
    const grid = $('#results-grid');
    const errorBox = $('#results-error');
    errorBox.hidden = !error;
    errorBox.textContent = error ? errorText(error, 'results.error') : '';
    if (!models) {
      $('#results-title').textContent = period;
      grid.innerHTML = error ? '' : '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      return;
    }
    $('#results-title').textContent = t('results.title', { period, days: daysText(search.days) });
    const askText = t('wa.need', { type: typeLabel(search.type).toLowerCase(), from: niceDate(search.from), to: niceDate(search.to) });
    grid.innerHTML = models.length
      ? models.map((o) => resultCard(o, search)).join('')
      : `<p class="muted">${t('results.none', { link: `<a href="${esc(waLink(askText))}" target="_blank" rel="noopener">${esc(t('results.noneLink'))}</a>` })}</p>`;
  }

  function bindSearch() {
    const form = $('#search-form');
    const start = addDays(todayIso(), 1);
    setupDateInputs(form.from, form.to, start, addDays(start, 7));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = $('button[type="submit"]', form);
      const search = { type: form.type.value, from: form.from.value, to: form.to.value };
      $('#results').hidden = false;
      state.results = { search, models: null, error: null };
      renderResults();
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      button.disabled = true;
      try {
        const data = await api(`/availability?type=${encodeURIComponent(search.type)}&from=${search.from}&to=${search.to}`);
        state.search = { ...search, days: data.days };
        state.results = { search: state.search, models: data.models, error: null };
      } catch (err) {
        state.results = { search, models: null, error: err };
      } finally {
        button.disabled = false;
      }
      renderResults();
    });

    $('#results-close').addEventListener('click', () => {
      $('#results').hidden = true;
      state.search = null;
      state.results = null;
    });
  }

  /* --------------------------------------------------------- Бронирование */

  const dialog = $('#book-dialog');
  const bookForm = $('#book-form');
  let estimateTimer = null;

  function refreshBookingTexts() {
    const { model, type } = state.booking;
    const info = state.catalog.get(model) || {};
    $('#book-type').textContent = type ? typeLabel(type) : '';
    $('#book-price').innerHTML = info.priceFrom ? t('card.from', { price: money(info.priceFrom) }) : '';
    if (!$('#book-done').hidden && state.booking.requestId) {
      $('#done-title').textContent = t('done.title', { id: state.booking.requestId });
    }
    updateWaLink();
    updateEstimate();
  }

  function openBooking(model, typeHint) {
    const info = state.catalog.get(model) || { model, type: typeHint };
    state.booking = { model, type: info.type || typeHint };

    $('#book-title').textContent = model;
    const photo = $('#book-photo');
    photo.hidden = !info.photo;
    if (info.photo) photo.src = info.photo;

    const from = state.search?.from || addDays(todayIso(), 1);
    const to = state.search?.to || addDays(from, 7);
    bookForm.from.value = from;
    bookForm.to.value = to;
    bookForm.from.min = todayIso();
    bookForm.to.min = addDays(from, 1);

    setStatus(bookForm, '');
    bookForm.hidden = false;
    $('#book-done').hidden = true;
    refreshBookingTexts();
    dialog.showModal();
  }

  function updateWaLink() {
    const { model } = state.booking;
    const from = bookForm.from.value;
    const to = bookForm.to.value;
    $('#book-wa').href = waLink(from && to
      ? t('wa.modelDates', { model, from: niceDate(from), to: niceDate(to) })
      : t('wa.model', { model }));
  }

  function updateEstimate() {
    clearTimeout(estimateTimer);
    const box = $('#book-estimate');
    const { model, type } = state.booking;
    const from = bookForm.from.value;
    const to = bookForm.to.value;
    if (!type || !from || !to || to <= from) {
      box.hidden = true;
      return;
    }
    estimateTimer = setTimeout(async () => {
      try {
        const data = await api(`/availability?type=${type}&from=${from}&to=${to}`);
        const option = data.models.find((m) => m.model === model);
        box.hidden = false;
        box.classList.toggle('is-warn', !option);
        if (!option) {
          box.textContent = t('est.none');
        } else if (option.price?.total) {
          box.textContent = t('est.price', { perDay: money(option.price.perDay), total: money(option.price.total), days: daysText(data.days) });
        } else {
          box.textContent = t('est.ok', { days: daysText(data.days) });
        }
      } catch {
        box.hidden = true;
      }
    }, 300);
  }

  function setStatus(form, text, kind = '') {
    const status = $('.form__status', form);
    status.textContent = text;
    status.className = `form__status${kind ? ` is-${kind}` : ''}`;
  }

  function bindBooking() {
    document.addEventListener('click', (e) => {
      const book = e.target.closest('[data-book]');
      if (book) openBooking(book.dataset.book, book.dataset.type);
      if (e.target.closest('[data-close]')) dialog.close();
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

    bookForm.from.addEventListener('change', () => {
      if (bookForm.from.value) {
        bookForm.to.min = addDays(bookForm.from.value, 1);
        if (!bookForm.to.value || bookForm.to.value <= bookForm.from.value) bookForm.to.value = addDays(bookForm.from.value, 7);
      }
      updateWaLink();
      updateEstimate();
    });
    bookForm.to.addEventListener('change', () => { updateWaLink(); updateEstimate(); });

    bookForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = $('button[type="submit"]', bookForm);
      button.disabled = true;
      setStatus(bookForm, t('form.sending'));
      try {
        const result = await api('/request', {
          name: bookForm.name.value,
          phone: bookForm.phone.value,
          message: bookForm.message.value,
          type: state.booking.type,
          model: state.booking.model,
          from: bookForm.from.value,
          to: bookForm.to.value,
          lang: state.lang,
          website: bookForm.website.value
        });
        state.booking.requestId = result.id || null;
        $('#done-title').textContent = result.id ? t('done.title', { id: result.id }) : t('done.titleNoId');
        bookForm.hidden = true;
        $('#book-done').hidden = false;
        bookForm.message.value = '';
      } catch (err) {
        setStatus(bookForm, errorText(err, 'book.fail'), 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------- Форма контакта */

  function bindContact() {
    const form = $('#contact-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = $('button[type="submit"]', form);
      if (!form.message.value.trim()) return setStatus(form, t('err.message_required'), 'error');
      button.disabled = true;
      setStatus(form, t('form.sending'));
      try {
        await api('/request', {
          name: form.name.value,
          phone: form.phone.value,
          email: form.email.value,
          message: form.message.value,
          lang: state.lang,
          website: form.website.value
        });
        form.reset();
        setStatus(form, t('form.thanks'), 'ok');
      } catch (err) {
        setStatus(form, errorText(err, 'form.fail'), 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  bindHeader();
  bindSearch();
  bindBooking();
  bindContact();
  setLang(detectLang(), { save: false });
  loadCatalog();
})();
