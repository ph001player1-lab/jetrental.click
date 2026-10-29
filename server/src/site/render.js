/**
 * ============================================================================
 * HTML страниц сайта (собирается на сервере)
 * ============================================================================
 * Поисковики сразу видят весь текст, модели и цены — не нужно ждать скрипт.
 * site.js в браузере добавляет подбор по датам, окно брони и формы.
 * Тексты — из web/site/i18n.js (t), данные — из каталога и прайса.
 * ============================================================================
 */

import { LOCALES, OG_LOCALES, SITE_LANGS } from './texts.js';
import { pagePath, langPrefix, CATEGORY_BY_TYPE, TYPE_ORDER } from './urls.js';

const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };
const LANG_LABEL = { en: 'EN', ru: 'RU', th: 'ไทย', zh: '中文' };
const NAV_KEY = { scooter: 'nav.scooters', motorcycle: 'nav.motorbikes', car: 'nav.cars' };
const SECTION_ID = { scooter: 'scooters', motorcycle: 'motorbikes', car: 'cars' };
// Картинка первого экрана разделов
const HERO_PHOTO = {
  home: '/img/models/ducati-xdiavel-1260.webp',
  scooter: '/img/models/honda-adv-350.webp',
  motorcycle: '/img/models/ducati-xdiavel-1260.webp',
  car: '/img/models/ford-ranger-4wd.webp'
};

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (n) => `${new Intl.NumberFormat('en-US').format(n)} ฿`;
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const isFullPhoto = (photo) => /\.jpe?g$/i.test(photo || '');

const waLink = (brand, text) => `https://wa.me/${brand.whatsapp}?text=${encodeURIComponent(text)}`;
const tgLink = (brand) => `https://t.me/${brand.telegram}`;

/* --------------------------------------------------------------- <head> */

function jsonLd(data) {
  // «</» внутри строк не должно закрыть тег script
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

function head(ctx, meta) {
  const { brand, lang } = ctx;
  const abs = (p) => `${brand.origin}${p}`;
  const noindex = brand.preview || meta.noindex;
  const links = meta.alternates
    ? [
        `<link rel="canonical" href="${esc(abs(meta.alternates[lang]))}" />`,
        ...SITE_LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(abs(meta.alternates[l]))}" />`),
        `<link rel="alternate" hreflang="x-default" href="${esc(abs(meta.alternates.en))}" />`
      ].join('\n  ')
    : '';
  const verification = [
    ...brand.googleVerification.map((code) => `<meta name="google-site-verification" content="${esc(code)}" />`),
    ...(ctx.verification.google || []).map((code) => `<meta name="google-site-verification" content="${esc(code)}" />`),
    ...(ctx.verification.yandex || []).map((code) => `<meta name="yandex-verification" content="${esc(code)}" />`)
  ].join('\n  ');
  const asset = `/${brand.assets}`;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.description)}" />
  ${noindex ? '<meta name="robots" content="noindex, nofollow" />' : ''}
  ${links}
  <meta name="theme-color" content="#0b1f33" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${esc(brand.name)}" />
  <meta property="og:title" content="${esc(meta.title)}" />
  <meta property="og:description" content="${esc(meta.description)}" />
  ${meta.alternates ? `<meta property="og:url" content="${esc(abs(meta.alternates[lang]))}" />` : ''}
  <meta property="og:locale" content="${OG_LOCALES[lang]}" />
  <meta property="og:image" content="${esc(abs(meta.image || `${asset}/og-image.jpg`))}" />
  ${verification}
  <link rel="icon" href="${asset}/icon-32.png" sizes="32x32" type="image/png" />
  <link rel="icon" href="${asset}/icon-192.png" sizes="192x192" type="image/png" />
  <link rel="apple-touch-icon" href="${asset}/apple-touch-icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${ctx.assetUrl('site.css')}" />
  ${(meta.ld || []).map(jsonLd).join('\n  ')}
