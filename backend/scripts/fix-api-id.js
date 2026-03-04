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

async function fix() {
  const result = await pool.query("SELECT order_number, tn_order_id FROM orders_validated WHERE shipping_type = 'api_3988894'");
  console.log('Pedidos con api_3988894:', result.rowCount);

  for (const row of result.rows) {
    try {
      const res = await axios.get(
        `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}/orders/${row.tn_order_id}`,
        {
          headers: {
            authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
            'User-Agent': 'bpm-validator'
          },
          timeout: 10000
        }
      );
      const shippingType = (typeof res.data.shipping_option === 'string'
        ? res.data.shipping_option
        : res.data.shipping_option?.name) || res.data.shipping || null;

      if (shippingType && shippingType !== 'api_3988894') {
        await pool.query('UPDATE orders_validated SET shipping_type = $1 WHERE order_number = $2', [shippingType, row.order_number]);
        console.log(`#${row.order_number}: ${shippingType}`);
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error(`#${row.order_number}: ${e.message}`);
    }
  }
  await pool.end();
}

fix();
