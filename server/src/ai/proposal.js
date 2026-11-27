/**
 * Что ИИ прочитал на фото → с чем это связано в портале: техника из «Парка» по номеру,
 * кто её сейчас держит, клиент в CRM, бронь и заявка. Общее для договора по фото
 * («Документы») и «＋ Операция».
 */

import * as db from '../db.js';
import { HttpError } from '../http.js';
import { plateKey, getPortalSnapshot } from '../fleet.js';
import { listVehicles } from '../fleetStore.js';
import { isSold } from '../sold.js';
import { clientOfReport, clientByContact, clientsByName } from '../crm.js';
import { contractFor } from '../documents.js';

const nameWords = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w.length >= 2);
/** Одно имя похоже на другое: два общих слова или все слова короткого имени */
export function sameName(a, b) {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return false;
  const common = x.filter((w) => y.includes(w)).length;
  return common >= 2 || common === Math.min(x.length, y.length);
}
const phoneTail = (p) => String(p || '').replace(/\D/g, '').slice(-9);
export const dayPart = (v) => (v ? String(v).slice(0, 10) : '');
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : '');
export const VEHICLE_CAPTION = { vehicle_front: 'front', vehicle_rear: 'rear', vehicle_left: 'left', vehicle_right: 'right', dashboard: 'dashboard', interior: 'interior', damage: 'damage' };
export const vehicleName = (x) => [x.brand, x.model].filter(Boolean).join(' ') || x.clientModel || '';

/** Фото из запроса: до 8, JPEG / PNG / WebP в base64 */
export function parsePhotos(body, max = 8) {
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, max) : [];
  return photos.map((ph) => {
    const type = ['image/jpeg', 'image/png', 'image/webp'].includes(ph?.type) ? ph.type : null;
    const data = typeof ph?.data === 'string' ? ph.data.replace(/^data:[^,]+,/, '') : '';
    if (!type || !data || data.length > 6_500_000 || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(400, 'bad_photo');
    return { type, data };
  });
}

/** Кто арендует (или забронировал) технику: { name, phone, source, clientId, contract } или null */
export async function renterOf(car) {
  const h = car.holder;
  if (!h) return null;
  const contract = contractFor(car.plate, h.from, h.to, h.docId);
  let client = null;
  if (h.client) client = await clientByContact(h.client.phone).catch(() => null);
  else if (h.src === 'group') client = await clientOfReport(h.ref).catch(() => null);
  const name = contract?.name || h.client?.name || client?.name || '';
  const phone = contract?.phone || h.client?.phone || client?.phone || '';
  if (!name && !phone) return contract ? { name: '', phone: '', source: 'contract', clientId: null, contract: { id: contract.id, number: contract.number }, kind: h.kind } : null;
  return {
    name, phone, kind: h.kind, clientId: client?.id || null,
    source: contract ? 'contract' : h.client ? 'portal' : 'group',
    contract: contract ? { id: contract.id, number: contract.number } : null
  };
}

/** Техника по номеру с фото: точное совпадение цифр или окончание номера; при нескольких — по модели */
export function vehicleByPhoto(v) {
  const digitsOnly = String(v?.plateNumber || '').replace(/\D/g, '') || (String(v?.plate || '').match(/(\d{3,5})\D*$/) || [])[1] || '';
  if (digitsOnly.length < 3) return { vehicle: null, candidates: [] };
  const full = plateKey(v.plate);
  const all = listVehicles().filter((x) => !isSold(x.plate));
  let found = all.filter((x) => { const k = plateKey(x.plate); return k === digitsOnly || k === full || k.endsWith(digitsOnly); });
  if (found.length > 1 && v.model) {
    const byModel = found.filter((x) => sameName(vehicleName(x), v.model));
    if (byModel.length) found = byModel;
  }
  const brief = (x) => ({ id: x.id, plate: x.plate, model: vehicleName(x), type: x.type });
  return found.length === 1 ? { vehicle: brief(found[0]), candidates: [] } : { vehicle: null, candidates: found.slice(0, 5).map(brief) };
}

/** Машина из снимка «Парка»: статус, кто держит (аренда или бронь) */
export async function carNow(vehicleId) {
  const car = (await getPortalSnapshot().catch(() => null))?.cars.find((c) => c.vehicleId === vehicleId) || null;
  const renter = car ? await renterOf(car).catch(() => null) : null;
  return { car, holder: car?.holder || null, renter };
}

/**
 * Прочитанное для договора (renter, vehicle, booking, photos, unsure, warnings) → ответ
 * для формы договора: поля, техника, клиент, бронь, заявка, подписи фото.
 */
