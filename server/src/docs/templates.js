/**
 * ============================================================================
 * Шаблоны документов Jet Mobility (утвердил владелец)
 * ============================================================================
 * Договор аренды (авто / мото), приложение «Фото при выдаче», акт возврата,
 * квитанция об оплате и залоге, дополнение к договору (продление, замена).
 * Каждая подпись — на языке клиента (en или ru), под ней по-тайски. Шрифты
 * (Noto Sans — латиница и кириллица, Sarabun — тайский; лицензия OFL) и логотип
 * встраиваются в HTML, PDF печатает Chromium (docs/pdf.js).
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const L = {
  carTitle: { en: 'Car Rental Agreement', ru: 'Договор аренды автомобиля', th: 'สัญญาเช่ารถยนต์' },
  bikeTitle: { en: 'Motorbike Rental Agreement', ru: 'Договор аренды мотоцикла / скутера', th: 'สัญญาเช่ารถจักรยานยนต์' },
  contractNo: { en: 'Contract No.', ru: 'Договор №', th: 'เลขที่สัญญา' },
  date: { en: 'Date', ru: 'Дата', th: 'วันที่' },
  plate: { en: 'License plate', ru: 'Госномер', th: 'ทะเบียนรถ' },
  renter: { en: 'Renter', ru: 'Арендатор', th: 'ข้อมูลผู้เช่า' },
  name: { en: 'Full name', ru: 'ФИО', th: 'ชื่อ-นามสกุล' },
  passport: { en: 'Passport No.', ru: 'Паспорт №', th: 'เลขหนังสือเดินทาง' },
  nationality: { en: 'Nationality', ru: 'Гражданство', th: 'สัญชาติ' },
  license: { en: 'Driving licence', ru: 'Водительское удостоверение', th: 'ใบขับขี่' },
  phone: { en: 'Phone / WhatsApp', ru: 'Телефон / WhatsApp', th: 'หมายเลขติดต่อ' },
  address: { en: 'Address in Thailand', ru: 'Адрес в Таиланде', th: 'ที่อยู่ในประเทศไทย' },
  carInfo: { en: 'Vehicle', ru: 'Автомобиль', th: 'ข้อมูลรถยนต์' },
  bikeInfo: { en: 'Motorbike', ru: 'Мотоцикл / скутер', th: 'ข้อมูลรถจักรยานยนต์' },
  model: { en: 'Model', ru: 'Модель', th: 'รุ่นรถ' },
  color: { en: 'Colour', ru: 'Цвет', th: 'สี' },
  vin: { en: 'VIN (chassis No.)', ru: 'VIN (номер кузова)', th: 'เลขตัวถัง' },
  mileage: { en: 'Mileage, km', ru: 'Пробег, км', th: 'เลขไมล์' },
  fuel: { en: 'Fuel', ru: 'Топливо', th: 'ระดับน้ำมัน' },
  equipment: { en: 'Handed over with the vehicle', ru: 'Передано вместе с техникой', th: 'อุปกรณ์ที่ส่งมอบ' },
  agree: { en: 'The renter agrees to pay', ru: 'Арендатор согласен оплатить', th: 'ผู้เช่าตกลงชำระค่าใช้จ่ายดังต่อไปนี้' },
  period: { en: 'Rental period', ru: 'Срок аренды', th: 'ระยะเวลาเช่า' },
  pickup: { en: 'Pick-up', ru: 'Выдача', th: 'วันที่รับรถ' },
  ret: { en: 'Return', ru: 'Возврат', th: 'วันที่คืนรถ' },
  pickupPlace: { en: 'Pick-up place', ru: 'Место выдачи', th: 'สถานที่รับรถ' },
  returnPlace: { en: 'Return place', ru: 'Место возврата', th: 'สถานที่คืนรถ' },
  charges: { en: 'Payment', ru: 'Оплата', th: 'ค่าใช้จ่าย' },
  days: { en: 'Rental days', ru: 'Суток аренды', th: 'จำนวนวันเช่า' },
  perDay: { en: 'Price per day', ru: 'Цена за сутки', th: 'ราคาต่อวัน' },
  total: { en: 'Total price', ru: 'Итого за аренду', th: 'ราคารวม' },
  priceList: { en: 'Price by tariff', ru: 'Цена по прайсу', th: 'ราคาตามอัตรา' },
  discount: { en: 'Discount', ru: 'Скидка', th: 'ส่วนลด' },
  draft: { en: 'DRAFT — discount awaiting approval', ru: 'ЧЕРНОВИК — скидка ждёт одобрения', th: 'ฉบับร่าง — รออนุมัติส่วนลด' },
  deposit: { en: 'Deposit (refundable)', ru: 'Залог (возвращается)', th: 'เงินมัดจำ (คืนได้)' },
  paid: { en: 'Paid', ru: 'Оплачено', th: 'ชำระแล้ว' },
  prepaid: { en: 'Prepaid at booking', ru: 'Предоплата при брони', th: 'มัดจำตอนจอง' },
  balance: { en: 'Balance due', ru: 'Осталось оплатить', th: 'คงเหลือที่ต้องชำระ' },
  rules: { en: 'Terms', ru: 'Условия', th: 'เงื่อนไข' },
  readAgree: { en: 'I have read and agree to the terms of this agreement.', ru: 'С условиями договора ознакомлен(а) и согласен(на).', th: 'ข้าพเจ้าได้อ่านและยอมรับเงื่อนไขของสัญญานี้' },
  renterSign: { en: 'Renter signature', ru: 'Подпись арендатора', th: 'ลายเซ็นผู้เช่า' },
  companySign: { en: 'For Jet Mobility', ru: 'От Jet Mobility', th: 'ผู้แทนบริษัท' },
  signedOnline: { en: 'Signed on screen', ru: 'Подписано на экране', th: 'ลงนามบนหน้าจอ' },
  photosTitle: { en: 'Annex 1. Photos at pick-up', ru: 'Приложение 1. Фото при выдаче', th: 'ภาคผนวก 1 ภาพถ่ายขณะส่งมอบรถ' },
  photosNote: { en: 'Photos taken at pick-up are part of this agreement. Damage not visible in them is charged per the terms.', ru: 'Фото при выдаче — часть договора. Повреждения, которых нет на фото, оплачиваются по условиям договора.', th: 'ภาพถ่ายขณะส่งมอบรถเป็นส่วนหนึ่งของสัญญา ความเสียหายที่ไม่ปรากฏในภาพจะคิดค่าใช้จ่ายตามเงื่อนไข' },
  returnTitle: { en: 'Vehicle Return Report', ru: 'Акт возврата техники', th: 'บันทึกการคืนรถ' },
  planned: { en: 'Planned', ru: 'По договору', th: 'ตามสัญญา' },
  actual: { en: 'Actual', ru: 'Фактически', th: 'คืนจริง' },
  late: { en: 'Late', ru: 'Опоздание', th: 'คืนช้า' },
  atPickup: { en: 'At pick-up', ru: 'При выдаче', th: 'ขณะรับรถ' },
  atReturn: { en: 'At return', ru: 'При возврате', th: 'ขณะคืนรถ' },
  driven: { en: 'Driven', ru: 'Проехал', th: 'ระยะทางที่ใช้' },
  returned: { en: 'Returned', ru: 'Возвращено', th: 'คืนแล้ว' },
  missing: { en: 'Missing', ru: 'Нет', th: 'สูญหาย' },
  damages: { en: 'Damage found', ru: 'Найденные повреждения', th: 'ความเสียหายที่พบ' },
  noDamage: { en: 'No new damage found.', ru: 'Новых повреждений нет.', th: 'ไม่พบความเสียหายใหม่' },
  deductions: { en: 'Deductions', ru: 'Удержания', th: 'รายการหักเงิน' },
  noDeductions: { en: 'No deductions.', ru: 'Удержаний нет.', th: 'ไม่มีรายการหักเงิน' },
  depositReceived: { en: 'Deposit received', ru: 'Залог получен', th: 'เงินมัดจำที่รับไว้' },
  deducted: { en: 'Deducted', ru: 'Удержано', th: 'หักจากเงินมัดจำ' },
  refund: { en: 'Deposit refunded', ru: 'Залог возвращён', th: 'คืนเงินมัดจำ' },
  method: { en: 'How', ru: 'Как', th: 'วิธีการ' },
  returnAgree: { en: 'Vehicle returned and deposit settled as stated above. No further claims.', ru: 'Техника возвращена, залог рассчитан, как указано выше. Претензий нет.', th: 'คืนรถและชำระเงินมัดจำตามรายการข้างต้นแล้ว ไม่มีข้อเรียกร้องเพิ่มเติม' },
  receiptTitle: { en: 'Payment Receipt', ru: 'Квитанция об оплате', th: 'ใบเสร็จรับเงิน' },
  receiptNo: { en: 'Receipt No.', ru: 'Квитанция №', th: 'เลขที่ใบเสร็จ' },
  receivedFrom: { en: 'Received from', ru: 'Получено от', th: 'ได้รับเงินจาก' },
  forWhat: { en: 'For', ru: 'За что', th: 'รายการ' },
  amount: { en: 'Amount, THB', ru: 'Сумма, ฿', th: 'จำนวนเงิน (บาท)' },
  totalReceived: { en: 'Total received', ru: 'Всего получено', th: 'รวมรับเงิน' },
  paymentMethod: { en: 'Payment method', ru: 'Способ оплаты', th: 'วิธีชำระเงิน' },
  receivedBy: { en: 'Received by', ru: 'Принял(а)', th: 'ผู้รับเงิน' },
  depositNote: { en: 'The deposit is refunded when the vehicle is returned on time, undamaged and with the same fuel level.', ru: 'Залог возвращается при возврате техники в срок, без повреждений и с тем же уровнем топлива.', th: 'เงินมัดจำจะคืนให้เมื่อคืนรถตรงเวลา ไม่มีความเสียหาย และมีน้ำมันเท่าเดิม' },
  addTitle: { en: 'Addendum to the Rental Agreement', ru: 'Дополнение к договору аренды', th: 'บันทึกเพิ่มเติมท้ายสัญญาเช่า' },
  addNo: { en: 'Addendum No.', ru: 'Дополнение №', th: 'บันทึกเพิ่มเติมเลขที่' },
  toContract: { en: 'to contract', ru: 'к договору', th: 'แนบท้ายสัญญาเลขที่' },
  extension: { en: 'Extension', ru: 'Продление', th: 'ขยายระยะเวลาเช่า' },
  swap: { en: 'Vehicle replacement', ru: 'Замена техники', th: 'เปลี่ยนรถ' },
  newReturn: { en: 'New return date', ru: 'Новая дата возврата', th: 'วันที่คืนรถใหม่' },
  extraDays: { en: 'Extra days', ru: 'Дополнительно суток', th: 'จำนวนวันเพิ่ม' },
  extraPrice: { en: 'Extra payment', ru: 'Доплата', th: 'ค่าเช่าเพิ่ม' },
  oldVehicle: { en: 'Returned vehicle', ru: 'Сдал', th: 'รถคันเดิม' },
  newVehicle: { en: 'New vehicle', ru: 'Получил', th: 'รถคันใหม่' },
  reason: { en: 'Reason', ru: 'Причина', th: 'เหตุผล' },
  otherTerms: { en: 'All other terms of the agreement stay the same.', ru: 'Остальные условия договора не меняются.', th: 'เงื่อนไขอื่นของสัญญาคงเดิม' },
  sample: { en: 'SAMPLE', ru: 'ОБРАЗЕЦ', th: 'ตัวอย่าง' },
  from: { en: 'from', ru: 'от', th: 'เริ่มต้น' }
};

export const COMPANY = {
  name: 'Jet Mobility Co., Ltd.',
  addressTh: '99 หมู่ 1 ถนนเทพกระษัตรี ต.เกาะแก้ว จ.ภูเก็ต',
  phone: '+66 63 192 3354',
  site: 'jetmobility.org'
};

export const LANGS = ['en', 'ru'];
export const docTitle = (kind, type, lang) => L[{ contract: type === 'car' ? 'carTitle' : 'bikeTitle', photos: 'photosTitle', return: 'returnTitle', receipt: 'receiptTitle', addendum: 'addTitle' }[kind]]?.[lang] || '';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '' : new Intl.NumberFormat('en-US').format(Number(n)));
const money = (n) => (n === null || n === undefined || n === '' ? '—' : `${num(n)} ฿`);

/** Подпись: язык клиента и тайский ниже */
const lbl = (key, lang) => `<span class="lb">${esc(L[key][lang])}<small>${esc(L[key].th)}</small></span>`;
/** Текст из данных: { en, ru, th } или свободный текст сотрудника { text } */
const txt = (x, lang) => `${esc(x.text ?? x[lang] ?? x.en ?? '')}${x.th && !x.text ? `<small>${esc(x.th)}</small>` : ''}`;

