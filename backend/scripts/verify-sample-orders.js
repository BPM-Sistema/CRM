#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('../db');
const axios = require('axios');

const TN_STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TN_TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;

async function getTNOrder(orderNumber) {
  try {
    // Search by order number
    const res = await axios.get(
      `https://api.tiendanube.com/v1/${TN_STORE_ID}/orders?q=${orderNumber}`,
      { headers: { 'Authentication': `bearer ${TN_TOKEN}` } }
    );
    const order = res.data.find(o => String(o.number) === String(orderNumber));
    if (!order) return null;
    return {
      number: order.number,
      payment_status: order.payment_status,
      shipping_status: order.shipping_status,
      status: order.status,
      total: order.total,
      created_at: order.created_at
    };
  } catch (err) {
    return { error: err.response?.status || err.message };
  }
}

async function getDBOrder(orderNumber) {
  const res = await pool.query(`
    SELECT order_number, estado_pago, estado_pedido, monto_tiendanube, total_pagado
    FROM orders_validated
    WHERE order_number = $1
  `, [String(orderNumber)]);
  return res.rows[0] || null;
}

// Sample from each category
const samples = {
  'confirmado_total + a_imprimir': [26733, 26540, 26659, 30288, 30302],
  'pendiente + pendiente_pago': [29115, 30310, 30235, 30363, 30378],
  'confirmado_total + armado': [29974, 30290, 30301, 30185, 30188],
  'confirmado_parcial + enviado': [27773, 29035, 29293],
  'pendiente + retirado': [26745, 29095, 29367],
  'pendiente + enviado': [30221, 30360, 30611],
  'NO encontrados en DB': [21951, 23344, 24769, 25076, 25100]
};

async function main() {
  console.log('Verificando muestra de pedidos contra Tiendanube...\n');

  for (const [category, orderNums] of Object.entries(samples)) {
    console.log(`\n=== ${category} ===`);

    for (const num of orderNums) {
      const [db, tn] = await Promise.all([
        getDBOrder(num),
        getTNOrder(num)
      ]);

      console.log(`\n#${num}:`);
      if (db) {
        console.log(`  DB:  pago=${db.estado_pago}, pedido=${db.estado_pedido}, monto=${db.monto_tiendanube}, pagado=${db.total_pagado}`);
      } else {
        console.log(`  DB:  NO EXISTE`);
      }

      if (tn && !tn.error) {
        console.log(`  TN:  payment=${tn.payment_status}, shipping=${tn.shipping_status}, status=${tn.status}, total=${tn.total}`);
      } else if (tn?.error) {
        console.log(`  TN:  ERROR ${tn.error}`);
      } else {
        console.log(`  TN:  NO ENCONTRADO`);
      }

      // Wait to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  pool.end();
  process.exit(1);
});
