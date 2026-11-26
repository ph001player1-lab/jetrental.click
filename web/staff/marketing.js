/*
 * Вкладка «Маркетинг» — игра-стратегия на карте Пхукета: источники клиентов на карте острова,
 * заявки едут (агенты), плывут (соцсети) и летят (реклама) в офис, над каждым
 * источником — табличка как у юнита в стратегии: уровень, «здоровье» (ответили
 * на заявки), «сила» (выручка) и цифры за сегодня и месяц. Только на русском.
 * Источники заводит и ставит на карту по сетке тот, у кого «Маркетинг: меняет».
 */
(function () {
  'use strict';

  const PERIODS = [['today', 'Сегодня'], ['week', '7 дней'], ['month', 'Месяц']];
  const CH = { site: 'Сайт (форма)', tg: 'Telegram', wa: 'WhatsApp', ig: 'Instagram', fb: 'Facebook' };
  const BOT_CH = ['tg', 'wa', 'ig', 'fb'];
  // WhatsApp отвечает бот на номере компании — его режим настраивается отдельно (окно «WhatsApp-бот»)
  const FORM_BOT_CH = BOT_CH.filter((c) => c !== 'wa');
  const COLORS = ['#e2557d', '#4b7bec', '#2ad4d0', '#25d366', '#ff8a1f', '#9b59b6', '#f1c40f', '#e74c3c', '#16a085', '#5d6d7e'];
  const ERRORS = {
    name_required: 'Укажите название.',
    invalid_code: 'Код ссылки: 3–24 латинские буквы, цифры, «-» или «_».',
    code_taken: 'Такой код уже есть у другого источника.',
    read_only: 'У вас «Маркетинг» только на просмотр.',
    bad_cell: 'Эта клетка вне карты.',
    not_found: 'Источник не найден — обновите страницу.'
  };

  // Карта: логические единицы 1000 × 720, сетка 25 × 18 клеток по 40
  const W = 1000;
  const H = 720;
  const CELL = 40;
  // Пхукет по координатам (1° ≈ 1447 ед.): север — сверху, Андаманское море — слева
  const ISLAND = [[433, 27], [455, 34], [491, 63], [534, 107], [578, 165], [614, 208], [636, 266], [629, 324], [614, 382], [602, 440], [585, 476],
    [600, 512], [592, 548], [611, 584], [600, 606], [563, 592], [534, 573], [506, 577], [513, 613], [491, 639], [469, 649], [443, 654], [448, 628],
    [440, 599], [435, 570], [430, 534], [411, 497], [435, 458], [400, 425], [414, 382], [406, 346], [433, 309], [419, 280], [400, 237], [433, 179],
    [423, 136], [416, 78]];
  const ISLETS = [[[622, 478], 11, 8], [[528, 612], 9, 6], [[545, 680], 8, 5], [[860, 190], 46, 70], [[835, 360], 34, 60], [[700, 560], 10, 7], [[300, 690], 16, 9]];
  const NODES = {
    north: [452, 48], mai: [490, 98], air: [504, 160], thalang: [534, 266], cherng: [484, 309], bangtao: [444, 317], kamala: [428, 382], kathu: [491, 440],
    patong: [448, 462], town: [571, 476], karon: [446, 534], chalong: [498, 534], kata: [450, 570], naiharn: [455, 628], rawai: [484, 630],
    panwa: [580, 590], hq: [572, 375],
    pPatong: [434, 460], pKata: [436, 572], pRawai: [492, 641], pTown: [588, 488], pChalong: [534, 575], pBay: [630, 362]
  };
  // Офис — на востоке острова, на шоссе между Талангом и Пхукет-Тауном, у него свой причал
  const EDGES = [['north', 'mai'], ['mai', 'air'], ['air', 'cherng'], ['cherng', 'thalang'], ['cherng', 'bangtao'], ['cherng', 'kathu'], ['thalang', 'hq'],
    ['hq', 'town'], ['kathu', 'town'], ['kathu', 'patong'], ['bangtao', 'kamala'], ['kamala', 'patong'], ['patong', 'karon'], ['karon', 'kata'], ['kata', 'naiharn'],
    ['naiharn', 'rawai'], ['rawai', 'chalong'], ['kata', 'chalong'], ['karon', 'chalong'], ['kathu', 'chalong'], ['town', 'chalong'],
    ['town', 'panwa'], ['chalong', 'pChalong'], ['hq', 'pBay'], ['patong', 'pPatong'], ['kata', 'pKata'], ['rawai', 'pRawai'], ['town', 'pTown']];
  const ROAD_NODES = Object.keys(NODES).filter((n) => !/^p[A-Z]/.test(n) && n !== 'north');
  const PIERS = { west: ['pPatong', 'pKata', 'pRawai'], east: ['pBay', 'pTown', 'pChalong'] };
  const HEIGHT = { site: 56, social: 36, ads: 46, maps: 52, messenger: 26, agent: 24, partner: 34, agency: 44, word: 22, other: 26 };

  const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const num = (n) => fmt.format(Math.round(n || 0));
  const baht = (n) => `${num(n)} ฿`;
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} млн` : n >= 1e4 ? `${Math.round(n / 1000)}к` : num(n));
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const roiOf = (m) => (m.cost ? m.revenue / m.cost : null);
  const roiText = (r) => (r === null ? '—' : `×${r.toFixed(r >= 10 ? 0 : 1).replace('.', ',')}`);
  const roiTone = (r) => (r === null || r >= 4 ? 'good' : r >= 1.5 ? 'warn' : 'bad');

  function create(ctx) {
    const { api, esc } = ctx;
    const st = {
      period: 'month', data: null, failed: null, view: 'map', selected: 'hq', editing: null, placing: null, msg: null,
      sky: 'auto', hover: null, delAsk: false, wabot: null
    };
    const canEdit = () => Boolean(st.data?.canEdit);
    const sources = () => (st.data?.sources || []);
    const byId = (id) => sources().find((s) => String(s.id) === String(id));
    const botShare = (s) => {
      const bots = st.data?.settings?.bots || {};
      const chans = s.channels.filter((c) => c !== 'site');
      return chans.length ? chans.filter((c) => bots[c]).length / chans.length : null;
    };

    /* ============================================================ Данные */

    async function load() {
      try {
        const [data, wabot] = await Promise.all([api(`/marketing?period=${st.period}`), api('/wabot').catch(() => null)]);
        st.data = data;
        st.wabot = wabot;
        st.failed = null;
        buildRoutes();
      } catch (err) {
        st.failed = err.code === 'no_section_access' ? 'Раздел «Маркетинг» для вас закрыт.' : 'Не удалось загрузить данные. Обновите страницу.';
      }
      ctx.rerender();
    }

    async function call(path, body, okText) {
      try {
        const r = await api(path, { body });
        st.msg = okText ? { kind: 'ok', text: okText } : null;
        await load();
        return r;
      } catch (err) {
        st.msg = { kind: 'error', text: ERRORS[err.code] || 'Не получилось. Попробуйте ещё раз.' };
        refreshPanel();
        return null;
      }
    }

    /* ======================================================= Геометрия карты */

    const posOf = (s) => (s.col === null || s.col === undefined ? null : [s.col * CELL + CELL / 2, s.row * CELL + CELL / 2]);
    function isLand([x, y]) {
      let inside = false;
      for (let i = 0, j = ISLAND.length - 1; i < ISLAND.length; j = i++) {
        const [xi, yi] = ISLAND[i];
        const [xj, yj] = ISLAND[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const nearest = (p, names) => names.reduce((best, n) => (dist(p, NODES[n]) < dist(p, NODES[best]) ? n : best), names[0]);

    // Кратчайший путь по дорогам до офиса (Дейкстра на двух десятках узлов)
    const adj = {};
    for (const [a, b] of EDGES) { (adj[a] ||= []).push(b); (adj[b] ||= []).push(a); }
    function roadPath(from) {
      const d = { [from]: 0 };
      const prev = {};
      const left = new Set(Object.keys(NODES));
      while (left.size) {
        let u = null;
        for (const n of left) if (d[n] !== undefined && (u === null || d[n] < d[u])) u = n;
        if (u === null || u === 'hq') break;
        left.delete(u);
        for (const v of adj[u] || []) {
          const alt = d[u] + dist(NODES[u], NODES[v]);
          if (d[v] === undefined || alt < d[v]) { d[v] = alt; prev[v] = u; }
        }
      }
      const path = ['hq'];
      while (path[0] !== from && prev[path[0]]) path.unshift(prev[path[0]]);
      return path.map((n) => NODES[n]);
    }
    function arc(a, b, lift) {
      const c = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - lift];
      const out = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        out.push([(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]);
      }
      return out;
    }

    /** Маршрут источника: реклама — самолётом в аэропорт; с моря — лодкой к пирсу; с суши — по дорогам */
    function buildRoutes() {
      for (const s of sources()) {
        const p = posOf(s);
        s.parts = null;
        if (!p || !s.active) continue;
        const parts = [];
        if (s.kind === 'ads') {
          parts.push({ mode: 'air', pts: arc(p, NODES.air, 40) });
          parts.push({ mode: 'land', pts: roadPath('air') });
        } else if (isLand(p)) {
          const n = nearest(p, ROAD_NODES);
          if (n !== 'hq' && dist(p, NODES.hq) > dist(p, NODES[n])) {
            parts.push({ mode: 'land', pts: [p, NODES[n]], local: true });
            parts.push({ mode: 'land', pts: roadPath(n) });
          } else parts.push({ mode: 'land', pts: [p, NODES.hq], local: true });
        } else {
          const pier = nearest(p, p[0] < 520 ? PIERS.west : PIERS.east);
          parts.push({ mode: 'sea', pts: [p, NODES[pier]] });
          const road = { pPatong: 'patong', pKata: 'kata', pRawai: 'rawai', pTown: 'town', pChalong: 'chalong', pBay: 'hq' }[pier];
          parts.push({ mode: 'land', pts: [NODES[pier], ...(road === 'hq' ? [NODES.hq] : roadPath(road))] });
        }
        const segs = [];
        for (const part of parts) for (let i = 0; i < part.pts.length - 1; i++) {
          const a = part.pts[i]; const b = part.pts[i + 1];
          const len = dist(a, b);
          if (len > 0.5) segs.push({ a, b, len, mode: part.mode });
        }
        s.parts = parts;
        s.segs = segs;
        s.total = segs.reduce((sum, x) => sum + x.len, 0);
      }
      staticDirty = true;
    }
    function pointAt(s, d) {
      let rest = Math.max(0, Math.min(d, s.total));
      for (const seg of s.segs) {
        if (rest <= seg.len) {
          const t = rest / seg.len;
          return { x: seg.a[0] + (seg.b[0] - seg.a[0]) * t, y: seg.a[1] + (seg.b[1] - seg.a[1]) * t, ang: Math.atan2(seg.b[1] - seg.a[1], seg.b[0] - seg.a[0]), mode: seg.mode };
        }
        rest -= seg.len;
      }
      const last = s.segs[s.segs.length - 1];
      return { x: last.b[0], y: last.b[1], ang: 0, mode: last.mode };
    }

    /* ============================================================ Рисование */

    let canvas = null;
    let g = null;
    const bg = document.createElement('canvas');
    let staticDirty = true;
    let dpr = 1;
    let k = 1;
    let VB = { x: 0, y: 0, w: W, h: H };
    let running = false;
    let last = 0;
    let clock = 0;
    let acc = 0;
    const cars = [];
    const pops = [];
    let lights = [];
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rng = (seed) => { let x = seed; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; };

    function closed(c, pts) {
      const n = pts.length;
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n]; const p1 = pts[i]; const p2 = pts[(i + 1) % n]; const p3 = pts[(i + 2) % n];
        c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
      }
      c.closePath();
    }
    function line(c, pts) {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.stroke();
    }
    const view = (c) => c.setTransform(dpr * k, 0, 0, dpr * k, -VB.x * dpr * k, -VB.y * dpr * k);

    function drawStatic() {
      const c = bg.getContext('2d');
      view(c);
      // Море с глубиной у берега
      const sea = c.createRadialGradient(520, 360, 60, 520, 360, 640);
      sea.addColorStop(0, '#3fa7b5');
      sea.addColorStop(0.45, '#1b7690');
      sea.addColorStop(1, '#0c3a52');
      c.fillStyle = sea;
      c.fillRect(-50, -50, W + 100, H + 100);
      const r = rng(11);
      c.strokeStyle = 'rgba(255, 255, 255, .09)';
      c.lineWidth = 1.2;
      for (let i = 0; i < 110; i++) { const x = r() * W; const y = r() * H; c.beginPath(); c.arc(x, y, 6, Math.PI * 1.15, Math.PI * 1.85); c.stroke(); }
      // Материк Пханг-Нга на севере, острова залива
      c.fillStyle = '#5e9440';
      c.beginPath(); c.moveTo(380, -10); c.lineTo(1010, -10); c.lineTo(1010, 70); c.quadraticCurveTo(880, 44, 760, 30); c.quadraticCurveTo(620, 22, 500, 12); c.quadraticCurveTo(440, 6, 380, -10); c.fill();
      for (const [[x, y], rx, ry] of ISLETS) {
        c.fillStyle = '#e7cf98'; c.beginPath(); c.ellipse(x, y, rx + 3, ry + 3, 0.4, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#7fb257'; c.beginPath(); c.ellipse(x, y, rx, ry, 0.4, 0, Math.PI * 2); c.fill();
      }
      // Пхукет: тень, песок, трава с рельефом
      c.save(); c.shadowColor = 'rgba(0, 0, 0, .35)'; c.shadowBlur = 26; c.shadowOffsetY = 6;
      closed(c, ISLAND); c.fillStyle = '#ecd39b'; c.fill(); c.restore();
      c.lineWidth = 12; c.strokeStyle = '#ecd39b'; closed(c, ISLAND); c.stroke();
      c.save(); closed(c, ISLAND); c.clip();
      const grass = c.createLinearGradient(0, 30, 0, 660);
      grass.addColorStop(0, '#93c463'); grass.addColorStop(1, '#6ea24a');
      c.fillStyle = grass;
      closed(c, ISLAND.map(([x, y]) => [x + (520 - x) * 0.04, y + (340 - y) * 0.018])); c.fill();
      // Холмы (в центре острова и у Патонга)
      for (const [x, y, rx, ry] of [[470, 350, 34, 70], [520, 410, 24, 30], [560, 250, 30, 46], [470, 500, 22, 30], [472, 600, 16, 20]]) {
        const h = c.createRadialGradient(x - rx * 0.3, y - ry * 0.3, 2, x, y, Math.max(rx, ry));
        h.addColorStop(0, 'rgba(60, 110, 40, .55)'); h.addColorStop(1, 'rgba(60, 110, 40, 0)');
        c.fillStyle = h; c.beginPath(); c.ellipse(x, y, rx, ry, 0.2, 0, Math.PI * 2); c.fill();
      }
      c.restore();
      // Пальмы вдоль пляжей
      const pr = rng(5);
      for (let i = 0; i < 40; i++) {
        const p = ISLAND[20 + Math.floor(pr() * 17)];
        const x = p[0] + 10 + pr() * 10; const y = p[1] + (pr() - 0.5) * 24;
        if (!isLand([x, y])) continue;
        c.fillStyle = 'rgba(0, 0, 0, .18)'; c.beginPath(); c.ellipse(x + 2, y + 2, 3.5, 2, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#3f7d2e'; c.beginPath(); c.arc(x, y, 3.2, 0, Math.PI * 2); c.fill();
      }
      // Дороги: обочина, асфальт, разметка
      c.lineCap = 'round'; c.lineJoin = 'round';
      const edges = EDGES.map(([a, b]) => [NODES[a], NODES[b]]);
      for (const local of sources().filter((s) => s.parts).flatMap((s) => s.parts.filter((p) => p.local))) edges.push(local.pts);
      c.lineWidth = 10; c.strokeStyle = '#8b806c'; for (const e of edges) line(c, e);
      c.lineWidth = 7; c.strokeStyle = '#d8cdb8'; for (const e of edges) line(c, e);
      c.setLineDash([4, 7]); c.lineWidth = 1; c.strokeStyle = 'rgba(255, 255, 255, .85)'; for (const e of edges) line(c, e); c.setLineDash([]);
      // Морские и воздушные пути
      for (const s of sources()) for (const part of s.parts || []) {
        if (part.mode === 'sea') { c.setLineDash([6, 9]); c.lineWidth = 2; c.strokeStyle = 'rgba(255, 255, 255, .45)'; line(c, part.pts); }
        if (part.mode === 'air') { c.setLineDash([2, 9]); c.lineWidth = 2.4; c.strokeStyle = 'rgba(255, 255, 255, .55)'; line(c, part.pts); }
        c.setLineDash([]);
      }
      // Пирсы, аэропорт, мост Сарасин
      c.fillStyle = '#a47f50';
      for (const n of [...PIERS.west, ...PIERS.east]) { const [x, y] = NODES[n]; c.fillRect(x - 9, y - 2.5, 18, 5); }
      c.strokeStyle = '#d8cdb8'; c.lineWidth = 4; line(c, [[452, 48], [470, 6]]);
      // Взлётная полоса аэропорта — с запада на восток, западный конец у пляжа
      c.save(); c.translate(462, 150);
      c.fillStyle = '#4b5560'; c.fillRect(-30, -6, 60, 12);
      c.fillStyle = '#fff'; for (const ex of [-27, 25]) for (let i = 0; i < 3; i++) c.fillRect(ex, -4.5 + i * 3.5, 2, 2);
      c.setLineDash([6, 6]); c.strokeStyle = '#fff'; c.lineWidth = 1.2; line(c, [[-20, 0], [20, 0]]); c.setLineDash([]);
      c.restore();
      c.fillStyle = '#e9e3d6'; c.fillRect(494, 162, 16, 8);
      // Подписи районов и морей
      c.font = '500 10.5px system-ui, sans-serif'; c.textBaseline = 'middle';
      c.fillStyle = 'rgba(25, 55, 20, .7)';
      for (const [t, x, y] of [['Аэропорт', 434, 166], ['Таланг', 548, 280], ['Банг Тао', 452, 300], ['Патонг', 456, 476], ['Карон', 456, 522], ['Ката', 456, 584],
        ['Пхукет-Таун', 528, 490], ['Чалонг', 470, 548], ['Раваи', 480, 616], ['Панва', 572, 604]]) { c.textAlign = 'left'; c.fillText(t, x, y); }
      c.font = 'italic 500 13px system-ui, sans-serif'; c.fillStyle = 'rgba(255, 255, 255, .38)'; c.textAlign = 'center';
      c.fillText('Андаманское море', 190, 700); c.fillText('Залив Пханг-Нга', 860, 300);
      staticDirty = false;
    }

    /* ----------------------------------------------------------- Объём */

    // Наклонная проекция: глубина уходит вверх-вправо
    const DX = 0.55;
    const DY = -0.42;
    function shade(hex, f) {
      const n = parseInt(hex.slice(1), 16);
      const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
      return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
    }
    function box(c, x, y, w, d, h, color) {
      const dx = d * DX; const dy = d * DY;
      c.fillStyle = 'rgba(0, 0, 0, .22)';
      c.beginPath(); c.moveTo(x - w / 2 - 3, y + 2); c.lineTo(x + w / 2 + dx + 6, y + dy + 2); c.lineTo(x + w / 2 + dx + 14, y + dy + 8); c.lineTo(x - w / 2 + 6, y + 8); c.closePath(); c.fill();
      c.fillStyle = shade(color, 0.72);
      c.beginPath(); c.moveTo(x + w / 2, y); c.lineTo(x + w / 2 + dx, y + dy); c.lineTo(x + w / 2 + dx, y + dy - h); c.lineTo(x + w / 2, y - h); c.closePath(); c.fill();
      c.fillStyle = shade(color, 1.12);
      c.beginPath(); c.moveTo(x - w / 2, y - h); c.lineTo(x + w / 2, y - h); c.lineTo(x + w / 2 + dx, y + dy - h); c.lineTo(x - w / 2 + dx, y + dy - h); c.closePath(); c.fill();
      c.fillStyle = color;
      c.fillRect(x - w / 2, y - h, w, h);
    }
    function windows(c, x, y, w, h, cols, rows, lit = '#ffd76a') {
      const gw = (w - 6) / cols; const gh = (h - 8) / rows;
      for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
        const wx = x - w / 2 + 3 + q * gw + gw * 0.2; const wy = y - h + 4 + r * gh + gh * 0.2;
        c.fillStyle = 'rgba(40, 70, 95, .85)';
        c.fillRect(wx, wy, gw * 0.6, gh * 0.55);
        if ((r * 7 + q * 3) % 4 !== 0) lights.push(['rect', wx, wy, gw * 0.6, gh * 0.55, lit]);
      }
    }
    function roof(c, x, y, w, d, h, color) {
      const dx = d * DX; const dy = d * DY;
      const top = y - h;
      c.fillStyle = color;
      c.beginPath(); c.moveTo(x - w / 2 - 2, top); c.lineTo(x + w / 2 + 2, top); c.lineTo(x + dx / 2 + 2, top + dy / 2 - 11); c.lineTo(x - w / 2 + dx / 2 - 2, top + dy / 2 - 11); c.closePath(); c.fill();
      c.fillStyle = shade(color, 0.75);
      c.beginPath(); c.moveTo(x + w / 2 + 2, top); c.lineTo(x + w / 2 + dx + 2, top + dy); c.lineTo(x + dx / 2 + 2, top + dy / 2 - 11); c.closePath(); c.fill();
    }

    function drawUnit(c, s, x, y, hot) {
      c.save();
      if (hot) {
        c.strokeStyle = 'rgba(255, 213, 74, .85)'; c.lineWidth = 2;
        c.beginPath(); c.ellipse(x + 4, y + 2, 26, 11, 0, 0, Math.PI * 2); c.stroke();
      }
      const color = s.color || COLORS[s.id % COLORS.length];
      switch (s.kind) {
        case 'site': {
          box(c, x, y, 20, 14, 50, '#6fa3c7');
          windows(c, x, y, 20, 50, 2, 6, '#bfe8ff');
          c.strokeStyle = '#e9eef0'; c.lineWidth = 1.6; line(c, [[x + 3, y - 54], [x + 3, y - 66]]);
          const blink = Math.sin(clock * 4) > 0;
          c.fillStyle = blink ? '#ff5a4e' : '#7a2a26'; c.beginPath(); c.arc(x + 3, y - 67, 2.2, 0, Math.PI * 2); c.fill();
          if (blink) lights.push(['glow', x + 3, y - 67, 9, '#ff5a4e']);
          break;
        }
        case 'social': {
          c.fillStyle = 'rgba(0, 0, 0, .25)'; c.beginPath(); c.ellipse(x + 4, y + 4, 24, 8, 0, 0, Math.PI * 2); c.fill();
          c.strokeStyle = '#6b7780'; c.lineWidth = 2; for (const lx of [-14, 14]) line(c, [[x + lx, y + 3], [x + lx, y - 4]]);
          box(c, x, y - 4, 34, 18, 6, '#c9d3d6');
          c.strokeStyle = '#8a969c'; c.lineWidth = 2; line(c, [[x, y - 10], [x, y - 22]]);
          c.fillStyle = color; c.beginPath(); c.arc(x, y - 32, 13, 0, Math.PI * 2); c.fill();
          c.fillStyle = shade(color, 0.7); c.beginPath(); c.arc(x + 2, y - 31, 13, -0.3, 1.2); c.lineTo(x, y - 32); c.fill();
          c.fillStyle = '#fff'; c.font = '800 11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s.badge || 'SM', x, y - 32);
          lights.push(['glow', x, y - 32, 18, color]);
          break;
        }
        case 'ads': {
          const bob = Math.sin(clock * 1.6 + s.id) * 3;
          c.fillStyle = 'rgba(0, 0, 0, .2)'; c.beginPath(); c.ellipse(x + 8, y + 6, 22, 6, 0, 0, Math.PI * 2); c.fill();
          const by = y - 34 + bob;
          c.fillStyle = color; c.beginPath(); c.ellipse(x, by, 24, 11, 0, 0, Math.PI * 2); c.fill();
          c.fillStyle = shade(color, 1.25); c.beginPath(); c.ellipse(x - 4, by - 4, 16, 5, 0, 0, Math.PI * 2); c.fill();
          c.fillStyle = shade(color, 0.7); c.beginPath(); c.moveTo(x - 22, by); c.lineTo(x - 32, by - 8); c.lineTo(x - 30, by + 8); c.closePath(); c.fill();
          c.fillStyle = '#2b2f33'; c.fillRect(x - 6, by + 10, 12, 5);
          c.fillStyle = '#fff'; c.font = '800 10px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s.badge || 'AD', x + 2, by);
          lights.push(['glow', x, by + 14, 8, '#ffd76a']);
          break;
        }
        case 'maps': {
          c.fillStyle = '#7d7368'; c.beginPath(); c.ellipse(x, y, 16, 7, 0, 0, Math.PI * 2); c.fill();
          for (let i = 0; i < 5; i++) {
            const w0 = 14 - i * 1.6;
            c.fillStyle = i % 2 ? '#e84a3c' : '#f5f2ec';
            c.fillRect(x - w0 / 2, y - 8 - i * 8, w0, 8);
          }
          c.fillStyle = '#2b2f33'; c.fillRect(x - 5, y - 52, 10, 4);
          c.fillStyle = '#ffd76a'; c.fillRect(x - 3.5, y - 49, 7, 6);
          // Знак «булавка» Google Карт
          c.fillStyle = '#34a853'; c.beginPath(); c.arc(x + 16, y - 46, 6, Math.PI, 0); c.lineTo(x + 16, y - 36); c.closePath(); c.fill();
          lights.push(['beam', x, y - 46, clock]);
          break;
        }
        case 'messenger': {
          box(c, x, y, 26, 18, 14, '#f4efe6');
          roof(c, x, y, 26, 18, 14, '#d2694a');
          c.fillStyle = color; c.beginPath(); c.arc(x + 15, y - 30, 7, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#fff'; c.font = '700 7px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s.badge || 'WA', x + 15, y - 30);
          windows(c, x, y, 26, 14, 2, 1);
          break;
        }
        case 'agent': {
          // Человечек-юнит на подставке, цвет подставки — уровень
          const ring = s.level >= 4 ? '#ffd54a' : s.level >= 2 ? '#c0c8cc' : '#b07a4a';
          c.fillStyle = 'rgba(0, 0, 0, .25)'; c.beginPath(); c.ellipse(x + 3, y + 3, 13, 5, 0, 0, Math.PI * 2); c.fill();
          c.fillStyle = ring; c.beginPath(); c.ellipse(x, y, 12, 5, 0, 0, Math.PI * 2); c.fill();
          c.fillStyle = shade(color, 0.8); c.fillRect(x - 4, y - 9, 3, 8); c.fillRect(x + 1, y - 9, 3, 8);
          c.fillStyle = color; c.beginPath(); c.roundRect ? c.roundRect(x - 6, y - 21, 12, 13, 4) : c.rect(x - 6, y - 21, 12, 13); c.fill();
          c.fillStyle = '#f0c8a0'; c.beginPath(); c.arc(x, y - 25, 5, 0, Math.PI * 2); c.fill();
          c.fillStyle = shade(color, 0.6); c.beginPath(); c.arc(x, y - 27, 5.2, Math.PI, 0); c.fill(); c.fillRect(x, y - 28, 7, 2);
          break;
        }
        case 'partner': {
          box(c, x, y, 28, 18, 30, '#f2ede4');
          windows(c, x, y, 28, 30, 3, 3);
          c.fillStyle = color; c.fillRect(x - 15, y - 33, 30, 4);
          break;
        }
        case 'agency': {
          box(c, x, y, 22, 16, 42, '#c7d3da');
          windows(c, x, y, 22, 42, 2, 5);
          c.fillStyle = color; c.fillRect(x - 11, y - 46, 22, 4);
          break;
        }
        case 'word': {
          for (const [hx, rc] of [[-9, '#d2694a'], [9, color]]) { box(c, x + hx, y, 14, 10, 10, '#f4efe6'); roof(c, x + hx, y, 14, 10, 10, rc); }
          c.fillStyle = '#ff5a4e'; c.beginPath(); c.moveTo(x, y - 25); c.bezierCurveTo(x - 6, y - 31, x - 11, y - 24, x, y - 17); c.bezierCurveTo(x + 11, y - 24, x + 6, y - 31, x, y - 25); c.fill();
          break;
        }
        default: {
          box(c, x, y, 24, 16, 18, '#efe6d6');
          c.fillStyle = color; c.beginPath(); c.moveTo(x - 14, y - 18); c.lineTo(x + 14, y - 18); c.lineTo(x + 12, y - 12); c.lineTo(x - 12, y - 12); c.closePath(); c.fill();
          windows(c, x, y, 24, 18, 2, 1);
        }
      }
      c.restore();
    }

    function drawHQ(c) {
      const [x, y] = NODES.hq;
      box(c, x, y + 6, 60, 26, 28, '#2a3238');
      c.fillStyle = '#ff8a1f'; c.fillRect(x - 31, y - 28, 62, 10);
      c.fillStyle = '#1d0e00'; c.font = '800 8.5px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('JET MOBILITY', x, y - 23);
      for (const gx of [-19, 0, 19]) {
        c.fillStyle = '#46525a'; c.fillRect(x + gx - 8, y - 14, 16, 20);
        c.fillStyle = 'rgba(255, 255, 255, .12)'; for (let i = 0; i < 4; i++) c.fillRect(x + gx - 8, y - 12 + i * 5, 16, 1);
        lights.push(['rect', x + gx - 8, y - 14, 16, 3, '#ffd76a']);
      }
    }

    /* ------------------------------------------------- Табличка юнита */

    function heart(c, x, y, s, col) {
      c.fillStyle = col; c.beginPath(); c.moveTo(x, y + s * 0.3);
      c.bezierCurveTo(x - s, y - s * 0.5, x - s * 0.4, y - s * 1.1, x, y - s * 0.45);
      c.bezierCurveTo(x + s * 0.4, y - s * 1.1, x + s, y - s * 0.5, x, y + s * 0.3); c.fill();
    }
    function bolt(c, x, y, s, col) {
      c.fillStyle = col; c.beginPath(); c.moveTo(x + s * 0.2, y - s); c.lineTo(x - s * 0.5, y + s * 0.1); c.lineTo(x, y + s * 0.1);
      c.lineTo(x - s * 0.2, y + s); c.lineTo(x + s * 0.5, y - s * 0.1); c.lineTo(x, y - s * 0.1); c.closePath(); c.fill();
    }
    function bar(c, x, y, w, h, v, col) {
      c.fillStyle = 'rgba(255, 255, 255, .14)'; c.fillRect(x, y, w, h);
      if (v > 0) { c.fillStyle = col; c.fillRect(x, y, Math.max(1.5, w * Math.min(1, v)), h); }
    }
    // Табличка одного размера на экране при любом масштабе карты
    const plateScale = () => Math.max(1, 0.95 / k);
    const plateSize = (full) => ({ w: (full ? 116 : 56) * plateScale(), h: (full ? 46 : 24) * plateScale() });
    function plate(c, s, x, topY, full, maxRev) {
      const S = plateScale();
      c.save();
      c.translate(x, topY);
      c.scale(S, S);
      const w = full ? 116 : 56;
      const h = full ? 46 : 24;
      const sel = String(s.id) === String(st.selected);
      c.fillStyle = sel ? 'rgba(46, 32, 6, .92)' : 'rgba(10, 24, 34, .86)';
      c.strokeStyle = sel ? '#ffd54a' : 'rgba(255, 255, 255, .18)';
      c.lineWidth = 1;
      c.beginPath(); c.roundRect ? c.roundRect(-w / 2, -h, w, h, 6) : c.rect(-w / 2, -h, w, h); c.fill(); c.stroke();
      c.fillStyle = sel ? '#ffd54a' : 'rgba(10, 24, 34, .86)';
      c.beginPath(); c.moveTo(-5, 0); c.lineTo(5, 0); c.lineTo(0, 5); c.closePath(); c.fill();
      // Уровень
      const lx = -w / 2 + 11; const ly = -h + 11;
      c.fillStyle = s.level >= 4 ? '#ffd54a' : s.level >= 2 ? '#c9d2d6' : '#c88a54';
      c.beginPath(); c.arc(lx, ly, 8, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#1b1405'; c.font = '800 9px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(s.level), lx, ly + 0.5);
      const m = s.month;
      const health = s.health === null ? null : s.health / 100;
      const hpCol = health === null ? '#5c6d75' : health >= 0.8 ? '#3ddc84' : health >= 0.5 ? '#ffc23d' : '#ff5a4e';
      if (full) {
        c.textAlign = 'left'; c.fillStyle = '#eef6f6'; c.font = '600 10px system-ui, sans-serif';
        let name = s.name;
        while (c.measureText(name).width > w - 28 && name.length > 3) name = `${name.slice(0, -2)}…`;
        c.fillText(name, lx + 11, ly);
        heart(c, -w / 2 + 8, -h + 25, 3.4, hpCol); bar(c, -w / 2 + 14, -h + 22, w - 22, 4, health === null ? 0 : health, hpCol);
        bolt(c, -w / 2 + 8, -h + 31, 3.4, '#ff8a1f'); bar(c, -w / 2 + 14, -h + 29, w - 22, 4, maxRev ? m.revenue / maxRev : 0, '#ff8a1f');
        c.fillStyle = '#b9ccd2'; c.font = '500 8.5px system-ui, sans-serif'; c.textBaseline = 'middle';
        c.fillText(`сег ${s.today.leads} · мес ${m.leads} · ${short(m.revenue)} ฿`, -w / 2 + 6, -h + 40);
      } else {
        bar(c, lx + 10, ly - 4, w - 26, 3.5, health === null ? 0 : health, hpCol);
        bar(c, lx + 10, ly + 2, w - 26, 3.5, maxRev ? m.revenue / maxRev : 0, '#ff8a1f');
      }
      c.restore();
      return { x: x - (w * S) / 2, y: topY - h * S, w: w * S, h: h * S };
    }

    /* ------------------------------------------------ Время суток */

    function skyState() {
      if (st.sky === 'day') return { dark: 0, tint: null, phase: 'day' };
      if (st.sky === 'night') return { dark: 0.55, tint: '#0a1440', phase: 'night' };
      const now = new Date(Date.now() + 7 * 3600000);
      const h = now.getUTCHours() + now.getUTCMinutes() / 60;
      if (h >= 7 && h < 17.5) return { dark: 0, tint: null, phase: 'day' };
      if (h >= 17.5 && h < 19.5) { const t = (h - 17.5) / 2; return { dark: 0.15 + t * 0.4, tint: t < 0.5 ? '#7a3a20' : '#2a1d55', phase: 'dusk' }; }
      if (h >= 5.5 && h < 7) { const t = (7 - h) / 1.5; return { dark: 0.1 + t * 0.4, tint: '#6a4060', phase: 'dawn' }; }
      return { dark: 0.55, tint: '#0a1440', phase: 'night' };
    }

    /* ------------------------------------------------ Машины, лодки, самолёты */

    const SPEED = { land: 58, sea: 38, air: 150 };
    function spawn() {
      const list = sources().filter((s) => s.segs?.length && s.month.leads > 0);
      if (!list.length) return;
      let r = Math.random() * list.reduce((a, s) => a + s.month.leads, 0);
      let s = list[0];
      for (const x of list) { r -= x.month.leads; if (r <= 0) { s = x; break; } }
      const m = s.metrics.leads ? s.metrics : { leads: 1, answered: 1, paid: 0 };
      const share = botShare(s) ?? 0;
      const waitP = ((m.leads - m.answered) / m.leads) * (1 - share * 0.85);
      const paidP = m.leads ? m.paid / m.leads : 0;
      const x = Math.random();
      const outcome = x < waitP ? 'wait' : x < waitP + paidP ? 'paid' : 'lost';
      const queue = outcome === 'wait' ? cars.filter((c) => c.s === s && c.outcome === 'wait').length : 0;
      cars.push({ s, d: 0, outcome, queue, waitT: 0, fade: 1 });
    }
    function update(dt) {
      for (const c of cars) {
        const stop = c.outcome === 'wait' ? Math.max(0, c.s.total - 36 - c.queue * 11) : c.s.total;
        if (c.d < stop) c.d = Math.min(stop, c.d + SPEED[pointAt(c.s, c.d).mode] * dt);
        else if (c.outcome === 'wait') { c.waitT += dt; if (c.waitT > 7) c.fade -= dt * 1.2; }
        else if (c.outcome === 'paid' && !c.popped) {
          c.popped = true;
          const check = c.s.month.paid ? c.s.month.revenue / c.s.month.paid : 0;
          if (check) pops.push({ text: `+${short(Math.round(check / 100) * 100)} ฿`, t: 0 });
          c.fade = 0;
        } else c.fade -= dt * 1.6;
      }
      for (let i = cars.length - 1; i >= 0; i--) if (cars[i].fade <= 0) cars.splice(i, 1);
      for (const p of pops) p.t += dt;
      for (let i = pops.length - 1; i >= 0; i--) if (pops[i].t > 1.4) pops.splice(i, 1);
    }
    function carColor(c) {
      const p = c.d / c.s.total;
      if (c.outcome === 'paid' && p > 0.55) return '#3ddc84';
      if (c.outcome === 'lost' && p > 0.9) return '#8aa0aa';
      if (c.outcome === 'wait' && c.d >= c.s.total - 40 - c.queue * 11) return c.waitT > 3.5 ? '#ff5a4e' : '#ffc23d';
      return '#ffffff';
    }
    function drawVehicle(c, v) {
      const p = pointAt(v.s, v.d);
      c.save();
      c.globalAlpha = Math.max(0, Math.min(1, v.fade));
      c.translate(p.x, p.y);
      c.rotate(p.ang);
      const col = carColor(v);
      if (p.mode === 'sea') {
        c.strokeStyle = 'rgba(255, 255, 255, .55)'; c.lineWidth = 1;
        line(c, [[-9, -2], [-15, -4]]); line(c, [[-9, 2], [-15, 4]]);
        c.fillStyle = col; c.beginPath(); c.moveTo(-8, -3.5); c.lineTo(5, -3.5); c.lineTo(9, 0); c.lineTo(5, 3.5); c.lineTo(-8, 3.5); c.closePath(); c.fill();
      } else if (p.mode === 'air') {
        c.fillStyle = col;
        c.beginPath(); c.moveTo(9, 0); c.lineTo(-7, -1.6); c.lineTo(-7, 1.6); c.closePath(); c.fill();
        c.beginPath(); c.moveTo(2, 0); c.lineTo(-3, -8); c.lineTo(-5, -8); c.lineTo(-2, 0); c.lineTo(-5, 8); c.lineTo(-3, 8); c.closePath(); c.fill();
      } else {
        c.fillStyle = 'rgba(0, 0, 0, .25)'; c.fillRect(-5.5, -2, 12, 7);
        c.fillStyle = col; c.beginPath(); c.roundRect ? c.roundRect(-6.5, -4, 13, 8, 2.2) : c.rect(-6.5, -4, 13, 8); c.fill();
        c.fillStyle = 'rgba(20, 40, 55, .75)'; c.fillRect(2, -3, 2.6, 6);
      }
      c.restore();
      lights.push(['glow', p.x + Math.cos(p.ang) * 9, p.y + Math.sin(p.ang) * 9, 7, '#fff3c0']);
    }

    /* ------------------------------------------- Живое море (видно и днём) */

    // Бегущие барашки волн: только в море, медленно дрейфуют на восток и мерцают
    const WAVES = (() => {
      const r = rng(29);
      const out = [];
      while (out.length < 80) {
        const p = [r() * W, 80 + r() * (H - 80)];
        if (!isLand(p)) out.push({ x: p[0], y: p[1], ph: r() * Math.PI * 2, sp: 3 + r() * 5, sz: 5 + r() * 4 });
      }
      return out;
    })();
    // Прибой — линия чуть мористее песка
    const SURF = ISLAND.map(([x, y]) => { const d = Math.hypot(x - 520, y - 340) || 1; return [x + ((x - 520) / d) * 9, y + ((y - 340) / d) * 9]; });
    // Парусники ходят по кругу в Андаманском море и в заливе
    const YACHTS = [[300, 560, 62, 22, 0.05, '#ffffff'], [330, 190, 46, 22, -0.06, '#ffe2a8'], [730, 520, 56, 30, 0.045, '#ffffff'], [740, 240, 40, 46, -0.04, '#c9f1ff']];
    function drawSea(c, day) {
      c.save();
      c.lineCap = 'round';
      for (const w of WAVES) {
        const x = ((w.x + clock * w.sp) % (W + 40)) - 20;
        const y = w.y + Math.sin(clock * 0.8 + w.ph) * 2;
        if (isLand([x, y]) || isLand([x + 8, y])) continue;
        c.globalAlpha = 0.12 + 0.22 * (0.5 + 0.5 * Math.sin(clock * 1.4 + w.ph));
        c.strokeStyle = '#ffffff'; c.lineWidth = 1.4;
        c.beginPath(); c.arc(x, y, w.sz, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
      }
      c.globalAlpha = 0.3 + 0.2 * Math.sin(clock * 1.2);
      c.strokeStyle = '#ffffff'; c.lineWidth = 2; c.setLineDash([12, 16]); c.lineDashOffset = -clock * 7;
      closed(c, SURF); c.stroke(); c.setLineDash([]);
      c.globalAlpha = 1;
      for (const [cx, cy, rx, ry, sp, sail] of YACHTS) {
        const a = clock * sp * 6;
        const x = cx + Math.cos(a) * rx; const y = cy + Math.sin(a) * ry;
        const dir = Math.atan2(Math.cos(a) * ry * Math.sign(sp), -Math.sin(a) * rx * Math.sign(sp));
        c.save(); c.translate(x, y);
        c.strokeStyle = 'rgba(255, 255, 255, .45)'; c.lineWidth = 1;
        line(c, [[-Math.cos(dir) * 8, -Math.sin(dir) * 8], [-Math.cos(dir) * 20, -Math.sin(dir) * 20]]);
        c.rotate(dir);
        c.fillStyle = '#7a5a3a'; c.beginPath(); c.moveTo(-7, -2.5); c.lineTo(5, -2.5); c.lineTo(8, 0); c.lineTo(5, 2.5); c.lineTo(-7, 2.5); c.closePath(); c.fill();
        c.rotate(-dir);
        const lean = Math.sin(clock * 1.1 + cx) * 1.5;
        c.fillStyle = sail; c.beginPath(); c.moveTo(0, -1); c.lineTo(lean, -15); c.lineTo(Math.cos(dir) >= 0 ? 7 : -7, -2); c.closePath(); c.fill();
        c.restore();
        lights.push(['glow', x, y - 4, 6, '#fff3c0']);
      }
      // Днём по острову и морю плывут тени облаков
      if (day) {
        for (const [x0, y0, rx, ry, sp] of [[120, 230, 90, 40, 7], [620, 470, 70, 32, 5], [380, 610, 60, 26, 9]]) {
          const x = ((x0 + clock * sp) % (W + 260)) - 130;
          const gr = c.createRadialGradient(x, y0, 4, x, y0, rx);
          gr.addColorStop(0, 'rgba(10, 30, 40, .16)'); gr.addColorStop(1, 'rgba(10, 30, 40, 0)');
          c.fillStyle = gr; c.beginPath(); c.ellipse(x, y0, rx, ry, 0, 0, Math.PI * 2); c.fill();
        }
      }
      c.restore();
    }

    /* ------------------------------------------------------------- Кадр */

    let plateBoxes = [];
    function draw() {
      if (!canvas) return;
      if (staticDirty) drawStatic();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(bg, 0, 0);
      view(g);
      lights = [];
      const sky = skyState();
      drawSea(g, sky.dark < 0.3);
      const list = sources().filter((s) => s.active && posOf(s));
      // Подсветка маршрута выбранного
      const sel = byId(st.selected);
      if (sel?.parts) {
        g.save(); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#ffd54a'; g.lineWidth = 4; g.globalAlpha = 0.5 + Math.sin(clock * 4) * 0.2;
        for (const part of sel.parts) line(g, part.pts);
        g.restore();
      }
      for (const v of cars) drawVehicle(g, v);
      // Сверху вниз — дальние за ближними
      const order = [...list.map((s) => ({ s, y: posOf(s)[1] })), { hq: true, y: NODES.hq[1] }].sort((a, b) => a.y - b.y);
      for (const o of order) {
        if (o.hq) drawHQ(g);
        else { const [x, y] = posOf(o.s); drawUnit(g, o.s, x, y, String(o.s.id) === String(st.selected)); }
      }
      // Время суток: затемнение и огни
      if (sky.dark > 0) {
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = sky.dark; g.fillStyle = sky.tint; g.fillRect(0, 0, canvas.width, canvas.height);
        g.restore();
        const L = Math.min(1, sky.dark / 0.45);
        g.save(); g.globalCompositeOperation = 'lighter';
        for (const l of lights) {
          if (l[0] === 'rect') { g.globalAlpha = 0.85 * L; g.fillStyle = l[5]; g.fillRect(l[1], l[2], l[3], l[4]); }
          if (l[0] === 'glow') {
            const gr = g.createRadialGradient(l[1], l[2], 0, l[1], l[2], l[3]);
            gr.addColorStop(0, l[4]); gr.addColorStop(1, 'rgba(0, 0, 0, 0)');
            g.globalAlpha = 0.7 * L; g.fillStyle = gr; g.beginPath(); g.arc(l[1], l[2], l[3], 0, Math.PI * 2); g.fill();
          }
          if (l[0] === 'beam') {
            const a = l[3] * 0.9;
            const gr = g.createRadialGradient(l[1], l[2], 0, l[1], l[2], 150);
            gr.addColorStop(0, 'rgba(255, 240, 180, .6)'); gr.addColorStop(1, 'rgba(255, 240, 180, 0)');
            g.globalAlpha = L; g.fillStyle = gr;
            g.beginPath(); g.moveTo(l[1], l[2]); g.arc(l[1], l[2], 150, a - 0.18, a + 0.18); g.closePath(); g.fill();
          }
        }
        // Фонари на перекрёстках
        for (const n of ROAD_NODES) {
          const [x, y] = NODES[n];
          const gr = g.createRadialGradient(x, y, 0, x, y, 14);
          gr.addColorStop(0, 'rgba(255, 220, 140, .55)'); gr.addColorStop(1, 'rgba(255, 220, 140, 0)');
          g.globalAlpha = L; g.fillStyle = gr; g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill();
        }
        g.restore();
      }
      // Таблички юнитов (поверх всего, как интерфейс игры)
      const maxRev = Math.max(1, ...list.map((s) => s.month.revenue));
      plateBoxes = [];
      // Раскладка табличек: не налезают друг на друга и на подпись офиса — сдвигаем вверх, с линией к зданию
      const placed = [{ x: NODES.hq[0] - 50, y: NODES.hq[1] + 12, w: 100, h: 16 }];
      const hit = (a) => placed.find((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
      const units = order.filter((o) => !o.hq).sort((a, b) => b.y - a.y);
      for (const o of units) {
        const [x, y] = posOf(o.s);
        const full = k >= 0.7 || String(o.s.id) === String(st.selected);
        const { w, h } = plateSize(full);
        const anchor = y - (HEIGHT[o.s.kind] || 26) - 8;
        const box = { x: x - w / 2, y: anchor - h, w, h };
        for (let i = 0; i < 12; i++) {
          const other = hit(box);
          if (!other) break;
          box.y = other.y - h - 3;
        }
        placed.push(box);
        if (box.y + h < anchor - 2) {
          g.strokeStyle = 'rgba(255, 255, 255, .55)'; g.lineWidth = 1;
          line(g, [[x, box.y + h], [x, anchor]]);
        }
        plateBoxes.push({ id: o.s.id, ...plate(g, o.s, x, box.y + h, full, maxRev) });
      }
      // Подпись офиса и монеты
      g.textAlign = 'center'; g.textBaseline = 'top'; g.font = '600 11px system-ui, sans-serif'; g.lineJoin = 'round';
      g.lineWidth = 4; g.strokeStyle = 'rgba(10, 30, 40, .8)'; g.strokeText('Офис Jet Mobility', NODES.hq[0], NODES.hq[1] + 14);
      g.fillStyle = st.selected === 'hq' ? '#ffd54a' : '#eef6f6'; g.fillText('Офис Jet Mobility', NODES.hq[0], NODES.hq[1] + 14);
      for (const p of pops) {
        g.globalAlpha = Math.max(0, 1 - p.t / 1.4);
        g.font = '800 13px system-ui, sans-serif'; g.strokeText(p.text, NODES.hq[0] + 48, NODES.hq[1] - 40 - p.t * 30);
        g.fillStyle = '#ffd54a'; g.fillText(p.text, NODES.hq[0] + 48, NODES.hq[1] - 40 - p.t * 30);
        g.globalAlpha = 1;
      }
      // Расстановка: сетка, занятые клетки, клетка под курсором
      if (st.placing) {
        g.save();
        g.strokeStyle = 'rgba(255, 255, 255, .28)'; g.lineWidth = 1;
        for (let cx = 0; cx <= W; cx += CELL) line(g, [[cx, 0], [cx, H]]);
        for (let cy = 0; cy <= H; cy += CELL) line(g, [[0, cy], [W, cy]]);
        g.fillStyle = 'rgba(255, 90, 78, .25)';
        for (const s of list) if (String(s.id) !== String(st.placing)) g.fillRect(s.col * CELL, s.row * CELL, CELL, CELL);
        if (st.hover) { g.fillStyle = 'rgba(255, 213, 74, .45)'; g.fillRect(st.hover[0] * CELL, st.hover[1] * CELL, CELL, CELL); }
        g.restore();
      }
    }
    function frame(ts) {
      if (!canvas || !document.body.contains(canvas)) { running = false; return; }
      const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
      last = ts;
      clock += dt;
      if (!reduce) {
        const total = sources().reduce((a, s) => a + (s.segs?.length ? s.month.leads : 0), 0);
        acc += dt * Math.min(1.6, 0.25 + total / 120);
        while (acc > 1) { acc -= 1; if (cars.length < 90) spawn(); }
        update(dt);
      }
      draw();
      requestAnimationFrame(frame);
    }

    function resize() {
      if (!canvas) return;
      // Приближение: остров и все поставленные источники, без пустого моря по краям
      // (в режиме расстановки — вся карта, чтобы можно было выбрать любую клетку)
      const narrow = canvas.parentElement.clientWidth < 600;
      if (st.placing) VB = { x: 0, y: 0, w: W, h: H };
      else {
        const xs = sources().filter((s) => s.active && posOf(s)).map((s) => posOf(s)[0]);
        const pad = narrow ? 70 : 90;
        const x0 = Math.max(0, Math.min(narrow ? 380 : 300, ...xs.map((x) => x - pad)));
        const x1 = Math.min(W, Math.max(narrow ? 660 : 740, ...xs.map((x) => x + pad)));
        VB = { x: x0, y: 0, w: x1 - x0, h: 690 };
      }
      // Вся карта — на первом экране: если по ширине она выше окна, показываем больше моря по бокам,
      // а если и вся карта целиком не влезает — делаем холст уже
      const cw = canvas.parentElement.clientWidth;
      const legend = canvas.parentElement.querySelector('.mk-legend')?.offsetHeight || 0;
      const head = document.querySelector('.topbar')?.offsetHeight || 0;
      const top = narrow ? head + 8 : canvas.parentElement.getBoundingClientRect().top + window.scrollY;
      const avail = Math.max(narrow ? 300 : 360, window.innerHeight - top - legend - 14);
      let width = cw;
      if (cw * (VB.h / VB.w) > avail) {
        const w = (VB.h * cw) / avail;
        if (w <= W) {
          const mid = VB.x + VB.w / 2;
          VB.x = Math.max(0, Math.min(W - w, mid - w / 2));
          VB.w = w;
        } else {
          VB = { x: 0, y: 0, w: W, h: st.placing ? H : 690 };
          width = Math.round((avail * W) / VB.h);
        }
      }
      canvas.style.width = width < cw ? `${width}px` : '';
      canvas.style.aspectRatio = `${VB.w} / ${VB.h}`;
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      k = rect.width / VB.w;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.width * (VB.h / VB.w) * dpr);
      bg.width = canvas.width;
      bg.height = canvas.height;
      staticDirty = true;
      draw();
    }

    /** После каждой отрисовки вкладки: найти холст, подогнать размер, запустить анимацию */
    function mount() {
      const el = document.getElementById('mk-map');
      if (!el) return;
      if (el !== canvas) {
        canvas = el;
        g = canvas.getContext('2d');
        canvas.addEventListener('click', onMapClick);
        canvas.addEventListener('mousemove', onMapMove);
        canvas.addEventListener('mouseleave', () => { st.hover = null; });
      }
      const dlg = document.getElementById('mk-detail');
      if (dlg && !dlg.dataset.bound) {
        dlg.dataset.bound = '1';
        dlg.addEventListener('close', () => { if (st.detail) { st.detail = null; dlg.innerHTML = ''; } });
        if (st.detail && !dlg.open) dlg.showModal?.();
      }
      resize();
      if (!running && !reduce) { running = true; last = 0; requestAnimationFrame(frame); }
    }
    window.addEventListener('resize', () => { clearTimeout(resize.t); resize.t = setTimeout(() => { if (canvas && document.body.contains(canvas)) resize(); }, 150); });

    function mapPoint(e) {
      const rect = canvas.getBoundingClientRect();
      return [VB.x + ((e.clientX - rect.left) / rect.width) * VB.w, VB.y + ((e.clientY - rect.top) / rect.height) * VB.h];
    }
    function onMapMove(e) {
      if (!st.placing) return;
      const [x, y] = mapPoint(e);
      st.hover = [Math.floor(x / CELL), Math.floor(y / CELL)];
      if (reduce) draw();
    }
    function onMapClick(e) {
      const [x, y] = mapPoint(e);
      if (st.placing) {
        const col = Math.floor(x / CELL);
        const row = Math.floor(y / CELL);
        const id = st.placing;
        st.placing = null;
        call('/marketing/place', { id, col, row }, 'Источник стоит на карте.').then(() => { st.selected = id; refreshPanel(); });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;
      // Табличка или само здание
      const toScreen = (lx, ly) => [(lx - VB.x) * k * dpr, (ly - VB.y) * k * dpr];
      for (const b of plateBoxes) {
        const [sx, sy] = toScreen(b.x, b.y);
        if (px >= sx && px <= sx + b.w * k * dpr && py >= sy && py <= sy + b.h * k * dpr) return select(b.id);
      }
      let best = null;
      let bestD = 30;
      for (const s of sources()) {
        const p = posOf(s);
        if (!p || !s.active) continue;
        const d = Math.hypot(p[0] - x, p[1] - 14 - y);
        if (d < bestD) { best = s.id; bestD = d; }
      }
      if (!best && Math.hypot(NODES.hq[0] - x, NODES.hq[1] - 10 - y) < 40) best = 'hq';
      if (best !== null) select(best);
    }
    function select(id) {
      st.selected = id;
      st.editing = null;
      st.delAsk = false;
      st.msg = null;
      refreshPanel();
      if (reduce) draw();
    }

    /* ============================================================ Интерфейс */

    function totals() { return st.data?.totals || { visits: 0, refVisits: 0, views: 0, visitors: 0, leads: 0, answered: 0, booked: 0, paid: 0, revenue: 0, cost: 0 }; }
    function hud() {
      const t = totals();
      const roi = t.cost ? t.revenue / t.cost : null;
      const un = st.data?.unattributed?.leads || 0;
      const tiles = [
        ['visits', 'Переходы', num(t.visits), `сайты ${short(t.views || 0)} · ссылки ${num(t.refVisits || 0)}`, ''],
        ['leads', 'Заявки', num(t.leads), un ? `ещё ${num(un)} без метки` : 'все с меткой источника', ''],
        ['answered', 'Ответили', pct(t.answered, t.leads), `ждут: ${num(t.leads - t.answered)}`, ''],
        ['paid', 'Продажи', num(t.paid), `${pct(t.paid, t.leads)} заявок`, 'good'],
        ['revenue', 'Выручка', short(t.revenue) + ' ฿', 'аренды этих клиентов', 'coin'],
        ['cost', 'Расходы', short(t.cost) + ' ฿', 'бюджеты и комиссии', ''],
        ['roi', 'Окупаемость', roiText(roi), 'выручка на 1 ฿ расходов', 'good'],
        ['cps', 'Цена продажи', t.paid && t.cost ? baht(t.cost / t.paid) : '—', 'расходы на одну оплату', '']
      ];
      return tiles.map(([id, l, v, h, tone]) => `<button type="button" class="mk-kpi${tone ? ` mk-kpi--${tone}` : ''}" data-mk-metric="${id}" title="Подробнее: ${l.toLowerCase()}"><span class="mk-kpi__l">${l}<span class="mk-kpi__more" aria-hidden="true">›</span></span><span class="mk-kpi__v">${esc(v)}</span><span class="mk-kpi__h">${esc(h)}</span></button>`).join('');
    }

    /* ------------------------------------------- Подробности верхних блоков */

    const METRICS = {
      visits: 'Переходы и посещения сайтов', leads: 'Заявки', answered: 'Ответы на заявки', paid: 'Продажи',
      revenue: 'Выручка', cost: 'Расходы', roi: 'Окупаемость', cps: 'Цена продажи', wabot: 'WhatsApp-бот для клиентов'
    };
    const FROM_SERVER = ['visits', 'leads', 'answered', 'paid'];
    const whenFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : whenFmt.format(d); };
    const dayText = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    const minText = (m) => (m === null || m === undefined ? '—' : m < 60 ? `${m} мин` : m < 1440 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${Math.round(m / 1440)} дн`);
    const periodText = () => PERIODS.find(([id]) => id === st.period)?.[1].toLowerCase() || '';

    /** Таблица: cols — подписи, left — сколько первых колонок по левому краю; строка — { c: [...ячейки], pick } */
    function grid(cols, rows, { left = 1, foot = null, empty = 'Пока пусто.' } = {}) {
      if (!rows.length) return `<p class="mk-tip">${empty}</p>`;
      const cell = (tag, v, i) => `<${tag}${i < left ? ' class="l"' : ''}>${v}</${tag}>`;
      return `<div class="table-wrap mk-dt"><table>
        <thead><tr>${cols.map((v, i) => cell('th', v, i)).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr${r.pick ? ` data-mk-pick="${r.pick}" class="is-link"` : ''}>${r.c.map((v, i) => cell('td', v, i)).join('')}</tr>`).join('')}</tbody>
        ${foot ? `<tfoot><tr>${foot.map((v, i) => cell('td', v, i)).join('')}</tr></tfoot>` : ''}</table></div>`;
    }
    const sec = (title, body, note = '') => `<section class="mk-dsec"><h4>${title}</h4>${note ? `<p class="mk-tip">${note}</p>` : ''}${body}</section>`;
    const activeSources = () => sources().filter((s) => s.active);
    const hostName = (h) => esc(h.replace(/^www\./, ''));

    function detailVisits(d) {
      const t = totals();
      const since = d.since ? `${dayText(d.since)}.${d.since.slice(0, 4)}` : null;
      const kinds = st.data.kinds || {};
      const src = d.bySource.filter((x) => x.refVisits || x.views || x.visitors);
      const refName = (v) => (v === 'прямой заход' ? 'прямой заход <span class="mk-dim">(адрес набрали сами, закладка или приложение)</span>' : v === 'google' ? 'Google (поиск, Карты)' : v === 'yandex' ? 'Яндекс' : esc(v));
      return `
        <p class="mk-text">За ${periodText()}: на сайтах <b>${num(t.views)}</b> просмотров страниц${t.visitors ? `, <b>${num(t.visitors)}</b> посетителей` : ''}; по ссылкам с кодом источника — <b>${num(t.refVisits)}</b> переходов.</p>
        <p class="mk-tip">Откуда цифры: просмотры — из журнала нашего сервера, каждая открытая страница jetmobility.org и kokoncar.com (без поисковых роботов, картинок и служебных запросов). Переходы по ссылкам — сколько раз сайт открыли по ссылке с кодом (?ref=…) агента, соцсети или рекламы.
        ${since ? `Подробности — страницы, откуда пришли, устройства и посетители — собираются с ${since}.` : 'Подробности — страницы, откуда пришли, устройства и посетители — начнут собираться после обновления сервера; до этого видны только общие просмотры.'}</p>
        ${sec('По источникам', grid(['Источник', 'Тип', 'По ссылке с кодом', 'Просмотры сайта', 'Посетители сайта'],
          src.map((x) => ({ pick: x.id, c: [esc(x.name), esc(kinds[x.kind] || x.kind), num(x.refVisits), x.kind === 'site' ? num(x.views) : '—', x.kind === 'site' ? num(x.visitors) : '—'] })), { left: 2, empty: 'За этот период переходов нет.' }))}
        ${sec('По дням', grid(['День', 'Просмотры сайтов', 'Посетители', 'По ссылкам с кодом'],
          d.byDay.map((x) => ({ c: [dayText(x.day), num(x.views), x.visitors ? num(x.visitors) : '—', num(x.refVisits)] }))))}
        <div class="mk-dcols">
          ${sec('Откуда пришли на сайт', grid(['Откуда', 'Сайт', 'Просмотры'], d.refs.map((x) => ({ c: [refName(x.value), hostName(x.host), num(x.n)] })), { left: 2, empty: since ? 'Пока пусто.' : 'Появится после обновления сервера.' }),
            'Instagram и WhatsApp часто не сообщают, откуда пришёл человек, — такие визиты попадают в «прямой заход». Поэтому для агентов и соцсетей нужны ссылки с кодом.')}
          ${sec('Популярные страницы', grid(['Страница', 'Сайт', 'Просмотры'], d.pages.map((x) => ({ c: [esc(x.value), hostName(x.host), num(x.n)] })), { left: 2, empty: since ? 'Пока пусто.' : 'Появится после обновления сервера.' }))}
          ${sec('Метки рекламы (utm_source)', grid(['Метка', 'Сайт', 'Просмотры'], d.utm.map((x) => ({ c: [esc(x.value), hostName(x.host), num(x.n)] })), { left: 2, empty: 'Пока нет. Такую метку ставят в ссылке рекламы: …?utm_source=google.' }))}
          ${sec('Устройства', grid(['Устройство', 'Сайт', 'Посетители'], d.devices.map((x) => ({ c: [esc(x.value), hostName(x.host), num(x.n)] })), { left: 2, empty: since ? 'Пока пусто.' : 'Появится после обновления сервера.' }))}
        </div>`;
    }

    function requestRows(rows) {
      return rows.map((r) => ({
        pick: r.sourceId,
        c: [when(r.at), esc(r.client), esc(CH[r.channel] || r.channel || '—'), esc(r.source), esc(r.model || '—'), esc(r.status), minText(r.answerMin),
          r.booked ? 'да' : '—', r.paid ? 'да' : '—', r.revenue ? baht(r.revenue) : '—']
      }));
    }
    const REQ_COLS = ['Когда', 'Клиент', 'Канал', 'Источник', 'Модель', 'Статус', 'Ответили через', 'Бронь', 'Оплата', 'Выручка'];

    function detailRequests(d, metric) {
      const list = activeSources();
      const t = totals();
      const un = st.data.unattributed || { leads: 0 };
      const cut = d.rows.length >= 500 ? '<p class="mk-tip">Показаны последние 500 заявок.</p>' : '';
      if (metric === 'leads') {
        const rows = list.filter((s) => s.metrics.leads).sort((a, b) => b.metrics.leads - a.metrics.leads)
          .map((s) => ({ pick: s.id, c: [esc(s.name), num(s.metrics.leads), num(s.metrics.answered), num(s.metrics.booked), num(s.metrics.paid), pct(s.metrics.paid, s.metrics.leads)] }));
        if (un.leads) rows.push({ c: ['<span class="mk-dim">Без источника</span>', num(un.leads), '', '', '', ''] });
        return `${sec('По источникам', grid(['Источник', 'Заявки', 'Ответили', 'Бронь', 'Оплачено', 'Конверсия'], rows,
            { foot: ['Всего с источником', num(t.leads), num(t.answered), num(t.booked), num(t.paid), pct(t.paid, t.leads)], empty: 'Заявок за этот период нет.' }))}
          ${sec(`Все заявки за ${periodText()}`, grid(REQ_COLS, requestRows(d.rows), { left: 6, empty: 'Заявок нет.' }), 'Включая заявки без источника. Нажмите строку — откроется источник на карте.')}${cut}`;
      }
      if (metric === 'answered') {
        const speed = new Map(d.speed.map((x) => [x.source, x]));
        const rows = list.filter((s) => s.metrics.leads).sort((a, b) => (b.metrics.leads - b.metrics.answered) - (a.metrics.leads - a.metrics.answered))
          .map((s) => ({ pick: s.id, c: [esc(s.name), num(s.metrics.leads), num(s.metrics.answered), num(s.metrics.leads - s.metrics.answered), pct(s.metrics.answered, s.metrics.leads), minText(speed.get(s.name)?.avgMin)] }));
        const waiting = d.rows.filter((r) => r.answerMin === null);
        return `${sec('По источникам', grid(['Источник', 'Заявки', 'Ответили', 'Ждут', 'Доля ответов', 'Среднее время ответа'], rows,
            { foot: ['Всего', num(t.leads), num(t.answered), num(t.leads - t.answered), pct(t.answered, t.leads), ''], empty: 'Заявок за этот период нет.' }))}
          ${sec('Ждут ответа', grid(REQ_COLS, requestRows(waiting), { left: 6, empty: 'Все заявки разобраны.' }))}
          ${sec(`Все заявки за ${periodText()}`, grid(REQ_COLS, requestRows(d.rows), { left: 6, empty: 'Заявок нет.' }), '«Ответили через» — от заявки до «Взять в работу» в портале или боте.')}${cut}`;
      }
      const rows = list.filter((s) => s.metrics.paid).sort((a, b) => b.metrics.paid - a.metrics.paid)
        .map((s) => ({ pick: s.id, c: [esc(s.name), num(s.metrics.paid), num(s.metrics.leads), pct(s.metrics.paid, s.metrics.leads), baht(s.metrics.revenue), baht(s.metrics.revenue / s.metrics.paid)] }));
      return `${sec('По источникам', grid(['Источник', 'Оплачено', 'Из заявок', 'Конверсия', 'Выручка', 'Средний чек'], rows,
          { foot: ['Всего', num(t.paid), num(t.leads), pct(t.paid, t.leads), baht(t.revenue), t.paid ? baht(t.revenue / t.paid) : '—'], empty: 'Продаж за этот период нет.' }))}
        ${sec('Оплаченные заявки', grid(REQ_COLS, requestRows(d.rows), { left: 6, empty: 'Продаж нет.' }), 'Продажа — клиент из заявки оплатил аренду (по CRM, за 60 дней после заявки).')}${cut}`;
    }

    function detailMoney(metric) {
      const list = activeSources();
      const t = totals();
      if (metric === 'revenue') {
        const rows = list.filter((s) => s.metrics.revenue).sort((a, b) => b.metrics.revenue - a.metrics.revenue)
          .map((s) => ({ pick: s.id, c: [esc(s.name), baht(s.metrics.revenue), pct(s.metrics.revenue, t.revenue), num(s.metrics.paid), s.metrics.paid ? baht(s.metrics.revenue / s.metrics.paid) : '—'] }));
        return sec('По источникам', grid(['Источник', 'Выручка', 'Доля', 'Продажи', 'Средний чек'], rows,
          { foot: ['Всего', baht(t.revenue), '100%', num(t.paid), t.paid ? baht(t.revenue / t.paid) : '—'], empty: 'Выручки за этот период нет.' }),
        'Выручка — аренды клиентов из заявок по CRM: клиент из заявки и его аренды за 60 дней после неё.');
      }
      if (metric === 'cost') {
        const rows = list.slice().sort((a, b) => b.metrics.cost - a.metrics.cost)
          .map((s) => ({ pick: s.id, c: [esc(s.name), esc(costLabel(s)), baht(s.metrics.cost), baht(s.metrics.revenue), roiText(roiOf(s.metrics))] }));
        return sec('По источникам', grid(['Источник', 'Как считаем', 'Расходы', 'Выручка', 'Окупаемость'], rows,
          { left: 2, foot: ['Всего', '', baht(t.cost), baht(t.revenue), roiText(t.cost ? t.revenue / t.cost : null)] }),
        'Расходы задаются в карточке источника («Изменить»): бюджет в месяц (за неделю или день — его доля) или комиссия, % от выручки.');
      }
      if (metric === 'roi') {
        const rows = list.filter((s) => s.metrics.cost || s.metrics.revenue).sort((a, b) => (roiOf(b.metrics) ?? 1e9) - (roiOf(a.metrics) ?? 1e9))
          .map((s) => ({ pick: s.id, c: [esc(s.name), baht(s.metrics.revenue), baht(s.metrics.cost), `<span class="mk-${roiTone(roiOf(s.metrics))}">${roiText(roiOf(s.metrics))}</span>`, baht(s.metrics.revenue - s.metrics.cost)] }));
        return sec('По источникам', grid(['Источник', 'Выручка', 'Расходы', 'Окупаемость', 'Выручка минус расходы'], rows,
          { foot: ['Всего', baht(t.revenue), baht(t.cost), roiText(t.cost ? t.revenue / t.cost : null), baht(t.revenue - t.cost)], empty: 'Нет ни выручки, ни расходов за этот период.' }),
        'Окупаемость — сколько бат выручки на 1 ฿ расходов: ×4 и выше — хорошо, ниже ×1,5 — канал стоит пересмотреть. «—» — у источника нет расходов.');
      }
      const rows = list.filter((s) => s.metrics.cost).sort((a, b) => (b.metrics.paid ? b.metrics.cost / b.metrics.paid : 1e12) - (a.metrics.paid ? a.metrics.cost / a.metrics.paid : 1e12))
        .map((s) => ({ pick: s.id, c: [esc(s.name), baht(s.metrics.cost), num(s.metrics.paid), s.metrics.paid ? baht(s.metrics.cost / s.metrics.paid) : 'нет продаж', s.metrics.paid ? baht(s.metrics.revenue / s.metrics.paid) : '—'] }));
      return sec('По источникам', grid(['Источник', 'Расходы', 'Продажи', 'Цена продажи', 'Средний чек'], rows,
        { foot: ['Всего', baht(t.cost), num(t.paid), t.paid && t.cost ? baht(t.cost / t.paid) : '—', t.paid ? baht(t.revenue / t.paid) : '—'], empty: 'У источников нет расходов за этот период.' }),
      'Цена продажи — расходы на источник, делённые на число оплат. Если она близка к среднему чеку — канал почти не приносит денег.');
    }

    function detailHtml() {
      const d = st.detail;
      if (!d) return '';
      let body;
      if (d.metric === 'wabot') body = wabotHtml();
      else if (d.failed) body = `<p class="md-status is-error">${esc(d.failed)}</p>`;
      else if (FROM_SERVER.includes(d.metric) && !d.data) body = '<p class="mk-tip">Загружаем…</p>';
      else if (d.metric === 'visits') body = detailVisits(d.data);
      else if (FROM_SERVER.includes(d.metric)) body = detailRequests(d.data, d.metric);
      else body = detailMoney(d.metric);
      return `<div class="sheet__body mk-detail">
        <div class="sheet__head"><div><div class="muted">Маркетинг${d.metric === 'wabot' ? '' : ` · ${esc(periodText())}`}</div><h2>${esc(METRICS[d.metric])}</h2></div>
          <button type="button" class="icon-btn icon-btn--plain" data-mk-close aria-label="Закрыть">×</button></div>
        ${body}</div>`;
    }
    function refreshDetail() {
      const dlg = document.getElementById('mk-detail');
      if (!dlg) return;
      dlg.innerHTML = detailHtml();
      dlg.classList.toggle('mk-sheet--narrow', st.detail?.metric === 'wabot');
      if (st.detail && !dlg.open) dlg.showModal?.();
      if (!st.detail && dlg.open) dlg.close();
    }
    async function openDetail(metric) {
      if (!METRICS[metric]) return;
      st.detail = { metric, period: st.period, data: null, failed: null };
      st.wabotMsg = null;
      refreshDetail();
      if (metric === 'wabot') { refreshWabot(); return; }
      if (!FROM_SERVER.includes(metric)) return;
      try {
        const data = await api(`/marketing/details?metric=${metric}&period=${st.period}`);
        if (st.detail?.metric === metric) { st.detail.data = data; refreshDetail(); }
      } catch {
        if (st.detail?.metric === metric) { st.detail.failed = 'Не удалось загрузить подробности. Попробуйте ещё раз.'; refreshDetail(); }
      }
    }
    function closeDetail() {
      st.detail = null;
      refreshDetail();
    }
    function funnel(m) {
      const base = Math.max(1, m.leads);
      const rows = [['Заявки', m.leads, ''], ['Ответили', m.answered, ''], ['Бронь', m.booked, ''], ['Оплачено', m.paid, 'paid']];
      const wait = m.leads - m.answered;
      if (wait > 0) rows.push(['Ждут ответа', wait, 'wait']);
      return `<div class="mk-funnel">${rows.map(([l, v, cls]) => `<div class="mk-step${cls ? ` mk-step--${cls}` : ''}"><span>${l}</span><div class="mk-bar"><span style="width:${Math.round((v / base) * 100)}%"></span></div><b>${num(v)}</b></div>`).join('')}</div>`;
    }
    function moneyBlock(m, costLabel) {
      const r = roiOf(m);
      return `<div class="mk-money">
        <div><span>Выручка</span><b class="mk-coin">${baht(m.revenue)}</b></div>
        <div><span>Расходы</span><b>${baht(m.cost)}</b>${costLabel ? `<small>${esc(costLabel)}</small>` : ''}</div>
        <div><span>Окупаемость</span><b class="mk-${roiTone(r)}">${roiText(r)}</b></div>
        <div><span>Цена продажи</span><b>${m.paid && m.cost ? baht(m.cost / m.paid) : '—'}</b></div>
      </div>`;
    }
    const costLabel = (s) => (s.costType === 'budget' ? `бюджет ${baht(s.costValue)} в месяц` : s.costType === 'commission' ? `комиссия ${s.costValue}% от выручки` : 'без затрат');
    const status = () => (st.msg ? `<p class="md-status is-${st.msg.kind === 'error' ? 'error' : 'ok'}" role="status">${esc(st.msg.text)}</p>` : '');

    function linksBlock(s) {
      const items = [['Ссылка на сайт', s.links.site], ['Ссылка на Telegram-бота', s.links.tg], ['Ссылка на WhatsApp', s.links.wa]].filter(([, v]) => v);
      return `<div class="mk-links">${items.map(([l, v]) => `
        <div class="mk-link"><span>${l}</span><div><input class="search" readonly value="${esc(v)}" aria-label="${esc(l)}"><button type="button" class="btn btn--small" data-mk-copy="${esc(v)}">Копировать</button></div></div>`).join('')}
        ${!s.links.tg || !s.links.wa ? '<p class="mk-tip">Ссылки на ботов появятся, когда в настройках (кнопка «Офис» на карте) будут номер WhatsApp и имя Telegram-бота.</p>' : ''}</div>`;
    }

    /** Заявки без источника: что ответили боту на «откуда узнали» */
    function unattributedBlock() {
      const un = st.data.unattributed || { leads: 0, answers: {} };
      if (!un.leads) return '';
      const parts = Object.entries(un.answers || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} — ${num(n)}`);
      return `<div><div class="mk-label">Без источника: ${num(un.leads)} заявок</div><p class="mk-tip">${parts.join(' · ')}</p></div>`;
    }

    /* ------------------------------------------- WhatsApp-бот (номер компании) */

    const MODE_TEXT = { off: 'никому — отвечают люди', test: 'только тестовым номерам', on: 'всем клиентам' };
    const phoneText = (d) => (d ? `+${d}` : '—');
    function wabotLine(w) {
      if (!w) return '⚪ Нет данных';
      if (w.reachable === false) return '⚪ Бот ещё не запущен на сервере';
      if (w.status === 'connected') {
        const group = w.groupSubject ? `заявки → «${w.groupSubject}»` : 'группа для заявок не выбрана';
        return `🟢 На связи ${phoneText(w.me?.id)} · отвечает: ${MODE_TEXT[w.settings?.mode] || '—'} · ${group}`;
      }
      if (w.status === 'qr' || w.status === 'logged_out') return '⚪ Номер не подключён';
      return '🟠 Нет связи с WhatsApp — проверьте телефон с номером компании';
    }
    function wabotBlock() {
      return `<div class="mk-wa"><div class="mk-label">WhatsApp-бот (номер компании)</div>
        <p class="mk-text">${esc(wabotLine(st.wabot))}</p>
        <button type="button" class="btn btn--small" data-mk-wabot>${canEdit() ? 'Настроить' : 'Подробнее'}</button></div>`;
    }
    function wabotHtml() {
      const w = st.wabot;
      const msg = st.wabotMsg ? `<p class="md-status is-${st.wabotMsg.kind === 'error' ? 'error' : 'ok'}" role="status">${esc(st.wabotMsg.text)}</p>` : '';
      if (!w) return '<p class="mk-tip">Загружаем…</p>';
      const how = `<details class="mk-how"><summary>Как работает бот</summary><ul>
        <li>Отвечает только тем, кто написал сам. Сам первым никому не пишет, рассылок нет.</li>
        <li>Ведёт клиента по шагам, как Telegram-бот: язык → техника → даты → свободные модели с ценами → «откуда узнали» → заявка. Варианты — списком, клиент отвечает цифрой.</li>
        <li>Есть вариант «Связаться с менеджером» — для постоянных клиентов: бот молчит, в группу приходит сообщение.</li>
        <li>Менеджер написал клиенту сам (с телефона или из WhatsApp Web) — бот молчит в этом чате 12 часов. После заявки бот молчит сутки; клиент может написать «меню».</li>
        <li>Заявка приходит карточкой в рабочую группу WhatsApp. Взять — ответить на карточку «+», не можете — «-». Клиенту придёт, кто им занимается. Имя берётся из «Доступов» по номеру WhatsApp.</li>
        <li>На каждом шаге есть «0️⃣ ◀️ Назад».</li>
      </ul></details>`;
      if (w.reachable === false) {
        return `<p class="warn">Бот не отвечает на сервере. Если сервер только что обновили — подождите минуту и откройте окно снова.</p>${how}`;
      }
      if (w.status === 'connected') {
        const set = w.settings || { mode: 'off', testNumbers: [] };
        const groups = (w.groups || []).map((g) => `<option value="${esc(g.id)}"${g.id === w.groupId ? ' selected' : ''}>${esc(`${g.subject} (${g.size})`)}</option>`).join('');
        const today = w.today?.date ? `Сегодня: написали ${num(w.today.received)}, бот ответил ${num(w.today.sent)} раз.` : '';
        if (!w.canEdit) return `<p>✅ Подключён номер ${esc(phoneText(w.me?.id))}</p><p class="mk-text">${esc(wabotLine(w))}</p><p class="mk-tip">${esc(today)}</p>${how}`;
        return `
          <p>✅ Подключён номер <b>${esc(phoneText(w.me?.id))}</b>${w.me?.name ? ` (${esc(w.me.name)})` : ''}</p>
          ${today ? `<p class="mk-tip">${esc(today)}</p>` : ''}
          <form class="mk-form" data-mk-wabot-mode>
            <div class="mk-label">Кому отвечает бот</div>
            <label class="mk-radio"><input type="radio" name="mode" value="off"${set.mode === 'off' ? ' checked' : ''}> Никому — клиентам отвечают люди с телефона</label>
            <label class="mk-radio"><input type="radio" name="mode" value="test"${set.mode === 'test' ? ' checked' : ''}> Только тестовым номерам — проверить перед запуском</label>
            <label class="field"><span>Тестовые номера (через запятую)</span><input class="search" name="testNumbers" inputmode="tel" value="${esc(set.testNumbers.map((n) => `+${n}`).join(', '))}" placeholder="+66 81 234 5678, +7 900 000 0000"></label>
            <label class="mk-radio"><input type="radio" name="mode" value="on"${set.mode === 'on' ? ' checked' : ''}> Всем, кто пишет (сотрудникам тоже)</label>
            <button type="submit" class="btn btn--primary btn--small">Сохранить</button>
          </form>
          <form class="mk-form" data-mk-wabot-group>
            <label class="field"><span>Рабочая группа WhatsApp для заявок</span>
              <select class="search" name="groupId"><option value="">— не присылать —</option>${groups}</select></label>
            <p class="mk-tip">Нет нужной группы — добавьте номер бота ${esc(phoneText(w.me?.id))} в рабочую группу на телефоне, через минуту она появится здесь.</p>
            <label class="mk-check"><input type="checkbox" name="telegramCopy"${set.telegramCopy ? ' checked' : ''}> Дублировать заявки в Telegram-группу</label>
            <p class="mk-tip">Выключено — заявки только в этой группе WhatsApp, брать их можно в одном месте. Утренняя сводка и оповещения в Telegram остаются. Если бот не на связи, заявка всё равно придёт в Telegram.</p>
            <button type="submit" class="btn btn--small">Сохранить</button>
          </form>
          ${msg}
          ${how}
          <button type="button" class="btn btn--small mk-danger" data-mk-wabot-logout>Отвязать номер</button>`;
      }
      if ((w.status === 'qr' || w.status === 'logged_out') && w.canEdit) {
        return `
          <ol class="jr-steps">
            <li>Возьмите телефон с номером компании (+66 98 227 6467), откройте WhatsApp.</li>
            <li>Настройки (или ⋮) → «Связанные устройства» → «Привязать устройство».</li>
            <li>Наведите камеру на QR-код ниже. Код обновляется сам.</li>
          </ol>
          ${w.qr ? `<img class="jr-qr" src="${esc(w.qr)}" alt="QR-код для привязки WhatsApp">` : '<p class="mk-tip">QR-код готовится…</p>'}
          <form class="mk-form" data-mk-wabot-pair>
            <label class="field"><span>Или вход по коду: номер компании</span><input class="search" name="phone" inputmode="tel" placeholder="+66 98 227 6467"></label>
            <button type="submit" class="btn btn--small">Получить код</button>
          </form>
          ${w.pairingCode ? `<p class="jr-code">${esc(w.pairingCode)}</p><p class="mk-tip">На телефоне: «Связанные устройства» → «Привязать устройство» → «Связать по номеру телефона» и введите этот код.</p>` : ''}
          ${msg}${how}`;
      }
      return `<p class="mk-text">${esc(wabotLine(w))}</p>${msg}${how}`;
    }
    async function refreshWabot() {
      st.wabot = await api('/wabot').catch(() => st.wabot);
      if (st.detail?.metric === 'wabot') refreshDetail();
      const panel = document.querySelector('#mk-panel .mk-wa');
      if (panel && !st.editing && !st.placing) refreshPanel();
    }
    async function wabotAction(path, body, okText) {
      try {
        await api(path, { body });
        st.wabotMsg = okText ? { kind: 'ok', text: okText } : null;
      } catch (err) {
        st.wabotMsg = { kind: 'error', text: { read_only: ERRORS.read_only, not_waiting_for_link: 'Код можно получить, только пока показывается QR-код.', unknown_group: 'Группа не найдена — обновите окно.', wabot_unreachable: 'Бот не отвечает на сервере.' }[err.code] || 'Не получилось. Попробуйте ещё раз.' };
      }
      await refreshWabot();
    }
    // Пока номер не привязан, QR-код обновляется — подтягиваем его каждые 5 секунд
    setInterval(() => {
      if (st.detail?.metric === 'wabot' && st.wabot?.status !== 'connected' && !document.hidden) refreshWabot();
    }, 5000);

    function panelHq() {
      const t = totals();
      const set = st.data.settings;
      const unplaced = sources().filter((s) => s.active && !posOf(s));
      return `
        <div class="mk-chips"><span class="chip">Офис</span><span class="chip">все источники</span></div>
        <h3>Офис Jet Mobility</h3>
        <p class="mk-tip">Сюда съезжаются заявки. Нажмите на здание или табличку — откроется источник.</p>
        ${funnel(t)}
        ${moneyBlock(t)}
        ${unattributedBlock()}
        ${wabotBlock()}
        ${canEdit() ? '<button type="button" class="btn btn--primary btn--small" data-mk-new>＋ Новый источник</button>' : ''}
        ${unplaced.length ? `<div><div class="mk-label">Не на карте</div><ul class="mk-list">${unplaced.map((s) => `<li><button type="button" class="link" data-mk-pick="${s.id}">${esc(s.name)}</button>${canEdit() ? ` <button type="button" class="link" data-mk-place="${s.id}">поставить</button>` : ''}</li>`).join('')}</ul></div>` : ''}
        ${canEdit() ? `
        <form class="mk-form" data-mk-settings>
          <div class="mk-label">ИИ-бот отвечает клиентам</div>
          <div class="mk-checks">${FORM_BOT_CH.map((c) => `<label><input type="checkbox" name="bot_${c}"${set.bots[c] ? ' checked' : ''}> ${CH[c]}</label>`).join('')}</div>
          <p class="mk-tip">WhatsApp — в окне «WhatsApp-бот» выше.</p>
          <label class="field"><span>Номер WhatsApp для ссылок</span><input class="search" name="waNumber" inputmode="tel" value="${esc(set.waNumber ? `+${set.waNumber}` : '')}" placeholder="+66 80 000 0000"></label>
          <label class="field"><span>Telegram-бот (имя без @)</span><input class="search" name="tgBot" value="${esc(set.tgBot)}" placeholder="jetmobility_bot"></label>
          <label class="field"><span>Сайт для ссылок</span><select class="search" name="siteHost">${['jetmobility.org', 'kokoncar.com'].map((h) => `<option${set.siteHost === h ? ' selected' : ''}>${h}</option>`).join('')}</select></label>
          <label class="field"><span>Сколько помнить код ссылки</span><select class="search" name="refDays">${[[0, 'бессрочно'], [30, '30 дней'], [60, '60 дней'], [90, '90 дней'], [180, 'полгода'], [365, 'год']].map(([d, l]) => `<option value="${d}"${set.refDays === d ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <p class="mk-tip">Если клиент приходил по нескольким ссылкам, засчитывается агент или партнёр, иначе — последняя ссылка. Клиента без кода бот спрашивает «Откуда вы о нас узнали?».</p>
          <button type="submit" class="btn btn--small">Сохранить настройки</button>
        </form>` : ''}
        ${status()}`;
    }

    function panelSource(s) {
      const m = s.metrics;
      const bots = st.data.settings.bots;
      const chans = s.channels.length ? s.channels.map((c) => `<div class="mk-bot"><b>${CH[c]}</b>${c === 'site' ? '<span class="mk-dim">заявка с формы</span>' : bots[c] ? '<span class="mk-good">ИИ-бот отвечает</span>' : '<span class="mk-warn">бот не подключён</span>'}</div>`).join('')
        : '<p class="mk-tip">Каналы не указаны.</p>';
      return `
        <div class="mk-chips"><span class="chip">${esc(st.data.kinds[s.kind] || s.kind)}</span><span class="chip">ур. ${s.level}</span>${s.active ? '' : '<span class="chip">скрыт</span>'}</div>
        <h3>${esc(s.name)}</h3>
        ${s.contact ? `<div><div class="mk-label">Контакт</div><p class="mk-text">${esc(s.contact)}</p></div>` : ''}
        <div><div class="mk-label">Куда приходят клиенты</div><div class="mk-bots">${chans}</div></div>
        <div><div class="mk-label">Переходы → заявки</div><p class="mk-text">${num(m.visits)} → ${num(m.leads)} ${m.visits ? `(${pct(m.leads, m.visits)})` : ''}</p></div>
        ${funnel(m)}
        ${moneyBlock(m, costLabel(s))}
        ${s.manual ? `<p class="mk-tip">В месяце учтены ручные цифры: заявок ${num(s.manual.leads)}, продаж ${num(s.manual.paid)}, выручка ${baht(s.manual.revenue)}.</p>` : ''}
        <div><div class="mk-label">Код «${esc(s.code)}» — ссылки для раздачи</div>${linksBlock(s)}</div>
        ${s.notes ? `<div><div class="mk-label">Заметки</div><p class="mk-text">${esc(s.notes)}</p></div>` : ''}
        ${canEdit() ? `<div class="mk-actions"><button type="button" class="btn btn--small" data-mk-edit="${s.id}">Изменить</button><button type="button" class="btn btn--small" data-mk-place="${s.id}">${posOf(s) ? 'Переставить на карте' : 'Поставить на карту'}</button></div>` : ''}
        ${status()}`;
    }

    function panelForm(s) {
      const isNew = !s;
      const v = s || { name: '', kind: 'agent', code: '', host: '', contact: '', channels: ['wa'], costType: 'none', costValue: 0, badge: '', color: '', notes: '', active: true, manual: null };
      const man = v.manual || {};
      return `
        <h3>${isNew ? 'Новый источник' : `Изменить: ${esc(v.name)}`}</h3>
        <form class="mk-form" data-mk-form="${isNew ? '' : v.id}">
          <label class="field"><span>Название *</span><input class="search" name="name" required maxlength="60" value="${esc(v.name)}" placeholder="Агент Сергей"></label>
          <label class="field"><span>Тип — от него зависит вид на карте</span><select class="search" name="kind">${Object.entries(st.data.kinds).map(([id, l]) => `<option value="${id}"${v.kind === id ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="field"><span>Контакт (кто отвечает за канал)</span><input class="search" name="contact" maxlength="120" value="${esc(v.contact)}" placeholder="Сергей, +66 …"></label>
          <label class="field"><span>Код ссылки (латиница; пусто — придумаем сами)</span><input class="search" name="code" maxlength="24" value="${esc(v.code)}" placeholder="sergey"></label>
          <label class="field"><span>Домен — только для типа «Сайт»</span><input class="search" name="host" maxlength="80" value="${esc(v.host)}" placeholder="kokoncar.com"></label>
          <div><div class="mk-label">Куда приходят клиенты</div><div class="mk-checks">${Object.entries(CH).map(([c, l]) => `<label><input type="checkbox" name="ch_${c}"${v.channels.includes(c) ? ' checked' : ''}> ${l}</label>`).join('')}</div></div>
          <div class="mk-row">
            <label class="field"><span>Расходы</span><select class="search" name="costType">
              <option value="none"${v.costType === 'none' ? ' selected' : ''}>без затрат</option>
              <option value="budget"${v.costType === 'budget' ? ' selected' : ''}>бюджет в месяц, ฿</option>
              <option value="commission"${v.costType === 'commission' ? ' selected' : ''}>комиссия, % от выручки</option></select></label>
            <label class="field"><span>Сумма или %</span><input class="search" name="costValue" inputmode="decimal" value="${v.costValue || ''}" placeholder="0"></label>
          </div>
          <div class="mk-row">
            <label class="field"><span>Значок (2–3 буквы)</span><input class="search" name="badge" maxlength="3" value="${esc(v.badge)}" placeholder="IG"></label>
            <label class="field"><span>Цвет</span><select class="search" name="color"><option value="">авто</option>${COLORS.map((c) => `<option value="${c}"${v.color === c ? ' selected' : ''} style="background:${c}">${c}</option>`).join('')}</select></label>
          </div>
          <label class="field"><span>Заметки</span><textarea class="search" name="notes" rows="2" maxlength="1000">${esc(v.notes)}</textarea></label>
          <div><div class="mk-label">Ручные цифры за этот месяц — для каналов, которые система не видит сама</div>
            <div class="mk-row mk-row--3">
              <label class="field"><span>Заявки</span><input class="search" name="m_leads" inputmode="numeric" value="${man.leads ?? ''}"></label>
              <label class="field"><span>Продажи</span><input class="search" name="m_paid" inputmode="numeric" value="${man.paid ?? ''}"></label>
              <label class="field"><span>Выручка, ฿</span><input class="search" name="m_revenue" inputmode="numeric" value="${man.revenue ?? ''}"></label>
            </div></div>
          <label class="mk-check"><input type="checkbox" name="active"${v.active ? ' checked' : ''}> Показывать на карте и в итогах</label>
          <div class="mk-actions">
            <button type="submit" class="btn btn--primary btn--small">${isNew ? 'Создать и поставить на карту' : 'Сохранить'}</button>
            <button type="button" class="btn btn--small" data-mk-cancel>Отмена</button>
            ${isNew ? '' : st.delAsk ? `<button type="button" class="btn btn--small mk-danger" data-mk-delete="${v.id}">Точно удалить?</button>` : `<button type="button" class="btn btn--small" data-mk-delask>Удалить</button>`}
          </div>
        </form>
        ${status()}`;
    }

    function panelHtml() {
      if (!st.data) return '';
      if (st.placing) {
        const s = byId(st.placing);
        return `<h3>Куда поставить «${esc(s?.name || '')}»?</h3>
          <p class="mk-tip">Нажмите клетку на карте. На суше заявки поедут по дорогам, в море — приплывут к ближайшему пирсу; реклама всегда прилетает в аэропорт. Красные клетки заняты.</p>
          <button type="button" class="btn btn--small" data-mk-cancel>Отмена</button>`;
      }
      if (st.editing === 'new') return panelForm(null);
      if (st.editing) return panelForm(byId(st.editing));
      const s = byId(st.selected);
      return s ? panelSource(s) : panelHq();
    }
    function refreshPanel() {
      const box = document.getElementById('mk-panel');
      if (box) box.innerHTML = panelHtml();
      if (reduce) draw();
    }

    function quests() {
      const list = [];
      const un = st.data.unattributed?.leads || 0;
      if (un) list.push(['warn', 'hq', `${num(un)} заявок без источника. Раздайте ссылки с кодом — тогда будет видно, откуда клиенты.`]);
      const rows = sources().filter((s) => s.active);
      const unplaced = rows.filter((s) => !posOf(s));
      if (unplaced.length) list.push(['warn', unplaced[0].id, `Не на карте: ${unplaced.map((s) => s.name).join(', ')}.`]);
      const bots = st.data.settings.bots;
      const waiting = rows.filter((s) => s.metrics.leads - s.metrics.answered > 0).sort((a, b) => (b.metrics.leads - b.metrics.answered) - (a.metrics.leads - a.metrics.answered))[0];
      if (waiting) {
        const missing = waiting.channels.filter((c) => c !== 'site' && !bots[c]).map((c) => CH[c]);
        list.push(['bad', waiting.id, `${waiting.name}: ${num(waiting.metrics.leads - waiting.metrics.answered)} заявок ждут ответа${missing.length ? `. Подключите ИИ-бота в ${missing.join(', ')}` : ''}.`]);
      }
      const best = rows.filter((s) => s.metrics.leads >= 3).sort((a, b) => b.metrics.paid / b.metrics.leads - a.metrics.paid / a.metrics.leads)[0];
      if (best && best.metrics.paid) list.push(['good', best.id, `${best.name} — лучшая конверсия: ${pct(best.metrics.paid, best.metrics.leads)} заявок оплачены.`]);
      const costly = rows.filter((s) => s.metrics.cost && s.metrics.paid).sort((a, b) => b.metrics.cost / b.metrics.paid - a.metrics.cost / a.metrics.paid)[0];
      if (costly) list.push(['warn', costly.id, `${costly.name}: одна продажа стоит ${baht(costly.metrics.cost / costly.metrics.paid)}, окупаемость ${roiText(roiOf(costly.metrics))}.`]);
      const idle = rows.filter((s) => posOf(s) && !s.month.leads);
      if (idle.length && rows.some((s) => s.month.leads)) list.push(['warn', idle[0].id, `Без заявок в этом месяце: ${idle.map((s) => s.name).join(', ')}.`]);
      if (!rows.some((s) => s.month.leads)) list.push(['warn', 'hq', 'Заявок с меткой пока нет. Раздайте ссылки: откройте источник — внизу его ссылки на сайт и ботов.']);
      return list.slice(0, 5).map(([sev, id, text]) => `<li><button type="button" data-mk-pick="${id}"><span class="mk-sev mk-sev--${sev}"></span><span>${esc(text)}</span></button></li>`).join('');
    }
    function leaders() {
      return sources().filter((s) => s.active).sort((a, b) => b.metrics.revenue - a.metrics.revenue || b.metrics.leads - a.metrics.leads).map((s, i) => {
        const r = roiOf(s.metrics);
        return `<li><button type="button" data-mk-pick="${s.id}"><span class="mk-rank">${i + 1}</span><span class="mk-name">${esc(s.name)}</span><span class="mk-rev">${short(s.metrics.revenue)} ฿</span><span class="mk-roi mk-${roiTone(r)}">${roiText(r)}</span></button></li>`;
      }).join('');
    }
    function table() {
      const rows = sources().slice().sort((a, b) => b.metrics.revenue - a.metrics.revenue);
      const t = totals();
      const tr = (name, contact, bot, m, id) => `<tr${id ? ` data-mk-pick="${id}"` : ''}><td>${name}</td><td>${contact}</td><td>${bot}</td><td>${num(m.visits)}</td><td>${num(m.leads)}</td><td>${num(m.answered)}</td><td>${num(m.booked)}</td><td>${num(m.paid)}</td><td>${pct(m.paid, m.leads)}</td><td>${baht(m.revenue)}</td><td>${baht(m.cost)}</td><td>${roiText(roiOf(m))}</td><td>${m.paid && m.cost ? baht(m.cost / m.paid) : '—'}</td></tr>`;
      const botText = (s) => { const sh = botShare(s); return sh === null ? '—' : sh === 1 ? 'да' : sh > 0 ? 'частично' : 'нет'; };
      return `<div class="table-wrap mk-table"><table>
        <thead><tr><th>Источник</th><th>Контакт</th><th>ИИ-бот</th><th>Переходы</th><th>Заявки</th><th>Ответили</th><th>Бронь</th><th>Оплачено</th><th>Конверсия</th><th>Выручка</th><th>Расходы</th><th>Окупаемость</th><th>Цена продажи</th></tr></thead>
        <tbody>${rows.map((s) => tr(`${esc(s.name)}${s.active ? '' : ' <span class="mk-dim">(скрыт)</span>'}`, esc(s.contact), botText(s), s.metrics, s.id)).join('')}</tbody>
        <tfoot>${tr('Всего', '', '', t, '')}</tfoot></table></div>`;
    }

    function render() {
      const chips = PERIODS.map(([id, l]) => `<button type="button" data-mk-period="${id}" aria-pressed="${st.period === id}">${l}</button>`).join('');
      const views = [['map', 'Карта'], ['table', 'Таблица']].map(([id, l]) => `<button type="button" data-mk-view="${id}" aria-pressed="${st.view === id}">${l}</button>`).join('');
      const skies = [['auto', 'Авто'], ['day', 'День'], ['night', 'Ночь']].map(([id, l]) => `<button type="button" data-mk-sky="${id}" aria-pressed="${st.sky === id}">${l}</button>`).join('');
      if (st.failed) return `<div class="mk"><div class="empty">${esc(st.failed)}</div></div>`;
      if (!st.data) return '<div class="mk"><div class="empty">Загружаем…</div></div>';
      return `
        <div class="mk">
          <div class="mk-top">
            <div class="mk-controls">
              <div class="mk-seg" role="group" aria-label="Период">${chips}</div>
              <div class="mk-seg" role="group" aria-label="Вид">${views}</div>
              ${st.view === 'map' ? `<div class="mk-seg" role="group" aria-label="Время суток">${skies}</div>` : ''}
            </div>
          </div>
          <section class="mk-hud" aria-label="Итоги периода">${hud()}</section>
          ${st.view === 'map' ? `
          <div class="mk-stage">
            <div class="mk-map"><canvas id="mk-map" width="1000" height="720" role="img" aria-label="Карта Пхукета: источники клиентов и заявки, которые едут, плывут и летят в офис. Нажмите на здание или табличку."></canvas>
              <div class="mk-legend"><span><i style="background:#fff"></i>новая заявка</span><span><i style="background:#3ddc84"></i>продажа</span><span><i style="background:#ffc23d"></i>ждёт ответа</span><span><i style="background:#8aa0aa"></i>без брони</span><span>♥ ответили на заявки за 7 дней · ⚡ выручка за месяц · уровень — по продажам за 90 дней</span></div>
            </div>
            <aside class="mk-panel" id="mk-panel" aria-live="polite">${panelHtml()}</aside>
          </div>` : table()}
          <section class="mk-lower">
            <div class="mk-card"><h3>Задания</h3><ul class="mk-quests">${quests()}</ul></div>
            <div class="mk-card"><h3>Таблица лидеров</h3><ol class="mk-leaders">${leaders()}</ol></div>
          </section>
          <p class="mk-tip">Источник заявки — по коду ссылки (сайт ?ref=, ссылка на Telegram-бота, код в первом сообщении WhatsApp); заявка с сайта без кода — по домену сайта. Продажи и выручка — из CRM: клиент из заявки и его аренды за 60 дней после неё. Нажмите на любой блок сверху — откроется подробная таблица.</p>
          <dialog id="mk-detail" class="sheet mk-sheet" aria-label="Подробности">${detailHtml()}</dialog>
        </div>`;
    }

    /* ============================================================ События */

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.mk')) return false;
      const dlg = el.closest('#mk-detail');
      if (dlg && (el === dlg || el.closest('[data-mk-close]'))) { closeDetail(); return true; }
      if (el.closest('[data-mk-wabot]')) { openDetail('wabot'); return true; }
      if (el.closest('[data-mk-wabot-logout]')) {
        if (window.confirm('Отвязать номер компании от бота? Бот перестанет отвечать клиентам, пока номер не привяжут снова.')) wabotAction('/wabot/logout', {}, 'Номер отвязан.');
        return true;
      }
      const metric = el.closest('[data-mk-metric]');
      if (metric) { openDetail(metric.dataset.mkMetric); return true; }
      const per = el.closest('[data-mk-period]');
      if (per) { st.period = per.dataset.mkPeriod; load(); return true; }
      const v = el.closest('[data-mk-view]');
      if (v) { st.view = v.dataset.mkView; ctx.rerender(); return true; }
      const sky = el.closest('[data-mk-sky]');
      if (sky) { st.sky = sky.dataset.mkSky; document.querySelectorAll('[data-mk-sky]').forEach((b) => b.setAttribute('aria-pressed', String(b === sky))); if (reduce) draw(); return true; }
      const pick = el.closest('[data-mk-pick]');
      if (pick && dlg) closeDetail();
      if (pick) {
        if (st.view !== 'map') { st.view = 'map'; st.selected = pick.dataset.mkPick === 'hq' ? 'hq' : Number(pick.dataset.mkPick); ctx.rerender(); return true; }
        select(pick.dataset.mkPick === 'hq' ? 'hq' : Number(pick.dataset.mkPick));
        document.querySelector('.mk-map')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
        return true;
      }
      if (el.closest('[data-mk-new]')) { st.editing = 'new'; st.msg = null; refreshPanel(); return true; }
      const edit = el.closest('[data-mk-edit]');
      if (edit) { st.editing = Number(edit.dataset.mkEdit); st.msg = null; st.delAsk = false; refreshPanel(); return true; }
      const place = el.closest('[data-mk-place]');
      if (place) { st.placing = Number(place.dataset.mkPlace); st.editing = null; st.msg = null; refreshPanel(); resize(); return true; }
      if (el.closest('[data-mk-cancel]')) { const was = st.placing; st.placing = null; st.editing = null; st.delAsk = false; st.msg = null; refreshPanel(); if (was) resize(); return true; }
      if (el.closest('[data-mk-delask]')) { st.delAsk = true; refreshPanel(); return true; }
      const del = el.closest('[data-mk-delete]');
      if (del) { const id = Number(del.dataset.mkDelete); st.editing = null; st.delAsk = false; st.selected = 'hq'; call('/marketing/source/delete', { id }, 'Источник удалён.'); return true; }
      const copy = el.closest('[data-mk-copy]');
      if (copy) {
        const text = copy.dataset.mkCopy;
        const done = () => { copy.textContent = 'Скопировано'; setTimeout(() => { copy.textContent = 'Копировать'; }, 1500); };
        try {
          navigator.clipboard.writeText(text).then(done, () => { copy.previousElementSibling?.select(); });
        } catch { copy.previousElementSibling?.select(); }
        return true;
      }
      return false;
    }

    function onSubmit(event) {
      const form = event.target;
      if (!form.closest?.('.mk')) return false;
      event.preventDefault();
      const f = new FormData(form);
      if (form.matches('[data-mk-wabot-mode]')) {
        const mode = f.get('mode');
        wabotAction('/wabot/settings', { mode, testNumbers: f.get('testNumbers') || '' },
          mode === 'on' ? 'Бот отвечает всем клиентам.' : mode === 'test' ? 'Бот отвечает только тестовым номерам.' : 'Бот никому не отвечает.').then(load);
        return true;
      }
      if (form.matches('[data-mk-wabot-group]')) {
        const telegramCopy = f.get('telegramCopy') === 'on';
        api('/wabot/settings', { body: { telegramCopy } }).catch(() => null)
          .then(() => wabotAction('/wabot/config', { groupId: f.get('groupId') },
            f.get('groupId') ? `Заявки будут приходить в эту группу${telegramCopy ? ' и копией в Telegram' : ''}.` : 'Заявки в WhatsApp-группу не приходят — только в Telegram.'));
        return true;
      }
      if (form.matches('[data-mk-wabot-pair]')) {
        wabotAction('/wabot/pair', { phone: f.get('phone') });
        return true;
      }
      if (form.matches('[data-mk-settings]')) {
        call('/marketing/settings', {
          bots: Object.fromEntries(FORM_BOT_CH.map((c) => [c, f.get(`bot_${c}`) === 'on'])),
          waNumber: f.get('waNumber'), tgBot: f.get('tgBot'), siteHost: f.get('siteHost'), refDays: Number(f.get('refDays'))
        }, 'Настройки сохранены.');
        return true;
      }
      if (form.matches('[data-mk-form]')) {
        const id = form.dataset.mkForm ? Number(form.dataset.mkForm) : null;
        const manual = ['leads', 'paid', 'revenue'].some((x) => String(f.get(`m_${x}`) || '').trim())
          ? { leads: f.get('m_leads'), paid: f.get('m_paid'), revenue: String(f.get('m_revenue') || '').replace(/\s/g, '') } : null;
        const body = {
          id, name: f.get('name'), kind: f.get('kind'), contact: f.get('contact'), code: f.get('code'), host: f.get('host'),
          channels: Object.keys(CH).filter((c) => f.get(`ch_${c}`) === 'on'),
          costType: f.get('costType'), costValue: String(f.get('costValue') || '').replace(',', '.'),
          badge: f.get('badge'), color: f.get('color'), notes: f.get('notes'), active: f.get('active') === 'on', manual
        };
        api('/marketing/source', { body }).then(async (r) => {
          const newId = r.result;
          st.editing = null;
          st.msg = { kind: 'ok', text: id ? 'Сохранено.' : 'Источник создан. Нажмите клетку на карте, куда его поставить.' };
          await load();
          st.selected = newId;
          if (!id) st.placing = newId;
          refreshPanel();
          resize();
        }).catch((err) => { st.msg = { kind: 'error', text: ERRORS[err.code] || 'Не получилось сохранить.' }; refreshPanel(); });
        return true;
      }
      return false;
    }

    /** Можно ли перерисовать вкладку при фоновом обновлении портала (не во время правки) */
    function canRefresh() {
      return !st.editing && !st.placing && !st.detail && !document.activeElement?.closest?.('.mk form');
    }

    return { load, render, mount, onClick, onSubmit, canRefresh };
  }

  window.STAFF_MARKETING = { create };
})();
