/**
 * ============================================================================
 * ИИ (Claude) читает фото для договора аренды
 * ============================================================================
 * Менеджер фотографирует паспорт, права, технику (виден номер), приборы и, если
 * есть, бронь (скриншот) — Claude возвращает поля договора строго по схеме.
 * Модель — из «Настройки» → «Модель ИИ»; расход — в ai_usage и в месячный лимит.
 *
 * Ничего не выдумывает: чего не видно — пустая строка; в чём не уверен —
 * в списке unsure (в портале такие поля подсвечены).
 * Фото документов нигде не сохраняются: только уходят в Claude на распознавание.
 * ============================================================================
 */

import { askStructured, photoContent, AiError } from './claude.js';

export { AiError };

// Что видно на фото: для техники — подпись в «Приложении 1» (фото при выдаче)
export const PHOTO_KINDS = ['passport', 'licence', 'id_card', 'vehicle_front', 'vehicle_rear', 'vehicle_left', 'vehicle_right',
  'dashboard', 'interior', 'damage', 'booking', 'receipt', 'other'];
export const FIELDS = ['name', 'passport', 'nationality', 'birthDate', 'license', 'licenseCategories', 'licenseValidTo', 'phone',
  'plate', 'model', 'color', 'mileage', 'fuel', 'from', 'to'];

export const str = { type: 'string' };
export const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

// Части схемы — общие для договора и «＋ Операция»
export const RENTER = obj({
  name: str, passport: str, nationality: str, birthDate: str, passportValidTo: str,
  license: str, licenseCategories: str, licenseValidTo: str, phone: str, address: str
});
export const VEHICLE = obj({ plate: str, plateNumber: str, model: str, color: str, mileage: str, fuel: str });
export const PHOTOS = { type: 'array', items: obj({ index: { type: 'integer' }, kind: { type: 'string', enum: PHOTO_KINDS } }) };

const SCHEMA = obj({
  renter: RENTER,
  vehicle: VEHICLE,
  booking: obj({ from: str, to: str }),
  photos: PHOTOS,
  unsure: { type: 'array', items: { type: 'string', enum: FIELDS } },
  warnings: { type: 'array', items: str }
});

export const PHOTO_TYPES = `The photos can show: the client's passport (any country), driving licence (national licence or International Driving Permit), ID card, the vehicle with its Thai licence plate, the dashboard (odometer, fuel gauge), existing damage, a screenshot of a booking or a chat with rental dates and a phone number.`;

export const FIELD_RULES = `- Copy only what you can actually read. Never guess or make values up: if a field is not visible, leave it as an empty string. If you filled a field but some characters are uncertain (blur, glare, cut off, handwriting), add the field name to "unsure".
- renter.name: the full name in Latin letters as printed in the passport, given names first, then the surname, in upper case (for example "IVAN PETROV"). Use the machine-readable zone (MRZ) to check spelling and the passport number when it is visible.
- renter.passport: the passport number exactly as printed. renter.nationality: country of citizenship in English (for example "Russia").
- Dates (birthDate, passportValidTo, licenseValidTo, booking.from, booking.to): YYYY-MM-DD.
- renter.license: what identifies the driving licence in a contract: the issuing country or "IDP", then the number (for example "Russia 99 12 345678" or "IDP 1234567"). renter.licenseCategories: the categories as printed (for example "A, B").
- renter.phone and booking dates: only from a booking or chat screenshot; phone in international format starting with +.
- renter.address: the client's hotel or address in Thailand, only if a screenshot shows it; never the home address from a document.
- vehicle.plate: the plate as printed, Thai letters kept. vehicle.plateNumber: only the main group of digits of the plate (for "1กข 2345 ภูเก็ต" it is "2345").
- vehicle.model: make and model if readable. vehicle.color: in English.
- vehicle.mileage: the odometer reading in km, digits only (not the trip meter). vehicle.fuel: the fuel level in eighths, "0" to "8", or "" if the gauge is not visible.
- photos: one entry per photo, in the order given (the first photo is index 0), saying what it shows. For the vehicle, choose the side it is photographed from.
- warnings: short notes in Russian for the manager about problems you see, for example: the passport or licence has expired, the licence has no category A while the vehicle is a motorbike or scooter, the name on the licence differs from the passport, a photo is too blurry to read. An empty array if there are none.`;

const SYSTEM = `You read photos that staff of a scooter, motorbike and car rental company in Phuket, Thailand take when a client rents a vehicle, and fill the fields of the rental contract.

${PHOTO_TYPES}

Rules:
${FIELD_RULES}`;

/**
 * Фото → поля договора. images — [{ data: base64, type: 'image/jpeg' | 'image/png' | 'image/webp' }]
 * Возвращает { result, model, usd }.
 */
export async function recognizeContractPhotos(images, staff, today) {
  const out = await askStructured({
    system: SYSTEM, schema: SCHEMA, purpose: 'contract_photos', staff,
    content: photoContent(images, `Today is ${today}. Fill the contract fields from these ${images.length} photo(s).`)
  });
  console.log(`AI read ${images.length} photo(s) for a contract (${out.model}, ${out.usd.toFixed(3)} USD) by ${staff?.email}`);
  return out;
}
