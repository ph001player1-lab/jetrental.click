/**
 * Адреса страниц сайта. Английский — без префикса, остальные языки —
 * /ru, /th, /zh (как было на Wix). Разделы: /scooters, /motorbikes, /cars,
 * модель — /cars/honda-city.
 */

import { SITE_LANGS } from './texts.js';

export const CATEGORY_BY_TYPE = { scooter: 'scooters', motorcycle: 'motorbikes', car: 'cars' };
export const TYPE_BY_CATEGORY = { scooters: 'scooter', motorbikes: 'motorcycle', cars: 'car' };
export const TYPE_ORDER = ['scooter', 'motorcycle', 'car'];

/** 'Honda X-ADV 750' → 'honda-x-adv-750' */
export function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export const langPrefix = (lang) => (lang === 'en' ? '' : `/${lang}`);

/** Путь страницы на языке: page — { kind: 'home' | 'category' | 'model', type?, slug? } */
export function pagePath(lang, page) {
  const prefix = langPrefix(lang);
  if (page.kind === 'home') return prefix || '/';
  const category = CATEGORY_BY_TYPE[page.type];
  return page.kind === 'category' ? `${prefix}/${category}` : `${prefix}/${category}/${page.slug}`;
}

/** Разбор пути: { lang, rest } — rest без языкового префикса, без завершающего «/» */
export function splitLang(pathname) {
  const m = /^\/(ru|th|zh)(?=\/|$)/.exec(pathname);
  const lang = m ? m[1] : 'en';
  const rest = (m ? pathname.slice(m[0].length) : pathname) || '/';
  return { lang, rest };
}

export { SITE_LANGS };
