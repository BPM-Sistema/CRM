import { clsx } from 'clsx';
import { PaymentStatus, OrderStatus } from '../../types';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange';
type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  className?: string;
}

const variants: Record<BadgeVariant, string> = {
  default: 'bg-white text-neutral-700 ring-1 ring-neutral-300',
  success: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  info: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  purple: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  cyan: 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200',
  orange: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200',
};

const sizes: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-[11px]',
  md: 'px-2.5 py-1 text-xs',
};

export function Badge({ children, variant = 'default', size = 'md', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full font-medium whitespace-nowrap',
        variants[variant],
        sizes[size],
        className
      )}
    >
      {children}
    </span>
  );
}

// ============ ESTADO DE PAGO ============
const paymentStatusVariants: Record<PaymentStatus, BadgeVariant> = {
  pendiente: 'warning',
  a_confirmar: 'info',
  parcial: 'purple',
  total: 'success',
  rechazado: 'danger',
};

const paymentStatusConfig: Record<PaymentStatus, { icon: string; label: string }> = {
  pendiente: { icon: '$', label: 'Pendiente' },
  a_confirmar: { icon: '', label: 'A confirmar' },
  parcial: { icon: '$', label: 'Parcial' },
  total: { icon: '$', label: 'Recibido' },
  rechazado: { icon: '$', label: 'Rechazado' },
};

interface PaymentStatusBadgeProps {
  status: PaymentStatus;
  size?: BadgeSize;
  className?: string;
}

export function PaymentStatusBadge({ status, size = 'md', className }: PaymentStatusBadgeProps) {
  const config = paymentStatusConfig[status];
  return (
    <Badge variant={paymentStatusVariants[status]} size={size} className={className}>
      {config.icon && <span className="mr-0.5 font-bold">{config.icon}</span>}
      {config.label}
    </Badge>
  );
}

// ============ ESTADO DEL PEDIDO ============
const orderStatusVariants: Record<OrderStatus, BadgeVariant> = {
  pendiente_pago: 'default',
  a_imprimir: 'default',
  hoja_impresa: 'default',
  armado: 'cyan',
  retirado: 'default',
  en_calle: 'warning',
  enviado: 'success',
  cancelado: 'danger',
};

const orderStatusConfig: Record<OrderStatus, { icon: string; label: string }> = {
  pendiente_pago: { icon: '\u{1F4E6}', label: 'Por empaquetar' },
  a_imprimir: { icon: '\u{1F4E6}', label: 'Por empaquetar' },
  hoja_impresa: { icon: '\u{1F4E6}', label: 'Por empaquetar' },
  armado: { icon: '\u{1F4E6}', label: 'Empaquetado' },
  retirado: { icon: '\u{1F3E0}', label: 'Retirada' },
  en_calle: { icon: '\u{1F69A}', label: 'En camino' },
  enviado: { icon: '\u{1F4E8}', label: 'Enviada' },
  cancelado: { icon: '\u{26D4}', label: 'Cancelada' },
};

interface OrderStatusBadgeProps {
  status: OrderStatus;
  size?: BadgeSize;
  className?: string;
}

export function OrderStatusBadge({ status, size = 'md', className }: OrderStatusBadgeProps) {
  const config = orderStatusConfig[status];
  return (
    <Badge variant={orderStatusVariants[status]} size={size} className={className}>
      <span className="mr-1 text-[10px]">{config.icon}</span>
      {config.label}
    </Badge>
  );
}

// Mantener StatusBadge como alias para PaymentStatusBadge por compatibilidad
export const StatusBadge = PaymentStatusBadge;
