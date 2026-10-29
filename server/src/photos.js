/**
 * Фото моделей. В листе Catalog у модели две колонки:
 *   «Фото (ссылка)»   — главное фото: карточка в каталоге и первый кадр карусели;
 *   «Фото — галерея»  — остальные фото страницы модели, по одной ссылке в строке.
 * Ссылка — файл сайта (img/…), загрузка с сайта сотрудников (uploads/…)
 * или полный https-адрес. Рядом с файлом может лежать уменьшенная копия
 * для миниатюр: name.sm.jpg для name.jpg.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const MAX_GALLERY = 12;

/** Ссылка из таблицы → адрес для сайта ('/img/…', '/uploads/…', 'https://…') или '' */
export function safePhoto(value) {
  const text = String(value || '').trim();
  if (/^https:\/\/[^\s"'<>]+$/.test(text)) return text;
  if (/^\/?(img|uploads)\/[\w\-./]+$/.test(text) && !text.includes('..')) return `/${text.replace(/^\//, '')}`;
  return '';
}

/** Файл на сервере для адреса сайта; null — внешний адрес */
function fileOf(url) {
  if (url.startsWith('/img/')) return path.join(config.site.dir, url.slice(1));
  if (url.startsWith('/uploads/')) return path.join(config.site.uploadsDir, url.slice('/uploads/'.length));
  return null;
}

/** Фото можно показывать: файл на месте (внешние адреса не проверяем) */
export function photoExists(url) {
  if (!url) return false;
  const file = fileOf(url);
  return file ? fs.existsSync(file) : true;
}

/** Адрес уменьшенной копии name.sm.jpg (если её нет — само фото) */
export function thumbOf(url) {
  const small = url.replace(/(\.\w+)$/, '.sm$1');
  const file = small !== url && fileOf(small);
  return file && fs.existsSync(file) ? small : url;
}

/** Ячейка «Фото — галерея» → список адресов без пустых строк и повторов */
export function parseGallery(value) {
  return [...new Set(String(value || '').split(/\s+/).map(safePhoto).filter(Boolean))];
}
