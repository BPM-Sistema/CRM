/**
 * Customer Segmentation Service
 * Asigna segmentos RFM a clientes basándose en sus métricas
 */

const pool = require('../db');

/**
 * Reglas de segmentación RFM - EXACTAS de Tiendanube
 * Orden importa: se evalúan de arriba a abajo, la primera que matchea gana
 */
const SEGMENT_RULES = [
  // === COMPRAS RECIENTES (< 45 días) ===
  {
    segment: 'campeones',
    label: 'Campeones',
    description: '6+ compras, última < 45 días',
    rules: {
      orders_count_min: 6,
      days_since_last_order_max: 45
    }
  },
  {
    segment: 'leales',
    label: 'Leales',
    description: '3-5 compras, última < 45 días',
    rules: {
      orders_count_min: 3,
      orders_count_max: 5,
      days_since_last_order_max: 45
    }
  },
  {
    segment: 'recientes',
    label: 'Recientes',
    description: '1-2 compras, última < 45 días',
    rules: {
      orders_count_min: 1,
      orders_count_max: 2,
      days_since_last_order_max: 45
    }
  },
  // === COMPRAS MEDIAS (45-90 días) ===
  {
    segment: 'alto_potencial',
    label: 'Alto Potencial',
    description: '5+ compras, última 45-90 días',
    rules: {
      orders_count_min: 5,
      days_since_last_order_min: 46,
      days_since_last_order_max: 90
    }
  },
  {
    segment: 'necesitan_incentivo',
    label: 'Necesitan Incentivo',
    description: '1-4 compras, última 45-90 días',
    rules: {
      orders_count_min: 1,
      orders_count_max: 4,
      days_since_last_order_min: 46,
      days_since_last_order_max: 90
    }
  },
  // === COMPRAS ANTIGUAS (90-180 días) ===
  {
    segment: 'no_pueden_perder',
    label: 'No Se Pueden Perder',
    description: '5+ compras, última 90-180 días',
    rules: {
      orders_count_min: 5,
      days_since_last_order_min: 91,
      days_since_last_order_max: 180
    }
  },
  {
    segment: 'en_riesgo',
    label: 'En Riesgo',
    description: '1-4 compras, última 90-180 días',
    rules: {
      orders_count_min: 1,
      orders_count_max: 4,
      days_since_last_order_min: 91,
      days_since_last_order_max: 180
    }
  },
  // === MUY ANTIGUAS (180-365 días) ===
  {
    segment: 'por_perder',
    label: 'Por Perder',
    description: '1+ compras, última 180-365 días',
    rules: {
      orders_count_min: 1,
      days_since_last_order_min: 181,
      days_since_last_order_max: 365
    }
  },
  // === PERDIDOS (> 365 días) ===
  {
    segment: 'perdidos',
    label: 'Perdidos',
    description: 'Sin actividad en más de un año',
    rules: {
      orders_count_min: 1,
      days_since_last_order_min: 366
    }
  },
  // === SIN COMPRAS ===
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
 * Reglas exactas de Tiendanube
 * @param {Object} customer - { orders_count, last_order_at, tn_updated_at }
 * @returns {string} Nombre del segmento
 */
function determineSegment(customer) {
  // Usar orders_count directo de TN (ya viene sincronizado correctamente)
  const ordersCount = parseInt(customer.orders_count) || 0;

  // Sin compras = 0 órdenes
  if (ordersCount === 0) {
    return 'sin_compras';
  }

  // Calcular días desde última orden
  // Usar last_order_at si existe, sino tn_updated_at como proxy
  const lastOrderAt = customer.last_order_at || customer.tn_updated_at;

  if (!lastOrderAt) {
    // Tiene órdenes pero no fecha - tratamos como perdido (muy viejo)
    return 'perdidos';
  }

  const daysSinceLastOrder = Math.floor(
    (Date.now() - new Date(lastOrderAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  // Aplicar reglas de TN en orden
  for (const rule of SEGMENT_RULES) {
    const r = rule.rules;

    // Si es sin_compras, ya lo manejamos arriba
    if (rule.segment === 'sin_compras') continue;

    let matches = true;

    // orders_count checks
    if (r.orders_count_min !== undefined && ordersCount < r.orders_count_min) {
      matches = false;
    }
    if (r.orders_count_max !== undefined && ordersCount > r.orders_count_max) {
      matches = false;
    }

    // days_since_last_order checks
    if (r.days_since_last_order_min !== undefined && daysSinceLastOrder < r.days_since_last_order_min) {
      matches = false;
    }
    if (r.days_since_last_order_max !== undefined && daysSinceLastOrder > r.days_since_last_order_max) {
      matches = false;
    }

    if (matches) {
      return rule.segment;
    }
  }

  // Si no matchea ninguna regla (edge case)
  return 'sin_clasificar';
}

/**
 * Recalcula segmentos para todos los clientes
 * Usa la función determineSegment() para consistencia con segmentación individual
 * @returns {Promise<Object>} { updated, bySegment }
 */
async function segmentAllCustomers() {
  console.log('[CustomerSegmentation] Calculando segmentos para todos los clientes...');

  // Obtener todos los clientes con sus métricas
  const { rows: customers } = await pool.query(`
    SELECT id, orders_count, last_order_at, total_spent, tn_updated_at
    FROM customers
  `);

  console.log(`[CustomerSegmentation] Procesando ${customers.length} clientes...`);

  // Calcular segmento para cada uno usando la lógica JS (consistente)
  const updates = customers.map(c => ({
    id: c.id,
    segment: determineSegment(c)
  }));

  // Agrupar por segmento para UPDATE batch
  const bySegment = {};
  for (const u of updates) {
    if (!bySegment[u.segment]) bySegment[u.segment] = [];
    bySegment[u.segment].push(u.id);
  }

  // Ejecutar UPDATEs por segmento (máximo 9 queries vs miles)
  let totalUpdated = 0;
  for (const [segment, ids] of Object.entries(bySegment)) {
    if (ids.length === 0) continue;
    const result = await pool.query(`
      UPDATE customers
      SET segment = $1, segment_updated_at = NOW()
      WHERE id = ANY($2)
    `, [segment, ids]);
    totalUpdated += result.rowCount;
    console.log(`[CustomerSegmentation] ${segment}: ${result.rowCount} clientes`);
  }

  console.log('[CustomerSegmentation] Segmentación completada, total actualizado:', totalUpdated);

  // Conteo final
  const counts = {};
  for (const [segment, ids] of Object.entries(bySegment)) {
    counts[segment] = ids.length;
  }

  return { updated: totalUpdated, bySegment: counts };
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

// ==========================================
// Segmentación por percentiles (Top Gastadores / Top Compradores)
// ==========================================

/**
 * Rangos de percentiles para segmentación
 * Los clientes se clasifican según su posición en el ranking
 */
const PERCENTILE_SEGMENTS = [
  { segment: 'campeones', label: 'Campeones', min: 95, max: 100, description: 'Top 5%' },
  { segment: 'leales', label: 'Leales', min: 85, max: 95, description: 'Top 5-15%' },
  { segment: 'alto_potencial', label: 'Alto potencial', min: 70, max: 85, description: 'Top 15-30%' },
  { segment: 'necesitan_incentivo', label: 'Necesitan incentivo', min: 50, max: 70, description: 'Top 30-50%' },
  { segment: 'no_pueden_perder', label: 'No se pueden perder', min: 35, max: 50, description: 'Top 50-65%' },
  { segment: 'en_riesgo', label: 'En riesgo', min: 20, max: 35, description: 'Top 65-80%' },
  { segment: 'por_perder', label: 'Por perder', min: 5, max: 20, description: 'Top 80-95%' },
  { segment: 'perdidos', label: 'Perdidos', min: 0, max: 5, description: 'Bottom 5%' },
];

/**
 * Determina el segmento de un cliente basándose en su percentil
 * @param {number} percentile - Percentil del cliente (0-100)
 * @returns {string} Nombre del segmento
 */
function getSegmentByPercentile(percentile) {
  for (const seg of PERCENTILE_SEGMENTS) {
    if (percentile >= seg.min && percentile < seg.max) {
      return seg.segment;
    }
  }
  // Top 100% = campeones
  if (percentile >= 100) return 'campeones';
  return 'perdidos';
}

/**
 * Calcula segmentos por total_spent (Top Gastadores)
 * @returns {Promise<Object>} { counts, customers }
 */
async function getSegmentsByTotalSpent() {
  // Obtener clientes con compras, ordenados por total_spent DESC
  const { rows: customers } = await pool.query(`
    SELECT id, tn_customer_id, name, email, phone,
           orders_count, total_spent, first_order_at, last_order_at,
           avg_order_value, segment as rfm_segment
    FROM customers
    WHERE orders_count > 0 AND total_spent > 0
    ORDER BY total_spent DESC
  `);

  const total = customers.length;
  if (total === 0) {
    return { counts: {}, customers: [] };
  }

  // Asignar segmento por percentil
  const counts = {};
  const customersWithSegment = customers.map((c, index) => {
    // Posición 0 = top, posición total-1 = bottom
    // Percentil = (total - position) / total * 100
    const percentile = ((total - index) / total) * 100;
    const segment = getSegmentByPercentile(percentile);

    counts[segment] = (counts[segment] || 0) + 1;

    return {
      ...c,
      segment,
      percentile: Math.round(percentile * 100) / 100
    };
  });

  return { counts, customers: customersWithSegment, total };
}

/**
 * Calcula segmentos por orders_count (Top Compradores)
 * @returns {Promise<Object>} { counts, customers }
 */
async function getSegmentsByOrdersCount() {
  // Obtener clientes con compras, ordenados por orders_count DESC
  const { rows: customers } = await pool.query(`
    SELECT id, tn_customer_id, name, email, phone,
           orders_count, total_spent, first_order_at, last_order_at,
           avg_order_value, segment as rfm_segment
    FROM customers
    WHERE orders_count > 0
    ORDER BY orders_count DESC, total_spent DESC
  `);

  const total = customers.length;
  if (total === 0) {
    return { counts: {}, customers: [] };
  }

  // Asignar segmento por percentil
  const counts = {};
  const customersWithSegment = customers.map((c, index) => {
    const percentile = ((total - index) / total) * 100;
    const segment = getSegmentByPercentile(percentile);

    counts[segment] = (counts[segment] || 0) + 1;

    return {
      ...c,
      segment,
      percentile: Math.round(percentile * 100) / 100
    };
  });

  return { counts, customers: customersWithSegment, total };
}

/**
 * Obtener conteos y definiciones por modo
 * @param {string} mode - 'lifecycle' | 'top_spenders' | 'top_buyers'
 * @returns {Promise<Object>} { counts, definitions }
 */
async function getSegmentCountsByMode(mode) {
  if (mode === 'top_spenders') {
    const result = await getSegmentsByTotalSpent();
    return {
      counts: result.counts,
      definitions: PERCENTILE_SEGMENTS.map(s => ({
        segment: s.segment,
        label: s.label,
        description: s.description
      }))
    };
  }

  if (mode === 'top_buyers') {
    const result = await getSegmentsByOrdersCount();
    return {
      counts: result.counts,
      definitions: PERCENTILE_SEGMENTS.map(s => ({
        segment: s.segment,
        label: s.label,
        description: s.description
      }))
    };
  }

  // Default: lifecycle (RFM)
  const counts = await getSegmentCounts();
  const definitions = getSegmentDefinitions();
  return { counts, definitions };
}

/**
 * Obtener clientes por segmento y modo
 * @param {string} segment - Nombre del segmento
 * @param {string} mode - 'lifecycle' | 'top_spenders' | 'top_buyers'
 * @param {Object} options - { page, limit, search, sortBy, sortDir }
 * @returns {Promise<Object>} { customers, total, page, limit }
 */
async function getCustomersBySegmentAndMode(segment, mode, options = {}) {
  const { page = 1, limit = 50, search = null, sortBy = 'total_spent', sortDir = 'desc' } = options;

  if (mode === 'lifecycle') {
    // Usar la función existente para RFM
    return getCustomersBySegment(segment, { page, limit });
  }

  // Para percentile modes, calcular todo y filtrar
  const result = mode === 'top_spenders'
    ? await getSegmentsByTotalSpent()
    : await getSegmentsByOrdersCount();

  let filtered = segment
    ? result.customers.filter(c => c.segment === segment)
    : result.customers;

  // Aplicar búsqueda si existe
  if (search) {
    const searchLower = search.toLowerCase();
    filtered = filtered.filter(c =>
      (c.name && c.name.toLowerCase().includes(searchLower)) ||
      (c.email && c.email.toLowerCase().includes(searchLower))
    );
  }

  // Ordenar
  const sortMultiplier = sortDir === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    const aVal = a[sortBy] ?? 0;
    const bVal = b[sortBy] ?? 0;
    if (typeof aVal === 'string') {
      return sortMultiplier * aVal.localeCompare(bVal);
    }
    return sortMultiplier * (aVal - bVal);
  });

  const total = filtered.length;
  const offset = (page - 1) * limit;
  const paginated = filtered.slice(offset, offset + limit);

  return {
    customers: paginated,
    total,
    page,
    limit
  };
}

module.exports = {
  SEGMENT_RULES,
  PERCENTILE_SEGMENTS,
  determineSegment,
  segmentAllCustomers,
  segmentCustomer,
  getSegmentCounts,
  getCustomersBySegment,
  getSegmentDefinitions,
  getSegmentCountsByMode,
  getCustomersBySegmentAndMode,
  getSegmentsByTotalSpent,
  getSegmentsByOrdersCount
};
