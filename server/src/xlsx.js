/**
 * Минимальное чтение файлов Excel (.xlsx) без сторонних библиотек: файл — это
 * zip-архив с XML. Достаём первый лист и общие строки, возвращаем строки
 * таблицы как массивы значений (текст или число). Формулы не считаем — берём
 * сохранённые в файле значения. Для выгрузок WS (Касса) этого достаточно.
 */

import zlib from 'node:zlib';

const MAX_ENTRY_BYTES = 60 * 1024 * 1024;

/** Файлы zip-архива: имя → содержимое (Buffer) */
function unzip(buffer) {
  // Конец центрального каталога: подпись 0x06054b50 в последних 64 КБ
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not_xlsx');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('not_xlsx');
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (size > MAX_ENTRY_BYTES) throw new Error('too_big');
    const lNameLen = buffer.readUInt16LE(local + 26);
    const lExtraLen = buffer.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(start, start + compSize);
    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)));
  }
  return files;
}

const decode = (text) => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/** Текст из <si>…</si> / <is>…</is>: все <t> подряд (в «богатом» тексте их несколько) */
const textOf = (xml) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

/** Номер колонки по адресу ячейки: A → 0, B → 1, AA → 26 */
function columnOf(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Строки первого листа: [[значение, …], …] (пустые ячейки — null) */
export function readFirstSheet(buffer) {
  const files = unzip(buffer);
  const read = (name) => files.get(name)?.().toString('utf8') || null;
  const shared = [...(read('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  // Первый лист по порядку в книге
  const workbook = read('xl/workbook.xml') || '';
  const rels = read('xl/_rels/workbook.xml.rels') || '';
  const firstId = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstId && new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath) || read('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('not_xlsx');
  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = null;
      if (type === 's') value = shared[Number(v)] ?? null;
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'str' || type === 'e') value = v != null ? decode(v) : null;
      else if (type === 'b') value = v === '1';
      else if (v != null) value = Number(v);
      const col = ref ? columnOf(ref) : row.length;
      row[col] = value;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? null : x)));
  }
  return rows;
}
