/**
 * ============================================================================
 * Google Sheets API без сторонних библиотек
 * ============================================================================
 * Авторизация служебным аккаунтом: подписываем JWT ключом из google-sa.json,
 * меняем его на токен доступа (живёт час, кэшируем) и ходим в Sheets API v4.
 * https://developers.google.com/identity/protocols/oauth2/service-account
 * ============================================================================
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function loadServiceAccount() {
  try {
    const sa = JSON.parse(fs.readFileSync(config.google.serviceAccountFile, 'utf8'));
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

const serviceAccount = loadServiceAccount();

export const sheetsEnabled = Boolean(serviceAccount && config.google.sheetId);

const base64url = (input) => Buffer.from(input).toString('base64url');

let cachedToken = null;
let pendingToken = null;

function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return Promise.resolve(cachedToken.value);
  // Параллельные запросы ждут один и тот же обмен ключа на токен
  if (!pendingToken) pendingToken = requestAccessToken().finally(() => { pendingToken = null; });
  return pendingToken;
}

async function requestAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: config.google.tokenUrl,
    iat: now,
    exp: now + 3600
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(serviceAccount.private_key);
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const response = await fetch(config.google.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Google auth failed: ${data.error_description || data.error || response.status}`);
  }

  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function sheetsRequest(method, path, body) {
  const token = await getAccessToken();
  const response = await fetch(`${config.google.sheetsBase}/${config.google.sheetId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Sheets ${method} ${path} failed: ${data.error?.message || response.status}`);
  }
  return data;
}

const encodeRange = (range) => encodeURIComponent(range);

/** Значения как их видит человек в таблице (строки), первая строка — заголовки */
export async function getValues(range) {
  const data = await sheetsRequest('GET', `/values/${encodeRange(range)}?valueRenderOption=FORMATTED_VALUE`);
  return data.values || [];
}

/** Читает лист как массив объектов { 'Заголовок': 'значение' } */
export async function getRows(sheetName) {
  const [header = [], ...rows] = await getValues(`'${sheetName}'`);
  return rows
    .filter((row) => row.some((cell) => String(cell).trim() !== ''))
    .map((row) => Object.fromEntries(header.map((col, i) => [String(col).trim(), row[i] ?? ''])));
}

/** Дописывает строку в конец листа. Возвращает номер строки в таблице. */
export async function appendRow(sheetName, values) {
  const data = await sheetsRequest(
    'POST',
    `/values/${encodeRange(`'${sheetName}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { values: [values] }
  );
  const match = /![A-Z]+(\d+)/.exec(data.updates?.updatedRange || '');
  return match ? Number(match[1]) : null;
}

export async function updateRange(range, values) {
  await sheetsRequest('PUT', `/values/${encodeRange(range)}?valueInputOption=USER_ENTERED`, { values });
}

/** Создаёт лист с заголовками, если его ещё нет */
export async function ensureSheet(sheetName, headers) {
  const meta = await sheetsRequest('GET', '?fields=sheets.properties.title');
  const exists = (meta.sheets || []).some((s) => s.properties.title === sheetName);
  if (exists) return false;

  await sheetsRequest('POST', ':batchUpdate', {
    requests: [{ addSheet: { properties: { title: sheetName, gridProperties: { frozenRowCount: 1 } } } }]
  });
  await updateRange(`'${sheetName}'!A1`, [headers]);
  return true;
}
