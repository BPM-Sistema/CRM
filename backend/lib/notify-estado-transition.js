/**
 * Disparadores de WhatsApp por transición de estado del pedido (Fase 2 PR 1).
 *
 * Mira el estado destino + estado de pago y, si corresponde, encola un WhatsApp.
 * Cada disparador tiene un toggle propio en `integration_config` que controla
 * si está activo (independiente del toggle de la plantilla en sí).
 *
 * Llamar desde TODO lugar donde se setea `estado_pedido`:
 *   - PATCH /orders/:n/status (manual + trigger A.2)
 *   - recalcularPagos.js (trigger A.1)
 *
 * Reutilización temporal de plantillas (hasta que se creen custom en Botmaker):
 *   empaquetado + pago no confirmado_total → pendiente_3hs
 *   pendiente_datos_envio                  → datos__envio
 *   pendiente_retiro                       → retiros_local
 */

const pool = require('../db');
const { queueWhatsApp } = require('./whatsapp-queue');
const { isEnabled } = require('../services/integrationConfig');

const TRANSITIONS = {
  empaquetado_pendiente_pago: { plantilla: 'pendiente_3hs',  label: 'empaquetado+pendiente_pago' },
  pendiente_datos_envio:      { plantilla: 'datos__envio',   label: 'pendiente_datos_envio'      },
  pendiente_retiro_aviso:     { plantilla: 'retiros_local',  label: 'pendiente_retiro'           },
};

function resolveTrigger(toEstado, estadoPago) {
  if (toEstado === 'empaquetado' &&
      estadoPago !== 'confirmado_total' && estadoPago !== 'a_favor') {
    return 'empaquetado_pendiente_pago';
  }
  if (toEstado === 'pendiente_datos_envio') return 'pendiente_datos_envio';
  if (toEstado === 'pendiente_retiro')      return 'pendiente_retiro_aviso';
  return null;
}

async function notifyEstadoTransition({ orderNumber, fromEstado, toEstado, estadoPago }) {
  if (!toEstado || fromEstado === toEstado) return;

  const triggerKey = resolveTrigger(toEstado, estadoPago);
  if (!triggerKey) return;

  const { plantilla, label } = TRANSITIONS[triggerKey];

  const on = await isEnabled(triggerKey, { logBlocked: false });
  if (!on) {
    console.log(`🔕 [notify-estado-transition] ${triggerKey} OFF → skip ${plantilla} #${orderNumber} (${label})`);
    return;
  }

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
    await queueWhatsApp({
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