// Галочки — рисунком (в шрифтах документа нет символов ✓ ✗)
const CHECK = '<svg viewBox="0 0 12 12" class="ckm"><path d="M2 6.5l2.5 2.5L10 3" fill="none" stroke="#111" stroke-width="1.8"/></svg>';
const CROSS = '<svg viewBox="0 0 12 12" class="ckm"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="#c0362c" stroke-width="1.8"/></svg>';
const box = (state) => `<span class="ck">${state === true ? CHECK : state === false ? CROSS : ''}</span>`;

/** Указатель топлива: 0…8 восьмых */
function fuelGauge(eighths) {
  const e = Math.max(0, Math.min(8, Number(eighths) || 0));
  const ticks = [];
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI - (i / 8) * Math.PI;
    const r2 = i % 4 ? 33 : 30;
    ticks.push(`<line x1="${(50 + Math.cos(a) * 38).toFixed(1)}" y1="${(48 - Math.sin(a) * 38).toFixed(1)}" x2="${(50 + Math.cos(a) * r2).toFixed(1)}" y2="${(48 - Math.sin(a) * r2).toFixed(1)}"/>`);
  }
  const a = Math.PI - (e / 8) * Math.PI;
  return `<svg class="fuel" viewBox="0 0 100 58"><g stroke="#222" stroke-width="2">${ticks.join('')}</g>
    <path d="M12 48 A38 38 0 0 1 88 48" fill="none" stroke="#222" stroke-width="1"/>
    <line x1="50" y1="48" x2="${(50 + Math.cos(a) * 30).toFixed(1)}" y2="${(48 - Math.sin(a) * 30).toFixed(1)}" stroke="#e0533d" stroke-width="3" stroke-linecap="round"/><circle cx="50" cy="48" r="3.5" fill="#222"/>
    <text x="6" y="56" font-size="9">E</text><text x="88" y="56" font-size="9">F</text><text x="50" y="57" font-size="8" text-anchor="middle">${e}/8</text></svg>`;
}

