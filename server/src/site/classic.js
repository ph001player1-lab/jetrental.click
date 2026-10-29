/**
 * ============================================================================
 * Дизайн «как на старом kokoncar.com» (Wix): тёмный фон, бордовые плашки,
 * карусели моделей, блоки плавно появляются при прокрутке
 * ============================================================================
 * Данные, тексты, адреса страниц и SEO-теги — общие с новым дизайном
 * (common.js): какой дизайн показывать, решает настройка домена (brands.js).
 * Окно брони, подбор по датам и формы работают через тот же site.js.
 * ============================================================================
 */

import { SITE_LANGS } from './texts.js';
import { pagePath, langPrefix, CATEGORY_BY_TYPE } from './urls.js';
import {
  NAV_KEY, esc, icon, isFullPhoto, waLink, tgLink, head, SPRITE, LOCK, crumbs, search,
  modelUrl, badge, photoTag, galleryBlock, descOf, REVIEWS, bookingDialog, dayMonth, homeMeta, categoryMeta, modelCrumbs, modelMeta, notFoundMeta
} from './common.js';

// Как на старом сайте: меню — авто, мотоциклы, скутеры; на главной — мотоциклы, авто (бордовая полоса), скутеры
const NAV_ORDER = ['car', 'motorcycle', 'scooter'];
const HOME_ORDER = ['motorcycle', 'car', 'scooter'];
const SECTION_ID = { scooter: 'scooters', motorcycle: 'motorbikes', car: 'cars' };
const TWO_WORD_BRANDS = ['royal enfield', 'land rover', 'aston martin', 'alfa romeo'];

/** Цена как на старом сайте: «1,330฿» */
const baht = (n) => `${new Intl.NumberFormat('en-US').format(n)}฿`;

/** 'Triumph Bobber' → { brand: 'Triumph', name: 'Bobber' } — на карточках марка крупно, модель ниже */
function splitName(model) {
  const words = String(model).split(/\s+/);
  const two = words.slice(0, 2).join(' ').toLowerCase();
  const n = TWO_WORD_BRANDS.includes(two) ? 2 : 1;
  return { brand: words.slice(0, n).join(' '), name: words.slice(n).join(' ') };
}

/* ------------------------------------------------------ Значки и флаги */

const ICON_SPEC = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6zm0-5.2 1.3 2.4 2.7-.6.6 2.7 2.4 1.3-1.2 2.5 1.2 2.5-2.4 1.3-.6 2.7-2.7-.6L12 21l-1.3-2.4-2.7.6-.6-2.7L5 15.2l1.2-2.5L5 10.2l2.4-1.3.6-2.7 2.7.6z"/></svg>';
const ICON_PRICE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M3.5 12.6 11.4 4.7a1.6 1.6 0 0 1 1.2-.5H19a.8.8 0 0 1 .8.8v6.4a1.6 1.6 0 0 1-.5 1.2l-7.9 7.9a1.6 1.6 0 0 1-2.3 0l-5.6-5.6a1.6 1.6 0 0 1 0-2.3zM16 8.1a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8zM9.6 13.3l3.1 3.1M8 15l1.8 1.8"/></svg>';
const QUOTE = '<svg viewBox="0 0 48 40" width="44" height="37" aria-hidden="true"><path fill="currentColor" d="M0 0h20v18c0 11-6 19-17 22l-2-6c6-2 9-6 9-11H0zm28 0h20v18c0 11-6 19-17 22l-2-6c6-2 9-6 9-11H28z"/></svg>';

