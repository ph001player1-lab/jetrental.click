/*
 * Вкладка «Доступы» (только админ): сотрудники, роли и права по разделам.
 * Админы — из Google-таблицы (их здесь только видно). Остальных сотрудников
 * админ добавляет здесь, назначает роль, отключает. У каждой роли по каждому
 * разделу: ✏️ меняет / 👁 смотрит / — раздела не видно. Всё сохраняется сразу.
 */
(function () {
  'use strict';

  const LEVEL_ICON = { edit: '✏️', view: '👁', none: '—' };

  function create(ctx) {
    const { api, t, esc } = ctx;
    const st = { data: null, failed: false, editing: null, note: null, busy: false, pick: null };

    async function load() {
      try {
        st.data = await api('/access');
        st.failed = false;
      } catch (err) {
        st.failed = ctx.errorText(err);
      }
      ctx.rerender();
    }

    /** Сообщение под разделом: ✓ сохранено / ошибка */
    function flash(kind, text) {
      st.note = { kind, text };
      ctx.rerender();
      clearTimeout(flash.timer);
      if (kind === 'ok') flash.timer = setTimeout(() => { st.note = null; ctx.rerender(); }, 2500);
    }

    async function call(path, body, okText = t('ac.saved')) {
      if (st.busy) return false;
      st.busy = true;
      try {
        await api(path, { body });
        st.data = await api('/access');
        flash('ok', okText);
        return true;
      } catch (err) {
        flash('error', t(`ac.err.${err.code}`) === `ac.err.${err.code}` ? ctx.errorText(err) : t(`ac.err.${err.code}`));
        return false;
      } finally {
        st.busy = false;
      }
    }

    const roleName = (id) => (id === 'admin' ? t('role.admin') : st.data?.roles.find((r) => r.id === id)?.name || id);

    /* ---------------------------------------------------------- Сотрудники */

    function staffForm(s) {
      const roles = st.data.roles.map((r) => `<option value="${esc(r.id)}"${r.id === s.roleId ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
      const sources = (st.data.sources || []).map((x) => `<option value="${x.id}"${x.id === s.sourceId ? ' selected' : ''}>${esc(x.name)}${x.active ? '' : ` (${esc(t('ac.f.sourceOff'))})`}</option>`).join('');
      return `
        <form class="ac-form card" data-ac-staff="${esc(s.id || '')}">
          <h4>${esc(t(s.id ? 'ac.staff.edit' : 'ac.staff.add'))}</h4>
          <div class="ac-form__grid">
            <label class="field"><span>${esc(t('ac.f.name'))}</span><input name="name" class="search" required maxlength="60" value="${esc(s.name || '')}"></label>
            <label class="field"><span>${esc(t('ac.f.email'))}</span><input name="email" type="email" class="search" value="${esc(s.email || '')}" placeholder="name@gmail.com"></label>
            <label class="field"><span>${esc(t('ac.f.role'))}</span><select name="roleId" class="search">${roles}</select></label>
            <label class="field"><span>${esc(t('ac.f.whatsapp'))}</span><input name="whatsapp" class="search" inputmode="tel" value="${esc(s.whatsapp ? `+${s.whatsapp}` : '')}" placeholder="+66 6x xxx xxxx"></label>
            <label class="field"><span>${esc(t('ac.f.rate'))}</span><input name="rate" class="search" type="number" min="0" step="1" inputmode="numeric" value="${esc(s.rate ? String(s.rate) : '')}" placeholder="0"></label>
            <label class="field"><span>${esc(t('ac.f.telegram'))}</span><input name="telegramId" class="search" inputmode="numeric" value="${esc(s.telegramId || '')}" placeholder="123456789"></label>
            <label class="field"><span>${esc(t('ac.f.source'))}</span>
              <select name="sourceId" class="search"><option value="">${esc(t('ac.f.sourceNone'))}</option>${sources}</select></label>
          </div>
          <p class="muted jr-small">${esc(t('ac.f.hint'))}</p>
          <div class="ac-form__buttons">
            <button type="submit" class="btn btn--primary btn--small">${esc(t('ac.save'))}</button>
            <button type="button" class="btn btn--small" data-ac-cancel>${esc(t('ac.cancel'))}</button>
          </div>
        </form>`;
    }

    /** Под именем: номер WhatsApp (если имя — не сам номер) и имя из WhatsApp, когда человек уже писал в группу */
    function staffSub(s) {
      const parts = [];
      if (s.whatsapp && /\p{L}/u.test(s.name)) parts.push(`WhatsApp +${s.whatsapp}`);
      if (s.waName && s.waName !== s.name) parts.push(t('ac.waName', { name: s.waName }));
      const source = s.sourceId && (st.data.sources || []).find((x) => x.id === s.sourceId);
      if (source) parts.push(t('ac.cabinetOf', { name: source.name }));
      return parts.length ? `<div class="muted jr-small">${esc(parts.join(' · '))}</div>` : '';
    }

    function renderStaff() {
      const d = st.data;
      const roleOptions = (current) => d.roles.map((r) => `<option value="${esc(r.id)}"${r.id === current ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
      const admins = d.admins.map((a) => `<li>👑 <b>${esc(a.name)}</b> <span class="muted">${esc(a.email)}</span></li>`).join('');
      // Без почты — «не подключён»: подсвечиваем, чтобы админ видел, кому ещё нужна почта
      const rows = d.staff.map((s) => `
        <tr class="${s.active ? '' : 'ac-off'}${s.connected ? '' : ' ac-nomail'}">
          <td><b>${esc(s.name)}</b>${staffSub(s)}</td>
          <td class="ac-email">${s.connected ? esc(s.email) : `<span class="ac-badge">${esc(t('ac.notConnected'))}</span>`}</td>
          <td><select class="search ac-select" data-ac-role="${s.id}" aria-label="${esc(t('ac.f.role'))}">${roleOptions(s.roleId)}</select></td>
          <td><label class="ac-switch"><input type="checkbox" data-ac-active="${s.id}"${s.active ? ' checked' : ''}> ${esc(t(s.active ? 'ac.active' : 'ac.inactive'))}</label></td>
          <td class="ac-actions">
            <button type="button" class="link" data-ac-edit="${s.id}">${esc(t('ac.edit'))}</button>
            <button type="button" class="link ac-danger" data-ac-del="${s.id}">${esc(t('ac.delete'))}</button>
          </td>
        </tr>`).join('');
      const editing = st.editing === 'new' ? staffForm({ roleId: 'viewer', active: true })
        : st.editing ? staffForm(d.staff.find((s) => s.id === st.editing) || {}) : '';
      return `
        <section class="card ac-sec">
          <h3>${esc(t('ac.staff.title'))}</h3>
          <p class="jr-counts">
            <span class="jr-count jr-count--fresh">${esc(t('ac.connected', { n: d.staff.filter((s) => s.connected && s.active).length }))}</span>
            <span class="jr-count jr-count--${d.staff.some((s) => !s.connected) ? 'late' : 'zero'}">${esc(t('ac.notConnectedN', { n: d.staff.filter((s) => !s.connected).length }))}</span>
          </p>
          <p class="muted jr-small">${esc(t('ac.staff.adminsNote'))}</p>
          <ul class="ac-admins">${admins}</ul>
          ${d.staff.length ? `<div class="table-wrap"><table class="ac-table">
            <thead><tr><th>${esc(t('ac.f.name'))}</th><th>${esc(t('ac.f.email'))}</th><th>${esc(t('ac.f.role'))}</th><th>${esc(t('ac.f.access'))}</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : `<p class="empty">${esc(t('ac.staff.none'))}</p>`}
          ${editing || `<button type="button" class="btn btn--small" data-ac-add>＋ ${esc(t('ac.staff.add'))}</button>`}
          <details class="ac-bulk"${st.bulkOpen ? ' open' : ''} data-ac-bulkbox>
            <summary>${esc(t('ac.bulk.title'))}</summary>
            <form data-ac-bulk>
              <p class="muted jr-small">${esc(t('ac.bulk.how'))}</p>
              <textarea name="text" class="search ac-bulk__text" rows="8" placeholder="${esc(t('ac.bulk.example'))}"></textarea>
              <button type="submit" class="btn btn--small btn--primary">${esc(t('ac.bulk.go'))}</button>
            </form>
          </details>
        </section>`;
    }

    /* --------------------------------------------------------------- Роли */

    function renderRoles() {
      const d = st.data;
      const head = d.roles.map((r) => `
        <th class="ac-role">
          <input class="ac-rname" data-ac-rname="${esc(r.id)}" value="${esc(r.name)}" maxlength="40" aria-label="${esc(t('ac.roleName'))}">
          <div class="ac-role__meta"><span class="muted">${esc(t('ac.people', { n: r.staffCount }))}</span>
            ${r.staffCount ? '' : `<button type="button" class="link ac-danger" data-ac-rdel="${esc(r.id)}" title="${esc(t('ac.delete'))}">🗑</button>`}</div>
        </th>`).join('');
      const body = d.sections.map((sec) => `
        <tr>
          <th class="ac-sec-name">${esc(t(`ac.s.${sec.id}`))}<div class="muted jr-small">${esc(t(`ac.h.${sec.id}`))}</div></th>
          <td class="ac-admin-cell" title="${esc(t('ac.adminFixed'))}">${LEVEL_ICON[sec.levels[0]]}</td>
          ${d.roles.map((r) => `
            <td><select class="ac-level ac-level--${r.perms[sec.id]}" data-ac-perm="${esc(r.id)}" data-ac-section="${esc(sec.id)}" aria-label="${esc(`${r.name}: ${t(`ac.s.${sec.id}`)}`)}">
              ${sec.levels.map((l) => `<option value="${l}"${r.perms[sec.id] === l ? ' selected' : ''}>${LEVEL_ICON[l]} ${esc(t(`ac.l.${l}`))}</option>`).join('')}
            </select></td>`).join('')}
        </tr>`).join('');
      return `
        <section class="card ac-sec">
          <h3>${esc(t('ac.roles.title'))}</h3>
          <p class="muted jr-small">${esc(t('ac.roles.note'))}</p>
          <div class="table-wrap ac-matrix-wrap ac-roles-desk"><table class="ac-matrix">
            <thead><tr><th></th><th class="ac-role ac-role--admin">${esc(t('role.admin'))}<div class="muted jr-small">${esc(t('ac.adminFromSheet'))}</div></th>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table></div>
          ${renderRolesPhone()}
          <form class="ac-newrole" data-ac-newrole>
            <input name="name" class="search" maxlength="40" placeholder="${esc(t('ac.roles.newName'))}" required>
            <button type="submit" class="btn btn--small">＋ ${esc(t('ac.roles.add'))}</button>
          </form>
        </section>`;
    }

    /** Телефон: одна роль за раз — выбор роли сверху, у разделов крупные кнопки уровней */
    function renderRolesPhone() {
      const d = st.data;
      const role = d.roles.find((r) => r.id === st.pick) || d.roles[0];
      if (!role) return '';
      const chips = d.roles.map((r) => `<button type="button" class="chip" data-ac-pick="${esc(r.id)}" aria-pressed="${r.id === role.id}">${esc(r.name)}</button>`).join('');
      const sections = d.sections.map((sec) => `
        <li>
          <div class="ac-phone-sec"><b>${esc(t(`ac.s.${sec.id}`))}</b><div class="muted jr-small">${esc(t(`ac.h.${sec.id}`))}</div></div>
          <div class="ac-seg" role="group" aria-label="${esc(`${role.name}: ${t(`ac.s.${sec.id}`)}`)}">
            ${sec.levels.map((l) => `<button type="button" class="ac-seg__btn ac-seg__btn--${l}" data-ac-set="${esc(role.id)}" data-ac-section="${esc(sec.id)}" data-ac-level="${l}" aria-pressed="${role.perms[sec.id] === l}">${LEVEL_ICON[l]} ${esc(t(`ac.l.${l}`))}</button>`).join('')}
          </div>
        </li>`).join('');
      return `
        <div class="ac-roles-phone">
          <p class="muted jr-small">👑 ${esc(t('role.admin'))} (${esc(t('ac.adminFromSheet'))}) — ${esc(t('ac.adminFixed'))}</p>
          <div class="chips ac-rolechips">${chips}</div>
          <div class="ac-phone-role">
            <label class="field"><span>${esc(t('ac.roleName'))}</span>
              <input class="search ac-rname" data-ac-rname="${esc(role.id)}" value="${esc(role.name)}" maxlength="40"></label>
            <p class="muted jr-small">${esc(t('ac.people', { n: role.staffCount }))}</p>
            <ul class="ac-phone-secs">${sections}</ul>
            ${role.staffCount ? '' : `<button type="button" class="btn btn--small ac-danger" data-ac-rdel="${esc(role.id)}">🗑 ${esc(t('ac.delete'))}</button>`}
          </div>
        </div>`;
    }

    /* ------------------------------------------------------------ История */

    function logLine(e) {
      const d = e.details || {};
      const who = d.staff || d.role || '';
      // Кого касается — в заголовке; роль — тоже, если менялась сама роль
      const skip = (k) => k === 'staff' || (k === 'role' && e.action.startsWith('role.'));
      const value = (k, v) => (k === 'active' ? t(v === 'on' ? 'ac.active' : 'ac.inactive') : v === true ? '✎' : v);
      const parts = Object.entries(d).filter(([k]) => !skip(k))
        .map(([k, v]) => (Array.isArray(v) ? v.map((x) => x.replace(/^(\w+):/, (m, s) => `${t(`ac.s.${s}`)}:`)).join('; ') : k === 'count' ? v : `${t(`ac.k.${k}`)}: ${value(k, v)}`))
        .filter(Boolean).join(' · ');
      return `<li><span class="muted">${esc(ctx.dateTime(e.at))} · ${esc(e.by === 'system' ? t('ac.system') : e.by)}</span>
        <div><b>${esc(t(`ac.a.${e.action}`))}</b>${who ? ` — ${esc(who)}` : ''}${parts ? `<div class="muted jr-small">${esc(parts)}</div>` : ''}</div></li>`;
    }

    function render() {
      if (st.failed) return `<div class="empty">${esc(st.failed)}</div>`;
      if (!st.data) return `<div class="empty">${esc(t('app.loading'))}</div>`;
      return `
        <div class="ac">
          ${st.note ? `<p class="md-status is-${st.note.kind} ac-note" role="status">${esc(st.note.text)}</p>` : ''}
          ${renderStaff()}
          ${renderRoles()}
          <section class="card ac-sec">
            <h3>${esc(t('ac.log.title'))}</h3>
            ${st.data.log.length ? `<ul class="ac-log">${st.data.log.map(logLine).join('')}</ul>` : `<p class="muted">${esc(t('ac.log.none'))}</p>`}
          </section>
        </div>`;
    }

    /* ------------------------------------------------------------ События */

    /** Список «Имя; Роль; Почта; WhatsApp» — добавить новых и обновить известных */
    async function bulkImport(text) {
      if (st.busy || !String(text || '').trim()) return;
      st.busy = true;
      st.bulkOpen = true;
      try {
        const r = await api('/access/import', { body: { text } });
        st.data = await api('/access');
        const errors = r.errors.map((e) => `${t('ac.bulk.line', { n: e.line })}: ${t(`ac.err.${e.error}`) === `ac.err.${e.error}` ? e.error : t(`ac.err.${e.error}`)}${e.text ? ` («${e.text}»)` : ''}`);
        flash(errors.length ? 'error' : 'ok', [t('ac.bulk.done', { added: r.added, updated: r.updated }), ...errors].join(' · '));
      } catch (err) {
        flash('error', ctx.errorText(err));
      } finally {
        st.busy = false;
      }
    }

    const staffById = (id) => st.data?.staff.find((s) => s.id === Number(id));

    function onClick(event) {
      const el = event.target;
      if (!el.closest('.ac')) return false;
      if (el.closest('[data-ac-add]')) { st.editing = 'new'; ctx.rerender(); return true; }
      if (el.closest('[data-ac-cancel]')) { st.editing = null; ctx.rerender(); return true; }
      const edit = el.closest('[data-ac-edit]');
      if (edit) { st.editing = Number(edit.dataset.acEdit); ctx.rerender(); return true; }
      const del = el.closest('[data-ac-del]');
      if (del) {
        const s = staffById(del.dataset.acDel);
        if (s && window.confirm(t('ac.confirmDelete', { name: s.name }))) call('/access/staff/delete', { id: s.id }, t('ac.deleted'));
        return true;
      }
      const pick = el.closest('[data-ac-pick]');
      if (pick) { st.pick = pick.dataset.acPick; ctx.rerender(); return true; }
      const set = el.closest('[data-ac-set]');
      if (set) {
        const role = st.data.roles.find((r) => r.id === set.dataset.acSet);
        if (role && role.perms[set.dataset.acSection] !== set.dataset.acLevel) {
          call('/access/role', { id: role.id, name: role.name, perms: { ...role.perms, [set.dataset.acSection]: set.dataset.acLevel } });
        }
        return true;
      }
      const rdel = el.closest('[data-ac-rdel]');
      if (rdel) {
        const name = roleName(rdel.dataset.acRdel);
        if (window.confirm(t('ac.confirmRoleDelete', { name }))) call('/access/role/delete', { id: rdel.dataset.acRdel }, t('ac.deleted'));
        return true;
      }
      return false;
    }

    function onChange(event) {
      const el = event.target;
      if (!el.closest('.ac')) return false;
      if (el.dataset.acRole) {
        const s = staffById(el.dataset.acRole);
        if (s) call('/access/staff', { ...s, roleId: el.value });
        return true;
      }
      if (el.dataset.acActive) {
        const s = staffById(el.dataset.acActive);
        if (s) call('/access/staff', { ...s, active: el.checked });
        return true;
      }
      if (el.dataset.acPerm) {
        const role = st.data.roles.find((r) => r.id === el.dataset.acPerm);
        if (role) call('/access/role', { id: role.id, name: role.name, perms: { ...role.perms, [el.dataset.acSection]: el.value } });
        return true;
      }
      if (el.dataset.acRname) {
        const role = st.data.roles.find((r) => r.id === el.dataset.acRname);
        const name = el.value.trim();
        if (role && name && name !== role.name) call('/access/role', { id: role.id, name, perms: role.perms });
        return true;
      }
      return false;
    }

    function onSubmit(event) {
      const form = event.target;
      if (!form.closest('.ac')) return false;
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (form.matches('[data-ac-newrole]')) {
        // Новая роль — с правами роли «Просмотр»: дальше админ настроит
        const base = st.data.roles.find((r) => r.id === 'viewer')?.perms || {};
        call('/access/role', { name: data.name, perms: base }, t('ac.roleAdded'));
        return true;
      }
      if (form.matches('[data-ac-bulk]')) {
        bulkImport(data.text);
        return true;
      }
      if (form.matches('[data-ac-staff]')) {
        const id = form.dataset.acStaff ? Number(form.dataset.acStaff) : undefined;
        const old = id ? staffById(id) : null;
        call('/access/staff', { ...data, id, sourceId: data.sourceId || null, active: old ? old.active : true }).then((ok) => {
          if (ok) { st.editing = null; ctx.rerender(); }
        });
        return true;
      }
      return false;
    }

    return { load, render, onClick, onChange, onSubmit };
  }

  window.STAFF_ACCESS = { create };
})();
