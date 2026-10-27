/**
 * Тексты и форматирование: типы техники, даты, карточка заявки для группы.
 */

import { config } from './config.js';

export const VEHICLE_TYPES = {
  scooter: { label: 'Скутер', icon: '🛵' },
  motorcycle: { label: 'Мотоцикл', icon: '🏍' },
  car: { label: 'Автомобиль', icon: '🚗' }
};

export function vehicleTypeLabel(type) {
  const t = VEHICLE_TYPES[type];
  return t ? `${t.icon} ${t.label}` : '—';
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** '2026-11-05' → '05.11' */
export function formatShortDate(isoDate) {
  if (!isoDate) return '—';
  const [, m, d] = isoDate.split('-');
  return `${d}.${m}`;
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}

/** Время в часовом поясе Бангкока: '14:32' */
export function formatTime(isoDateTime) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(isoDateTime));
}

/**
 * Карточка заявки для рабочей группы (HTML-разметка Telegram).
 */
export function formatStaffRequest(request) {
  const lines = [];
  const isTest = request.channel === 'test';

  lines.push(`🆕 <b>Заявка #${request.id}</b>${isTest ? ' <i>(тест)</i>' : ''}`);
  lines.push(request.model ? `${vehicleTypeLabel(request.vehicle_type)} · <b>${escapeHtml(request.model)}</b>` : vehicleTypeLabel(request.vehicle_type));

  if (request.date_from && request.date_to) {
    const days = daysBetween(request.date_from, request.date_to);
    lines.push(`📅 ${formatShortDate(request.date_from)} – ${formatShortDate(request.date_to)} (${days} дн.)`);
  }

  if (request.estimate_thb) lines.push(`💰 ≈ ${formatThb(request.estimate_thb)} за весь срок`);
  if (request.free_units) lines.push(`🔑 Свободны (госномер): ${escapeHtml(request.free_units)}`);

  const contact = [request.client_name, request.client_phone].filter(Boolean).map(escapeHtml).join(' · ');
  if (contact) lines.push(`👤 ${contact}`);
  if (request.comment) lines.push(`💬 ${escapeHtml(request.comment)}`);
  lines.push(`📲 Источник: ${channelLabel(request.channel)}`);

  if (request.status === 'taken') {
    lines.push('');
    lines.push(`✅ <b>Взял(а): ${escapeHtml(request.taken_by_name)}</b> · ${formatTime(request.taken_at)}`);
  } else if (request.declined_by) {
    lines.push('');
    lines.push(`🚫 Не могут: ${escapeHtml(request.declined_by.split('\n').join(', '))}`);
  }

  return lines.join('\n');
}

/** 8400 → '8 400 ฿' */
export function formatThb(amount) {
  return `${new Intl.NumberFormat('ru-RU').format(amount).replace(/[\u00a0\u202f]/g, ' ')} ฿`;
}

function channelLabel(channel) {
  switch (channel) {
    case 'telegram': return 'Telegram';
    case 'whatsapp': return 'WhatsApp';
    case 'test': return 'тестовая заявка';
    default: return channel;
  }
}
