/**
 * ============================================================================
 * Выгрузка чата WhatsApp («Экспорт чата → Без медиа», файл .txt) → сообщения
 * ============================================================================
 * Понимает оба формата:
 *   iPhone:  [7/10/26, 10:09:38 AM] Имя: текст
 *   Android: 10/07/2026, 10:09 - Имя: текст   (или 7/10/26, 10:09 AM - Имя: …)
 * Порядок день/месяц определяем по самим датам (если где-то первое число > 12 —
 * это день). Время в выгрузке — время телефона, считаем его бангкокским.
 * ============================================================================
 */

const BANGKOK_MS = 7 * 3600000;

const IOS = /^\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\]\s(?:-\s)?/i;
const ANDROID = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s-\s/i;

/** Порядок «день/месяц»: 'dmy' или 'mdy' */
function detectOrder(heads) {
  let dmy = 0;
  let mdy = 0;
  for (const [a, b] of heads) {
    if (a > 12) dmy++;
    if (b > 12) mdy++;
  }
  return dmy > mdy ? 'dmy' : 'mdy';
}

export function parseExport(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/[‎‏‪-‮﻿]/g, '').replace(/[  ]/g, ' ');
  const rawLines = text.split('\n');
  const starts = [];
  for (let i = 0; i < rawLines.length; i++) {
    const m = rawLines[i].match(IOS) || rawLines[i].match(ANDROID);
    if (m) starts.push({ i, m });
  }
  const order = detectOrder(starts.map(({ m }) => [Number(m[1]), Number(m[2])]));
  const messages = [];
  for (let k = 0; k < starts.length; k++) {
    const { i, m } = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1].i : rawLines.length;
    const first = rawLines[i].slice(m[0].length);
    const body = [first, ...rawLines.slice(i + 1, end)].join('\n');
    const [day, month] = order === 'dmy' ? [m[1], m[2]] : [m[2], m[1]];
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    let hour = Number(m[4]) % (m[7] ? 12 : 24);
    if (m[7] && m[7].toUpperCase() === 'PM') hour += 12;
    const local = Date.UTC(year, Number(month) - 1, Number(day), hour, Number(m[5]), Number(m[6] || 0));
    const ts = new Date(local - BANGKOK_MS).toISOString();
    // «Имя: текст»; системные строки («X added Y», «You created the group») — без двоеточия
    const sep = body.indexOf(': ');
    const nl = body.indexOf('\n');
    if (sep <= 0 || (nl >= 0 && nl < sep) || sep > 60) continue;
    const author = body.slice(0, sep).trim();
    const content = body.slice(sep + 2).trim();
    // Удалённые и недоставленные сообщения (английская и русская выгрузки)
    if (!content || /^(this message was deleted|you deleted this message|данное сообщение удалено|это сообщение удалено|вы удалили это сообщение)/i.test(content)
      || /^(waiting for this message|ожидание (этого )?сообщения)/i.test(content)) continue;
    messages.push({ ts, author, text: content });
  }
  return {
    order,
    messages,
    from: messages[0]?.ts || null,
    to: messages[messages.length - 1]?.ts || null
  };
}
