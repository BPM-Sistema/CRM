/**
 * Customer Metrics Service
 * Calcula métricas RFM desde orders_validated
 */

const pool = require('../db');

/**
 * Recalcula métricas para todos los clientes
 * - orders_count: cantidad de órdenes (solo pagadas/confirmadas)
 * - total_spent: suma de montos (recalculado desde orders_validated)
 * - first_order_at: fecha primera orden
 * - last_order_at: fecha última orden
 * - avg_order_value: promedio por orden
 *
 * @returns {Promise<Object>} { updated, errors }
 */
async function recalculateAllMetrics() {
  console.log('[CustomerMetrics] Recalculando métricas para todos los clientes...');

  // Calcular métricas desde orders_validated agrupando por email
  // Solo contamos órdenes con pago confirmado (no canceladas/pendientes)
  const metricsQuery = `
    WITH order_metrics AS (
      SELECT
        LOWER(TRIM(customer_email)) as email,
        COUNT(*) as orders_count,
        SUM(monto_tiendanube) as total_spent,
        MIN(tn_created_at) as first_order_at,
        MAX(tn_created_at) as last_order_at,
        AVG(monto_tiendanube) as avg_order_value
      FROM orders_validated
      WHERE customer_email IS NOT NULL
        AND customer_email != ''
        AND estado_pago IN ('confirmado_total', 'confirmado_parcial', 'a_favor')
      GROUP BY LOWER(TRIM(customer_email))
    )
    UPDATE customers c
    SET
      orders_count = om.orders_count,
      total_spent = COALESCE(om.total_spent, c.total_spent),
      first_order_at = om.first_order_at,
      last_order_at = om.last_order_at,
      avg_order_value = om.avg_order_value,
      updated_at = NOW()
    FROM order_metrics om
    WHERE LOWER(TRIM(c.email)) = om.email
    RETURNING c.id
  `;

  try {
    const result = await pool.query(metricsQuery);
    const updated = result.rowCount;

    console.log(`[CustomerMetrics] Métricas actualizadas para ${updated} clientes`);
    return { updated, errors: 0 };
  } catch (error) {
    console.error('[CustomerMetrics] Error recalculando métricas:', error.message);
    throw error;
  }
}

/**
 * Recalcula métricas para un cliente específico
 * @param {string} customerId - UUID del cliente
 * @returns {Promise<Object>} Métricas calculadas
 */
async function recalculateMetricsForCustomer(customerId) {
  const query = `
    WITH customer_email AS (
      SELECT email FROM customers WHERE id = $1
    ),
    order_metrics AS (
      SELECT
        COUNT(*) as orders_count,
        COALESCE(SUM(monto_tiendanube), 0) as total_spent,
        MIN(tn_created_at) as first_order_at,
        MAX(tn_created_at) as last_order_at,
        AVG(monto_tiendanube) as avg_order_value
      FROM orders_validated
      WHERE LOWER(TRIM(customer_email)) = (SELECT LOWER(TRIM(email)) FROM customer_email)
        AND estado_pago IN ('confirmado_total', 'confirmado_parcial', 'a_favor')
    )
    UPDATE customers
    SET
      orders_count = (SELECT orders_count FROM order_metrics),
      total_spent = (SELECT total_spent FROM order_metrics),
      first_order_at = (SELECT first_order_at FROM order_metrics),
      last_order_at = (SELECT last_order_at FROM order_metrics),
      avg_order_value = (SELECT avg_order_value FROM order_metrics),
      updated_at = NOW()
    WHERE id = $1
    RETURNING orders_count, total_spent, first_order_at, last_order_at, avg_order_value
  `;

  const result = await pool.query(query, [customerId]);
  return result.rows[0] || null;
}

/**
 * Obtener métricas agregadas de todos los clientes
 * @returns {Promise<Object>} Estadísticas globales
 */
async function getGlobalMetrics() {
  const query = `
    SELECT
      COUNT(*) as total_customers,
      COUNT(CASE WHEN orders_count > 0 THEN 1 END) as customers_with_orders,
      AVG(orders_count) as avg_orders_per_customer,
      AVG(total_spent) as avg_total_spent,
      SUM(total_spent) as total_revenue,
      AVG(EXTRACT(EPOCH FROM (NOW() - last_order_at)) / 86400)::int as avg_days_since_last_order
    FROM customers
    WHERE orders_count > 0
  `;

  const result = await pool.query(query);
  return result.rows[0];
}

module.exports = {
  recalculateAllMetrics,
  recalculateMetricsForCustomer,
  getGlobalMetrics
};
