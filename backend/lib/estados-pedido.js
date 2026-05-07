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
 * Los 7 estados nuevos (en_preparacion / en_revision / pendiente_stock /
 * por_empaquetar / pendiente_datos_envio / pendiente_retiro / por_enviar) son
 * valores válidos del enum desde Fase 1 PR 2, pero el flujo real de la oficina
 * todavía no los usa: se activan en Fase 2 con el QR del depo.
 */

const ESTADOS = [
  // Inicial (sin comprobante).
  'pendiente_pago',

  // Listo para imprimir / impreso.
  'a_imprimir',
  'hoja_impresa',

  // Flujo del depo (Fase 2 los usa, en Fase 1 existen pero no se transitan).
  'en_preparacion',
  'en_revision',
  'pendiente_stock',
  'por_empaquetar',

  // Empaquetado (ex 'armado').
  'empaquetado',

  // Esperando algo del cliente o del transportista.
  'pendiente_datos_envio',
  'pendiente_retiro',
  'por_enviar',

  // Terminales.
  'en_calle',
  'enviado',
  'retirado',
  'cancelado',
];

// Orden jerárquico para "no retroceder" en sync TN→BPM.
// Estados terminales (en_calle/enviado/retirado) comparten nivel 4 — son rama final.
// Los estados nuevos comparten niveles según etapa lógica:
//   3.0–3.9: depo (preparación, stock, revisión, listo para empaquetar)
//   4.0:     empaquetado
//   4.5–4.9: esperando algo del cliente o del transportista
//   5+:      en calle / enviado / retirado
// cancelado=99 evita que cualquier sync lo pise sin intención explícita.
const ESTADO_PEDIDO_ORDER = {
  pendiente_pago:        0,
  a_imprimir:            1,
  hoja_impresa:          2,
  en_preparacion:        3.0,
  pendiente_stock:       3.2,
  en_revision:           3.5,
  por_empaquetar:        3.8,
  empaquetado:           4.0,
  pendiente_datos_envio: 4.5,
  pendiente_retiro:      4.7,
  por_enviar:            4.7,
  en_calle:              5.0,
  enviado:               5.5,
  retirado:              5.5,
  cancelado:             99,
};

// Mapeo BPM → TiendaNube. Solo los estados que tienen equivalente directo.
// El resto (pendiente_pago, a_imprimir, hoja_impresa, todos los nuevos del depo)
// son control interno y NO se sincronizan.
const ESTADO_TN_MAP = {
  empaquetado: { tnStatus: 'packed',    configKey: 'tiendanube_sync_estado_empaquetado', label: 'empaquetada' },
  enviado:     { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',     label: 'despachada' },
  retirado:    { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',     label: 'despachada' },
  cancelado:   { tnStatus: 'cancelled', configKey: 'tiendanube_sync_estado_cancelado',   label: 'cancelada' },
};

// Acción de log que se inserta en `logs.accion` al entrar al estado vía PATCH /orders/:n/status.
// Si un estado no aparece, se loguea como `estado_<nombre>` (fallback genérico).
// Mantenemos `pedido_armado` como fallback en eventConfig (frontend) para que los
// logs históricos (escritos antes del rename) sigan renderizándose bien.
const ACCIONES_LOG = {
  hoja_impresa:          'hoja_impresa',
  en_preparacion:        'pedido_en_preparacion',
  en_revision:           'pedido_en_revision',
  pendiente_stock:       'pedido_pendiente_stock',
  por_empaquetar:        'pedido_por_empaquetar',
  empaquetado:           'pedido_empaquetado',
  pendiente_datos_envio: 'pedido_pendiente_datos_envio',
  pendiente_retiro:      'pedido_pendiente_retiro',
  por_enviar:            'pedido_por_enviar',
  retirado:              'pedido_retirado',
  en_calle:              'pedido_en_calle',
  enviado:               'pedido_enviado',
  cancelado:             'pedido_cancelado',
};

// Mapeo estado → permiso RBAC requerido para verlo en el listado.
// Fase 1 PR 4 (revisión): cada estado tiene su propio permiso, simétrico 1↔1
// con los botones de filtro. Los 4 permisos agrupados que metimos en la primera
// versión de PR 4 (preparacion, listos_para_salir, finalizados) se eliminaron
// en migration 089 — los roles afectados recibieron los individuales antes de
// borrar. Lo mismo con orders.view_armado (legacy del rename de PR 2).
const ESTADO_PERMISOS = {
  pendiente_pago:        'orders.view_pendiente_pago',
  a_imprimir:            'orders.view_a_imprimir',
  hoja_impresa:          'orders.view_hoja_impresa',
  en_preparacion:        'orders.view_en_preparacion',
  en_revision:           'orders.view_en_revision',
  pendiente_stock:       'orders.view_pendiente_stock',
  por_empaquetar:        'orders.view_por_empaquetar',
  empaquetado:           'orders.view_empaquetado',
  pendiente_datos_envio: 'orders.view_pendiente_datos_envio',
  pendiente_retiro:      'orders.view_pendiente_retiro',
  por_enviar:            'orders.view_por_enviar',
  en_calle:              'orders.view_en_calle',
  enviado:               'orders.view_enviado',
  retirado:              'orders.view_retirado',
  cancelado:             'orders.view_cancelado',
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

/**
 * Detecta si el shipping_type requiere que el cliente complete un formulario
 * de envío (Vía Cargo / Expreso a Elección). Se duplica de payment-helpers.js
 * porque ahí está acoplado al modelo de carriers prohibidos; acá solo nos
 * importa si el pedido necesita datos extra del cliente.
 */
function requiresShippingForm(shipping_type) {
  if (!shipping_type) return false;
  const lower = shipping_type.toLowerCase();
  return (
    (lower.includes('expreso') && lower.includes('elec')) ||
    lower.includes('via cargo') ||
    lower.includes('viacargo')
  );
}

/**
 * Dado un pedido en `empaquetado` con pago confirmado, deriva el siguiente
 * estado según método de envío y disponibilidad de datos.
 *
 * - Retiro                         → 'pendiente_retiro'
 * - Envío + datos cargados         → 'por_enviar'
 * - Envío + sin datos              → 'pendiente_datos_envio'
 *
 * Si no se debería derivar (caso impossible), devuelve 'empaquetado' (no-op).
 */
function derivarEstadoDesdeEmpaquetado({ shipping_type, empresa_envio, shipping_carrier, has_shipping_request } = {}) {
  if (esRetiro({ shipping_type, empresa_envio, shipping_carrier })) {
    return 'pendiente_retiro';
  }
  // Es envío.
  if (requiresShippingForm(shipping_type) && !has_shipping_request) {
    return 'pendiente_datos_envio';
  }
  return 'por_enviar';
}

/**
 * Dado un pedido en `pendiente_datos_envio` al que se le acaban de cargar
 * los datos, decide a dónde mover según el estado de pago.
 *
 * - Pago confirmado total / a_favor → 'por_enviar'
 * - Pago pendiente / parcial / etc  → 'empaquetado'
 */
function derivarEstadoTrasCargarDatos(estado_pago) {
  if (estado_pago === 'confirmado_total' || estado_pago === 'a_favor') {
    return 'por_enviar';
  }
  return 'empaquetado';
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
  requiresShippingForm,
  derivarEstadoDesdeEmpaquetado,
  derivarEstadoTrasCargarDatos,
  isEstadoValido,
  accionParaEstado,
};
