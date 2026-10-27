/**
 * Тексты и форматирование: типы техники, даты, карточка заявки для группы.
 * Карточка для сотрудников — на английском (команда читает по-английски).
 */

import { config } from './config.js';
import { LANGUAGES, t } from './i18n.js';

export const VEHICLE_TYPES = {
  scooter: { label: 'Скутер', icon: '🛵' },
  motorcycle: { label: 'Мотоцикл', icon: '🏍' },
  car: { label: 'Автомобиль', icon: '🚗' }
};

/** Тип техники для сотрудников: '🛵 Scooter' */
export function vehicleTypeLabel(type) {
  return VEHICLE_TYPES[type] ? t('en', `type_${type}`) : '—';
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
 * Карточка заявки для рабочей группы (HTML-разметка Telegram), на английском.
 */
export function formatStaffRequest(request) {
  const lines = [];
  const isTest = request.channel === 'test';

  lines.push(`🆕 <b>Request #${request.id}</b>${isTest ? ' <i>(test)</i>' : ''}`);
  if (request.model) lines.push(`${vehicleTypeLabel(request.vehicle_type)} · <b>${escapeHtml(request.model)}</b>`);
  else if (request.vehicle_type) lines.push(vehicleTypeLabel(request.vehicle_type));

  if (request.date_from && request.date_to) {
    const days = daysBetween(request.date_from, request.date_to);
    lines.push(`📅 ${formatShortDate(request.date_from)} – ${formatShortDate(request.date_to)} (${days} ${days === 1 ? 'day' : 'days'})`);
  }

  if (request.estimate_thb) lines.push(`💰 ≈ ${formatThb(request.estimate_thb)} total`);
  if (request.free_units) lines.push(`🔑 Free (plate): ${escapeHtml(request.free_units)}`);

  const contact = [request.client_name, request.client_phone].filter(Boolean).map(escapeHtml).join(' · ');
  if (contact) lines.push(`👤 ${contact}`);
  if (request.comment) lines.push(`💬 ${escapeHtml(request.comment)}`);
  const lang = LANGUAGES[request.lang];
  lines.push(`📲 Source: ${channelLabel(request.channel)}${lang ? ` · client language ${lang.title}` : ''}`);

  if (request.status === 'taken') {
    lines.push('');
    lines.push(`✅ <b>Taken by: ${escapeHtml(request.taken_by_name)}</b> · ${formatTime(request.taken_at)}`);
  } else if (request.declined_by) {
    lines.push('');
    lines.push(`🚫 Can't: ${escapeHtml(request.declined_by.split('\n').join(', '))}`);
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
    case 'site': return 'Website';
    case 'test': return 'test request';
    default: return channel;
  }
}
