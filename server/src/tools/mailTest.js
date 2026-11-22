/**
 * Проверка отправки писем (Resend): отправляет тестовое письмо и печатает
 * ответ почтового сервиса.
 * Ключ RESEND_API_KEY не печатается.
 *
 *   docker compose -f /opt/kokon/app/deploy/docker-compose.yml exec bot node src/tools/mailTest.js you@example.com
 */

import { config } from '../config.js';

const to = process.argv[2];
if (!to || !to.includes('@')) {
  console.log('Укажите почту: node src/tools/mailTest.js you@example.com');
  process.exit(1);
}
console.log(`RESEND_API_KEY: ${config.mail.resendApiKey ? `задан (${config.mail.resendApiKey.length} символов)` : 'НЕ ЗАДАН'}`);

{
  const from = config.mail.from;
  const response = await fetch(`${config.mail.apiBase}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: 'Jet Mobility: тест почты', text: `Тестовое письмо, отправитель ${from}` })
  });
  const data = await response.json().catch(() => ({}));
  console.log(`\nОтправитель: ${from}\nОтвет: HTTP ${response.status} ${JSON.stringify(data)}`);
  console.log(response.ok ? '✅ Письмо принято — проверьте почту и resend.com → Emails.' : '❌ Resend не принял письмо — причина в ответе выше.');
}
