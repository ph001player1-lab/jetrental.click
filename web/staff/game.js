/*
 * ============================================================================
 * Вкладка «Игра» — режим наблюдателя (владелец и админ)
 * ============================================================================
 * Живая картинка того, что происходит в портале: остров, офис, стоянки,
 * сервис, финансы, пляж. Факты — из GET /api/staff/game/state (сотрудники по
 * табелю, техника, заявки, касса, посетители сайта, события); маршруты машин
 * в аренде по острову — условные (GPS нет). Управлять отсюда ничем нельзя.
 * Рисуется на Canvas 2D (пиксели), модуль грузится только при открытии вкладки.
 * Только на русском (как «Маркетинг»).
 * ============================================================================
 */
(function () {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища — не страшно */ } }
};
const reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const money = (n) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ฿`;
const shadeCache = new Map();
function shade(hex, f) {
  const key = hex + '|' + f;
  let v = shadeCache.get(key);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  const c = (s) => clamp(Math.round(((n >> s) & 255) * f), 0, 255);
  v = `rgb(${c(16)},${c(8)},${c(0)})`;
  shadeCache.set(key, v);
  return v;
}

/* ---------- состояние ---------- */
const S = {
  gt: 0,            // время анимаций, секунды
  rt: 0,            // реальное время с открытия, секунды
  sim: 12 * 60,     // часы Пхукета, минуты от полуночи (настоящее время)
  offset: 0,        // поправка часов браузера по серверу, мс
  mode: 'owner',
  zoom: 2, camX: 0, camY: 0,
  intro: null,      // { t, dur }
  introEnd: -10,
  selected: null,
  sound: false,
  safes: { op: 0, dep: 0 },
  quietSince: 0     // когда последний раз были клиенты или гости (реальные мс)
};
const nowMs = () => Date.now() + S.offset;
function phuketMinutes() { const d = new Date(nowMs() + 7 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60; }

/* ---------- изометрия ---------- */
const HW = 16, HH = 8;            // половина плитки 32×16
const MW = 46, MH = 36;           // карта в плитках
const OX = MH * HW + 40, OY = 110;
const WORLD_W = (MW + MH) * HW + 80, WORLD_H = (MW + MH) * HH + 170;
let dropOff = 0;                  // сдвиг вверх для интро (падение плиток и объектов)
const iso = (x, y) => [OX + (x - y) * HW, OY + (x + y) * HH - dropOff];

/* ---------- карта ---------- */
const T = { SEA: 0, SAND: 1, GRASS: 2, ROAD: 3, LOT: 4, WOOD: 5, CARPET: 6, CONC: 7, PAVE: 8, SHALLOW: 9 };
const map = new Uint8Array(MW * MH);
const tAt = (x, y) => (x < 0 || y < 0 || x >= MW || y >= MH ? T.SEA : map[y * MW + x]);
const tSet = (x, y, t) => { if (x >= 0 && y >= 0 && x < MW && y < MH) map[y * MW + x] = t; };
const tFill = (x0, y0, x1, y1, t) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tSet(x, y, t); };
const isWater = (t) => t === T.SEA || t === T.SHALLOW;
(function buildMap() {
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const dx = (x + 0.5 - 20.5) / 19, dy = (y + 0.5 - 17.5) / 16;
    const n = 0.07 * Math.sin(x * 0.9 + y * 0.3) + 0.06 * Math.cos(y * 0.8 - x * 0.2);
    map[y * MW + x] = dx ** 4 + dy ** 4 < 1 - n ? T.GRASS : T.SEA;
  }
  const land = map.slice();
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const i = y * MW + x;
    if (land[i] === T.GRASS) {
      let shore = x >= 31;
      for (let j = -1; j <= 1 && !shore; j++) for (let k = -1; k <= 1; k++) if ((land[(y + j) * MW + x + k] ?? T.SEA) === T.SEA || y + j < 0 || y + j >= MH) shore = true;
      if (shore) map[i] = T.SAND;
    } else {
      let near = false;
      for (let j = -2; j <= 2 && !near; j++) for (let k = -2; k <= 2; k++) {
        const yy = y + j, xx = x + k;
        if (xx >= 0 && yy >= 0 && xx < MW && yy < MH && land[yy * MW + xx] === T.GRASS) near = true;
      }
      if (near) map[i] = T.SHALLOW;
    }
  }
  // кольцевая дорога, выезды «в город», к пляжу, подъезд к стоянкам
  tFill(8, 7, 29, 7, T.ROAD); tFill(8, 27, 29, 27, T.ROAD); tFill(8, 7, 8, 27, T.ROAD); tFill(29, 7, 29, 27, T.ROAD);
  tFill(2, 17, 7, 17, T.ROAD); tFill(20, 2, 20, 6, T.ROAD); tFill(14, 28, 14, 31, T.ROAD); tFill(30, 22, 35, 22, T.ROAD);
  // зоны компании
  tFill(9, 16, 18, 19, T.PAVE); tFill(19, 16, 24, 16, T.PAVE); tFill(17, 20, 18, 26, T.PAVE); tFill(11, 25, 16, 26, T.PAVE);
  tFill(11, 10, 18, 15, T.WOOD); tFill(19, 10, 23, 15, T.CARPET);
  tFill(11, 20, 16, 24, T.CONC);
  tFill(19, 17, 27, 21, T.LOT); tFill(19, 23, 27, 25, T.LOT);
  tFill(17, 22, 28, 22, T.ROAD); tSet(28, 19, T.ROAD);
})();

/* ---------- плитки ---------- */
const TILE = {
  [T.SAND]: { base: '#efd798', dots: ['#e3c57d', '#f7e6b4', '#e8cc88'] },
  [T.GRASS]: { base: '#5fae4b', dots: ['#6cc057', '#4f9a3e', '#78c962'] },
  [T.ROAD]: { base: '#575a61', dots: ['#4f5259', '#60636a'] },
  [T.LOT]: { base: '#686b72', dots: ['#5f6269', '#72757c'] },
  [T.WOOD]: { base: '#c99159', dots: ['#b9804a', '#d49c64'], rows: '#b47c45' },
  [T.CARPET]: { base: '#3d8b6b', dots: ['#46977a', '#357c5f'] },
  [T.CONC]: { base: '#a2a7ad', dots: ['#969ba1', '#adb2b8', '#8d9298'] },
  [T.PAVE]: { base: '#d9c7a4', dots: ['#cdb894', '#e3d3b4'], rows: '#cbb893' },
  [T.SHALLOW]: { base: 'rgba(110,215,220,.30)', dots: ['rgba(190,245,245,.35)'] }
};
const rowW = (r) => (r < 8 ? (r + 1) * 2 : (16 - r) * 2);
function makeTile(spec, seed) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 16;
  const g = c.getContext('2d');
  for (let r = 0; r < 16; r++) {
    const w = rowW(r);
    g.fillStyle = spec.rows && r % 4 === 3 ? spec.rows : spec.base;
    g.fillRect(16 - w, r, w * 2, 1);
  }
  for (let i = 0; i < 12; i++) {
    const r = 1 + Math.floor(hash(seed, i) * 14);
    const w = rowW(r);
    const x = 16 - w + 1 + Math.floor(hash(i + 7, seed) * Math.max(1, w * 2 - 2));
    g.fillStyle = spec.dots[i % spec.dots.length];
    g.fillRect(x, r, 1, 1);
  }
  return c;
}
const tileImg = {};
for (const k of Object.keys(TILE)) tileImg[k] = [0, 1, 2, 3].map((v) => makeTile(TILE[k], Number(k) * 31 + v * 7 + 3));

/* ---------- примитивы ---------- */
let b = null; // контекст буфера пикселей (задаётся в части 3)
function setCtx(g) { b = g; }
function poly(pts, color) {
  b.fillStyle = color;
  b.beginPath();
  b.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) b.lineTo(pts[i][0], pts[i][1]);
  b.closePath();
  b.fill();
}
const up = (p, d) => [p[0], p[1] - d];
function isoBox(x, y, lx, ly, h, top, left, right, z = 0) {
  const c0 = iso(x - lx / 2, y - ly / 2), c1 = iso(x + lx / 2, y - ly / 2), c2 = iso(x + lx / 2, y + ly / 2), c3 = iso(x - lx / 2, y + ly / 2);
  poly([up(c3, z), up(c2, z), up(c2, z + h), up(c3, z + h)], left);
  poly([up(c1, z), up(c2, z), up(c2, z + h), up(c1, z + h)], right);
  poly([up(c0, z + h), up(c1, z + h), up(c2, z + h), up(c3, z + h)], top);
}
function shadowBox(x, y, lx, ly) {
  poly([iso(x - lx / 2, y - ly / 2), iso(x + lx / 2, y - ly / 2), iso(x + lx / 2, y + ly / 2), iso(x - lx / 2, y + ly / 2)], 'rgba(0,0,0,.22)');
}
function pline(g, x0, y0, x1, y1, color) {
  const n = Math.max(1, Math.round(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  g.fillStyle = color;
  for (let i = 0; i <= n; i++) g.fillRect(Math.round(lerp(x0, x1, i / n)), Math.round(lerp(y0, y1, i / n)), 1, 1);
}
function px(x, y, w, h, color) { b.fillStyle = color; b.fillRect(Math.round(x), Math.round(y), w, h); }

/* ---------- неподвижный слой (земля) ---------- */
const stat = document.createElement('canvas');
stat.width = WORLD_W; stat.height = WORLD_H;
function forTiles(fn) {
  for (let s = 0; s <= MW + MH - 2; s++) {
    for (let x = Math.max(0, s - MH + 1); x <= Math.min(MW - 1, s); x++) fn(x, s - x);
  }
}
function drawTile(g, x, y) {
  const t = tAt(x, y);
  if (t === T.SEA) return;
  const [sx, sy] = iso(x, y);
  g.drawImage(tileImg[t][Math.floor(hash(x, y) * 4)], Math.round(sx) - 16, Math.round(sy));
}
function buildStatic() {
  const g = stat.getContext('2d');
  g.clearRect(0, 0, WORLD_W, WORLD_H);
  const keep = dropOff; dropOff = 0;
  forTiles((x, y) => drawTile(g, x, y));
  // разметка дорог: пунктир по середине и тёмная кромка
  forTiles((x, y) => {
    if (tAt(x, y) !== T.ROAD) return;
    const r = (a, c) => tAt(a, c) === T.ROAD;
    const along = r(x - 1, y) || r(x + 1, y), across = r(x, y - 1) || r(x, y + 1);
    if (along && !across) { const a = iso(x + 0.3, y + 0.5), c = iso(x + 0.7, y + 0.5); pline(g, a[0], a[1], c[0], c[1], '#ebe4c8'); }
    if (across && !along) { const a = iso(x + 0.5, y + 0.3), c = iso(x + 0.5, y + 0.7); pline(g, a[0], a[1], c[0], c[1], '#ebe4c8'); }
    const edge = (p1, p2) => pline(g, p1[0], p1[1], p2[0], p2[1], '#45484e');
    if (!r(x, y - 1)) edge(iso(x, y), iso(x + 1, y));
    if (!r(x, y + 1)) edge(iso(x, y + 1), iso(x + 1, y + 1));
    if (!r(x - 1, y)) edge(iso(x, y), iso(x, y + 1));
    if (!r(x + 1, y)) edge(iso(x + 1, y), iso(x + 1, y + 1));
  });
  // разметка стоянок
  const line = (x0, y0, x1, y1) => { const a = iso(x0, y0), c = iso(x1, y1); pline(g, a[0], a[1], c[0], c[1], '#e6e3d6'); };
  for (let i = 0; i <= 7; i++) {
    const sx = 19.55 + i * 1.15 - 0.575;
    line(sx, 17.25, sx, 18.6); line(sx, 20.0, sx, 21.3);
  }
  for (let i = 0; i <= 12; i++) {
    const sx = 19.4 + i * 0.7 - 0.35;
    line(sx, 23.1, sx, 23.95); line(sx, 24.45, sx, 25.35);
  }
  for (const y of [16.1, 16.9, 17.7, 18.5, 19.3]) line(9.3, y, 10.6, y);
  // ковёр в шоуруме, полоса у ворот гаража, буква P
  g.globalAlpha = 0.85;
  const rug = [iso(12.1, 12.1), iso(14.3, 12.1), iso(14.3, 14.9), iso(12.1, 14.9)];
  g.fillStyle = '#b8483a'; g.beginPath(); rug.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fill();
  g.globalAlpha = 1;
  for (let i = 0; i < 10; i++) {
    const a = iso(12 + i * 0.3, 24.85), c = iso(12.15 + i * 0.3, 24.85);
    pline(g, a[0], a[1], c[0], c[1], i % 2 ? '#2b2b2b' : '#f2c230');
  }
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.font = '8px "Press Start 2P", monospace';
  const pp = iso(23.2, 19.4); g.fillText('P', pp[0] - 4, pp[1] + 4);
  dropOff = keep;
}

/* ---------- море: волны и пена ---------- */
const waves = [];
const foam = [];
(function buildSea() {
  let guard = 0;
  while (waves.length < 240 && guard++ < 5000) {
    const x = rnd(-6, MW + 4), y = rnd(-6, MH + 4);
    const t = tAt(Math.floor(x), Math.floor(y));
    if (!isWater(t)) continue;
    const [sx, sy] = iso(x, y);
    waves.push({ x: sx, y: sy, p: rnd(0, 6.28), w: ri(3, 6), s: rnd(0.6, 1.4) });
  }
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    if (!isWater(tAt(x, y))) continue;
    const add = (ax, ay, bx, by) => foam.push({ a: iso(ax, ay), b: iso(bx, by), p: hash(x, y) * 6.28 });
    if (!isWater(tAt(x, y - 1)) && y > 0) add(x, y, x + 1, y);
    if (!isWater(tAt(x, y + 1)) && y < MH - 1) add(x, y + 1, x + 1, y + 1);
    if (!isWater(tAt(x - 1, y)) && x > 0) add(x, y, x, y + 1);
    if (!isWater(tAt(x + 1, y)) && x < MW - 1) add(x + 1, y, x + 1, y + 1);
  }
})();

/* ---------- спрайты ---------- */
const LOOK_SHOES = '#1c1a18';
// Человечек ~16 пикселей: ноги, тело, руки, голова; позы: stand, walk, sit, sad, ride, repair, megaphone, lie, swim
function drawPerson(a, sx, sy) {
  const L = a.look;
  sx = Math.round(sx); sy = Math.round(sy);
  const f = a.face >= 0 ? 1 : -1;
  const pose = a.pose;
  if (pose === 'lie') {
    px(sx - 8, sy - 4, 16, 1, 'rgba(0,0,0,.18)');
    px(sx - 7, sy - 7, 4, 3, L.skin); px(sx - 8, sy - 7, 2, 3, L.hair);
    px(sx - 3, sy - 7, 6, 3, L.shirt); px(sx + 3, sy - 6, 5, 2, L.skin);
    a.hit = [sx - 9, sy - 10, sx + 9, sy]; a.headY = sy - 9;
    return;
  }
  if (pose === 'swim') {
    const bob = Math.round(Math.sin(S.gt * 3 + a.seed) * 1);
    const ring = (Math.sin(S.gt * 2 + a.seed) + 1) / 2;
    b.globalAlpha = 0.35 + ring * 0.4;
    px(sx - 5, sy - 1, 11, 1, '#eafcff'); px(sx - 3, sy, 7, 1, '#eafcff');
    b.globalAlpha = 1;
    px(sx - 2, sy - 5 + bob, 5, 4, L.skin); px(sx - 2, sy - 6 + bob, 5, 2, L.hair);
    if (Math.sin(S.gt * 4 + a.seed) > 0.6) { px(sx - 5, sy - 3, 1, 2, L.skin); px(sx + 5, sy - 3, 1, 2, L.skin); }
    a.hit = [sx - 6, sy - 9, sx + 6, sy + 2]; a.headY = sy - 7;
    return;
  }
  const walking = a.moving;
  const k = walking ? Math.floor(a.step * 3) % 2 : 0;
  const sit = pose === 'sit' || pose === 'sad';
  const ride = pose === 'ride';
  if (!ride) px(sx - 3, sy - 1, 7, 2, 'rgba(0,0,0,.25)');
  let waist;
  if (ride) {
    waist = sy - 2;
    px(sx - 2, waist, 5, 2, L.pants);
  } else if (sit) {
    waist = sy - 4;
    px(sx - 2, waist, 5, 2, L.pants); px(sx - 2, waist + 2, 2, 2, L.pants); px(sx + 1, waist + 2, 2, 2, L.pants);
  } else {
    waist = sy - 5 - (walking && k ? 1 : 0);
    px(sx - 2, waist, 2, 5 - (k ? 1 : 0), L.pants); px(sx + 1, waist, 2, 5 - (k ? 0 : 1), L.pants);
    px(sx - 2, sy - 1 - (k ? 1 : 0), 2, 1, LOOK_SHOES); px(sx + 1, sy - 1 - (k ? 0 : 1), 2, 1, LOOK_SHOES);
  }
  const slump = pose === 'sad' ? 1 : 0;
  px(sx - 3, waist - 6 + slump, 7, 6 - slump, L.shirt);
  let swing = walking ? (k ? 1 : -1) : 0;
  if (pose === 'repair') swing = Math.sin(S.gt * 9 + a.seed) > 0 ? -2 : 0;
  px(sx - 4, waist - 6 + slump, 1, 3, L.shirt); px(sx + 4, waist - 6 + slump, 1, 3, L.shirt);
  px(sx - 4, waist - 3 + slump + swing, 1, 2, L.skin); px(sx + 4, waist - 3 + slump - swing, 1, 2, L.skin);
  const hy = waist - 11 + slump * 2;
  px(sx - 2, hy, 5, 5, L.skin);
  if (a.back) px(sx - 2, hy - 1, 5, 5, L.hair);
  else {
    px(sx - 2, hy - 1, 5, 2, L.hair); px(f > 0 ? sx - 2 : sx + 2, hy, 1, 2, L.hair);
    px(sx + (f > 0 ? 1 : -1), hy + 2 + slump, 1, 1, '#2a1d14');
    if (L.glasses) px(sx - 1, hy + 2, 4, 1, '#30343a');
  }
  if (L.hat) { px(sx - 3, hy - 2, 7, 2, L.hat); px(f > 0 ? sx + 2 : sx - 5, hy - 1, 4, 1, L.hat); }
  const hand = [sx + (f > 0 ? 5 : -7), waist - 4];
  if (pose === 'megaphone' && !walking) {
    const mx = sx + (f > 0 ? 4 : -9), my = hy + 2;
    px(mx, my, 6, 3, '#c9ced6'); px(f > 0 ? mx + 5 : mx - 1, my - 1, 2, 5, '#e8ecf1'); px(f > 0 ? mx - 1 : mx + 5, my + 1, 1, 1, '#3a3f47');
  } else if (a.carry) drawCarry(a.carry, hand[0], hand[1]);
  if (pose === 'repair') { px(sx + (f > 0 ? 5 : -7), waist - 5 + swing, 3, 1, '#bfc5cc'); px(sx + (f > 0 ? 7 : -7), waist - 6 + swing, 1, 3, '#bfc5cc'); }
  a.hit = [sx - 6, hy - 3, sx + 6, sy + 1];
  a.headY = hy - 2;
}
function drawCarry(kind, x, y) {
  if (kind === 'doc') { px(x, y, 3, 4, '#fbfbf6'); px(x + 1, y + 1, 1, 1, '#9aa'); px(x + 1, y + 2, 1, 1, '#9aa'); }
  else if (kind === 'tool') { px(x + 1, y - 1, 1, 5, '#b9c0c8'); px(x, y - 1, 3, 1, '#b9c0c8'); }
  else if (kind === 'bag') { px(x, y, 4, 4, '#a2702f'); px(x + 1, y - 1, 2, 1, '#8a5d25'); px(x + 1, y + 1, 2, 2, '#ffd34d'); }
  else if (kind === 'keys') { px(x, y, 2, 2, '#ffd34d'); px(x + 2, y + 1, 2, 1, '#c9ced6'); }
  else if (kind === 'receipt') { px(x, y, 2, 4, '#ffffff'); }
  else if (kind === 'phone') { px(x, y, 2, 3, '#22252b'); px(x, y, 2, 1, '#7fd3ff'); }
}

function drawVehicle(v) {
  if (v.hidden) return;
  if (v.type === 'car') drawCar(v); else drawBike(v);
  const top = iso(v.x + v.ox, v.y + v.oy);
  const h = v.type === 'car' ? 15 : 13;
  v.hit = [top[0] - 13, top[1] - h - (v.z || 0) - 4, top[0] + 13, top[1] + 4];
  v.headY = top[1] - h - (v.z || 0);
  v.sx = top[0];
}
function lights(v, x, y, lx, ly, z) {
  const ax = v.dir === 'x';
  const front = (v.sgn || 1) > 0;
  b.fillStyle = front ? '#fff3a6' : '#ff5a4f';
  for (const s of [-1, 1]) {
    const p = ax ? iso(x + lx / 2, y + s * ly * 0.3) : iso(x + s * lx * 0.3, y + ly / 2);
    b.fillRect(Math.round(p[0]), Math.round(p[1]) - z - 5, 1, 1);
  }
}
function drawCar(v) {
  const x = v.x + v.ox, y = v.y + v.oy, z = v.z || 0, ax = v.dir === 'x';
  const lx = ax ? 0.95 : 0.5, ly = ax ? 0.5 : 0.95;
  if (!z) shadowBox(x, y, lx + 0.1, ly + 0.1);
  b.fillStyle = '#1b1b1f';
  const wp = ax ? [[x - 0.3, y + ly / 2], [x + 0.3, y + ly / 2], [x + lx / 2, y + 0.15]] : [[x + lx / 2, y - 0.3], [x + lx / 2, y + 0.3], [x + 0.15, y + ly / 2]];
  for (const [wx, wy] of wp) { const p = iso(wx, wy); b.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 3 - z, 3, 3); }
  isoBox(x, y, lx, ly, 5, shade(v.color, 1.04), shade(v.color, 0.82), shade(v.color, 0.66), z + 2);
  const off = 0.09 * (v.sgn || 1);
  const cx = ax ? x - off : x, cy = ax ? y : y - off;
  isoBox(cx, cy, ax ? 0.5 : 0.42, ax ? 0.42 : 0.5, 4, shade(v.color, 1.14), '#7eb3cf', '#5b8fac', z + 7);
  lights(v, x, y, lx, ly, z);
}
function drawBike(v) {
  const x = v.x + v.ox, y = v.y + v.oy, z = v.z || 0, ax = v.dir === 'x';
  const moto = v.type === 'moto';
  const L = moto ? 0.62 : 0.5, Wd = moto ? 0.2 : 0.16;
  const lx = ax ? L : Wd, ly = ax ? Wd : L;
  shadowBox(x, y, lx + 0.06, ly + 0.06);
  b.fillStyle = '#1b1b1f';
  for (const s of [-1, 1]) {
    const p = iso(ax ? x + s * L * 0.42 : x, ax ? y : y + s * L * 0.42);
    b.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 3 - z, 3, 3);
  }
  isoBox(x, y, lx, ly, moto ? 4 : 3, shade(v.color, 1.04), shade(v.color, 0.8), shade(v.color, 0.64), z + 2);
  const so = -0.08 * (v.sgn || 1);
  isoBox(ax ? x + so : x, ax ? y : y + so, ax ? L * 0.45 : Wd, ax ? Wd : L * 0.45, 1, '#2a2a2e', '#222226', '#1a1a1d', z + (moto ? 6 : 5));
  const fo = L * 0.38 * (v.sgn || 1);
  const h = iso(ax ? x + fo : x, ax ? y : y + fo);
  px(h[0], h[1] - 9 - z, 1, 5, '#3a3a40'); px(h[0] - 2, h[1] - 10 - z, 5, 1, '#3a3a40'); px(h[0], h[1] - 7 - z, 1, 1, '#fff6b0');
  if (v.rider) {
    const p = iso(x, y);
    v.rider.pose = 'ride';
    v.rider.face = (ax ? 1 : -1) * (v.sgn || 1);
    v.rider.back = (v.sgn || 1) < 0;
    drawPerson(v.rider, p[0], p[1] - 4 - z);
  }
}
function drawWarn(cx, cy, level) {
  const w = Math.round(Math.abs(Math.cos(S.rt * 3)) * 8) + 1;
  const bob = Math.round(Math.sin(S.rt * 4) * 1.5);
  const col = level === 'error' ? '#ff4d3d' : '#ffc21a';
  for (let r = 0; r < 8; r++) {
    const ww = Math.max(1, Math.round(((r + 1) / 8) * w));
    b.fillStyle = r === 7 ? shade(level === 'error' ? '#ff4d3d' : '#ffc21a', 0.7) : col;
    b.fillRect(Math.round(cx - ww / 2), Math.round(cy - 9 + r + bob), ww, 1);
  }
  if (w > 4) { px(cx - 0.5, cy - 6 + bob, 1, 3, '#2a1a10'); px(cx - 0.5, cy - 2 + bob, 1, 1, '#2a1a10'); }
}
function drawPalm(o) {
  const [sx, sy] = iso(o.x, o.y);
  px(sx - 4, sy - 1, 9, 2, 'rgba(0,0,0,.2)');
  const hgt = o.h || 20;
  for (let i = 0; i < hgt; i++) px(sx + Math.round(Math.sin((i / hgt) * 1.3) * 3 * o.lean), sy - i, 2, 1, i % 3 ? '#8b5a2b' : '#73491f');
  const tx = sx + Math.round(Math.sin(1.3) * 3 * o.lean), ty = sy - hgt;
  const sway = Math.sin(S.rt * 1.3 + o.seed) * 0.12;
  for (let f = 0; f < 6; f++) {
    const a = (f / 6) * Math.PI * 2 + sway + o.seed;
    for (let j = 1; j < 9; j++) {
      const fx = tx + Math.cos(a) * j, fy = ty + Math.sin(a) * j * 0.45 + j * j * 0.07;
      px(fx, fy, 2, 1, j % 2 ? '#3f9b3a' : '#2f7d2c');
    }
  }
  px(tx - 1, ty + 1, 2, 2, '#6b4a1e'); px(tx + 1, ty + 2, 2, 2, '#5c3f19');
}
function drawTree(o) {
  const [sx, sy] = iso(o.x, o.y);
  px(sx - 5, sy - 1, 11, 2, 'rgba(0,0,0,.2)');
  px(sx, sy - 7, 2, 7, '#7a4f26');
  const r = 6;
  for (let y = -r; y <= r; y++) {
    const w = Math.round(Math.sqrt(r * r - y * y) * 1.2);
    px(sx + 1 - w, sy - 13 + y, w * 2, 1, y < -2 ? '#5cb84c' : y < 2 ? '#4aa23c' : '#3c8a31');
  }
}
function drawHouse(o) {
  const { x, y, c, roof } = o;
  shadowBox(x + 0.1, y + 0.1, 1.4, 1.4);
  isoBox(x, y, 1.3, 1.3, 12, c, shade(c, 0.9), shade(c, 0.76));
  const c1 = up(iso(x + 0.65, y - 0.65), 12), c2 = up(iso(x + 0.65, y + 0.65), 12), c3 = up(iso(x - 0.65, y + 0.65), 12);
  const apex = up(iso(x, y), 22);
  poly([c3, c2, apex], shade(roof, 1));
  poly([c1, c2, apex], shade(roof, 0.78));
  const d = iso(x, y + 0.65);
  px(d[0] - 1, d[1] - 6, 3, 5, '#5a3b22');
  const w1 = iso(x + 0.65, y - 0.2);
  px(w1[0] + 1, w1[1] - 9, 3, 3, (S.sim > 18 * 60 + 30 || S.sim < 6 * 60) ? '#ffe28a' : '#8fd0ea');
}
function drawUmbrella(o) {
  const [sx, sy] = iso(o.x, o.y);
  px(sx, sy - 14, 1, 14, '#e8e3d8');
  for (let r = 0; r < 5; r++) {
    const w = 3 + r * 2;
    for (let i = -w; i < w; i++) px(sx + i, sy - 19 + r, 1, 1, Math.floor((i + 20) / 3) % 2 ? o.c : '#fbfbf6');
  }
}
function drawTumble(o) {
  const [sx, sy] = iso(o.x, o.y);
  const bounce = Math.round(Math.abs(Math.sin(o.ph * 2.2)) * 4);
  const a0 = o.ph * 3;
  px(sx - 3, sy - 1, 7, 1, 'rgba(0,0,0,.18)');
  for (let i = 0; i < 14; i++) {
    const a = a0 + (i / 14) * Math.PI * 2;
    const r = 3.5 + (i % 3) * 0.6;
    px(sx + Math.cos(a) * r, sy - 5 - bounce + Math.sin(a) * r * 0.9, 1, 1, i % 2 ? '#a07a3e' : '#7d5c2a');
  }
  px(sx - 1, sy - 6 - bounce, 2, 2, '#8a6a33');
}

/* =====================================================================
 * Мир: стены, дверь, вывески, мебель, гараж, пляж, город, дороги
 * ===================================================================== */

const objs = [];
function addObj(o) { if (o.depth === undefined) o.depth = o.x + o.y; objs.push(o); return o; }

/* ---------- стены (каждый отрезок — свой объект, чтобы правильно перекрывать людей) ---------- */
const OFFICE = { L: '#f1e6cf', R: '#dccbad', cap: '#a8916b' };
const GARAGE_C = { L: '#cdd2d8', R: '#b0b6bd', cap: '#80868d' };
function wall(x0, y0, x1, y1, h, color, cap, depth, extra = {}) {
  return addObj({
    x: (x0 + x1) / 2, y: (y0 + y1) / 2, depth, h, color, cap, ...extra,
    draw(o) {
      const p1 = iso(x0, y0), p2 = iso(x1, y1);
      poly([p1, p2, up(p2, o.h), up(p1, o.h)], o.color);
      poly([up(p1, o.h), up(p2, o.h), up(p2, o.h + 2), up(p1, o.h + 2)], o.cap);
      if (o.window) {
        const night = S.sim > 18 * 60 + 30 || S.sim < 6 * 60;
        const a = [lerp(p1[0], p2[0], 0.22), lerp(p1[1], p2[1], 0.22)], c = [lerp(p1[0], p2[0], 0.78), lerp(p1[1], p2[1], 0.78)];
        poly([up(a, 9), up(c, 9), up(c, o.h - 6), up(a, o.h - 6)], night ? '#ffe08a' : '#9fd3ea');
        poly([up(a, 9), up(c, 9), up(c, 10), up(a, 10)], o.cap);
      }
    }
  });
}
// офис и финансы: задние стены высокие, передние — низкие (разрез, как в «домиках»)
for (let x = 11; x <= 23; x++) wall(x, 10, x + 1, 10, 30, OFFICE.L, OFFICE.cap, x + 10.45, { window: x % 3 === 0 });
for (let y = 10; y <= 15; y++) wall(11, y, 11, y + 1, 30, OFFICE.R, OFFICE.cap, 11 + y + 0.45, { window: y === 12 });
for (let x = 11; x <= 23; x++) if (x !== 16) wall(x, 16, x + 1, 16, 7, OFFICE.L, OFFICE.cap, x + 16.5);
for (let y = 10; y <= 15; y++) wall(24, y, 24, y + 1, 7, OFFICE.R, OFFICE.cap, 24 + y + 0.5);
// гараж
for (let x = 11; x <= 16; x++) wall(x, 20, x + 1, 20, 22, GARAGE_C.L, GARAGE_C.cap, x + 20.45, { window: x === 14 });
for (let y = 20; y <= 24; y++) wall(11, y, 11, y + 1, 22, GARAGE_C.R, GARAGE_C.cap, 11 + y + 0.45);
for (const x of [11, 15, 16]) wall(x, 25, x + 1, 25, 7, GARAGE_C.L, GARAGE_C.cap, x + 25.5);
for (const y of [20, 22, 23, 24]) wall(17, y, 17, y + 1, 7, GARAGE_C.R, GARAGE_C.cap, 17 + y + 0.5);

/* ---------- дверь офиса (стеклянная, раздвижная) ---------- */
const DOOR = { out: [16.5, 16.75], in: [16.5, 15.3], open: 0, hold: 0 };
addObj({
  x: 16.5, y: 16, depth: 32.5,
  draw() {
    const p1 = iso(16, 16), p2 = iso(17, 16), mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    const o = DOOR.open;
    const l2 = [lerp(mid[0], p1[0], o * 0.85), lerp(mid[1], p1[1], o * 0.85)];
    const r1 = [lerp(mid[0], p2[0], o * 0.85), lerp(mid[1], p2[1], o * 0.85)];
    b.globalAlpha = 0.7;
    poly([p1, l2, up(l2, 22), up(p1, 22)], '#a9dcef');
    poly([r1, p2, up(p2, 22), up(r1, 22)], '#a9dcef');
    b.globalAlpha = 1;
    poly([up(p1, 22), up(p2, 22), up(p2, 26), up(p1, 26)], OFFICE.cap);
    px(p1[0], p1[1] - 26, 2, 26, '#8d7a5a'); px(p2[0] - 2, p2[1] - 26, 2, 26, '#8d7a5a');
    px(mid[0] - 6, mid[1] - 34, 13, 6, '#2c3e50'); px(mid[0] - 5, mid[1] - 33, 11, 4, S.sim > 8 * 60 && S.sim < 20 * 60 ? '#4ee07a' : '#c0392b');
  }
});

/* ---------- вывески ---------- */
function sign(x, y, depth, text, bg, fg, h) {
  return addObj({
    x, y, depth,
    draw() {
      const [sx, sy] = iso(x, y);
      b.font = '8px "Press Start 2P", monospace';
      const w = Math.ceil(b.measureText(text).width) + 8;
      px(sx - w / 2 + 2, sy - h + 2, w, 13, 'rgba(0,0,0,.25)');
      px(sx - w / 2, sy - h, w, 13, bg);
      b.fillStyle = fg; b.fillText(text, Math.round(sx - w / 2 + 4), Math.round(sy - h + 10));
      px(sx - w / 2 + 6, sy - h + 13, 1, h - 30 > 0 ? 6 : 4, '#555'); px(sx + w / 2 - 7, sy - h + 13, 1, h - 30 > 0 ? 6 : 4, '#555');
    }
  });
}
sign(17.5, 10, 27.6, 'JET MOBILITY', '#1d2b3a', '#ffd38a', 58);
sign(14, 20, 36.6, 'SERVICE', '#3a2a1d', '#ffb26b', 40);

/* ---------- мебель и предметы ---------- */
function box(x, y, lx, ly, h, c, z = 0, depth) {
  return addObj({ x, y, depth, draw() { isoBox(x, y, lx, ly, h, c, shade(c, 0.84), shade(c, 0.7), z); } });
}
// Столы у задней стены: за столом — место сотрудника, перед ним — стул клиента
const DESK_X = [13.6, 15.4, 17.2];
const DESK_VIA = [12.85, 14.5, 16.3];
const DESKS = {};
function desk(id, x, y) {
  DESKS[id] = { x, y, on: false };
  addObj({
    x, y,
    draw() {
      isoBox(x, y, 0.9, 0.45, 6, '#c58d55', '#a87442', '#8e6136');
      isoBox(x, y - 0.12, 0.34, 0.07, 6, '#2b2f36', '#24282e', '#1d2126', 6);
      const p = iso(x + 0.17, y - 0.12);
      if (DESKS[id].on) px(p[0] - 1, p[1] - 12, 1, 4, Math.sin(S.rt * 7) > -0.3 ? '#8fe1ff' : '#5fb7d6');
      const q2 = iso(x - 0.3, y + 0.05);
      px(q2[0], q2[1] - 8, 3, 2, '#fbfbf6');
    }
  });
}
DESK_X.forEach((x, i) => { desk(`d${i + 1}`, x, 11.3); box(x, 12.15, 0.32, 0.3, 3, '#3e4552'); });
desk('fd', 21.4, 12.3);
box(18.25, 10.45, 0.5, 0.3, 13, '#8a6a46');                         // шкаф с документами
box(19.05, 11.95, 0.2, 3.9, 8, '#efe7d6');                          // стойка финансов
addObj({ x: 11.75, y: 13.6, draw() {                                // диван для клиентов
  isoBox(11.8, 13.6, 0.5, 1.5, 4, '#c0563d', '#a8472f', '#8f3c28');
  isoBox(11.5, 13.6, 0.14, 1.5, 9, '#c0563d', '#a8472f', '#8f3c28');
} });
for (const [x, y] of [[11.45, 10.45], [23.65, 15.45], [11.4, 15.4]]) addObj({ x, y, draw() {
  isoBox(x, y, 0.22, 0.22, 4, '#b5651d', '#9c561a', '#844816');
  const [sx, sy] = iso(x, y);
  for (let i = 0; i < 9; i++) px(sx - 4 + (i % 3) * 3, sy - 12 + Math.floor(i / 3) * 2 - (i % 2), 3, 2, i % 2 ? '#3f9b3a' : '#2f7d2c');
} });
// витрина шоурума (украшение)
const DISPLAY = [
  { type: 'car', color: '#f5f5f2', x: 13.2, y: 13.6, dir: 'y', sgn: 1, ox: 0, oy: 0, z: 0 },
  { type: 'scooter', color: '#2f74c0', x: 15.6, y: 14.5, dir: 'x', sgn: -1, ox: 0, oy: 0, z: 2 }
];
for (const v of DISPLAY) addObj({ x: v.x, y: v.y, draw() {
  if (v.z) isoBox(v.x, v.y, 0.85, 0.6, 2, '#ebe5d6', '#d1cab8', '#bcb4a1');
  drawVehicle(v);
} });

// Финансы: два больших сейфа с монетами и суммой над ними
const SAFES_OBJ = {};
const SAFES = {
  op: { x: 20.0, y: 10.75, title: 'Касса: приход сегодня', note: 'Наличные, полученные сегодня (аренда, доплаты) — из «Финансов».' },
  dep: { x: 22.6, y: 10.75, title: 'Залоговая касса', note: 'Залоги клиентов на руках сейчас — из «Финансов».' }
};
for (const id of ['op', 'dep']) {
  const s = SAFES[id];
  SAFES_OBJ[id] = addObj({
    x: s.x, y: s.y, kind: 'safe', id,
    draw(o) {
      isoBox(s.x, s.y, 0.93, 0.75, 21, '#6b7480', '#5a626d', '#4b525c');
      const f = iso(s.x, s.y + 0.375);
      px(f[0] - 8, f[1] - 18, 16, 12, '#7d8792'); px(f[0] - 2, f[1] - 15, 4, 4, '#e3e7ec'); px(f[0] - 1, f[1] - 14, 2, 2, '#9aa3ad'); px(f[0] + 4, f[1] - 12, 3, 1, '#3a3f45');
      const t = up(iso(s.x, s.y), 21);
      const amount = S.safes[id] || 0;
      const n = amount > 0 ? clamp(Math.round(amount / 8000), 1, 14) : 0;
      for (let i = 0; i < n; i++) {
        px(t[0] - 9, t[1] - 3 - i * 2, 7, 2, i % 2 ? '#d9a92b' : '#f2c94c');
        if (i < n - 3) px(t[0] + 2, t[1] - 2 - i * 2, 7, 2, i % 2 ? '#f2c94c' : '#d9a92b');
      }
      o.hit = [t[0] - 16, t[1] - 8 - 2 * n, t[0] + 16, f[1] + 2];
      o.headY = t[1] - 6 - 2 * n;
      o.sx = t[0];
    }
  });
}
// Кошельки сотрудников: столики с монетами (минус — красная расписка), имя и сумма над каждым
const PEDESTALS = [[23.35, 11.55], [23.35, 12.45], [23.35, 13.35], [23.35, 14.25], [22.55, 11.75], [22.55, 12.65], [22.55, 13.55], [22.55, 14.45]]
  .map(([x, y]) => ({ x, y, w: null, kind: 'wallet' }));
for (const p of PEDESTALS) addObj({ x: p.x, y: p.y, draw() {
  if (!p.w) { p.hit = null; return; }
  isoBox(p.x, p.y, 0.42, 0.34, 7, '#9b7a52', '#84663f', '#6e5534');
  const t = up(iso(p.x, p.y), 7);
  const thb = p.w.thb;
  let top = t[1] - 4;
  if (thb >= 0) {
    const n = clamp(Math.round(thb / 2500), 1, 12);
    for (let i = 0; i < n; i++) px(t[0] - 4, t[1] - 3 - i * 2, 8, 2, i % 2 ? '#d9a92b' : '#f2c94c');
    top = t[1] - 4 - n * 2;
  } else {
    px(t[0] - 4, t[1] - 10, 9, 7, '#fff4f2'); px(t[0] - 3, t[1] - 8, 6, 1, '#e74c3c'); px(t[0] - 3, t[1] - 6, 4, 1, '#e74c3c');
    top = t[1] - 11;
  }
  p.hit = [t[0] - 8, top - 4, t[0] + 8, t[1] + 6];
  p.headY = top; p.sx = t[0];
} });

// Табло посетителей сайта над входом: сколько сейчас на сайте (наведите — откуда)
const COUNTER = { n: 0, sources: [], hit: null };
addObj({
  x: 16.5, y: 16, depth: 32.6,
  draw() {
    const p = iso(16.5, 16);
    const text = String(COUNTER.n);
    b.font = '8px "Press Start 2P", monospace';
    const w = Math.max(30, Math.ceil(b.measureText(text).width) + 20);
    const x0 = Math.round(p[0] - w / 2), y0 = Math.round(p[1] - 48);
    px(x0 + 2, y0 + 2, w, 13, 'rgba(0,0,0,.3)');
    px(x0, y0, w, 13, '#10202e'); px(x0, y0, w, 1, '#3d5a73');
    // человечек
    px(x0 + 4, y0 + 3, 3, 3, '#7dff9b'); px(x0 + 3, y0 + 7, 5, 4, '#7dff9b');
    b.fillStyle = COUNTER.n ? '#7dff9b' : '#4f6b5a';
    b.fillText(text, x0 + 12, y0 + 11);
    px(p[0] - 1, y0 + 13, 2, 6, '#555');
    COUNTER.hit = [x0 - 2, y0 - 2, x0 + w + 2, y0 + 16];
    COUNTER.sx = p[0]; COUNTER.headY = y0;
  }
});

// гараж: подъёмник, стеллаж, шины, ящик
const LIFT = { x: 13.4, y: 21.7, v: null, h: 0, target: 0 };
box(12.75, 21.2, 0.12, 0.12, 20, '#d4a72c'); box(14.05, 21.2, 0.12, 0.12, 20, '#d4a72c');
addObj({ x: LIFT.x, y: LIFT.y - 0.01, draw() { isoBox(LIFT.x, LIFT.y, 1.1, 0.62, 2, '#cfa22a', '#b38b22', '#99761c', LIFT.h); } });
addObj({ x: 11.25, y: 21.6, draw() {
  isoBox(11.25, 21.6, 0.15, 1.6, 16, '#7c5a3a', '#6a4c31', '#5a4029');
  const p = iso(11.33, 21.2);
  const cols = ['#e74c3c', '#3498db', '#f1c40f', '#bdc3c7', '#2ecc71'];
  for (let i = 0; i < 5; i++) px(p[0] + i * 3, p[1] - 12 + i, 2, 4, cols[i]);
} });
box(16.3, 24.45, 0.35, 0.35, 6, '#262629'); box(16.3, 24.45, 0.35, 0.35, 3, '#38383c', 6);
box(16.25, 20.6, 0.4, 0.25, 5, '#c0392b');
// гаражные ворота: балка над проёмом
addObj({ x: 13.5, y: 25, depth: 38.6, draw() {
  const p1 = iso(12, 25), p2 = iso(15, 25);
  poly([up(p1, 18), up(p2, 18), up(p2, 22), up(p1, 22)], GARAGE_C.cap);
  px(p1[0], p1[1] - 22, 2, 22, '#80868d'); px(p2[0] - 2, p2[1] - 22, 2, 22, '#80868d');
} });
// будка выдачи, табличка маркетолога
addObj({ x: 28.25, y: 17.2, draw() {
  isoBox(28.25, 17.2, 0.7, 0.45, 9, '#f4efe4', '#ddd6c6', '#c7c0b0');
  isoBox(28.25, 17.2, 0.9, 0.62, 2, '#e74c3c', '#c0392b', '#a93226', 12);
} });
sign(28.6, 20.0, 48.4, 'RENT FROM 250', '#fffdf5', '#c0392b', 22);
// пляж: зонтики и шезлонги
const BEACH = [];
for (const [x, y, c] of [[33.6, 11.2, '#e74c3c'], [34.0, 14.6, '#2e86de'], [33.6, 18.2, '#f39c12'], [35.2, 25.4, '#16a085']]) {
  addObj({ x, y, draw() { drawUmbrella({ x, y, c }); } });
  box(x - 0.6, y + 0.4, 0.75, 0.3, 2, '#f3efe6');
  BEACH.push({ p: [x - 0.6, y + 0.35], kind: 'lie', who: null });
}
for (const p of [[40.4, 12.6], [40.9, 16.6], [40.5, 20.6]]) BEACH.push({ p, kind: 'swim', who: null });

/* ---------- город и природа ---------- */
(function decor() {
  const roadNear = (x, y, r) => { for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) if (tAt(Math.floor(x) + k, Math.floor(y) + j) === T.ROAD) return true; return false; };
  const inside = (x, y) => x > 7.5 && x < 30.5 && y > 6.5 && y < 28.5;
  const ROOF = ['#c0392b', '#d35400', '#16a085', '#2c3e50', '#8e44ad'];
  const WALLS = ['#f6f1e7', '#fdebd0', '#e8f6f3', '#fef9e7', '#f2f3f4'];
  let i = 0;
  for (let y = 2; y < 33; y += 2) for (let x = 2; x < 31; x += 2) {
    const jx = x + hash(x, y) * 1.2, jy = y + hash(y, x) * 1.2;
    const t = tAt(Math.floor(jx), Math.floor(jy));
    if (inside(jx, jy) || roadNear(jx, jy, 1) || t !== T.GRASS) continue;
    const r = hash(x * 3, y * 5);
    if (r < 0.45 && (x < 7 || y < 6)) addObj({ x: jx, y: jy, c: WALLS[i % 5], roof: ROOF[i++ % 5], draw: drawHouse });
    else if (r < 0.75) addObj({ x: jx, y: jy, draw: drawTree });
    else addObj({ x: jx, y: jy, h: 16 + Math.floor(r * 10), lean: r > 0.85 ? -1 : 1, seed: r * 9, draw: drawPalm });
  }
  for (const [x, y] of [[25.5, 11.5], [26.8, 13.6], [25.6, 15.3], [9.8, 23.4], [9.6, 25.8], [27.8, 25.9], [31.4, 9.5], [31.7, 13.0], [31.5, 16.8], [32.0, 26.5], [36.5, 9.8], [36.8, 24.8]]) {
    addObj({ x, y, h: 17 + Math.floor(hash(x * 7, y) * 8), lean: hash(y, x) > 0.5 ? 1 : -1, seed: x, draw: drawPalm });
  }
})();

/* ---------- дороги: граф ---------- */
const RN = {
  A: [8.5, 7.5], N: [20.5, 7.5], B: [29.5, 7.5], R1: [29.5, 19.25], E: [29.5, 22.5], C: [29.5, 27.5], S: [14.5, 27.5],
  D: [8.5, 27.5], Wn: [8.5, 17.5], WX: [2.3, 17.5], NX: [20.5, 2.3], SX: [14.5, 31.6], BX: [35.2, 22.5], DW: [18.6, 22.5]
};
const RE = {
  A: ['N', 'Wn'], N: ['A', 'B', 'NX'], B: ['N', 'R1'], R1: ['B', 'E'], E: ['R1', 'C', 'DW', 'BX'], C: ['E', 'S'],
  S: ['C', 'D', 'SX'], D: ['S', 'Wn'], Wn: ['D', 'A', 'WX'], WX: ['Wn'], NX: ['N'], SX: ['S'], BX: ['E'], DW: ['E']
};
const ENDS = ['WX', 'NX', 'SX'];
function bfs(graph, from, to) {
  if (from === to) return [from];
  const prev = { [from]: null }, q = [from];
  while (q.length) {
    const n = q.shift();
    for (const m of graph[n]) if (!(m in prev)) { prev[m] = n; if (m === to) { const out = [m]; let c = n; while (c) { out.unshift(c); c = prev[c]; } return out; } q.push(m); }
  }
  return [from];
}
// пешеходные точки снаружи
const WN = {
  DO: [16.5, 16.75], CW: [10.3, 17.7], CE: [17.8, 17.0], GS: [17.75, 21.3], DWW: [17.8, 22.5], LT: [23.5, 22.5],
  GT: [28.6, 22.5], MK: [28.15, 21.25], BKm: [28.4, 19.8], BK: [28.2, 17.85], RX: [30.4, 22.5], BE: [32.2, 22.5],
  GAS: [17.6, 25.7], GA: [13.5, 25.8], LW: [18.5, 19.25], LE: [27.9, 19.25]
};
const WE = {
  DO: ['CW', 'CE'], CW: ['DO'], CE: ['DO', 'GS', 'LW'], GS: ['CE', 'DWW', 'LW'], DWW: ['GS', 'LT', 'GAS'], LT: ['DWW', 'GT'],
  GT: ['LT', 'MK', 'BKm', 'RX'], MK: ['GT'], BKm: ['GT', 'BK', 'LE'], BK: ['BKm'], RX: ['GT', 'BE'], BE: ['RX'], GAS: ['DWW', 'GA'], GA: ['GAS'],
  LW: ['CE', 'GS', 'LE'], LE: ['LW', 'BKm']
};
const zoneOf = (p) => (p[0] >= 11 && p[0] < 24 && p[1] >= 10 && p[1] < 16 ? 'office'
  : p[0] >= 11 && p[0] < 17 && p[1] >= 20 && p[1] < 25 ? 'garage'
    : p[0] >= 30.8 ? 'beach' : 'out');
function nearestWN(p) {
  let best = 'DO', bd = Infinity;
  for (const [k, q] of Object.entries(WN)) { const d = dist(p, q); if (d < bd) { bd = d; best = k; } }
  return best;
}

function deskGap(x) {
  let best = DESK_VIA[0];
  for (const v of [...DESK_VIA, 17.95]) if (Math.abs(v - x) < Math.abs(best - x)) best = v;
  return best;
}
// Внутри офиса ходим через проход (y = 12.65), а не сквозь столы и стойку
function officeToAisle(p) {
  const pts = [];
  if (p[0] > 18.9) { if (p[1] < 12.9) pts.push([20.5, p[1] < 12.0 ? 11.75 : 13.05]); pts.push([19.8, 14.75], [18.6, 15.1]); }
  else if (p[1] < 11.15) { const x = deskGap(p[0]); pts.push([x, 10.95], [x, 12.65]); }
  else if (p[1] < 12.4) pts.push([p[0] + 0.6 > 18.4 ? p[0] - 0.6 : p[0] + 0.6, 12.65]);
  return pts;
}
function officeOut(from) { return [...officeToAisle(from), DOOR.in.slice(), DOOR.out.slice()]; }
function officeIn(to, via) { return [DOOR.in.slice(), ...officeToAisle(to).reverse(), ...(via ? [via.slice()] : []), to.slice()]; }

function walkRoute(from, to, via) {
  const zf = zoneOf(from), zt = zoneOf(to);
  if (zf === zt && zf !== 'out') {
    const inner = zf === 'office' ? [...officeToAisle(from), ...officeToAisle(to).reverse()] : [];
    return [...inner, ...(via ? [via.slice()] : []), to.slice()];
  }
  const pts = [];
  let start;
  if (zf === 'office') { pts.push(...officeOut(from)); start = 'DO'; }
  else if (zf === 'garage') { pts.push([16.4, 21.3], WN.GS.slice()); start = 'GS'; }
  else if (zf === 'beach') { pts.push(WN.BE.slice()); start = 'BE'; }
  else start = nearestWN(from);
  let end, tail;
  if (zt === 'office') { end = 'DO'; tail = officeIn(to, via); }
  else if (zt === 'garage') { end = 'GS'; tail = [[16.4, 21.3], ...(via ? [via.slice()] : []), to.slice()]; }
  else if (zt === 'beach') { end = 'BE'; tail = [to.slice()]; }
  else { end = nearestWN(to); tail = [to.slice()]; }
  const mid = bfs(WE, start, end).map((n) => WN[n].slice());
  if (zf === 'out' && mid.length && dist(from, mid[0]) < 0.2) mid.shift();
  return [...pts, ...mid, ...tail];
}

/* ---------- техника ---------- */
// Стоянки: два ряда машин, два ряда байков; что не влезло — у дороги за кольцом
const SLOTS = { car: [], bike: [] };
for (let i = 0; i < 7; i++) { SLOTS.car.push({ x: 19.55 + i * 1.15, y: 17.9, row: 'A', v: null }); SLOTS.car.push({ x: 19.55 + i * 1.15, y: 20.6, row: 'B', v: null }); }
for (let i = 0; i < 12; i++) { SLOTS.bike.push({ x: 19.4 + i * 0.7, y: 23.5, row: 'S', v: null }); SLOTS.bike.push({ x: 19.4 + i * 0.7, y: 24.9, row: 'S', v: null }); }
for (let i = 0; i < 10; i++) SLOTS.car.push({ x: 30.45, y: 8.7 + i * 1.1, row: 'O', v: null });
for (let i = 0; i < 6; i++) SLOTS.bike.push({ x: 30.45, y: 23.5 + i * 0.6, row: 'Q', v: null, dir: 'x' });
// Сервис: подъёмник и места ожидания (в гараже и перед ним)
const GWAIT = [{ x: 15.7, y: 21.0, dir: 'y' }, { x: 15.7, y: 23.5, dir: 'y' }, { x: 12.1, y: 23.9, dir: 'x' }, { x: 11.8, y: 25.9, dir: 'x' }, { x: 15.6, y: 25.9, dir: 'x' }]
  .map((g) => ({ ...g, v: null }));
const STAFFPARK = [[9.95, 16.5], [9.95, 17.3], [9.95, 18.1], [9.95, 18.9], [9.95, 19.7], [10.75, 19.7], [10.75, 16.5], [10.75, 17.3], [10.75, 18.1], [10.75, 18.9]]
  .map((p) => ({ x: p[0], y: p[1], v: null }));
const VEH = [];
const VEH_BY_ID = new Map();
const COLOR_WORDS = [[/бел|white/i, '#ecebe6'], [/ч[её]рн|black/i, '#2b2d31'], [/красн|red/i, '#c0392b'], [/син|голуб|blue/i, '#2f6db5'],
  [/сер|grey|gray|silver|сталь/i, '#9aa3ad'], [/зел|green/i, '#3c8d2f'], [/ж[её]лт|yellow/i, '#f1c40f'], [/оранж|orange/i, '#e67e22'],
  [/розов|pink/i, '#f4a6b7'], [/корич|brown|беж|beige/i, '#8a5a2b'], [/бирюз|teal|turq|мят|mint/i, '#16a085'], [/фиол|purple|violet/i, '#8e44ad']];
const PALETTE = ['#ecebe6', '#c0392b', '#9aa3ad', '#2f6db5', '#3b3f45', '#d7263d', '#1f4e8c', '#7ac2b0', '#f4a6b7', '#2d2d2d', '#8a5a2b'];
function colorOf(c) {
  for (const [re, hex] of COLOR_WORDS) if (re.test(c.color || '')) return hex;
  return PALETTE[Math.floor(hash(Number(c.id) * 7 || 1, 3) * PALETTE.length)];
}
const SPEED = { car: 1.9, moto: 2.1, scooter: 1.6 };
function newVehicle(c) {
  const v = {
    id: c.id, model: c.model || 'Техника', type: c.type, color: colorOf(c), plate: c.plate || '',
    x: RN.E[0], y: RN.E[1], ox: 0, oy: 0, dir: 'y', sgn: 1, z: 0, path: [], cb: null, node: null, prev: null,
    speed: SPEED[c.type] || 1.6, status: c.status, slot: null, gspot: null, err: null,
    cruise: false, away: 0, park: 0, hidden: false, rider: null, claim: false, data: c
  };
  VEH.push(v); VEH_BY_ID.set(c.id, v);
  return v;
}
function removeVehicle(v) {
  leaveSlot(v); leaveGarage(v);
  const i = VEH.indexOf(v); if (i >= 0) VEH.splice(i, 1);
  VEH_BY_ID.delete(v.id);
}
const slotsFor = (v) => (v.type === 'car' ? SLOTS.car : SLOTS.bike);
const freeSlot = (v) => slotsFor(v).find((s) => !s.v) || null;
function parkAt(v, s) { v.slot = s; s.v = v; v.x = s.x; v.y = s.y; v.dir = s.dir || 'y'; v.sgn = 1; v.ox = 0; v.oy = 0; v.path = []; v.hidden = false; v.cruise = false; }
function leaveSlot(v) { if (v.slot) { v.slot.v = null; v.slot = null; } }
function leaveGarage(v) {
  if (v.gspot) { v.gspot.v = null; v.gspot = null; }
  if (LIFT.v === v) { LIFT.v = null; LIFT.target = 0; }
}
function setCruise(v, from, to) {
  v.cruise = true; v.prev = from; v.node = to; v.path = [RN[to].slice()]; v.cb = () => cruiseNext(v);
}
function cruiseNext(v) {
  const n = v.node;
  if (!v.cruise) return;
  if (ENDS.includes(n)) { v.hidden = true; v.away = S.gt + rnd(8, 25); return; }
  if (n === 'BX' && !v.beachDone) { v.beachDone = true; v.park = S.gt + rnd(5, 14); return; }
  v.beachDone = false;
  const opts = RE[n].filter((m) => m !== v.prev && m !== 'DW');
  const next = pick(opts.length ? opts : RE[n]);
  v.prev = n; v.node = next; v.path = [RN[next].slice()]; v.cb = () => cruiseNext(v);
}
// Машина в аренде «катается» по острову (маршрут условный)
function startCruise(v, randomPlace) {
  leaveSlot(v); leaveGarage(v);
  v.hidden = false; v.away = 0; v.park = 0; v.z = 0;
  if (randomPlace) {
    const edges = [['A', 'N'], ['N', 'B'], ['B', 'R1'], ['R1', 'E'], ['E', 'C'], ['C', 'S'], ['S', 'D'], ['D', 'Wn'], ['Wn', 'A'], ['E', 'BX'], ['Wn', 'WX'], ['N', 'NX'], ['S', 'SX']];
    const [a, c] = pick(edges);
    const t = Math.random();
    v.x = lerp(RN[a][0], RN[c][0], t); v.y = lerp(RN[a][1], RN[c][1], t);
    if (Math.random() < 0.3) { v.cruise = true; v.hidden = true; v.away = S.gt + rnd(2, 20); v.node = c; v.prev = a; v.path = []; return; }
    setCruise(v, a, c);
  } else setCruise(v, v.prev || 'DW', v.node || 'E');
}
// перехватить технику у «катания по острову»: fn вызовется, когда она доедет до узла дороги
function takeControl(v, fn) {
  v.cruise = false;
  if (v.hidden) { v.hidden = false; v.away = 0; const e = pick(ENDS); v.x = RN[e][0]; v.y = RN[e][1]; v.node = e; v.prev = e; v.path = []; v.cb = null; fn(); return; }
  if (v.park) { v.park = 0; fn(); return; }
  if (v.path.length && v.node) { v.cb = fn; return; }
  if (!v.node) { v.node = 'E'; v.x = RN.E[0]; v.y = RN.E[1]; }
  fn();
}
function routeToSlot(v, s) {
  if (s.row === 'A') return [...bfs(RE, v.node, 'R1').slice(1).map((n) => RN[n].slice()), [s.x, 19.25], [s.x, s.y]];
  if (s.row === 'O') return [...bfs(RE, v.node, 'R1').slice(1).map((n) => RN[n].slice()), [29.5, s.y], [s.x, s.y]];
  if (s.row === 'Q') return [...bfs(RE, v.node, 'E').slice(1).map((n) => RN[n].slice()), [29.5, s.y], [s.x, s.y]];
  return [...bfs(RE, v.node, 'E').slice(1).map((n) => RN[n].slice()), [s.x, 22.5], [s.x, s.y]];
}
function routeFromSlot(v) {
  const s = v.slot;
  if (s && s.row === 'A') { v.node = 'R1'; v.prev = Math.random() < 0.5 ? 'E' : 'B'; return [[s.x, 19.25], [28.6, 19.25], RN.R1.slice()]; }
  if (s && s.row === 'O') { v.node = 'R1'; v.prev = 'B'; return [[29.5, s.y], RN.R1.slice()]; }
  if (s && s.row === 'Q') { v.node = 'C'; v.prev = 'E'; return [[29.5, s.y], RN.C.slice()]; }
  v.node = 'E'; v.prev = 'DW';
  return [[v.x, 22.5], RN.E.slice()];
}
function routeFromGarage(v) {
  const pts = LIFT.v === v ? [[LIFT.x, 23.3]] : v.gspot && v.gspot.y < 25 ? [[v.x, Math.min(v.y + 0.6, 24.6)]] : [];
  v.node = 'S'; v.prev = 'SX';
  return [...pts, [13.5, 25.3], [14.5, 26.4], RN.S.slice()];
}
function routeToGarage(v, spot) {
  const nodes = bfs(RE, v.node, 'S').slice(1).map((n) => RN[n].slice());
  if (spot.y > 25) return [...nodes, [14.5, 26.4], [spot.x, 26.4], [spot.x, spot.y]];
  return [...nodes, [14.5, 26.2], [13.5, 25.3], [spot.x, Math.min(spot.y + 0.6, 24.6)], [spot.x, spot.y]];
}
function nearPoint(v) {
  const s = v.slot;
  if (s && s.row === 'O') return [s.x + 0.6, s.y + 0.3];
  if (s && s.row === 'Q') return [s.x + 0.5, s.y + 0.25];
  if (v.type === 'car') return [v.x + 0.6, v.y < 19 ? 18.85 : 19.95];
  return [v.x + 0.35, v.y < 24 ? 22.9 : 24.2];
}
// Сразу поставить технику туда, где она по статусу (первая загрузка, большие изменения)
function placeVehicle(v) {
  v.claim = false; v.rider = null; v.path = []; v.cb = null; v.cruise = false; v.hidden = false; v.park = 0; v.away = 0; v.z = 0; v.sparks = false;
  if (v.status === 'rent') { startCruise(v, true); return; }
  if (v.status === 'service') {
    leaveSlot(v);
    if (v.gspot || LIFT.v === v) return;
    const g = GWAIT.find((x) => !x.v);
    if (g) { g.v = v; v.gspot = g; v.x = g.x; v.y = g.y; v.dir = g.dir; return; }
    v.hidden = true; return;
  }
  leaveGarage(v);
  if (v.slot) { v.x = v.slot.x; v.y = v.slot.y; return; }
  const s = freeSlot(v);
  if (s) parkAt(v, s); else v.hidden = true;
}

/* ---------- люди ---------- */
const PEOPLE = [];
let pid = 0;
function newPerson(o) {
  const a = {
    id: ++pid, kind: 'staff', name: '', g: 'm', look: null, x: 0, y: 0, path: [], speed: 1.25, speedMul: 1,
    face: 1, back: false, pose: 'stand', moving: false, step: 0, seed: rnd(0, 6), carry: null, bubble: null,
    tasks: [], present: false, hidden: false, busy: null, wanted: false, lastAct: 0, wallet: 0, state: 'off', ...o
  };
  PEOPLE.push(a);
  return a;
}

/* ---------- сотрудники: вид, места, скутеры ---------- */
const STAFF = new Map(); // id сотрудника в портале → персонаж
const ROLE_SHIRT = { manager: '#2f6fd0', owner: '#c9a227', finance: '#2e9a6a', service: '#e57a1e', marketing: '#8e44ad', delivery: '#17a2a2' };
const ROLE_RU = { manager: 'менеджер', owner: 'владелец', finance: 'финансист', service: 'сервис', marketing: 'маркетинг', delivery: 'выдача и приём' };
const ROLE_ICON = { manager: '🧑‍💼', owner: '👑', finance: '🧮', service: '🔧', marketing: '📣', delivery: '🔑' };
const SKINS = ['#e0ac7e', '#c68a5e', '#f1c9a5', '#efc29a', '#b97a52', '#f3c7a1', '#8d5a3b'];
const HAIRS = ['#1b1410', '#0e0b09', '#7a4a22', '#c9a15a', '#3b2a1a', '#16100c', '#5a3a1a'];
const BIKES = ['#f2c14e', '#27ae60', '#e84393', '#e67e22', '#9b59b6', '#16a085', '#c0392b', '#2980b9'];
const staffList = () => [...STAFF.values()];
function lookFor(s) {
  const h = (k) => Math.floor(hash(Number(s.id) * 13 + k, 7) * 1000);
  const shirt = ROLE_SHIRT[s.role] || ROLE_SHIRT.manager;
  return { skin: SKINS[h(1) % SKINS.length], hair: HAIRS[h(2) % HAIRS.length], shirt, pants: s.role === 'service' ? shirt : '#2b2f3a', hat: s.role === 'service' ? '#2b3a55' : null, glasses: s.role === 'finance' };
}
function assignHomes() {
  const groups = {};
  for (const a of staffList().sort((p, q) => p.sid - q.sid)) (groups[a.role === 'owner' ? 'manager' : a.role] ||= []).push(a);
  (groups.manager || []).forEach((a, i) => {
    if (i < DESK_X.length) { const x = DESK_X[i]; a.home = { p: [x, 10.8], via: [deskGap(x), 10.95], pose: 'sit', face: i % 2 ? -1 : 1, desk: `d${i + 1}`, client: [x, 12.2] }; }
    else { const x = 14.4 + (i - 3) * 1.2; a.home = { p: [x, 13.75], pose: 'stand', face: 1, client: [x + 0.4, 14.3] }; }
  });
  (groups.finance || []).forEach((a, i) => {
    a.home = i === 0 ? { p: [21.4, 11.75], via: [20.5, 11.75], pose: 'sit', face: 1, desk: 'fd', client: [21.4, 13.05] } : { p: [20.0 + i * 0.5, 13.9], pose: 'stand', face: 1, client: [20.0 + i * 0.5, 14.4] };
  });
  (groups.service || []).forEach((a, i) => { a.home = { p: i === 0 ? [12.55, 22.45] : [14.7, 24.0 - i * 0.55], pose: 'stand', face: 1 }; });
  (groups.marketing || []).forEach((a, i) => { a.home = { p: [28.15 - i * 0.45, 21.25 + i * 0.35], pose: 'megaphone', face: 1 }; });
  (groups.delivery || []).forEach((a, i) => { a.home = { p: [28.2 - i * 0.6, 17.85 + i * 0.3], pose: 'stand', face: -1 }; });
}
function staffBike(a, slot) {
  const v = { id: `bike${a.sid}`, model: `скутер: ${a.name}`, type: 'scooter', color: BIKES[a.sid % BIKES.length], plate: '', x: slot.x, y: slot.y, ox: 0, oy: 0,
    dir: 'x', sgn: 1, z: 0, path: [], cb: null, node: null, prev: null, speed: 1.9, status: 'staff', staffOf: a, slot: null, pslot: slot, hidden: false, rider: null };
  slot.v = v; VEH.push(v);
  return v;
}
function dropStaffBike(a) {
  const v = VEH.find((x) => x.staffOf === a);
  if (!v) return;
  if (v.pslot) v.pslot.v = null;
  VEH.splice(VEH.indexOf(v), 1);
}
function placeStaff(a) {
  if (a.present) {
    a.state = 'work'; a.hidden = false; a.x = a.home.p[0]; a.y = a.home.p[1]; a.pose = a.home.pose; a.face = a.home.face; a.path = [];
    if (!VEH.some((x) => x.staffOf === a)) { const slot = STAFFPARK.find((s) => !s.v); if (slot) staffBike(a, slot); }
  } else { a.state = 'off'; a.hidden = true; a.path = []; dropStaffBike(a); if (a.home.desk) DESKS[a.home.desk].on = false; }
}

/* ---------- лента, пузыри, эффекты ---------- */
const FEED = [];
const clockStr = (m = S.sim) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const timeOf = (iso) => { const d = new Date(Date.parse(iso) + 7 * 3600000); return Number.isFinite(d.getTime()) ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : clockStr(); };
function feed(text, src, icon, at) {
  const item = { time: at ? timeOf(at) : clockStr(), text, src, icon };
  FEED.unshift(item);
  if (FEED.length > 80) FEED.pop();
  feedAdd(item);
}
function bubble(a, text, sec = 2.6) { if (a) a.bubble = { text, until: S.rt + sec }; }
const FX = [], FLY = [], FLOAT = [];
function anchor(e, lift = 16) {
  if (e.hit) return [(e.hit[0] + e.hit[2]) / 2, (e.headY ?? e.hit[1]) + 2];
  const p = iso(e.x, e.y); return [p[0], p[1] - lift];
}
function flyCoins(from, to, n, onEnd) {
  for (let i = 0; i < n; i++) FLY.push({ kind: 'coin', a: from, b: to, t: -i * 0.07, dur: 0.85, h: 22, onEnd: i === n - 1 ? onEnd : null });
  sound('coin');
}
function flyIcon(icon, from, to, onEnd, dur = 1.6) { FLY.push({ kind: 'icon', icon, a: from, b: to, t: 0, dur, h: 40, onEnd }); }
function floatText(at, text, color) { FLOAT.push({ at, text, color, t: 0, dur: 2.2 }); }
function burst(p, colors, n = 14, spread = 1.4) {
  for (let i = 0; i < (reduced ? n / 3 : n); i++) FX.push({ x: p[0], y: p[1], vx: rnd(-30, 30) * spread, vy: rnd(-60, -15) * spread, life: 0, max: rnd(0.4, 0.8), c: pick(colors), g: 140 });
}
const doorPoint = () => { const p = iso(DOOR.out[0], DOOR.out[1]); return [p[0], p[1] - 12]; };

/* ---------- сценарии ---------- */
const RUN = [], QUEUE = [];
function play(name, need, make) { QUEUE.push({ name, need: [...new Set(need.filter(Boolean))], make }); }
function tryStart() {
  for (let i = 0; i < QUEUE.length; i++) {
    const q = QUEUE[i];
    if (q.need.every((a) => !a.busy)) {
      QUEUE.splice(i--, 1);
      const sc = { name: q.name, actors: q.need, gen: q.make(), wait: null };
      q.need.forEach((a) => { a.busy = sc; a.wanted = false; });
      RUN.push(sc);
    } else q.need.forEach((a) => { if (a.busy && a.busy.name === 'rest') a.wanted = true; });
  }
}
function stepScenarios() {
  for (let i = 0; i < RUN.length; i++) {
    const sc = RUN[i];
    for (let guard = 0; guard < 10; guard++) {
      if (sc.wait && !sc.wait()) break;
      let r;
      try { r = sc.gen.next(); } catch (e) { console.warn('scenario', sc.name, e); r = { done: true }; }
      if (r.done) { sc.actors.forEach((a) => { if (a.busy === sc) a.busy = null; }); RUN.splice(i--, 1); break; }
      sc.wait = r.value || null;
    }
  }
}
const wait = (sec) => { const end = S.gt + sec; return () => S.gt >= end; };
const walk = (a, pts, mul = 1) => { a.path = pts.map((p) => p.slice()); a.speedMul = mul; return () => !a.path.length; };
const drive = (v, pts) => { v.cb = null; v.path = pts.map((p) => p.slice()); return () => !v.path.length; };
const both = (...ws) => () => ws.every((w) => w());
const flag = () => { const f = { done: false }; f.wait = () => f.done; return f; };

const present = (a) => a && a.present && a.state !== 'leaving' && a.state !== 'off';
const managers = () => staffList().filter((a) => (a.role === 'manager' || a.role === 'owner') && present(a));
function freeManager(prefer) {
  if (prefer && (prefer.role === 'manager' || prefer.role === 'owner') && present(prefer)) return prefer;
  const ms = managers();
  if (!ms.length) return null;
  return ms.slice().sort((p, q) => (p.busy ? 1 : 0) - (q.busy ? 1 : 0) || p.tasks.length - q.tasks.length)[0];
}
function freeHelper() {
  return staffList().find((a) => a.role === 'delivery' && present(a) && a.state === 'work' && !a.busy && !queued(a)) || null;
}
const queued = (a) => QUEUE.some((q) => q.need.includes(a));
const CLIENT_LOOKS = [
  { skin: '#f1c9a5', hair: '#d9b25a', shirt: '#f39c12', pants: '#3b6ea5' }, { skin: '#e0ac7e', hair: '#1b1410', shirt: '#ffffff', pants: '#2c3e50' },
  { skin: '#c68a5e', hair: '#2d1d12', shirt: '#e84393', pants: '#34495e' }, { skin: '#f5d0b0', hair: '#8b4b23', shirt: '#00b894', pants: '#dfe6e9' },
  { skin: '#8d5a3b', hair: '#111111', shirt: '#fdcb6e', pants: '#2d3436' }, { skin: '#f3c7a1', hair: '#e8e1c4', shirt: '#74b9ff', pants: '#636e72' }
];
const ENTRY = [31.5, 22.6];
function newClient(extra = {}) {
  return newPerson({ kind: 'client', name: 'Клиент', look: pick(CLIENT_LOOKS), speed: 1.15, present: true, x: ENTRY[0], y: ENTRY[1], ...extra });
}
function removePerson(a) { a.gone = true; const i = PEOPLE.indexOf(a); if (i >= 0) PEOPLE.splice(i, 1); }
const SHOWROOM = [[13.0, 12.6], [14.3, 14.3], [15.2, 13.3], [12.5, 12.2], [16.6, 13.8], [12.4, 14.9]];

/* --- приход и уход (отметки в группе WhatsApp, как табель) --- */
function* arrive(a) {
  a.present = true; a.state = 'arriving'; a.hidden = true;
  const slot = STAFFPARK.find((s) => !s.v) || STAFFPARK[0];
  dropStaffBike(a);
  const v = staffBike(a, slot);
  const end = pick(ENDS);
  v.x = RN[end][0]; v.y = RN[end][1]; v.node = end; v.rider = a;
  const nodes = bfs(RE, end, 'Wn').slice(1).map((n) => RN[n].slice());
  yield drive(v, [...nodes, [9.3, 17.5], [9.6, slot.y], [slot.x, slot.y]]);
  v.rider = null; v.dir = 'x'; v.sgn = 1;
  a.hidden = false; a.x = slot.x + 0.55; a.y = slot.y + 0.2; a.pose = 'stand';
  bubble(a, '👋');
  yield wait(0.6);
  if (a.role === 'service') {
    yield walk(a, walkRoute([a.x, a.y], [11.75, 21.3]));
    bubble(a, '🔧'); a.carry = 'tool'; yield wait(0.8);
  } else {
    yield walk(a, walkRoute([a.x, a.y], DOOR.out));
    a.back = true; bubble(a, '🚪', 1.2); DOOR.hold = S.gt + 1.6; sound('ding');
    yield wait(0.9);
    yield walk(a, [DOOR.in, [17.95, 11.2]]);
    a.back = true; yield wait(0.7);
    if (a.role === 'marketing') { bubble(a, '📣'); a.pose = 'megaphone'; } else a.carry = 'doc';
  }
  yield walk(a, walkRoute([a.x, a.y], a.home.p, a.home.via));
  a.carry = null; a.pose = a.home.pose; a.face = a.home.face; a.back = false;
  a.state = 'work';
  feed(`${a.name} на рабочем месте`, 'анимация прихода', '💼');
}
function* leave(a) {
  a.state = 'leaving';
  if (a.home.desk) DESKS[a.home.desk].on = false;
  bubble(a, '👋');
  const v = VEH.find((x) => x.staffOf === a);
  if (v) {
    yield walk(a, walkRoute([a.x, a.y], [v.x + 0.55, v.y + 0.2]));
    a.hidden = true; v.rider = a; if (v.pslot) v.pslot.v = null;
    const end = pick(ENDS);
    yield drive(v, [[9.3, 17.5], ...bfs(RE, 'Wn', end).map((n) => RN[n].slice())]);
    VEH.splice(VEH.indexOf(v), 1);
  }
  a.hidden = true; a.state = a.present ? 'off' : 'off';
}
/* --- отдых: 30 минут без действий — санук, на пляж (очередь задач видна над головой) --- */
const BEACH_SPOTS = () => BEACH;
function* rest(a) {
  a.state = 'rest';
  const spots = BEACH.filter((s) => !s.who);
  const spot = spots.length ? pick(spots) : BEACH[0];
  spot.who = a;
  if (a.home.desk) DESKS[a.home.desk].on = false;
  a.pose = 'stand';
  yield walk(a, walkRoute([a.x, a.y], spot.p));
  a.pose = spot.kind === 'swim' ? 'swim' : 'lie';
  if (spot.kind === 'swim') sound('splash');
  yield () => a.wanted || !a.present;
  spot.who = null;
  a.pose = 'stand';
  if (!a.present) return;
  bubble(a, '🏃', 1.5);
  yield walk(a, walkRoute([a.x, a.y], a.home.p, a.home.via), 2.2);
  a.pose = a.home.pose; a.face = a.home.face; a.state = 'work';
}

/* --- выдача: клиент смотрит технику, договор за столом, ключи у стоянки, уезжает --- */
function* visit(c) {
  S.quietSince = nowMs();
  for (let i = 0; i < 2; i++) {
    yield walk(c, walkRoute([c.x, c.y], pick(SHOWROOM)));
    bubble(c, pick(['🤔', '😍', '📸', '🛵?'])); yield wait(rnd(1.2, 2.2));
  }
}
function* issueDesk(m, v, c, who) {
  yield walk(c, walkRoute([c.x, c.y], m.home.client));
  c.pose = 'sit'; c.back = true; c.face = 1;
  bubble(m, '🙂'); bubble(c, v.type === 'car' ? '🚗?' : '🛵?');
  yield wait(1.4);
  bubble(m, '✍️'); m.carry = 'doc'; yield wait(1.6);
  const p = iso(m.home.client[0], m.home.client[1] - 0.6);
  burst([p[0], p[1] - 10], ['#ffd34d', '#ffffff', '#4ee07a'], 18);
  floatText([p[0], p[1] - 16], '✓ договор', '#7dff9b');
  sound('stamp');
  m.carry = null; m.pose = 'sit';
  yield wait(1);
  c.pose = 'stand'; c.back = false;
}
function* issueScene(v, who) {
  v.claim = true;
  const c = newClient({ name: v.data?.client || 'Клиент' });
  yield* visit(c);
  const m = freeManager(who);
  if (m) {
    const done = flag();
    play('issueDesk', [m], function* () { yield* issueDesk(m, v, c, who); done.done = true; });
    yield done.wait;
  }
  const helper = freeHelper();
  const near = nearPoint(v);
  if (helper && v.slot) {
    const got = flag();
    play('keys', [helper], function* () {
      yield walk(helper, walkRoute([helper.x, helper.y], [near[0] + 0.35, near[1] + 0.2]));
      bubble(helper, '🔑'); helper.carry = 'keys'; yield wait(1); helper.carry = null; got.done = true;
    });
    yield walk(c, walkRoute([c.x, c.y], near));
    yield got.wait;
  } else if (v.slot) yield walk(c, walkRoute([c.x, c.y], near));
  else yield walk(c, walkRoute([c.x, c.y], WN.GT));
  c.carry = 'keys'; bubble(c, '😎'); yield wait(0.6);
  c.hidden = true; c.carry = null;
  if (v.type !== 'car') v.rider = c;
  let pts;
  if (v.slot) { pts = routeFromSlot(v); leaveSlot(v); }
  else if (v.gspot || LIFT.v === v) { pts = routeFromGarage(v); leaveGarage(v); }
  else { v.hidden = false; v.x = RN.DW[0]; v.y = RN.DW[1]; v.node = 'E'; v.prev = 'DW'; pts = [RN.E.slice()]; }
  v.z = 0;
  yield drive(v, pts);
  v.claim = false;
  if (v.status === 'rent') startCruise(v, false); else placeVehicle(v);
  removePerson(c);
}
/* --- возврат: техника заезжает, осмотр, акт за столом, залог из сейфа клиенту --- */
function* returnScene(v, who) {
  v.claim = true;
  const ready = flag();
  takeControl(v, () => { ready.done = true; });
  yield ready.wait;
  const s = v.slot || freeSlot(v);
  if (!s) { v.claim = false; placeVehicle(v); return; }
  s.v = v; v.slot = s;
  yield drive(v, routeToSlot(v, s));
  v.dir = s.dir || 'y'; v.ox = 0; v.oy = 0; v.cruise = false;
  const np = nearPoint(v);
  const c = newClient({ name: v.data?.client || 'Клиент', x: np[0], y: np[1] });
  if (v.rider) { c.look = v.rider.look; v.rider = null; }
  bubble(c, '🙋', 3);
  const helper = freeHelper();
  if (helper) {
    const seen = flag();
    play('inspect', [helper], function* () {
      yield walk(helper, walkRoute([helper.x, helper.y], [np[0] + 0.3, np[1]]));
      bubble(helper, '🔍', 2); yield wait(1.5); bubble(helper, '👍'); seen.done = true;
    });
    yield seen.wait;
  }
  const m = freeManager(who);
  if (m) {
    const done = flag();
    play('returnDesk', [m], function* () {
      yield walk(c, walkRoute([c.x, c.y], m.home.client));
      c.pose = 'sit'; c.back = true;
      bubble(m, '✍️'); m.carry = 'doc'; yield wait(1.6);
      const p = iso(m.home.client[0], m.home.client[1] - 0.6);
      burst([p[0], p[1] - 10], ['#ffd34d', '#ffffff', '#7fd3ff'], 14); sound('stamp');
      floatText([p[0], p[1] - 16], '✓ акт', '#7fd3ff');
      flyCoins(anchor(SAFES_OBJ.dep, 0), anchor(c, 10), 5);
      m.carry = null; m.pose = 'sit';
      yield wait(1);
      done.done = true;
    });
    yield done.wait;
  }
  c.pose = 'stand'; c.back = false; bubble(c, '🙏');
  v.claim = false;
  if (v.status !== 'free' && v.status !== 'reserve') placeVehicle(v);
  yield walk(c, walkRoute([c.x, c.y], WN.GT));
  yield walk(c, [ENTRY]);
  removePerson(c);
}
/* --- сервис: техника едет в гараж; на подъёмнике — искры, пока статус «в ремонте» --- */
function* serviceIn(v) {
  v.claim = true;
  const spot = GWAIT.find((g) => !g.v);
  if (!spot) { v.claim = false; placeVehicle(v); return; }
  spot.v = v; v.gspot = spot;
  if (v.slot) { const pts = routeFromSlot(v); leaveSlot(v); yield drive(v, pts); }
  else { const ready = flag(); takeControl(v, () => { ready.done = true; }); yield ready.wait; }
  v.cruise = false;
  if (v.rider) v.rider = null;
  yield drive(v, routeToGarage(v, spot));
  v.dir = spot.dir; v.ox = 0; v.oy = 0; v.claim = false;
}
function* serviceOut(v) {
  v.claim = true; v.sparks = false;
  if (LIFT.v === v) { LIFT.target = 0; yield () => LIFT.h < 0.4; }
  const pts = routeFromGarage(v);
  leaveGarage(v);
  yield drive(v, pts);
  v.claim = false;
  if (v.status === 'rent') { startCruise(v, false); return; }
  const s = freeSlot(v);
  if (!s) { placeVehicle(v); return; }
  s.v = v; v.slot = s;
  yield drive(v, routeToSlot(v, s));
  v.dir = s.dir || 'y'; v.ox = 0; v.oy = 0;
}
function* toLift(v) {
  v.claim = true;
  yield drive(v, [[v.x, Math.min(v.y + 0.5, 24.5)], [LIFT.x + 0.4, 23.2], [LIFT.x, LIFT.y]]);
  if (v.gspot) { v.gspot.v = null; v.gspot = null; }
  LIFT.v = v; LIFT.target = 6; v.dir = 'x'; v.ox = 0; v.oy = 0; v.claim = false;
}

/* --- гости: посетители сайта гуляют по шоуруму; заявка — садятся к менеджеру; пишут боту — телефон --- */
const GUESTS = [];
const GUEST_SPOTS = [[13.0, 12.6], [14.3, 14.3], [15.2, 13.3], [12.5, 12.2], [16.6, 13.8], [11.95, 13.2], [12.4, 14.9], [21.0, 18.85], [24.0, 19.95], [22.5, 22.9], [25.5, 24.2], [26.2, 22.9]];
function spawnGuest(source) {
  const g = newPerson({ kind: 'guest', name: 'Гость', source: source || '', look: pick(CLIENT_LOOKS), present: true, x: ENTRY[0], y: ENTRY[1], speed: rnd(0.95, 1.3) });
  GUESTS.push(g);
  play('guest', [g], () => guestLife(g));
  return g;
}
function* guestLife(g) {
  while (!g.gone) {
    if (g.job) { const job = g.job; g.job = null; yield* job(); continue; }
    if (g.leaving) break;
    const w = walk(g, walkRoute([g.x, g.y], pick(GUEST_SPOTS)));
    yield () => g.gone || g.job || g.leaving || w();
    if (g.gone) return;
    if (g.job || g.leaving) continue;
    if (Math.random() < 0.35) bubble(g, pick(['🤔', '😍', '📸', '🛵?', '🚗?']));
    const t = wait(rnd(2.5, 6));
    yield () => g.gone || g.job || g.leaving || t();
  }
  if (g.gone) return;
  const w2 = walk(g, walkRoute([g.x, g.y], WN.GT));
  yield () => g.gone || w2();
  yield walk(g, [ENTRY]);
  const i = GUESTS.indexOf(g); if (i >= 0) GUESTS.splice(i, 1);
  removePerson(g);
}
// Заявка с сайта: гость подходит к менеджеру и садится — «оставил заявку»
function guestRequest(m) {
  const g = GUESTS.find((x) => !x.job && !x.leaving) || spawnGuest('');
  g.job = function* () {
    const target = m ? m.home.client : [16.5, 13.2];
    yield walk(g, walkRoute([g.x, g.y], target));
    if (m) { g.pose = 'sit'; g.back = true; }
    bubble(g, '📝 заявка', 3); if (m) bubble(m, '❗', 2);
    yield wait(3.2);
    g.pose = 'stand'; g.back = false;
  };
}
// Посетитель пишет боту: достаёт телефон, пузырь «💬»
function guestChat(channel) {
  const g = GUESTS.length ? pick(GUESTS) : null;
  const icon = /tele|tg/i.test(channel) ? '✈️ Telegram' : '💬 WhatsApp';
  if (!g || g.job) return;
  g.job = function* () {
    g.carry = 'phone'; bubble(g, icon, 3);
    yield wait(3);
    g.carry = null;
  };
}

/* =====================================================================
 * Связь с порталом, обновление мира, отрисовка, панель, карточки
 * ===================================================================== */
let root = null, stage = null, cv = null, ctx = null;
const buf = document.createElement('canvas');
setCtx(buf.getContext('2d'));
let cssW = 800, cssH = 600, DPR = 1, running = false, started = false;

/* ---------- звук (выключен, пока не нажали 🔊) ---------- */
let AC = null;
function sound(kind) {
  if (!S.sound || !AC) return;
  const P = { coin: [988, 1480, 'square', 0.1], ding: [1046, 784, 'triangle', 0.3], stamp: [160, 70, 'square', 0.14], blip: [660, 990, 'square', 0.07], splash: [420, 120, 'sawtooth', 0.2] }[kind] || [440, 440, 'square', 0.1];
  const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
  o.type = P[2]; o.frequency.setValueAtTime(P[0], t); o.frequency.exponentialRampToValueAtTime(P[1], t + P[3]);
  g.gain.setValueAtTime(0.045, t); g.gain.exponentialRampToValueAtTime(0.0001, t + P[3] + 0.05);
  o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + P[3] + 0.07);
}
const LATER = [];
function later(sec, fn) { LATER.push({ at: S.gt + sec, fn }); }

/* ---------- данные портала → мир ---------- */
const KIND_RU = { booking: 'бронь', issue: 'выдача', return: 'возврат', pickup_task: 'забрать технику', change_task: 'замена', changed: 'замена', reschedule: 'перенос', extension: 'продление', payment: 'оплата', service: 'сервис' };
const STATUS_RU = { rent: 'в аренде', free: 'свободна', reserve: 'бронь', service: 'в ремонте' };
const STATUS_ACT = { rent: 'Выдача', free: 'Возврат', reserve: 'Бронь', service: 'В ремонт' };
const CH_RU = { site: 'с сайта', web: 'с сайта', telegram: 'из Telegram', tg: 'из Telegram', whatsapp: 'из WhatsApp', wa: 'из WhatsApp', wabot: 'из WhatsApp', agent: 'от агента', partner: 'от партнёра' };
const CH_ICON = { site: '✉️', web: '✉️', telegram: '✈️', tg: '✈️', whatsapp: '💬', wa: '💬', wabot: '💬', agent: '🤝', partner: '🤝' };
const DOC_RU = { contract: 'договор', act: 'акт', addendum: 'дополнение', receipt: 'квитанция' };
const PAY_RU = { cash: 'наличные', transfer: 'перевод', card: 'карта' };
const CAT_RU = { fuel: 'топливо', repair: 'ремонт', wash: 'мойка', delivery: 'доставка, такси', office: 'офис', insurance: 'страховка', tax: 'налоги', ads: 'реклама',
  it: 'IT', salary: 'зарплата', owners: 'выплата владельцу', refunds: 'возврат', vehicles: 'покупка техники', personal: 'личные', other: 'прочее',
  rent: 'аренда', extras: 'доп. услуги', deposit: 'залог', damage: 'ущерб' };
const TYPE_RU = { car: 'Автомобиль', scooter: 'Скутер', moto: 'Мотоцикл' };
const TYPE_ICON = { car: '🚗', scooter: '🛵', moto: '🏍' };
const plateKey = (p) => String(p || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const recentWho = new Map();   // госномер → { staffId, name }
const SEEN = new Set();
const chatSeen = new Map();
let REQ = [];
const reqSeen = new Set();
const reqTaken = new Set();
let cursor = null, lastSync = 0, firstSync = true, siteInfo = { online: 0, sources: [] }, chatInfo = { active: 0, byChannel: {} }, finInfo = null, carsData = [];
let syncError = null;

function eventText(e) {
  const who = e.who ? ` · ${e.who}` : '';
  if (e.type === 'status') {
    const v = [...VEH_BY_ID.values()].find((x) => plateKey(x.plate) === plateKey(e.plate));
    return [`${STATUS_ACT[e.status] || e.status}: ${v ? v.model : ''} (${e.plate})${who}`, 'Парк: статус', { rent: '🔑', free: '↩️', reserve: '🔖', service: '🔧' }[e.status] || '🚗'];
  }
  if (e.type === 'shift_start') return [`${e.who || 'Сотрудник'}: отметка «на месте»`, 'группа WhatsApp → табель', '📲'];
  if (e.type === 'shift_end') return [`${e.who || 'Сотрудник'}: отметка «ушёл»`, 'группа WhatsApp → табель', '🏁'];
  if (e.type === 'group') return [`Группа: ${KIND_RU[e.kind] || e.kind}${e.plates.length ? ` ${e.plates.join(', ')}` : ''}${who}`, 'рабочая группа WhatsApp', '📲'];
  if (e.type === 'doc') return [`${DOC_RU[e.kind] || 'Документ'}${e.number ? ` №${e.number}` : ''}${who}`, 'Документы', '✍️'];
  if (e.type === 'money') return [`${e.dir === 'out' ? 'Выдали' : 'Приход'} ${money(e.thb)}${e.method ? ` (${PAY_RU[e.method] || e.method})` : ''}${who}`, 'Финансы · «＋ Операция»', e.dir === 'out' ? '💵' : '💰'];
  if (e.type === 'expense') return [`Расход ${money(e.thb)}${e.category ? ` — ${CAT_RU[e.category] || e.category}` : ''}${who}`, 'Финансы · чек', '🧾'];
  if (e.type === 'request') return [`Новая заявка ${CH_RU[e.channel] || e.channel}${e.what ? `: ${e.what}` : ''}`, 'Заявки', CH_ICON[e.channel] || '📨'];
  if (e.type === 'request_taken') return [`Заявку взяли в работу${who}`, 'Заявки', '✅'];
  if (e.type === 'chat') return [`Клиент пишет боту ${/tele|tg/i.test(e.channel) ? 'в Telegram' : 'в WhatsApp'}`, 'клиентский бот', '💬'];
  return [e.type, '', '•'];
}
function playEvent(e) {
  const a = e.staffId ? STAFF.get(e.staffId) : null;
  const here = a && a.present && !a.hidden;
  if (e.type === 'doc' && here) {
    bubble(a, '✍️');
    const p = anchor(a, 10);
    burst([p[0], p[1] + 4], ['#ffd34d', '#ffffff', '#4ee07a'], 12);
    floatText([p[0], p[1] - 4], `✓ ${DOC_RU[e.kind] || 'документ'}`, '#7dff9b');
    sound('stamp');
  } else if (e.type === 'money') {
    const safe = /deposit|залог/i.test(e.kind || '') ? SAFES_OBJ.dep : SAFES_OBJ.op;
    const who = here ? anchor(a, 8) : doorPoint();
    if (e.dir === 'out') flyCoins(anchor(safe, 0), who, 5); else flyCoins(who, anchor(safe, 0), 5);
    floatText(e.dir === 'out' ? anchor(safe, 0) : who, `${e.dir === 'out' ? '−' : '+'}${money(e.thb)}`, e.dir === 'out' ? '#ff8a80' : '#7dff9b');
  } else if (e.type === 'expense') {
    const from = here ? anchor(a, 8) : doorPoint();
    const fin = staffList().find((x) => x.role === 'finance' && x.present && !x.hidden);
    flyIcon('🧾', from, fin ? anchor(fin, 8) : anchor(SAFES_OBJ.op, 0), null, 1.4);
    floatText(from, `−${money(e.thb)}`, '#ff8a80');
    if (here) bubble(a, '📸');
  } else if (e.type === 'request_taken' && here) {
    bubble(a, '✅ взял заявку', 2.6);
  } else if (e.type === 'group' && here) {
    bubble(a, '📲', 2);
  } else if (e.type === 'chat') {
    guestChat(e.channel);
  }
}
function transition(v, from, to, who) {
  if (to === 'service') { play('svcIn', [], () => serviceIn(v)); return; }
  if (from === 'service') { play('svcOut', [], () => serviceOut(v)); return; }
  if (to === 'rent' && v.slot) { play('issue', [], () => issueScene(v, who)); return; }
  if (from === 'rent' && (to === 'free' || to === 'reserve')) { play('return', [], () => returnScene(v, who)); return; }
  placeVehicle(v);
}
function applyState(st) {
  S.offset = Date.parse(st.now) - Date.now();
  const gap = lastSync && Date.now() - lastSync > 120000;
  const silent = firstSync || gap;
  lastSync = Date.now();
  cursor = st.cursor;
  // 1) события: лента и «кто это сделал»
  const fresh = (st.events || []).filter((e) => !SEEN.has(e.id));
  for (const e of fresh) {
    SEEN.add(e.id);
    if (e.type === 'chat') {
      const last = chatSeen.get(e.key) || 0;
      chatSeen.set(e.key, Date.parse(e.at));
      if (Date.parse(e.at) - last < 10 * 60000) { if (!silent) playEvent(e); continue; }
    }
    if ((e.type === 'status' || e.type === 'group') && e.staffId) for (const p of e.plates || [e.plate]) recentWho.set(plateKey(p), e.staffId);
    const [text, src, icon] = eventText(e);
    feed(text, src, icon, e.at);
    if (!silent) playEvent(e);
  }
  // 2) сотрудники (на смене — по табелю группы)
  const ids = new Set();
  let homesDirty = false;
  for (const s of st.staff || []) {
    ids.add(s.id);
    let a = STAFF.get(s.id);
    if (!a) {
      a = newPerson({ kind: 'staff', sid: s.id, name: s.name, role: s.role, look: lookFor(s), present: false, state: 'off', hidden: true, fresh: true });
      STAFF.set(s.id, a); homesDirty = true;
    }
    if (a.role !== s.role) { a.role = s.role; a.look = lookFor(s); homesDirty = true; }
    a.name = s.name; a.roleName = s.roleName; a.since = s.since; a.left = s.left; a.wallet = s.wallet;
    const la = s.lastAction ? Date.parse(s.lastAction) : null;
    if (a.state === 'rest' && la && la > (a.restAt || 0)) a.wanted = true;
    a.lastAction = la;
    a.onShift = s.present;
  }
  for (const [id, a] of STAFF) if (!ids.has(id)) { removePerson(a); dropStaffBike(a); STAFF.delete(id); homesDirty = true; }
  if (homesDirty) assignHomes();
  for (const a of staffList()) {
    if (silent || a.fresh) { a.fresh = false; if (!a.busy) { a.present = a.onShift; placeStaff(a); } continue; }
    if (a.onShift && a.state === 'off' && !a.busy && !queued(a)) { a.state = 'queued'; play('arrive', [a], () => arrive(a)); }
    else if (!a.onShift && ['work', 'rest'].includes(a.state)) {
      if (a.state === 'rest') a.wanted = true;
      play('leave', [a], function* () { yield* leave(a); a.present = false; dropStaffBike(a); });
    }
  }
  // 3) техника
  carsData = st.cars || [];
  const carIds = new Set();
  for (const c of carsData) {
    carIds.add(c.id);
    let v = VEH_BY_ID.get(c.id);
    if (!v) { v = newVehicle(c); placeVehicle(v); continue; }
    v.data = c; v.model = c.model || v.model; v.plate = c.plate || v.plate;
    v.err = c.overdue ? { level: 'error', text: 'Срок аренды прошёл — возврат не отмечен' } : c.needsRepair ? { level: 'warning', text: 'Нужен ремонт' } : null;
    if (v.status === c.status) continue;
    const old = v.status;
    v.status = c.status;
    if (silent) { if (!v.claim) placeVehicle(v); continue; }
    if (v.claim) continue;
    const whoId = recentWho.get(plateKey(c.plate));
    transition(v, old, c.status, whoId ? STAFF.get(whoId) : null);
  }
  for (const v of [...VEH_BY_ID.values()]) if (!carIds.has(v.id)) removeVehicle(v);
  // 4) заявки: новые — письмо к менеджеру; с сайта — гость садится к менеджеру
  REQ = (st.requests || []).filter((r) => r.status === 'new');
  for (const r of st.requests || []) {
    if (r.status === 'new' && !reqSeen.has(r.id)) {
      reqSeen.add(r.id);
      if (!silent) {
        const m = freeManager();
        const icon = CH_ICON[r.channel] || '📨';
        flyIcon(icon, [S.camX + 30 / S.zoom, S.camY + 30 / S.zoom], () => (m ? anchor(m, 2) : doorPoint()), () => { if (m) bubble(m, '❗', 1.4); sound('blip'); });
        if (/site|web/.test(r.channel)) guestRequest(m);
        const mk = staffList().find((x) => x.role === 'marketing' && x.present && !x.hidden && !x.busy);
        if (mk) bubble(mk, '🎉', 1.6);
      }
    }
    if (r.status === 'taken') reqTaken.add(r.id);
  }
  // 5) деньги: суммы над сейфами и кошельками, монеты при изменении
  if (st.finance) {
    const was = { ...S.safes };
    S.safes = { op: st.finance.cashToday || 0, dep: st.finance.depositsHeld || 0 };
    if (!silent && finInfo) {
      for (const id of ['op', 'dep']) {
        const d = S.safes[id] - was[id];
        if (Math.abs(d) >= 1) { if (d > 0) flyCoins(doorPoint(), anchor(SAFES_OBJ[id], 0), 5); else flyCoins(anchor(SAFES_OBJ[id], 0), doorPoint(), 4); floatText(anchor(SAFES_OBJ[id], 0), `${d > 0 ? '+' : '−'}${money(Math.abs(d))}`, d > 0 ? '#7dff9b' : '#ff8a80'); }
      }
    }
    const wallets = st.finance.wallets.slice().sort((p, q) => Math.abs(q.thb) - Math.abs(p.thb)).slice(0, PEDESTALS.length);
    const old = new Map(PEDESTALS.filter((p) => p.w).map((p) => [p.w.name, p.w.thb]));
    PEDESTALS.forEach((p, i) => { p.w = wallets[i] || null; });
    if (!silent && finInfo) for (const w of wallets) {
      const before = old.get(w.name);
      const p = PEDESTALS.find((x) => x.w === w);
      if (before !== undefined && before !== w.thb && p) {
        const a = w.staffId ? STAFF.get(w.staffId) : null;
        const from = a && a.present && !a.hidden ? anchor(a, 8) : doorPoint();
        if (w.thb > before) flyCoins(from, anchor(p, 0), 4); else flyCoins(anchor(p, 0), from, 3);
      }
    }
    finInfo = st.finance;
  }
  // 6) сайт и боты: гости в шоуруме = посетители сайта сейчас
  siteInfo = st.site || siteInfo;
  chatInfo = st.chats || chatInfo;
  COUNTER.n = siteInfo.online; COUNTER.sources = siteInfo.sources || [];
  syncGuests();
  firstSync = false;
  syncError = null;
}
function syncGuests() {
  const target = Math.min(24, siteInfo.online || 0);
  const live = GUESTS.filter((g) => !g.leaving && !g.gone);
  const labels = [];
  for (const s of siteInfo.sources || []) for (let i = 0; i < s.n; i++) labels.push(s.name);
  if (live.length < target) for (let i = live.length; i < target; i++) later((i - live.length) * 0.8, () => { if (GUESTS.filter((g) => !g.leaving && !g.gone).length < Math.min(24, siteInfo.online || 0)) spawnGuest(labels[i] || ''); });
  else for (const g of live.slice(target)) g.leaving = true;
}
let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  if (!running) return;
  try {
    const res = await fetch(`/api/staff/game/state${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`, { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401 || res.status === 403) { syncError = 'Нет доступа к «Игре» (только владелец и админ).'; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyState(await res.json());
  } catch (err) {
    syncError = 'Нет связи с порталом — повторю через несколько секунд.';
  }
  if (running) pollTimer = setTimeout(poll, firstSync ? 3000 : 6000);
}

/* ---------- обновление мира ---------- */
function moveAlong(e, dt, speed) {
  let d = speed * dt, moved = 0;
  while (d > 1e-6 && e.path.length) {
    const [tx, ty] = e.path[0];
    const dx = tx - e.x, dy = ty - e.y, L = Math.hypot(dx, dy);
    if (L > 1e-6) { e.dirx = dx / L; e.diry = dy / L; }
    if (L <= d) { e.x = tx; e.y = ty; d -= L; moved += L; e.path.shift(); }
    else { e.x += (dx / L) * d; e.y += (dy / L) * d; moved += d; d = 0; }
  }
  return moved;
}
const mechanicWorking = () => staffList().some((a) => a.role === 'service' && a.present && !a.hidden && a.state === 'work' && !a.busy && atHome(a));
function updateVehicle(v, dt) {
  if (v.hidden && v.away && v.cruise && S.gt > v.away) {
    v.hidden = false; v.away = 0;
    const e = pick(ENDS);
    v.x = RN[e][0]; v.y = RN[e][1]; v.prev = e; v.node = e; v.path = [];
    cruiseNext(v);
  }
  if (v.park && S.gt > v.park) { v.park = 0; cruiseNext(v); }
  if (v.path.length && !v.hidden) {
    moveAlong(v, dt, v.speed);
    if (Math.abs(v.dirx || 0) > Math.abs(v.diry || 0)) { v.dir = 'x'; v.sgn = Math.sign(v.dirx) || 1; }
    else { v.dir = 'y'; v.sgn = Math.sign(v.diry) || 1; }
    if (!v.path.length && v.cb) { const cb = v.cb; v.cb = null; cb(); }
  }
  const onRoad = tAt(Math.floor(v.x), Math.floor(v.y)) === T.ROAD && v.path.length > 0;
  const tx = onRoad ? (v.diry || 0) * 0.2 : 0, ty = onRoad ? -(v.dirx || 0) * 0.2 : 0;
  const k = Math.min(1, dt * 6);
  v.ox += (tx - v.ox) * k; v.oy += (ty - v.oy) * k;
  v.z = LIFT.v === v && Math.hypot(v.x - LIFT.x, v.y - LIFT.y) < 0.05 ? LIFT.h + 2 : 0;
  v.sparks = LIFT.v === v && v.status === 'service' && LIFT.h > 5 && mechanicWorking();
  if (v.sparks && Math.random() < (reduced ? 0.15 : 0.6) && dt > 0) {
    const p = up(iso(LIFT.x + 0.25, LIFT.y + 0.3), LIFT.h + 6);
    FX.push({ x: p[0], y: p[1], vx: rnd(-45, 45), vy: rnd(-70, -20), life: 0, max: rnd(0.25, 0.5), c: pick(['#fff6a8', '#ffd34d', '#ff9f1a', '#ffffff']), g: 220 });
  }
}
const atHome = (a) => a.home && Math.hypot(a.x - a.home.p[0], a.y - a.home.p[1]) < 0.06;
const SHOUTS = ['📣 Скутеры от 250 ฿!', '📣 Rent a car!', '📣 เช่ารถ ราคาดี!', '📣 Доставка в отель!'];
const REST_MS = 30 * 60000;
function updatePerson(a, dt) {
  if (!a.present || a.hidden) { a.moving = false; return; }
  if (a.path.length) {
    if (['sit', 'sad', 'lie', 'repair'].includes(a.pose)) a.pose = 'stand';
    const moved = moveAlong(a, dt, a.speed * (a.speedMul || 1));
    a.moving = moved > 0;
    a.step += moved * 2.4;
    const sx = (a.dirx || 0) - (a.diry || 0);
    if (Math.abs(sx) > 0.05) a.face = sx > 0 ? 1 : -1;
    a.back = (a.dirx || 0) + (a.diry || 0) < -0.2;
  } else a.moving = false;
  if (a.kind !== 'staff' || a.busy || a.state !== 'work') return;
  if (!a.path.length && !atHome(a)) { a.path = walkRoute([a.x, a.y], a.home.p, a.home.via); return; }
  if (a.path.length) return;
  const repairing = a.role === 'service' && LIFT.v && LIFT.v.status === 'service';
  a.pose = a.role === 'service' ? (repairing ? 'repair' : 'stand') : a.home.pose;
  a.face = a.home.face; a.back = false;
  if (a.home.desk) DESKS[a.home.desk].on = true;
  if ((a.role === 'manager' || a.role === 'owner') && TUMBLE.active && !a.tasks.length) {
    a.pose = 'sad';
    if (!a.bubble || a.bubble.until < S.rt - 4) bubble(a, pick(['…', '😴', '🥱', '…']), 1.6);
  }
  if (a.role === 'marketing' && (!a.bubble || a.bubble.until < S.rt - 3)) bubble(a, pick(SHOUTS), 2.4);
  if (queued(a)) return;
  // механик сам ставит на подъёмник следующую технику из очереди
  if (a.role === 'service' && !LIFT.v) {
    const w = VEH.find((v) => v.gspot && v.status === 'service' && !v.claim && !v.path.length);
    if (w) { play('toLift', [], () => toLift(w)); return; }
  }
  if (repairing) return;
  const idleSince = a.lastAction || (a.since ? Date.parse(a.since) : null);
  if (idleSince && nowMs() - idleSince > REST_MS) { a.restAt = nowMs(); play('rest', [a], () => rest(a)); }
}
const TUMBLE = { x: 11.6, y: 15.2, ph: 0, active: false };
function updateWorld(dt) {
  S.rt += dt;
  S.sim = phuketMinutes();
  const t = S.intro ? 0 : dt;
  S.gt += t;
  DOOR.open += ((PEOPLE.some((p) => p.present && !p.hidden && Math.hypot(p.x - 16.5, p.y - 16) < 0.95) || S.gt < DOOR.hold ? 1 : 0) - DOOR.open) * Math.min(1, dt * 8);
  LIFT.h += (LIFT.target - LIFT.h) * Math.min(1, t * 3);
  for (const v of VEH) updateVehicle(v, S.intro ? dt * 0.8 : t);
  if (S.intro) return;
  // задачи над головами: заявки — менеджерам по очереди, техника в ремонте — сервису
  const ms = managers().sort((p, q) => p.sid - q.sid);
  for (const a of staffList()) a.tasks = [];
  REQ.forEach((r, i) => { if (ms.length) ms[i % ms.length].tasks.push({ kind: 'req', icon: CH_ICON[r.channel] || '📨', what: `Заявка ${CH_RU[r.channel] || r.channel}${r.what ? `: ${r.what}` : ''}`, at: r.at, late: nowMs() - Date.parse(r.at) > 20 * 60000 }); });
  const mechs = staffList().filter((a) => a.role === 'service' && a.present);
  if (mechs.length) for (const v of VEH) if (v.status === 'service' && !v.staffOf) mechs[0].tasks.push({ kind: 'svc', icon: '🔧', what: `${v.model} (${v.plate})`, late: false });
  for (const a of staffList()) if (a.state === 'rest' && a.role === 'service' && VEH.some((v) => v.gspot && v.status === 'service')) a.wanted = true;
  for (const a of PEOPLE.slice()) updatePerson(a, t);
  tryStart();
  stepScenarios();
  for (let i = 0; i < LATER.length; i++) if (S.gt >= LATER[i].at) { const f = LATER[i].fn; LATER.splice(i--, 1); f(); }
  const clients = PEOPLE.some((p) => p.kind === 'client' || p.kind === 'guest');
  if (clients || REQ.length) S.quietSince = nowMs();
  TUMBLE.active = !clients && managers().length > 0 && nowMs() - S.quietSince > 20 * 60000;
  if (TUMBLE.active) {
    TUMBLE.ph += t * 1.4;
    const u = (Math.sin(TUMBLE.ph * 0.35) + 1) / 2;
    TUMBLE.x = lerp(11.5, 18.6, u); TUMBLE.y = lerp(15.3, 12.7, u);
  }
}
function updateFx(dt) {
  for (let i = 0; i < FX.length; i++) { const p = FX[i]; p.life += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.life > p.max) FX.splice(i--, 1); }
  for (let i = 0; i < FLY.length; i++) { const f = FLY[i]; f.t += dt; if (f.t >= f.dur) { FLY.splice(i--, 1); if (f.onEnd) f.onEnd(); } }
  for (let i = 0; i < FLOAT.length; i++) { const f = FLOAT[i]; f.t += dt; if (f.t > f.dur) FLOAT.splice(i--, 1); }
}
function flyPos(f) {
  const u = clamp(f.t / f.dur, 0, 1);
  const bb = typeof f.b === 'function' ? f.b() : f.b;
  const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  return [lerp(f.a[0], bb[0], e), lerp(f.a[1], bb[1], e) - Math.sin(u * Math.PI) * f.h];
}

/* ---------- отрисовка ---------- */
function nightAlpha() {
  const h = S.sim / 60;
  if (h >= 18.5) return clamp((h - 18.5) / 2.5, 0, 1) * 0.38;
  if (h < 6) return 0.38;
  if (h < 7) return (7 - h) * 0.38;
  return 0;
}
function introDrop(x, y, kind) {
  const p = S.intro.t / S.intro.dur;
  const d = clamp(Math.hypot(x - 20, y - 17) / 24, 0, 1);
  const start = kind === 'tile' ? d * 0.42 : 0.36 + d * 0.3;
  const local = clamp((p - start) / 0.2, 0, 1);
  if (local <= 0) return null;
  return (1 - (1 - Math.pow(1 - local, 3))) * 70;
}
function render() {
  const z = S.zoom;
  const bw = Math.ceil(cssW / z) + 2, bh = Math.ceil(cssH / z) + 2;
  if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; }
  const cx = Math.floor(S.camX), cy = Math.floor(S.camY);
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.imageSmoothingEnabled = false;
  b.fillStyle = '#17698c'; b.fillRect(0, 0, bw, bh);
  b.setTransform(1, 0, 0, 1, -cx, -cy);
  const vis = (sx, sy, m = 90) => sx > cx - m && sx < cx + bw + m && sy > cy - m && sy < cy + bh + m;
  for (const w of waves) {
    if (!vis(w.x, w.y, 10)) continue;
    const a = (Math.sin(S.rt * w.s + w.p) + 1) / 2;
    b.globalAlpha = 0.15 + a * 0.45; b.fillStyle = '#8fe0ee';
    b.fillRect(Math.round(w.x + Math.sin(S.rt * 0.5 + w.p) * 3), Math.round(w.y), w.w, 1);
  }
  b.globalAlpha = 1;
  if (S.intro) {
    forTiles((x, y) => {
      const off = introDrop(x, y, 'tile');
      if (off === null) return;
      dropOff = off; b.globalAlpha = clamp(1 - off / 70, 0.2, 1);
      drawTile(b, x, y);
    });
    dropOff = 0; b.globalAlpha = 1;
  } else b.drawImage(stat, 0, 0);
  b.fillStyle = '#f2fdff';
  for (const f of foam) {
    if (!vis(f.a[0], f.a[1], 20)) continue;
    const a = (Math.sin(S.rt * 1.6 + f.p) + 1) / 2;
    if (a < 0.35) continue;
    b.globalAlpha = a * 0.7;
    for (const t of [0.2, 0.5, 0.8]) b.fillRect(Math.round(lerp(f.a[0], f.b[0], t)), Math.round(lerp(f.a[1], f.b[1], t) + Math.sin(S.rt * 2 + f.p) * 1.2), 2, 1);
  }
  b.globalAlpha = 1;
  const list = [];
  for (const o of objs) { const p = iso(o.x, o.y); if (vis(p[0], p[1])) list.push({ d: o.depth, o }); }
  for (const v of VEH) if (!v.hidden) list.push({ d: v.x + v.y + (LIFT.v === v ? 0.3 : 0), v });
  for (const a of PEOPLE) if (a.present && !a.hidden) list.push({ d: a.x + a.y + 0.02, a });
  if (TUMBLE.active) list.push({ d: TUMBLE.x + TUMBLE.y, t: TUMBLE });
  list.sort((p, q) => p.d - q.d);
  for (const it of list) {
    const e = it.o || it.v || it.a || it.t;
    if (S.intro) { const off = introDrop(e.x, e.y, 'obj'); if (off === null) continue; dropOff = off; }
    if (it.o) it.o.draw(it.o);
    else if (it.v) drawVehicle(it.v);
    else if (it.a) {
      const p = iso(it.a.x, it.a.y);
      const keep = it.a.pose;
      if (isWater(tAt(Math.floor(it.a.x), Math.floor(it.a.y)))) it.a.pose = 'swim';
      drawPerson(it.a, p[0], p[1]);
      it.a.pose = keep;
    } else drawTumble(it.t);
    dropOff = 0;
  }
  dropOff = 0;
  if (!S.intro) {
    for (const v of VEH) {
      if (v.hidden || !v.hit || v.staffOf) continue;
      if (v.err) drawWarn(v.sx, v.headY - 3, v.err.level);
      else if (v.status === 'reserve') { px(v.sx, v.headY - 10, 1, 8, '#ddd'); px(v.sx + 1, v.headY - 10, 5, 3, '#3b82f6'); }
    }
    for (const a of staffList()) {
      if (!a.present || a.hidden || !a.hit) continue;
      const n = Math.min(4, a.tasks.length);
      const sx = (a.hit[0] + a.hit[2]) / 2, hy = a.headY;
      for (let i = 0; i < n; i++) {
        const t = a.tasks[i];
        px(sx - 3 + i, hy - 7 - i * 2, 7, 5, '#fbfbf6');
        px(sx - 3 + i, hy - 7 - i * 2, 7, 1, t.late ? '#e74c3c' : t.kind === 'svc' ? '#e67e22' : '#3b82f6');
      }
      a.taskHit = n ? [sx - 9, hy - 18, sx + 9, hy - 1] : null;
      if (a.tasks.some((t) => t.late)) drawWarn(sx + 8, hy - 8, 'error');
    }
    for (const f of FLY) {
      if (f.t < 0 || f.kind !== 'coin') continue;
      const [x, y] = flyPos(f);
      px(x - 2, y - 2, 4, 4, '#f2c94c'); px(x - 2, y - 2, 2, 1, '#fff6c8'); px(x + 1, y + 1, 1, 1, '#b8871f');
    }
    for (const p of FX) { b.globalAlpha = clamp(1 - p.life / p.max, 0, 1); px(p.x, p.y, 1, 1, p.c); }
    b.globalAlpha = 1;
    const sel = S.selected && S.selected.e;
    if (sel && sel.x !== undefined && !sel.hidden && sel.present !== false) {
      const r = 0.42 + Math.sin(S.rt * 5) * 0.06;
      const pts = [iso(sel.x - r, sel.y - r), iso(sel.x + r, sel.y - r), iso(sel.x + r, sel.y + r), iso(sel.x - r, sel.y + r)];
      b.strokeStyle = '#ffd38a'; b.lineWidth = 1; b.beginPath(); pts.forEach((p, i) => (i ? b.lineTo(p[0], p[1]) : b.moveTo(p[0], p[1]))); b.closePath(); b.stroke();
    }
  }
  const night = nightAlpha();
  if (night > 0) { b.fillStyle = `rgba(18,22,64,${night})`; b.fillRect(cx, cy, bw, bh); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const k = z * DPR;
  ctx.drawImage(buf, 0, 0, bw, bh, Math.round(-(S.camX - cx) * k), Math.round(-(S.camY - cy) * k), Math.round(bw * k), Math.round(bh * k));
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  overlay();
}
const scr = (p) => [(p[0] - S.camX) * S.zoom, (p[1] - S.camY) * S.zoom];
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawBubble(sx, sy, text, dark) {
  ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 14, h = 21;
  const x = Math.round(sx - w / 2), y = Math.round(sy - h - 7);
  ctx.fillStyle = dark ? 'rgba(20,24,32,.92)' : 'rgba(255,255,255,.96)';
  roundRect(x, y, w, h, 8); ctx.fill();
  ctx.beginPath(); ctx.moveTo(sx - 4, y + h); ctx.lineTo(sx + 4, y + h); ctx.lineTo(sx, y + h + 5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = dark ? '#ffe7b0' : '#1d1b16';
  ctx.fillText(text, x + 7, y + 15);
}
// Подписи (имена, суммы) раскладываем без наложений: занятое место поднимает подпись выше
function layoutLabels(list) {
  const placed = [];
  for (const l of list) {
    ctx.font = `${l.font} system-ui, -apple-system, "Segoe UI", sans-serif`;
    l.w = Math.ceil(ctx.measureText(l.text).width) + 10;
    let shift = 0;
    for (let i = 0; i < 8; i++) {
      const r = [l.x - l.w / 2, l.y - 15 - shift, l.x + l.w / 2, l.y - shift];
      if (!placed.some((p) => r[0] < p[2] + 2 && r[2] > p[0] - 2 && r[1] < p[3] + 1 && r[3] > p[1] - 1)) { placed.push(r); break; }
      shift += 16;
    }
    l.shift = shift;
  }
  for (const l of list) {
    if (l.shift) { ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(l.x, l.y - l.shift); ctx.stroke(); }
    tag(l.x, l.y - l.shift, l.text, l.bg, l.fg, l.font);
    if (l.owner) l.owner.labelTop = l.y - l.shift - 17;
  }
}
function tag(sx, sy, text, bg, fg = '#fff', font = '700 11px') {
  ctx.font = `${font} system-ui, -apple-system, "Segoe UI", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 10;
  ctx.fillStyle = bg; roundRect(Math.round(sx - w / 2), Math.round(sy - 15), w, 15, 7); ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.fillText(text, Math.round(sx), Math.round(sy - 4)); ctx.textAlign = 'left';
  return 17;
}
function overlay() {
  const z = S.zoom;
  if (!S.intro) {
    ctx.textAlign = 'left';
    for (const mk of staffList()) {
      if (mk.role !== 'marketing' || !mk.present || mk.hidden || mk.pose !== 'megaphone' || mk.moving || !mk.hit) continue;
      const [sx, sy] = scr([mk.hit[2] + 4, mk.headY + 5]);
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const ph = (S.rt * 1.4 + i / 3) % 1;
        ctx.globalAlpha = 1 - ph;
        ctx.beginPath(); ctx.arc(sx, sy, 4 + ph * 16 * Math.max(1, z / 2), -0.7, 0.7); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // подписи: суммы над сейфами и кошельками, имена над сотрудниками — всегда, без наложений
    const small = z >= 1.5 ? '700 11px' : '700 10px';
    const labels = [];
    for (const id of ['op', 'dep']) {
      const o = SAFES_OBJ[id]; if (!o.hit) continue;
      const [sx, sy] = scr([o.sx, o.headY]);
      labels.push({ x: sx, y: sy, text: `${id === 'op' ? '💰 сегодня' : '🔒 залоги'} ${money(S.safes[id])}`, bg: 'rgba(20,24,32,.94)', fg: '#ffe7b0', font: small });
    }
    for (const p of PEDESTALS) {
      if (!p.w || !p.hit) continue;
      const [sx, sy] = scr([p.sx, p.headY]);
      const neg = p.w.thb < 0;
      labels.push({ x: sx, y: sy, text: `${String(p.w.name).split(/\s+/)[0]} ${neg ? '−' : '+'}${money(Math.abs(p.w.thb))}`, bg: neg ? 'rgba(170,40,30,.94)' : 'rgba(25,110,60,.94)', fg: '#fff', font: small });
    }
    for (const a of staffList()) {
      if (!a.present || a.hidden || !a.hit) continue;
      const head = scr([(a.hit[0] + a.hit[2]) / 2, a.headY]);
      if (a.tasks.length > 1) {
        const [bx, by] = scr([(a.hit[0] + a.hit[2]) / 2 + 6, a.headY - 14]);
        ctx.fillStyle = '#e74c3c'; ctx.beginPath(); ctx.arc(bx, by, 7, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '700 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(a.tasks.length), bx, by + 3.5); ctx.textAlign = 'left';
      }
      labels.push({ x: head[0], y: head[1] - (a.tasks.length ? 8 * z : 0) - 1, text: a.name.split(/\s+/)[0], bg: 'rgba(10,16,26,.78)', fg: a.role === 'owner' ? '#ffd38a' : '#ffffff', font: '600 11px', owner: a });
    }
    labels.sort((p, q) => q.y - p.y);
    layoutLabels(labels);
    // пузыри — над подписью
    for (const a of PEOPLE) {
      if (!a.present || a.hidden || !a.hit) continue;
      const head = scr([(a.hit[0] + a.hit[2]) / 2, a.headY]);
      let top = head[1];
      if (a.kind === 'staff' && a.labelTop !== undefined) top = a.labelTop + 2;
      else if (a.kind === 'guest' && z >= 2.5 && a.source) {
        ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillText(a.source, head[0], head[1] - 3); ctx.textAlign = 'left';
        top -= 12;
      }
      if (a.bubble && a.bubble.until > S.rt) drawBubble(head[0], top, a.bubble.text, a.role === 'marketing');
    }
    ctx.font = '18px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    for (const f of FLY) {
      if (f.kind !== 'icon' || f.t < 0) continue;
      const [sx, sy] = scr(flyPos(f));
      ctx.fillText(f.icon, sx, sy);
    }
    for (const f of FLOAT) {
      const [sx, sy] = scr(f.at);
      ctx.globalAlpha = clamp(1.4 - f.t / f.dur, 0, 1);
      ctx.font = '800 14px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillText(f.text, sx + 1, sy - f.t * 20 + 1);
      ctx.fillStyle = f.color; ctx.fillText(f.text, sx, sy - f.t * 20);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }
  const p = S.intro ? S.intro.t / S.intro.dur : 1 + (S.rt - S.introEnd) / 0.7;
  if (p > 0.45 && p < 2) {
    const alpha = p <= 1 ? clamp((p - 0.45) / 0.15, 0, 1) : clamp(2 - p, 0, 1) * (p < 1.9 ? 1 : 0);
    const size = Math.round(clamp(cssW / 13, 16, 46));
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    const cx0 = cssW / 2, cy0 = cssH * 0.36;
    ctx.fillStyle = 'rgba(8,14,24,.55)';
    roundRect(cx0 - size * 6.2, cy0 - size * 1.15, size * 12.4, size * 2.35, 14); ctx.fill();
    const word = 'GAME MODE';
    const shown = p <= 1 ? Math.max(1, Math.ceil(clamp((p - 0.48) / 0.3, 0, 1) * word.length)) : word.length;
    ctx.font = `${size}px "Press Start 2P", monospace`;
    ctx.fillStyle = '#7a2c0c'; ctx.fillText(word.slice(0, shown), cx0 + 4, cy0 + 4);
    ctx.fillStyle = '#ff8547'; ctx.fillText(word.slice(0, shown), cx0, cy0);
    ctx.font = `${Math.max(7, Math.round(size / 3.6))}px "Press Start 2P", monospace`;
    ctx.fillStyle = '#ffe7b0'; ctx.fillText('JET MOBILITY · KOKONCAR · PHUKET', cx0, cy0 + size * 0.85);
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }
}

/* ---------- камера и ввод ---------- */
function clampCam() {
  const vw = cssW / S.zoom, vh = cssH / S.zoom;
  S.camX = clamp(S.camX, -vw * 0.4, WORLD_W - vw * 0.6);
  S.camY = clamp(S.camY, -vh * 0.4, WORLD_H - vh * 0.6);
}
function centerOn(x, y) { const p = iso(x, y); S.camX = p[0] - cssW / S.zoom / 2; S.camY = p[1] - cssH / S.zoom / 2; clampCam(); }
function zoomAt(mx, my, nz) {
  nz = clamp(nz, 1, 4);
  const wx = S.camX + mx / S.zoom, wy = S.camY + my / S.zoom;
  S.zoom = nz; S.camX = wx - mx / nz; S.camY = wy - my / nz; clampCam();
}
function resize() {
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  if (!r.width) return;
  cssW = r.width; cssH = r.height;
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.round(cssW * DPR); cv.height = Math.round(cssH * DPR);
  clampCam();
}
const pointers = new Map();
let drag = null, pinch = null;
function wireCanvas() {
  cv.addEventListener('pointerdown', (e) => {
    if (S.intro) { skipIntro(); return; }
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, cam: [S.camX, S.camY], moved: false };
    else if (pointers.size === 2) { const [p1, p2] = [...pointers.values()]; pinch = { d: Math.max(20, dist(p1, p2)), z: S.zoom }; drag = null; }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) { if (e.pointerType === 'mouse') hover(e.offsetX, e.offsetY); return; }
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pinch && pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      zoomAt((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, pinch.z * dist(p1, p2) / pinch.d);
    } else if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) { drag.moved = true; cv.classList.add('gm-dragging'); tipHide(); }
      if (drag.moved) { S.camX = drag.cam[0] - dx / S.zoom; S.camY = drag.cam[1] - dy / S.zoom; clampCam(); }
    }
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (drag && !drag.moved && e.type === 'pointerup') clickAt(e.offsetX, e.offsetY);
    if (!pointers.size) { drag = null; pinch = null; cv.classList.remove('gm-dragging'); }
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', tipHide);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, S.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); }, { passive: false });
}
const inside = (h, wx, wy) => h && wx >= h[0] && wx <= h[2] && wy >= h[1] && wy <= h[3];
function pickAt(mx, my) {
  const wx = S.camX + mx / S.zoom, wy = S.camY + my / S.zoom;
  let best = null, bd = -Infinity;
  for (const v of VEH) if (!v.hidden && inside(v.hit, wx, wy) && v.x + v.y > bd) { best = v.staffOf ? { kind: 'person', e: v.staffOf } : { kind: 'veh', e: v }; bd = v.x + v.y; }
  for (const a of PEOPLE) if (a.present && !a.hidden && inside(a.hit, wx, wy) && a.x + a.y + 0.5 > bd) { best = { kind: 'person', e: a }; bd = a.x + a.y + 0.5; }
  for (const id of ['op', 'dep']) if (inside(SAFES_OBJ[id].hit, wx, wy)) { best = { kind: 'safe', id, e: SAFES_OBJ[id] }; bd = 99; }
  for (const p of PEDESTALS) if (p.w && inside(p.hit, wx, wy)) { best = { kind: 'wallet', e: p }; bd = 99; }
  for (const a of staffList()) if (a.present && !a.hidden && a.taskHit && inside(a.taskHit, wx, wy)) { best = { kind: 'tasks', e: a }; bd = 199; }
  if (inside(COUNTER.hit, wx, wy)) best = { kind: 'counter', e: COUNTER };
  return best;
}
function clickAt(mx, my) {
  const best = pickAt(mx, my);
  if (best) openCard(best); else closeCard();
}
/* подсказка у табло посетителей: откуда пришли */
let tipEl = null;
function sourcesHtml() {
  const list = COUNTER.sources || [];
  return list.length ? list.map((s) => `<li><span>${esc(s.name)}</span><b>${s.n}</b></li>`).join('') : '<li><span>сейчас никого</span></li>';
}
function hover(mx, my) {
  const wx = S.camX + mx / S.zoom, wy = S.camY + my / S.zoom;
  if (!inside(COUNTER.hit, wx, wy)) { tipHide(); cv.style.cursor = ''; return; }
  cv.style.cursor = 'help';
  tipEl.innerHTML = `<b>На сайте сейчас: ${COUNTER.n}</b><small>Открывали страницы за последние 5 минут. Откуда пришли:</small><ul>${sourcesHtml()}</ul>`;
  tipEl.hidden = false;
  tipEl.style.left = `${Math.min(mx + 14, cssW - 250)}px`;
  tipEl.style.top = `${Math.max(8, my - 10)}px`;
}
function tipHide() { if (tipEl) tipEl.hidden = true; }