</head>`;
}

/* -------------------------------------------------------- Шапка и подвал */

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <symbol id="i-wa" viewBox="0 0 24 24"><path fill="currentColor" d="M17.5 14.4c-.3-.1-1.8-.9-2-1s-.5-.1-.7.1-.8 1-.9 1.2-.3.2-.6.1a8.2 8.2 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.8.4 3.5 3.5 0 0 0-1.1 2.6 6 6 0 0 0 1.3 3.2 13.8 13.8 0 0 0 5.3 4.7c2 .9 2.8.9 3.8.8.6-.1 1.8-.8 2.1-1.5s.3-1.3.2-1.5-.3-.2-.6-.3zM12 21.8a9.8 9.8 0 0 1-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A9.8 9.8 0 1 1 12 21.8zM20.5 3.5A11.8 11.8 0 0 0 1.9 17.7L.2 24l6.4-1.7A11.8 11.8 0 0 0 24 12a11.7 11.7 0 0 0-3.5-8.5z"/></symbol>
    <symbol id="i-tg" viewBox="0 0 24 24"><path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></symbol>
  </svg>`;

const LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z"/></svg>';

function topbar(ctx, alternates) {
  const { brand, lang, t } = ctx;
  const langs = SITE_LANGS.map((l) => {
    const href = alternates ? alternates[l] : pagePath(l, { kind: 'home' });
    return `<a href="${esc(href)}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="true"' : ''}>${LANG_LABEL[l]}</a>`;
  }).join('\n        ');
  return `
  <div class="topbar">
    <div class="container topbar__inner">
      <span class="topbar__item topbar__address">📍 ${esc(t('top.address'))}</span>
      ${brand.phones.map((p) => `<a class="topbar__item topbar__phone" href="tel:${p.tel}">${p.short}</a>`).join('\n      ')}
      <nav class="lang" aria-label="Language">
        ${langs}
      </nav>
      <a class="staff-link" href="${brand.staffUrl}" rel="nofollow">${LOCK} Staff only</a>
    </div>
  </div>`;
}

function navLinks(ctx) {
  const { lang, t } = ctx;
  return [
    ...TYPE_ORDER.map((type) => `<a href="${pagePath(lang, { kind: 'category', type })}">${esc(t(NAV_KEY[type]))}</a>`),
    `<a href="#services">${esc(t('nav.services'))}</a>`,
    `<a href="#contact">${esc(t('nav.contact'))}</a>`
  ];
}

function header(ctx) {
  const { brand, lang, t } = ctx;
  const asset = `/${brand.assets}`;
  return `
  <header class="header" id="top">
    <div class="container header__inner">
      <a class="logo" href="${pagePath(lang, { kind: 'home' })}">
        <img src="${asset}/logo-wordmark.webp" alt="${esc(brand.name)}" width="${brand.logo.width}" height="${brand.logo.height}" />
      </a>
      <nav class="nav" id="nav" aria-label="Main">
        ${navLinks(ctx).join('\n        ')}
      </nav>
      <div class="header__actions">
        <a class="btn btn--wa header__msg" href="${esc(waLink(brand, t('wa.general')))}" target="_blank" rel="noopener" aria-label="WhatsApp">
          ${icon('wa', 18)}
          <span>WhatsApp</span>
        </a>
        <a class="btn btn--tg header__msg" href="${tgLink(brand)}" target="_blank" rel="noopener" aria-label="Telegram">
          ${icon('tg', 18)}
          <span>Telegram</span>
        </a>
      </div>
      <button class="burger" type="button" aria-label="${esc(t('nav.menu'))}" aria-expanded="false" aria-controls="nav"><span></span><span></span><span></span></button>
    </div>
  </header>`;
}

function footer(ctx) {
  const { brand, lang, t } = ctx;
  const asset = `/${brand.assets}`;
  return `
  <footer class="footer">
    <div class="container footer__inner">
      <a class="logo logo--light" href="${pagePath(lang, { kind: 'home' })}"><img src="${asset}/logo-wordmark-light.webp" alt="${esc(brand.name)}" width="${brand.logo.width}" height="${brand.logo.height}" loading="lazy" /></a>
      <nav class="footer__nav" aria-label="Footer">
        ${navLinks(ctx).filter((_, i) => i !== 3).join('\n        ')}
      </nav>
      <div class="footer__social">
        <a class="icon-btn icon-btn--wa" href="${esc(waLink(brand, t('wa.general')))}" target="_blank" rel="noopener" aria-label="WhatsApp">${icon('wa')}</a>
        <a class="icon-btn icon-btn--tg" href="${tgLink(brand)}" target="_blank" rel="noopener" aria-label="Telegram">${icon('tg')}</a>
        <a class="staff-link staff-link--footer" href="${brand.staffUrl}" rel="nofollow">${LOCK} Staff only</a>
      </div>
      <p class="footer__copy">${esc(t('footer.address'))} · © ${ctx.year} ${esc(brand.name)}</p>
    </div>
  </footer>`;
}

