/**
 * Servicio de Cola de Sincronización
 * Maneja operaciones de cola para sincronización resiliente de pedidos
 */

const pool = require('../db');

/**
 * Agregar item a la cola de sincronización
 */
async function addToQueue({ type, resourceId, orderNumber, payload, maxAttempts = 5 }) {
  console.log(`[QUEUE] Attempting INSERT: type=${type} resourceId=${resourceId}`);
  try {
    const result = await pool.query(`
      INSERT INTO sync_queue (type, resource_id, order_number, payload, max_attempts, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (type, resource_id, status) DO NOTHING
      RETURNING id
    `, [type, resourceId, orderNumber, JSON.stringify(payload), maxAttempts]);

    if (result.rows[0]?.id) {
      console.log(`📥 Agregado a cola: ${type} - ${orderNumber || resourceId}`);
      return result.rows[0].id;
    } else {
      console.log(`⏭️ Ya existe en cola (DO NOTHING): ${type} - ${resourceId}`);
      return null;
    }
  } catch (error) {
    console.log(`[QUEUE] CATCH: type=${type} resourceId=${resourceId} code=${error.code} msg=${error.message}`);
    if (error.code === '23505') {
      console.log(`⏭️ Ya existe en cola (catch 23505): ${type} - ${resourceId}`);
      return null;
    }
    throw error;
  }
}

/**
 * Verificar si hay items pendientes en la cola (sin bloquear)
 */
async function hasPendingItems() {
  const result = await pool.query(`
    SELECT EXISTS(
      SELECT 1 FROM sync_queue
      WHERE status = 'pending' AND next_retry_at <= NOW()
    ) as has_pending
  `);
  return result.rows[0]?.has_pending || false;
}

/**
 * Obtener próximo item pendiente de la cola
 * Maneja conflictos cuando múltiples instancias procesan la misma cola
 */
async function getNextPending(retryCount = 0) {
  const MAX_RETRIES = 3; // Reducido de 5 a 3

  // Verificación rápida antes de intentar actualizar
  if (retryCount === 0) {
    const hasPending = await hasPendingItems();
    if (!hasPending) {
      return null; // No hay items pendientes, salir silenciosamente
    }
  }

  try {
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
  } catch (error) {
    // 23505 = duplicate key - otro worker ya procesando un item con mismo (type, resource_id)
    if (error.code === '23505') {
      if (retryCount < MAX_RETRIES) {
        // Solo loguear en el último intento para reducir ruido
        if (retryCount === MAX_RETRIES - 1) {
          console.log(`⏭️ Conflicto en cola, otro worker procesando...`);
        }
        return getNextPending(retryCount + 1);
      }
      // No loguear warning si simplemente no hay más items disponibles
      return null;
    }
    throw error;
  }
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
  try {
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
  } catch (error) {
    // 23505 = duplicate key - puede pasar si vuelve a pending y ya existe uno pending
    if (error.code === '23505') {
      // Marcar como failed en lugar de pending para evitar conflicto
      await pool.query(`
        UPDATE sync_queue SET status = 'failed', last_error = $2 WHERE id = $1
      `, [id, errorMessage + ' (forzado a failed por conflicto)']);
      console.log(`⚠️ Item ${id} forzado a failed por conflicto de constraint`);
    } else {
      throw error;
    }
  }
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