/* ---------- интро ---------- */
function startIntro(short) {
  if (reduced) { S.introEnd = S.rt - 5; return; }
  S.intro = { t: 0, dur: short ? 1.1 : 2.6 };
  stage.classList.add('gm-intro');
}
function endIntro() {
  S.intro = null; S.introEnd = S.rt;
  stage.classList.remove('gm-intro');
  try { localStorage.setItem('gm.introSeen', '1'); } catch (e) { /* без хранилища — не страшно */ }
}
function skipIntro() { if (S.intro) S.intro.t = S.intro.dur; }

/* ---------- карточки ---------- */
let card = null, cardTimer = 0;
const DOING = { arrive: 'идёт на работу', leave: 'уходит домой', rest: 'отдыхает', issueDesk: 'оформляет договор', returnDesk: 'принимает возврат',
  keys: 'отдаёт ключи', inspect: 'осматривает технику', toLift: 'ставит на подъёмник' };
const HOME_DOING = { manager: 'за своим столом', owner: 'в офисе', finance: 'в финансах', service: 'в гараже', marketing: 'зазывает клиентов 📣', delivery: 'у будки выдачи' };
const hm = (iso) => (iso ? timeOf(iso) : '');
function idleMin(a) { const s = a.lastAction || (a.since ? Date.parse(a.since) : null); return s ? Math.max(0, Math.round((nowMs() - s) / 60000)) : null; }
function unitStatus(a) {
  if (a.state === 'off' || (!a.present && a.state !== 'queued')) return a.left ? [`ушёл в ${hm(a.left)}`, ''] : ['не на смене', ''];
  if (a.state === 'queued' || a.state === 'arriving') return ['идёт на работу', 'info'];
  if (a.state === 'leaving') return ['уходит', ''];
  if (a.state === 'rest') return [`${a.pose === 'swim' ? 'купается' : 'на пляже'} · ${idleMin(a) ?? '—'} мин без дел${a.tasks.length ? ` · очередь ${a.tasks.length}` : ''}`, a.tasks.length ? 'warn' : 'ok'];
  if (a.busy) return [DOING[a.busy.name] || 'занят', 'info'];
  if (a.pose === 'sad') return ['скучает: клиентов нет', ''];
  if (a.role === 'service' && LIFT.v && LIFT.v.status === 'service') return ['ремонтирует', 'info'];
  return [HOME_DOING[a.role] || 'на месте', 'ok'];
}
function cardHtml(sel) {
  const x = '<button type="button" class="gm-x" data-gm-close aria-label="Закрыть">×</button>';
  const e = sel.e;
  if (sel.kind === 'veh') {
    const st = STATUS_RU[e.status] || e.status;
    const where = e.slot ? (['O', 'Q'].includes(e.slot.row) ? 'у дороги (стоянка заполнена)' : 'стоянка компании') : e.gspot || LIFT.v === e ? 'сервис' : e.park ? 'у пляжа' : e.hidden ? 'где-то на острове' : 'едет по острову';
    const d = e.data || {};
    return `${x}<div class="gm-sub">${TYPE_RU[e.type] || 'Техника'} · ${esc(e.plate)}</div><h2>${TYPE_ICON[e.type] || '🚗'} ${esc(e.model)}</h2>
      <span class="gm-pill gm-${e.status}">${esc(st)}</span>${e.err ? `<span class="gm-pill gm-${e.err.level === 'error' ? 'bad' : 'warn'}">⚠ ${esc(e.err.text)}</span>` : ''}
      <dl>${d.client ? `<dt>${d.holderKind === 'reserve' ? 'Бронь' : 'Клиент'}</dt><dd>${esc(d.client)}</dd>` : ''}${d.until ? `<dt>До</dt><dd>${esc(String(d.until).slice(0, 10))}</dd>` : ''}
      <dt>Где</dt><dd>${where}</dd></dl>
      <div class="gm-note2">${e.status === 'rent' ? 'Маршрут по острову условный — GPS-трекеров нет. ' : ''}Статус — из «Парка».</div>`;
  }
  if (sel.kind === 'safe') {
    const s = SAFES[sel.id];
    return `${x}<div class="gm-sub">Финансы · сейф</div><h2>🔒 ${esc(s.title)}</h2><dl><dt>Сейчас</dt><dd><b>${money(S.safes[sel.id])}</b></dd></dl>
      <div class="gm-note2">${esc(s.note)} Сумма меняется вместе с операциями; точные остатки сейфов появятся с «Личными счетами сотрудников».</div>`;
  }
  if (sel.kind === 'wallet') {
    const w = e.w;
    return `${x}<div class="gm-sub">Кошелёк сотрудника</div><h2>👛 ${esc(w.name)}</h2><dl><dt>На руках</dt><dd style="color:${w.thb < 0 ? '#ff8a80' : '#7dff9b'}"><b>${money(w.thb)}</b></dd></dl>
      <div class="gm-note2">Наличные с последней сдачи кассы — как в «Финансах». Минус — сотрудник потратил свои: при сдаче кассы ему выдают разницу.</div>`;
  }
  if (sel.kind === 'tasks') {
    const items = e.tasks.map((t) => `<li>${t.icon} ${esc(t.what)}${t.at ? ` · ${Math.max(1, Math.round((nowMs() - Date.parse(t.at)) / 60000))} мин` : ''}${t.late ? ' <span class="gm-pill gm-bad">без ответа 20+ мин</span>' : ''}</li>`).join('');
    return `${x}<div class="gm-sub">Очередь · ${esc(e.name)}</div><h2>📨 Задачи (${e.tasks.length})</h2><ul>${items || '<li>Пусто</li>'}</ul>
      <div class="gm-note2">Новые заявки делятся между менеджерами на месте; у сервиса — техника в ремонте.</div>`;
  }
  if (sel.kind === 'counter') {
    return `${x}<div class="gm-sub">Табло у входа</div><h2>👥 На сайте сейчас: ${COUNTER.n}</h2><ul class="gm-src">${sourcesHtml()}</ul>
      <div class="gm-note2">Посетители jetmobility.org и kokoncar.com, открывавшие страницы за последние 5 минут (без имён и адресов). Столько же гостей гуляет по шоуруму.</div>`;
  }
  if (e.kind === 'guest') return `${x}<div class="gm-sub">Посетитель сайта</div><h2>🧳 Гость</h2><p>Смотрит сайт прямо сейчас${e.source ? ` · пришёл: ${esc(e.source)}` : ''}. Без имени и контактов.</p>`;
  if (e.kind === 'client') return `${x}<div class="gm-sub">Клиент</div><h2>🧍 ${esc(e.name)}</h2><p>Анимация выдачи или возврата по статусу техники.</p>`;
  const [st, cls] = unitStatus(e);
  const idle = idleMin(e);
  const tasks = e.tasks.map((t) => `<li>${t.icon} ${esc(t.what)}${t.late ? ' ⚠' : ''}</li>`).join('');
  return `${x}<div class="gm-sub">${esc(e.roleName || ROLE_RU[e.role] || '')}</div><h2>${ROLE_ICON[e.role] || '🙂'} ${esc(e.name)}</h2>
    <span class="gm-pill gm-${cls || 'off'}">${esc(st)}</span>
    <dl>${e.since ? `<dt>На месте с</dt><dd>${hm(e.since)}</dd>` : ''}${e.left ? `<dt>Ушёл</dt><dd>${hm(e.left)}</dd>` : ''}
    <dt>Последнее действие</dt><dd>${e.lastAction ? `${timeOf(new Date(e.lastAction).toISOString())}${idle !== null ? ` (${idle} мин назад)` : ''}` : 'сегодня не было'}</dd>
    ${e.wallet !== null && e.wallet !== undefined ? `<dt>Кошелёк</dt><dd style="color:${e.wallet < 0 ? '#ff8a80' : e.wallet > 0 ? '#7dff9b' : 'inherit'}">${money(e.wallet)}</dd>` : ''}
    <dt>Очередь</dt><dd>${e.tasks.length || 'пусто'}</dd></dl>${tasks ? `<ul>${tasks}</ul>` : ''}
    <div class="gm-note2">Приход и уход — отметки в группе WhatsApp (как табель). Действия — группа, статусы, документы, деньги, «＋ Операция». 30 минут без действий — отдых на пляже.</div>`;
}
function openCard(sel) { S.selected = sel; card.innerHTML = cardHtml(sel); card.classList.add('gm-open'); cardTimer = S.rt; tipHide(); }
function closeCard() { S.selected = null; if (card) card.classList.remove('gm-open'); }

