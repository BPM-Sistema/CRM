/**
 * Payment Helper Functions
 *
 * Funciones de calculo de pagos y estado de pedidos.
 * Extraidas de index.js para uso compartido.
 */

const pool = require('../db');
const { calcularEstadoCuenta } = require('../utils/calcularEstadoCuenta');
const { normalizePhone } = require('../utils/phoneNormalize');
const { ESTADO_PEDIDO_ORDER } = require('./estados-pedido');
const { motivoBloqueoImpresion } = require('./shipping-requirements');

/* =====================================================
   UTIL — CALCULAR TOTAL PAGADO
   Suma comprobantes confirmados + pagos en efectivo
===================================================== */
async function calcularTotalPagado(orderNumber) {
  // Sumar comprobantes confirmados
  const compRes = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total
     FROM comprobantes
     WHERE order_number = $1 AND estado = 'confirmado'`,
    [orderNumber]
  );

  // Sumar pagos en efectivo
  const efectivoRes = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total
     FROM pagos_efectivo
     WHERE order_number = $1`,
    [orderNumber]
  );

  return Number(compRes.rows[0].total) + Number(efectivoRes.rows[0].total);
}

/* =====================================================
   UTIL — CALCULAR ESTADO PEDIDO (centralizado)

   Modelo de bloqueos pre-imprimir: hay dos estados que pueden bloquear un
   pedido antes de a_imprimir, según qué le falta:
   - pendiente_pago         → falta confirmar el pago
   - pendiente_datos_envio  → pago OK, falta el formulario de envío (Vía Cargo
                              y similares)

   Regla de transicion a a_imprimir (segun tipo de envio):
   - Retiro (pickup/retiro/deposito): estado_pago in (confirmado_parcial,
     confirmado_total, a_favor). No requiere datos extra.
   - Via Cargo / Expreso a eleccion: estado_pago in (confirmado_total, a_favor)
     AND shipping_request cargado. Si falta el pago → pendiente_pago. Si está
     el pago pero falta el form → pendiente_datos_envio.
   - Resto (Envio Nube, etc.): estado_pago in (confirmado_total, a_favor).

   Sin el contexto { shippingType, hasShippingRequest } la funcion es conservadora:
   NO mueve el estado. Asi obligamos a los callers nuevos a pasar el contexto.

   Regla de retroceso (independiente del envio):
   - si estado_pago queda en ('pendiente','anulado'), a_imprimir y
     pendiente_datos_envio retroceden a pendiente_pago. Razon: significa que
     ni siquiera se imprimio el pedido, no hay trabajo fisico que respetar.
   - estados posteriores (hoja_impresa, empaquetado, retirado, en_calle,
     enviado) NO retroceden porque ya hubo trabajo fisico.
===================================================== */
// Mantenido por compatibilidad con codigo que importa la constante.
// La logica de habilitacion ahora vive dentro de calcularEstadoPedido y depende del tipo de envio.
const ESTADOS_PAGO_HABILITAN_IMPRIMIR = ['confirmado_total', 'confirmado_parcial', 'a_favor', 'a_confirmar'];
const ESTADOS_PAGO_BLOQUEAN_IMPRIMIR = ['pendiente', 'anulado'];

// Estados pre-imprimir que se recalculan según pago + contexto de envío.
// Cualquier estado fuera de esta lista es "avanzado" y no se mueve.
const ESTADOS_RECALCULABLES = ['pendiente_pago', 'pendiente_datos_envio', 'a_imprimir'];

function calcularEstadoPedido(estadoPago, estadoPedidoActual, ctx = {}) {
  // 1. Retroceso si el pago se anula y el pedido todavía no se imprimió.
  //    Aplica tanto a a_imprimir como a pendiente_datos_envio (ambos están
  //    "antes" del trabajo físico).
  if ((estadoPedidoActual === 'a_imprimir' || estadoPedidoActual === 'pendiente_datos_envio')
      && ESTADOS_PAGO_BLOQUEAN_IMPRIMIR.includes(estadoPago)) {
    return 'pendiente_pago';
  }

  // 2. Estados avanzados (hoja_impresa+) no se recalculan.
  if (!ESTADOS_RECALCULABLES.includes(estadoPedidoActual)) {
    return estadoPedidoActual;
  }

  // 3. Re-evaluación según pago + tipo de envío + datos cargados.
  const { shippingType, hasShippingRequest } = ctx;
  if (shippingType === undefined) {
    // Caller no pasó contexto: ser conservador y no mover.
    return estadoPedidoActual;
  }

  return resolveEstadoInicial(estadoPago, shippingType, hasShippingRequest === true);
}

