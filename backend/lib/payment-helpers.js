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
   UTIL — MAPEAR SHIPPING STATUS DE TN → ESTADO_PEDIDO
   Solo avanza hacia adelante, nunca retrocede.
   Retorna null si no corresponde cambiar.
===================================================== */
const ESTADO_PEDIDO_ORDER = {
  'pendiente_pago': 0, 'a_imprimir': 1, 'hoja_impresa': 2,
  'armado': 3, 'retirado': 4, 'en_calle': 4, 'enviado': 4, 'cancelado': 99,
};

function mapShippingToEstadoPedido(tnShippingStatus, shippingType, estadoPedidoActual) {
  if (!tnShippingStatus || estadoPedidoActual === 'cancelado') return null;

  const isPickup = shippingType && /pickup|retiro|deposito|depósito/i.test(shippingType);

  let nuevoEstado = null;
  switch (tnShippingStatus) {
    case 'packed':
      nuevoEstado = 'armado';
      break;
    case 'fulfilled':
      nuevoEstado = isPickup ? 'retirado' : 'enviado';
      break;
    case 'shipped':
      nuevoEstado = 'en_calle';
      break;
    case 'delivered':
      nuevoEstado = 'enviado';
      break;
    case 'pickup-point':
      nuevoEstado = 'retirado';
      break;
    default:
      // TN usa IDs de carrier como shipping status (ej: api_3988894 = Envío Nube)
      // y 'table' para transportes manuales. Ambos significan "enviado".
      if (/^api_\d+$/.test(tnShippingStatus) || tnShippingStatus === 'table') {
        nuevoEstado = 'enviado';
        break;
      }
      return null;
  }

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