const field = (key, value, lang, cls = '') => `<div class="f ${cls}">${lbl(key, lang)}<b>${esc(value) || '&nbsp;'}</b></div>`;

function head(title, lang, right, d) {
  return `<header class="hd">
    <img class="logo" src="${LOGO}" alt="Jet Mobility">
    <div class="tt"><h1>${esc(title[lang])}</h1><div class="th1">${esc(title.th)}</div></div>
    <div class="no">${right}</div>
  </header>${d.sample ? `<div class="wm">${esc(L.sample[lang])} · ${esc(L.sample.th)}</div>` : d.draft ? `<div class="wm wm--draft">${esc(L.draft[lang])}<br>${esc(L.draft.th)}</div>` : ''}`;
}

const foot = () => `<footer class="ft"><b>${COMPANY.name}</b> · ${esc(COMPANY.addressTh)} · ${COMPANY.phone} · ${COMPANY.site}</footer>`;

function signBlock(lang, d, who, key) {
  const s = d.signatures?.[who];
  return `<div class="sg">${lbl(key, lang)}<div class="line">${s?.png ? `<img src="${s.png}" alt="">` : ''}</div>
    <span class="who">${esc(who === 'company' ? d.staff || '' : d.renter?.name || '')}${s?.at ? ` · ${esc(L.signedOnline[lang])} ${esc(s.at)}` : ''}</span></div>`;
}