// Круглые флажки языков (как на старом сайте)
const FLAGS = {
  en: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><clipPath id="fc-en"><circle cx="10" cy="10" r="10"/></clipPath><g clip-path="url(#fc-en)"><rect width="20" height="20" fill="#fff"/><path fill="#d22f27" d="M0 0h20v2H0zm0 4h20v2H0zm0 4h20v2H0zm0 4h20v2H0zm0 4h20v2H0z"/><rect width="10" height="10" fill="#1e3a8a"/></g></svg>',
  ru: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><clipPath id="fc-ru"><circle cx="10" cy="10" r="10"/></clipPath><g clip-path="url(#fc-ru)"><rect width="20" height="7" fill="#fff"/><rect y="7" width="20" height="6" fill="#1c57a5"/><rect y="13" width="20" height="7" fill="#d52b1e"/></g></svg>',
  th: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><clipPath id="fc-th"><circle cx="10" cy="10" r="10"/></clipPath><g clip-path="url(#fc-th)"><rect width="20" height="20" fill="#a51931"/><rect y="3.3" width="20" height="13.4" fill="#f4f5f8"/><rect y="6.7" width="20" height="6.6" fill="#2d2a4a"/></g></svg>',
  zh: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><clipPath id="fc-zh"><circle cx="10" cy="10" r="10"/></clipPath><g clip-path="url(#fc-zh)"><rect width="20" height="20" fill="#de2910"/><path fill="#ffde00" d="m6 3.2.9 2.6h2.8L7.5 7.4l.8 2.6L6 8.4 3.7 10l.8-2.6-2.2-1.6h2.8z"/></g></svg>'
};
const LANG_SHORT = { en: 'EN', ru: 'RU', th: 'TH', zh: 'ZH' };

/* -------------------------------------------------------- Шапка и подвал */

function navLinks(ctx) {
  const { lang, t } = ctx;
  return [
    ...NAV_ORDER.map((type) => `<a href="${pagePath(lang, { kind: 'category', type })}">${esc(t(NAV_KEY[type]))}</a>`),
    `<a href="#contact">${esc(t('nav.contact'))}</a>`
  ];
}

function header(ctx, alternates) {
  const { brand, lang, t } = ctx;
  const langs = SITE_LANGS.map((l) => {
    const href = alternates ? alternates[l] : pagePath(l, { kind: 'home' });
    return `<a href="${esc(href)}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="true"' : ''}>${FLAGS[l]}<span>${LANG_SHORT[l]}</span></a>`;
  }).join('');
  return `
  <header class="cl-header" id="top">
    <div class="cl-wrap cl-header__inner">
      <a class="cl-logo" href="${pagePath(lang, { kind: 'home' })}">
        <img src="/${brand.assets}/logo-wordmark-light.webp" alt="${esc(brand.name)}" width="${brand.logo.width}" height="${brand.logo.height}" />
      </a>
      <nav class="cl-nav" id="nav" aria-label="Main">
        ${navLinks(ctx).join('\n        ')}
      </nav>
      <div class="cl-header__phones">${brand.phones.map((p) => `<a href="tel:${p.tel}">${p.short}</a>`).join('')}</div>
      <div class="cl-header__msg">
        <a class="cl-pill cl-pill--wa" href="${esc(waLink(brand, t('wa.general')))}" target="_blank" rel="noopener">${icon('wa', 18)}<span>What'sApp</span></a>
        <a class="cl-pill cl-pill--tg" href="${tgLink(brand)}" target="_blank" rel="noopener" aria-label="Telegram">${icon('tg', 18)}<span>Telegram</span></a>
      </div>
      <nav class="cl-lang" aria-label="Language">${langs}</nav>
      <button class="burger" type="button" aria-label="${esc(t('nav.menu'))}" aria-expanded="false" aria-controls="nav"><span></span><span></span><span></span></button>
    </div>
  </header>`;
}

function footer(ctx) {
  const { brand, t } = ctx;
  return `
  <footer class="cl-footer">
    <div class="cl-wrap">
      <div class="cl-rule" aria-hidden="true"></div>
      <div class="cl-footer__inner">
        <div class="cl-footer__info">
          <p class="cl-footer__name">${esc(brand.wordmark || brand.name)}</p>
          <p>${esc(t('contact.beach'))}<br>${esc(t('contact.country'))}</p>
          <p>${brand.phones.map((p) => `<a href="tel:${p.tel}">${p.full}</a>`).join('<br>')}</p>
          <p><a href="mailto:${esc(brand.email)}">${esc(brand.email)}</a></p>
          <p class="cl-footer__copy">© ${ctx.year} ${esc(brand.name)}</p>
        </div>
        <nav class="cl-footer__nav" aria-label="Footer">
          ${navLinks(ctx).join('\n          ')}
          <a class="cl-footer__staff" href="${brand.staffUrl}" rel="nofollow">${LOCK} Staff only</a>
        </nav>
      </div>
    </div>
  </footer>`;
}

