/**
 * Servicio de Sincronización de Pedidos
 * Polling de TiendaNube + procesamiento de cola
 */

const axios = require('axios');
const pool = require('../db');
const {
  addToQueue,
  getNextPending,
  markCompleted,
  markFailed,
  getSyncState,
  updateSyncState,
  cleanupOldItems
} = require('./syncQueue');

const TIENDANUBE_STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TIENDANUBE_ACCESS_TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;
const BOTMAKER_ACCESS_TOKEN = process.env.BOTMAKER_ACCESS_TOKEN;
const BOTMAKER_CHANNEL_ID = process.env.BOTMAKER_CHANNEL_ID;

/**
 * Obtener pedido de TiendaNube por ID
 */
async function fetchOrderFromTiendaNube(orderId) {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/v1/${TIENDANUBE_STORE_ID}/orders/${orderId}`,
      {
        headers: {
          authentication: `bearer ${TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-validator'
        },
        timeout: 10000
      }
    );
    return response.data;
  } catch (error) {
    console.error(`❌ Error obteniendo pedido ${orderId}:`, error.message);
    throw error;
  }
}

/**
 * Obtener pedidos recientes de TiendaNube
 * @param {number} limit - Cantidad de pedidos a obtener
 * @param {string} sinceId - Obtener pedidos después de este ID (para paginación)
 */
