/**
 * ============================================================================
 * Публичный сайт: страницы, переадресации, sitemap.xml и robots.txt
 * ============================================================================
 *   /                         главная          /ru, /th, /zh — другие языки
 *   /scooters /motorbikes /cars                 разделы
 *   /cars/honda-city                            страница модели
 *   /cars-1/…, /motorbikes-1/…, /scooters/…     старые адреса Wix → 301
 *   /sitemap.xml, /robots.txt
 * Готовые страницы держим в памяти минуту: каталог и наличие обновляются
 * не чаще. Картинки, стили и скрипты отдаёт Caddy из папки web/site.
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { brandForHost } from './brands.js';
import { translator, SITE_LANGS } from './texts.js';
import { pagePath, splitLang, TYPE_BY_CATEGORY, TYPE_ORDER } from './urls.js';
import { siteCatalog, modelTariffs } from './data.js';
import { catalogVersion } from '../publicApi.js';
import { legacyTarget } from './legacy.js';
import { renderHome, renderCategory, renderModel, renderNotFound, esc } from './render.js';

const PAGE_CACHE_MS = 60 * 1000;
const pageCache = new Map();

/* ---------------------------------------------- Версии файлов для кэша */

// site.js?v=<хеш> — после обновления браузер сразу берёт новый файл
const assetVersions = new Map();
function assetUrl(name) {
  const file = path.join(config.site.dir, name);
  try {
    const { mtimeMs } = fs.statSync(file);
    let known = assetVersions.get(name);
    if (!known || known.mtimeMs !== mtimeMs) {
      known = { mtimeMs, hash: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10) };
      assetVersions.set(name, known);
    }
    return `/${name}?v=${known.hash}`;
  } catch {
    return `/${name}`;
  }
}

function context(brand, lang) {
  return {
    brand,
    lang,
    t: translator(lang, brand.name),
    assetUrl,
    year: new Date().getFullYear(),
    verification: { google: config.site.googleVerification, yandex: config.site.yandexVerification }
  };
}

/* ---------------------------------------------------------- Ответы */

function sendHtml(req, res, status, html, brand) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
    ...(brand.indexable ? {} : { 'X-Robots-Tag': 'noindex, nofollow' })
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}

