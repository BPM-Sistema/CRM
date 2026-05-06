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
 * Buscar pedidos con posible divergencia de pago BPM-TN.
 *
 * Antes filtraba solo "creado ayer" (24hs); en la practica las divergencias
 * mas dolorosas son las que pasan dias sin detectar (ej: 31129/31207 estuvieron
 * 11 dias en limbo). Ahora miramos los ultimos 30 dias y limitamos a 200 para
 * no colgar el cron si por alguna razon hubiese muchas.
 */
async function findPotentialDivergences() {
  const result = await pool.query(`
    SELECT order_number, tn_order_id, estado_pago, tn_payment_status, total_pagado, created_at
    FROM orders_validated
    WHERE estado_pago = 'confirmado_total'
      AND (tn_payment_status IS NULL OR tn_payment_status != 'paid')
      AND tn_order_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '30 days'
      AND estado_pedido != 'cancelado'
    ORDER BY created_at DESC
    LIMIT 200
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

// ════════════════════════════════════════════════════════════════
// CASO INVERSO: TN dice paid pero BPM no se enteró
// ════════════════════════════════════════════════════════════════
// Cobertura del cron /resync-estados/cron es solo últimos 7 días. Si el
// cliente paga semanas/meses después de crear el pedido (algo común con
// transferencias manuales), el pedido queda con estado_pago='pendiente' en
// BPM y nunca se sincroniza, generando recordatorios falsos a clientes
// que ya pagaron.
//
// Esta función busca pedidos pendientes (incluso viejos) que TN reporta
// como pagados y los SINCRONIZA automaticamente — la decisión es clara.

async function findAndFixReversePaymentDivergences() {
  console.log('[TN Reverse Divergence] Iniciando chequeo TN→BPM...');
  const storeId = process.env.TIENDANUBE_STORE_ID;
  const token = process.env.TIENDANUBE_ACCESS_TOKEN;
  if (!storeId || !token) {
    console.warn('[TN Reverse Divergence] TN no configurado, saltando');
    return { checked: 0, fixed: 0 };
  }

  const axios = require('axios');
  const { recalcularPagos } = require('./recalcularPagos');

  // Pedidos candidatos: pendiente_pago + sin pago confirmado + tn_order_id + ult 90d.
  // Limito a 200 para no abusar de la API de TN en una sola corrida.
  const { rows: candidates } = await pool.query(`
    SELECT order_number, tn_order_id, estado_pago, tn_payment_status,
           total_pagado, pago_online_tn, monto_tiendanube, created_at
    FROM orders_validated
    WHERE estado_pago = 'pendiente'
      AND estado_pedido != 'cancelado'
      AND tn_order_id IS NOT NULL
      AND created_at >= NOW() - INTERVAL '90 days'
    ORDER BY created_at DESC
    LIMIT 200
  `);

  if (candidates.length === 0) {
    console.log('[TN Reverse Divergence] No hay candidatos');
    return { checked: 0, fixed: 0 };
  }

  console.log(`[TN Reverse Divergence] Revisando ${candidates.length} pedidos contra TN...`);

  let fixed = 0;
  const fixedDetails = [];

  for (const c of candidates) {
    await new Promise(r => setTimeout(r, 200)); // rate limit a TN
    let tn;
    try {
      const res = await axios.get(
        `https://api.tiendanube.com/v1/${storeId}/orders/${c.tn_order_id}`,
        { headers: { 'Authentication': `bearer ${token}`, 'User-Agent': 'BPM Reverse Divergence' }, timeout: 10000 }
      );
      tn = res.data;
    } catch (err) {
      console.warn(`[TN Reverse Divergence] error TN para #${c.order_number}: ${err.message}`);
      continue;
    }

    if (tn.payment_status !== 'paid' || tn.status === 'cancelled') continue;

    // TN dice paid, BPM tiene estado_pago='pendiente' → sincronizar
    const tnTotalPaid = Math.round(Number(tn.total_paid || 0));
    const pagoOnline = tnTotalPaid > 0 ? tnTotalPaid : Math.round(Number(tn.total || c.monto_tiendanube));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE orders_validated
            SET tn_payment_status = $1,
                tn_paid_at = $2,
                tn_total_paid = $3,
                tn_gateway = $4,
                pago_online_tn = $5,
                updated_at = NOW()
          WHERE order_number = $6`,
        ['paid', tn.paid_at || null, tnTotalPaid, tn.gateway || null, pagoOnline, c.order_number]
      );
      await recalcularPagos(client, c.order_number);
      await client.query('COMMIT');

      fixed++;
      fixedDetails.push({ order_number: c.order_number, paid_at: tn.paid_at, total_paid: tnTotalPaid });
      console.log(`[TN Reverse Divergence] FIXED #${c.order_number} (paid_at=${tn.paid_at}, $${pagoOnline})`);
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[TN Reverse Divergence] tx error #${c.order_number}: ${txErr.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`[TN Reverse Divergence] Sincronizados ${fixed} de ${candidates.length}`);
  return { checked: candidates.length, fixed, details: fixedDetails };
}

module.exports = {
  checkTnPaymentDivergences,
  findPotentialDivergences,
  getTnPaymentStatus,
  syncTnPaymentStatus,
  findAndFixReversePaymentDivergences,
};
