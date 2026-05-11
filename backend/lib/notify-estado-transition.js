/**
 * Disparadores de WhatsApp por transición de estado del pedido (Fase 2 PR 1).
 *
 * Mira el estado destino + estado de pago y, si corresponde, encola un WhatsApp
 * vía enviarWhatsAppPlantilla. Esa función ya chequea el toggle whatsapp_tpl_<key>
 * del catálogo plantilla_tipos, aplica la convención de testing, normaliza el
 * teléfono y dedup.
 *
 * Llamar desde TODO lugar donde se setea `estado_pedido`:
 *   - PATCH /orders/:n/status (manual + trigger A.2)
 *   - recalcularPagos.js (trigger A.1)
 *
 * Plantillas (definidas en plantilla_tipos, migration 094):
 *   aviso_empaquetado_pendiente_pago → template Botmaker pendiente_3hs (reutilizado)
 *   aviso_pendiente_datos_envio      → template Botmaker datos__envio  (reutilizado)
 *   aviso_pendiente_retiro           → template Botmaker retiros_local (reutilizado)
 *
 * Cuando se creen templates custom en Botmaker, basta editar plantilla_default
 * desde el panel — el helper no necesita cambios.
 */

const pool = require('../db');
const { enviarWhatsAppPlantilla } = require('./whatsapp-helpers');

function resolvePlantilla(toEstado, estadoPago) {
  if (toEstado === 'empaquetado' &&
      estadoPago !== 'confirmado_total' && estadoPago !== 'a_favor') {
    return 'aviso_empaquetado_pendiente_pago';
  }
  if (toEstado === 'pendiente_datos_envio') return 'aviso_pendiente_datos_envio';
  if (toEstado === 'pendiente_retiro')      return 'aviso_pendiente_retiro';
  return null;
}

async function notifyEstadoTransition({ orderNumber, fromEstado, toEstado, estadoPago }) {
  if (!toEstado || fromEstado === toEstado) return;

  const plantilla = resolvePlantilla(toEstado, estadoPago);
  if (!plantilla) return;

  // Re-leer el pedido del pool global. Doble propósito:
  //   1. Tener customer_name/customer_phone con datos frescos.
  //   2. Confirmar que `toEstado` realmente quedó persistido (si el caller
  //      hizo rollback de la transacción, el estado actual no coincidirá
  //      con `toEstado` y abortamos sin mandar el WhatsApp).
  let order;
  try {
    const r = await pool.query(
      `SELECT customer_name, customer_phone, estado_pedido
       FROM orders_validated WHERE order_number = $1`,
      [orderNumber]
    );
    if (r.rowCount === 0) return;
    order = r.rows[0];
  } catch (err) {
    console.error(`❌ [notify-estado-transition] Error leyendo pedido #${orderNumber}: ${err.message}`);
    return;
  }

  if (order.estado_pedido !== toEstado) {
    console.log(`⏭️ [notify-estado-transition] #${orderNumber} estado actual=${order.estado_pedido} ≠ esperado=${toEstado} → skip (posible rollback)`);
    return;
  }

  if (!order.customer_phone) {
    console.log(`⚠️ [notify-estado-transition] #${orderNumber} sin customer_phone → skip ${plantilla}`);
    return;
  }

  try {
    // enviarWhatsAppPlantilla chequea: catálogo + toggle whatsapp_tpl_<key> +
    // testing config + normalización de teléfono + encola con dedup.
    await enviarWhatsAppPlantilla({
      telefono: order.customer_phone,
      plantilla,
      variables: {
        '1': order.customer_name || 'Cliente',
        '2': String(orderNumber),
      },
      orderNumber: parseInt(orderNumber, 10),
    });
  } catch (err) {
    console.error(`❌ [notify-estado-transition] Error encolando ${plantilla} #${orderNumber}: ${err.message}`);
  }
}

module.exports = { notifyEstadoTransition };
