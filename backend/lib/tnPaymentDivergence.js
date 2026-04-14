/**
 * Detector de divergencias de pago TN
 *
 * Corre una vez al día y detecta pedidos donde:
 * - BPM tiene estado_pago = 'confirmado_total'
 * - tn_payment_status != 'paid' (webhook de TN nunca llegó)
 * - Pero en TN el pedido SÍ está como 'paid'
 *
 * Cuando detecta esta situación, crea una notificación para que
 * el operador revise y sincronice manualmente si es necesario.
 */

const pool = require('../db');
const axios = require('axios');
const { notificarUsuariosConPermiso } = require('../utils/notifications');

/**
 * Buscar pedidos del día anterior con posible divergencia
 */
async function findPotentialDivergences() {
  // Pedidos de ayer con pago confirmado en BPM pero no reflejado desde TN
  const result = await pool.query(`
    SELECT order_number, tn_order_id, estado_pago, tn_payment_status, total_pagado, created_at
    FROM orders_validated
    WHERE estado_pago = 'confirmado_total'
      AND (tn_payment_status IS NULL OR tn_payment_status != 'paid')
      AND tn_order_id IS NOT NULL
      AND created_at >= CURRENT_DATE - INTERVAL '1 day'
      AND created_at < CURRENT_DATE
      AND estado_pedido != 'cancelado'
    ORDER BY created_at DESC
  `);

  return result.rows;
}

/**
 * Consultar estado real en Tiendanube
 */
async function getTnPaymentStatus(tnOrderId) {
  const storeId = process.env.TIENDANUBE_STORE_ID;
  const token = process.env.TIENDANUBE_ACCESS_TOKEN;

  if (!storeId || !token) {
    return null;
  }

  try {
    const res = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
      {
        headers: {
          'Authentication': `bearer ${token}`,
          'User-Agent': 'BPM Administrador'
        },
        timeout: 10000
      }
    );

    return {
      payment_status: res.data.payment_status,
      paid_at: res.data.paid_at
    };
  } catch (err) {
    console.error(`[TN Divergence] Error consultando TN para orden ${tnOrderId}:`, err.message);
    return null;
  }
}

/**
 * Sincronizar tn_payment_status desde TN
 */
async function syncTnPaymentStatus(orderNumber, tnPaymentStatus, tnPaidAt) {
  await pool.query(`
    UPDATE orders_validated
    SET tn_payment_status = $1, tn_paid_at = $2
    WHERE order_number = $3
  `, [tnPaymentStatus, tnPaidAt, orderNumber]);

  console.log(`[TN Divergence] Sincronizado ${orderNumber}: tn_payment_status = ${tnPaymentStatus}`);
}

/**
 * Job principal: detectar y notificar divergencias
 */
async function checkTnPaymentDivergences() {
  console.log('[TN Divergence] Iniciando chequeo de divergencias...');

  const potentialDivergences = await findPotentialDivergences();

  if (potentialDivergences.length === 0) {
    console.log('[TN Divergence] No hay pedidos con posible divergencia');
    return { checked: 0, divergences: 0 };
  }

  console.log(`[TN Divergence] Revisando ${potentialDivergences.length} pedido(s)...`);

  const divergences = [];

  for (const order of potentialDivergences) {
    // Pequeña pausa para no saturar la API de TN
    await new Promise(r => setTimeout(r, 200));

    const tnStatus = await getTnPaymentStatus(order.tn_order_id);

    if (!tnStatus) {
      continue; // Error consultando TN, saltear
    }

    if (tnStatus.payment_status === 'paid' && order.tn_payment_status !== 'paid') {
      divergences.push({
        order_number: order.order_number,
        bpm_status: order.tn_payment_status || 'pending',
        tn_status: tnStatus.payment_status,
        tn_paid_at: tnStatus.paid_at
      });
    }
  }

  if (divergences.length === 0) {
    console.log('[TN Divergence] No se encontraron divergencias');
    return { checked: potentialDivergences.length, divergences: 0 };
  }

  // Crear notificación para admins/operadores
  const pedidosTexto = divergences.length <= 5
    ? divergences.map(d => `#${d.order_number}`).join(', ')
    : `${divergences.slice(0, 5).map(d => `#${d.order_number}`).join(', ')} y ${divergences.length - 5} más`;

  await notificarUsuariosConPermiso('orders.view', {
    tipo: 'divergencia_tn',
    titulo: `${divergences.length} pedido(s) con divergencia TN`,
    descripcion: `Pedidos pagados en TN pero sin confirmación en BPM: ${pedidosTexto}. Revisar y sincronizar manualmente.`,
    referenciaTipo: 'divergencia_tn',
    referenciaId: null
  });

  console.log(`[TN Divergence] ${divergences.length} divergencia(s) detectada(s) y notificada(s)`);

  return { checked: potentialDivergences.length, divergences: divergences.length, details: divergences };
}

module.exports = {
  checkTnPaymentDivergences,
  findPotentialDivergences,
  getTnPaymentStatus,
  syncTnPaymentStatus
};
