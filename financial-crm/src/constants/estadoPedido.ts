/**
 * Definiciones canónicas del modelo de estados de pedido (frontend).
 *
 * Punto único de verdad para:
 *   - Type OrderStatus (antes en types/index.ts).
 *   - Lista de estados.
 *   - Variantes visuales (color, ícono, label).
 *   - Botones de filtro.
 *
 * Espejo del backend en backend/lib/estados-pedido.js.
 */

export type OrderStatus =
  | 'pendiente_pago'
  | 'a_imprimir'
  | 'hoja_impresa'
  | 'armado'
  | 'retirado'
  | 'en_calle'
  | 'enviado'
  | 'cancelado';

export const ORDER_STATUSES: OrderStatus[] = [
  'pendiente_pago',
  'a_imprimir',
  'hoja_impresa',
  'armado',
  'retirado',
  'en_calle',
  'enviado',
  'cancelado',
];

// Variantes de color para Badge (debe coincidir con BadgeVariant de Badge.tsx).
export type OrderStatusVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange';

export const STATUS_VARIANTS: Record<OrderStatus, OrderStatusVariant> = {
  pendiente_pago: 'warning',
  a_imprimir:     'info',
  hoja_impresa:   'purple',
  armado:         'cyan',
  retirado:       'purple',
  en_calle:       'warning',
  enviado:        'success',
  cancelado:      'danger',
};

// Configuración de display: ícono (emoji) y label corto.
export const STATUS_CONFIG: Record<OrderStatus, { icon: string; label: string }> = {
  pendiente_pago: { icon: '\u{1F4B3}', label: 'Pend. Pago' },
  a_imprimir:     { icon: '\u{1F5A8}', label: 'A Imprimir' },
  hoja_impresa:   { icon: '\u{1F4C4}', label: 'Hoja Impresa' },
  armado:         { icon: '\u{1F4E6}', label: 'Armado' },
  retirado:       { icon: '\u{1F3E0}', label: 'Retirado' },
  en_calle:       { icon: '\u{1F69A}', label: 'En Calle' },
  enviado:        { icon: '\u{1F4E8}', label: 'Enviado' },
  cancelado:      { icon: '\u{26D4}', label: 'Cancelado' },
};

// Configuración para los botones de filtro (clases de Tailwind + permiso).
export const STATUS_FILTER_CONFIG: Record<OrderStatus, { label: string; color: string; permission: string }> = {
  pendiente_pago: { label: 'Pend. Pago',   color: 'bg-amber-50 text-amber-700',     permission: 'orders.view_pendiente_pago' },
  a_imprimir:     { label: 'A Imprimir',   color: 'bg-blue-50 text-blue-700',       permission: 'orders.view_a_imprimir' },
  hoja_impresa:   { label: 'Hoja Impr.',   color: 'bg-violet-50 text-violet-700',   permission: 'orders.view_hoja_impresa' },
  armado:         { label: 'Armado',       color: 'bg-cyan-50 text-cyan-700',       permission: 'orders.view_armado' },
  retirado:       { label: 'Retirado',     color: 'bg-purple-50 text-purple-700',   permission: 'orders.view_retirado' },
  en_calle:       { label: 'En Calle',     color: 'bg-orange-50 text-orange-700',   permission: 'orders.view_en_calle' },
  enviado:        { label: 'Enviado',      color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_enviado' },
  cancelado:      { label: 'Cancelado',    color: 'bg-red-50 text-red-700',         permission: 'orders.view_cancelado' },
};

// Acciones de log (espejo de ACCIONES_LOG del backend) — útil para mapear eventos del log a UI.
export const STATUS_LOG_ACTIONS: Record<OrderStatus, string> = {
  pendiente_pago: 'estado_pendiente_pago',
  a_imprimir:     'estado_a_imprimir',
  hoja_impresa:   'hoja_impresa',
  armado:         'pedido_armado',
  retirado:       'pedido_retirado',
  en_calle:       'pedido_en_calle',
  enviado:        'pedido_enviado',
  cancelado:      'pedido_cancelado',
};