/* ---------------------------------------------------------------- Блоки */

function hero(ctx, type = null) {
  const { lang, t } = ctx;
  const facts = `
          <ul class="hero__facts">
            <li>${t('hero.fact1')}</li>
            <li>${t('hero.fact2')}</li>
            <li>${t('hero.fact3')}</li>
          </ul>`;
  const photo = HERO_PHOTO[type || 'home'];
  if (!type) {
    return `
    <section class="hero">
      <div class="hero__sun" aria-hidden="true"></div>
      ${WAVES}
      <div class="container hero__inner">
        <div class="hero__text">
          <p class="eyebrow">${esc(t('hero.eyebrow'))}</p>
          <h1><span>${esc(t('hero.title1'))}</span> <span class="hero__accent">${esc(t('hero.title2'))}</span></h1>
          <p class="hero__lead">${esc(t('hero.lead'))}</p>
          <div class="hero__ctas">
            <a class="btn btn--sun" href="${pagePath(lang, { kind: 'category', type: 'motorcycle' })}">${esc(t('hero.ctaMoto'))}</a>
            <a class="btn btn--glass" href="${pagePath(lang, { kind: 'category', type: 'car' })}">${esc(t('hero.ctaCars'))}</a>
            <a class="btn btn--glass" href="${pagePath(lang, { kind: 'category', type: 'scooter' })}">${esc(t('hero.ctaScooters'))}</a>
          </div>${facts}
        </div>
        <div class="hero__media">
          <img src="${photo}" alt="Ducati XDiavel 1260 S" width="539" height="440" fetchpriority="high" />
        </div>
      </div>
    </section>`;
  }
  const category = CATEGORY_BY_TYPE[type];
  return `
    <section class="hero hero--page">
      <div class="hero__sun" aria-hidden="true"></div>
      ${WAVES}
      <div class="container hero__inner">
        <div class="hero__text">
          ${crumbs(ctx, [{ label: t(NAV_KEY[type]) }], true)}
          <h1>${esc(t(`page.${category}.h1`))}</h1>
          <p class="hero__lead">${esc(t(`page.${category}.lead`))}</p>${facts}
        </div>
        <div class="hero__media">
          <img src="${photo}" alt="${esc(t(`page.${category}.h1`))}" width="560" height="400" fetchpriority="high" />
        </div>
      </div>
    </section>`;
}

const WAVES = `<svg class="hero__waves" viewBox="0 0 1440 160" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 96c120-32 240-48 360-32s240 64 360 64 240-48 360-64 240 0 360 32v64H0z" fill="rgba(94,234,212,.12)"/>
        <path d="M0 120c160-24 320-24 480 0s320 24 480 0 320-24 480 0v40H0z" fill="rgba(94,234,212,.2)"/>
      </svg>`;

/** Хлебные крошки: Главная › … (последний пункт — текущая страница, без ссылки) */
function crumbs(ctx, items, light = false) {
  const { lang, t } = ctx;
  const all = [{ label: t('crumb.home'), href: pagePath(lang, { kind: 'home' }) }, ...items];
  return `<nav class="crumbs${light ? ' crumbs--light' : ''}" aria-label="Breadcrumb"><ol>${all.map((item, i) => (i < all.length - 1 && item.href
    ? `<li><a href="${esc(item.href)}">${esc(item.label)}</a></li>`
    : `<li aria-current="page">${esc(item.label)}</li>`)).join('')}</ol></nav>`;
}

