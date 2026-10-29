/**
 * Общее для всех дизайнов сайта: экранирование, ссылки на мессенджеры,
 * <head> с SEO-тегами (одинаковыми в любом дизайне), окно брони, подбор по
 * датам, данные для поисковиков. Дизайны — render.js (новый) и classic.js
 * (как на старом kokoncar.com на Wix).
 */

import { LOCALES, OG_LOCALES, SITE_LANGS } from './texts.js';
import { pagePath, TYPE_ORDER } from './urls.js';

export const TYPE_ICON = { scooter: '🛵', motorcycle: '🏍', car: '🚗' };
export const LANG_LABEL = { en: 'EN', ru: 'RU', th: 'ไทย', zh: '中文' };
export const NAV_KEY = { scooter: 'nav.scooters', motorcycle: 'nav.motorbikes', car: 'nav.cars' };

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (n) => `${new Intl.NumberFormat('en-US').format(n)} ฿`;
export const icon = (name, size = 20) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export const isFullPhoto = (photo) => /\.jpe?g$/i.test(photo || '');

export const waLink = (brand, text) => `https://wa.me/${brand.whatsapp}?text=${encodeURIComponent(text)}`;
export const tgLink = (brand) => `https://t.me/${brand.telegram}`;

/* --------------------------------------------------------------- <head> */

// Оформление: стили и шрифты дизайна (тексты и SEO-теги одинаковые)
const THEMES = {
  modern: {
    css: 'site.css',
    fonts: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap',
    themeColor: '#0b1f33'
  },
  classic: {
    css: 'classic.css',
    fonts: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Poppins:wght@500;600;700&display=swap',
    themeColor: '#080d11',
    // Блоки «выезжают» при прокрутке (site.js). Если скрипт не загрузился —
    // через 2,5 с показываем всё, чтобы страница не осталась пустой
    boot: "<script>document.documentElement.classList.add('js');setTimeout(function(){if(!window.__reveal)document.documentElement.classList.add('reveal-all')},2500)</script>"
  }
};

export function jsonLd(data) {
  // «</» внутри строк не должно закрыть тег script
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function head(ctx, meta) {
  const { brand, lang } = ctx;
  const abs = (p) => `${brand.origin}${p}`;
  const noindex = !brand.indexable || meta.noindex;
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
  const theme = THEMES[ctx.theme] || THEMES.modern;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  ${theme.boot || ''}
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.description)}" />
  ${noindex ? '<meta name="robots" content="noindex, nofollow" />' : ''}
  ${links}
  <meta name="theme-color" content="${theme.themeColor}" />
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
  <link href="${theme.fonts}" rel="stylesheet" />
  <link rel="stylesheet" href="${ctx.assetUrl(theme.css)}" />
  ${(meta.ld || []).map(jsonLd).join('\n  ')}
</head>`;
}

export const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <symbol id="i-wa" viewBox="0 0 24 24"><path fill="currentColor" d="M17.5 14.4c-.3-.1-1.8-.9-2-1s-.5-.1-.7.1-.8 1-.9 1.2-.3.2-.6.1a8.2 8.2 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.8.4 3.5 3.5 0 0 0-1.1 2.6 6 6 0 0 0 1.3 3.2 13.8 13.8 0 0 0 5.3 4.7c2 .9 2.8.9 3.8.8.6-.1 1.8-.8 2.1-1.5s.3-1.3.2-1.5-.3-.2-.6-.3zM12 21.8a9.8 9.8 0 0 1-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A9.8 9.8 0 1 1 12 21.8zM20.5 3.5A11.8 11.8 0 0 0 1.9 17.7L.2 24l6.4-1.7A11.8 11.8 0 0 0 24 12a11.7 11.7 0 0 0-3.5-8.5z"/></symbol>
    <symbol id="i-tg" viewBox="0 0 24 24"><path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></symbol>
  </svg>`;

export const LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z"/></svg>';

