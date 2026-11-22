/**
 * Запуск журнала при старте сервера: переразбор старых сообщений после
 * улучшения разбора, внутренний API для наблюдателя WhatsApp, раз в сутки —
 * сроки хранения фото и чистка старой истории WS.
 */

import { reparseStale, applyMediaRetention, relinkMediaOnce } from './journal.js';
import { startInternalServer } from './observer.js';
import { pruneWsHistory } from './wsHistory.js';

const DAY_MS = 86400000;

function daily() {
  try {
    const removed = applyMediaRetention();
    if (removed) console.log(`Journal: removed ${removed} expired photos`);
    pruneWsHistory();
  } catch (err) {
    console.error('Journal daily cleanup failed:', err.message);
  }
}

export function startJournal() {
  try {
    const n = reparseStale();
    if (n) console.log(`Journal: re-parsed ${n} messages`);
    const unlinked = relinkMediaOnce();
    if (unlinked) console.log(`Journal: unlinked ${unlinked} photos attached to the wrong report`);
  } catch (err) {
    console.error('Journal re-parse failed:', err.message);
  }
  startInternalServer();
  setTimeout(daily, 60 * 1000).unref();
  setInterval(daily, DAY_MS).unref();
}