/** Подбор по датам; plain — без «наезда» на первый экран (на странице модели его нет) */
function search(ctx, type = null, plain = false) {
  const { t } = ctx;
  const options = TYPE_ORDER.map((ty) => `<option value="${ty}"${ty === type ? ' selected' : ''}>${TYPE_ICON[ty]} ${esc(t(`type.${ty}`))}</option>`).join('\n            ');
  return `
    <section class="search-wrap container${plain ? ' search-wrap--plain' : ''}" aria-label="${esc(t('search.title'))}">
      <form class="search" id="search-form">
        <div class="search__title">
          <b>${esc(t('search.title'))}</b>
          <span>${esc(t('search.live'))}</span>
        </div>
        <label class="search__field">
          <span>${esc(t('search.vehicle'))}</span>
          <select name="type" required>
            ${options}
          </select>
        </label>
        <label class="search__field">
          <span>${esc(t('search.pickup'))}</span>
          <input type="date" name="from" required />
        </label>
        <label class="search__field">
          <span>${esc(t('search.return'))}</span>
          <input type="date" name="to" required />
        </label>
        <button class="btn btn--primary search__btn" type="submit">${esc(t('search.submit'))}</button>
      </form>
    </section>

    <section class="section results" id="results" hidden>
      <div class="container">
        <div class="section__head">
          <div>
            <p class="eyebrow eyebrow--dark">${esc(t('results.eyebrow'))}</p>
            <h2 id="results-title"></h2>
          </div>
          <button class="link" type="button" id="results-close">${esc(t('results.clear'))}</button>
        </div>
        <p class="error" id="results-error" hidden></p>
        <div class="grid" id="results-grid"></div>
      </div>
    </section>`;
}

export function modelUrl(lang, item) {
  return pagePath(lang, { kind: 'model', type: item.type, slug: item.slug });
}

function badge(ctx, item) {
  if (item.availableNow === true) return `<span class="badge badge--free">${esc(ctx.t('badge.free'))}</span>`;
  if (item.availableNow === false) return `<span class="badge badge--busy">${esc(ctx.t('badge.busy'))}</span>`;
  return '';
}

function photoTag(item, { width = 320, height = 220, lazy = true, priority = false } = {}) {
  const typeIcon = TYPE_ICON[item.type] || '🚘';
  if (!item.photo) return `<span class="vcard__placeholder" aria-hidden="true">${typeIcon}</span>`;
  return `<img src="${esc(item.photo)}" alt="${esc(item.model)}"${lazy ? ' loading="lazy"' : ''}${priority ? ' fetchpriority="high"' : ''} width="${width}" height="${height}" data-icon="${typeIcon}" />`;
}

function messengerButtons(ctx, model) {
  const { brand, t } = ctx;
  return `<a class="btn btn--wa btn--sm" href="${esc(waLink(brand, t('wa.model', { model })))}" target="_blank" rel="noopener" aria-label="${esc(model)} — WhatsApp">${icon('wa')}</a>
          <a class="btn btn--tg btn--sm" href="${tgLink(brand)}" target="_blank" rel="noopener" aria-label="${esc(model)} — Telegram">${icon('tg')}</a>`;
}

function card(ctx, item) {
  const { lang, t } = ctx;
  const href = modelUrl(lang, item);
  const price = item.priceFrom
    ? t('card.from', { price: money(item.priceFrom) })
    : `<span class="vcard__ask">${esc(t('card.ask'))}</span>`;
  return `
      <article class="vcard">
        <a class="vcard__media${isFullPhoto(item.photo) ? ' vcard__media--photo' : ''}" href="${esc(href)}" tabindex="-1" aria-hidden="true">${badge(ctx, item)}${photoTag(item)}</a>
        <div class="vcard__body">
          ${item.description ? `<div class="vcard__spec">${esc(item.description)}</div>` : ''}
          <h3><a href="${esc(href)}">${esc(item.model)}</a></h3>
          <div class="vcard__price">${price}</div>
          <div class="vcard__actions">
          <button class="btn btn--primary btn--sm" type="button" data-book="${esc(item.model)}" data-type="${esc(item.type)}">${esc(t('card.book'))}</button>
          ${messengerButtons(ctx, item.model)}
          </div>
        </div>
      </article>`;
}

function grid(ctx, items, catalogError) {
  const { brand, t } = ctx;
  const link = `<a href="${esc(waLink(brand, t('wa.which')))}" target="_blank" rel="noopener">WhatsApp</a>`;
  if (catalogError) return `<p class="muted">${t('catalog.error', { link })}</p>`;
  if (!items.length) return `<p class="muted">${t('catalog.empty', { link })}</p>`;
  return items.map((item) => card(ctx, item)).join('');
}

