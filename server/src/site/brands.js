/**
 * Бренды сайта. Код и данные одни, а название, логотип, почта и основной
 * адрес зависят от домена: kokoncar.com — KokonCar, jetrental.click — JetRental.
 * Поисковикам открыт только kokoncar.com: тестовая копия KokonCar
 * (kokon.jetrental.click) и jetrental.click закрыты, чтобы в поиске не было
 * двух одинаковых сайтов. После переезда jetrental.click будет переадресовывать
 * на kokoncar.com (это делает Caddy).
 */

import { config } from '../config.js';

const CONTACTS = {
  whatsapp: '79037965656',
  telegram: 'JetRental_bot',
  phones: [
    { tel: '+79037965656', short: '+7 903 796 56-56', full: '+7 (903) 796-56-56' },
    { tel: '+66809908490', short: '+66 80 990 84-90', full: '+66 80 990 84-90' }
  ],
  staffUrl: 'https://staff.jetrental.click'
};

const BRANDS = {
  jetrental: {
    id: 'jetrental',
    name: 'JetRental',
    origin: 'https://jetrental.click',
    email: 'info@jetrental.click',
    assets: 'img/brand',
    logo: { width: 341, height: 120 },
    googleVerification: [],
    indexable: false
  },
  kokoncar: {
    id: 'kokoncar',
    name: 'KokonCar',
    origin: 'https://www.kokoncar.com',
    email: 'info@kokoncar.rent',
    assets: 'img/brand/kokoncar',
    logo: { width: 344, height: 160 },
    // Метка Google Search Console со старого сайта на Wix — чтобы подтверждение не слетело
    googleVerification: ['q_ZYOKxSsfoUE_qybSHBRXAWbm-yb936bQnAFzPTRnM'],
    indexable: true
  }
};

/**
 * Бренд по заголовку Host: { ...бренд, host, origin, indexable } или null —
 * домен не наш сайт (например, bot.jetrental.click с вебхуками).
 */
export function brandForHost(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  const { site } = config;
  if (site.kokonPreviewHosts.includes(host)) {
    return { ...CONTACTS, ...BRANDS.kokoncar, host, origin: `https://${host}`, indexable: false };
  }
  if (site.kokonHosts.includes(host)) return { ...CONTACTS, ...BRANDS.kokoncar, host };
  if (site.jetrentalHosts.includes(host)) return { ...CONTACTS, ...BRANDS.jetrental, host };
  return null;
}
