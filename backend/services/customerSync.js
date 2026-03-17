/**
 * Customer Sync Service
 * Sincroniza clientes desde Tiendanube hacia tabla customers local
 */

const pool = require('../db');
const axios = require('axios');

const TN_API_BASE = `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}`;
const TN_HEADERS = {
  'Authentication': `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
  'User-Agent': 'BPM Admin (bpmadministrador.com)',
  'Content-Type': 'application/json'
};

/**
 * Fetch customers from Tiendanube with pagination
 * @param {Object} options - { updatedAtMin, page, perPage }
 * @returns {Promise<Array>} Array of customers
 */
async function fetchCustomersFromTN({ updatedAtMin = null, page = 1, perPage = 200 } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage)
  });

  if (updatedAtMin) {
    params.append('updated_at_min', updatedAtMin);
  }

  const url = `${TN_API_BASE}/customers?${params.toString()}`;

  try {
    const response = await axios.get(url, { headers: TN_HEADERS });
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      return [];
    }
    throw error;
  }
}

/**
 * Upsert a single customer into the database
 * @param {Object} customer - Customer data from TN
 * @returns {Promise<Object>} { inserted: boolean, updated: boolean }
 */
async function upsertCustomer(customer) {
  // NOTA: TN customers API NO devuelve orders_count ni last_order_at
  // Solo devuelve: total_spent, last_order_id, updated_at
  // El orders_count se sincroniza después con syncOrdersCountFromTN()
  const query = `
    INSERT INTO customers (
      tn_customer_id,
      name,
      email,
      phone,
      normalized_phone,
      total_spent,
      tn_last_order_id,
      tn_created_at,
      tn_updated_at,
      tn_synced_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    ON CONFLICT (tn_customer_id) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, customers.name),
      email = COALESCE(EXCLUDED.email, customers.email),
      phone = COALESCE(EXCLUDED.phone, customers.phone),
      normalized_phone = COALESCE(EXCLUDED.normalized_phone, customers.normalized_phone),
      total_spent = EXCLUDED.total_spent,
      tn_last_order_id = EXCLUDED.tn_last_order_id,
      tn_updated_at = EXCLUDED.tn_updated_at,
      tn_synced_at = NOW(),
      updated_at = NOW()
    RETURNING id, (xmax = 0) AS inserted
  `;

  // Normalize phone (simple version - strip non-digits)
  const phone = customer.phone || customer.default_address?.phone || null;
  const normalizedPhone = phone ? phone.replace(/\D/g, '') : null;

  const values = [
    customer.id,                                    // tn_customer_id
    customer.name || null,                          // name
    customer.email || null,                         // email
    phone,                                          // phone
    normalizedPhone,                                // normalized_phone
    parseFloat(customer.total_spent) || 0,          // total_spent
    customer.last_order_id || null,                 // tn_last_order_id
    customer.created_at || null,                    // tn_created_at
    customer.updated_at || null                     // tn_updated_at
  ];

  const result = await pool.query(query, values);
  return {
    id: result.rows[0]?.id,
    inserted: result.rows[0]?.inserted === true,
    updated: result.rows[0]?.inserted === false
  };
}

/**
 * Get the last sync timestamp from database
 * @returns {Promise<string|null>} ISO timestamp or null
 */
async function getLastSyncTimestamp() {
  const result = await pool.query(`
    SELECT MAX(tn_synced_at) as last_sync
    FROM customers
    WHERE tn_customer_id IS NOT NULL
  `);
  return result.rows[0]?.last_sync?.toISOString() || null;
}

/**
 * Full sync - fetch all customers from TN
 * @param {Function} onProgress - Callback for progress updates
 * @returns {Promise<Object>} { total, inserted, updated, errors }
 */
async function fullSync(onProgress = null) {
  console.log('[CustomerSync] Starting full sync...');

  let page = 1;
  let total = 0;
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  while (true) {
    const customers = await fetchCustomersFromTN({ page, perPage: 200 });

    if (!customers || customers.length === 0) {
      break;
    }

    for (const customer of customers) {
      try {
        const result = await upsertCustomer(customer);
        if (result.inserted) inserted++;
        else if (result.updated) updated++;
        total++;
      } catch (err) {
        console.error(`[CustomerSync] Error upserting customer ${customer.id}:`, err.message);
        errors++;
      }
    }

    if (onProgress) {
      onProgress({ page, processed: total, inserted, updated, errors });
    }

    console.log(`[CustomerSync] Page ${page}: ${customers.length} customers processed (total: ${total})`);

    if (customers.length < 200) {
      break; // Last page
    }

    page++;

    // Rate limiting - TN allows 2 req/sec
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[CustomerSync] Full sync complete. Total: ${total}, Inserted: ${inserted}, Updated: ${updated}, Errors: ${errors}`);

  return { total, inserted, updated, errors };
}

/**
 * Incremental sync - fetch only customers updated since last sync
 * @param {Function} onProgress - Callback for progress updates
 * @returns {Promise<Object>} { total, inserted, updated, errors, since }
 */
