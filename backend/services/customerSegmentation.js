/**
 * Customer Segmentation Service
 * Asigna segmentos RFM a clientes basándose en sus métricas
 */

const pool = require('../db');

/**
 * Reglas de segmentación RFM
 * Orden importa: se evalúan de arriba a abajo, la primera que matchea gana
 */
const SEGMENT_RULES = [
  {
    segment: 'campeones',
    label: 'Campeones',
    description: 'Compradores frecuentes y recientes',
    rules: {
      orders_count_min: 5,
      days_since_last_order_max: 30
    }
  },
  {
    segment: 'leales',
    label: 'Leales',
    description: 'Compradores regulares',
    rules: {
      orders_count_min: 3,
      days_since_last_order_max: 90
    }
  },
  {
    segment: 'potenciales',
    label: 'Potenciales',
    description: 'Segunda compra reciente',
    rules: {
      orders_count_min: 2,
      orders_count_max: 4,
      days_since_last_order_max: 60
    }
  },
  {
    segment: 'nuevos',
    label: 'Nuevos',
    description: 'Primera compra muy reciente',
    rules: {
      orders_count_min: 1,
      orders_count_max: 1,
      days_since_last_order_max: 30
    }
  },
  {
    segment: 'prometedores',
    label: 'Prometedores',
    description: 'Primera compra, pero hace un tiempo',
    rules: {
      orders_count_min: 1,
      orders_count_max: 1,
      days_since_last_order_min: 31,
      days_since_last_order_max: 90
    }
  },
  {
    segment: 'en_riesgo',
    label: 'En Riesgo',
    description: 'Compradores que se están alejando',
    rules: {
      orders_count_min: 2,
      days_since_last_order_min: 91,
      days_since_last_order_max: 180
    }
  },
  {
    segment: 'hibernando',
    label: 'Hibernando',
    description: 'Sin compras en mucho tiempo',
    rules: {
      orders_count_min: 1,
      days_since_last_order_min: 181,
      days_since_last_order_max: 365
    }
  },
  {
    segment: 'perdidos',
    label: 'Perdidos',
    description: 'Sin actividad en más de un año',
    rules: {
      orders_count_min: 1,
      days_since_last_order_min: 366
    }
  },
  {
    segment: 'sin_compras',
    label: 'Sin Compras',
    description: 'Registrado pero nunca compró',
    rules: {
      orders_count_max: 0
    }
  }
];

/**
 * Determina el segmento de un cliente basándose en sus métricas
 * @param {Object} customer - { orders_count, last_order_at }
 * @returns {string} Nombre del segmento
 */
function determineSegment(customer) {
  const ordersCount = customer.orders_count || 0;
  const lastOrderAt = customer.last_order_at;

  let daysSinceLastOrder = null;
  if (lastOrderAt) {
    daysSinceLastOrder = Math.floor((Date.now() - new Date(lastOrderAt).getTime()) / (1000 * 60 * 60 * 24));
  }

  for (const rule of SEGMENT_RULES) {
    const r = rule.rules;
    let matches = true;

    // orders_count checks
    if (r.orders_count_min !== undefined && ordersCount < r.orders_count_min) {
      matches = false;
    }
    if (r.orders_count_max !== undefined && ordersCount > r.orders_count_max) {
      matches = false;
    }

    // days_since_last_order checks (solo si hay última orden)
    if (daysSinceLastOrder !== null) {
      if (r.days_since_last_order_min !== undefined && daysSinceLastOrder < r.days_since_last_order_min) {
        matches = false;
      }
      if (r.days_since_last_order_max !== undefined && daysSinceLastOrder > r.days_since_last_order_max) {
        matches = false;
      }
    } else {
      // Si no hay última orden pero la regla requiere una, no matchea
      if (r.days_since_last_order_min !== undefined || r.days_since_last_order_max !== undefined) {
        if (ordersCount > 0) {
          // Tiene órdenes pero no fecha? Raro, pero tratamos como muy viejo
          // Solo matchea si la regla NO tiene límite max
          if (r.days_since_last_order_max !== undefined) {
            matches = false;
          }
        }
      }
    }

    if (matches) {
      return rule.segment;
    }
  }

  return 'sin_clasificar';
}

/**
 * Recalcula segmentos para todos los clientes
 * @returns {Promise<Object>} { updated, bySegment }
 */
async function segmentAllCustomers() {
  console.log('[CustomerSegmentation] Calculando segmentos para todos los clientes...');

  // Traer todos los clientes con sus métricas
  const { rows: customers } = await pool.query(`
    SELECT id, orders_count, last_order_at
    FROM customers
  `);

  const bySegment = {};
  let updated = 0;

  for (const customer of customers) {
    const segment = determineSegment(customer);

    await pool.query(`
      UPDATE customers
      SET segment = $1, segment_updated_at = NOW()
      WHERE id = $2
    `, [segment, customer.id]);

    bySegment[segment] = (bySegment[segment] || 0) + 1;
    updated++;
  }

  console.log('[CustomerSegmentation] Segmentación completada:', bySegment);

  return { updated, bySegment };
}

/**
 * Recalcula segmento para un cliente específico
 * @param {string} customerId - UUID del cliente
 * @returns {Promise<string>} Segmento asignado
 */
async function segmentCustomer(customerId) {
  const { rows } = await pool.query(`
    SELECT id, orders_count, last_order_at FROM customers WHERE id = $1
  `, [customerId]);

  if (!rows[0]) return null;

  const segment = determineSegment(rows[0]);

  await pool.query(`
    UPDATE customers
    SET segment = $1, segment_updated_at = NOW()
    WHERE id = $2
  `, [segment, customerId]);

  return segment;
}

/**
 * Obtener conteo de clientes por segmento
 * @returns {Promise<Object>} { segment: count, ... }
 */
async function getSegmentCounts() {
  const { rows } = await pool.query(`
    SELECT segment, COUNT(*) as count
    FROM customers
    GROUP BY segment
    ORDER BY count DESC
  `);

  const result = {};
  for (const row of rows) {
    result[row.segment || 'sin_clasificar'] = parseInt(row.count);
  }

  return result;
}

/**
 * Obtener clientes de un segmento específico
 * @param {string} segment - Nombre del segmento
 * @param {Object} options - { page, limit }
 * @returns {Promise<Object>} { customers, total, page, limit }
 */
async function getCustomersBySegment(segment, { page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;

  const countResult = await pool.query(`
    SELECT COUNT(*) as total FROM customers WHERE segment = $1
  `, [segment]);

  const { rows } = await pool.query(`
    SELECT
      id, tn_customer_id, name, email, phone,
      orders_count, total_spent, first_order_at, last_order_at, avg_order_value,
      segment, segment_updated_at
    FROM customers
    WHERE segment = $1
    ORDER BY total_spent DESC NULLS LAST
    LIMIT $2 OFFSET $3
  `, [segment, limit, offset]);

  return {
    customers: rows,
    total: parseInt(countResult.rows[0].total),
    page,
    limit
  };
}

/**
 * Obtener definición de todos los segmentos
 * @returns {Array} Lista de segmentos con sus reglas
 */
function getSegmentDefinitions() {
  return SEGMENT_RULES.map(r => ({
    segment: r.segment,
    label: r.label,
    description: r.description
  }));
}

module.exports = {
  SEGMENT_RULES,
  determineSegment,
  segmentAllCustomers,
  segmentCustomer,
  getSegmentCounts,
  getCustomersBySegment,
  getSegmentDefinitions
};
