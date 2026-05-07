import { PaymentStatus, OrderStatus } from '../../types';
import { clsx } from 'clsx';
import { useAuth } from '../../contexts/AuthContext';
import { ORDER_STATUSES, STATUS_FILTER_CONFIG } from '../../constants/estadoPedido';

interface OrderFiltersProps {
  paymentFilter: PaymentStatus | 'all';
  onPaymentFilterChange: (value: PaymentStatus | 'all') => void;
  orderStatusFilter: OrderStatus | 'all';
  onOrderStatusFilterChange: (value: OrderStatus | 'all') => void;
}

const paymentButtons: { value: PaymentStatus | 'all'; label: string; color: string; permission?: string }[] = [
  { value: 'all', label: 'Todos', color: 'bg-neutral-100 text-neutral-700' },
  { value: 'pendiente', label: 'Pendiente', color: 'bg-amber-50 text-amber-700', permission: 'orders.view_pendiente' },
  { value: 'a_confirmar', label: 'A confirmar', color: 'bg-blue-50 text-blue-700', permission: 'orders.view_a_confirmar' },
  { value: 'parcial', label: 'Parcial', color: 'bg-violet-50 text-violet-700', permission: 'orders.view_parcial' },
  { value: 'total', label: 'Total', color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_total' },
  { value: 'rechazado', label: 'Rechazado', color: 'bg-red-50 text-red-700', permission: 'orders.view_rechazado' },
];

const orderStatusButtons: { value: OrderStatus | 'all'; label: string; color: string; permission?: string }[] = [
  { value: 'all', label: 'Todos', color: 'bg-neutral-100 text-neutral-700' },
  ...ORDER_STATUSES.map(estado => ({
    value: estado,
    label: STATUS_FILTER_CONFIG[estado].label,
    color: STATUS_FILTER_CONFIG[estado].color,
    permission: STATUS_FILTER_CONFIG[estado].permission,
  })),
];

export function OrderFilters({
  paymentFilter,
  onPaymentFilterChange,
  orderStatusFilter,
  onOrderStatusFilterChange,
}: OrderFiltersProps) {
  const { hasPermission, user } = useAuth();

  // Debug: mostrar permisos del usuario
  console.log('[OrderFilters] User permissions:', user?.permissions);

  // Filtrar botones según permisos del usuario
  const visiblePaymentButtons = paymentButtons.filter(btn => {
    if (btn.value === 'all') return true;
    const hasPerm = hasPermission(btn.permission!);
    console.log(`[OrderFilters] ${btn.permission}: ${hasPerm}`);
    return hasPerm;
  });

  const visibleOrderStatusButtons = orderStatusButtons.filter(btn => {
    if (btn.value === 'all') return true;
    const hasPerm = hasPermission(btn.permission!);
    console.log(`[OrderFilters] ${btn.permission}: ${hasPerm}`);
    return hasPerm;
  });

  // Ocultar sección si solo queda el botón "Todos"
  const showPaymentFilters = visiblePaymentButtons.length > 1;
  const showOrderStatusFilters = visibleOrderStatusButtons.length > 1;

  if (!showPaymentFilters && !showOrderStatusFilters) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Filtros de estado de pago */}
      {showPaymentFilters && (
        <div>
          <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Estado de Pago</span>
          <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
            {visiblePaymentButtons.map((btn) => (
              <button
                key={btn.value}
                onClick={() => onPaymentFilterChange(btn.value)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  paymentFilter === btn.value
                    ? clsx(btn.color, 'ring-2 ring-neutral-900/10')
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filtros de estado del pedido */}
      {showOrderStatusFilters && (
        <div>
          <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Estado del Pedido</span>
          <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
            {visibleOrderStatusButtons.map((btn) => (
              <button
                key={btn.value}
                onClick={() => onOrderStatusFilterChange(btn.value)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  orderStatusFilter === btn.value
                    ? clsx(btn.color, 'ring-2 ring-neutral-900/10')
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
