/*
 * Вкладка «Ошибки и предложения»: сотрудник присылает тикет — ошибку (готовая
 * причина на выбор) или предложение, коротко текстом и со скриншотом. Кто,
 * с какой вкладки, когда и с какого устройства — добавляется само.
 * Разбирающие («Ошибки и предложения: меняет» — админ и владелец) видят все
 * тикеты, меняют статус и отвечают автору. Остальные видят свои тикеты и ответы.
 * Тексты — i18n (tk.*).
 */
(function () {
  'use strict';

  const CATEGORIES = ['not_loading', 'broken_action', 'wrong_data', 'missing_message', 'text', 'slow', 'other'];
  const FILTERS = ['open', 'new', 'work', 'done', 'rejected', 'all'];
  // Какие кнопки статуса показать разбирающему при текущем статусе
  const MOVES = { new: ['work', 'done', 'rejected'], work: ['done', 'rejected', 'new'], done: ['work'], rejected: ['work'] };
  const DEVICE_ICON = { phone: '📱', tablet: '📱', computer: '💻' };

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = {
      data: null, failed: null, filter: 'open', busy: null, cardMsg: null,
      form: { kind: 'bug', category: null, text: '', shot: null, preparing: false, sending: false, msg: null },
      notes: new Map()
    };
    const canHandle = () => Boolean(st.data?.canHandle);

    /* ------------------------------------------------------------ Данные */

    async function load() {
      try {
        const data = await api('/tickets');
        st.data = data;
        st.failed = null;
        ctx.onBadge(data.badge, data.canHandle);
        // Автор открыл вкладку — ответы прочитаны (подсветка остаётся до следующей загрузки)
        if (!data.canHandle && data.tickets.some((x) => x.unseen)) {
          api('/tickets/seen', { method: 'POST' }).then(() => ctx.onBadge(0, false)).catch(() => {});
        }
      } catch {
        st.failed = t('tk.loadFailed');
      }
      ctx.rerender();
    }

    /** Устройство и браузер — коротко, без лишних данных */
    function device() {
      const ua = navigator.userAgent;
      const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
      const minSide = Math.min(window.screen.width, window.screen.height);
      // Сначала по самому устройству (iPhone, Android-телефон), потом по сенсорному экрану
      const type = /ipad|tablet/i.test(ua) || (ios && !/iphone|ipod/i.test(ua)) || (/android/i.test(ua) && !/mobile/i.test(ua)) ? 'tablet'
        : /iphone|ipod|mobi/i.test(ua) ? 'phone'
          : !touch ? 'computer' : minSide >= 600 ? 'tablet' : 'phone';
      const iosVer = (/OS (\d+)[._](\d+)/.exec(ua) || []).slice(1, 3).join('.');
      const androidVer = (/Android (\d+(?:\.\d+)?)/.exec(ua) || [])[1] || '';
      const os = ios ? `iOS ${iosVer}`.trim() : /android/i.test(ua) ? `Android ${androidVer}`.trim()
        : /windows/i.test(ua) ? 'Windows' : /mac os x/i.test(ua) ? 'macOS' : /cros/i.test(ua) ? 'ChromeOS' : /linux/i.test(ua) ? 'Linux' : '';
      const browser = /edg(e|a|ios)?\//i.test(ua) ? 'Edge' : /samsungbrowser/i.test(ua) ? 'Samsung Internet' : /opr\/|opera/i.test(ua) ? 'Opera'
        : /firefox|fxios/i.test(ua) ? 'Firefox' : /crios|chrome/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : '';
      const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      const script = document.querySelector('script[src*="staff.js"]');
      const version = (/[?&]v=(\w+)/.exec(script?.getAttribute('src') || '') || [])[1] || '';
      return { type, os, browser, screen: `${window.screen.width}×${window.screen.height}`, installed, lang: ctx.lang(), version };
    }

    /** «📱 Телефон · iOS 18.1 · Safari · 390×844 · приложение» */
    function deviceText(d) {
      if (!d || !d.type) return '';
      return [`${DEVICE_ICON[d.type] || ''} ${t(`tk.device.${d.type}`)}`, d.os, d.browser, d.screen, d.installed ? t('tk.installed') : '']
        .filter(Boolean).join(' · ');
    }

    const tabText = (id) => (id ? t('tk.onTab', { tab: ctx.tabTitle(id) }) : '');
    const what = (x) => (x.kind === 'bug' ? t(`tk.cat.${x.category || 'other'}`) : t('tk.idea'));

    /* ------------------------------------------------------------ Экран */

    function render() {
      return `<div class="tk">${renderForm()}${renderList()}</div>`;
    }

    function renderForm() {
      const f = st.form;
      const bug = f.kind === 'bug';
      const prev = ctx.prevTab();
      const auto = [ctx.userName(), tabText(prev), deviceText(device())].filter(Boolean).join(' · ');
      const pasteHint = window.matchMedia('(pointer: coarse)').matches ? '' : `<span class="tk-hint">${esc(t('tk.shotPaste'))}</span>`;
      return `
        <section class="card tk-form" aria-labelledby="tk-form-title">
          <h2 id="tk-form-title">${esc(t('tk.newTitle'))}</h2>
          <p class="tk-intro">${esc(t('tk.intro'))}</p>
          <form data-tk-form novalidate>
            <div class="tk-kinds" role="group" aria-label="${esc(t('tk.kindLabel'))}">
              ${['bug', 'idea'].map((k) => `<button type="button" class="tk-kind tk-kind--${k}" data-tk-kind="${k}" aria-pressed="${f.kind === k}">${esc(t(`tk.kind.${k}`))}</button>`).join('')}
            </div>
            ${bug ? `
              <fieldset class="tk-cats">
                <legend>${esc(t('tk.whatHappened'))}</legend>
                <div class="tk-cats__list">
                  ${CATEGORIES.map((c) => `<button type="button" class="chip" data-tk-cat="${c}" aria-pressed="${f.category === c}">${esc(t(`tk.cat.${c}`))}</button>`).join('')}
                </div>
              </fieldset>` : ''}
            <label class="field tk-text">
              <span>${esc(t('tk.textLabel'))}</span>
              <textarea class="search" data-tk-text rows="4" maxlength="2000" placeholder="${esc(t(bug ? 'tk.textBug' : 'tk.textIdea'))}">${esc(f.text)}</textarea>
            </label>
            <div class="tk-shot">
              ${f.shot ? `
                <figure class="tk-shot__preview">
                  <img src="${esc(f.shot.url)}" alt="${esc(t('tk.shotAlt'))}" />
                  <button type="button" class="btn btn--small" data-tk-shot-remove>✕ ${esc(t('tk.shotRemove'))}</button>
                </figure>` : `
                <label class="btn btn--small tk-shot__add">
                  <input type="file" accept="image/*" data-tk-file hidden />
                  ${esc(f.preparing ? t('tk.shotPreparing') : t('tk.shotAdd'))}
                </label>${pasteHint}`}
            </div>
            <p class="tk-auto">${esc(t('tk.auto'))} <span>${esc(auto)}</span></p>
            <div class="tk-actions">
              <button type="submit" class="btn btn--primary" ${f.sending || f.preparing ? 'disabled' : ''}>${esc(f.sending ? t('tk.sending') : t('tk.send'))}</button>
              ${f.msg ? `<p class="tk-msg tk-msg--${f.msg.kind}" role="status">${esc(f.msg.text)}</p>` : ''}
            </div>
          </form>
        </section>`;
    }

    function renderList() {
      if (st.failed) return `<div class="card empty">${esc(st.failed)}</div>`;
      if (!st.data) return `<div class="card empty">${esc(t('app.loading'))}</div>`;
      const all = st.data.tickets;
      const handler = canHandle();
      const count = (f) => all.filter((x) => matches(x, f)).length;
      const list = handler ? all.filter((x) => matches(x, st.filter)) : all;
      const filters = handler ? `
        <div class="chips tk-filters" role="group" aria-label="${esc(t('tk.filterLabel'))}">
          ${FILTERS.map((f) => `<button type="button" class="chip" data-tk-filter="${f}" aria-pressed="${st.filter === f}">${esc(t(`tk.f.${f}`))} <span class="chip__n">${count(f)}</span></button>`).join('')}
        </div>` : '';
      const empty = !all.length ? t(handler ? 'tk.empty' : 'tk.emptyMine') : t('tk.emptyFilter');
      return `
        <section class="tk-list" aria-labelledby="tk-list-title">
          <h2 class="section-title" id="tk-list-title">${esc(t(handler ? 'tk.allTitle' : 'tk.mineTitle'))}</h2>
          ${filters}
          ${list.length ? `<div class="list">${list.map(renderTicket).join('')}</div>` : `<div class="card empty">${esc(empty)}</div>`}
        </section>`;
    }

    function matches(x, filter) {
      if (filter === 'all') return true;
      if (filter === 'open') return x.status === 'new' || x.status === 'work';
      return x.status === filter;
    }

    function renderTicket(x) {
      const handler = canHandle();
      const meta = [x.own && !handler ? '' : x.author.name, tabText(x.tab), deviceText(x.device), ctx.dateTime(x.createdAt)].filter(Boolean).join(' · ');
      const history = x.history.length ? `
        <ol class="tk-history">
          ${x.history.map((h) => `
            <li>
              <span class="tk-history__at">${esc(ctx.dateTime(h.at))} · ${esc(h.by)}</span>
              ${h.status ? `<span class="pill tk-st tk-st--${h.status}">${esc(t(`tk.st.${h.status}`))}</span>` : ''}
              ${h.note ? `<p>${esc(h.note)}</p>` : ''}
            </li>`).join('')}
        </ol>` : '';
      const msg = st.cardMsg?.id === x.id ? `<p class="tk-msg tk-msg--${st.cardMsg.kind}" role="status">${esc(st.cardMsg.text)}</p>` : '';
      const busy = st.busy === x.id;
      const controls = handler ? `
        <div class="tk-handle">
          <textarea class="search" rows="2" maxlength="1000" data-tk-note="${x.id}" placeholder="${esc(t('tk.notePh'))}" aria-label="${esc(t('tk.notePh'))}">${esc(st.notes.get(x.id) || '')}</textarea>
          <div class="tk-handle__btns">
            ${(MOVES[x.status] || []).map((s) => `<button type="button" class="btn btn--small tk-to tk-to--${s}" data-tk-status="${s}" data-tk-id="${x.id}" ${busy ? 'disabled' : ''}>${esc(t(`tk.to.${s}`))}</button>`).join('')}
            <button type="button" class="btn btn--small" data-tk-reply="${x.id}" ${busy ? 'disabled' : ''}>${esc(t('tk.reply'))}</button>
            <button type="button" class="btn btn--small btn--danger-text tk-del" data-tk-delete="${x.id}" ${busy ? 'disabled' : ''}>${esc(t('tk.delete'))}</button>
          </div>
          ${msg}
        </div>` : msg;
      return `
        <article class="card tk-item tk-item--${x.status}${x.unseen ? ' tk-item--unseen' : ''}" data-tk-ticket="${x.id}">
          <header class="tk-item__head">
            <span class="tk-item__id">${x.kind === 'bug' ? '🐞' : '💡'} #${x.id}</span>
            <b class="tk-item__what">${esc(what(x))}</b>
            <span class="pill tk-st tk-st--${x.status}">${esc(t(`tk.st.${x.status}`))}</span>
            ${x.unseen ? `<span class="pill pill--new">${esc(t('tk.newAnswer'))}</span>` : ''}
          </header>
          <p class="tk-item__text">${esc(x.text)}</p>
          ${x.hasShot ? `<a class="tk-item__shot" href="${esc(ctx.apiBase)}/tickets/shot?id=${x.id}" target="_blank" rel="noopener" title="${esc(t('tk.shotOpen'))}"><img loading="lazy" src="${esc(ctx.apiBase)}/tickets/shot?id=${x.id}" alt="${esc(t('tk.shotAlt'))}" /></a>` : ''}
          <p class="tk-item__meta">${esc(meta)}</p>
          ${history}
          ${controls}
        </article>`;
    }

    /* ------------------------------------------------------- Скриншот */

    async function setShot(file) {
      if (!file || !/^image\//.test(file.type)) return;
      st.form.preparing = true;
      st.form.msg = null;
      ctx.rerender();
      try {
        const blob = await ctx.prepareShot(file);
        if (!blob) throw new Error('bad image');
        if (st.form.shot) URL.revokeObjectURL(st.form.shot.url);
        st.form.shot = { blob, url: URL.createObjectURL(blob) };
      } catch {
        st.form.msg = { kind: 'error', text: t('tk.shotFailed') };
      }
      st.form.preparing = false;
      ctx.rerender();
    }

    function clearShot() {
      if (st.form.shot) URL.revokeObjectURL(st.form.shot.url);
      st.form.shot = null;
    }

    /** Ctrl+V на компьютере: картинка из буфера обмена — скриншотом */
    function onPaste(event) {
      const item = [...(event.clipboardData?.items || [])].find((i) => i.kind === 'file' && /^image\//.test(i.type));
      if (!item) return false;
      event.preventDefault();
      setShot(item.getAsFile());
      return true;
    }

    /* ------------------------------------------------------- Действия */

    async function send() {
      const f = st.form;
      const text = f.text.trim();
      if (f.kind === 'bug' && !f.category) return setFormMsg('error', t('tk.needCategory'));
      if (text.length < 3) return setFormMsg('error', t('tk.needText'));
      f.sending = true;
      f.msg = null;
      ctx.rerender();
      let ticket;
      try {
        ({ ticket } = await api('/tickets', { body: { kind: f.kind, category: f.kind === 'bug' ? f.category : null, text, tab: ctx.prevTab(), device: device() } }));
      } catch (err) {
        f.sending = false;
        return setFormMsg('error', err.code === 'too_many_requests' ? t('tk.tooMany') : t('tk.sendFailed'));
      }
      let shotOk = true;
      if (f.shot) {
        try { await ctx.uploadImage(`/tickets/shot?id=${ticket.id}`, f.shot.blob); } catch { shotOk = false; }
      }
      clearShot();
      Object.assign(f, { category: null, text: '', sending: false });
      setFormMsg(shotOk ? 'ok' : 'error', t(shotOk ? 'tk.sent' : 'tk.sentNoShot', { id: ticket.id }), false);
      await load();
    }

    function setFormMsg(kind, text, rerender = true) {
      st.form.msg = { kind, text };
      if (rerender) ctx.rerender();
    }

    async function setStatus(id, status) {
      const note = (st.notes.get(id) || '').trim();
      if (!status && !note) {
        st.cardMsg = { id, kind: 'error', text: t('tk.needNote') };
        return ctx.rerender();
      }
      st.busy = id;
      ctx.rerender();
      try {
        const { ticket } = await api('/tickets/status', { body: { id, status: status || undefined, note } });
        st.data.tickets = st.data.tickets.map((x) => (x.id === id ? ticket : x));
        st.notes.delete(id);
        st.cardMsg = { id, kind: 'ok', text: t(ticket.own ? 'tk.savedSelf' : 'tk.saved') };
      } catch {
        st.cardMsg = { id, kind: 'error', text: t('tk.saveFailed') };
      }
      st.busy = null;
      ctx.rerender();
      refreshBadge();
    }

    async function remove(id) {
      if (!window.confirm(t('tk.deleteConfirm', { id }))) return;
      st.busy = id;
      ctx.rerender();
      try {
        await api('/tickets/delete', { body: { id } });
        st.data.tickets = st.data.tickets.filter((x) => x.id !== id);
      } catch {
        st.cardMsg = { id, kind: 'error', text: t('tk.saveFailed') };
      }
      st.busy = null;
      ctx.rerender();
      refreshBadge();
    }

    function refreshBadge() {
      if (canHandle()) ctx.onBadge(st.data.tickets.filter((x) => x.status === 'new').length, true);
    }

    /* ------------------------------------------------------- События */

    function onClick(event) {
      const el = event.target.closest('[data-tk-kind], [data-tk-cat], [data-tk-filter], [data-tk-status], [data-tk-reply], [data-tk-delete], [data-tk-shot-remove]');
      if (!el) return false;
      const d = el.dataset;
      if (d.tkKind) { st.form.kind = d.tkKind; st.form.msg = null; }
      else if (d.tkCat) { st.form.category = d.tkCat; st.form.msg = null; }
      else if (d.tkFilter) st.filter = d.tkFilter;
      else if (d.tkStatus) { setStatus(Number(d.tkId), d.tkStatus); return true; }
      else if (d.tkReply) { setStatus(Number(d.tkReply), null); return true; }
      else if (d.tkDelete) { remove(Number(d.tkDelete)); return true; }
      else if ('tkShotRemove' in d) clearShot();
      ctx.rerender();
      return true;
    }

    function onInput(event) {
      if (event.target.matches('[data-tk-text]')) { st.form.text = event.target.value; return true; }
      if (event.target.matches('[data-tk-note]')) { st.notes.set(Number(event.target.dataset.tkNote), event.target.value); return true; }
      return false;
    }

    function onChange(event) {
      if (!event.target.matches('[data-tk-file]')) return false;
      setShot(event.target.files?.[0]);
      return true;
    }

    function onSubmit(event) {
      if (!event.target.closest('[data-tk-form]')) return false;
      event.preventDefault();
      if (!st.form.sending) send();
      return true;
    }

    /** Фоновое обновление не трогает вкладку, пока сотрудник пишет */
    function canRefresh() {
      return !document.activeElement?.closest?.('.tk textarea, .tk input') && !st.form.sending && !st.busy;
    }

    return { load, render, onClick, onInput, onChange, onSubmit, onPaste, canRefresh };
  }

  window.STAFF_TICKETS = { create };
})();