// Mapea (estadoPago, tipoEnvio, hasShippingRequest) → estado inicial canónico:
// pendiente_pago | pendiente_datos_envio | a_imprimir.
// Las reglas por método de envío viven en lib/shipping-requirements.js.
function resolveEstadoInicial(estadoPago, shippingType, hasShippingRequest) {
  const motivo = motivoBloqueoImpresion(estadoPago, shippingType, hasShippingRequest);
  if (motivo === 'pago')  return 'pendiente_pago';
  if (motivo === 'datos') return 'pendiente_datos_envio';
  return 'a_imprimir';
}

/* =====================================================
   UTIL — REQUIERE FORMULARIO DE ENVIO
   Detecta si un pedido requiere completar el formulario /envio
   Casos: "Expreso a eleccion" o "Via Cargo"
===================================================== */
function requiresShippingForm(shippingType) {
  if (!shippingType) return false;
  const lower = shippingType.toLowerCase();
  return (
    (lower.includes('expreso') && lower.includes('elec')) ||
    lower.includes('via cargo') ||
    lower.includes('viacargo')
  );
}

/* =====================================================
   UTIL — ES ENVIO POR RETIRO
   Detecta si el envio es retiro en deposito / pickup point.
   Misma logica que ya esta duplicada en index.js (print-data) y mapShippingToEstadoPedido.
===================================================== */
function isPickupShipping(shippingType) {
  if (!shippingType) return false;
  return /pickup|retiro|deposito|depósito/i.test(shippingType);
}

/* =====================================================
   UTIL — TRANSPORTES PROHIBIDOS
   Bloqueamos Andreani, OCA y Correo Argentino en el form /envio:
   están con demoras y costos altos. Replica la validación del
   frontend (ShippingForm.tsx) — no confiar solo en el cliente.
===================================================== */
// Lista exhaustiva de carriers prohibidos. NO usar "correo" solo: hay transportes
// legitimos que empiezan con esa palabra. Bloqueamos solo nombres especificos
// (oficiales + plurales + typos comunes).
const FORBIDDEN_CARRIERS = [
  // === Correo Argentino ===
  'correo argentino', 'correos argentinos',
  'correo arg', 'correos arg', 'correoarg',
  'correoargentino', 'correosargentinos',
  // typos en "correo"
  'corrreo argentino', 'corrrreo argentino', 'coreo argentino', 'corre argentino',
  'corero argentino', 'corero arg',
  // typos en "argentino"
  'correo argetino', 'correos argetinos',
  'correo argntino', 'correos argntinos',
  'correo argentno', 'correos argentnos',
  'correo argentnio', 'correos argentnios',
  'correo argentinno',
  'correo arjentino', 'correos arjentinos',
  'correo agentino', 'correos agentinos',
  'correo argentina', 'correos argentinas',

  // === Andreani ===
  'andreani', 'andreani sa', 'andreani s.a.', 'andreni', 'andreny',
  'andriani', 'andereani', 'andreanis', 'andreans', 'andrean',
  'adreani', 'andeani',

  // === OCA ===
  'oca', 'oca sa', 'oca s.a.', 'oca express', 'o c a', 'o.c.a',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FORBIDDEN_CARRIER_PATTERNS = FORBIDDEN_CARRIERS.map(
  s => new RegExp(`\\b${escapeRegex(s)}\\b`)
);

function isForbiddenCarrier(value) {
  if (!value) return false;
  const normalized = String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.\-_/]/g, ' ')      // separadores → espacio
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return FORBIDDEN_CARRIER_PATTERNS.some(pattern => pattern.test(normalized));
}

