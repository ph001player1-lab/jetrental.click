/**
 * Удаление тестовых заявок из базы бота. Запуск на сервере:
 *   docker compose -f /opt/kokon/app/deploy/docker-compose.yml exec bot node src/tools/deleteRequests.js --status taken --clear-sheet-rows
 * --status taken — взятые в работу, new — новые. Перед удалением копия
 * заявок сохраняется в /data/deleted-requests-<дата>.json (на всякий случай).
 * Лист Requests в таблице скрипт не трогает. Если строки из листа удалили
 * вручную, добавьте --clear-sheet-rows: оставшиеся заявки забудут свои номера
 * строк, и смена статуса не попадёт в чужую строку.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as db from '../db.js';

const args = process.argv.slice(2);
const status = args[args.indexOf('--status') + 1];
if (!args.includes('--status') || !['new', 'taken'].includes(status)) {
  console.log('Usage: node src/tools/deleteRequests.js --status taken|new');
  process.exit(1);
}

const forgetRows = () => {
  if (args.includes('--clear-sheet-rows')) console.log(`Sheet row numbers cleared: ${db.clearSheetRows()}`);
};

const rows = db.requestsByStatus(status);
if (!rows.length) {
  console.log(`No requests with status "${status}" — nothing to delete.`);
  forgetRows();
  process.exit(0);
}

const backup = path.join(config.dataDir, `deleted-requests-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(backup, JSON.stringify(rows, null, 1));
db.deleteRequests(rows.map((r) => r.id));
console.log(`Deleted ${rows.length} request(s): #${rows.map((r) => r.id).join(', #')}`);
console.log(`Backup: ${backup}`);
forgetRows();
