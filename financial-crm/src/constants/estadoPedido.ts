/**
 * Definiciones canónicas del modelo de estados de pedido (frontend).
 *
 * Punto único de verdad para:
 *   - Type OrderStatus.
 *   - Lista de estados.
 *   - Variantes visuales (color, ícono, label).
 *   - Botones de filtro.
 *
 * Espejo del backend en backend/lib/estados-pedido.js.
 *
 * Los 7 estados nuevos (en_preparacion / en_revision / pendiente_stock /
 * por_empaquetar / pendiente_datos_envio / pendiente_retiro / por_enviar) son
 * valores válidos desde Fase 1 PR 2, pero el flujo real todavía no los usa.
 */

export type OrderStatus =
  | 'pendiente_pago'
  | 'a_imprimir'
  | 'hoja_impresa'
  | 'en_preparacion'
  | 'en_revision'
  | 'pendiente_stock'
  | 'por_empaquetar'
  | 'empaquetado'
  | 'pendiente_datos_envio'
  | 'pendiente_retiro'
  | 'por_enviar'
  | 'en_calle'
  | 'enviado'
  | 'retirado'
  | 'cancelado';

export const ORDER_STATUSES: OrderStatus[] = [
  'pendiente_pago',
  'pendiente_datos_envio',
  'a_imprimir',
  'hoja_impresa',
  'en_preparacion',
  'en_revision',
  'pendiente_stock',
  'por_empaquetar',
  'empaquetado',
  'pendiente_retiro',
  'por_enviar',
  'en_calle',
  'enviado',
  'retirado',
  'cancelado',
];

// Variantes de color para Badge (debe coincidir con BadgeVariant de Badge.tsx).
export type OrderStatusVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange';

// Asignación intencional de variantes (Fase 1 PR 4): los estados intermedios
// del flujo del depo usan info/purple/cyan; los pendientes que esperan algo
// del cliente usan orange/amber; los de salida (verde) y los terminales.
// Reutilizamos las 8 variantes de Badge.tsx — los íconos diferencian más
// que los colores cuando varios estados comparten variante.
export const STATUS_VARIANTS: Record<OrderStatus, OrderStatusVariant> = {
  pendiente_pago:        'warning',
  a_imprimir:            'info',
  hoja_impresa:          'purple',
  en_preparacion:        'info',
  en_revision:           'purple',
  pendiente_stock:       'orange',
  por_empaquetar:        'cyan',
  empaquetado:           'cyan',
  pendiente_datos_envio: 'orange',
  pendiente_retiro:      'success',
  por_enviar:            'success',
  en_calle:              'warning',
  enviado:               'success',
  retirado:              'purple',
  cancelado:             'danger',
};

// Configuración de display: ícono (emoji) y label corto.
export const STATUS_CONFIG: Record<OrderStatus, { icon: string; label: string }> = {
  pendiente_pago:        { icon: '\u{1F4B3}', label: 'Pend. Pago' },
  a_imprimir:            { icon: '\u{1F5A8}', label: 'A Imprimir' },
  hoja_impresa:          { icon: '\u{1F4C4}', label: 'Hoja Impresa' },
  en_preparacion:        { icon: '\u{1F527}', label: 'En Preparación' },
  en_revision:           { icon: '\u{1F50D}', label: 'En Revisión' },
  pendiente_stock:       { icon: '\u{1F4E6}', label: 'Pend. Stock' },
  por_empaquetar:        { icon: '\u{1F4E6}', label: 'Por Empaquetar' },
  empaquetado:           { icon: '\u{1F4E6}', label: 'Empaquetado' },
  pendiente_datos_envio: { icon: '\u{1F4CB}', label: 'Pend. Datos Envío' },
  pendiente_retiro:      { icon: '\u{1F3EA}', label: 'Pend. Retiro' },
  por_enviar:            { icon: '\u{1F69A}', label: 'Por Enviar' },
  en_calle:              { icon: '\u{1F69A}', label: 'En Calle' },
  enviado:               { icon: '\u{1F4E8}', label: 'Enviado' },
  retirado:              { icon: '\u{1F3E0}', label: 'Retirado' },
  cancelado:             { icon: '\u{26D4}', label: 'Cancelado' },
};

// Configuración para los botones de filtro (clases de Tailwind + permiso).
// Cada estado tiene su propio permiso (simétrico 1↔1 con los botones de filtro).
export const STATUS_FILTER_CONFIG: Record<OrderStatus, { label: string; color: string; permission: string }> = {
  pendiente_pago:        { label: 'Pend. Pago',         color: 'bg-amber-50 text-amber-700',     permission: 'orders.view_pendiente_pago' },
  a_imprimir:            { label: 'A Imprimir',         color: 'bg-blue-50 text-blue-700',       permission: 'orders.view_a_imprimir' },
  hoja_impresa:          { label: 'Hoja Impr.',         color: 'bg-violet-50 text-violet-700',   permission: 'orders.view_hoja_impresa' },
  en_preparacion:        { label: 'En Preparación',     color: 'bg-blue-50 text-blue-700',       permission: 'orders.view_en_preparacion' },
  en_revision:           { label: 'En Revisión',        color: 'bg-violet-50 text-violet-700',   permission: 'orders.view_en_revision' },
  pendiente_stock:       { label: 'Pend. Stock',        color: 'bg-orange-50 text-orange-700',   permission: 'orders.view_pendiente_stock' },
  por_empaquetar:        { label: 'Por Empaquetar',     color: 'bg-cyan-50 text-cyan-700',       permission: 'orders.view_por_empaquetar' },
  empaquetado:           { label: 'Empaquetado',        color: 'bg-cyan-50 text-cyan-700',       permission: 'orders.view_empaquetado' },
  pendiente_datos_envio: { label: 'Pend. Datos Envío',  color: 'bg-orange-50 text-orange-700',   permission: 'orders.view_pendiente_datos_envio' },
  pendiente_retiro:      { label: 'Pend. Retiro',       color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_pendiente_retiro' },
  por_enviar:            { label: 'Por Enviar',         color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_por_enviar' },
  en_calle:              { label: 'En Calle',           color: 'bg-amber-50 text-amber-700',     permission: 'orders.view_en_calle' },
  enviado:               { label: 'Enviado',            color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_enviado' },
  retirado:              { label: 'Retirado',           color: 'bg-purple-50 text-purple-700',   permission: 'orders.view_retirado' },
  cancelado:             { label: 'Cancelado',          color: 'bg-red-50 text-red-700',         permission: 'orders.view_cancelado' },
};

// Acciones de log (espejo de ACCIONES_LOG del backend) — útil para mapear eventos del log a UI.
// `pedido_armado` se mantiene en eventConfig.ts para renderizar logs históricos.
export const STATUS_LOG_ACTIONS: Record<OrderStatus, string> = {
  pendiente_pago:        'estado_pendiente_pago',
  a_imprimir:            'estado_a_imprimir',
  hoja_impresa:          'hoja_impresa',
  en_preparacion:        'pedido_en_preparacion',
  en_revision:           'pedido_en_revision',
  pendiente_stock:       'pedido_pendiente_stock',
  por_empaquetar:        'pedido_por_empaquetar',
  empaquetado:           'pedido_empaquetado',
  pendiente_datos_envio: 'pedido_pendiente_datos_envio',
  pendiente_retiro:      'pedido_pendiente_retiro',
  por_enviar:            'pedido_por_enviar',
  en_calle:              'pedido_en_calle',
  enviado:               'pedido_enviado',
  retirado:              'pedido_retirado',
  cancelado:             'pedido_cancelado',
};