/** Хлебные крошки: Главная › … (последний пункт — текущая страница, без ссылки) */
export function crumbs(ctx, items, light = false) {
  const { lang, t } = ctx;
  const all = [{ label: t('crumb.home'), href: pagePath(lang, { kind: 'home' }) }, ...items];
  return `<nav class="crumbs${light ? ' crumbs--light' : ''}" aria-label="Breadcrumb"><ol>${all.map((item, i) => (i < all.length - 1 && item.href
    ? `<li><a href="${esc(item.href)}">${esc(item.label)}</a></li>`
    : `<li aria-current="page">${esc(item.label)}</li>`)).join('')}</ol></nav>`;
}

/** Подбор по датам; plain — без «наезда» на первый экран (на странице модели его нет) */
export function search(ctx, type = null, plain = false) {
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

export function badge(ctx, item) {
  if (item.availableNow === true) return `<span class="badge badge--free">${esc(ctx.t('badge.free'))}</span>`;
  if (item.availableNow === false) return `<span class="badge badge--busy">${esc(ctx.t('badge.busy'))}</span>`;
  return '';
}

export function photoTag(item, { width = 320, height = 220, lazy = true, priority = false } = {}) {
  const typeIcon = TYPE_ICON[item.type] || '🚘';
  if (!item.photo) return `<span class="vcard__placeholder" aria-hidden="true">${typeIcon}</span>`;
  return `<img src="${esc(item.photo)}" alt="${esc(item.model)}"${lazy ? ' loading="lazy"' : ''}${priority ? ' fetchpriority="high"' : ''} width="${width}" height="${height}" data-icon="${typeIcon}" />`;
}

/**
 * Фото на странице модели. Одно фото — просто картинка; несколько — карусель:
 * большое фото со стрелками и счётчиком, ниже ряд миниатюр. Кадры листаются
 * и без скрипта (прокрутка с прилипанием), site.js добавляет стрелки и миниатюры.
 * frame — класс рамки в дизайне (model__media, cl-model__media),
 * photoClass — класс рамки для полноразмерного фото (не вырезанного на фоне).
 */
export function galleryBlock(ctx, item, { frame, photoClass }) {
  const { t } = ctx;
  const slides = item.gallery?.length ? item.gallery : [];
  if (slides.length < 2) {
    return `<div class="${frame}${isFullPhoto(item.photo) ? ` ${photoClass}` : ''}" data-reveal>${badge(ctx, item)}${photoTag(item, { width: 640, height: 440, lazy: false, priority: true })}</div>`;
  }
  const typeIcon = TYPE_ICON[item.type] || '🚘';
  const alt = (i) => (i ? t('gal.photo', { model: item.model, n: i + 1 }) : item.model);
  const frames = slides.map(({ src }, i) => `
            <div class="gal__slide${isFullPhoto(src) ? ' is-photo' : ''}"><img src="${esc(src)}" alt="${esc(alt(i))}" width="1280" height="880"${i ? ' loading="lazy" decoding="async"' : ' fetchpriority="high"'} data-icon="${typeIcon}" /></div>`).join('');
  const thumbs = slides.map(({ thumb, src }, i) => `
          <button class="gal__thumb${isFullPhoto(src) ? ' is-photo' : ''}${i ? '' : ' is-active'}" type="button" data-gal-to="${i}" aria-label="${esc(t('gal.show', { n: i + 1 }))}"${i ? '' : ' aria-current="true"'}><img src="${esc(thumb)}" alt="" width="120" height="82" loading="lazy" decoding="async" /></button>`).join('');
  return `<div class="gal" data-gallery data-reveal>
        <div class="${frame} gal__view">
          ${badge(ctx, item)}
          <div class="gal__track" tabindex="0" role="group" aria-label="${esc(item.model)}">${frames}
          </div>
          <button class="gal__arrow gal__arrow--prev" type="button" data-gal="-1" aria-label="${esc(t('gal.prev'))}" disabled><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg></button>
          <button class="gal__arrow gal__arrow--next" type="button" data-gal="1" aria-label="${esc(t('gal.next'))}"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></button>
          <span class="gal__count" aria-hidden="true"><b>1</b> / ${slides.length}</span>
        </div>
        <div class="gal__thumbs">${thumbs}
        </div>
      </div>`;
}

// Оригинальные отзывы клиентов (не переводятся)
export const REVIEWS = [
  ['Брал два мото в аренду, супер выгодные условия и шикарный подход к клиенту! Буду обращаться снова, спасибо за быструю доставку!', 'Egor Bobrov'],
  ['Арендовала новенький Filano, очень довольна отношением владельца: всегда на связи, подсказывал всё по байку. Весь залог вернул по окончании аренды. Рекомендую!', 'Daniel Lee'],
  ['Было офигительно круто! Мотоциклы в отличном состоянии со всем необходимым, хороший опрятный сервис, всем рекомендую!:)', 'Ann Malyisheva']
];

export function bookingDialog(ctx) {
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

export const alternatesFor = (page) => Object.fromEntries(SITE_LANGS.map((l) => [l, pagePath(l, page)]));

export function organization(ctx) {
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

export function breadcrumbLd(ctx, items) {
  const { brand, lang, t } = ctx;
  const all = [{ label: t('crumb.home'), href: pagePath(lang, { kind: 'home' }) }, ...items];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: all.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.label, item: `${brand.origin}${item.href}` }))
  };
}

