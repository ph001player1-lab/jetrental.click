/**
 * ============================================================================
 * Прайс: обновление цен из файлов тарифов (Excel-выгрузка WS)
 * ============================================================================
 * Файл — тариф одного старого сезона: в первой строке «Тариф: 15NOV-19DEC/
 * 21JAN-FEB», дальше № | «Машина (госномер)» | 1-2 | 3-6 | 7-13 | 14-30 | 31+ |
 * Залог | Перепробег 1 км. Сроки 14-30 и 31+ — это 14–27 и 28+ портала (по
 * порядку, как при первом переносе).
 *
 * Сезоны в файлах старые, в портале — новые. Каждому сезону портала даём файл,
 * который покрывает больше всего его дней (можно выбрать вручную). Дальше как
 * при первом переносе: цена модели — та, что у большинства её машин в файле,
 * у машин с другой ценой — особая цена (лишние особые цены убираем).
 * Сначала предпросмотр (было → стало), применяется по «Применить» одним
 * изменением в истории прайса — его можно отменить.
 *
 *   POST /api/staff/price/import { files: [{ name, data (base64) }], mapping?, apply? }
 * ============================================================================
 */

import { readFirstSheet } from './xlsx.js';
import { parsePrice, plateFromName, hasTypo } from './pricing.js';
import { listSeasons, allRates, applyChanges } from './price.js';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12
};
// Дни месяцев високосного года — чтобы «FEB» без числа значило до 29.02
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const md = (m, d) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * «Тариф: 15NOV-19DEC/21JAN-FEB» → [{ from: '11-15', to: '12-19' }, { from: '01-21', to: '02-29' }].
 * Без числа: начало — 1-е, конец — последний день месяца.
 */
export function parseTariffRanges(text) {
  const ranges = [];
  const re = /(\d{1,2})?\s*([a-zа-я]{3,})\.?\s*[-–—]\s*(\d{1,2})?\s*([a-zа-я]{3,})/giu;
  for (const m of String(text || '').replace(/_/g, ' ').matchAll(re)) {
    const m1 = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const m2 = MONTHS[m[4].slice(0, 3).toLowerCase()];
    if (!m1 || !m2) continue;
    const d1 = Math.min(Number(m[1] || 1), MONTH_DAYS[m1 - 1]);
    const d2 = Math.min(Number(m[3] || MONTH_DAYS[m2 - 1]), MONTH_DAYS[m2 - 1]);
    ranges.push({ from: md(m1, d1), to: md(m2, d2) });
  }
  return ranges;
}

/** Дни года (ММ-ДД, високосный год), которые покрывают периоды */
function daysOf(periods) {
  const days = new Set();
  for (let ms = Date.UTC(2024, 0, 1); ms < Date.UTC(2025, 0, 1); ms += 86400000) {
    const day = new Date(ms).toISOString().slice(5, 10);
    if (periods.some((p) => (p.from <= p.to ? p.from <= day && day <= p.to : day >= p.from || day <= p.to))) days.add(day);
  }
  return days;
}

export class ImportError extends Error {
  constructor(code, details = null) { super(code); this.code = code; this.details = details; }
}

/** Файл тарифа → { title, ranges, rows: [{ name, plate, tiers, deposit, overKm }], noPlate } */
export function readTariffFile(buffer, fileName = '') {
  let rows;
  try {
    rows = readFirstSheet(buffer);
  } catch {
    throw new ImportError('not_xlsx', fileName);
  }
  const titleRow = rows.find((r) => r.some((v) => /тариф|tariff/i.test(String(v ?? ''))));
  const title = titleRow ? String(titleRow.find((v) => /тариф|tariff/i.test(String(v ?? '')))).trim() : '';
  let ranges = parseTariffRanges(title.replace(/^.*?:/, ''));
  if (!ranges.length) ranges = parseTariffRanges(fileName.replace(/\.xlsx$/i, ''));
  const head = rows.findIndex((r) => r.some((v) => String(v ?? '').replace(/\s/g, '') === '1-2'));
  if (head < 0) throw new ImportError('no_price_table', fileName);
  const out = [];
  const noPlate = [];
  for (const r of rows.slice(head + 1)) {
    const name = String(r[1] ?? '').trim();
    if (!name) continue;
    const tiers = [2, 3, 4, 5, 6].map((i) => parsePrice(r[i]));
    if (!tiers.some(Boolean)) continue;
    const plate = plateFromName(name);
    if (!plate) { noPlate.push(name); continue; }
    out.push({ name, plate, tiers, deposit: parsePrice(r[7]), overKm: parsePrice(r[8]) });
  }
  return { name: fileName, title: title || fileName, ranges, rows: out, noPlate };
}

const sig = (e) => JSON.stringify([e.tiers, e.deposit, e.overKm]);
const valueOf = (r) => (r ? { tiers: r.tiers, deposit: r.deposit ?? null, overKm: r.overKm ?? null } : null);

/**
 * План обновления: какой файл какому сезону, изменения цен (для applyChanges)
 * и отчёт для предпросмотра. units — машины парка [{ plate, model }].
 * mapping — { [seasonId]: индекс файла | -1 (не менять) }; без него — по датам.
 */
