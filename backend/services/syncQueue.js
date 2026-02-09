/**
 * Servicio de Cola de Sincronización
 * Maneja operaciones de cola para sincronización resiliente de pedidos
 */

const pool = require('../db');

/**
 * Agregar item a la cola de sincronización
 */
async function addToQueue({ type, resourceId, orderNumber, payload, maxAttempts = 5 }) {
  try {
    const result = await pool.query(`
      INSERT INTO sync_queue (type, resource_id, order_number, payload, max_attempts, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (type, resource_id, status)
        WHERE status IN ('pending', 'processing')
        DO UPDATE SET
          payload = EXCLUDED.payload
      RETURNING id
    `, [type, resourceId, orderNumber, JSON.stringify(payload), maxAttempts]);

    console.log(`📥 Agregado a cola: ${type} - ${orderNumber || resourceId}`);
    return result.rows[0]?.id;
  } catch (error) {
    // Si falla por constraint único, ya existe un item pendiente
    if (error.code === '23505') {
      console.log(`⏭️ Ya existe en cola: ${type} - ${resourceId}`);
      return null;
    }
    throw error;
  }
}

/**
 * Obtener próximo item pendiente de la cola
 */
async function getNextPending() {
  const result = await pool.query(`
    UPDATE sync_queue
    SET status = 'processing', attempts = attempts + 1
    WHERE id = (
      SELECT id FROM sync_queue
      WHERE status = 'pending'
        AND next_retry_at <= NOW()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return result.rows[0] || null;
}

/**
 * Marcar item como completado
 */
async function markCompleted(id) {
  await pool.query(`
    UPDATE sync_queue
    SET status = 'completed', processed_at = NOW()
    WHERE id = $1
  `, [id]);
  console.log(`✅ Completado en cola: ${id}`);
}

/**
 * Marcar item como fallido (con reintento exponencial)
 */
async function markFailed(id, errorMessage) {
  // Backoff exponencial: 1min, 2min, 4min, 8min, 16min...
  await pool.query(`
    UPDATE sync_queue
    SET
      status = CASE
        WHEN attempts >= max_attempts THEN 'failed'
        ELSE 'pending'
      END,
      last_error = $2,
      next_retry_at = CASE
        WHEN attempts >= max_attempts THEN NULL
        ELSE NOW() + (INTERVAL '1 minute' * POWER(2, attempts - 1))
      END
    WHERE id = $1
  `, [id, errorMessage]);
  console.log(`❌ Falló en cola: ${id} - ${errorMessage}`);
}

/**
 * Obtener estadísticas de la cola
 */
async function getQueueStats() {
  const result = await pool.query(`
    SELECT
      status,
      COUNT(*) as count
    FROM sync_queue
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY status
  `);

  const stats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    total: 0
  };

  result.rows.forEach(row => {
    stats[row.status] = parseInt(row.count);
    stats.total += parseInt(row.count);
  });

  return stats;
}

/**
 * Obtener/actualizar estado de sincronización
 */
async function getSyncState(key) {
  const result = await pool.query(
    'SELECT value FROM sync_state WHERE key = $1',
    [key]
  );
  return result.rows[0]?.value || null;
}

async function updateSyncState(key, value) {
  await pool.query(`
    INSERT INTO sync_state (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = $2,
      updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

/**
 * Limpiar items viejos completados (más de 7 días)
 */
async function cleanupOldItems() {
  const result = await pool.query(`
    DELETE FROM sync_queue
    WHERE status = 'completed'
      AND processed_at < NOW() - INTERVAL '7 days'
  `);
  if (result.rowCount > 0) {
    console.log(`🧹 Limpiados ${result.rowCount} items antiguos de la cola`);
  }
}

module.exports = {
  addToQueue,
  getNextPending,
  markCompleted,
  markFailed,
  getQueueStats,
  getSyncState,
  updateSyncState,
  cleanupOldItems
};
