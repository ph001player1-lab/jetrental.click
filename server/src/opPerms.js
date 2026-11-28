/**
 * Кто какие операции проводит — вкладка «Доступы» (у админа — все): аренда, сервис, деньги.
 * Общее для «＋ Операция», вкладки «Операции» и договоров.
 */

import { can, roleOf } from './roles.js';
import { OP_KINDS } from './ai/operation.js';

export const RENT_OPS = ['booking', 'issue', 'return', 'swap', 'extend'];
export const MONEY_OPS = ['income', 'deposit_refund', 'payout'];

export const isOwnerOrAdmin = (staff) => roleOf(staff) === 'owner' || can(staff, 'access.admin');

export const mayKind = (staff, kind) => {
  // Выдача — это ещё и договор: нужен «Документы: меняет»
  if (RENT_OPS.includes(kind)) return can(staff, 'op_rent.edit') && (kind !== 'issue' || can(staff, 'docs.edit'));
  if (kind === 'service') return can(staff, 'op_service.edit');
  if (kind === 'expense') return can(staff, 'op_service.edit') || can(staff, 'op_money.edit');
  if (MONEY_OPS.includes(kind)) return can(staff, 'op_money.edit');
  return false;
};
export const anyKind = (staff) => OP_KINDS.some((k) => mayKind(staff, k));
/** Какие операции доступны сотруднику (для кнопки «＋ Операция») */
export const allowedOps = (staff) => OP_KINDS.filter((k) => mayKind(staff, k));