function sendText(req, res, type, body, brand) {
  res.writeHead(200, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'public, max-age=3600',
    ...(brand.indexable ? {} : { 'X-Robots-Tag': 'noindex, nofollow' })
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function redirect(res, location) {
  res.writeHead(301, { Location: location, 'Cache-Control': 'public, max-age=3600' });
  res.end();
}

/* ------------------------------------------------------ Разбор адреса */

/**
 * Что показать по адресу: { page } | { redirect } | { notFound }.
 * page — { kind, type?, item? }.
 */
function resolve(pathname, models) {
  const { lang, rest } = splitLang(pathname);
  if (rest === '/') return { lang, page: { kind: 'home' } };

  const bySlug = new Map(models.map((m) => [m.slug, m]));
  const byName = new Map(models.map((m) => [m.model, m]));
  const toModel = (item) => ({ redirect: pagePath(lang, { kind: 'model', type: item.type, slug: item.slug }) });
  const toCategory = (type) => ({ redirect: pagePath(lang, { kind: 'category', type }) });

  let m = /^\/(scooters|motorbikes|cars)$/.exec(rest);
  if (m) return { lang, page: { kind: 'category', type: TYPE_BY_CATEGORY[m[1]] } };

  // Старые адреса Wix: /cars-1/…, /motorbikes-1/…, /scooters/adv-350-black
  const legacy = legacyTarget(rest);
  const legacyItem = legacy?.model && byName.get(legacy.model);

  m = /^\/(scooters|motorbikes|cars)\/([^/]+)$/.exec(rest);
  if (m) {
    const type = TYPE_BY_CATEGORY[m[1]];
    const item = bySlug.get(m[2]);
    if (item && item.type === type) return { lang, page: { kind: 'model', type, item } };
    if (item) return toModel(item); // модель есть, но в другом разделе
    if (legacyItem) return toModel(legacyItem);
    return toCategory(type); // модели больше нет в каталоге (продана)
  }
  if (legacy) return legacyItem ? toModel(legacyItem) : toCategory(legacy.type);
  return { lang, notFound: true };
}

/** Адрес той же страницы на другом языке (для старых ссылок вида ?lang=ru) */
function withLang(pathname, lang) {
  const { rest } = splitLang(pathname);
  const prefix = lang === 'en' ? '' : `/${lang}`;
  return rest === '/' ? prefix || '/' : `${prefix}${rest}`;
}

/* ---------------------------------------------- sitemap.xml и robots.txt */

function sitemap(brand, models) {
  const pages = [
    { kind: 'home' },
    ...TYPE_ORDER.map((type) => ({ kind: 'category', type })),
    ...models.map((m) => ({ kind: 'model', type: m.type, slug: m.slug }))
  ];
  const urls = [];
  for (const page of pages) {
    const alternates = SITE_LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(brand.origin + pagePath(l, page))}"/>`).join('\n');
    for (const lang of SITE_LANGS) {
      urls.push(`  <url>\n    <loc>${esc(brand.origin + pagePath(lang, page))}</loc>\n${alternates}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(brand.origin + pagePath('en', page))}"/>\n  </url>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`;
}

function robots(brand) {
  // Закрытый сайт не запрещаем обходить: поисковик должен зайти на страницу,
  // увидеть «noindex» и убрать её из поиска, если уже успел найти
  if (!brand.indexable) return 'User-agent: *\nDisallow:\n';
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${brand.origin}/sitemap.xml\n`;
}

/* ---------------------------------------------------------- Вход */

/** true — запрос к сайту обработан; false — домен не сайта (решает index.js) */
export async function handleSite(req, res, url) {
  const brand = brandForHost(req.headers.host);
  if (!brand) return false;
  const { pathname } = url;

  if (pathname === '/robots.txt') {
    sendText(req, res, 'text/plain', robots(brand), brand);
    return true;
  }

  const data = await siteCatalog();
  // Каталог ещё не загрузился (сервер только что запущен, таблица не отвечает):
  // страницы показываем, но поисковикам говорим «временно», чтобы они не
  // приняли пустой каталог и переадресации за настоящие
  if (data.error) {
    const { lang } = splitLang(pathname);
    res.setHeader('Retry-After', '300');
    // Главная с сообщением «каталог не загрузился» и контактами
    sendHtml(req, res, 503, renderHome(context(brand, lang), data), brand);
    return true;
  }
  if (pathname === '/sitemap.xml') {
    sendText(req, res, 'application/xml', sitemap(brand, data.models), brand);
    return true;
  }

  // Ссылки старого сайта jetrental.click: ?lang=ru → /ru/…
  const queryLang = url.searchParams.get('lang');
  let target = null;
  if (queryLang && SITE_LANGS.includes(queryLang)) target = withLang(pathname, queryLang);
  else if (pathname === '/index.html') target = '/';
  else if (pathname.length > 1 && pathname.endsWith('/')) target = pathname.replace(/\/+$/, '') || '/';

  const found = target ? { redirect: target } : resolve(pathname, data.models);
  if (found.redirect) {
    redirect(res, found.redirect);
    return true;
  }

  const key = `${brand.host}|${pathname}`;
  const cached = pageCache.get(key);
  const version = `${data.updatedAt}|${catalogVersion()}`;
  if (cached && Date.now() - cached.at < PAGE_CACHE_MS && cached.version === version) {
    sendHtml(req, res, cached.status, cached.html, brand);
    return true;
  }

  const ctx = context(brand, found.lang);
  let status = 200;
  let html;
  if (found.notFound) {
    status = 404;
    html = renderNotFound(ctx, data);
  } else if (found.page.kind === 'home') {
    html = renderHome(ctx, data);
  } else if (found.page.kind === 'category') {
    html = renderCategory(ctx, data, found.page.type);
  } else {
    html = renderModel(ctx, data, found.page.item, await modelTariffs(found.page.item.model));
  }

  // Страницы 404 не кэшируем: случайные адреса не должны занимать память
  if (status === 200) {
    pageCache.set(key, { at: Date.now(), version, status, html });
    if (pageCache.size > 1000) {
      for (const [k, v] of pageCache) if (Date.now() - v.at > PAGE_CACHE_MS) pageCache.delete(k);
    }
  }
  sendHtml(req, res, status, html, brand);
  return true;
}
