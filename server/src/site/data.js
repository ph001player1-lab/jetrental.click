/**
 * Данные для страниц сайта: каталог моделей (как в /api/public/catalog)
 * и цены модели по сезонам — для таблицы на странице модели.
 */

import { getCatalog } from '../publicApi.js';
import { getFleet, plateKey } from '../fleet.js';

// Названия сезонов в таблице → ключи переводов и порядок в таблице цен
const SEASON_KEYS = { 'низкий': 'low', 'средний': 'mid', 'высокий': 'high', 'пик': 'peak' };
const SEASON_ORDER = ['low', 'mid', 'high', 'peak'];

export async function siteCatalog() {
  try {
    return { ...(await getCatalog()), error: false };
  } catch (err) {
    console.error('Site catalog failed:', err.message);
    return { updatedAt: null, models: [], error: true };
  }
}

/**
 * Цены модели по проверенным сезонам: [{ key, name, ranges: [{ from, to }],
 * tiers: [5 цен за день или null], deposit }]. Если у модели несколько
 * единиц, в каждой ступени — самая низкая цена (её и называет «цена от»).
 */
export async function modelTariffs(model) {
  let fleet;
  try {
    fleet = await getFleet();
  } catch {
    return [];
  }
  const { units, pricing } = fleet;
  if (!pricing) return [];
  const plates = units.filter((u) => u.model === model).map((u) => plateKey(u.plate)).filter(Boolean);

  const groups = new Map();
  for (const season of pricing.seasons) {
    if (!season.verified) continue;
    const group = groups.get(season.name) || { name: season.name, sheets: new Set(), ranges: [] };
    group.sheets.add(season.sheet);
    group.ranges.push({ from: season.from, to: season.to });
    groups.set(season.name, group);
  }

  const result = [];
  for (const group of groups.values()) {
    const tiers = [null, null, null, null, null];
    let deposit = null;
    for (const sheet of group.sheets) {
      const byPlate = pricing.prices.get(sheet);
      for (const plate of plates) {
        const entry = byPlate?.get(plate);
        if (!entry || entry.suspicious) continue;
        entry.tiers.forEach((price, i) => { if (price && (!tiers[i] || price < tiers[i])) tiers[i] = price; });
        if (entry.deposit && (!deposit || entry.deposit < deposit)) deposit = entry.deposit;
      }
    }
    if (!tiers.some(Boolean)) continue;
    const key = SEASON_KEYS[group.name.toLowerCase()] || null;
    result.push({ key, name: group.name, ranges: group.ranges, tiers, deposit });
  }
  const order = (s) => (s.key ? SEASON_ORDER.indexOf(s.key) : SEASON_ORDER.length);
  return result.sort((a, b) => order(a) - order(b));
}
