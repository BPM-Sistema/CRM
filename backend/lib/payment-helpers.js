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

module.exports = {
  calcularTotalPagado,
  calcularEstadoPedido,
  requiresShippingForm,
  normalizePhoneForComparison,
  normalizePhone,
  calcularEstadoCuenta,
};
