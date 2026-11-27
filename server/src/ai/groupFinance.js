/**
 * ============================================================================
 * ИИ (Claude) читает сообщение рабочей группы про деньги и раскладывает его на
 * движения «откуда → куда» между счетами: операционный сейф, залоговый сейф,
 * наличные сотрудника, клиент, владелец, банк, расход. «Закрытие дня» и
 * «в кассе осталось…» — снимок остатка (сверка), а не движение.
 * ============================================================================
 */

import { askStructured } from './claude.js';
import { str, obj } from './recognize.js';
import { EXPENSE_CATEGORIES } from './operation.js';

export const ACCOUNTS = ['op', 'dep', 'staff', 'client', 'owner', 'bank', 'expense', 'unknown'];
export const PURPOSES = ['rent', 'deposit', 'deposit_return', 'extras', 'damage', 'handover', 'expense', 'salary', 'owner', 'transfer', 'refund', 'exchange', 'other'];
const ACC = { type: 'string', enum: ACCOUNTS };
const MOVE = obj({
  from: ACC, fromName: str, to: ACC, toName: str, amount: str, currency: str,
  method: { type: 'string', enum: ['cash', 'transfer', 'card', ''] },
  purpose: { type: 'string', enum: PURPOSES },
  category: { type: 'string', enum: [...EXPENSE_CATEGORIES, ''] },
  plate: str, note: str
});
const SCHEMA = obj({
  relevant: { type: 'boolean' },
  summary: str,
  moves: { type: 'array', items: MOVE },
  balances: { type: 'array', items: obj({ account: { type: 'string', enum: ['op', 'dep', 'staff'] }, name: str, amount: str, currency: str }) },
  unsure: { type: 'boolean' },
  question: str
});

const SYSTEM = `You keep the cash ledger of a scooter, motorbike and car rental company in Phuket, Thailand. Staff write in the company's WhatsApp work group in Russian, English or Thai, often briefly. For ONE message, decide whether it is about money and list every money movement as a double entry "from → to".

Accounts:
- "op": the operational safe — the office cash box for rent payments and other company money.
- "dep": the deposit safe — clients' deposits kept in the office.
- "staff": cash held personally by an employee. Put the employee's name in fromName/toName, written exactly as in the staff list when you can match it. "I", "я", "мне", "сдал", "взял" without a name mean the author.
- "client": a client (pays rent, extras, damages, deposits; gets deposits back).
- "owner": the business owner.
- "bank": a bank account or transfer — money that is not cash in hand.
- "expense": money spent on something (fuel, repair, wash, delivery, office, ads...). Set "category".
- "unknown": cannot tell.

How to read typical messages:
- "Сдал в кассу 12 500" / "handover 12500" → staff(author) → op, purpose "handover". Deposits handed to the safe → staff → dep.
- "Взял из кассы 2000 на бензин" → op → staff(author), purpose "transfer"; if the message also says it was spent, add staff(author) → expense (category fuel).
- Cash from a client received by the author: client → staff(author), purpose rent / deposit / extras / damage. If the message says the money went straight into the safe: client → op (deposits → dep). A client's transfer: client → bank, method "transfer".
- An operation report (issue, return, extension, payment, booking) that mentions money: model the payments and deposits the same way (cash with the author unless the safe is named; transfers to bank). At a return, the deposit given back is deposit_return from staff(author) (or dep if the safe is named) to client; a deduction kept from the deposit is NOT returned — mention it in the note.
- Expense paid by the author in cash: staff(author) → expense; from the office cash box: op → expense; by transfer or card: bank → expense.
- Money given to another employee: staff(author) → staff(name), purpose "transfer". Salary or advance paid to an employee: op or staff(payer) → staff(employee), purpose "salary".
- The owner takes money: op → owner, purpose "owner"; the owner adds money: owner → op.
- "Закрытие дня", "закрыл кассу", "в кассе", "остаток", "итого в сейфе", "на руках у меня": these are BALANCES (a snapshot of how much is there now), not moves. Operational cash box → account "op"; deposit safe → "dep"; cash an employee holds → "staff" with the name. A message can have both moves and balances.

Rules:
- amount: digits and an optional dot only, no separators; "12к", "12k" = 12000; "1.5к" = 1500. currency: ISO code, "THB" unless another currency is written (฿, бат, baht = THB; $ = USD; € = EUR; руб = RUB; USDT).
- Do not invent movements that the message does not state. A message that is not about money (greetings, vehicle checks, questions without amounts, plans) → relevant=false and empty lists.
- If the direction, the amount or the person is unclear, still give your best guess and set unsure=true with a short question in Russian in "question".
- note: a short Russian description of each move. summary: one short Russian line for the whole message.
- plate: the vehicle number if the message names one, else "".`;

/** Сообщение → { result, model, usd } */
export async function readGroupFinance({ text, author, authorRole, at, kind, quoted, staffList, model }) {
  const content = [
    `Time (Phuket): ${at}`,
    `Author: ${author}${authorRole ? ` (${authorRole})` : ''}`,
    `Staff list: ${staffList.map((s) => `${s.name}${s.role ? ` (${s.role})` : ''}`).join(', ') || '—'}`,
    kind && kind !== 'note' ? `The group bot parsed this message as an operation report of kind "${kind}".` : '',
    quoted ? `It is a reply to: """${String(quoted).slice(0, 600)}"""` : '',
    `Message: """${String(text).slice(0, 2000)}"""`
  ].filter(Boolean).join('\n');
  return askStructured({ system: SYSTEM, schema: SCHEMA, purpose: 'group_finance', staff: null, content: [{ type: 'text', text: content }], model, effort: 'low' });
}