export function planImport(files, mapping, units, plateKey) {
  const seasons = listSeasons();
  const rates = allRates();
  const fileDays = files.map((f) => daysOf(f.ranges));
  const byModel = new Map();
  const fleetPlates = new Set();
  for (const u of units) {
    const plate = plateKey(u.plate);
    if (!plate || !u.model) continue;
    fleetPlates.add(plate);
    if (!byModel.has(u.model)) byModel.set(u.model, []);
    if (!byModel.get(u.model).includes(plate)) byModel.get(u.model).push(plate);
  }

  const changes = [];
  const report = [];
  for (const s of seasons) {
    const days = daysOf(s.periods);
    const candidates = files.map((f, i) => ({ file: i, days: [...days].filter((d) => fileDays[i].has(d)).length }));
    const best = candidates.reduce((a, b) => (b.days > a.days ? b : a), { file: -1, days: 0 });
    const asked = mapping && Object.hasOwn(mapping, s.id) ? Number(mapping[s.id]) : null;
    const fileIndex = asked !== null && asked >= -1 && asked < files.length ? asked : best.file;
    const entry = { seasonId: s.id, name: s.name, periods: s.periods, totalDays: days.size, file: fileIndex, auto: best.file,
      coveredDays: fileIndex >= 0 ? candidates[fileIndex].days : 0, candidates, models: [], plates: [], removed: 0, same: 0, missing: [], suspicious: [] };
    report.push(entry);
    if (fileIndex < 0) continue;
    const inFile = new Map(files[fileIndex].rows.map((r) => [plateKey(r.plate), r]));
    for (const [model, plates] of byModel) {
      const list = plates.map((p) => ({ plate: p, row: inFile.get(p) })).filter((x) => x.row);
      if (!list.length) { entry.missing.push(model); continue; }
      const counts = new Map();
      for (const { row } of list) counts.set(sig(row), (counts.get(sig(row)) || 0) + 1);
      const main = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      const base = list.find(({ row }) => sig(row) === main).row;
      if (hasTypo(base.tiers)) entry.suspicious.push(model);
      const oldModel = rates.get(`${s.id}|model|${model}`) || null;
      if (!oldModel || sig(valueOf(oldModel)) !== sig(base)) {
        changes.push({ seasonId: s.id, scope: 'model', key: model, model, tiers: base.tiers, deposit: base.deposit, overKm: base.overKm });
        entry.models.push({ model, old: valueOf(oldModel), new: valueOf(base) });
      } else entry.same++;
      for (const { plate, row } of list) {
        const oldPlate = rates.get(`${s.id}|plate|${plate}`) || null;
        if (sig(row) === main) {
          // Цена как у модели — особая цена больше не нужна
          if (oldPlate) { changes.push({ seasonId: s.id, scope: 'plate', key: plate, model, remove: true }); entry.removed++; }
          continue;
        }
        if (!oldPlate || sig(valueOf(oldPlate)) !== sig(row)) {
          changes.push({ seasonId: s.id, scope: 'plate', key: plate, model, tiers: row.tiers, deposit: row.deposit, overKm: row.overKm });
          entry.plates.push({ plate, model, old: valueOf(oldPlate), new: valueOf(row) });
        }
      }
    }
  }
  const allFilePlates = new Set(files.flatMap((f) => f.rows.map((r) => plateKey(r.plate))));
  return {
    changes,
    report,
    files: files.map((f) => ({ name: f.name, title: f.title, ranges: f.ranges, rows: f.rows.length, noPlate: f.noPlate })),
    // В файлах есть, в «Парке» нет (продана или ещё не заведена) — пропускаем
    notInFleet: [...new Set(files.flatMap((f) => f.rows.filter((r) => !fleetPlates.has(plateKey(r.plate))).map((r) => r.name)))],
    // В «Парке» есть, ни в одном файле нет — цены остаются прежними
    notInFiles: units.filter((u) => plateKey(u.plate) && !allFilePlates.has(plateKey(u.plate))).map((u) => `${u.model || '—'} (${u.plate})`)
  };
}

const MAX_FILES = 8;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

/** Файлы из запроса портала (base64) → прочитанные тарифы */
export function decodeFiles(list) {
  if (!Array.isArray(list) || !list.length) throw new ImportError('no_files');
  if (list.length > MAX_FILES) throw new ImportError('too_many_files');
  return list.map((f) => {
    const buffer = Buffer.from(String(f?.data || ''), 'base64');
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new ImportError('bad_file', String(f?.name || ''));
    return readTariffFile(buffer, String(f?.name || '').slice(0, 120));
  });
}

/** Предпросмотр или применение (apply) — одним изменением в истории прайса */
export function runImport(body, units, plateKey, by) {
  const files = decodeFiles(body.files);
  const plan = planImport(files, body.mapping || null, units, plateKey);
  if (!body.apply) return { preview: true, ...plan, count: plan.changes.length };
  if (!plan.changes.length) throw new ImportError('nothing_changed');
  const used = plan.report.filter((r) => r.file >= 0).map((r) => `${r.name} ← «${files[r.file].title.replace(/^.*?:\s*/, '')}»`);
  const result = applyChanges({ rates: plan.changes }, by, `Цены из файлов тарифов: ${used.join(', ')}`);
  return { applied: true, ...result };
}