export const minPrice = (items) => Math.min(...items.map((m) => m.priceFrom).filter(Boolean));

/** '12-20' → '20 дек.' (на языке страницы) */
export function dayMonth(lang, md) {
  const date = new Date(`2000-${md}T00:00:00Z`);
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date);
}

/* ------------------------------------- Заголовки и описания для поисковиков */
// Одни и те же в любом дизайне: смена оформления не трогает позиции в поиске

export function homeMeta(ctx) {
  const { t } = ctx;
  return { title: t('meta.title'), description: t('meta.description'), alternates: alternatesFor({ kind: 'home' }), ld: [organization(ctx)] };
}

export function categoryMeta(ctx, data, type, category) {
  const { lang, t } = ctx;
  const page = { kind: 'category', type };
  const from = minPrice(data.models.filter((m) => m.type === type));
  return {
    title: t(`page.${category}.title`),
    description: Number.isFinite(from) ? t(`page.${category}.desc`, { price: money(from) }) : t(`page.${category}.descAsk`),
    alternates: alternatesFor(page),
    ld: [breadcrumbLd(ctx, [{ label: t(NAV_KEY[type]), href: pagePath(lang, page) }])]
  };
}

/** Хлебные крошки страницы модели: раздел › модель */
export function modelCrumbs(ctx, item) {
  const { lang, t } = ctx;
  return [
    { label: t(NAV_KEY[item.type]), href: pagePath(lang, { kind: 'category', type: item.type }) },
    { label: item.model, href: pagePath(lang, { kind: 'model', type: item.type, slug: item.slug }) }
  ];
}

export function modelMeta(ctx, item) {
  const { t } = ctx;
  return {
    title: item.priceFrom ? t('page.model.title', { model: item.model, price: money(item.priceFrom) }) : t('page.model.titleAsk', { model: item.model }),
    description: item.priceFrom
      ? t(`page.model.desc.${item.type}`, { model: item.model, price: money(item.priceFrom) })
      : t(`page.model.descAsk.${item.type}`, { model: item.model }),
    alternates: alternatesFor({ kind: 'model', type: item.type, slug: item.slug }),
    // Для превью в мессенджерах лучше настоящее фото, чем вырезанное на фоне
    image: [...(item.gallery || []).map((g) => g.src).filter(isFullPhoto), item.photo].find((src) => src && !/^https:/.test(src)) || null,
    ld: [breadcrumbLd(ctx, modelCrumbs(ctx, item))]
  };
}

export const notFoundMeta = (ctx) => ({ title: ctx.t('nf.metaTitle'), description: ctx.t('meta.description'), noindex: true });