/* ---------- панель справа: команда, парк, сайт, касса; лента ---------- */
let panelTab = 'team', panelKey = '';
const TYPES_ROWS = [['scooter', 'Скутеры'], ['moto', 'Мотоциклы'], ['car', 'Автомобили']];
function teamHtml() {
  const order = { manager: 1, owner: 0, finance: 2, service: 3, delivery: 4, marketing: 5 };
  const list = staffList().sort((p, q) => (q.present ? 1 : 0) - (p.present ? 1 : 0) || (order[p.role] ?? 9) - (order[q.role] ?? 9) || p.name.localeCompare(q.name));
  const here = list.filter((a) => a.present && a.state !== 'leaving').length;
  const units = list.map((a) => {
    const [st, cls] = unitStatus(a);
    const extra = [a.tasks.length ? `📨${a.tasks.length}` : '', a.wallet ? `<span style="color:${a.wallet < 0 ? '#ff8a80' : '#7dff9b'}">${money(a.wallet)}</span>` : ''].filter(Boolean).join(' · ');
    return `<li class="gm-unit${a.present ? '' : ' gm-away'}" data-gm-unit="${a.sid}"><i style="background:${a.look.shirt}"></i>
      <div><b>${esc(a.name)}</b> <small>${esc(ROLE_RU[a.role] || '')}</small><span class="gm-ust gm-${cls || 'off'}">${esc(st)}${a.since && a.present ? ` · с ${hm(a.since)}` : ''}</span></div>${extra ? `<span class="gm-ux">${extra}</span>` : ''}</li>`;
  }).join('');
  const count = (type, status) => carsData.filter((c) => c.type === type && (!status || c.status === status)).length;
  const all = (status) => carsData.filter((c) => !status || c.status === status).length;
  const rows = TYPES_ROWS.map(([t, l]) => `<tr><td>${l}</td><td><b>${count(t)}</b></td><td>${count(t, 'free')}</td><td>${count(t, 'rent')}</td><td>${count(t, 'service')}</td><td>${count(t, 'reserve')}</td></tr>`).join('');
  const src = (siteInfo.sources || []).slice(0, 4).map((s) => `${esc(s.name)} ${s.n}`).join(', ');
  return `<section><h4>Команда · на месте ${here} из ${list.length}</h4><ul class="gm-units">${units || '<li class="gm-empty">Сотрудников в «Доступах» нет</li>'}</ul></section>
    <section><h4>Парк — как в «Обзоре»</h4><table class="gm-fleet"><thead><tr><th></th><th>всего</th><th>своб.</th><th>аренда</th><th>ремонт</th><th>бронь</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>Итого</td><td><b>${all()}</b></td><td>${all('free')}</td><td>${all('rent')}</td><td>${all('service')}</td><td>${all('reserve')}</td></tr></tfoot></table></section>
    <section><h4>Сайт и боты</h4><p>🌐 На сайте сейчас: <b>${siteInfo.online || 0}</b>${src ? ` <small>(${src})</small>` : ''}<br>💬 Пишут ботам (10 мин): <b>${chatInfo.active || 0}</b><br>📨 Новых заявок: <b>${REQ.length}</b></p></section>
    <section><h4>Касса</h4><p>💰 Приход наличными сегодня: <b>${money(S.safes.op)}</b><br>🔒 Залоги на руках: <b>${money(S.safes.dep)}</b></p></section>`;
}
function renderPanel() {
  if (panelTab !== 'team') return;
  const html = teamHtml();
  if (html === panelKey) return;
  panelKey = html;
  root.querySelector('[data-gm-team]').innerHTML = html;
}
function feedLi(item) {
  const li = document.createElement('li');
  li.innerHTML = `<time>${esc(item.time)}</time>${esc(item.icon)} ${esc(item.text)}<small>${esc(item.src)}</small>`;
  return li;
}
function feedAdd(item) {
  if (!root) return;
  const list = root.querySelector('[data-gm-feed]');
  list.prepend(feedLi(item));
  while (list.children.length > 60) list.lastChild.remove();
}
function setPanelTab(tab) {
  panelTab = tab;
  root.querySelectorAll('[data-gm-ptab]').forEach((b2) => b2.setAttribute('aria-pressed', String(b2.dataset.gmPtab === tab)));
  root.querySelector('[data-gm-team]').hidden = tab !== 'team';
  root.querySelector('[data-gm-feed]').hidden = tab !== 'feed';
  panelKey = ''; renderPanel();
}
let hudT = 0;
function hud() {
  root.querySelector('[data-gm-clock]').textContent = clockStr();
  const syncEl = root.querySelector('[data-gm-sync]');
  syncEl.textContent = syncError || (firstSync ? 'загружаю…' : '');
  syncEl.hidden = !syncEl.textContent;
  const c = (st) => carsData.filter((x) => x.status === st).length;
  root.querySelector('[data-gm-stats]').innerHTML = `<span>🅿️ свободно <b>${c('free')}</b></span><span>🛵 в аренде <b>${c('rent')}</b></span><span>🔧 ремонт <b>${c('service')}</b></span><span>👥 на месте <b>${staffList().filter((a) => a.present && a.state !== 'leaving').length}/${STAFF.size}</b></span><span>🌐 на сайте <b>${siteInfo.online || 0}</b></span>`;
  renderPanel();
  if (S.selected && card.classList.contains('gm-open') && S.rt - cardTimer > 1 && !card.contains(document.activeElement)) {
    const sel = S.selected;
    if (sel.kind === 'person' && sel.e.gone) return closeCard();
    card.innerHTML = cardHtml(sel); cardTimer = S.rt;
  }
}

