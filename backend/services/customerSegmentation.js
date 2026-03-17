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
 * @param {Object} customer - { orders_count, last_order_at, total_spent }
 * @returns {string} Nombre del segmento
 */
function determineSegment(customer) {
  // Usar orders_count si existe, sino inferir de total_spent (datos de TN)
  const ordersCount = customer.orders_count > 0
    ? customer.orders_count
    : (parseFloat(customer.total_spent) > 0 ? 1 : 0);  // Si gastó algo, al menos 1 orden
  const lastOrderAt = customer.last_order_at || customer.tn_updated_at; // Fallback a última actualización TN

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
 * Recalcula segmentos para todos los clientes (versión optimizada con SQL)
 * @returns {Promise<Object>} { updated, bySegment }
 */
async function segmentAllCustomers() {
  console.log('[CustomerSegmentation] Calculando segmentos para todos los clientes...');

  // Una sola query UPDATE con CASE WHEN - mucho más rápido
  const result = await pool.query(`
    UPDATE customers
    SET
      segment = CASE
        -- Primero determinamos si tiene compras (orders_count > 0 O total_spent > 0)
        WHEN (orders_count > 0 OR COALESCE(total_spent, 0) > 0) THEN
          CASE
            -- Calcular días desde última orden (usar last_order_at o tn_updated_at)
            WHEN COALESCE(last_order_at, tn_updated_at) IS NOT NULL THEN
              CASE
                -- Campeones: 5+ órdenes Y última < 30 días
                WHEN orders_count >= 5
                  AND EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 <= 30
                  THEN 'campeones'
                -- Leales: 3+ órdenes Y última < 90 días
                WHEN orders_count >= 3
                  AND EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 <= 90
                  THEN 'leales'
                -- Potenciales: 2-4 órdenes Y última < 60 días
                WHEN orders_count >= 2 AND orders_count <= 4
                  AND EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 <= 60
                  THEN 'potenciales'
                -- Nuevos: 1 orden Y última < 30 días (o total_spent > 0 sin orders_count)
                WHEN (orders_count = 1 OR (orders_count = 0 AND COALESCE(total_spent, 0) > 0))
                  AND EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 <= 30
                  THEN 'nuevos'
                -- Prometedores: 1 orden Y última 31-90 días
                WHEN (orders_count = 1 OR (orders_count = 0 AND COALESCE(total_spent, 0) > 0))
                  AND EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 BETWEEN 31 AND 90
                  THEN 'prometedores'
                -- En riesgo: 2+ órdenes Y última 91-180 días
                WHEN orders_count >= 2
                  AND EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 BETWEEN 91 AND 180
                  THEN 'en_riesgo'
                -- Hibernando: cualquier orden Y última 181-365 días
                WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 BETWEEN 181 AND 365
                  THEN 'hibernando'
                -- Perdidos: cualquier orden Y última > 365 días
                WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(last_order_at, tn_updated_at))) / 86400 > 365
                  THEN 'perdidos'
                ELSE 'sin_clasificar'
              END
            ELSE 'sin_clasificar'
          END
        ELSE 'sin_compras'
      END,
      segment_updated_at = NOW()
  `);

  console.log('[CustomerSegmentation] Segmentación completada, filas actualizadas:', result.rowCount);

  // Obtener conteo por segmento
  const { rows } = await pool.query(`
    SELECT segment, COUNT(*) as count FROM customers GROUP BY segment
  `);

  const bySegment = {};
  rows.forEach(r => { bySegment[r.segment] = parseInt(r.count); });

  return { updated: result.rowCount, bySegment };
}

/**
 * Recalcula segmento para un cliente específico
 * @param {string} customerId - UUID del cliente
 * @returns {Promise<string>} Segmento asignado
 */
async function segmentCustomer(customerId) {
  const { rows } = await pool.query(`
    SELECT id, orders_count, last_order_at, total_spent, tn_updated_at FROM customers WHERE id = $1
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