function layout(ctx, meta, main) {
  const { brand, lang } = ctx;
  return `${head(ctx, meta)}
<body class="cl" data-whatsapp="${brand.whatsapp}" data-telegram="${brand.telegram}" data-brand="${brand.id}" data-brand-name="${esc(brand.name)}" data-prefix="${langPrefix(lang)}" data-theme="classic">
  ${SPRITE}
${header(ctx, meta.alternates)}

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

/* ---------------------------------------------------------------- Блоки */

function hero(ctx) {
  const { lang, t } = ctx;
  const labels = [['tl', 'cl.insurance'], ['tr', 'cl.help'], ['bl', 'cl.delivery'], ['br', 'cl.service']]
    .map(([pos, key], i) => `<span class="cl-hero__label cl-hero__label--${pos}" style="--d:${0.5 + i * 0.15}s">${esc(t(key))}</span>`).join('');
  return `
    <section class="cl-hero">
      <div class="cl-wrap cl-hero__inner">
        <div class="cl-hero__text">
          <h1>${esc(t('hero.title1'))}<br>${esc(t('hero.title2'))}</h1>
          <p>${esc(t('hero.lead'))}</p>
          <div class="cl-hero__ctas">
            <a class="cl-btn cl-btn--red" href="${pagePath(lang, { kind: 'category', type: 'motorcycle' })}">${esc(t('hero.ctaMoto'))}</a>
            <a class="cl-btn cl-btn--red" href="${pagePath(lang, { kind: 'category', type: 'car' })}">${esc(t('hero.ctaCars'))}</a>
            <a class="cl-btn cl-btn--red" href="${pagePath(lang, { kind: 'category', type: 'scooter' })}">${esc(t('hero.ctaScooters'))}</a>
          </div>
        </div>
        <div class="cl-hero__visual" aria-hidden="true">
          <div class="cl-hero__circle"></div>
          <img class="cl-hero__car" src="/img/classic/hero-car.webp" alt="" width="900" height="444" fetchpriority="high" />
          <img class="cl-hero__moto" src="/img/classic/hero-moto.webp" alt="" width="680" height="600" />
          ${labels}
        </div>
      </div>
    </section>`;
}

function card(ctx, item) {
  const { brand, lang, t } = ctx;
  const href = modelUrl(lang, item);
  const { brand: make, name } = splitName(item.model);
  return `
        <article class="cl-card" data-reveal>
          <a class="cl-card__media${isFullPhoto(item.photo) ? ' is-photo' : ''}" href="${esc(href)}" tabindex="-1" aria-hidden="true">${badge(ctx, item)}${photoTag(item)}</a>
          <h3 class="cl-card__title"><a href="${esc(href)}"><b>${esc(make)}</b> <span>${name ? esc(name) : '&nbsp;'}</span></a></h3>
          <ul class="cl-card__pills">
            ${descOf(ctx, item) ? `<li>${ICON_SPEC}<span>${esc(descOf(ctx, item))}</span></li>` : '<li class="is-empty" aria-hidden="true"></li>'}
            <li>${ICON_PRICE}<span>${item.priceFrom ? esc(t('cl.from', { price: baht(item.priceFrom) })) : esc(t('card.ask'))}</span></li>
          </ul>
          <div class="cl-card__actions">
            <a class="cl-btn cl-btn--dark" href="${esc(href)}">${esc(t('card.seeMore'))}</a>
            <a class="cl-btn cl-btn--wa cl-btn--round" href="${esc(waLink(brand, t('wa.model', { model: item.model })))}" target="_blank" rel="noopener" aria-label="WhatsApp" title="WhatsApp">${icon('wa', 22)}</a>
            <a class="cl-btn cl-btn--tg cl-btn--round" href="${esc(tgLink(brand))}" target="_blank" rel="noopener" aria-label="Telegram" title="Telegram">${icon('tg', 22)}</a>
          </div>
        </article>`;
}

function emptyText(ctx, catalogError) {
  const { brand, t } = ctx;
  const link = `<a href="${esc(waLink(brand, t('wa.which')))}" target="_blank" rel="noopener">WhatsApp</a>`;
  return `<p class="cl-muted">${catalogError ? t('catalog.error', { link }) : t('catalog.empty', { link })}</p>`;
}

/** Карусель карточек: на компьютере — стрелки, на телефоне — листается пальцем */
function slider(ctx, items, data) {
  if (data.error || !items.length) return emptyText(ctx, data.error);
  return `
      <div class="cl-slider" data-slider>
        <button class="cl-slider__arrow cl-slider__arrow--prev" type="button" data-slide="-1" aria-label="Previous">‹</button>
        <div class="cl-slider__track">${items.map((item) => card(ctx, item)).join('')}
        </div>
        <button class="cl-slider__arrow cl-slider__arrow--next" type="button" data-slide="1" aria-label="Next">›</button>
      </div>`;
}

function catalogSection(ctx, type, data, { band = false } = {}) {
  const { lang, t } = ctx;
  const category = CATEGORY_BY_TYPE[type];
  const items = data.models.filter((m) => m.type === type);
  return `
    <section class="cl-section${band ? ' cl-band' : ''}" id="${SECTION_ID[type]}">
      <div class="cl-wrap">
        <div class="cl-head" data-reveal>
          <h2>${esc(t(NAV_KEY[type]))}</h2>
          <p>${esc(t(`sec.${category}`))}</p>
        </div>
        ${slider(ctx, items, data)}
        <a class="cl-more" href="${pagePath(lang, { kind: 'category', type })}">${esc(t(`more.${category}`))}</a>
      </div>
    </section>`;
}

function priority(ctx) {
  const { t } = ctx;
  return `
    <section class="cl-section cl-priority">
      <div class="cl-wrap cl-priority__inner">
        <div class="cl-priority__text" data-reveal>
          <div class="cl-rule" aria-hidden="true"></div>
          <h3>${esc(t('priority.eyebrow'))}</h3>
          <h2>${esc(t('priority.title'))}</h2>
          <p>${esc(t('priority.text'))}</p>
        </div>
        <img class="cl-priority__img" src="/img/classic/rider.jpg" alt="" width="1200" height="800" loading="lazy" data-reveal />
      </div>
    </section>`;
}

function services(ctx) {
  const { t } = ctx;
  const items = [['icon-seat', 's1'], ['icon-driver', 's2'], ['icon-helmet', 's3']].map(([img, key]) => `
          <article class="cl-service" data-reveal>
            <div class="cl-service__icon"><img src="/img/classic/${img}.png" alt="" width="90" height="90" loading="lazy" /></div>
            <h3>${esc(t(`${key}.title`))}</h3>
            <p>${esc(t(`${key}.text`))}</p>
          </article>`).join('');
  return `
    <section class="cl-section" id="services">
      <div class="cl-wrap cl-services">${items}
      </div>
    </section>`;
}

function contact(ctx) {
  const { brand, t } = ctx;
  return `
    <section class="cl-section" id="contact">
      <div class="cl-wrap cl-contact">
        <div class="cl-contact__info" data-reveal>
          <ul>
            <li><b>${esc(t('contact.beach'))}</b><br>${esc(t('contact.country'))}<br><a href="https://www.google.com/maps/dir/?api=1&amp;destination=Bang+Tao+Beach+Phuket" target="_blank" rel="noopener">${esc(t('contact.route'))}</a></li>
            <li>${brand.phones.map((p) => `<a href="tel:${p.tel}">${p.full}</a>`).join('<br>')}</li>
            <li><a href="mailto:${esc(brand.email)}">${esc(brand.email)}</a></li>
          </ul>
          <div class="cl-contact__msg">
            <a class="cl-pill cl-pill--wa" href="${esc(waLink(brand, t('wa.general')))}" target="_blank" rel="noopener">${icon('wa', 18)}<span>What'sApp</span></a>
            <a class="cl-pill cl-pill--tg" href="${tgLink(brand)}" target="_blank" rel="noopener">${icon('tg', 18)}<span>Telegram</span></a>
          </div>
        </div>
        <form class="cl-form" id="contact-form" novalidate data-reveal>
          <h2>${esc(t('contact.eyebrow'))}</h2>
          <label class="field"><span>${esc(t('form.firstName'))}</span><input name="name" autocomplete="given-name" required maxlength="80" placeholder="${esc(t('form.firstNamePh'))}" /></label>
          <label class="field"><span>${esc(t('form.phone'))}</span><input name="phone" type="tel" autocomplete="tel" required placeholder="${esc(t('form.phonePh'))}" /></label>
          <label class="field"><span>${esc(t('form.email'))}</span><input name="email" type="email" autocomplete="email" placeholder="${esc(t('form.emailPh'))}" /></label>
          <label class="field"><span>${esc(t('form.message'))}</span><textarea name="message" rows="4" required maxlength="1000" placeholder="${esc(t('form.messagePh'))}"></textarea></label>
          <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off" /></label>
          <button class="cl-submit" type="submit">${esc(t('form.submit'))}</button>
          <p class="form__status" role="status"></p>
        </form>
      </div>
    </section>`;
}

function reviews() {
  return `
    <section class="cl-section">
      <div class="cl-wrap cl-reviews">${REVIEWS.map(([text, name]) => `
        <figure class="cl-review" data-reveal>
          <span class="cl-review__quote">${QUOTE}</span>
          <div>
            <blockquote lang="ru">${esc(text)}</blockquote>
            <figcaption>${esc(name)}</figcaption>
          </div>
        </figure>`).join('')}
      </div>
    </section>`;
}

/* --------------------------------------------------------------- Страницы */

export function renderHome(ctx, data) {
  const main = `${hero(ctx)}
${search(ctx)}
${HOME_ORDER.map((type) => catalogSection(ctx, type, data, { band: type === 'car' })).join('\n')}
${priority(ctx)}
${services(ctx)}
${contact(ctx)}
${reviews()}`;
  return layout(ctx, homeMeta(ctx), main);
}

export function renderCategory(ctx, data, type) {
  const { t } = ctx;
  const category = CATEGORY_BY_TYPE[type];
  const items = data.models.filter((m) => m.type === type);
  const main = `
    <section class="cl-section cl-page">
      <div class="cl-wrap">
        ${crumbs(ctx, [{ label: t(NAV_KEY[type]) }])}
        <div class="cl-head" data-reveal>
          <h1>${esc(t(`page.${category}.h1`))}</h1>
          <p>${esc(t(`page.${category}.lead`))}</p>
        </div>
      </div>
    </section>
${search(ctx, type, true)}
    <section class="cl-section" id="${SECTION_ID[type]}">
      <div class="cl-wrap">
        ${data.error || !items.length ? emptyText(ctx, data.error) : `<div class="cl-grid">${items.map((item) => card(ctx, item)).join('')}\n        </div>`}
      </div>
    </section>
${services(ctx)}
${contact(ctx)}
${reviews()}`;
  return layout(ctx, categoryMeta(ctx, data, type, category), main);
}

/** Бордовая таблица цен, как на старом сайте: ступени по дням, строки — сезоны */
function priceBlock(ctx, item, tariffs) {
  const { lang, t } = ctx;
  if (!tariffs.length) return `<p class="cl-muted">${esc(t('model.noPrices'))}</p>`;
  const heads = [1, 2, 3, 4, 5].map((i) => `<th scope="col">${esc(t(`tier.${i}`))}</th>`).join('');
  const rows = tariffs.map((s) => {
    const label = s.key ? t(`season.${s.key}`) : s.name;
    const ranges = s.ranges.map((r) => `${dayMonth(lang, r.from)} – ${dayMonth(lang, r.to)}`).join(', ');
    const cells = s.tiers.map((price) => `<td>${price ? esc(t('cl.perDay', { price: baht(price) })) : '—'}</td>`).join('');
    return `<tr><th scope="row">${esc(label)}<small>${esc(ranges)}</small></th>${cells}</tr>`;
  }).join('\n              ');
  const deposits = tariffs.map((s) => s.deposit).filter(Boolean);
  return `
        <div class="cl-prices__wrap">
          <table class="cl-prices">
            <caption>${esc(t('model.pricesCaption', { model: item.model }))}</caption>
            <thead><tr><th scope="col">${esc(t('model.season'))}</th>${heads}</tr></thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
        ${deposits.length ? `<p class="cl-prices__deposit">${esc(t('model.deposit', { amount: baht(Math.min(...deposits)) }))}</p>` : ''}
        <p class="cl-muted">${esc(t('model.pricesLead'))} ${esc(t('model.note'))}</p>`;
}

export function renderModel(ctx, data, item, tariffs) {
  const { brand, lang, t } = ctx;
  const type = item.type;
  const { brand: make, name } = splitName(item.model);
  const others = data.models.filter((m) => m.type === type && m.model !== item.model);
  const main = `
    <section class="cl-section cl-page">
      <div class="cl-wrap">
        ${crumbs(ctx, modelCrumbs(ctx, item))}
        <div class="cl-model">
          ${galleryBlock(ctx, item, { frame: 'cl-model__media', photoClass: 'is-photo' })}
          <div class="cl-model__info" data-reveal>
            <h1><b>${esc(make)}</b>${name ? ` <span>${esc(name)}</span>` : ''}</h1>
            <p class="cl-model__from">${item.priceFrom ? esc(t('cl.from', { price: baht(item.priceFrom) })) : esc(t('card.ask'))}</p>
            ${descOf(ctx, item) ? `<p class="cl-model__spec">${ICON_SPEC}<span>${esc(descOf(ctx, item))}</span></p>` : ''}
            <p class="cl-model__lead">${esc(t(`model.lead.${type}`, { model: item.model }))}</p>
            <div class="cl-model__actions">
              <button class="cl-btn cl-btn--red cl-btn--big" type="button" data-book="${esc(item.model)}" data-type="${esc(type)}">${esc(t('card.book'))}</button>
              <a class="cl-btn cl-btn--tg cl-btn--big" href="${tgLink(brand)}" target="_blank" rel="noopener">${icon('tg', 22)}Telegram</a>
              <a class="cl-btn cl-btn--wa2 cl-btn--big" href="${esc(waLink(brand, t('wa.model', { model: item.model })))}" target="_blank" rel="noopener">${icon('wa', 22)}What'sApp</a>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="cl-section" id="prices">
      <div class="cl-wrap">
        <div class="cl-head" data-reveal><h2>${esc(t('model.prices'))}</h2></div>
        ${priceBlock(ctx, item, tariffs)}
      </div>
    </section>
${others.length ? `
    <section class="cl-section" id="${SECTION_ID[type]}">
      <div class="cl-wrap">
        <div class="cl-head" data-reveal><h2>${esc(t('model.more'))}</h2></div>
        ${slider(ctx, others, data)}
        <a class="cl-more" href="${pagePath(lang, { kind: 'category', type })}">${esc(t(`more.${CATEGORY_BY_TYPE[type]}`))}</a>
      </div>
    </section>` : ''}
${contact(ctx)}`;
  return layout(ctx, modelMeta(ctx, item), main);
}

export function renderNotFound(ctx) {
  const { lang, t } = ctx;
  const main = `
    <section class="cl-section cl-page">
      <div class="cl-wrap cl-head">
        <p class="cl-muted">404</p>
        <h1>${esc(t('nf.title'))}</h1>
        <p>${esc(t('nf.text'))}</p>
        <div class="cl-hero__ctas">
          <a class="cl-btn cl-btn--red" href="${pagePath(lang, { kind: 'home' })}">${esc(t('nf.home'))}</a>
          ${NAV_ORDER.map((type) => `<a class="cl-btn cl-btn--dark" href="${pagePath(lang, { kind: 'category', type })}">${esc(t(NAV_KEY[type]))}</a>`).join('\n          ')}
        </div>
      </div>
    </section>
${contact(ctx)}`;
  return layout(ctx, notFoundMeta(ctx), main);
}

