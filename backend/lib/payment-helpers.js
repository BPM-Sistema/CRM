/**
 * Payment Helper Functions
 *
 * Funciones de calculo de pagos y estado de pedidos.
 * Extraidas de index.js para uso compartido.
 */

const pool = require('../db');
const { calcularEstadoCuenta } = require('../utils/calcularEstadoCuenta');
const { normalizePhone } = require('../utils/phoneNormalize');

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
   Regla: si hay plata pagada -> puede avanzar en flujo logistico
   Independiente del metodo de pago (transferencia, efectivo, etc.)
===================================================== */
function calcularEstadoPedido(estadoPago, estadoPedidoActual) {
  // Si ya avanzo mas alla de pendiente_pago, no retroceder
  if (estadoPedidoActual !== 'pendiente_pago') {
    return estadoPedidoActual;
  }

  // Estados de pago que indican que hay plata pagada -> avanzar a a_imprimir
  const estadosPagados = ['confirmado_total', 'confirmado_parcial', 'a_favor'];

  if (estadosPagados.includes(estadoPago)) {
    return 'a_imprimir';
  }

  // Si no hay pago confirmado, mantener pendiente_pago
  return 'pendiente_pago';
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
const ESTADO_PEDIDO_ORDER = {
  'pendiente_pago': 0, 'a_imprimir': 1, 'hoja_impresa': 2,
  'armado': 3, 'retirado': 4, 'en_calle': 4, 'enviado': 4, 'cancelado': 99,
};

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
        nuevoEstado = 'armado';
        break;
      case 'unpacked':
        // No avanzar — todavía sin preparar
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
  requiresShippingForm,
  normalizePhoneForComparison,
  normalizePhone,
  calcularEstadoCuenta,
  mapShippingToEstadoPedido,
};