/* =====================================================
   UTIL — NORMALIZAR TELEFONO PARA COMPARACION
   Re-export de utils/phoneNormalize para conveniencia
===================================================== */
function normalizePhoneForComparison(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

/* =====================================================
   UTIL — MAPEAR SHIPPING DE TN → ESTADO_PEDIDO
   Solo avanza hacia adelante, nunca retrocede.
   Retorna null si no corresponde cambiar.

   Datos reales de TN API (verificado 2026-03-26):
   - shipping_status: unpacked | shipped | delivered (los estados reales)
   - shipping: carrier ID (api_3988894, table, draft, pickup-point) — NO es el estado
   - fulfillments[].status: UNPACKED | DISPATCHED | DELIVERED
   - shipping_option.name: nombre legible del envío

   Prioridad: shipping_status > fulfillments > shipping (carrier)
===================================================== */
/**
 * @param {string} shippingStatus - pedido.shipping_status (unpacked/shipped/delivered)
 * @param {string} shippingCarrier - pedido.shipping (api_3988894/table/draft/pickup-point)
 * @param {string} shippingType - shipping_type de DB (nombre legible del envío)
 * @param {string} estadoPedidoActual - estado_pedido actual en DB
 * @param {object} [opts] - opciones
 * @param {string} [opts.fulfillmentStatus] - fulfillments[0].status (UNPACKED/DISPATCHED/DELIVERED)
 */
function mapShippingToEstadoPedido(shippingStatus, shippingCarrier, shippingType, estadoPedidoActual, opts = {}) {
  if (estadoPedidoActual === 'cancelado') return null;

  const isPickup = (shippingType && /pickup|retiro|deposito|depósito/i.test(shippingType))
    || shippingCarrier === 'pickup-point';

  const fulfillStatus = opts.fulfillmentStatus?.toUpperCase();
  let nuevoEstado = null;

  // 1. Prioridad: shipping_status (campo real de la API)
  if (shippingStatus) {
    switch (shippingStatus) {
      case 'delivered':
        nuevoEstado = isPickup ? 'retirado' : 'enviado';
        break;
      case 'shipped':
        nuevoEstado = isPickup ? 'retirado' : 'enviado';
        break;
      case 'packed':
      case 'unshipped':
        // unshipped en TN = preparado/empaquetado pero no despachado
        nuevoEstado = 'empaquetado';
        break;
      case 'unpacked':
        // Estado por defecto de TN para pedidos no empaquetados — NO-OP
        // No debe cambiar estado_pedido (evita revertir hoja_impresa/armado/enviado)
        break;
    }
  }

  // 2. Fallback: fulfillment status
  if (!nuevoEstado && fulfillStatus) {
    switch (fulfillStatus) {
      case 'DELIVERED':
        nuevoEstado = isPickup ? 'retirado' : 'enviado';
        break;
      case 'DISPATCHED':
        nuevoEstado = isPickup ? 'retirado' : 'enviado';
        break;
      // UNPACKED = no avanzar
    }
  }

  // 3. Carrier-based: pickup-point como carrier siempre implica retiro
  if (!nuevoEstado && shippingCarrier === 'pickup-point') {
    nuevoEstado = 'retirado';
  }

  if (!nuevoEstado) return null;

  // Solo avanzar, nunca retroceder
  const ordenActual = ESTADO_PEDIDO_ORDER[estadoPedidoActual] ?? 0;
  const ordenNuevo = ESTADO_PEDIDO_ORDER[nuevoEstado] ?? 0;
  if (ordenNuevo <= ordenActual) return null;

  return nuevoEstado;
}

module.exports = {
  calcularTotalPagado,
  calcularEstadoPedido,
  ESTADOS_PAGO_HABILITAN_IMPRIMIR,
  ESTADOS_PAGO_BLOQUEAN_IMPRIMIR,
  requiresShippingForm,
  isPickupShipping,
  isForbiddenCarrier,
  normalizePhoneForComparison,
  normalizePhone,
  calcularEstadoCuenta,
  mapShippingToEstadoPedido,
};