function signs(lang, d, agreeKey = 'readAgree') {
  return `<p class="agree">${esc(L[agreeKey][lang])}<small>${esc(L[agreeKey].th)}</small></p>
    <div class="signs">${signBlock(lang, d, 'renter', 'renterSign')}${signBlock(lang, d, 'company', 'companySign')}</div>`;
}

const noBox = (lang, no, date) => `<div>${lbl('contractNo', lang)}<b class="big">${esc(no)}</b></div><div>${lbl('date', lang)}<b>${esc(date)}</b></div>`;

/* ---------------------------------------------------------------- Договор */

function contract(d, lang) {
  const car = d.vehicle.type === 'car';
  const eq = d.handover.equipment.map((e) => `<li>${box(e.ok ? true : null)}<span>${txt(e, lang)}</span></li>`).join('');
  const pen = d.penalties.map((p) => `<tr><td>${txt(p, lang)}</td><td class="r">${p.from ? `${esc(L.from[lang])} ` : ''}${money(p.thb)}</td></tr>`).join('');
  const rules = d.rules.map((r) => `<li>${txt(r, lang)}</li>`).join('');
  const m = d.money;
  const balance = Math.max(0, (Number(m.total) || 0) + (Number(m.deposit) || 0) - (Number(m.prepaid) || 0) - (Number(m.paid) || 0));
  return `<section class="page">
    ${head(L[car ? 'carTitle' : 'bikeTitle'], lang, noBox(lang, d.no, d.date), d)}
    <h2>${lbl('renter', lang)}</h2>
    <div class="grid g3">
      ${field('name', d.renter.name, lang, 's2')}${field('nationality', d.renter.nationality, lang)}
      ${field('passport', d.renter.passport, lang)}${field('license', d.renter.license, lang)}${field('phone', d.renter.phone, lang)}
      ${field('address', d.renter.address, lang, 's3')}
    </div>
    <h2>${lbl(car ? 'carInfo' : 'bikeInfo', lang)}</h2>
    <div class="veh">
      <div class="grid g3">
        ${field('model', d.vehicle.model, lang, 's2')}${field('plate', d.vehicle.plate, lang)}
        ${field('color', d.vehicle.color, lang)}${field('vin', d.vehicle.vin, lang)}${field('mileage', num(d.handover.mileage), lang)}
      </div>
      <div class="fuelbox">${lbl('fuel', lang)}${fuelGauge(d.handover.fuel)}</div>
    </div>
    <div class="two">
      <div><h2>${lbl('equipment', lang)}</h2><ul class="eq">${eq}</ul></div>
      <div><h2>${lbl('agree', lang)}</h2><table class="pen">${pen}</table></div>
    </div>
    <h2>${lbl('rules', lang)}</h2>
    <ul class="rules">${rules}</ul>
    <div class="two">
      <div><h2>${lbl('period', lang)}</h2><div class="grid g2">
        ${field('pickup', d.period.from, lang)}${field('ret', d.period.to, lang)}
        ${field('pickupPlace', d.period.pickupPlace, lang)}${field('returnPlace', d.period.returnPlace, lang)}</div></div>
      <div><h2>${lbl('charges', lang)}</h2><table class="money">
        <tr><td>${lbl('days', lang)}</td><td class="r">${esc(m.days)}</td></tr>
        ${m.base && m.discount ? `<tr><td>${lbl('priceList', lang)}</td><td class="r">${money(m.base)}</td></tr>
        <tr><td><span class="lb">${esc(L.discount[lang])} ${esc(m.discount.percent)}%<small>${esc(L.discount.th)}</small></span></td><td class="r">− ${money(m.discount.off)}</td></tr>` : ''}
        <tr><td>${lbl('perDay', lang)}</td><td class="r">${money(m.perDay)}</td></tr>
        <tr class="em"><td>${lbl('total', lang)}</td><td class="r">${money(m.total)}</td></tr>
        <tr><td>${lbl('deposit', lang)}</td><td class="r">${money(m.deposit)}</td></tr>
        ${m.prepaid ? `<tr><td>${lbl('prepaid', lang)}</td><td class="r">${money(m.prepaid)}</td></tr>` : ''}
        <tr><td>${lbl('paid', lang)}</td><td class="r">${money(m.paid)}</td></tr>
        <tr class="em"><td>${lbl('balance', lang)}</td><td class="r">${money(balance)}</td></tr>
      </table></div>
    </div>
    ${signs(lang, d)}
    ${foot()}
  </section>`;
}