/* ---------- кадр ---------- */
let last = 0, looping = false;
function frame(ts) {
  if (!root || !root.isConnected) { looping = false; running = false; clearTimeout(pollTimer); return; }
  requestAnimationFrame(frame);
  const now = ts / 1000;
  const dt = Math.min(0.05, last ? now - last : 0.016);
  last = now;
  if (document.hidden) return;
  if (S.intro) { S.intro.t += dt; if (S.intro.t >= S.intro.dur) endIntro(); }
  updateWorld(dt);
  updateFx(dt);
  render();
  if (S.rt - hudT > 0.5) { hudT = S.rt; hud(); }
}

/* ---------- сборка и подключение к вкладке ---------- */
const TEMPLATE = `
  <div class="gm-stage">
    <canvas class="gm-cv" aria-label="Мир компании: офис и шоурум, стоянки, сервис, финансы, пляж, дороги острова"></canvas>
    <div class="gm-hud gm-top">
      <div class="gm-box gm-clock"><b data-gm-clock>--:--</b><span data-gm-sync hidden></span></div>
      <div class="gm-box gm-stats" data-gm-stats></div>
      <div class="gm-grow"></div>
      <button type="button" class="gm-box" data-gm-act="office" title="К офису" aria-label="К офису">🏢</button>
      <button type="button" class="gm-box" data-gm-act="finance" title="К финансам" aria-label="К финансам">💰</button>
      <button type="button" class="gm-box" data-gm-act="sound" aria-pressed="false" title="Звук" aria-label="Звук">🔇</button>
    </div>
    <aside class="gm-hud gm-box gm-panel" data-gm-panel>
      <div class="gm-ptabs"><button type="button" data-gm-ptab="team" aria-pressed="true">👥 Команда</button><button type="button" data-gm-ptab="feed" aria-pressed="false">📜 Лента</button></div>
      <div class="gm-team" data-gm-team></div>
      <ol class="gm-feed" data-gm-feed hidden></ol>
    </aside>
    <div class="gm-hud gm-box gm-card" data-gm-card role="dialog" aria-label="Карточка"></div>
    <div class="gm-tip" data-gm-tip hidden></div>
    <div class="gm-hud gm-zoom">
      <button type="button" class="gm-box gm-ptoggle" data-gm-act="panel" aria-label="Команда и лента">👥</button>
      <button type="button" class="gm-box" data-gm-act="zin" aria-label="Крупнее">＋</button>
      <button type="button" class="gm-box" data-gm-act="zout" aria-label="Мельче">－</button>
    </div>
    <div class="gm-hint">Наблюдатель: только смотрим. Маршруты машин в аренде условные.</div>
    <button type="button" class="gm-skip" data-gm-act="skip">Пропустить ▸</button>
  </div>`;
