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
 * Fetch order count and last order date for customers from TN orders API
 * This fills in the orders_count that TN customers API doesn't provide
 * @returns {Promise<Object>} { updated, errors }
 */
async function syncOrdersCountFromTN() {
  console.log('[CustomerSync] Syncing orders_count from TN orders API...');

  // Get customers with total_spent > 0 but orders_count = 0 (missing data)
  const { rows: customers } = await pool.query(`
    SELECT id, tn_customer_id, name
    FROM customers
    WHERE tn_customer_id IS NOT NULL
      AND COALESCE(total_spent, 0) > 0
      AND COALESCE(orders_count, 0) = 0
    LIMIT 500
  `);

  console.log(`[CustomerSync] Found ${customers.length} customers needing orders sync`);

  let updated = 0;
  let errors = 0;

  for (const customer of customers) {
    try {
      // Fetch orders for this customer from TN
      const url = `${TN_API_BASE}/orders?customer_id=${customer.tn_customer_id}&per_page=200`;
      const response = await axios.get(url, { headers: TN_HEADERS });
      const orders = response.data;

      if (orders && orders.length > 0) {
        // Count paid orders
        const paidOrders = orders.filter(o =>
          o.payment_status === 'paid' || o.payment_status === 'partially_paid'
        );
        const ordersCount = paidOrders.length;

        // Get last order date
        const lastOrder = orders.sort((a, b) =>
          new Date(b.created_at) - new Date(a.created_at)
        )[0];
        const lastOrderAt = lastOrder?.created_at || null;

        // Update customer
        await pool.query(`
          UPDATE customers
          SET orders_count = $1, last_order_at = $2, updated_at = NOW()
          WHERE id = $3
        `, [ordersCount, lastOrderAt, customer.id]);

        updated++;
        console.log(`[CustomerSync] ${customer.name}: ${ordersCount} orders`);
      }

      // Rate limit - TN allows 2 req/sec
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      console.error(`[CustomerSync] Error syncing orders for ${customer.name}:`, err.message);
      errors++;
    }
  }

  console.log(`[CustomerSync] Orders sync complete. Updated: ${updated}, Errors: ${errors}`);
  return { updated, errors, remaining: customers.length - updated - errors };
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