export async function contractProposal(r, photoCount) {
  const warnings = Array.isArray(r.warnings) ? r.warnings.map(String).slice(0, 8) : [];
  const fields = {
    name: r.renter?.name || '', passport: r.renter?.passport || '', nationality: r.renter?.nationality || '',
    license: [r.renter?.license, r.renter?.licenseCategories ? `(${r.renter.licenseCategories})` : ''].filter(Boolean).join(' '),
    phone: r.renter?.phone || '', address: r.renter?.address || '',
    mileage: String(r.vehicle?.mileage || '').replace(/\D/g, ''), fuel: /^[0-8]$/.test(String(r.vehicle?.fuel)) ? Number(r.vehicle.fuel) : null,
    plate: r.vehicle?.plate || '', model: r.vehicle?.model || '', color: r.vehicle?.color || ''
  };
  // Техника — по номеру из «Парка»; что с ней сейчас (бронь, аренда)
  const { vehicle, candidates } = vehicleByPhoto(r.vehicle || {});
  let fleetBooking = null;
  if (vehicle) {
    const { holder: h, renter } = await carNow(vehicle.id);
    if (h?.kind === 'reserve') fleetBooking = { from: dayPart(h.from), to: dayPart(h.to), name: renter?.name || '', phone: renter?.phone || '', source: 'fleet' };
    if (h?.kind === 'rent') warnings.push(`Эта техника сейчас в аренде${renter?.name ? ` у ${renter.name}` : ''}${h.to ? ` до ${dayPart(h.to)}` : ''}. Проверьте номер.`);
  }
  // Клиент в CRM: по телефону со скриншота, иначе по имени из паспорта
  let client = fields.phone ? await clientByContact(fields.phone).catch(() => null) : null;
  let crmBooking = null;
  if (!client && fields.name) {
    const list = await clientsByName(fields.name).catch(() => []);
    if (list[0]) {
      client = list[0];
      if (list[0].booking) crmBooking = { from: list[0].booking.from, to: list[0].booking.to, name: list[0].name, phone: list[0].phone, source: 'crm' };
    }
  }
  // Заявка с сайта или из ботов (новая или взятая): по телефону или имени
  const reqMatch = db.listActiveRequests().filter((x) => (fields.phone && phoneTail(x.client_phone || x.client_chat_id) === phoneTail(fields.phone))
    || (client?.phone && phoneTail(x.client_phone || x.client_chat_id) === phoneTail(client.phone))
    || (fields.name && sameName(x.client_name, fields.name)))
    .sort((a, b) => b.id - a.id)[0] || null;
  const request = reqMatch ? { id: reqMatch.id, name: reqMatch.client_name || '', from: reqMatch.date_from, to: reqMatch.date_to, model: reqMatch.model } : null;
  // Бронь: на эту технику и этого клиента → заявка → CRM → даты со скриншота
  let booking = null;
  if (fleetBooking && (!fields.name || !fleetBooking.name || sameName(fleetBooking.name, fields.name))) booking = fleetBooking;
  else if (fleetBooking) warnings.push(`Эта техника забронирована на другого клиента: ${fleetBooking.name} (${fleetBooking.from} – ${fleetBooking.to}).`);
  if (!booking && request?.from) booking = { from: request.from, to: request.to, name: request.name, source: 'request', requestId: request.id };
  if (!booking && crmBooking) booking = crmBooking;
  if (!booking && (isoDay(r.booking?.from) || isoDay(r.booking?.to))) booking = { from: isoDay(r.booking.from), to: isoDay(r.booking.to), source: 'photo' };
  if (!fields.phone) fields.phone = booking?.phone || client?.phone || '';
  const unsure = Array.isArray(r.unsure) ? [...new Set(r.unsure.map(String))] : [];
  if (!vehicle && fields.plate) warnings.push(candidates.length ? `Номер ${fields.plate} подходит к нескольким машинам — выберите технику.` : `Техники с номером ${fields.plate} нет в «Парке» — выберите вручную.`);
  return {
    fields, unsure, warnings,
    photos: photoList(r.photos, photoCount),
    vehicle, candidates, client: client ? { id: client.id, name: client.name, phone: client.phone } : null, booking, request
  };
}

/** Что на каком фото: [{ index, kind, caption }] — caption для «Фото при выдаче» (только техника) */
export function photoList(list, count) {
  return (Array.isArray(list) ? list : []).filter((x) => Number.isInteger(x?.index) && x.index >= 0 && x.index < count)
    .map((x) => ({ index: x.index, kind: x.kind, caption: VEHICLE_CAPTION[x.kind] || null }));
}
