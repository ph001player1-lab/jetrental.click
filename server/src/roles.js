/**
 * ============================================================================
 * Роли сотрудников (колонка «Роль» листа Users)
 * ============================================================================
 *                                   Admin   Editor   Viewer
 *   Обзор, Парк, Календарь, Заявки   ✓       ✓        ✓  (смотреть)
 *   Сайт: фото и описания            ✓       ✓        только смотреть
 *   Вкладка «Сервер»                 ✓       —        —
 *   Настройки (лимит трафика)        ✓       —        —
 * Пустая или незнакомая роль = Viewer: лишних прав по ошибке не будет.
 * ============================================================================
 */

export const ROLES = ['admin', 'editor', 'viewer'];

const PERMISSIONS = {
  admin: ['site.edit', 'server.view', 'settings'],
  editor: ['site.edit'],
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
