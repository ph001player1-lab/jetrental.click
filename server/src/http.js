/**
 * Мелкие помощники HTTP-сервера: JSON-ответы, чтение тела, cookie,
 * IP клиента за Caddy и простое ограничение частоты запросов.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

/** Сырое тело запроса (Buffer) — нужно для проверки подписи вебхука */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * JSON из тела POST-запроса. Требуем Content-Type: application/json —
 * так чужой сайт не сможет отправить форму от имени сотрудника.
 */
export async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json_required');
  }
  try {
    const value = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'bad_json');
  }
}

export function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

/** IP клиента: Caddy дописывает его последним в X-Forwarded-For */
export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) || req.socket.remoteAddress || 'unknown';
}

/**
 * Ограничитель частоты: не больше max событий за windowMs на ключ.
 * hit(key) → true, если ещё можно; false — лимит исчерпан.
 */
export function rateLimiter(windowMs, max) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 10000) {
        for (const [k, times] of hits) if (!times.some((t) => now - t < windowMs)) hits.delete(k);
      }
      return true;
    }
  };
}
