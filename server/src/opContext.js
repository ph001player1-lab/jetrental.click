/**
 * Какая операция сейчас выполняется. Всё, что она создаёт (статус техники, деньги, расход),
 * помечается её номером — по нему операцию потом открывают, меняют и отменяют во вкладке
 * «Операции». Номер передаётся «по ходу выполнения» (AsyncLocalStorage), а не через
 * параметры каждой функции.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const opScope = new AsyncLocalStorage();
export const currentOpId = () => opScope.getStore()?.opId || null;
