/**
 * ============================================================================
 * Контакты сайта jetmobility.org — из портала («Настройки» → «Сайт: контакты»)
 * ============================================================================
 * Телефоны (в шапке и в контактах), номер для кнопок WhatsApp, Telegram, адрес
 * (на языках сайта) и точка на карте. Пока ничего не сохранили — на сайте то,
 * что было в коде. Сайт видит изменения в течение минуты (кэш страниц).
 * Меняют владелец и админ. kokoncar.com не трогаем — к нему нет доступа.
 *
 *   GET  /api/staff/site-contacts
 *   POST /api/staff/site-contacts/save    { phones, whatsapp, telegram, address, map }
 *   POST /api/staff/site-contacts/resolve { link } — точка по ссылке Google Maps
 * ============================================================================
 */

import * as db from './db.js';
import { HttpError, sendJson, readJson } from './http.js';
import { can } from './roles.js';

const KEY = 'site_contacts_jetmobility';
export const ADDRESS_LANGS = ['en', 'ru', 'th', 'zh'];

// Точка, которую прислал владелец (до первого сохранения из портала)
const DEFAULT_MAP = { lat: 7.9392713, lng: 98.3952487, link: 'https://maps.app.goo.gl/Wp95vyvqTmxvvsWX6' };

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const digits = (v) => String(v || '').replace(/\D/g, '');

let cache = null;
function saved() {
  if (cache) return cache.value;
  let value = null;
  try { value = JSON.parse(db.getSetting(KEY) || 'null'); } catch { value = null; }
  cache = { value };
  return value;
}

/** Метка версии — для кэша страниц сайта */
export const contactsVersion = () => saved()?.at || '';

/** Контакты бренда с учётом сохранённого в портале (только jetmobility.org) */
export function applySiteContacts(brand) {
  if (brand?.id !== 'jetmobility') return brand;
  const s = saved();
  const out = { ...brand, map: s?.map || DEFAULT_MAP, address: s?.address || null };
  if (!s) return out;
  if (s.phones?.length) out.phones = s.phones.map((p) => ({ tel: `+${p.tel}`, short: p.display, full: p.display, header: p.header !== false }));
  if (s.whatsapp) out.whatsapp = s.whatsapp;
  if (s.telegram) out.telegram = s.telegram;
  return out;
}

/** Точка из ссылки Google Maps: !3d…!4d… (место), @lat,lng (вид), q=/ll=/destination= */
export function pointFromLink(url) {
  const u = String(url || '');
  const num = (s) => Number(s);
  const ok = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng);
  let m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(u);
  if (m && ok(num(m[1]), num(m[2]))) return { lat: num(m[1]), lng: num(m[2]) };
  m = /[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i.exec(u);
  if (m && ok(num(m[1]), num(m[2]))) return { lat: num(m[1]), lng: num(m[2]) };
  m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(u);
  if (m && ok(num(m[1]), num(m[2]))) return { lat: num(m[1]), lng: num(m[2]) };
  m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(u);
  if (m && ok(num(m[1]), num(m[2]))) return { lat: num(m[1]), lng: num(m[2]) };
  return null;
}

function needRights(staff) {
  if (!can(staff, 'site.contacts')) throw new HttpError(403, 'owner_or_admin_only');
}

/** Что сейчас на сайте (с подставленным по умолчанию) — для формы */
function current(defaultBrand) {
  const b = applySiteContacts(defaultBrand);
  return {
    phones: b.phones.map((p) => ({ number: p.full, header: p.header !== false })),
    whatsapp: b.whatsapp, telegram: b.telegram,
    address: b.address || {},
    map: b.map
  };
}

export function siteContactsRoute(defaultBrand) {
  return async (staff, req, res) => {
    needRights(staff);
    const s = saved();
    sendJson(res, 200, { contacts: current(defaultBrand), saved: Boolean(s), at: s?.at || null, by: s?.by || null, langs: ADDRESS_LANGS });
  };
}

export async function siteContactsSave(staff, req, res) {
  needRights(staff);
  const body = await readJson(req, 32 * 1024);
  const phones = (Array.isArray(body.phones) ? body.phones : []).slice(0, 6)
    .map((p) => ({ display: text(p?.number, 40), tel: digits(p?.number), header: p?.header !== false }))
    .filter((p) => p.display || p.tel);
  if (!phones.length) throw new HttpError(400, 'phone_required');
  if (phones.some((p) => p.tel.length < 8 || p.tel.length > 15)) throw new HttpError(400, 'bad_phone');
  const whatsapp = digits(body.whatsapp);
  if (whatsapp.length < 8 || whatsapp.length > 15) throw new HttpError(400, 'bad_whatsapp');
  const telegram = String(body.telegram || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(telegram)) throw new HttpError(400, 'bad_telegram');
  const address = Object.fromEntries(ADDRESS_LANGS.map((l) => [l, text(body.address?.[l], 120)]).filter(([, v]) => v));
  const lat = Number(body.map?.lat);
  const lng = Number(body.map?.lng);
  if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new HttpError(400, 'bad_map');
  const link = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps)\//i.test(String(body.map?.link || '')) ? String(body.map.link).slice(0, 500) : '';
  const value = {
    phones, whatsapp, telegram, address, map: { lat: Math.round(lat * 1e7) / 1e7, lng: Math.round(lng * 1e7) / 1e7, link },
    at: new Date().toISOString(), by: staff.name || staff.email
  };
  db.setSetting(KEY, JSON.stringify(value));
  cache = null;
  console.log(`Site contacts (jetmobility.org) saved by ${staff.email}`);
  sendJson(res, 200, { ok: true, at: value.at });
}

/** Ссылка Google Maps → точка (короткую ссылку открываем и берём из адреса, куда она ведёт) */
export async function siteContactsResolve(staff, req, res) {
  needRights(staff);
  const { link } = await readJson(req);
  const url = String(link || '').trim();
  let point = pointFromLink(url);
  if (!point && /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(url)) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      point = pointFromLink(r.headers.get('location') || '');
    } catch { /* нет связи — попросим координаты */ }
  }
  if (!point) throw new HttpError(400, 'map_not_found');
  sendJson(res, 200, { point });
}
