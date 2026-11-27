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

import Anthropic from '@anthropic-ai/sdk';
import { aiSettings, aiAllowed, recordAiUsage } from '../itSettings.js';

export class AiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Что видно на фото: для техники — подпись в «Приложении 1» (фото при выдаче)
export const PHOTO_KINDS = ['passport', 'licence', 'id_card', 'vehicle_front', 'vehicle_rear', 'vehicle_left', 'vehicle_right',
  'dashboard', 'interior', 'damage', 'booking', 'other'];
const FIELDS = ['name', 'passport', 'nationality', 'birthDate', 'license', 'licenseCategories', 'licenseValidTo', 'phone',
  'plate', 'model', 'color', 'mileage', 'fuel', 'from', 'to'];

const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const SCHEMA = obj({
  renter: obj({
    name: str, passport: str, nationality: str, birthDate: str, passportValidTo: str,
    license: str, licenseCategories: str, licenseValidTo: str, phone: str, address: str
  }),
  vehicle: obj({ plate: str, plateNumber: str, model: str, color: str, mileage: str, fuel: str }),
  booking: obj({ from: str, to: str }),
  photos: { type: 'array', items: obj({ index: { type: 'integer' }, kind: { type: 'string', enum: PHOTO_KINDS } }) },
  unsure: { type: 'array', items: { type: 'string', enum: FIELDS } },
  warnings: { type: 'array', items: str }
});

const SYSTEM = `You read photos that staff of a scooter, motorbike and car rental company in Phuket, Thailand take when a client rents a vehicle, and fill the fields of the rental contract.

The photos can show: the client's passport (any country), driving licence (national licence or International Driving Permit), ID card, the vehicle with its Thai licence plate, the dashboard (odometer, fuel gauge), existing damage, a screenshot of a booking or a chat with rental dates and a phone number.

Rules:
- Copy only what you can actually read. Never guess or make values up: if a field is not visible, leave it as an empty string. If you filled a field but some characters are uncertain (blur, glare, cut off, handwriting), add the field name to "unsure".
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

let client = null;
const claude = () => {
  // Ключ — ANTHROPIC_API_KEY из /opt/kokon/.env; клиент сам повторяет 429 и 5xx
  if (!client) client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  return client;
};

/**
 * Фото → поля договора. images — [{ data: base64, type: 'image/jpeg' | 'image/png' | 'image/webp' }]
 * Возвращает { result, model, usd }.
 */
export async function recognizeContractPhotos(images, staff, today) {
  const allowed = aiAllowed();
  if (!allowed.ok) throw new AiError(allowed.code);
  const { model } = aiSettings();
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
  });
  content.push({ type: 'text', text: `Today is ${today}. Fill the contract fields from these ${images.length} photo(s).` });
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }]
  };
  let response;
  try {
    // Opus и Sonnet: если фильтр безопасности ошибочно откажет — тот же запрос выполнит запасная модель
    response = model === 'claude-haiku-5-5'
      ? await claude().messages.create(params)
      : await claude().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new AiError('ai_bad_key');
    if (err instanceof Anthropic.RateLimitError) throw new AiError('ai_busy');
    if (err instanceof Anthropic.APIConnectionError) throw new AiError('ai_unreachable');
    if (err instanceof Anthropic.APIError) {
      console.error(`Claude error ${err.status}: ${err.message}`);
      throw new AiError(err.status === 400 ? 'ai_bad_photo' : 'ai_failed');
    }
    throw err;
  }
  const usd = recordAiUsage({
    model, inputTokens: response.usage?.input_tokens || 0, outputTokens: response.usage?.output_tokens || 0,
    purpose: 'contract_photos', by: staff?.email || null
  });
  if (response.stop_reason === 'refusal') throw new AiError('ai_refused');
  if (response.stop_reason === 'max_tokens') throw new AiError('ai_failed');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new AiError('ai_failed');
  }
  console.log(`AI read ${images.length} photo(s) for a contract (${model}, $${usd.toFixed(3)}) by ${staff?.email}`);
  return { result, model, usd };
}
