/**
 * ============================================================================
 * HTML страниц сайта (собирается на сервере)
 * ============================================================================
 * Поисковики сразу видят весь текст, модели и цены — не нужно ждать скрипт.
 * site.js в браузере добавляет подбор по датам, окно брони и формы.
 * Тексты — из web/site/i18n.js (t), данные — из каталога и прайса.
 * ============================================================================
 */

import { SITE_LANGS } from './texts.js';
import { pagePath, langPrefix, CATEGORY_BY_TYPE, TYPE_ORDER } from './urls.js';
import {
  TYPE_ICON, LANG_LABEL, NAV_KEY, esc, money, icon, isFullPhoto, waLink, tgLink, head, SPRITE, LOCK, crumbs, search,
  modelUrl, badge, photoTag, REVIEWS, bookingDialog, dayMonth, homeMeta, categoryMeta, modelCrumbs, modelMeta, notFoundMeta
} from './common.js';

const SECTION_ID = { scooter: 'scooters', motorcycle: 'motorbikes', car: 'cars' };
// Картинка первого экрана разделов
const HERO_PHOTO = {
  home: '/img/models/ducati-xdiavel-1260.webp',
  scooter: '/img/models/honda-adv-350.webp',
  motorcycle: '/img/models/ducati-xdiavel-1260.webp',
  car: '/img/models/ford-ranger-4wd.webp'
};

/* -------------------------------------------------------- Шапка и подвал */

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

function layout(ctx, meta, main) {
  const { brand, lang } = ctx;
  return `${head(ctx, meta)}
<body data-whatsapp="${brand.whatsapp}" data-telegram="${brand.telegram}" data-brand="${brand.id}" data-brand-name="${esc(brand.name)}" data-prefix="${langPrefix(lang)}" data-theme="modern">
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

export function renderHome(ctx, data) {
  const main = `${hero(ctx)}
${search(ctx)}
${TYPE_ORDER.map((type, i) => catalogSection(ctx, type, data, { sand: i === 1, more: true })).join('\n')}
${priority(ctx)}
${services(ctx)}
${reviews(ctx)}
${contact(ctx)}`;
  return layout(ctx, homeMeta(ctx), main);
}

export function renderCategory(ctx, data, type) {
  const main = `${hero(ctx, type)}
${search(ctx, type)}
${catalogSection(ctx, type, data)}
${services(ctx)}
${priority(ctx)}
${reviews(ctx)}
${contact(ctx)}`;
  return layout(ctx, categoryMeta(ctx, data, type, CATEGORY_BY_TYPE[type]), main);
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
  const crumbItems = modelCrumbs(ctx, item);
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

  return layout(ctx, modelMeta(ctx, item), main);
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
  return layout(ctx, notFoundMeta(ctx), main);
}
