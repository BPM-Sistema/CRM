/**
 * Script para actualizar pedidos con shipping_type = "table"
 * Estos pedidos tienen "Expreso a elección" pero no se guardó correctamente
 *
 * Uso: node fix-shipping-type-table.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
});

const TIENDANUBE_STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TIENDANUBE_ACCESS_TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;

async function getOrderFromTiendaNube(tnOrderId) {
  const res = await axios.get(
    `https://api.tiendanube.com/v1/${TIENDANUBE_STORE_ID}/orders/${tnOrderId}`,
    {
      headers: {
        authentication: `bearer ${TIENDANUBE_ACCESS_TOKEN}`,
        'User-Agent': 'bpm-validator'
      },
      timeout: 10000
    }
  );
  return res.data;
}

async function main() {
  try {
    // Buscar pedidos con shipping_type = "table" que tienen tn_order_id
    const result = await pool.query(`
      SELECT order_number, tn_order_id
      FROM orders_validated
      WHERE shipping_type = 'table'
        AND tn_order_id IS NOT NULL
      ORDER BY order_number DESC
      LIMIT 100
    `);

    console.log(`Encontrados ${result.rowCount} pedidos con shipping_type = "table"\n`);

    let actualizados = 0;
    let errores = 0;

    for (const row of result.rows) {
      try {
        const pedido = await getOrderFromTiendaNube(row.tn_order_id);

        // Extraer shipping_option correctamente
        const shippingType = (typeof pedido.shipping_option === 'string'
          ? pedido.shipping_option
          : pedido.shipping_option?.name) || pedido.shipping || null;

        if (shippingType && shippingType !== 'table') {
          await pool.query(
            'UPDATE orders_validated SET shipping_type = $1 WHERE order_number = $2',
            [shippingType, row.order_number]
          );
          console.log(`✅ #${row.order_number}: "${shippingType}"`);
          actualizados++;
        } else {
          console.log(`⏭️  #${row.order_number}: sin cambio (${shippingType})`);
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`❌ #${row.order_number}: ${err.message}`);
        errores++;
      }
    }

    console.log(`\n✅ Actualizados: ${actualizados}`);
    console.log(`❌ Errores: ${errores}`);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