function catalogSection(ctx, type, data, { sand = false, more = false } = {}) {
  const { lang, t } = ctx;
  const items = data.models.filter((m) => m.type === type);
  const category = CATEGORY_BY_TYPE[type];
  return `
    <section class="section${sand ? ' section--sand' : ''}" id="${SECTION_ID[type]}">
      <div class="container">
        <div class="section__head">
          <div>
            <p class="eyebrow eyebrow--dark">${esc(t(NAV_KEY[type]))}</p>
            <h2>${esc(t(`sec.${category}`))}</h2>
          </div>
          ${more ? `<a class="section__more" href="${pagePath(lang, { kind: 'category', type })}">${esc(t(`more.${category}`))}</a>` : ''}
        </div>
        <div class="grid">${grid(ctx, items, data.error)}</div>
      </div>
    </section>`;
}

function priority(ctx) {
  const { t } = ctx;
  const items = [['🛡️', 'p1'], ['✨', 'p2'], ['🔧', 'p3'], ['🕐', 'p4']]
    .map(([emoji, key]) => `<li><span>${emoji}</span><div><b>${esc(t(`${key}.title`))}</b><p>${esc(t(`${key}.text`))}</p></div></li>`).join('\n          ');
  return `
    <section class="section section--navy">
      <div class="container priority">
        <div>
          <p class="eyebrow">${esc(t('priority.eyebrow'))}</p>
          <h2>${esc(t('priority.title'))}</h2>
          <p class="priority__text">${esc(t('priority.text'))}</p>
        </div>
        <ul class="priority__list">
          ${items}
        </ul>
      </div>
    </section>`;
}

function services(ctx) {
  const { t } = ctx;
  const items = [['👶', 's1'], ['🧑‍✈️', 's2'], ['⛑️', 's3'], ['🚚', 's4']].map(([emoji, key]) => `
          <article class="service">
            <div class="service__icon">${emoji}</div>
            <h3>${esc(t(`${key}.title`))}</h3>
            <p>${esc(t(`${key}.text`))}</p>
          </article>`).join('');
  return `
    <section class="section" id="services">
      <div class="container">
        <div class="section__head">
          <div>
            <p class="eyebrow eyebrow--dark">${esc(t('services.eyebrow'))}</p>
            <h2>${esc(t('services.title'))}</h2>
          </div>
        </div>
        <div class="services">${items}
        </div>
      </div>
    </section>`;
}

// Оригинальные отзывы клиентов (не переводятся)
const REVIEWS = [
  ['Брал два мото в аренду, супер выгодные условия и шикарный подход к клиенту! Буду обращаться снова, спасибо за быструю доставку!', 'Egor Bobrov'],
  ['Арендовала новенький Filano, очень довольна отношением владельца: всегда на связи, подсказывал всё по байку. Весь залог вернул по окончании аренды. Рекомендую!', 'Daniel Lee'],
  ['Было офигительно круто! Мотоциклы в отличном состоянии со всем необходимым, хороший опрятный сервис, всем рекомендую!:)', 'Ann Malyisheva']
];

function reviews(ctx) {
  const { t } = ctx;
  return `
    <section class="section section--sand">
      <div class="container">
        <div class="section__head">
          <div>
            <p class="eyebrow eyebrow--dark">${esc(t('reviews.eyebrow'))}</p>
            <h2>${esc(t('reviews.title'))}</h2>
          </div>
        </div>
        <div class="reviews">${REVIEWS.map(([text, name]) => `
          <figure class="review">
            <div class="review__stars" aria-label="5/5">★★★★★</div>
            <blockquote lang="ru">${esc(text)}</blockquote>
            <figcaption>${esc(name)}</figcaption>
          </figure>`).join('')}
        </div>
      </div>
    </section>`;
}

