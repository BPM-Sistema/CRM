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
const { pushOrderToImprimir } = require('./sheets-helpers');
const { derivarEstadoDesdeEmpaquetado, accionParaEstado } = require('./estados-pedido');
const { logEvento } = require('../utils/logging');
const { notifyEstadoTransition } = require('./notify-estado-transition');
const { pagoAlcanzaParaDespachar } = require('./shipping-requirements');

async function recalcularPagos(clientOrPool, orderNumber, opts = {}) {
  const tolerancia = opts.tolerancia ?? 1000;

  const r = await clientOrPool.query(`
    SELECT
      ov.monto_tiendanube,
      ov.pago_online_tn,
      ov.estado_pedido,
      ov.estado_pago,
      ov.shipping_type,
      EXISTS (SELECT 1 FROM shipping_requests WHERE order_number = ov.order_number) AS has_shipping_request,
      COALESCE(c.total, 0) as comp_total,
      COALESCE(e.total, 0) as ef_total,
      COALESCE(cp.pending_count, 0) as comp_pending_count
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
    LEFT JOIN (
      SELECT order_number, COUNT(*) as pending_count
      FROM comprobantes WHERE estado IN ('pendiente', 'a_confirmar')
      GROUP BY order_number
    ) cp ON ov.order_number = cp.order_number
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
  const compPendingCount = Number(row.comp_pending_count);
  const pagosLocales = compTotal + efTotal;
  const totalPagado = pagoOnlineTn + pagosLocales;
  const saldo = Math.max(0, monto - totalPagado);
  const estadoPedidoActual = row.estado_pedido;
  const estadoPagoActual = row.estado_pago;

  // No tocar estados especiales SOLO si el pedido sigue efectivamente cancelado.
  // Si el pedido fue reabierto (estado_pedido != 'cancelado'), el 'anulado'/'reembolsado'
  // es residuo de una cancelación previa y debe recomputarse según comprobantes/efectivo.
  let estadoPago;
  if ((estadoPagoActual === 'reembolsado' || estadoPagoActual === 'anulado') &&
      estadoPedidoActual === 'cancelado') {
    estadoPago = estadoPagoActual;
  } else if (Math.abs(monto - totalPagado) <= tolerancia && totalPagado > 0) {
    estadoPago = 'confirmado_total';
  } else if (saldo <= 0 && totalPagado > 0) {
    estadoPago = 'confirmado_total';
  } else if (totalPagado > 0) {
    estadoPago = 'confirmado_parcial';
  } else if (compPendingCount > 0) {
    // Hay comprobante(s) pendientes de verificacion pero ninguno confirmado:
    // preservar a_confirmar (no retroceder a pendiente).
    estadoPago = 'a_confirmar';
  } else {
    estadoPago = 'pendiente';
  }

  const estadoPedido = calcularEstadoPedido(estadoPago, estadoPedidoActual, {
    shippingType: row.shipping_type,
    hasShippingRequest: row.has_shipping_request === true,
  });

  await clientOrPool.query(`
    UPDATE orders_validated
    SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
    WHERE order_number = $5
  `, [totalPagado, saldo, estadoPago, estadoPedido, orderNumber]);

  // Transición a "a_imprimir" → tracking en Google Sheets (fire-and-forget,
  // nunca rompe el flujo aunque la API de Sheets falle).
  if (estadoPedidoActual !== 'a_imprimir' && estadoPedido === 'a_imprimir') {
    setImmediate(() => { pushOrderToImprimir(orderNumber); });
  }

  // Trigger A: si el pedido quedó en `empaquetado` y el pago alcanza para
  // despachar según el método, avanza solo a `pendiente_retiro` / `por_enviar`.
  // Retiro acepta pago parcial; envío exige pago total. Reglas en
  // lib/shipping-requirements.js.
  let estadoFinal = estadoPedido;
  if (estadoPedido === 'empaquetado' && pagoAlcanzaParaDespachar(estadoPago, row.shipping_type)) {
    const ctx = await clientOrPool.query(`
      SELECT
        ov.shipping_type,
        EXISTS (SELECT 1 FROM shipping_requests WHERE order_number = ov.order_number) AS has_shipping_request,
        (SELECT empresa_envio FROM shipping_requests
          WHERE order_number = ov.order_number
          ORDER BY created_at DESC LIMIT 1) AS empresa_envio
      FROM orders_validated ov
      WHERE ov.order_number = $1
    `, [orderNumber]);
    const o = ctx.rows[0] || {};
    const derivado = derivarEstadoDesdeEmpaquetado({
      shipping_type: o.shipping_type,
      empresa_envio: o.empresa_envio,
      has_shipping_request: o.has_shipping_request,
    });
    if (derivado !== 'empaquetado') {
      await clientOrPool.query(
        `UPDATE orders_validated SET estado_pedido = $1 WHERE order_number = $2`,
        [derivado, orderNumber]
      );
      estadoFinal = derivado;
      // Log fire-and-forget. Origen 'trigger_auto_pago' permite distinguir
      // estos cambios de los manuales en auditorías.
      setImmediate(() => {
        logEvento({
          orderNumber,
          accion: accionParaEstado(derivado),
          origen: 'trigger_auto_pago',
        });
      });
    }
  }

  // WhatsApps de Fase 2 PR 1: disparar si la transición lo amerita.
  // setImmediate + el helper usa pool global (no clientOrPool) y re-verifica
  // el estado actual del pedido. Si el caller hace rollback de la transacción,
  // el estado en DB no coincidirá con estadoFinal y el helper hace skip.
  if (estadoFinal !== estadoPedidoActual) {
    setImmediate(() => {
      notifyEstadoTransition({
        orderNumber,
        fromEstado: estadoPedidoActual,
        toEstado: estadoFinal,
        estadoPago,
      }).catch(() => { /* loggeado adentro */ });
    });
  }

  return {
    totalPagado,
    pagoOnlineTn,
    pagosLocales,
    saldo,
    estadoPago,
    estadoPedido: estadoFinal,
    monto
  };
}

module.exports = { recalcularPagos };