async function fetchRecentOrders(limit = 50, sinceId = null) {
  try {
    const params = {
      per_page: limit,
      created_at_min: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // Últimas 24h
    };

    if (sinceId) {
      params.since_id = sinceId;
    }

    const response = await axios.get(
      `https://api.tiendanube.com/v1/${TIENDANUBE_STORE_ID}/orders`,
      {
        headers: {
          authentication: `bearer ${TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-validator'
        },
        params,
        timeout: 15000
      }
    );

    return response.data || [];
  } catch (error) {
    console.error('❌ Error obteniendo pedidos de TiendaNube:', error.message);
    throw error;
  }
}

/**
 * Polling: Detectar y encolar pedidos faltantes
 */
async function pollForMissingOrders() {
  console.log('🔄 Iniciando polling de pedidos...');

  try {
    // Obtener pedidos recientes de TiendaNube
    const tnOrders = await fetchRecentOrders(100);

    if (!tnOrders.length) {
      console.log('📭 No hay pedidos recientes en TiendaNube');
      return { checked: 0, queued: 0 };
    }

    // Obtener order_numbers que ya tenemos en DB
    const orderNumbers = tnOrders.map(o => String(o.number));
    const existingResult = await pool.query(
      'SELECT order_number FROM orders_validated WHERE order_number = ANY($1)',
      [orderNumbers]
    );
    const existingOrders = new Set(existingResult.rows.map(r => r.order_number));

    // Encolar pedidos faltantes
    let queued = 0;
    for (const order of tnOrders) {
      const orderNumber = String(order.number);

      if (!existingOrders.has(orderNumber)) {
        // Determinar tipo basado en estado de pago
        const type = order.payment_status === 'paid' ? 'order_paid' : 'order_created';

        await addToQueue({
          type,
          resourceId: String(order.id),
          orderNumber,
          payload: { orderId: order.id, orderNumber }
        });
        queued++;
      }
    }

    // Actualizar estado de sync
    await updateSyncState('last_order_sync', {
      last_synced_at: new Date().toISOString(),
      orders_checked: tnOrders.length,
      orders_queued: queued
    });

    console.log(`✅ Polling completado: ${tnOrders.length} pedidos revisados, ${queued} encolados`);
    return { checked: tnOrders.length, queued };

  } catch (error) {
    console.error('❌ Error en polling:', error.message);
    throw error;
  }
}

/**
 * Procesar un pedido de la cola (order_created)
 */
async function processOrderCreated(orderId, orderNumber) {
  const pedido = await fetchOrderFromTiendaNube(orderId);

  if (!pedido) {
    throw new Error('Pedido no encontrado en TiendaNube');
  }

  // Extraer datos del cliente
  const customerName = pedido.customer?.name || pedido.contact_name || null;
  const customerEmail = pedido.customer?.email || pedido.contact_email || null;
  const customerPhone = pedido.contact_phone || pedido.customer?.phone ||
                        pedido.shipping_address?.phone || pedido.customer?.default_address?.phone || null;

  // Guardar en DB
  await pool.query(`
    INSERT INTO orders_validated (order_number, monto_tiendanube, currency, customer_name, customer_email, customer_phone, estado_pedido, tn_created_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'pendiente_pago', $7)
    ON CONFLICT (order_number) DO UPDATE SET
      customer_name = COALESCE(orders_validated.customer_name, EXCLUDED.customer_name),
      customer_email = COALESCE(orders_validated.customer_email, EXCLUDED.customer_email),
      customer_phone = COALESCE(orders_validated.customer_phone, EXCLUDED.customer_phone),
      tn_created_at = COALESCE(orders_validated.tn_created_at, EXCLUDED.tn_created_at)
  `, [
    String(pedido.number),
    Math.round(Number(pedido.total)),
    pedido.currency || 'ARS',
    customerName,
    customerEmail,
    customerPhone,
    pedido.created_at || null
  ]);

  console.log(`✅ Pedido #${pedido.number} sincronizado desde cola`);

  // ❌ WhatsApp DESACTIVADO en sync - solo guardar pedido en DB
  // Los WhatsApp se envían solo desde el webhook en tiempo real

  return pedido;
}

/**
 * Procesar un pedido pagado de la cola (order_paid)
 */
async function processOrderPaid(orderId, orderNumber) {
  const pedido = await fetchOrderFromTiendaNube(orderId);

  if (!pedido) {
    throw new Error('Pedido no encontrado en TiendaNube');
  }

  // Verificar si ya existe
  const existing = await pool.query(
    'SELECT order_number FROM orders_validated WHERE order_number = $1',
    [String(pedido.number)]
  );

  if (existing.rowCount === 0) {
    // Crear como pagado directamente
    await pool.query(`
      INSERT INTO orders_validated (order_number, monto_tiendanube, total_pagado, saldo, estado_pago, estado_pedido, currency, tn_created_at)
      VALUES ($1, $2, $2, 0, 'confirmado_total', 'a_imprimir', $3, $4)
    `, [String(pedido.number), Math.round(Number(pedido.total)), pedido.currency || 'ARS', pedido.created_at || null]);
  } else {
    // Actualizar como pagado
    await pool.query(`
      UPDATE orders_validated SET
        estado_pago = 'confirmado_total',
        total_pagado = monto_tiendanube,
        saldo = 0,
        estado_pedido = CASE
          WHEN estado_pedido = 'pendiente_pago' THEN 'a_imprimir'
          ELSE estado_pedido
        END,
        tn_created_at = COALESCE(tn_created_at, $2)
      WHERE order_number = $1
    `, [String(pedido.number), pedido.created_at || null]);
  }

  // Registrar pago
  const montoTotal = Math.round(Number(pedido.total));
  await pool.query(`
    INSERT INTO pagos_efectivo (order_number, monto, registrado_por, notas, tipo)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING
  `, [String(pedido.number), montoTotal, 'sistema', 'Pago sincronizado desde cola', 'tiendanube']);

  // Log
  await pool.query(`
    INSERT INTO logs (order_number, accion, origen)
    VALUES ($1, $2, $3)
  `, [String(pedido.number), 'pago_sincronizado_cola', 'sync_worker']);

  console.log(`✅ Pago de pedido #${pedido.number} sincronizado desde cola`);
  return pedido;
}

/**
 * Worker: Procesar cola de sincronización
 */
async function processQueue() {
  const item = await getNextPending();

  if (!item) {
    return null; // No hay items pendientes
  }

  console.log(`⚙️ Procesando: ${item.type} - ${item.order_number || item.resource_id}`);

  try {
    const { orderId, orderNumber } = item.payload || {};

    switch (item.type) {
      case 'order_created':
        await processOrderCreated(orderId || item.resource_id, orderNumber);
        break;

      case 'order_paid':
        await processOrderPaid(orderId || item.resource_id, orderNumber);
        break;

      default:
        console.log(`⚠️ Tipo desconocido: ${item.type}`);
    }

    await markCompleted(item.id);
    return { success: true, item };

  } catch (error) {
    await markFailed(item.id, error.message);
    return { success: false, item, error: error.message };
  }
}

/**
 * Ejecutar worker continuamente hasta vaciar cola
 */
async function runWorker(maxItems = 50) {
  let processed = 0;
  let errors = 0;

  while (processed < maxItems) {
    const result = await processQueue();

    if (!result) {
      break; // Cola vacía
    }

    processed++;
    if (!result.success) errors++;

    // Pequeña pausa entre items para no saturar APIs
    await new Promise(r => setTimeout(r, 200));
  }

  if (processed > 0) {
    console.log(`🏁 Worker terminado: ${processed} procesados, ${errors} errores`);
  }

  return { processed, errors };
}

/**
 * Job completo: Polling + Worker + Cleanup
 */
async function runSyncJob() {
  console.log('🚀 Iniciando job de sincronización...');
  const startTime = Date.now();

  try {
    // 1. Polling de pedidos faltantes
    const pollResult = await pollForMissingOrders();

    // 2. Procesar cola
    const workerResult = await runWorker();

    // 3. Limpiar items viejos
    await cleanupOldItems();

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ Job completado en ${duration}s`);

    return {
      polling: pollResult,
      worker: workerResult,
      duration
    };

  } catch (error) {
    console.error('❌ Error en job de sincronización:', error.message);
    throw error;
  }
}

module.exports = {
  pollForMissingOrders,
  processQueue,
  runWorker,
  runSyncJob,
  fetchOrderFromTiendaNube,
  fetchRecentOrders
};
