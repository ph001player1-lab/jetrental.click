/**
 * Старые адреса kokoncar.com (сайт на Wix) → новые страницы. Позиции в
 * поиске переходят по постоянной переадресации (301), поэтому каждый адрес
 * из старой карты сайта ведёт на свою модель, а модели, которых больше нет
 * в парке, — на раздел. Языковые версии (/ru/…, /zh/…) работают так же.
 */

// Раздел старого сайта → тип техники и «старый адрес модели → модель для клиента»
const LEGACY_SECTIONS = {
  'cars-1': {
    type: 'car',
    models: {
      'chr-hybrid': 'Toyota C-HR',
      city: 'Honda City',
      cruze: 'Chevrolet Cruze',
      'ecosport-titanium': 'Ford EcoSport',
      'jolion-ultra-black': 'Haval Jolion',
      'jolion-ultra-blue': 'Haval Jolion',
      'jolion-ultra-grey': 'Haval Jolion',
      'jolion-ultra-red': 'Haval Jolion',
      'jolion-ultra-white': 'Haval Jolion',
      'mg3-max': 'MG3',
      'ranger-4wd-max': 'Ford Ranger 4WD',
      'ranger-expedition-ultra': 'Ford Ranger Expedition Ultra',
      'staria-ultra-11-seats': 'Hyundai Staria',
      'staria-ultra-8-seats': 'Hyundai Staria',
      zs: 'MG ZS',
      'zs-ultra': 'MG ZS'
    }
  },
  'motorbikes-1': {
    type: 'motorcycle',
    models: {
      'bobber-1200': 'Triumph Bobber',
      'boulevard-900-gt': 'Suzuki Boulevard',
      'breakout-special': 'Harley-Davidson Breakout',
      'cb-650-r': 'Honda CB650R',
      'cbr-500-rr': 'Honda CBR500R',
      'cbr-650-rr': 'Honda CBR650R',
      'hypermotard-950': 'Ducati Hypermotard 950',
      'meteor-350-red': 'Royal Enfield Meteor 350',
      'meteor-350-yellow': 'Royal Enfield Meteor 350',
      'monster-937': 'Ducati Monster 937',
      'new-sportster-s-1250-black': 'Harley-Davidson Sportster S 1250',
      'new-sportster-s-1250-white': 'Harley-Davidson Sportster S 1250',
      'niken-gt': 'Yamaha Niken GT',
      'rebel-300/500': 'Honda Rebel 300',
      'tracer-900-gt': 'Yamaha Tracer 9 GT',
      'trident-660': 'Triumph Trident 660',
      'vulcan-orange': 'Kawasaki Vulcan S 650',
      'vulcan-s-650': 'Kawasaki Vulcan S 650',
      'x-adv-750': 'Honda X-ADV 750',
      'x-diavel-1260-s': 'Ducati XDiavel 1260',
      'xsr-155': 'Yamaha XSR155',
      'xsr-900': 'Yamaha XSR900'
    }
  },
  // На Wix у скутеров раздел и модели жили под одним адресом /scooters/…
  scooters: {
    type: 'scooter',
    models: {
      'adv-350-air-force': 'Honda ADV 350',
      'adv-350-black': 'Honda ADV 350',
      'adv-350-grey': 'Honda ADV 350',
      'adv-350-ultra': 'Honda ADV 350',
      'adv-350-ultra-2': 'Honda ADV 350',
      'new-gold-grand-filano-ii': 'Yamaha Grand Filano',
      'new-green-grand-filano-ii': 'Yamaha Grand Filano',
      'x-adv750': 'Honda X-ADV 750'
    }
  }
};

/**
 * Старый адрес (без языкового префикса) → { model, type } или { type }
 * (модели нет — ведём в раздел) или null, если это не старый адрес.
 */
export function legacyTarget(rest) {
  const m = /^\/(cars-1|motorbikes-1|scooters)(?:\/(.+))?$/.exec(rest);
  if (!m) return null;
  const section = LEGACY_SECTIONS[m[1]];
  if (!m[2]) return { type: section.type };
  let slug = m[2].toLowerCase();
  try { slug = decodeURIComponent(slug); } catch { /* битая кодировка — оставляем как есть */ }
  const model = section.models[slug];
  return model ? { model, type: section.type } : { type: section.type };
}
