/**
 * Definiciones canónicas del modelo de estados de pedido.
 *
 * Punto único de verdad para:
 *   - Lista de estados válidos (estado_pedido).
 *   - Orden jerárquico (para detectar retrocesos en sync TN→BPM).
 *   - Mapeo BPM → TiendaNube.
 *   - Acciones de log por transición.
 *   - Permisos RBAC por estado.
 *
 * Antes vivía duplicado en index.js, payment-helpers.js, divergence-detector.js
 * y tn-sync.js. Cambios en uno divergían silenciosamente.
 */

const ESTADOS = [
  'pendiente_pago',
  'a_imprimir',
  'hoja_impresa',
  'armado',
  'retirado',
  'en_calle',
  'enviado',
  'cancelado',
];

// Orden jerárquico para "no retroceder" en sync TN→BPM.
// Estados terminales (retirado/en_calle/enviado) comparten nivel 4 — son rama final.
// cancelado=99 evita que cualquier sync lo pise sin intención explícita.
const ESTADO_PEDIDO_ORDER = {
  pendiente_pago: 0,
  a_imprimir: 1,
  hoja_impresa: 2,
  armado: 3,
  retirado: 4,
  en_calle: 4,
  enviado: 4,
  cancelado: 99,
};

// Mapeo BPM → TiendaNube. Solo los estados que tienen equivalente directo.
// El resto (pendiente_pago, a_imprimir, hoja_impresa) son control interno y no se sincronizan.
const ESTADO_TN_MAP = {
  armado:    { tnStatus: 'packed',    configKey: 'tiendanube_sync_estado_armado',    label: 'empaquetada' },
  enviado:   { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',   label: 'despachada' },
  retirado:  { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',   label: 'despachada' },
  cancelado: { tnStatus: 'cancelled', configKey: 'tiendanube_sync_estado_cancelado', label: 'cancelada' },
};

// Acción de log que se inserta en `logs.accion` al entrar al estado vía PATCH /orders/:n/status.
// Si un estado no aparece, se loguea como `estado_<nombre>` (fallback genérico).
const ACCIONES_LOG = {
  hoja_impresa: 'hoja_impresa',
  armado: 'pedido_armado',
  retirado: 'pedido_retirado',
  en_calle: 'pedido_en_calle',
  enviado: 'pedido_enviado',
  cancelado: 'pedido_cancelado',
};

// Mapeo estado → permiso requerido para verlo en el listado.
// Hoy 1:1, en PR 4 se agrupa para los estados nuevos.
const ESTADO_PERMISOS = {
  pendiente_pago: 'orders.view_pendiente_pago',
  a_imprimir:     'orders.view_a_imprimir',
  hoja_impresa:   'orders.view_hoja_impresa',
  armado:         'orders.view_armado',
  retirado:       'orders.view_retirado',
  en_calle:       'orders.view_en_calle',
  enviado:        'orders.view_enviado',
  cancelado:      'orders.view_cancelado',
};

/**
 * Detecta si un pedido es de retiro (vs envío).
 * Mira shipping_type, empresa_envio (del shipping_request) y carrier ID.
 * Centraliza la lógica que estaba duplicada en index.js:2883 y payment-helpers.js:179.
 */
function esRetiro({ shipping_type, empresa_envio, shipping_carrier } = {}) {
  if (shipping_carrier === 'pickup-point') return true;
  const candidates = [shipping_type, empresa_envio].filter(Boolean);
  return candidates.some(s => /pickup|retiro|deposito|depósito/i.test(s));
}

function isEstadoValido(s) {
  return ESTADOS.includes(s);
}

function accionParaEstado(estado) {
  return ACCIONES_LOG[estado] || `estado_${estado}`;
}

module.exports = {
  ESTADOS,
  ESTADO_PEDIDO_ORDER,
  ESTADO_TN_MAP,
  ACCIONES_LOG,
  ESTADO_PERMISOS,
  esRetiro,
  isEstadoValido,
  accionParaEstado,
};
