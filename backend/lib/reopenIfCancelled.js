/**
 * Reabre un pedido cancelado si entra una accion que implique que sigue vivo:
 *   - Webhook order/updated de TN con status != cancelled
 *   - Operador confirma un comprobante
 *   - Conciliacion bancaria confirma un comprobante
 *   - Caja registra un pago en efectivo
 *
 * El UPDATE inicial es solo placeholder; quien llama debe correr `recalcularPagos`
 * a continuacion para que `estado_pago` y `estado_pedido` se deriven de los pagos
 * reales.
 *
 * Reglas:
 *   1) `estado_pago` en ('anulado','reembolsado') -> 'pendiente' (placeholder).
 *   2) `estado_pedido`:
 *      - si `printed_at IS NOT NULL` -> 'hoja_impresa' (no retroceder a a_imprimir
 *        un pedido fisicamente impreso antes de cancelar).
 *      - else -> 'pendiente_pago' (placeholder; recalcularPagos lo sube a
 *        a_imprimir si los pagos lo habilitan).
 *
 * Limitacion conocida: si la cancelacion habia puesto `pago_online_tn=0`
 * (refunded/voided), ese monto no se restaura aca — depende del siguiente
 * order/updated de TN.
 *
 * @param {object} client - pg Client (dentro de transaccion) o Pool
 * @param {string} orderNumber
 * @param {string} origen - 'webhook_tiendanube' | 'comprobante_confirmado' |
 *                          'conciliacion_banco' | 'pago_efectivo' | etc.
 * @returns {Promise<{ reopened: boolean, previousState?: { estado_pedido, estado_pago } }>}
 */
async function reopenIfCancelled(client, orderNumber, origen) {
  const r = await client.query(
    `SELECT estado_pedido, estado_pago FROM orders_validated WHERE order_number = $1 FOR UPDATE`,
    [orderNumber]
  );

  if (r.rowCount === 0) {
    return { reopened: false };
  }

  const { estado_pedido, estado_pago } = r.rows[0];
  if (estado_pedido !== 'cancelado') {
    return { reopened: false };
  }

  await client.query(
    `UPDATE orders_validated
     SET estado_pago = CASE
           WHEN estado_pago IN ('anulado','reembolsado') THEN 'pendiente'
           ELSE estado_pago
         END,
         estado_pedido = CASE
           WHEN printed_at IS NOT NULL THEN 'hoja_impresa'
           ELSE 'pendiente_pago'
         END,
         updated_at = NOW()
     WHERE order_number = $1`,
    [orderNumber]
  );

  return {
    reopened: true,
    origen,
    previousState: { estado_pedido, estado_pago },
  };
}

module.exports = { reopenIfCancelled };