function contact(ctx) {
  const { brand, t } = ctx;
  return `
    <section class="section" id="contact">
      <div class="container contact">
        <div class="contact__info">
          <p class="eyebrow eyebrow--dark">${esc(t('contact.eyebrow'))}</p>
          <h2>${esc(t('contact.title'))}</h2>
          <p class="muted">${esc(t('contact.lead'))}</p>
          <ul class="contact__list">
            <li><span>📍</span><div><b>${esc(t('contact.beach'))}</b><br><span>${esc(t('contact.country'))}</span><br><a href="https://www.google.com/maps/dir/?api=1&amp;destination=Bang+Tao+Beach+Phuket" target="_blank" rel="noopener">${esc(t('contact.route'))}</a></div></li>
            <li><span>📞</span><div>${brand.phones.map((p) => `<a href="tel:${p.tel}">${p.full}</a>`).join('<br>')}</div></li>
            <li><span>✉️</span><div><a href="mailto:${esc(brand.email)}">${esc(brand.email)}</a></div></li>
          </ul>
          <div class="contact__messengers">
            <a class="btn btn--wa" href="${esc(waLink(brand, t('wa.general')))}" target="_blank" rel="noopener">${icon('wa', 18)}WhatsApp</a>
            <a class="btn btn--tg" href="${tgLink(brand)}" target="_blank" rel="noopener">${icon('tg', 18)}Telegram</a>
          </div>
        </div>

        <form class="form card" id="contact-form" novalidate>
          <label class="field"><span>${esc(t('form.firstName'))}</span><input name="name" autocomplete="given-name" required maxlength="80" /></label>
          <label class="field"><span>${esc(t('form.phone'))}</span><input name="phone" type="tel" autocomplete="tel" required placeholder="+66 …" /></label>
          <label class="field"><span>${esc(t('form.email'))}</span><input name="email" type="email" autocomplete="email" /></label>
          <label class="field"><span>${esc(t('form.message'))}</span><textarea name="message" rows="4" required maxlength="1000"></textarea></label>
          <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off" /></label>
          <button class="btn btn--primary" type="submit">${esc(t('form.submit'))}</button>
          <p class="form__status" role="status"></p>
        </form>
      </div>
    </section>`;
}

function bookingDialog(ctx) {
  const { brand, t } = ctx;
  return `
  <dialog class="dialog" id="book-dialog">
    <form class="dialog__body" id="book-form" novalidate>
      <button class="dialog__close" type="button" data-close aria-label="${esc(t('dialog.close'))}">×</button>
      <div class="dialog__vehicle">
        <img id="book-photo" alt="" width="160" height="110" />
        <div>
          <p class="eyebrow eyebrow--dark" id="book-type"></p>
          <h3 id="book-title"></h3>
          <p class="muted" id="book-price"></p>
        </div>
      </div>
      <div class="form__row">
        <label class="field"><span>${esc(t('dialog.pickup'))}</span><input type="date" name="from" required /></label>
        <label class="field"><span>${esc(t('dialog.return'))}</span><input type="date" name="to" required /></label>
      </div>
      <p class="book__estimate" id="book-estimate" hidden></p>
      <label class="field"><span>${esc(t('dialog.name'))}</span><input name="name" autocomplete="name" required maxlength="80" /></label>
      <label class="field"><span>${esc(t('dialog.phone'))}</span><input name="phone" type="tel" autocomplete="tel" required placeholder="+66 …" /></label>
      <label class="field"><span>${esc(t('dialog.comment'))}</span><textarea name="message" rows="2" maxlength="1000" placeholder="${esc(t('dialog.commentPh'))}"></textarea></label>
      <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off" /></label>
      <button class="btn btn--primary btn--block" type="submit">${esc(t('dialog.submit'))}</button>
      <p class="form__status" role="status"></p>
      <div class="dialog__alt">
        <span>${esc(t('dialog.alt'))}</span>
        <a class="btn btn--wa btn--sm" id="book-wa" target="_blank" rel="noopener">${icon('wa', 16)}WhatsApp</a>
        <a class="btn btn--tg btn--sm" href="${tgLink(brand)}" target="_blank" rel="noopener">${icon('tg', 16)}Telegram</a>
      </div>
    </form>
    <div class="dialog__body dialog__done" id="book-done" hidden>
      <div class="done__icon">✅</div>
      <h3 id="done-title">${esc(t('done.titleNoId'))}</h3>
      <p>${esc(t('done.text'))}</p>
      <button class="btn btn--primary btn--block" type="button" data-close>${esc(t('done.button'))}</button>
    </div>
  </dialog>`;
}

function layout(ctx, meta, main) {
  const { brand, lang } = ctx;
  return `${head(ctx, meta)}
<body data-whatsapp="${brand.whatsapp}" data-telegram="${brand.telegram}" data-brand="${brand.id}" data-brand-name="${esc(brand.name)}" data-prefix="${langPrefix(lang)}">
  ${SPRITE}
${topbar(ctx, meta.alternates)}
${header(ctx)}

  <main>${main}
  </main>
${footer(ctx)}
${bookingDialog(ctx)}

  <script src="${ctx.assetUrl('i18n.js')}"></script>
  <script src="${ctx.assetUrl('site.js')}"></script>
</body>
</html>
`;
}

