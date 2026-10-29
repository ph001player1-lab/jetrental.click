/**
 * Тексты сайта для сервера — из того же web/site/i18n.js, что и в браузере
 * (один источник переводов). Файл перечитывается, когда меняется на диске:
 * после git pull новые тексты видны без перезапуска сервера.
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { config } from '../config.js';

export const SITE_LANGS = ['en', 'ru', 'th', 'zh'];
export const LOCALES = { en: 'en-GB', ru: 'ru-RU', th: 'th-TH', zh: 'zh-CN' };
// Для og:locale и hreflang
export const OG_LOCALES = { en: 'en_US', ru: 'ru_RU', th: 'th_TH', zh: 'zh_CN' };

const file = () => path.join(config.site.dir, 'i18n.js');
let loaded = { mtimeMs: 0, dict: null };

function dictionary() {
  const { mtimeMs } = fs.statSync(file());
  if (!loaded.dict || mtimeMs !== loaded.mtimeMs) {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(file(), 'utf8'), sandbox, { timeout: 1000 });
    loaded = { mtimeMs, dict: sandbox.window.JR_I18N };
  }
  return loaded.dict;
}

/**
 * Переводчик для языка и бренда: t(key, params). {brand} подставляется везде,
 * остальные {параметры} — из params; значения не экранируются (как в site.js).
 */
export function translator(lang, brandName) {
  const dict = dictionary();
  return (key, params = {}) => {
    const text = dict[lang]?.[key] ?? dict.en[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (m, name) => {
      if (name in params) return String(params[name]);
      return name === 'brand' ? brandName : m;
    });
  };
}

export function daysText(lang, n) {
  switch (lang) {
    case 'ru': {
      const mod10 = n % 10;
      const mod100 = n % 100;
      const word = mod10 === 1 && mod100 !== 11 ? 'день' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'дня' : 'дней';
      return `${n} ${word}`;
    }
    case 'th': return `${n} วัน`;
    case 'zh': return `${n}天`;
    default: return `${n} ${n === 1 ? 'day' : 'days'}`;
  }
}
