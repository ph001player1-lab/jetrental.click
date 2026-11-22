/**
 * ============================================================================
 * Роли сотрудников (колонка «Роль» листа Users)
 * ============================================================================
 *                                   Admin   Editor   Viewer
 *   Обзор, Парк, Календарь, Заявки   ✓       ✓        ✓  (смотреть)
 *   Сайт: фото и описания            ✓       ✓        только смотреть
 *   Журнал: операции, сверка         ✓       ✓        ✓
 *   Журнал: фото и контакты клиентов ✓       ✓        —
 *   Журнал: исправить разбор         ✓       ✓        —
 *   Журнал: табель, WhatsApp, история ✓      —        —
 *   Вкладка «Сервер»                 ✓       —        —
 *   Настройки (лимит трафика)        ✓       —        —
 * Пустая или незнакомая роль = Viewer: лишних прав по ошибке не будет.
 * ============================================================================
 */

export const ROLES = ['admin', 'editor', 'viewer'];

const PERMISSIONS = {
  // journal.private — фото и контакты клиентов в журнале; journal.edit — исправлять разбор;
  // journal.admin — загрузка истории из выгрузки и подключение наблюдателя WhatsApp;
  // journal.timesheet — табель (кто когда начал и закончил смену)
  admin: ['site.edit', 'server.view', 'settings', 'journal.private', 'journal.edit', 'journal.admin', 'journal.timesheet'],
  editor: ['site.edit', 'journal.private', 'journal.edit'],
  viewer: []
};

/** 'Admin' / 'editor ' / '' → 'admin' | 'editor' | 'viewer' */
export function roleOf(staff) {
  const role = String(staff?.role || '').trim().toLowerCase();
  return ROLES.includes(role) ? role : 'viewer';
}

/** Список прав роли сотрудника */
export const permissionsOf = (staff) => PERMISSIONS[roleOf(staff)];

/** Есть ли у сотрудника право perm */
export const can = (staff, perm) => permissionsOf(staff).includes(perm);