/* --------------------------------------------------------------- Страницы */

const alternatesFor = (page) => Object.fromEntries(SITE_LANGS.map((l) => [l, pagePath(l, page)]));

function organization(ctx) {
  const { brand } = ctx;
  return {
    '@context': 'https://schema.org',
    '@type': 'AutoRental',
    name: brand.name,
    url: `${brand.origin}/`,
    logo: `${brand.origin}/${brand.assets}/icon-512.png`,
    image: `${brand.origin}/${brand.assets}/og-image.jpg`,
    telephone: brand.phones.map((p) => p.tel),
    email: brand.email,
    address: { '@type': 'PostalAddress', streetAddress: 'Bang Tao Beach', addressLocality: 'Phuket', addressCountry: 'TH' },
    priceRange: '฿฿'
  };
}

function breadcrumbLd(ctx, items) {
  const { brand, lang, t } = ctx;
  const all = [{ label: t('crumb.home'), href: pagePath(lang, { kind: 'home' }) }, ...items];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: all.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.label, item: `${brand.origin}${item.href}` }))
  };
}

const minPrice = (items) => Math.min(...items.map((m) => m.priceFrom).filter(Boolean));

export function renderHome(ctx, data) {
  const { t } = ctx;
  const page = { kind: 'home' };
  const main = `${hero(ctx)}
${search(ctx)}
${TYPE_ORDER.map((type, i) => catalogSection(ctx, type, data, { sand: i === 1, more: true })).join('\n')}
${priority(ctx)}
${services(ctx)}
${reviews(ctx)}
${contact(ctx)}`;
  return layout(ctx, {
    title: t('meta.title'),
    description: t('meta.description'),
    alternates: alternatesFor(page),
    ld: [organization(ctx)]
  }, main);
}

export function renderCategory(ctx, data, type) {
  const { lang, t } = ctx;
  const category = CATEGORY_BY_TYPE[type];
  const page = { kind: 'category', type };
  const items = data.models.filter((m) => m.type === type);
  const from = minPrice(items);
  const main = `${hero(ctx, type)}
${search(ctx, type)}
${catalogSection(ctx, type, data)}
${services(ctx)}
${priority(ctx)}
${reviews(ctx)}
${contact(ctx)}`;
  return layout(ctx, {
    title: t(`page.${category}.title`),
    description: Number.isFinite(from) ? t(`page.${category}.desc`, { price: money(from) }) : t(`page.${category}.descAsk`),
    alternates: alternatesFor(page),
    ld: [breadcrumbLd(ctx, [{ label: t(NAV_KEY[type]), href: pagePath(lang, page) }])]
  }, main);
}

/** '12-20' → '20 дек.' (на языке страницы) */
function dayMonth(lang, md) {
  const date = new Date(`2000-${md}T00:00:00Z`);
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date);
}

function priceTable(ctx, item, tariffs) {
  const { lang, t } = ctx;
  if (!tariffs.length) return `<p class="muted">${esc(t('model.noPrices'))}</p>`;
  const heads = [1, 2, 3, 4, 5].map((i) => `<th scope="col">${esc(t(`tier.${i}`))}</th>`).join('');
  const rows = tariffs.map((s) => {
    const label = s.key ? t(`season.${s.key}`) : s.name;
    const ranges = s.ranges.map((r) => `${dayMonth(lang, r.from)} – ${dayMonth(lang, r.to)}`).join(', ');
    const cells = s.tiers.map((price) => `<td>${price ? esc(money(price)) : '—'}</td>`).join('');
    return `<tr><th scope="row"><b>${esc(label)}</b><small>${esc(ranges)}</small></th>${cells}</tr>`;
  }).join('\n              ');
  const deposits = [...new Set(tariffs.map((s) => s.deposit).filter(Boolean))];
  const deposit = deposits.length ? `<p class="prices__deposit">${esc(t('model.deposit', { amount: money(Math.min(...deposits)) }))}</p>` : '';
  return `
        <div class="table-wrap">
          <table class="prices">
            <caption>${esc(t('model.pricesCaption', { model: item.model }))}</caption>
            <thead><tr><th scope="col">${esc(t('model.season'))}</th>${heads}</tr></thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
        ${deposit}
        <p class="muted prices__note">${esc(t('model.note'))}</p>`;
}