/* ------------------------------------------------- Приложение: фото при выдаче */

function photos(d, lang) {
  const cells = (d.photos || []).map((p, i) => `<figure><div class="ph">${p.src ? `<img src="${p.src}">` : `<span>${i + 1}</span>`}</div>
    <figcaption>${esc(p.caption || '')}${p.at ? ` · ${esc(p.at)}` : ''}</figcaption></figure>`).join('');
  return `<section class="page">
    ${head(L.photosTitle, lang, noBox(lang, d.no, d.date), d)}
    <p class="note">${esc(L.photosNote[lang])}<small>${esc(L.photosNote.th)}</small></p>
    <div class="grid g3 sm">${field('model', d.vehicle.model, lang)}${field('plate', d.vehicle.plate, lang)}${field('mileage', num(d.handover.mileage), lang)}</div>
    <div class="photos">${cells}</div>
    ${signs(lang, d)}
    ${foot()}
  </section>`;
}

/* ------------------------------------------------------------- Акт возврата */

function returnAct(d, lang) {
  const r = d.return;
  // Только то, что выдавали (r.equipment — по тем же местам, что в договоре)
  const eq = d.handover.equipment.map((e, i) => [e, i]).filter(([e]) => e.ok)
    .map(([e, i]) => `<li>${box(r.equipment[i] !== false)}<span>${txt(e, lang)}${r.equipment[i] === false ? ` <b class="bad">${esc(L.missing[lang])}</b>` : ''}</span></li>`).join('');
  const dmg = r.damages.length ? `<ul class="rules one">${r.damages.map((x) => `<li>${txt(x, lang)}${x.thb ? ` — <b>${money(x.thb)}</b>` : ''}</li>`).join('')}</ul>` : `<p>${esc(L.noDamage[lang])}</p>`;
  const ded = r.deductions.map((x) => `<tr><td>${txt(x, lang)}</td><td class="r">${money(x.thb)}</td></tr>`).join('');
  const deducted = r.deductions.reduce((s, x) => s + (Number(x.thb) || 0), 0);
  const deposit = Number(d.money.deposit) || 0;
  return `<section class="page">
    ${head(L.returnTitle, lang, noBox(lang, d.contractNo || d.no, r.date), d)}
    <div class="grid g3">
      ${field('name', d.renter.name, lang, 's2')}${field('phone', d.renter.phone, lang)}
      ${field('model', d.vehicle.model, lang, 's2')}${field('plate', d.vehicle.plate, lang)}
    </div>
    <h2>${lbl('ret', lang)}</h2>
    <table class="cmp">
      <tr><th></th><th>${lbl('planned', lang)}</th><th>${lbl('actual', lang)}</th><th>${lbl('late', lang)}</th></tr>
      <tr><td>${lbl('ret', lang)}</td><td>${esc(d.period.to)}</td><td><b>${esc(r.at)}</b></td><td>${esc(r.late || '—')}</td></tr>
    </table>
    <table class="cmp">
      <tr><th></th><th>${lbl('atPickup', lang)}</th><th>${lbl('atReturn', lang)}</th><th>${lbl('driven', lang)}</th></tr>
      <tr><td>${lbl('mileage', lang)}</td><td>${num(d.handover.mileage)}</td><td><b>${num(r.mileage)}</b></td><td>${r.mileage && d.handover.mileage ? num(r.mileage - d.handover.mileage) : ''}</td></tr>
      <tr><td>${lbl('fuel', lang)}</td><td>${fuelGauge(d.handover.fuel)}</td><td>${fuelGauge(r.fuel)}</td><td></td></tr>
    </table>
    <div class="two">
      <div><h2>${lbl('returned', lang)}</h2><ul class="eq">${eq}</ul></div>
      <div><h2>${lbl('damages', lang)}</h2>${dmg}</div>
    </div>
    <h2>${lbl('deductions', lang)}</h2>
    <table class="money">
      ${ded || `<tr><td colspan="2">${esc(L.noDeductions[lang])}</td></tr>`}
      <tr class="em"><td>${lbl('depositReceived', lang)}</td><td class="r">${money(deposit)}</td></tr>
      <tr><td>${lbl('deducted', lang)}</td><td class="r">${deducted ? `− ${money(deducted)}` : money(0)}</td></tr>
      <tr class="em"><td>${lbl('refund', lang)}</td><td class="r">${money(Math.max(0, deposit - deducted))}</td></tr>
      <tr><td>${lbl('method', lang)}</td><td class="r">${esc(r.refundMethod || '')}</td></tr>
    </table>
    ${signs(lang, d, 'returnAgree')}
    ${foot()}
  </section>`;
}

