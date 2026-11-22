/**
 * Бренды сайта. Код и данные одни, а название, логотип, почта и основной
 * адрес зависят от домена: jetmobility.org — Jet Mobility (дизайн classic в
 * цветах логотипа), kokoncar.com — KokonCar.
 * Поисковикам открыт только kokoncar.com: jetmobility.org пока закрыт, чтобы в
 * поиске не было двух одинаковых сайтов, пока работает старый kokoncar.com.
 */

import { config } from '../config.js';

const CONTACTS = {
  whatsapp: '79037965656',
  telegram: 'JetRental_bot',
  phones: [
    { tel: '+79037965656', short: '+7 903 796 56-56', full: '+7 (903) 796-56-56' },
    { tel: '+66809908490', short: '+66 80 990 84-90', full: '+66 80 990 84-90' }
  ],
  staffUrl: config.staff.url
};

const BRANDS = {
  jetmobility: {
    id: 'jetmobility',
    name: 'Jet Mobility',
    origin: 'https://jetmobility.org',
    // Почту на сайте не показываем
    email: null,
    assets: 'img/brand/jetmobility',
    logo: { width: 316, height: 100 },
    wordmark: 'JET MOBILITY',
    googleVerification: [],
    indexable: false,
    theme: 'classic'
  },
  kokoncar: {
    id: 'kokoncar',
    name: 'KokonCar',
    origin: 'https://www.kokoncar.com',
    email: 'info@kokoncar.rent',
    assets: 'img/brand/kokoncar',
    logo: { width: 344, height: 160 },
    wordmark: 'KOKON CAR',
    // Метка Google Search Console со старого сайта на Wix — чтобы подтверждение не слетело
    googleVerification: ['q_ZYOKxSsfoUE_qybSHBRXAWbm-yb936bQnAFzPTRnM'],
    indexable: true
  }
};

/**
 * Бренд по заголовку Host: { ...бренд, host, origin, indexable, theme } или
 * null — домен не наш сайт (например, bot.jetmobility.org с вебхуками).
 * Дизайн (theme): 'classic' — как старый kokoncar.com на Wix, 'modern' — другой.
 * jetmobility.org — classic в цветах логотипа Jet Mobility, на kokoncar.com —
 * настройка KOKON_THEME (по умолчанию classic).
 */
export function brandForHost(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  const { site } = config;
  if (site.kokonPreviewHosts.includes(host)) {
    return { ...CONTACTS, ...BRANDS.kokoncar, host, origin: `https://${host}`, indexable: false, theme: 'classic' };
  }
  if (site.kokonHosts.includes(host)) return { ...CONTACTS, ...BRANDS.kokoncar, host, theme: site.kokonTheme };
  if (site.jetmobilityHosts.includes(host)) return { ...CONTACTS, ...BRANDS.jetmobility, host };
  return null;
}
