import { getStoredUser } from '../services/api';

// Definición de items de navegación con sus permisos (misma estructura que Sidebar)
const navItems = [
  {
    to: '/',
    permissions: ['dashboard.view']
  },
  {
    to: '/orders',
    permissions: ['orders.view', 'orders.print', 'orders.update_status', 'orders.create_cash_payment']
  },
  {
    to: '/receipts',
    permissions: ['receipts.view', 'receipts.confirm', 'receipts.reject', 'receipts.download', 'receipts.upload_manual']
  },
];

const adminItems = [
  { to: '/admin/roles', permissions: ['users.view'] },
  { to: '/admin/users', permissions: ['users.view'] },
];

/**
 * Determina la primera ruta disponible según los permisos del usuario
 * @returns La ruta a la que debe redirigirse el usuario
 */
export function getDefaultRoute(): string {
  const user = getStoredUser();

  if (!user) {
    return '/login';
  }

  const hasAnyPermission = (permissions: string[]) => {
    if (permissions.length === 0) return true;
    return permissions.some(p => user.permissions.includes(p));
  };

  // Buscar la primera ruta disponible en navItems
  for (const item of navItems) {
    if (hasAnyPermission(item.permissions)) {
      return item.to;
    }
  }

  // Si no hay ninguna en navItems, buscar en adminItems
  for (const item of adminItems) {
    if (hasAnyPermission(item.permissions)) {
      return item.to;
    }
  }

  // Si no tiene acceso a nada, ir al dashboard
  return '/';
}
