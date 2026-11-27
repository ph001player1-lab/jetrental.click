/**
 * HTML → PDF через Chromium из командной строки (--print-to-pdf), без
 * сторонних npm-пакетов. На сервере Chromium ставится в образ бота
 * (server/Dockerfile), путь можно задать в CHROMIUM_PATH. Документы печатаются
 * по одному; временные файлы (в них личные данные клиента) сразу удаляются.
 * Всё нужное (шрифты, логотип, фото, подписи) уже встроено в HTML — сеть
 * Chromium не нужна, её отключаем (JavaScript не выключаем — без него Chromium не печатает).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium'].filter(Boolean);
const TIMEOUT_MS = 45000;

export class PdfError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function chromiumPath() {
  return CANDIDATES.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

let queue = Promise.resolve();

/** HTML страницы A4 → Buffer с PDF (по одному документу за раз) */
export function htmlToPdf(html) {
  const run = queue.then(() => print(html));
  queue = run.catch(() => {});
  return run;
}

async function print(html) {
  const bin = chromiumPath();
  if (!bin) throw new PdfError('pdf_unavailable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokon-pdf-'));
  const src = path.join(dir, 'doc.html');
  const out = path.join(dir, 'doc.pdf');
  fs.writeFileSync(src, html);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, [
        '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
        '--proxy-server=socks5://127.0.0.1:9',
        '--no-pdf-header-footer', '--print-to-pdf-no-header',
        `--user-data-dir=${path.join(dir, 'profile')}`, `--print-to-pdf=${out}`, `file://${src}`
      ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: dir } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new PdfError('pdf_timeout')); }, TIMEOUT_MS);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) resolve();
        else reject(new Error(`chromium exit ${code}: ${stderr.slice(-600)}`));
      });
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
