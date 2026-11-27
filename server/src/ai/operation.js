/**
 * ============================================================================
 * «＋ Операция»: ИИ (Claude) по фото и короткой записке понимает, что произошло
 * ============================================================================
 * Выдача (дальше — договор по фото), возврат (акт), замена техники (дополнение),
 * сервис (ремонт, ТО, пробег) или расход по чеку. Возвращает вид операции и поля
 * строго по схеме; чего не видно — пустая строка; в чём не уверен — в unsure.
 * ============================================================================
 */

import { askStructured, photoContent } from './claude.js';
import { str, obj, RENTER, VEHICLE, PHOTOS, PHOTO_TYPES, FIELD_RULES, FIELDS } from './recognize.js';

export const OP_KINDS = ['issue', 'return', 'swap', 'service', 'expense'];
export const SERVICE_ACTIONS = ['to_repair', 'from_repair', 'maintenance', 'mileage'];
// Статьи расходов — те же, что во «Финансах»
export const EXPENSE_CATEGORIES = ['fuel', 'repair', 'wash', 'delivery', 'office', 'insurance', 'tax', 'ads', 'it', 'salary', 'owners', 'refunds', 'vehicles', 'personal', 'other'];
export const PAY_METHODS = ['cash', 'transfer', 'card'];

const money = obj({ text: str, thb: str });
const SCHEMA = obj({
  kind: { type: 'string', enum: [...OP_KINDS, 'unknown'] },
  renter: RENTER,
  vehicle: VEHICLE,
  newVehicle: obj({ plate: str, plateNumber: str, model: str, mileage: str, fuel: str }),
  booking: obj({ from: str, to: str }),
  damages: { type: 'array', items: money },
  deductions: { type: 'array', items: money },
  refund: obj({ amount: str, method: str }),
  service: obj({ action: { type: 'string', enum: [...SERVICE_ACTIONS, ''] }, note: str }),
  expense: obj({
    amount: str, currency: str, date: str, category: { type: 'string', enum: [...EXPENSE_CATEGORIES, ''] },
    vendor: str, method: { type: 'string', enum: [...PAY_METHODS, ''] }, note: str
  }),
  photos: PHOTOS,
  unsure: { type: 'array', items: { type: 'string', enum: [...FIELDS, 'newPlate', 'newMileage', 'newFuel', 'amount', 'date', 'category'] } },
  warnings: { type: 'array', items: str }
});

const SYSTEM = `You help staff of a scooter, motorbike and car rental company in Phuket, Thailand record what just happened, from photos and a short note. Decide which operation it is and fill its fields.

Operations ("kind"):
- "issue": a client takes a vehicle now: photos of the passport, the driving licence and the vehicle. Fill renter, vehicle and booking as for a rental contract.
- "return": a client brings a vehicle back: photos of the vehicle with its plate, the dashboard, maybe damage. Fill vehicle (mileage and fuel at return), damages, deductions and refund.
- "swap": the client gets another vehicle instead of the rented one: two vehicles in the photos or the note. "vehicle" is the one returned, "newVehicle" is the one the client gets, each with mileage and fuel if visible.
- "service": repair, maintenance or a mileage check: "service.action" is "to_repair" (goes to the workshop), "from_repair" (back from repair, ready to rent), "maintenance" (scheduled service: oil and so on) or "mileage" (only the odometer reading). Put the work done in "service.note" (Russian). If a receipt or invoice is in the photos, fill "expense" too (category "repair").
- "expense": a receipt, invoice or bill for something the company paid: fill "expense": amount (the total actually paid, digits and a dot only), currency (ISO code, "THB" unless another is shown), date (YYYY-MM-DD), category, vendor (shop or company name), method ("cash", "transfer", "card" or "" if not shown) and a short note in Russian about what was bought. If the receipt or the note names a vehicle plate, fill vehicle.plate and vehicle.plateNumber.
- "unknown": none of these.

If the staff member says which operation it is, follow that unless the photos clearly show something else (then add a warning).

${PHOTO_TYPES} Also receipts and invoices.

Rules:
${FIELD_RULES}
- newVehicle: the same rules as vehicle (plate, plateNumber, mileage, fuel).
- damages: damage you can see on the vehicle photos at return, each as a short text in Russian ("царапина на левом зеркале"); "thb" only if the note gives a price, else "".
- deductions and refund: only from the staff note: deductions are amounts kept from the deposit (text in Russian and amount in "thb", digits only); refund is the deposit returned to the client ("amount" digits, "method" as written: cash, transfer...).
- Amounts: no thousands separators or currency signs; the expense amount may have a decimal dot, other amounts are whole baht.`;

/** Фото и записка → { result, model, usd } */
export async function recognizeOperation(images, note, hint, staff, today) {
  const text = [
    `Today is ${today}.`,
    hint && OP_KINDS.includes(hint) ? `The staff member says the operation is: ${hint}.` : '',
    note ? `Staff note: """${String(note).slice(0, 1000)}"""` : 'No staff note.',
    images.length ? `Fill the fields from these ${images.length} photo(s).` : 'There are no photos: use the note only.'
  ].filter(Boolean).join('\n');
  const out = await askStructured({ system: SYSTEM, schema: SCHEMA, purpose: 'operation', staff, content: photoContent(images, text) });
  console.log(`AI read an operation: ${out.result?.kind} from ${images.length} photo(s) (${out.model}, ${out.usd.toFixed(3)} USD) by ${staff?.email}`);
  return out;
}
