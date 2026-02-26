/**
 * Script de backfill para poblar tn_order_id faltantes
 *
 * Busca pedidos sin tn_order_id y los completa consultando la API de Tiendanube
 *
 * Uso: node scripts/backfill-tn-order-id.js [--dry-run] [--limit=N]
 */

require('dotenv').config();
const axios = require('axios');
const pool = require('../db');

const TIENDANUBE_STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TIENDANUBE_ACCESS_TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;

// Parsear argumentos
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 100;

async function searchOrderInTiendanube(orderNumber) {
  try {
    // Buscar por número de pedido
    const response = await axios.get(
      `https://api.tiendanube.com/v1/${TIENDANUBE_STORE_ID}/orders`,
      {
        headers: {
          authentication: `bearer ${TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-backfill'
        },
        params: {
          q: orderNumber,
          per_page: 5
        },
        timeout: 10000
      }
    );

    if (!Array.isArray(response.data) || response.data.length === 0) {
      return null;
    }

    // Buscar coincidencia exacta
    const match = response.data.find(o => String(o.number) === String(orderNumber));
    return match ? { id: match.id, number: match.number } : null;

  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔧 BACKFILL: Poblar tn_order_id faltantes');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Mode: ${DRY_RUN ? '🔍 DRY RUN (sin cambios)' : '⚡ PRODUCCIÓN'}`);
  console.log(`Limit: ${LIMIT} pedidos`);
  console.log('');

  try {
    // 1. Obtener pedidos sin tn_order_id
    const result = await pool.query(`
      SELECT order_number, customer_name, created_at
      FROM orders_validated
      WHERE tn_order_id IS NULL
      ORDER BY created_at DESC
      LIMIT $1
    `, [LIMIT]);

    const orders = result.rows;
    console.log(`📋 Encontrados ${orders.length} pedidos sin tn_order_id`);
    console.log('');

    if (orders.length === 0) {
      console.log('✅ No hay pedidos para procesar');
      await pool.end();
      return;
    }

    let updated = 0;
    let notFound = 0;
    let errors = 0;

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const progress = `[${i + 1}/${orders.length}]`;

      try {
        // Buscar en Tiendanube
        const tnOrder = await searchOrderInTiendanube(order.order_number);

        if (tnOrder) {
          console.log(`${progress} #${order.order_number} → tn_order_id: ${tnOrder.id}`);

          if (!DRY_RUN) {
            await pool.query(
              'UPDATE orders_validated SET tn_order_id = $1 WHERE order_number = $2',
              [tnOrder.id, order.order_number]
            );
          }
          updated++;
        } else {
          console.log(`${progress} #${order.order_number} → ❌ No encontrado en TN`);
          notFound++;
        }

        // Rate limiting: esperar 200ms entre requests
        await new Promise(r => setTimeout(r, 200));

      } catch (error) {
        console.log(`${progress} #${order.order_number} → ⚠️ Error: ${error.message}`);
        errors++;
      }
    }

    // Resumen
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📊 RESUMEN');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`✅ Actualizados: ${updated}`);
    console.log(`❌ No encontrados en TN: ${notFound}`);
    console.log(`⚠️ Errores: ${errors}`);

    if (DRY_RUN) {
      console.log('');
      console.log('💡 Este fue un DRY RUN. Para aplicar cambios, ejecutar sin --dry-run');
    }

    await pool.end();

  } catch (error) {
    console.error('❌ Error fatal:', error.message);
    await pool.end();
    process.exit(1);
  }
}

run();
