/**
 * ============================================================================
 * KOKON BOT — HTTP-сервер (заготовка)
 * ============================================================================
 * Пока умеет только отвечать на /health, чтобы проверить, что сервер,
 * HTTPS (Caddy) и домен bot.jetrental.click работают. Сюда же потом придут
 * вебхуки WhatsApp и Telegram.
 * ============================================================================
 */

import http from 'node:http';

const PORT = Number(process.env.PORT) || 3000;
const STARTED_AT = new Date();

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'kokon-bot',
      startedAt: STARTED_AT.toISOString(),
      uptimeSeconds: Math.round(process.uptime())
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`kokon-bot listening on port ${PORT}`);
});

// Docker останавливает контейнер сигналом SIGTERM — закрываемся аккуратно
process.on('SIGTERM', () => server.close(() => process.exit(0)));