/* ----------------------------------------------------------------- Квитанция */

function receipt(d, lang) {
  const p = d.receipt;
  const rows = p.items.map((x) => `<tr><td>${txt(x, lang)}</td><td class="r">${num(x.thb)}</td></tr>`).join('');
  const total = p.items.reduce((s, x) => s + (Number(x.thb) || 0), 0);
  const noR = `<div>${lbl('receiptNo', lang)}<b class="big">${esc(d.no)}</b></div><div>${lbl('date', lang)}<b>${esc(d.date)}</b></div>`;
  return `<section class="page">
    ${head(L.receiptTitle, lang, noR, d)}
    <div class="grid g3">
      ${field('receivedFrom', d.renter.name, lang, 's2')}${field('contractNo', d.contractNo, lang)}
      ${field('model', d.vehicle.model, lang)}${field('plate', d.vehicle.plate, lang)}${field('period', `${d.period.from} – ${d.period.to}`, lang)}
    </div>
    <table class="money wide">
      <tr><th>${lbl('forWhat', lang)}</th><th class="r">${lbl('amount', lang)}</th></tr>
      ${rows}
      <tr class="em"><td>${lbl('totalReceived', lang)}</td><td class="r">${money(total)}</td></tr>
      <tr><td>${lbl('paymentMethod', lang)}</td><td class="r">${esc(p.method || '')}</td></tr>
    </table>
    ${p.items.some((x) => x.deposit) ? `<p class="note">${esc(L.depositNote[lang])}<small>${esc(L.depositNote.th)}</small></p>` : ''}
    <div class="signs one">${signBlock(lang, d, 'company', 'receivedBy')}</div>
    ${foot()}
  </section>`;
}

