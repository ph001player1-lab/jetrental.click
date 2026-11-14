/**
 * ============================================================================
 * Вкладка «Сервер» (только Admin) — приборная панель в стиле кабины самолёта
 * ============================================================================
 * Табло ламп (MASTER WARNING / MASTER CAUTION) и сообщения о том, что не так;
 * четыре прибора сервера (процессор, память, нагрузка, диск); «двигатель» —
 * наш бот; «топливо» — трафик за месяц против лимита, график по дням и на что
 * он ушёл. Данные — GET /api/staff/server (раз в 10 секунд, пока вкладка
 * открыта). Только рисует HTML — события и загрузка в staff.js.
 * ============================================================================
 */
(() => {
  'use strict';

  const LAMPS = ['disk', 'cpu', 'memory', 'load', 'response', 'traffic', 'ws', 'sheets', 'telegram', 'mail', 'whatsapp', 'engine'];
  const CATEGORY_ORDER = ['pages', 'photos', 'assets', 'api', 'webhooks', 'other', 'system'];

  let h; // помощники из staff.js: t, tn, esc, lang, locale, dateTime, time

  /* -------------------------------------------------------------- Числа */

  const num = (n, digits = 1) => new Intl.NumberFormat(h.locale, { maximumFractionDigits: digits }).format(n);

  /** 1234567 → «1,2 МБ» (десятичные единицы, как у хостинга) */
  function bytes(n) {
    if (n == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    return `${num(v, v >= 100 || i === 0 ? 0 : 1)} ${h.t(`srv.u.${units[i]}`)}`;
  }

  const gbOf = (n) => num(n / 1e9, n >= 100e9 ? 0 : 1);

  /** 93784 с → «1 д 2 ч» */
  function duration(seconds) {
    const d = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return h.t('srv.dur.dh', { d, h: hours });
    if (hours) return h.t('srv.dur.hm', { h: hours, m });
    return h.t('srv.dur.m', { m: Math.max(0, m) });
  }

  /* ------------------------------------------------------------- Прибор */

  const A0 = 135;
  const SWEEP = 270;
  const CX = 60;
  const CY = 58;

  const point = (a, r) => {
    const rad = ((A0 + SWEEP * Math.max(0, Math.min(1, a))) * Math.PI) / 180;
    return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
  };

  function arc(a1, a2, r) {
    if (a2 - a1 <= 0.0005) return '';
    const [x1, y1] = point(a1, r);
    const [x2, y2] = point(a2, r);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${(a2 - a1) * SWEEP > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }

  /**
   * Круглый прибор: шкала 270°, зелёная / жёлтая / красная зоны, стрелка и
   * цифровое табло. zones — [[от, до, 'ok'|'caution'|'warning'], …] в долях шкалы.
   */
  function gauge({ value, max, zones, readout, level, label, sub, spark }) {
    const a = value == null ? 0 : Math.max(0, Math.min(1, value / max));
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const [x1, y1] = point(i / 10, 46);
      const [x2, y2] = point(i / 10, i % 5 === 0 ? 38 : 41);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="g-tick${i % 5 === 0 ? ' g-tick--major' : ''}"/>`;
    }).join('');
    const bands = zones.map(([from, to, kind]) => `<path d="${arc(from, to, 49.5)}" class="g-zone g-zone--${kind}"/>`).join('');
    const [nx, ny] = point(a, 40);
    const needle = value == null ? '' : `<line x1="${CX}" y1="${CY}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="g-needle"/>`;
    return `
      <figure class="gauge">
        <svg viewBox="0 0 120 100" role="img" aria-label="${h.esc(`${label}: ${readout}`)}">
          <path d="${arc(0, 1, 44)}" class="g-track"/>
          <path d="${arc(0, a, 44)}" class="g-fill g-fill--${level}"/>
          ${bands}${ticks}${needle}
          <circle cx="${CX}" cy="${CY}" r="4.5" class="g-hub"/>
          <rect x="33" y="72" width="54" height="19" rx="3" class="g-box"/>
          <text x="60" y="86" class="g-read g-read--${level}">${h.esc(readout)}</text>
        </svg>
        <figcaption><b>${h.esc(label)}</b>${sub ? `<span>${h.esc(sub)}</span>` : ''}${spark || ''}</figcaption>
      </figure>`;
  }

  /** Зоны «чем больше — тем хуже»: зелёная до caution, жёлтая до warning, дальше красная */
  const zonesUp = (caution, warning, max) => [[0, caution / max, 'ok'], [caution / max, warning / max, 'caution'], [warning / max, 1, 'warning']];
  const levelUp = (v, caution, warning) => (v == null ? 'off' : v >= warning ? 'warning' : v >= caution ? 'caution' : 'ok');

  /** Мини-график за час: 0…max, пропуски — разрыв линии */
  function sparkline(values, max, title) {
    const n = values.length;
    if (!n || values.every((v) => v == null)) return '';
    const parts = [];
    let current = [];
    values.forEach((v, i) => {
      if (v == null) {
        if (current.length) parts.push(current);
        current = [];
        return;
      }
      current.push(`${((i / Math.max(1, n - 1)) * 100).toFixed(1)},${(20 - Math.min(1, v / max) * 18 - 1).toFixed(1)}`);
    });
    if (current.length) parts.push(current);
    const lines = parts.map((p) => (p.length === 1 ? `<circle cx="${p[0].split(',')[0]}" cy="${p[0].split(',')[1]}" r="1"/>` : `<polyline points="${p.join(' ')}"/>`)).join('');
    return `<span class="spark" title="${h.esc(title)}"><svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">${lines}</svg><i>${h.esc(h.t('srv.hour'))}</i></span>`;
  }

  /* ------------------------------------------------------------- Лампы */

  function messageFor(id, r) {
    const tr = r.traffic;
    const p = {
      disk: () => ({ free: bytes(r.host.disk?.free), total: bytes(r.host.disk?.total), percent: num(r.host.disk?.freePercent ?? 0, 0) }),
      cpu: () => ({ v: num(r.host.cpu, 0) }),
      memory: () => ({ v: num(r.host.memory.percent, 0), used: bytes(r.host.memory.used), total: bytes(r.host.memory.total) }),
      load: () => ({ v: num(r.host.load.perCore, 2) }),
      response: () => ({ v: num(r.engine.responseMs, 0) }),
      whatsapp: () => ({}),
      traffic: () => ({ used: `${gbOf(tr.used || 0)} ${h.t('srv.u.GB')}`, limit: `${num(tr.limitGb, 0)} ${h.t('srv.u.GB')}`, percent: num(tr.usedPercent || 0, 0), forecast: `${gbOf(tr.forecast || 0)} ${h.t('srv.u.GB')}` })
    }[id];
    return h.t(`srv.msg.${id}`, p ? p() : {});
  }

  function renderLamps(r, failed) {
    const levels = Object.fromEntries(r.lamps.map((l) => [l.id, l.level]));
    levels.engine = failed ? 'warning' : 'run';
    const warning = failed || r.master.warning;
    const caution = r.master.caution;
    const lamps = LAMPS.map((id) => {
      const level = levels[id] || 'off';
      const text = id === 'engine' && failed ? h.t('srv.lamp.noLink') : h.t(`srv.lamp.${id}`);
      return `<span class="lamp lamp--${level}" title="${h.esc(h.t(`srv.lampHint.${id}`))}">${h.esc(text)}</span>`;
    }).join('');
    const issues = r.lamps.filter((l) => l.level === 'warning' || l.level === 'caution')
      .sort((a, b) => (a.level === 'warning' ? 0 : 1) - (b.level === 'warning' ? 0 : 1));
    const messages = [
      ...(failed ? [`<li class="ecam--warning">${h.esc(h.t('srv.msg.noLink'))}</li>`] : []),
      ...issues.map((l) => `<li class="ecam--${l.level}">${h.esc(messageFor(l.id, r))}</li>`)
    ];
    return `
      <div class="ck-annun">
        <div class="ck-masters">
          <span class="master master--warning${warning ? ' is-on' : ''}">MASTER<br>WARNING</span>
          <span class="master master--caution${caution ? ' is-on' : ''}">MASTER<br>CAUTION</span>
        </div>
        <div class="ck-lamps">${lamps}</div>
      </div>
      <ul class="ecam">${messages.length ? messages.join('') : `<li class="ecam--ok">${h.esc(h.t('srv.msg.allOk'))}</li>`}</ul>`;
  }

  /* --------------------------------------------------- Приборы сервера */

  function renderHost(r) {
    const { host, thresholds: th } = r;
    const hist = r.history || [];
    const memPct = host.memory.percent;
    const disk = host.disk;
    const diskCaution = 100 - th.diskFree.caution;
    const diskWarning = 100 - th.diskFree.warning;
    const loadMax = 3;
    const gauges = [
      gauge({
        value: host.cpu, max: 100, zones: zonesUp(th.cpu.caution, th.cpu.warning, 100),
        readout: `${num(host.cpu ?? 0, 0)}%`, level: levelUp(host.cpu, th.cpu.caution, th.cpu.warning),
        label: h.t('srv.g.cpu'),
        sub: host.steal >= 1 ? h.t('srv.g.cpuSteal', { cores: host.cores, steal: num(host.steal, 0) }) : h.tn('srv.cores', host.cores),
        spark: sparkline(hist.map((x) => x.cpu), 100, h.t('srv.g.cpu'))
      }),
      gauge({
        value: memPct, max: 100, zones: zonesUp(th.memory.caution, th.memory.warning, 100),
        readout: `${num(memPct, 0)}%`, level: levelUp(memPct, th.memory.caution, th.memory.warning),
        label: h.t('srv.g.memory'), sub: `${bytes(host.memory.used)} / ${bytes(host.memory.total)}`,
        spark: sparkline(hist.map((x) => x.memory), 100, h.t('srv.g.memory'))
      }),
      gauge({
        value: host.load.perCore, max: loadMax, zones: zonesUp(th.load.caution, th.load.warning, loadMax),
        readout: num(host.load.load1, 2), level: levelUp(host.load.perCore, th.load.caution, th.load.warning),
        label: h.t('srv.g.load'), sub: h.t('srv.g.loadSub', { l5: num(host.load.load5, 2), l15: num(host.load.load15, 2), per: num(host.load.perCore, 2) })
      }),
      disk ? gauge({
        value: disk.percent, max: 100, zones: zonesUp(diskCaution, diskWarning, 100),
        readout: `${num(disk.percent, 0)}%`, level: levelUp(disk.percent, diskCaution, diskWarning),
        label: h.t('srv.g.disk'), sub: h.t('srv.g.diskSub', { free: bytes(disk.free), total: bytes(disk.total) })
      }) : ''
    ].join('');
    return `
      <section class="ck-panel">
        <h3 class="ck-title">${h.esc(h.t('srv.hostTitle'))}<span>${h.esc(h.t('srv.hostSub', { name: host.hostname, up: duration(host.uptimeSeconds) }))}</span></h3>
        <div class="ck-gauges">${gauges}</div>
      </section>`;
  }

  /* ---------------------------------------------------- Двигатель (бот) */

  function renderEngine(r) {
    const e = r.engine;
    const hist = r.history || [];
    const memMb = e.memory.rss / 1048576;
    const resp = e.responseMs;
    const th = r.thresholds.responseMs;
    const cells = [
      ['version', e.version.commit + (e.version.date ? ` · ${h.dateTime(e.version.date)}` : '')],
      ['uptime', duration(e.uptimeSeconds)],
      ['rpm', e.requestsPerMinute == null ? '—' : num(e.requestsPerMinute, 1)],
      ['response', resp == null ? '—' : h.t('srv.e.ms', { avg: num(resp, 0), max: num(e.maxResponseMs ?? resp, 0) }), levelUp(resp, th.caution, th.warning)],
      ['errors', String(e.errors5m), e.errors5m ? 'caution' : 'ok'],
      ['loop', e.loopDelayMs == null ? '—' : `${num(e.loopDelayMs, 1)} ${h.t('srv.u.ms')}`],
      ['db', e.sizes ? bytes(e.sizes.database) : '—'],
      ['uploads', e.sizes ? `${bytes(e.sizes.uploads.bytes)} · ${h.tn('srv.files', e.sizes.uploads.files)}` : '—'],
      ['images', e.sizes ? `${bytes(e.sizes.siteImages.bytes)} · ${h.tn('srv.files', e.sizes.siteImages.files)}` : '—'],
      ['sync', e.lastSyncAt ? `${h.time(e.lastSyncAt)}` : '—'],
      ['node', e.node]
    ].map(([key, value, level]) => `<div class="ck-cell"><span>${h.esc(h.t(`srv.e.${key}`))}</span><b class="${level ? `is-${level}` : ''}">${h.esc(value)}</b></div>`).join('');
    return `
      <section class="ck-panel">
        <h3 class="ck-title">${h.esc(h.t('srv.engineTitle'))}<span class="ck-run">● ${h.esc(h.t('srv.lamp.engine'))}</span></h3>
        <div class="ck-engine">
          <div class="ck-gauges ck-gauges--2">
            ${gauge({
              value: e.cpu, max: 100, zones: zonesUp(50, 80, 100), readout: `${num(e.cpu ?? 0, 1)}%`, level: levelUp(e.cpu, 50, 80),
              label: h.t('srv.e.cpu'), sub: h.t('srv.e.cpuSub'), spark: sparkline(hist.map((x) => x.procCpu), Math.max(5, ...hist.map((x) => x.procCpu || 0)), h.t('srv.e.cpu'))
            })}
            ${gauge({
              value: memMb, max: 1024, zones: zonesUp(512, 800, 1024), readout: `${num(memMb, 0)} ${h.t('srv.u.MiB')}`, level: levelUp(memMb, 512, 800),
              label: h.t('srv.e.memory'), sub: h.t('srv.e.memorySub', { heap: num(e.memory.heapUsed / 1048576, 0) })
            })}
          </div>
          <div class="ck-cells">${cells}
            <div class="ck-cell ck-cell--wide"><span>${h.esc(h.t('srv.e.rpmHour'))}</span>${sparkline(hist.map((x) => x.requests), Math.max(10, ...hist.map((x) => x.requests)), h.t('srv.e.rpmHour'))}</div>
          </div>
        </div>
      </section>`;
  }

  /* ---------------------------------------------------------- Трафик */

  function renderFuel(tr) {
    const used = Math.min(100, tr.usedPercent || 0);
    const forecast = Math.min(100, tr.forecastPercent || 0);
    const level = levelUp(tr.usedPercent, 70, 90);
    return `
      <div class="fuel">
        <div class="fuel__head">
          <span class="fuel__big is-${level}">${h.esc(`${gbOf(tr.used)} / ${num(tr.limitGb, 0)} ${h.t('srv.u.GB')}`)}</span>
          <span class="fuel__pct is-${level}">${h.esc(`${num(tr.usedPercent, 1)}%`)}</span>
        </div>
        <div class="fuel__bar" role="img" aria-label="${h.esc(h.t('srv.t.barAria', { used: num(tr.usedPercent, 1), forecast: num(tr.forecastPercent, 0) }))}">
          <span class="fuel__zone fuel__zone--caution" style="left:70%;width:20%"></span>
          <span class="fuel__zone fuel__zone--warning" style="left:90%;width:10%"></span>
          <span class="fuel__fill is-${level}" style="width:${used}%"></span>
          <span class="fuel__forecast${forecast < 10 ? ' fuel__forecast--start' : forecast > 90 ? ' fuel__forecast--end' : ''}" style="left:${forecast}%"><i>${h.esc(h.t('srv.t.forecastMark'))}</i></span>
        </div>
        <div class="fuel__scale"><span>0</span><span>${num(tr.limitGb / 2, 0)}</span><span>${num(tr.limitGb, 0)} ${h.esc(h.t('srv.u.GB'))}</span></div>
      </div>`;
  }

  function renderDays(tr) {
    const max = Math.max(1, ...tr.days.map((d) => d.rx + d.tx));
    const cols = tr.days.map((d) => {
      const day = Number(d.date.slice(8, 10));
      const isToday = d.date === tr.today;
      const label = day === 1 || day % 5 === 0 || isToday;
      const title = h.t('srv.t.dayTip', { day: h.shortDate(d.date), out: bytes(d.tx), in: bytes(d.rx) });
      return `
        <div class="tday${isToday ? ' tday--today' : ''}" title="${h.esc(title)}">
          <div class="tday__area"><div class="tday__stack" style="height:${((d.rx + d.tx) / max) * 100}%">
            <span class="tday__out" style="flex-grow:${d.tx}"></span><span class="tday__in" style="flex-grow:${d.rx}"></span>
          </div></div>
          <span class="tday__x">${label ? day : ''}</span>
        </div>`;
    }).join('');
    return `
      <div class="ck-sub">
        <div class="ck-subhead"><b>${h.esc(h.t('srv.t.daysTitle'))}</b><span class="tlegend"><span><i class="tsw tsw--out"></i>${h.esc(h.t('srv.t.out'))}</span><span><i class="tsw tsw--in"></i>${h.esc(h.t('srv.t.in'))}</span></span></div>
        <div class="tdays" style="--days:${tr.daysInMonth}">${cols}</div>
      </div>`;
  }

  function breakdownRows(rows, total, nameOf) {
    return rows.filter((row) => row.out > 0).map((row) => {
      const share = total ? (row.out / total) * 100 : 0;
      return `
        <div class="brow">
          <span class="brow__name">${h.esc(nameOf(row))}</span>
          <span class="brow__bar"><i style="width:${Math.max(share, 0.5)}%"></i></span>
          <span class="brow__val">${h.esc(bytes(row.out))}</span>
          <span class="brow__pct">${h.esc(`${num(share, share < 10 ? 1 : 0)}%`)}</span>
        </div>`;
    }).join('');
  }

  function renderBreakdown(tr) {
    const web = tr.web;
    if (!web.available && !tr.available) return '';
    const categories = [...web.categories];
    if (tr.available && tr.otherOut > 0) categories.push({ id: 'system', out: tr.otherOut, in: tr.otherIn, requests: 0 });
    categories.sort((a, b) => b.out - a.out || CATEGORY_ORDER.indexOf(a.id) - CATEGORY_ORDER.indexOf(b.id));
    const total = categories.reduce((s, c) => s + c.out, 0);
    const hostTotal = web.hosts.reduce((s, x) => s + x.out, 0);
    const byCategory = breakdownRows(categories, total, (c) => h.t(`srv.cat.${c.id}`));
    const byHost = breakdownRows(web.hosts, hostTotal, (x) => x.id);
    return `
      <div class="ck-sub">
        <div class="ck-subhead"><b>${h.esc(h.t('srv.t.whereTitle'))}</b><span>${h.esc(h.t('srv.t.whereSub'))}</span></div>
        ${byCategory || `<p class="ck-note">${h.esc(h.t('srv.t.noWeb'))}</p>`}
        ${web.bots.out ? `<p class="ck-note">${h.esc(h.t('srv.t.bots', { out: bytes(web.bots.out), n: num(web.bots.requests, 0), percent: num(web.out ? (web.bots.out / web.out) * 100 : 0, 0) }))}</p>` : ''}
        ${byHost ? `<div class="ck-subhead ck-subhead--2"><b>${h.esc(h.t('srv.t.hostsTitle'))}</b><span>${h.esc(h.tn('srv.requests', web.requests))}</span></div>${byHost}` : ''}
      </div>`;
  }

  function renderMonths(tr) {
    if (!tr.months?.length) return '';
    const fmt = new Intl.DateTimeFormat(h.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const rows = [...tr.months].reverse().map((m) => `<tr><td>${h.esc(fmt.format(new Date(`${m.month}-01T00:00:00Z`)))}</td><td>${h.esc(bytes(m.tx))}</td><td>${h.esc(bytes(m.rx))}</td></tr>`).join('');
    return `
      <details class="ck-months">
        <summary>${h.esc(h.t('srv.t.months'))}</summary>
        <table><thead><tr><th>${h.esc(h.t('srv.t.month'))}</th><th>${h.esc(h.t('srv.t.out'))}</th><th>${h.esc(h.t('srv.t.in'))}</th></tr></thead><tbody>${rows}</tbody></table>
      </details>`;
  }

  function renderTraffic(r) {
    const tr = r.traffic;
    const monthName = new Intl.DateTimeFormat(h.locale, { month: 'long', timeZone: 'UTC' }).format(new Date(`${tr.month}-01T00:00:00Z`));
    const head = `<h3 class="ck-title">${h.esc(h.t('srv.trafficTitle', { month: monthName }))}<span>${h.esc(h.t(tr.basis === 'out' ? 'srv.t.basisOut' : 'srv.t.basisTotal'))}</span></h3>`;
    if (!tr.available) {
      return `
        <section class="ck-panel">
          ${head}
          <p class="ck-note ck-note--warn">${h.esc(h.t(`srv.t.no.${tr.reason || 'error'}`))}</p>
          ${renderBreakdown(tr)}
        </section>`;
    }
    const stat = (key, value, extra = '') => `<div class="ck-cell"><span>${h.esc(h.t(`srv.t.${key}`))}</span><b class="${extra}">${h.esc(value)}</b></div>`;
    const both = (out, inn) => `↑ ${bytes(out)} · ↓ ${bytes(inn)}`;
    return `
      <section class="ck-panel">
        ${head}
        ${renderFuel(tr)}
        <div class="ck-cells ck-cells--traffic">
          ${stat('monthOut', bytes(tr.monthTx))}
          ${stat('monthIn', bytes(tr.monthRx))}
          ${stat('today', both(tr.todayTx, tr.todayRx))}
          ${stat('yesterday', both(tr.yesterdayTx, tr.yesterdayRx))}
          ${stat('perDay', bytes(tr.perDay))}
          ${stat('forecast', `${gbOf(tr.forecast)} ${h.t('srv.u.GB')} · ${num(tr.forecastPercent, 0)}%`, `is-${levelUp(tr.forecastPercent, 70, 90)}`)}
        </div>
        ${renderDays(tr)}
        ${renderBreakdown(tr)}
        ${renderMonths(tr)}
        <p class="ck-note">${h.esc(h.t('srv.t.source', { iface: tr.interface, time: tr.updatedAt ? tr.updatedAt.slice(11, 16) : '—' }))}</p>
      </section>`;
  }

  /* --------------------------------------------------------- Настройки */

  function renderSettings(settings, status) {
    if (!settings) return '';
    return `
      <form class="card srv-settings" id="srv-settings" novalidate>
        <h3>${h.esc(h.t('srv.s.title'))}</h3>
        <div class="srv-settings__row">
          <label class="field"><span>${h.esc(h.t('srv.s.limit'))}</span>
            <input type="number" name="limit" min="1" max="100000" step="1" inputmode="numeric" value="${h.esc(settings.limitGb)}" required /></label>
          <label class="field"><span>${h.esc(h.t('srv.s.basis'))}</span>
            <select name="basis" class="search">
              <option value="out"${settings.basis === 'out' ? ' selected' : ''}>${h.esc(h.t('srv.s.basisOut'))}</option>
              <option value="total"${settings.basis === 'total' ? ' selected' : ''}>${h.esc(h.t('srv.s.basisTotal'))}</option>
            </select></label>
          <button type="submit" class="btn btn--primary">${h.esc(h.t('srv.s.save'))}</button>
        </div>
        <p class="muted md-hint">${h.esc(h.t('srv.s.hint'))}</p>
        ${status ? `<p class="md-status is-${status.kind === 'error' ? 'error' : 'ok'}" role="status">${h.esc(status.text)}</p>` : ''}
      </form>`;
  }

  /* -------------------------------------------------------------- Всё */

  /**
   * report — ответ /api/staff/server (или null, пока грузится), failed — нет
   * связи с сервером (показываем последний отчёт и красную лампу).
   */
  function render(report, { failed, helpers }) {
    h = helpers;
    if (!report) return `<div class="empty">${h.esc(failed ? h.t('srv.loadFailed') : h.t('app.loading'))}</div>`;
    return `
      <div class="cockpit">
        ${renderLamps(report, failed)}
        ${renderHost(report)}
        ${renderEngine(report)}
        ${renderTraffic(report)}
        <p class="ck-foot">${h.esc(h.t('srv.updated', { time: h.time(report.at) }))}</p>
      </div>`;
  }

  /** Форма лимита трафика — отдельно, чтобы обновление приборов не сбивало ввод */
  function settings(report, status, helpers) {
    h = helpers;
    return report ? renderSettings(report.settings, status) : '';
  }

  window.STAFF_COCKPIT = { render, settings };
})();
