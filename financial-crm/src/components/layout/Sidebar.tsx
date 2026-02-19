import { NavLink } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  LayoutDashboard,
  ShoppingCart,
  Receipt,
  BarChart3,
  Settings,
  Building2,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Users,
  Activity,
  Landmark,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
}

function NavItem({ to, icon, label, collapsed }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150',
          'hover:bg-neutral-100',
          isActive
            ? 'bg-neutral-900 text-white hover:bg-neutral-800'
            : 'text-neutral-600',
          collapsed && 'justify-center px-2'
        )
      }
    >
      <span className="flex-shrink-0">{icon}</span>
      {!collapsed && <span className="font-medium text-sm">{label}</span>}
    </NavLink>
  );
}

// Cada item tiene permisos requeridos (si tiene alguno de ellos, se muestra)
const navItems = [
  {
    to: '/',
    icon: <LayoutDashboard size={20} />,
    label: 'Panel',
    permissions: ['dashboard.view']
  },
  {
    to: '/orders',
    icon: <ShoppingCart size={20} />,
    label: 'Pedidos',
    permissions: ['orders.view', 'orders.print', 'orders.update_status', 'orders.create_cash_payment']
  },
  {
    to: '/receipts',
    icon: <Receipt size={20} />,
    label: 'Comprobantes',
    permissions: ['receipts.view', 'receipts.confirm', 'receipts.reject', 'receipts.download', 'receipts.upload_manual']
  },
  {
    to: '/analytics',
    icon: <BarChart3 size={20} />,
    label: 'Estadísticas',
    permissions: ['dashboard.view'] // Requiere ver dashboard para ver estadísticas
  },
  {
    to: '/settings',
    icon: <Settings size={20} />,
    label: 'Configuración',
    permissions: [] // Siempre visible
  },
];

const adminItems = [
  { to: '/admin/users', icon: <Users size={20} />, label: 'Usuarios', permissions: ['users.view'] },
  { to: '/admin/financieras', icon: <Landmark size={20} />, label: 'Financieras', permissions: ['financieras.view'] },
  { to: '/admin/activity', icon: <Activity size={20} />, label: 'Actividad', permissions: ['activity.view'] },
  { to: '/admin/sync-queue', icon: <RefreshCw size={20} />, label: 'Sincronización', permissions: ['activity.view'] },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const { logout, hasPermission } = useAuth();

  // Filtrar items según permisos (si permissions está vacío, siempre se muestra)
  const hasAnyPermission = (permissions: string[]) => {
    if (permissions.length === 0) return true;
    return permissions.some(p => hasPermission(p));
  };

  const visibleNavItems = navItems.filter(item => hasAnyPermission(item.permissions));
  const visibleAdminItems = adminItems.filter(item => hasAnyPermission(item.permissions));

  return (
    <aside
      className={clsx(
        'fixed left-0 top-0 h-full bg-white border-r border-neutral-200/60 z-30',
        'flex flex-col transition-all duration-300',
        collapsed ? 'w-[72px]' : 'w-64'
      )}
    >
      <div
        className={clsx(
          'flex items-center h-16 px-4 border-b border-neutral-100',
          collapsed ? 'justify-center' : 'gap-3'
        )}
      >
        <div className="flex items-center justify-center w-9 h-9 bg-neutral-900 rounded-xl">
          <Building2 size={20} className="text-white" />
        </div>
        {!collapsed && (
          <div className="flex flex-col">
            <span className="font-semibold text-neutral-900 text-sm">FinOps</span>
            <span className="text-xs text-neutral-500">Control de Pagos</span>
          </div>
        )}
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {visibleNavItems.map((item) => (
          <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} />
        ))}

        {visibleAdminItems.length > 0 && (
          <>
            <div className={clsx(
              'pt-4 pb-2',
              collapsed ? 'px-2' : 'px-3'
            )}>
              {!collapsed && (
                <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                  Administración
                </span>
              )}
              {collapsed && (
                <div className="h-px bg-neutral-200" />
              )}
            </div>
            {visibleAdminItems.map((item) => (
              <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} />
            ))}
          </>
        )}
      </nav>

      <div className="p-3 border-t border-neutral-100">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'flex items-center gap-2 w-full px-3 py-2 rounded-lg',
            'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100',
            'transition-colors duration-150',
            collapsed && 'justify-center'
          )}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          {!collapsed && <span className="text-sm">Colapsar</span>}
        </button>
      </div>

      <div className="p-3 border-t border-neutral-100">
        <button
          onClick={logout}
          className={clsx(
            'flex items-center gap-2 w-full px-3 py-2 rounded-lg',
            'text-red-500 hover:text-red-700 hover:bg-red-50',
            'transition-colors duration-150',
            collapsed && 'justify-center'
          )}
        >
          <LogOut size={18} />
          {!collapsed && <span className="text-sm">Cerrar Sesión</span>}
        </button>
      </div>
    </aside>
  );
}