/* ------------------------------------------------------- Дополнение к договору */

function addendum(d, lang) {
  const a = d.addendum;
  const noR = `<div>${lbl('addNo', lang)}<b class="big">${esc(d.no)}</b></div><div>${lbl('toContract', lang)}<b>${esc(d.contractNo)}</b></div>`;
  const ext = a.extension ? `
    <h2>${box(true)} ${lbl('extension', lang)}</h2>
    <div class="grid g3">
      ${field('ret', d.period.to, lang)}${field('newReturn', a.extension.newReturn, lang)}${field('extraDays', a.extension.extraDays, lang)}
      ${field('perDay', money(a.extension.perDay), lang)}${field('extraPrice', money(a.extension.extraPrice), lang)}${field('paid', money(a.extension.paid), lang)}
    </div>` : '';
  const sw = a.swap ? `
    <h2>${box(true)} ${lbl('swap', lang)}</h2>
    <table class="cmp">
      <tr><th></th><th>${lbl('oldVehicle', lang)}</th><th>${lbl('newVehicle', lang)}</th></tr>
      <tr><td>${lbl('model', lang)}</td><td>${esc(d.vehicle.model)}</td><td><b>${esc(a.swap.model)}</b></td></tr>
      <tr><td>${lbl('plate', lang)}</td><td>${esc(d.vehicle.plate)}</td><td><b>${esc(a.swap.plate)}</b></td></tr>
      <tr><td>${lbl('mileage', lang)}</td><td>${num(a.swap.oldMileage)}</td><td>${num(a.swap.newMileage)}</td></tr>
      <tr><td>${lbl('fuel', lang)}</td><td>${fuelGauge(a.swap.oldFuel)}</td><td>${fuelGauge(a.swap.newFuel)}</td></tr>
    </table>
    ${a.swap.reason ? field('reason', a.swap.reason, lang) : ''}` : '';
  return `<section class="page">
    ${head(L.addTitle, lang, noR, d)}
    <div class="grid g3">${field('name', d.renter.name, lang, 's2')}${field('date', d.date, lang)}</div>
    ${ext}${sw}
    <p class="note">${esc(L.otherTerms[lang])}<small>${esc(L.otherTerms.th)}</small></p>
    ${signs(lang, d)}
    ${foot()}
  </section>`;
}

/* ------------------------------------------------------------ Страница целиком */

const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));
let FONT_CSS = '';
let LOGO = '';

function loadAssets() {
  if (FONT_CSS) return;
  const faces = [];
  for (const [family, file, subsets] of [['Noto Sans', 'noto-sans', ['latin', 'latin-ext', 'cyrillic']], ['Sarabun', 'sarabun', ['thai', 'latin']]]) {
    for (const sub of subsets) {
      for (const w of [400, 600, 700]) {
        const p = path.join(ASSETS, 'fonts', `${file}-${sub}-${w}-normal.woff2`);
        if (fs.existsSync(p)) faces.push(`@font-face{font-family:'${family}';font-weight:${w};src:url(data:font/woff2;base64,${fs.readFileSync(p).toString('base64')}) format('woff2');}`);
      }
    }
  }
  FONT_CSS = faces.join('\n');
  try {
    const logo = path.join(config.site.dir, '..', 'staff', 'logo-wordmark.webp');
    LOGO = `data:image/webp;base64,${fs.readFileSync(logo).toString('base64')}`;
  } catch {
    LOGO = '';
  }
}

const RENDER = { contract, photos, return: returnAct, receipt, addendum };

/** Документ → HTML для печати (A4). kind — вид, d — данные, lang — en | ru */
export function renderDocument(kind, d, lang) {
  loadAssets();
  const page = RENDER[kind];
  if (!page) throw new Error(`unknown_document_kind:${kind}`);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(d.no || '')}</title>
