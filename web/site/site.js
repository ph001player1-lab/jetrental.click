/**
 * ============================================================================
 * JetRental — логика сайта
 * ============================================================================
 * - каталог: GET /api/public/catalog (модели, цены и фото — лист Catalog,
 *   «свободно сейчас» — Автопрокат);
 * - подбор по датам: GET /api/public/availability;
 * - заявки (бронь и форма «Contact us»): POST /api/public/request → рабочая
 *   группа в Telegram с кнопками Take / Can't.
 * ============================================================================
 */
(() => {
  'use strict';

  const API = '/api/public';
  const TZ = 'Asia/Bangkok';
  const WHATSAPP = document.body.dataset.whatsapp;
  const TYPE_LABEL = { scooter: 'Scooter', motorcycle: 'Motorbike', car: 'Car' };
  const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍️', car: '🚗' };
  const ERRORS = {
    name_required: 'Please enter your name.',
    invalid_phone: 'Please enter a valid phone number with country code.',
    invalid_email: 'Please check the email address.',
    message_required: 'Please write a message.',
    invalid_dates: 'Please choose pick-up and return dates.',
    date_past: 'The pick-up date has already passed.',
    date_order: 'The return date must be after the pick-up date.',
    too_long: 'Maximum rental period is one year.',
    too_many_requests: 'Too many requests. Please try again later or message us on WhatsApp.'
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `${new Intl.NumberFormat('en-US').format(n)} ฿`;
  const DAY_MS = 86400000;

  /** Сегодня по Бангкоку: 'YYYY-MM-DD' */
  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
  const niceDate = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${iso}T00:00:00Z`));

  const state = { catalog: new Map(), search: null, booking: null };

  async function api(path, body) {
    const init = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    const response = await fetch(API + path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { code: data.error });
    return data;
  }

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
    $('#year').textContent = new Date().getFullYear();
  }

  /* ------------------------------------------------------------- Карточки */

  const WA_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M17.5 14.4c-.3-.1-1.8-.9-2-1s-.5-.1-.7.1-.8 1-.9 1.2-.3.2-.6.1a8.2 8.2 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.8.4 3.5 3.5 0 0 0-1.1 2.6 6 6 0 0 0 1.3 3.2 13.8 13.8 0 0 0 5.3 4.7c2 .9 2.8.9 3.8.8.6-.1 1.8-.8 2.1-1.5s.3-1.3.2-1.5-.3-.2-.6-.3zM12 21.8a9.8 9.8 0 0 1-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A9.8 9.8 0 1 1 12 21.8zM20.5 3.5A11.8 11.8 0 0 0 1.9 17.7L.2 24l6.4-1.7A11.8 11.8 0 0 0 24 12a11.7 11.7 0 0 0-3.5-8.5z"/></svg>';

  function media(item, badge = '') {
    const img = item.photo
      ? `<img src="${esc(item.photo)}" alt="${esc(item.model)}" loading="lazy" width="320" height="220" />`
      : `<span class="vcard__placeholder" aria-hidden="true">${TYPE_ICON[item.type] || '🚘'}</span>`;
    return `<div class="vcard__media">${badge}${img}</div>`;
  }

  function availabilityBadge(item) {
    if (item.availableNow === true) return '<span class="badge badge--free">Available now</span>';
    if (item.availableNow === false) return '<span class="badge badge--busy">Booked now · ask for dates</span>';
    return '';
  }

  function catalogCard(item) {
    const price = item.priceFrom
      ? `from <b>${money(item.priceFrom)}</b> / day`
      : '<span class="vcard__ask">Price on request</span>';
    return `
      <article class="vcard">
        ${media(item, availabilityBadge(item))}
        <div class="vcard__body">
          ${item.description ? `<div class="vcard__spec">${esc(item.description)}</div>` : ''}
          <h3>${esc(item.model)}</h3>
          <div class="vcard__price">${price}</div>
          <div class="vcard__actions">
            <button class="btn btn--primary btn--sm" type="button" data-book="${esc(item.model)}">Book</button>
            <a class="btn btn--wa btn--sm" href="${esc(waLink(`Hello! I am interested in ${item.model}`))}" target="_blank" rel="noopener" aria-label="Ask about ${esc(item.model)} in WhatsApp">${WA_ICON}</a>
          </div>
        </div>
      </article>`;
  }

  function priceLines(price, days) {
    if (price?.total) {
      return `<div class="vcard__price"><b>${money(price.perDay)}</b> / day</div>
              <div class="vcard__total">≈ <b>${money(price.total)}</b> for ${days} ${days === 1 ? 'day' : 'days'}${price.deposit ? ` · deposit ${money(price.deposit)}` : ''}</div>`;
    }
    if (price?.fromPerDay) return `<div class="vcard__price">from <b>${money(price.fromPerDay)}</b> / day</div>`;
    return '<div class="vcard__price"><span class="vcard__ask">Price on request</span></div>';
  }

  function resultCard(option, search) {
    const info = state.catalog.get(option.model) || { model: option.model, type: search.type };
    return `
      <article class="vcard">
        ${media({ ...info, model: option.model }, '<span class="badge badge--free">Free for your dates</span>')}
        <div class="vcard__body">
          ${info.description ? `<div class="vcard__spec">${esc(info.description)}</div>` : ''}
          <h3>${esc(option.model)}</h3>
          ${priceLines(option.price, search.days)}
          <div class="vcard__actions">
            <button class="btn btn--primary btn--sm" type="button" data-book="${esc(option.model)}" data-type="${esc(search.type)}">Book</button>
            <a class="btn btn--wa btn--sm" href="${esc(waLink(`Hello! I am interested in ${option.model} from ${niceDate(search.from)} to ${niceDate(search.to)}`))}" target="_blank" rel="noopener" aria-label="Ask in WhatsApp">${WA_ICON}</a>
          </div>
        </div>
      </article>`;
  }

  /* --------------------------------------------------------------- Каталог */

  async function loadCatalog() {
    const grids = $$('[data-catalog]');
    try {
      const { models } = await api('/catalog');
      models.forEach((m) => state.catalog.set(m.model, m));
      for (const grid of grids) {
        const items = models.filter((m) => m.type === grid.dataset.catalog);
        grid.innerHTML = items.length
          ? items.map(catalogCard).join('')
          : `<p class="muted">Ask us about availability in <a href="${esc(waLink('Hello! What vehicles are available?'))}" target="_blank" rel="noopener">WhatsApp</a>.</p>`;
      }
    } catch {
      for (const grid of grids) {
        grid.innerHTML = `<p class="muted">Could not load the catalog. Please message us in <a href="${esc(waLink('Hello! What vehicles are available?'))}" target="_blank" rel="noopener">WhatsApp</a>.</p>`;
      }
    }
  }

  /* ---------------------------------------------------- Подбор по датам */

  function setupDateInputs(fromInput, toInput, from, to) {
    const today = todayIso();
    fromInput.min = today;
    fromInput.value = from;
    toInput.min = addDays(from, 1);
    toInput.value = to;
    fromInput.addEventListener('change', () => {
      if (!fromInput.value) return;
      toInput.min = addDays(fromInput.value, 1);
      if (!toInput.value || toInput.value <= fromInput.value) toInput.value = addDays(fromInput.value, 7);
    });
  }

  function bindSearch() {
    const form = $('#search-form');
    const start = addDays(todayIso(), 1);
    setupDateInputs(form.from, form.to, start, addDays(start, 7));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = $('button[type="submit"]', form);
      const search = { type: form.type.value, from: form.from.value, to: form.to.value };
      const section = $('#results');
      const grid = $('#results-grid');
      const error = $('#results-error');
      section.hidden = false;
      error.hidden = true;
      grid.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      $('#results-title').textContent = `${TYPE_LABEL[search.type]}s for ${niceDate(search.from)} – ${niceDate(search.to)}`;
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      button.disabled = true;
      try {
        const data = await api(`/availability?type=${encodeURIComponent(search.type)}&from=${search.from}&to=${search.to}`);
        state.search = { ...search, days: data.days };
        $('#results-title').textContent = `${data.models.length ? data.models.length : 'No'} ${TYPE_LABEL[search.type].toLowerCase()}${data.models.length === 1 ? '' : 's'} free · ${niceDate(search.from)} – ${niceDate(search.to)} (${data.days} ${data.days === 1 ? 'day' : 'days'})`;
        grid.innerHTML = data.models.length
          ? data.models.map((o) => resultCard(o, state.search)).join('')
          : `<p class="muted">Everything is booked for these dates. Try other dates or <a href="${esc(waLink(`Hello! I need a ${TYPE_LABEL[search.type].toLowerCase()} from ${niceDate(search.from)} to ${niceDate(search.to)}`))}" target="_blank" rel="noopener">ask us in WhatsApp</a> — we'll find an option.</p>`;
      } catch (err) {
        grid.innerHTML = '';
        error.hidden = false;
        error.textContent = ERRORS[err.code] || 'Could not check availability. Please try again.';
      } finally {
        button.disabled = false;
      }
    });

    $('#results-close').addEventListener('click', () => {
      $('#results').hidden = true;
      state.search = null;
    });
  }

  /* --------------------------------------------------------- Бронирование */

  const dialog = $('#book-dialog');
  const bookForm = $('#book-form');
  let estimateTimer = null;

  function openBooking(model, typeHint) {
    const info = state.catalog.get(model) || { model, type: typeHint };
    const type = info.type || typeHint;
    state.booking = { model, type };

    $('#book-title').textContent = model;
    $('#book-type').textContent = TYPE_LABEL[type] || '';
    $('#book-price').textContent = info.priceFrom ? `from ${money(info.priceFrom)} / day` : '';
    const photo = $('#book-photo');
    photo.hidden = !info.photo;
    if (info.photo) photo.src = info.photo;

    const start = addDays(todayIso(), 1);
    const from = state.search?.from || start;
    const to = state.search?.to || addDays(from, 7);
    bookForm.from.value = from;
    bookForm.to.value = to;
    bookForm.from.min = todayIso();
    bookForm.to.min = addDays(from, 1);

    setStatus(bookForm, '');
    bookForm.hidden = false;
    $('#book-done').hidden = true;
    updateWaLink();
    updateEstimate();
    dialog.showModal();
  }

  function updateWaLink() {
    const { model } = state.booking;
    const from = bookForm.from.value;
    const to = bookForm.to.value;
    const dates = from && to ? ` from ${niceDate(from)} to ${niceDate(to)}` : '';
    $('#book-wa').href = waLink(`Hello! I am interested in ${model}${dates}`);
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
          box.textContent = 'Not available for these dates — send a request anyway and we will suggest an option.';
        } else if (option.price?.total) {
          box.textContent = `✓ Available · ${money(option.price.perDay)}/day · ≈ ${money(option.price.total)} for ${data.days} days`;
        } else {
          box.textContent = `✓ Available for your dates (${data.days} ${data.days === 1 ? 'day' : 'days'})`;
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
      setStatus(bookForm, 'Sending…');
      try {
        const result = await api('/request', {
          name: bookForm.name.value,
          phone: bookForm.phone.value,
          message: bookForm.message.value,
          type: state.booking.type,
          model: state.booking.model,
          from: bookForm.from.value,
          to: bookForm.to.value,
          lang: 'en',
          website: bookForm.website.value
        });
        $('#done-title').textContent = result.id ? `Request #${result.id} received!` : 'Request received!';
        bookForm.hidden = true;
        $('#book-done').hidden = false;
        bookForm.message.value = '';
      } catch (err) {
        setStatus(bookForm, ERRORS[err.code] || 'Could not send the request. Please try WhatsApp.', 'error');
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
      if (!form.message.value.trim()) return setStatus(form, ERRORS.message_required, 'error');
      button.disabled = true;
      setStatus(form, 'Sending…');
      try {
        await api('/request', {
          name: form.name.value,
          phone: form.phone.value,
          email: form.email.value,
          message: form.message.value,
          lang: 'en',
          website: form.website.value
        });
        form.reset();
        setStatus(form, '✓ Thank you! Our manager will contact you shortly.', 'ok');
      } catch (err) {
        setStatus(form, ERRORS[err.code] || 'Could not send. Please message us in WhatsApp.', 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  bindHeader();
  bindSearch();
  bindBooking();
  bindContact();
  loadCatalog();
})();
