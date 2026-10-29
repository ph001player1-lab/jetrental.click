/**
 * ============================================================================
 * Логика сайта в браузере (KokonCar / JetRental)
 * ============================================================================
 * Страницы, тексты и каталог собирает сервер (server/src/site) — скрипт
 * добавляет то, что зависит от действий посетителя:
 * - подбор по датам: GET /api/public/availability;
 * - окно брони и форма «Contact us»: POST /api/public/request → рабочая
 *   группа в Telegram с кнопками Take / Can't (с пометкой языка клиента);
 * - данные моделей для окна брони: GET /api/public/catalog.
 * Язык — из <html lang> (у каждого языка свои адреса: /ru, /th, /zh),
 * тексты — в i18n.js.
 * ============================================================================
 */
(() => {
  'use strict';

  const API = '/api/public';
  const TZ = 'Asia/Bangkok';
  const WHATSAPP = document.body.dataset.whatsapp;
  const TELEGRAM = `https://t.me/${document.body.dataset.telegram}`;
  const BRAND = document.body.dataset.brandName;
  // Языковой префикс адресов страниц: '' (английский), '/ru', '/th', '/zh'
  const PREFIX = document.body.dataset.prefix || '';
  const DICT = window.JR_I18N;
  const LOCALES = { en: 'en-GB', ru: 'ru-RU', th: 'th-TH', zh: 'zh-CN' };
  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };
  const CATEGORY = { scooter: 'scooters', motorcycle: 'motorbikes', car: 'cars' };
  // Дизайн страницы: 'modern' (новый) или 'classic' (как старый kokoncar.com)
  const CLASSIC = document.body.dataset.theme === 'classic';
  const DAY_MS = 86400000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `${new Intl.NumberFormat('en-US').format(n)} ฿`;

  const state = {
    lang: DICT[document.documentElement.lang] ? document.documentElement.lang : 'en',
    catalog: new Map(),
    search: null,
    results: null,
    booking: null
  };

  /* ---------------------------------------------------------------- Языки */

  /** Текст по ключу с подстановкой {параметров} и {brand}; значения параметров не экранируются */
  /** Описание модели на языке страницы (из каталога; без перевода — английское) */
  const descOf = (info) => info.descriptions?.[state.lang] || info.description || '';

  function t(key, params = {}) {
    const text = DICT[state.lang]?.[key] ?? DICT.en[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (m, name) => {
      if (name in params) return String(params[name]);
      return name === 'brand' && BRAND ? BRAND : m;
    });
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
  }

  /* ------------------------------------------------------------- Карточки */

  const icon = (name, size = 20) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  /** Фото с фоном (.jpg) заполняют карточку целиком, вырезанные (.webp/.png) — по центру */
  const isFullPhoto = (photo) => /\.jpe?g$/i.test(photo || '');

  /** Адрес страницы модели на текущем языке (как на сервере: /ru/cars/honda-city) */
  const modelUrl = (item) => (item.slug && CATEGORY[item.type] ? `${PREFIX}/${CATEGORY[item.type]}/${item.slug}` : null);

  function media(item, badge = '') {
    const icon = TYPE_ICON[item.type] || '🚘';
    const img = item.photo
      ? `<img src="${esc(item.photo)}" alt="${esc(item.model)}" loading="lazy" width="320" height="220" data-icon="${icon}" />`
      : `<span class="vcard__placeholder" aria-hidden="true">${icon}</span>`;
    const cls = `vcard__media${isFullPhoto(item.photo) ? ' vcard__media--photo' : ''}`;
    const href = modelUrl(item);
    return href
      ? `<a class="${cls}" href="${esc(href)}" tabindex="-1" aria-hidden="true">${badge}${img}</a>`
      : `<div class="${cls}">${badge}${img}</div>`;
  }

  // Файла по ссылке из Catalog нет (опечатка, ещё не выложен) → значок вместо пустой рамки
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.id === 'book-photo') { img.hidden = true; return; }
    const box = img.closest('.gal__slide, .gal__thumb, .vcard__media, .cl-card__media, .cl-model__media');
    if (!box) return;
    box.classList.remove('vcard__media--photo', 'is-photo');
    img.outerHTML = `<span class="vcard__placeholder" aria-hidden="true">${img.dataset.icon || '🚘'}</span>`;
  }, true);

  function actions(model, type, waText) {
    return `
      <div class="vcard__actions">
        <button class="btn btn--primary btn--sm" type="button" data-book="${esc(model)}"${type ? ` data-type="${esc(type)}"` : ''}>${esc(t('card.book'))}</button>
        <a class="btn btn--wa btn--sm" href="${esc(waLink(waText))}" target="_blank" rel="noopener" aria-label="${esc(model)} — WhatsApp">${icon('wa')}</a>
        <a class="btn btn--tg btn--sm" href="${TELEGRAM}" target="_blank" rel="noopener" aria-label="${esc(model)} — Telegram">${icon('tg')}</a>
      </div>`;
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

  // Значки плашек карточки (как в server/src/site/classic.js)
  const ICON_SPEC = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6zm0-5.2 1.3 2.4 2.7-.6.6 2.7 2.4 1.3-1.2 2.5 1.2 2.5-2.4 1.3-.6 2.7-2.7-.6L12 21l-1.3-2.4-2.7.6-.6-2.7L5 15.2l1.2-2.5L5 10.2l2.4-1.3.6-2.7 2.7.6z"/></svg>';
  const ICON_PRICE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M3.5 12.6 11.4 4.7a1.6 1.6 0 0 1 1.2-.5H19a.8.8 0 0 1 .8.8v6.4a1.6 1.6 0 0 1-.5 1.2l-7.9 7.9a1.6 1.6 0 0 1-2.3 0l-5.6-5.6a1.6 1.6 0 0 1 0-2.3zM16 8.1a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8zM9.6 13.3l3.1 3.1M8 15l1.8 1.8"/></svg>';

  /** Карточка результата подбора в дизайне classic — как карточки на страницах */
  function classicResultCard(option, search, info, waText) {
    const words = option.model.split(/\s+/);
    const n = /^royal enfield/i.test(option.model) ? 2 : 1;
    const href = modelUrl(info);
    const baht = (v) => `${new Intl.NumberFormat('en-US').format(v)}฿`;
    const price = option.price?.total
      ? `<li>${ICON_PRICE}<span>${esc(t('cl.perDay', { price: baht(option.price.perDay) }))}</span></li>`
      : `<li>${ICON_PRICE}<span>${option.price?.fromPerDay ? esc(t('cl.from', { price: baht(option.price.fromPerDay) })) : esc(t('card.ask'))}</span></li>`;
    const total = option.price?.total ? `<p class="cl-card__total">${t('card.total', { total: money(option.price.total), days: esc(daysText(search.days)) })}</p>` : '';
    const photo = info.photo
      ? `<img src="${esc(info.photo)}" alt="${esc(option.model)}" loading="lazy" width="320" height="220" data-icon="${TYPE_ICON[info.type] || '🚘'}" />`
      : `<span class="vcard__placeholder" aria-hidden="true">${TYPE_ICON[info.type] || '🚘'}</span>`;
    return `
      <article class="cl-card">
        <${href ? `a href="${esc(href)}"` : 'div'} class="cl-card__media${isFullPhoto(info.photo) ? ' is-photo' : ''}"><span class="badge badge--free">${esc(t('badge.dates'))}</span>${photo}</${href ? 'a' : 'div'}>
        <h3 class="cl-card__title">${href ? `<a href="${esc(href)}">` : '<span>'}<b>${esc(words.slice(0, n).join(' '))}</b> <span>${esc(words.slice(n).join(' '))}</span>${href ? '</a>' : '</span>'}</h3>
        <ul class="cl-card__pills">${descOf(info) ? `<li>${ICON_SPEC}<span>${esc(descOf(info))}</span></li>` : ''}${price}</ul>
        ${total}
        <div class="cl-card__actions">
          <button class="cl-btn cl-btn--dark" type="button" data-book="${esc(option.model)}" data-type="${esc(search.type)}">${esc(t('card.book'))}</button>
          <a class="cl-btn cl-btn--wa" href="${esc(waLink(waText))}" target="_blank" rel="noopener">${icon('wa', 18)}What'sApp</a>
        </div>
      </article>`;
  }

  function resultCard(option, search) {
    const info = state.catalog.get(option.model) || { model: option.model, type: search.type };
    const waText = t('wa.modelDates', { model: option.model, from: niceDate(search.from), to: niceDate(search.to) });
    if (CLASSIC) return classicResultCard(option, search, info, waText);
    return `
      <article class="vcard">
        ${media({ ...info, model: option.model }, `<span class="badge badge--free">${esc(t('badge.dates'))}</span>`)}
        <div class="vcard__body">
          ${descOf(info) ? `<div class="vcard__spec">${esc(descOf(info))}</div>` : ''}
          <h3>${modelUrl(info) ? `<a href="${esc(modelUrl(info))}">${esc(option.model)}</a>` : esc(option.model)}</h3>
          ${priceLines(option.price, search.days)}
          ${actions(option.model, search.type, waText)}
        </div>
      </article>`;
  }

  /* --------------------------------------------------------------- Каталог */

  // Карточки на странице уже есть (их рисует сервер); данные моделей нужны
  // для окна брони и результатов подбора — фото, цена «от», адрес страницы
  async function loadCatalog() {
    try {
      const { models } = await api('/catalog');
      models.forEach((m) => state.catalog.set(m.model, m));
    } catch {
      /* без каталога окно брони покажет только название модели */
    }
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
    if (!form) return; // на странице «не найдено» подбора нет
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
    photo.classList.toggle('is-photo', isFullPhoto(info.photo));
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
    if (!form) return;
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

  /* -------------------------------------------- Анимации и карусели (classic) */

  // Блоки с data-reveal плавно появляются, когда доходят до экрана; карточки
  // в одном ряду — друг за другом
  function bindReveal() {
    const items = document.querySelectorAll('[data-reveal]');
    window.__reveal = true;
    if (!items.length) return;
    if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      items.forEach((el) => el.classList.add('is-in'));
      return;
    }
    document.querySelectorAll('.cl-slider__track, .cl-grid').forEach((row) => {
      [...row.children].forEach((el, i) => el.style.setProperty('--delay', `${Math.min(i, 6) * 0.08}s`));
    });
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => observer.observe(el));
  }

  // Стрелки карусели листают примерно на ширину экрана
  function bindSliders() {
    document.querySelectorAll('[data-slider]').forEach((slider) => {
      const track = $('.cl-slider__track', slider);
      const prev = $('[data-slide="-1"]', slider);
      const next = $('[data-slide="1"]', slider);
      const update = () => {
        prev.disabled = track.scrollLeft < 8;
        next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
      };
      slider.addEventListener('click', (e) => {
        const arrow = e.target.closest('[data-slide]');
        if (arrow) track.scrollBy({ left: Number(arrow.dataset.slide) * track.clientWidth * 0.8, behavior: 'smooth' });
      });
      track.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      update();
    });
  }

  // Фото на странице модели: стрелки, миниатюры, счётчик, клавиши ← →.
  // Листать пальцем можно и без скрипта — это обычная прокрутка с прилипанием
  function bindGalleries() {
    document.querySelectorAll('[data-gallery]').forEach((gallery) => {
      const track = $('.gal__track', gallery);
      const slides = track.children.length;
      const thumbs = [...gallery.querySelectorAll('[data-gal-to]')];
      const row = $('.gal__thumbs', gallery);
      const prev = $('[data-gal="-1"]', gallery);
      const next = $('[data-gal="1"]', gallery);
      const count = $('.gal__count b', gallery);
      let current = 0;

      const show = (index) => {
        const i = Math.max(0, Math.min(slides - 1, index));
        track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
      };
      const mark = () => {
        const i = Math.max(0, Math.min(slides - 1, Math.round(track.scrollLeft / track.clientWidth)));
        if (i === current) return;
        current = i;
        count.textContent = i + 1;
        prev.disabled = i === 0;
        next.disabled = i === slides - 1;
        thumbs.forEach((thumb, j) => {
          thumb.classList.toggle('is-active', j === i);
          if (j === i) thumb.setAttribute('aria-current', 'true');
          else thumb.removeAttribute('aria-current');
        });
        // Активная миниатюра — посередине ряда
        const thumb = thumbs[i];
        if (thumb) row.scrollTo({ left: thumb.offsetLeft - (row.clientWidth - thumb.offsetWidth) / 2, behavior: 'smooth' });
      };

      let frame = 0;
      track.addEventListener('scroll', () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(mark);
      }, { passive: true });
      prev.addEventListener('click', () => show(current - 1));
      next.addEventListener('click', () => show(current + 1));
      row.addEventListener('click', (e) => {
        const thumb = e.target.closest('[data-gal-to]');
        if (thumb) show(Number(thumb.dataset.galTo));
      });
      track.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        show(current + (e.key === 'ArrowRight' ? 1 : -1));
      });
      // При повороте экрана остаёмся на том же кадре
      window.addEventListener('resize', () => track.scrollTo({ left: current * track.clientWidth }));
    });
  }

  bindHeader();
  bindSearch();
  bindBooking();
  bindContact();
  bindReveal();
  bindSliders();
  bindGalleries();
  loadCatalog();
})();