function build() {
  root = document.createElement('div');
  root.className = 'gm';
  root.innerHTML = TEMPLATE;
  stage = root.querySelector('.gm-stage');
  cv = root.querySelector('.gm-cv');
  ctx = cv.getContext('2d');
  card = root.querySelector('[data-gm-card]');
  tipEl = root.querySelector('[data-gm-tip]');
  wireCanvas();
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-gm-close]')) { closeCard(); return; }
    const tabBtn = e.target.closest('[data-gm-ptab]');
    if (tabBtn) { setPanelTab(tabBtn.dataset.gmPtab); return; }
    const unit = e.target.closest('[data-gm-unit]');
    if (unit) {
      const a = STAFF.get(Number(unit.dataset.gmUnit)) || STAFF.get(unit.dataset.gmUnit);
      if (!a) return;
      if (a.present && !a.hidden) centerOn(a.x, a.y);
      openCard({ kind: 'person', e: a });
      if (cssW < 760) root.querySelector('[data-gm-panel]').classList.remove('gm-open');
      return;
    }
    const act = e.target.closest('[data-gm-act]');
    if (!act) return;
    const k = act.dataset.gmAct;
    if (k === 'skip') skipIntro();
    else if (k === 'zin') zoomAt(cssW / 2, cssH / 2, S.zoom * 1.35);
    else if (k === 'zout') zoomAt(cssW / 2, cssH / 2, S.zoom / 1.35);
    else if (k === 'office') centerOn(16, 14);
    else if (k === 'finance') { if (S.zoom < 2) zoomAt(cssW / 2, cssH / 2, 2); centerOn(21.6, 12.4); }
    else if (k === 'panel') root.querySelector('[data-gm-panel]').classList.toggle('gm-open');
    else if (k === 'sound') {
      S.sound = !S.sound;
      if (S.sound && !AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (err) { S.sound = false; } }
      if (AC && AC.state === 'suspended') AC.resume();
      act.textContent = S.sound ? '🔊' : '🔇'; act.setAttribute('aria-pressed', String(S.sound));
      sound('blip');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (!root.isConnected || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    if (S.intro) { skipIntro(); return; }
    if (e.key === 'Escape') closeCard();
    else if (e.key === '+' || e.key === '=') zoomAt(cssW / 2, cssH / 2, S.zoom * 1.35);
    else if (e.key === '-') zoomAt(cssW / 2, cssH / 2, S.zoom / 1.35);
  });
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  else window.addEventListener('resize', resize);
}
function mount(view) {
  if (!root) build();
  if (root.parentNode !== view) { view.innerHTML = ''; view.append(root); }
  resize();
  if (!started) {
    started = true;
    buildStatic();
    if (document.fonts && document.fonts.load) document.fonts.load('8px "Press Start 2P"').then(buildStatic).catch(() => {});
    S.zoom = cssW >= 1100 ? 2 : cssW >= 700 ? 1.5 : 1;
    if (cssW >= 1000) centerOn(22.5, 15.5); else if (cssW >= 700) centerOn(20, 16); else centerOn(17.5, 14.5);
    let seen = false;
    try { seen = localStorage.getItem('gm.introSeen') === '1'; } catch (e) { /* без хранилища */ }
    startIntro(seen);
    S.quietSince = nowMs();
  }
  if (!running) { running = true; poll(); }
  if (!looping) { looping = true; last = 0; requestAnimationFrame(frame); }
}
window.STAFF_GAME = { mount };
})();
