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
 *
 * Caso especial pendiente_datos_envio (2026-05-13): NO se manda inmediato.
 * Al pagar el comprobante el cliente ya recibe un msj con instrucciones para
 * cargar datos del envío. Recién si pasan 24hs hábiles y no los cargó, ahí
 * se dispara el reminder via scheduled_whatsapp. Ver scheduleDatosEnvioReminder.
 */

const pool = require('../db');
const { enviarWhatsAppPlantilla } = require('./whatsapp-helpers');
const { nextBusinessSendAtAR } = require('../utils/businessHours');

function resolvePlantilla(toEstado, estadoPago) {
  if (toEstado === 'empaquetado' &&
      estadoPago !== 'confirmado_total' && estadoPago !== 'a_favor') {
    return 'aviso_empaquetado_pendiente_pago';
  }
  // pendiente_datos_envio: NO mandar inmediato; se programa a +24hs (ver abajo).
  if (toEstado === 'pendiente_retiro') return 'aviso_pendiente_retiro';
  return null;
}

async function notifyEstadoTransition({ orderNumber, fromEstado, toEstado, estadoPago }) {
  if (!toEstado || fromEstado === toEstado) return;

  // Caso especial: pendiente_datos_envio programa un reminder a +24hs hábiles.
  if (toEstado === 'pendiente_datos_envio') {
    await scheduleDatosEnvioReminder(orderNumber);
    return;
  }

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

/**
 * Programa un WhatsApp `aviso_pendiente_datos_envio` a +24hs hábiles (L-V 9-18 AR)
 * desde ahora. Si pasa ese plazo y el pedido sigue en `pendiente_datos_envio`,
 * el procesador de scheduled_whatsapp (index.js setInterval) manda el mensaje.
 * Si el cliente carga los datos antes, el guard del procesador lo descarta.
 *
 * Idempotente: si ya hay un reminder programado y pendiente para este pedido,
 * no encola otro (evita duplicados ante recálculos múltiples).
 */
async function scheduleDatosEnvioReminder(orderNumber) {
  try {
    const existsRes = await pool.query(
      `SELECT 1 FROM scheduled_whatsapp
       WHERE order_number = $1
         AND plantilla = 'aviso_pendiente_datos_envio'
         AND sent_at IS NULL
         AND error IS NULL
       LIMIT 1`,
      [String(orderNumber)]
    );
    if (existsRes.rowCount > 0) return;

    const r = await pool.query(
      `SELECT customer_name, customer_phone, estado_pedido
       FROM orders_validated WHERE order_number = $1`,
      [orderNumber]
    );
    if (r.rowCount === 0) return;
    const ord = r.rows[0];
    if (ord.estado_pedido !== 'pendiente_datos_envio') return; // sanity
    if (!ord.customer_phone) {
      console.log(`⚠️ [notify] pendiente_datos_envio #${orderNumber} sin customer_phone → skip reminder`);
      return;
    }

    const sendAt = nextBusinessSendAtAR(new Date(), Number(orderNumber) || 0, 24);

    await pool.query(
      `INSERT INTO scheduled_whatsapp (telefono, plantilla, variables, order_number, send_at)
       VALUES ($1, 'aviso_pendiente_datos_envio', $2::jsonb, $3, $4)`,
      [
        ord.customer_phone,
        JSON.stringify({ '1': ord.customer_name || 'Cliente', '2': String(orderNumber) }),
        String(orderNumber),
        sendAt,
      ]
    );
    console.log(`⏰📅 pendiente_datos_envio #${orderNumber}: reminder programado a ${sendAt.toISOString()}`);
  } catch (err) {
    console.error(`❌ [notify] scheduleDatosEnvioReminder #${orderNumber} error: ${err.message}`);
  }
}

module.exports = { notifyEstadoTransition };
