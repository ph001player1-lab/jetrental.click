/**
 * ============================================================================
 * Сезонный прайс из Google-таблицы
 * ============================================================================
 * Лист «Сезоны»: Сезон | Лист с ценами | С (дд.мм) | По (дд.мм) | Цены проверены
 * Листы цен («Прайс Низкий» и т.д.) — как файлы прайса: A №, B «Машина
 * (госномер)», C–G цены за день на 1–2 / 3–6 / 7–13 / 14–30 / 31+ дней,
 * H залог, I перепробег ฿/км. Госномер берём из скобок в колонке B.
 *
 * Расчёт: ступень цены — по общей длине аренды, цена каждого дня — по
 * сезону этого дня. Сезоны без «Да» в «Цены проверены» не используем:
 * для таких дат клиент видит цену «от», точную назовёт менеджер.
 * ============================================================================
 */

const SEASONS_SHEET = 'Сезоны';
// Верхние границы ступеней прайса (дней): 1–2, 3–6, 7–13, 14–30, 31+
const TIER_MAX = [2, 6, 13, 30, Infinity];
const YES = ['да', 'yes', 'y', 'true', '1', '✓', '+'];

/** '1 200' / '1200,00' / '฿1,200' → 1200 */
export function parsePrice(value) {
  const text = String(value ?? '').replace(/[\s ฿]/g, '');
  if (!text) return null;
  const normalized = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const number = Math.round(parseFloat(normalized));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** '20.12' / '20.12.2026' / '2026-12-20' → '12-20' (месяц-день, без года) */
export function parseDayMonth(value) {
  const text = String(value ?? '').trim();
  let m = /^(\d{1,2})[./](\d{1,2})/.exec(text);
  if (m) return `${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^\d{4}-(\d{2})-(\d{2})/.exec(text);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** 'HONDA ADV 350 cc (1124)' → '1124' (последние скобки с цифрами) */
export function plateFromName(name) {
  const m = /\(\s*(\d+)\s*\)\s*$/.exec(String(name ?? ''));
  return m ? m[1] : null;
}

function hasTypo(tiers) {
  const known = tiers.filter(Boolean);
  return known.some((price, i) => i > 0 && price < known[i - 1] / 3) || known.some((price, i) => i > 0 && price > known[i - 1]);
}

export function tierIndex(days) {
  return TIER_MAX.findIndex((max) => days <= max);
}

/**
 * seasonRows — строки листа «Сезоны» как объекты по заголовкам;
 * priceSheets — Map(имя листа → массив строк значений, начиная со 2-й строки).
 */
export function buildPricing(seasonRows, priceSheets) {
  const seasons = [];
  for (const row of seasonRows) {
    const name = String(row['Сезон'] || '').trim();
    const sheet = String(row['Лист с ценами'] || '').trim();
    const from = parseDayMonth(row['С (дд.мм)'] ?? row['С']);
    const to = parseDayMonth(row['По (дд.мм)'] ?? row['По']);
    if (!name || !sheet || !from || !to) continue;
    const verified = YES.includes(String(row['Цены проверены'] || '').trim().toLowerCase());
    seasons.push({ name, sheet, from, to, verified });
  }

  const prices = new Map();
  for (const [sheet, rows] of priceSheets) {
    const byPlate = new Map();
    for (const row of rows) {
      const plate = plateFromName(row[1]);
      if (!plate) continue;
      const tiers = [2, 3, 4, 5, 6].map((i) => parsePrice(row[i]));
      byPlate.set(plate, {
        name: String(row[1]).trim(),
        tiers,
        // Цена за день не должна расти с длиной аренды — иначе в строке опечатка
        suspicious: hasTypo(tiers),
        deposit: parsePrice(row[7]),
        overKm: parsePrice(row[8])
      });
    }
    prices.set(sheet, byPlate);
  }
  return { seasons, prices };
}

/** Листы цен, которые нужно прочитать, — из листа «Сезоны» */
export function priceSheetNames(seasonRows) {
  return [...new Set(seasonRows.map((r) => String(r['Лист с ценами'] || '').trim()).filter(Boolean))];
}

export { SEASONS_SHEET };

/** Сезон даты 'YYYY-MM-DD' (периоды через Новый год, например 20.12–20.01, тоже работают) */
export function seasonFor(pricing, isoDate) {
  const md = isoDate.slice(5, 10);
  return pricing?.seasons.find((s) => (s.from <= s.to ? s.from <= md && md <= s.to : md >= s.from || md <= s.to)) || null;
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * Точная стоимость аренды единицы (госномер — только цифры) на даты
 * [from, to): { perDay, total, deposit } или null, если для какого-то дня
 * нет проверенного сезона или цены.
 */
export function quotePlate(pricing, plate, from, to) {
  if (!pricing || !plate) return null;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  if (!(days >= 1)) return null;
  const tier = tierIndex(days);

  let total = 0;
  let deposit = null;
  for (let i = 0; i < days; i++) {
    const season = seasonFor(pricing, addDays(from, i));
    if (!season?.verified) return null;
    const entry = pricing.prices.get(season.sheet)?.get(plate);
    const price = entry?.tiers[tier];
    if (!price || entry.suspicious) return null;
    if (i === 0) deposit = entry.deposit;
    total += price;
  }
  return { perDay: Math.round(total / days), total, deposit };
}

/** Тариф единицы на дату (для сотрудников): сезон, проверен ли, цены по ступеням */
export function tariffOn(pricing, plate, isoDate) {
  const season = seasonFor(pricing, isoDate);
  if (!season) return null;
  const entry = pricing.prices.get(season.sheet)?.get(plate);
  if (!entry) return { season: season.name, verified: season.verified, tiers: null };
  return { season: season.name, verified: season.verified, suspicious: entry.suspicious, tiers: entry.tiers, deposit: entry.deposit, overKm: entry.overKm };
}
