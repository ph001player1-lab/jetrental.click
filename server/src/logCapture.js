/**
 * Журнал сервера в файл: всё, что бот пишет в console, — ещё и в
 * /data/logs/server.log (по 5 МБ, хранится текущий и один предыдущий файл).
 * Так журнал переживает перезапуск и обновление, и его можно прочитать
 * через служебную диагностику (diag.js). Подключается первым в index.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const DIR = path.join(process.env.DATA_DIR || '/data', 'logs');
export const LOG_FILE = path.join(DIR, 'server.log');
const MAX_BYTES = 5 * 1024 * 1024;

let stream = null;
let bytes = 0;

function open() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    bytes = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch {
    stream = null;
  }
}

function write(level, args) {
  if (!stream) return;
  const line = `${new Date().toISOString()} ${level} ${util.format(...args).replace(/\n/g, '\n  ')}\n`;
  stream.write(line);
  bytes += Buffer.byteLength(line);
  if (bytes > MAX_BYTES) {
    const old = stream;
    stream = null;
    old.end(() => {
      try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* не страшно */ }
      open();
    });
  }
}

open();
for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    write(level, args);
  };
}