export function renderModel(ctx, data, item, tariffs) {
  const { lang, t } = ctx;
  const type = item.type;
  const category = CATEGORY_BY_TYPE[type];
  const page = { kind: 'model', type, slug: item.slug };
  const crumbItems = [
    { label: t(NAV_KEY[type]), href: pagePath(lang, { kind: 'category', type }) },
    { label: item.model, href: pagePath(lang, page) }
  ];
  const price = item.priceFrom
    ? `<div class="model__price">${t('card.from', { price: money(item.priceFrom) })}</div>`
    : `<div class="model__price"><span class="vcard__ask">${esc(t('card.ask'))}</span></div>`;
  const others = data.models.filter((m) => m.type === type && m.model !== item.model).slice(0, 8);

  const main = `
    <div class="container">${crumbs(ctx, crumbItems)}</div>
    <section class="model container">
      <div class="model__media${isFullPhoto(item.photo) ? ' vcard__media--photo' : ''}">${badge(ctx, item)}${photoTag(item, { width: 640, height: 440, lazy: false, priority: true })}</div>
      <div class="model__info">
        <p class="eyebrow eyebrow--dark">${esc(t(`type.${type}`))}${item.description ? ` · ${esc(item.description)}` : ''}</p>
        <h1>${esc(t('model.h1', { model: item.model }))}</h1>
        <p class="model__lead">${esc(t(`model.lead.${type}`, { model: item.model }))}</p>
        ${price}
        <div class="model__actions">
          <button class="btn btn--primary" type="button" data-book="${esc(item.model)}" data-type="${esc(type)}">${esc(t('card.book'))}</button>
          ${messengerButtons(ctx, item.model)}
        </div>
        <ul class="model__facts">
          <li>${t('hero.fact1')}</li>
          <li>${t('hero.fact2')}</li>
          <li>${t('hero.fact3')}</li>
        </ul>
      </div>
    </section>

    <section class="section section--sand" id="prices">
      <div class="container">
        <div class="section__head">
          <div>
            <p class="eyebrow eyebrow--dark">${esc(t('model.pricesEyebrow'))}</p>
            <h2>${esc(t('model.prices'))}</h2>
          </div>
        </div>
        <p class="muted prices__lead">${esc(t('model.pricesLead'))}</p>
        ${priceTable(ctx, item, tariffs)}
      </div>
    </section>
${search(ctx, type, true)}
    <section class="section" id="${SECTION_ID[type]}">
      <div class="container">
        <div class="section__head">
          <div>
            <p class="eyebrow eyebrow--dark">${esc(t(NAV_KEY[type]))}</p>
            <h2>${esc(t('model.more'))}</h2>
          </div>
          <a class="section__more" href="${pagePath(lang, { kind: 'category', type })}">${esc(t(`more.${category}`))}</a>
        </div>
        <div class="grid">${grid(ctx, others, data.error)}</div>
      </div>
    </section>
${services(ctx)}
${contact(ctx)}`;

  return layout(ctx, {
    title: item.priceFrom ? t('page.model.title', { model: item.model, price: money(item.priceFrom) }) : t('page.model.titleAsk', { model: item.model }),
    description: item.priceFrom
      ? t(`page.model.desc.${type}`, { model: item.model, price: money(item.priceFrom) })
      : t(`page.model.descAsk.${type}`, { model: item.model }),
    alternates: alternatesFor(page),
    image: item.photo && !/^https:/.test(item.photo) ? item.photo : null,
    ld: [breadcrumbLd(ctx, crumbItems)]
  }, main);
}

export function renderNotFound(ctx, data) {
  const { lang, t } = ctx;
  const main = `
    <section class="section notfound">
      <div class="container">
        <p class="eyebrow eyebrow--dark">404</p>
        <h1>${esc(t('nf.title'))}</h1>
        <p class="muted">${esc(t('nf.text'))}</p>
        <div class="hero__ctas">
          <a class="btn btn--primary" href="${pagePath(lang, { kind: 'home' })}">${esc(t('nf.home'))}</a>
          ${TYPE_ORDER.map((type) => `<a class="btn btn--ghost" href="${pagePath(lang, { kind: 'category', type })}">${esc(t(NAV_KEY[type]))}</a>`).join('\n          ')}
        </div>
      </div>
    </section>
${contact(ctx)}`;
  return layout(ctx, { title: t('nf.metaTitle'), description: t('meta.description'), noindex: true }, main);
}
