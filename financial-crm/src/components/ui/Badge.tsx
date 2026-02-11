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
  default: 'bg-neutral-100 text-neutral-700',
  success: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-1 ring-amber-600/20',
  danger: 'bg-red-50 text-red-700 ring-1 ring-red-600/20',
  info: 'bg-blue-50 text-blue-700 ring-1 ring-blue-600/20',
  purple: 'bg-violet-50 text-violet-700 ring-1 ring-violet-600/20',
  cyan: 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-600/20',
  orange: 'bg-orange-50 text-orange-700 ring-1 ring-orange-600/20',
};

const sizes: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
};

export function Badge({ children, variant = 'default', size = 'md', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md font-medium whitespace-nowrap',
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
// Pendiente → A confirmar → Parcial → Total → Rechazado
const paymentStatusVariants: Record<PaymentStatus, BadgeVariant> = {
  pendiente: 'warning',
  a_confirmar: 'info',
  parcial: 'purple',
  total: 'success',
  rechazado: 'danger',
};

const paymentStatusLabels: Record<PaymentStatus, string> = {
  pendiente: 'Pendiente',
  a_confirmar: 'A confirmar',
  parcial: 'Parcial',
  total: 'Total',
  rechazado: 'Rechazado',
};

// Etiquetas cortas para tamaño pequeño
const paymentStatusLabelsShort: Record<PaymentStatus, string> = {
  pendiente: 'Pend.',
  a_confirmar: 'A conf.',
  parcial: 'Parcial',
  total: 'Total',
  rechazado: 'Rech.',
};

interface PaymentStatusBadgeProps {
  status: PaymentStatus;
  size?: BadgeSize;
  className?: string;
}

export function PaymentStatusBadge({ status, size = 'md', className }: PaymentStatusBadgeProps) {
  const label = size === 'sm' ? paymentStatusLabelsShort[status] : paymentStatusLabels[status];
  return (
    <Badge variant={paymentStatusVariants[status]} size={size} className={className}>
      {label}
    </Badge>
  );
}

// ============ ESTADO DEL PEDIDO ============
const orderStatusVariants: Record<OrderStatus, BadgeVariant> = {
  pendiente_pago: 'warning',
  a_imprimir: 'info',
  hoja_impresa: 'purple',
  armado: 'cyan',
  retirado: 'success',
  enviado: 'success',
  en_calle: 'orange',
};

const orderStatusLabels: Record<OrderStatus, string> = {
  pendiente_pago: 'Pendiente de pago',
  a_imprimir: 'A imprimir',
  hoja_impresa: 'Hoja impresa',
  armado: 'Armado',
  retirado: 'Retirado',
  enviado: 'Enviado',
  en_calle: 'En calle',
};

// Etiquetas cortas para tamaño pequeño
const orderStatusLabelsShort: Record<OrderStatus, string> = {
  pendiente_pago: 'Pend. pago',
  a_imprimir: 'A impr.',
  hoja_impresa: 'Hoja impr.',
  armado: 'Armado',
  retirado: 'Retirado',
  enviado: 'Enviado',
  en_calle: 'En calle',
};

interface OrderStatusBadgeProps {
  status: OrderStatus;
  size?: BadgeSize;
  className?: string;
}

export function OrderStatusBadge({ status, size = 'md', className }: OrderStatusBadgeProps) {
  const label = size === 'sm' ? orderStatusLabelsShort[status] : orderStatusLabels[status];
  return (
    <Badge variant={orderStatusVariants[status]} size={size} className={className}>
      {label}
    </Badge>
  );
}

// Mantener StatusBadge como alias para PaymentStatusBadge por compatibilidad
export const StatusBadge = PaymentStatusBadge;
