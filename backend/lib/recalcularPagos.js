/**
 * Función centralizada para recalcular total_pagado, saldo y estado_pago.
 *
 * REGLA DE NEGOCIO:
 *   total_pagado = pago_online_tn + SUM(comprobantes confirmados) + SUM(pagos_efectivo)
 *   saldo = GREATEST(0, monto_tiendanube - total_pagado)
 *   estado_pago = derivado del saldo
 *
 * Esto garantiza que pagos online (TN/MercadoPago) y pagos locales
 * (comprobantes + efectivo) se sumen sin pisarse.
 *
 * @param {object} clientOrPool - pg Client (dentro de transacción) o Pool
 * @param {string} orderNumber - Número de pedido
 * @param {object} [opts] - Opciones
 * @param {number} [opts.tolerancia=1000] - Tolerancia en centavos para confirmado_total
 * @returns {object} { totalPagado, pagoOnlineTn, pagosLocales, saldo, estadoPago, estadoPedido }
 */

const { calcularEstadoPedido } = require('./payment-helpers');

async function recalcularPagos(clientOrPool, orderNumber, opts = {}) {
  const tolerancia = opts.tolerancia ?? 1000;

  const r = await clientOrPool.query(`
    SELECT
      ov.monto_tiendanube,
      ov.pago_online_tn,
      ov.estado_pedido,
      ov.estado_pago,
      COALESCE(c.total, 0) as comp_total,
      COALESCE(e.total, 0) as ef_total
    FROM orders_validated ov
    LEFT JOIN (
      SELECT order_number, SUM(monto) as total
      FROM comprobantes WHERE estado = 'confirmado'
      GROUP BY order_number
    ) c ON ov.order_number = c.order_number
    LEFT JOIN (
      SELECT order_number, SUM(monto) as total
      FROM pagos_efectivo
      GROUP BY order_number
    ) e ON ov.order_number = e.order_number
    WHERE ov.order_number = $1
  `, [orderNumber]);

  if (r.rowCount === 0) {
    throw new Error(`Pedido ${orderNumber} no encontrado`);
  }

  const row = r.rows[0];
  const monto = Number(row.monto_tiendanube);
  const pagoOnlineTn = Number(row.pago_online_tn) || 0;
  const compTotal = Number(row.comp_total);
  const efTotal = Number(row.ef_total);
  const pagosLocales = compTotal + efTotal;
  const totalPagado = pagoOnlineTn + pagosLocales;
  const saldo = Math.max(0, monto - totalPagado);
  const estadoPedidoActual = row.estado_pedido;
  const estadoPagoActual = row.estado_pago;

  // No tocar estados especiales
  let estadoPago;
  if (estadoPagoActual === 'reembolsado' || estadoPagoActual === 'anulado') {
    estadoPago = estadoPagoActual;
  } else if (Math.abs(monto - totalPagado) <= tolerancia && totalPagado > 0) {
    estadoPago = 'confirmado_total';
  } else if (saldo <= 0 && totalPagado > 0) {
    estadoPago = 'confirmado_total';
  } else if (totalPagado > 0) {
    estadoPago = 'confirmado_parcial';
  } else {
    estadoPago = 'pendiente';
  }

  const estadoPedido = calcularEstadoPedido(estadoPago, estadoPedidoActual);

  await clientOrPool.query(`
    UPDATE orders_validated
    SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
    WHERE order_number = $5
  `, [totalPagado, saldo, estadoPago, estadoPedido, orderNumber]);

  return {
    totalPagado,
    pagoOnlineTn,
    pagosLocales,
    saldo,
    estadoPago,
    estadoPedido,
    monto
  };
}

module.exports = { recalcularPagos };
