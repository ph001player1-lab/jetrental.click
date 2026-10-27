/**
 * ============================================================================
 * WS.Автопрокат — клиент API-протокола разработчика (версия протокола 2.4)
 * ============================================================================
 * Авторизация: POST /api/v1/tokens/signin { UserName, PasswordHash (SHA-512),
 * LongToken } → accessToken. Данные: GET /data_api/<метод> с заголовком
 * Authorization: Bearer <token>. Даты со временем передаются в UTC
 * в формате «ГГГГ-ММ-ДД ЧЧ:ММ».
 *
 * Пока только ЧИТАЕМ: машины, тарифы, свободные машины и периоды.
 * ============================================================================
 */

import crypto from 'node:crypto';
import { config } from '../config.js';

export const wsEnabled = Boolean(config.ws.baseUrl && config.ws.user && config.ws.password);

const BANGKOK_OFFSET_HOURS = 7;
const CARS_CACHE_MS = 10 * 60 * 1000;
const CITIES_CACHE_MS = 60 * 60 * 1000;

let accessToken = null;
let pendingSignin = null;

async function signin() {
  const response = await fetch(`${config.ws.baseUrl}/api/v1/tokens/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      UserName: config.ws.user,
      PasswordHash: crypto.createHash('sha512').update(config.ws.password, 'utf8').digest('hex'),
      LongToken: true
    })
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* не JSON — покажем начало ответа ниже */ }

  const token = data.accessToken || data.AccessToken || data.access_token;
  if (!response.ok || !token) {
    // Для диагностики — только сообщение сервера и имена полей, без токенов
    const message = data.error_message || data.errorMessage || data.message || data.error || data.title || '';
    const detail = typeof data === 'object' && Object.keys(data).length
      ? `fields: ${Object.keys(data).join(', ')}${message ? `; message: ${String(message).slice(0, 200)}` : ''}`
      : `body: ${text.slice(0, 200)}`;
    throw new Error(`WS signin failed: HTTP ${response.status}; ${detail}`);
  }
  accessToken = token;
  return accessToken;
}

function getToken() {
  if (accessToken) return Promise.resolve(accessToken);
  if (!pendingSignin) pendingSignin = signin().finally(() => { pendingSignin = null; });
  return pendingSignin;
}

async function dataRequest(method, params = {}, retry = true) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
  );
  const url = `${config.ws.baseUrl}/data_api/${method}${query.size ? `?${query}` : ''}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });

  // Токен отозван или устарел — входим заново один раз
  if (response.status === 401 && retry) {
    accessToken = null;
    return dataRequest(method, params, false);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.result_code !== undefined && data.result_code !== 0)) {
    throw new Error(`WS ${method} failed: HTTP ${response.status}, result_code ${data.result_code}, ${data.error_message || ''}`.trim());
  }
  return data;
}

/**
 * Дата клиента 'YYYY-MM-DD' (+ время выдачи по Бангкоку) → UTC 'YYYY-MM-DD HH:MM',
 * как ждёт API.
 */
export function toWsDateTime(isoDate, localTime = config.ws.rentTime) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [hh, mm] = localTime.split(':').map(Number);
  return formatUtc(new Date(Date.UTC(y, m - 1, d, hh - BANGKOK_OFFSET_HOURS, mm)));
}

export function formatUtc(date) {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function cached(ttlMs, loader) {
  let value = null;
  let loadedAt = 0;
  return async () => {
    if (value && Date.now() - loadedAt < ttlMs) return value;
    value = await loader();
    loadedAt = Date.now();
    return value;
  };
}

/** Действующие (не архивные) города */
export const getCities = cached(CITIES_CACHE_MS, async () => {
  const data = await dataRequest('city_list');
  return (data.cities || []).filter((c) => !c.archive);
});

/** Все машины, которые сейчас в кластере: { car_id, model, number, city_id, year } */
export const getCars = cached(CARS_CACHE_MS, async () => {
  const data = await dataRequest('car_list');
  return data.cars || [];
});

/** Тарифы «сетки для сайта» и залог: Map(car_id → { deposit, tariffs[] }) */
export const getTariffs = cached(CARS_CACHE_MS, async () => {
  const data = await dataRequest('tariff_list');
  return new Map((data.cars || []).map((c) => [c.car_id, { deposit: c.deposit, tariffs: c.tariffs || [] }]));
});

/**
 * ID машин, свободных на весь период [begin, end] (UTC 'YYYY-MM-DD HH:MM')
 * с учётом аренд, броней и сервисов, по всем действующим городам.
 */
export async function getFreeCarIds(begin, end) {
  const cities = await getCities();
  const results = await Promise.all(cities.map((city) => dataRequest('car_free_list', {
    city_id: city.city_id,
    begin,
    end,
    include_reserves: true,
    include_idles: true
  })));
  return new Set(results.flatMap((r) => r.cars || []));
}

/** Свободные окна машины в периоде: [{ begin, end }] (UTC ISO-строки) */
export async function getCarFreePeriods(carId, begin, end) {
  const data = await dataRequest('car_period_list', {
    car_id: carId,
    begin,
    end,
    include_reserves: true,
    include_idles: true
  });
  return data.car_periods || [];
}

/** Цена за день по тарифной сетке на нужный срок (без почасовых тарифов) */
export function tariffFor(entry, days) {
  if (!entry) return null;
  const tariff = entry.tariffs.find((t) => !t.is_hours && t.min <= days && days <= t.max);
  if (!tariff || !tariff.cost) return null;
  return { perDay: tariff.cost, total: tariff.cost * days, deposit: entry.deposit || null };
}