async function incrementalSync(onProgress = null) {
  const lastSync = await getLastSyncTimestamp();

  if (!lastSync) {
    console.log('[CustomerSync] No previous sync found, running full sync...');
    return fullSync(onProgress);
  }

  console.log(`[CustomerSync] Starting incremental sync since ${lastSync}...`);

  let page = 1;
  let total = 0;
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  while (true) {
    const customers = await fetchCustomersFromTN({
      updatedAtMin: lastSync,
      page,
      perPage: 200
    });

    if (!customers || customers.length === 0) {
      break;
    }

    for (const customer of customers) {
      try {
        const result = await upsertCustomer(customer);
        if (result.inserted) inserted++;
        else if (result.updated) updated++;
        total++;
      } catch (err) {
        console.error(`[CustomerSync] Error upserting customer ${customer.id}:`, err.message);
        errors++;
      }
    }

    if (onProgress) {
      onProgress({ page, processed: total, inserted, updated, errors });
    }

    console.log(`[CustomerSync] Page ${page}: ${customers.length} customers processed`);

    if (customers.length < 200) {
      break;
    }

    page++;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[CustomerSync] Incremental sync complete. Total: ${total}, Inserted: ${inserted}, Updated: ${updated}, Errors: ${errors}`);

  return { total, inserted, updated, errors, since: lastSync };
}

/**
 * Sync a single customer by TN ID
 * @param {number} tnCustomerId - Tiendanube customer ID
 * @returns {Promise<Object>} Upsert result
 */
async function syncSingleCustomer(tnCustomerId) {
  const url = `${TN_API_BASE}/customers/${tnCustomerId}`;

  try {
    const response = await axios.get(url, { headers: TN_HEADERS });
    return await upsertCustomer(response.data);
  } catch (error) {
    if (error.response?.status === 404) {
      return { notFound: true };
    }
    throw error;
  }
}

/**
 * Fetch ALL orders from TN and calculate orders_count per customer
 * TN's customer_id filter on /orders doesn't work reliably
 * @param {Function} onProgress - Callback for progress updates
 * @returns {Promise<Object>} { updated, totalOrders }
 */
async function syncOrdersCountFromTN(onProgress = null) {
  console.log('[CustomerSync] Fetching all orders from TN to calculate orders_count...');

  // Fetch all orders with pagination
  const customerOrders = new Map(); // tn_customer_id -> { count, lastOrderAt }
  let page = 1;
  let totalOrders = 0;

  while (true) {
    try {
      const url = `${TN_API_BASE}/orders?per_page=200&page=${page}`;
      const response = await axios.get(url, { headers: TN_HEADERS });
      const orders = response.data;

      if (!orders || orders.length === 0) break;

      for (const order of orders) {
        const customerId = order.customer?.id;
        if (!customerId) continue;

        // Solo contar órdenes pagadas
        if (order.payment_status !== 'paid' && order.payment_status !== 'partially_paid') continue;

        const existing = customerOrders.get(customerId) || { count: 0, lastOrderAt: null };
        existing.count++;

        const orderDate = order.created_at;
        if (!existing.lastOrderAt || new Date(orderDate) > new Date(existing.lastOrderAt)) {
          existing.lastOrderAt = orderDate;
        }

        customerOrders.set(customerId, existing);
      }

      totalOrders += orders.length;
      console.log(`[CustomerSync] Page ${page}: ${orders.length} orders (total: ${totalOrders}, unique customers: ${customerOrders.size})`);

      if (onProgress) {
        onProgress({ page, totalOrders, uniqueCustomers: customerOrders.size });
      }

      if (orders.length < 200) break;

      page++;
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    } catch (err) {
      console.error(`[CustomerSync] Error fetching orders page ${page}:`, err.message);
      if (err.response?.status === 504 || err.response?.status === 429) {
        // Timeout o rate limit - esperar y reintentar
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      break;
    }
  }

  console.log(`[CustomerSync] Fetched ${totalOrders} orders for ${customerOrders.size} customers`);

  // Now update customers table in batch
  let updated = 0;
  for (const [tnCustomerId, data] of customerOrders) {
    try {
      const result = await pool.query(`
        UPDATE customers
        SET orders_count = $1, last_order_at = $2, updated_at = NOW()
        WHERE tn_customer_id = $3 AND (orders_count IS NULL OR orders_count != $1)
      `, [data.count, data.lastOrderAt, tnCustomerId]);

      if (result.rowCount > 0) updated++;
    } catch (err) {
      // Ignore individual errors
    }
  }

  console.log(`[CustomerSync] Updated ${updated} customers with orders_count`);
  return { updated, totalOrders, uniqueCustomers: customerOrders.size };
}

module.exports = {
  fetchCustomersFromTN,
  upsertCustomer,
  getLastSyncTimestamp,
  fullSync,
  incrementalSync,
  syncSingleCustomer,
  syncOrdersCountFromTN
};
