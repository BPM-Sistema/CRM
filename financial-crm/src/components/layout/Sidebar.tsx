import { NavLink, useLocation } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  LayoutDashboard,
  ShoppingCart,
  Receipt,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Users,
  Activity,
  Landmark,
  RefreshCw,
  Truck,
  ImageIcon,
  Settings,
  Monitor,
  UserCheck,
  Send,
  // Bot, // PAUSADO — Bot IA
  MoreHorizontal,
  X,
  ClipboardList,
  CreditCard,
  AlertTriangle,
  MapPin,
} from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
}

function NavItem({ to, icon, label, collapsed, onClick }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
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

// Mobile bottom tab item
function MobileTabItem({ to, icon, label, onClick }: { to: string; icon: React.ReactNode; label: string; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        clsx(
          'flex flex-col items-center justify-center gap-0.5 py-1.5 px-1 rounded-lg transition-colors min-w-0 flex-1',
          isActive
            ? 'text-neutral-900'
            : 'text-neutral-400'
        )
      }
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="text-[10px] font-medium leading-tight truncate">{label}</span>
    </NavLink>
  );
}

const navItems = [
  { to: '/', icon: <LayoutDashboard size={20} />, label: 'Panel', mobileIcon: <LayoutDashboard size={22} />, permissions: ['dashboard.view'] },
  { to: '/orders', icon: <ShoppingCart size={20} />, label: 'Pedidos', mobileIcon: <ShoppingCart size={22} />, permissions: ['orders.view', 'orders.print', 'orders.update_status', 'orders.create_cash_payment'] },
  { to: '/receipts', icon: <Receipt size={20} />, label: 'Comprobantes', mobileIcon: <Receipt size={22} />, permissions: ['receipts.view', 'receipts.confirm', 'receipts.reject', 'receipts.download', 'receipts.upload_manual'] },
  { to: '/remitos', icon: <Truck size={20} />, label: 'Remitos', mobileIcon: <Truck size={22} />, permissions: ['remitos.view', 'remitos.upload', 'remitos.confirm', 'remitos.reject'] },
  { to: '/transportes-ranking', icon: <MapPin size={20} />, label: 'Transportes', mobileIcon: <MapPin size={22} />, permissions: ['orders.view'] },
  { to: '/customers', icon: <UserCheck size={20} />, label: 'Clientes', mobileIcon: <UserCheck size={22} />, permissions: ['customers.view'] },
];

const localItems = [
  { to: '/local/reservas', icon: <ClipboardList size={20} />, label: 'Reservas', permissions: ['local.orders.view'] },
  { to: '/local/caja', icon: <CreditCard size={20} />, label: 'Caja', permissions: ['local.box.view'] },
  { to: '/local/alertas', icon: <AlertTriangle size={20} />, label: 'Alertas', permissions: ['local.alerts.view'] },
];

