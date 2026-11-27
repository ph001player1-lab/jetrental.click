/**
 * ============================================================================
 * Права сотрудника на сайте сотрудников
 * ============================================================================
 * Админ — из Google-таблицы (лист Users, роль Admin): у него все права и
 * вкладка «Доступы». Остальным роль назначает админ в портале (access.js):
 * у роли по каждому разделу уровень «меняет / смотрит / нет», из него —
 * список прав вида «journal.view», «site.edit». Роль читается при каждом
 * запросе, поэтому изменения действуют сразу.
 * ============================================================================
 */

import { ADMIN_ROLE, DEFAULT_ROLE, adminPermissions, getRole, permissionsFromLevels } from './access.js';

/** Код роли сотрудника: 'admin' или код роли из портала */
export function roleOf(staff) {
  const role = String(staff?.role || '').trim().toLowerCase();
  if (role === ADMIN_ROLE) return ADMIN_ROLE;
  return getRole(staff?.role) ? staff.role : DEFAULT_ROLE;
}

/** Название роли для портала («Админ» — переводит портал) */
export function roleNameOf(staff) {
  const role = roleOf(staff);
  return role === ADMIN_ROLE ? null : getRole(role)?.name || null;
}

/** Список прав сотрудника */
export function permissionsOf(staff) {
  const role = roleOf(staff);
  // «Игра» (режим наблюдателя) — владелец и админ
  if (role === ADMIN_ROLE) return [...adminPermissions(), 'game.view'];
  const found = getRole(role);
  const list = found ? permissionsFromLevels(found.perms) : [];
  return role === 'owner' ? [...list, 'game.view'] : list;
}

/** Есть ли у сотрудника право perm */
export const can = (staff, perm) => permissionsOf(staff).includes(perm);

/** Есть ли хотя бы одно из прав */
export const canAny = (staff, perms) => {
  const list = permissionsOf(staff);
  return perms.some((p) => list.includes(p));
};