<style>${FONT_CSS}${CSS}</style></head><body>${page(d, LANGS.includes(lang) ? lang : 'en')}</body></html>`;
}

const CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Noto Sans', 'Sarabun', sans-serif; color: #111; font-size: 10.5px; line-height: 1.3; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
small { display: block; font-family: 'Sarabun', 'Noto Sans', sans-serif; color: #555; font-size: 9.5px; font-weight: 400; }
.page { width: 210mm; height: 297mm; padding: 8mm 11mm 13mm; position: relative; page-break-after: always; overflow: hidden; display: flex; flex-direction: column; gap: 3px; }
.hd { display: grid; grid-template-columns: 38mm 1fr 52mm; align-items: center; gap: 10px; border-bottom: 2px solid #111; padding-bottom: 6px; }
.logo { width: 36mm; }
.tt { text-align: center; } .tt h1 { margin: 0; font-size: 18px; } .th1 { font-family: 'Sarabun'; font-size: 15px; color: #333; }
.no { display: grid; gap: 4px; justify-items: end; text-align: right; }
.no .lb { font-size: 9px; color: #555; } .no b { display: block; font-size: 12px; } .no .big { font-size: 15px; color: #b85200; }
.wm { position: absolute; top: 120mm; left: 0; right: 0; text-align: center; font-size: 64px; font-weight: 700; color: rgba(184,82,0,.08); transform: rotate(-24deg); }
.wm.wm--draft { font-size: 30px; color: rgba(192, 54, 44, .16); }
h2 { margin: 4px 0 1px; font-size: 11.5px; display: flex; gap: 6px; align-items: center; }
h2 .lb small { display: inline; margin-left: 6px; font-size: 10.5px; }
.lb { font-weight: 600; }
.grid { display: grid; gap: 0; border: 1px solid #111; }
.grid.g3 { grid-template-columns: repeat(3, 1fr); } .grid.g2 { grid-template-columns: repeat(2, 1fr); }
.f { border: .5px solid #999; padding: 2px 6px; min-height: 26px; display: flex; flex-direction: column; justify-content: space-between; }
.f .lb { font-size: 9px; color: #444; font-weight: 600; } .f .lb small { display: inline; margin-left: 4px; font-size: 8.5px; }
.f b { font-size: 11.5px; overflow-wrap: anywhere; } .s2 { grid-column: span 2; } .s3 { grid-column: span 3; }
.veh { display: grid; grid-template-columns: 1fr 34mm; gap: 8px; align-items: stretch; }
.fuelbox { border: 1px solid #111; padding: 2px 6px; text-align: center; } .fuelbox .lb { font-size: 9px; display: block; } .fuelbox .lb small { display: block; }
.fuel { width: 26mm; height: auto; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.eq { list-style: none; margin: 0; padding: 0; border: 1px solid #111; }
.eq li { display: grid; grid-template-columns: 18px 1fr; align-items: center; column-gap: 6px; padding: 2px 6px; border-bottom: .5px solid #999; }
.eq li:last-child { border-bottom: 0; }
.ck { display: inline-flex; width: 14px; height: 14px; border: 1px solid #111; align-items: center; justify-content: center; flex: none; }
.ckm { width: 11px; height: 11px; }
.pen, .money, .cmp { width: 100%; border-collapse: collapse; border: 1px solid #111; }
.pen td, .money td, .money th, .cmp td, .cmp th { border: .5px solid #999; padding: 2px 6px; vertical-align: middle; text-align: left; }
.r { text-align: right !important; white-space: nowrap; font-weight: 600; }
.money .em td { background: #f3f0ea; font-weight: 700; }
.cmp .fuel { width: 20mm; }
.rules { margin: 0; padding-left: 14px; columns: 2; column-gap: 18px; font-size: 9.8px; } .rules.one { columns: 1; }
.rules li { break-inside: avoid; margin-bottom: 2px; } .rules li small { font-size: 8.8px; }
.note { margin: 2px 0; padding: 5px 8px; background: #f3f0ea; border-radius: 4px; }
.agree { margin: 4px 0 0; font-weight: 600; }
.signs { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: auto; padding-top: 4px; }
.signs.one { grid-template-columns: 1fr; width: 60%; margin-left: auto; }
.sg .line { border-bottom: 1px solid #111; height: 30px; position: relative; }
.sg .line img { position: absolute; left: 0; bottom: 1px; height: 34px; max-width: 100%; object-fit: contain; }
.sg .who { font-size: 9.5px; color: #333; }
.ft { position: absolute; left: 11mm; right: 11mm; bottom: 6mm; font-size: 8.5px; color: #555; border-top: .5px solid #999; padding-top: 3px; }
.photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.photos figure { margin: 0; } .ph { height: 52mm; border: 1px solid #999; background: #e9ecef; display: flex; align-items: center; justify-content: center; font-size: 24px; color: #9aa; overflow: hidden; }
.ph img { width: 100%; height: 100%; object-fit: cover; }
figcaption { font-size: 9px; color: #444; padding-top: 2px; }
.bad { color: #c0362c; }
.grid.sm .f { min-height: 24px; }
.money.wide th { background: #f3f0ea; }
`;