const adminItems = [
  { to: '/admin/users', icon: <Users size={20} />, label: 'Usuarios', permissions: ['users.view'] },
  { to: '/admin/financieras', icon: <Landmark size={20} />, label: 'Financieras', permissions: ['financieras.view'] },
  { to: '/admin/activity', icon: <Activity size={20} />, label: 'Actividad', permissions: ['activity.view'] },
  { to: '/admin/sync-queue', icon: <RefreshCw size={20} />, label: 'Sincronización', permissions: ['activity.view'] },
  { to: '/admin/whatsapp-actions', icon: <Send size={20} />, label: 'WhatsApp Envíos', permissions: ['whatsapp.send_bulk'] },
  { to: '/admin/image-sync', icon: <ImageIcon size={20} />, label: 'Sync Imagenes', permissions: ['activity.view'] },
  { to: '/admin/integrations', icon: <Settings size={20} />, label: 'Integraciones', permissions: ['integrations.view'] },
  { to: '/system-status', icon: <Monitor size={20} />, label: 'Estado Sistema', permissions: ['integrations.view'] },
  // Bot IA — PAUSADO, descomentar cuando se active
  // { to: '/admin/ai-bot', icon: <Bot size={20} />, label: 'Bot IA', permissions: ['ai_bot.view'] },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { logout, hasPermission } = useAuth();
  const location = useLocation();

  const hasAnyPermission = (permissions: string[]) => {
    if (permissions.length === 0) return true;
    return permissions.some(p => hasPermission(p));
  };

  const visibleNavItems = navItems.filter(item => hasAnyPermission(item.permissions));
  const visibleLocalItems = localItems.filter(item => hasAnyPermission(item.permissions));
  const visibleAdminItems = adminItems.filter(item => hasAnyPermission(item.permissions));

  // Mobile: show first 4 nav items + "More" button
  const mobileMainTabs = visibleNavItems.slice(0, 4);
  const mobileOverflowItems = [...visibleNavItems.slice(4), ...visibleLocalItems, ...visibleAdminItems];
  const isOverflowActive = mobileOverflowItems.some(item => location.pathname === item.to || location.pathname.startsWith(item.to + '/'));

  return (
    <>
      {/* Desktop Sidebar - hidden on mobile */}
      <aside
        className={clsx(
          'fixed left-0 top-0 h-full bg-white border-r border-neutral-200/60 z-30',
          'hidden md:flex flex-col transition-all duration-300',
          collapsed ? 'w-[72px]' : 'w-64'
        )}
      >
        <div className="flex items-center justify-center h-16 px-4 border-b border-neutral-100">
          <img
            src="/logo.webp"
            alt="Blanqueria"
            className={clsx('object-contain', collapsed ? 'h-8 w-8' : 'h-10')}
          />
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {visibleNavItems.map((item) => (
            <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} />
          ))}

          {visibleLocalItems.length > 0 && (
            <>
              <div className={clsx('pt-4 pb-2', collapsed ? 'px-2' : 'px-3')}>
                {!collapsed && (
                  <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                    Local
                  </span>
                )}
                {collapsed && <div className="h-px bg-neutral-200" />}
              </div>
              {visibleLocalItems.map((item) => (
                <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} collapsed={collapsed} />
              ))}
            </>
          )}

          {visibleAdminItems.length > 0 && (
            <>
              <div className={clsx('pt-4 pb-2', collapsed ? 'px-2' : 'px-3')}>
                {!collapsed && (
                  <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                    Administración
                  </span>
                )}
                {collapsed && <div className="h-px bg-neutral-200" />}
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

      {/* Mobile Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white border-t border-neutral-200 safe-area-bottom">
        <div className="flex items-stretch justify-around px-1 h-14">
          {mobileMainTabs.map((item) => (
            <MobileTabItem
              key={item.to}
              to={item.to}
              icon={item.mobileIcon}
              label={item.label}
            />
          ))}
          {/* More button */}
          <button
            onClick={() => setMobileMenuOpen(true)}
            className={clsx(
              'flex flex-col items-center justify-center gap-0.5 py-1.5 px-1 rounded-lg transition-colors min-w-0 flex-1',
              isOverflowActive ? 'text-neutral-900' : 'text-neutral-400'
            )}
          >
            <MoreHorizontal size={22} />
            <span className="text-[10px] font-medium leading-tight">Más</span>
          </button>
        </div>
      </nav>

      {/* Mobile "More" Menu - Full screen overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-[60] md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          {/* Menu panel - slides from bottom */}
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl max-h-[85vh] overflow-y-auto safe-area-bottom animate-slide-up">
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
              <h3 className="text-lg font-semibold text-neutral-900">Menú</h3>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 -mr-2 text-neutral-400 hover:text-neutral-600 rounded-full hover:bg-neutral-100"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 space-y-1">
              {/* Overflow nav items */}
              {visibleNavItems.slice(4).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileMenuOpen(false)}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-3 px-4 py-3.5 rounded-xl transition-colors',
                      isActive
                        ? 'bg-neutral-900 text-white'
                        : 'text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200'
                    )
                  }
                >
                  {item.icon}
                  <span className="font-medium">{item.label}</span>
                </NavLink>
              ))}

              {/* Local section */}
              {visibleLocalItems.length > 0 && (
                <>
                  <div className="pt-4 pb-2 px-4">
                    <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                      Local
                    </span>
                  </div>
                  {visibleLocalItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileMenuOpen(false)}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-3 px-4 py-3.5 rounded-xl transition-colors',
                          isActive
                            ? 'bg-neutral-900 text-white'
                            : 'text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200'
                        )
                      }
                    >
                      {item.icon}
                      <span className="font-medium">{item.label}</span>
                    </NavLink>
                  ))}
                </>
              )}

              {/* Admin section */}
              {visibleAdminItems.length > 0 && (
                <>
                  <div className="pt-4 pb-2 px-4">
                    <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                      Administración
                    </span>
                  </div>
                  {visibleAdminItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileMenuOpen(false)}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-3 px-4 py-3.5 rounded-xl transition-colors',
                          isActive
                            ? 'bg-neutral-900 text-white'
                            : 'text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200'
                        )
                      }
                    >
                      {item.icon}
                      <span className="font-medium">{item.label}</span>
                    </NavLink>
                  ))}
                </>
              )}

              {/* Logout */}
              <div className="pt-4 border-t border-neutral-100 mt-4">
                <button
                  onClick={() => { logout(); setMobileMenuOpen(false); }}
                  className="flex items-center gap-3 w-full px-4 py-3.5 rounded-xl text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors"
                >
                  <LogOut size={20} />
                  <span className="font-medium">Cerrar Sesión</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
