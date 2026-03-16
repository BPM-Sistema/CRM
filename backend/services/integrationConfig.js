/**
 * Integration Config Service
 *
 * Servicio centralizado para gestionar feature flags de integraciones.
 * Implementa cache en memoria con TTL para evitar consultas excesivas a DB.
 *
 * Características:
 * - Cache con TTL configurable (default 30s)
 * - Fallback seguro (enabled=true si falla lectura)
 * - Logging cuando se bloquea una operación
 * - Soporte para master switch (si master off, todo off)
 */

const pool = require('../db');

// ─── Configuración ────────────────────────────────────────

const CACHE_TTL_MS = 30 * 1000; // 30 segundos

// ─── Cache en memoria ─────────────────────────────────────

let configCache = new Map();
let cacheTimestamp = 0;

// ─── Funciones internas ───────────────────────────────────

/**
 * Cargar toda la configuración desde DB
 */
async function loadConfigFromDB() {
  try {
    const result = await pool.query(`
      SELECT key, enabled, description, category, updated_at
      FROM integration_config
    `);

    const newCache = new Map();
    for (const row of result.rows) {
      newCache.set(row.key, {
        enabled: row.enabled,
        description: row.description,
        category: row.category,
        updated_at: row.updated_at
      });
    }

    configCache = newCache;
    cacheTimestamp = Date.now();

    return true;
  } catch (error) {
    console.error('⚠️ [IntegrationConfig] Error cargando config desde DB:', error.message);
    return false;
  }
}

/**
 * Verificar si el cache está vigente
 */
function isCacheValid() {
  return configCache.size > 0 && (Date.now() - cacheTimestamp) < CACHE_TTL_MS;
}

/**
 * Asegurar que el cache esté actualizado
 */
async function ensureCacheLoaded() {
  if (!isCacheValid()) {
    await loadConfigFromDB();
  }
}

// ─── API Pública ──────────────────────────────────────────

/**
 * Verificar si una integración está habilitada
 *
 * @param {string} key - Clave de la configuración (ej: 'tiendanube_webhooks_enabled')
 * @param {object} options - Opciones adicionales
 * @param {boolean} options.logBlocked - Si loguear cuando está bloqueado (default: true)
 * @param {string} options.context - Contexto adicional para el log
 * @returns {Promise<boolean>} - true si está habilitada, false si no
 */
async function isEnabled(key, options = {}) {
  const { logBlocked = true, context = '' } = options;

  try {
    await ensureCacheLoaded();

    // Buscar la config específica
    const config = configCache.get(key);

    // Si no existe, fallback a enabled (no romper producción)
    if (!config) {
      console.warn(`⚠️ [IntegrationConfig] Config '${key}' no encontrada, usando fallback enabled=true`);
      return true;
    }

    if (!config.enabled && logBlocked) {
      console.log(`🚫 [IntegrationConfig] ${key} está deshabilitado${context ? ` (${context})` : ''}`);
    }

    return config.enabled;

  } catch (error) {
    // Error de DB = fallback a enabled (no romper producción)
    console.error(`⚠️ [IntegrationConfig] Error verificando '${key}', usando fallback enabled=true:`, error.message);
    return true;
  }
}

/**
 * Verificar múltiples keys a la vez
 * Útil cuando una operación depende de varias configs
 *
 * @param {string[]} keys - Array de claves a verificar
 * @returns {Promise<boolean>} - true si TODAS están habilitadas
 */
async function areAllEnabled(keys) {
  for (const key of keys) {
    const enabled = await isEnabled(key, { logBlocked: false });
    if (!enabled) {
      console.log(`🚫 [IntegrationConfig] Operación bloqueada por: ${key}`);
      return false;
    }
  }
  return true;
}

/**
 * Obtener todas las configuraciones (para panel admin)
 *
 * @returns {Promise<Array>} - Lista de configuraciones
 */
async function getAllConfigs() {
  try {
    const result = await pool.query(`
      SELECT
        ic.key,
        ic.enabled,
        ic.description,
        ic.category,
        ic.metadata,
        ic.updated_at,
        u.email as updated_by_email
      FROM integration_config ic
      LEFT JOIN users u ON ic.updated_by = u.id
      ORDER BY ic.category, ic.key
    `);

    return result.rows;
  } catch (error) {
    console.error('❌ [IntegrationConfig] Error obteniendo configs:', error.message);
    throw error;
  }
}

/**
 * Actualizar una configuración
 *
 * @param {string} key - Clave de la configuración
 * @param {boolean} enabled - Nuevo valor
 * @param {number} userId - ID del usuario que hace el cambio
 * @param {string} reason - Razón del cambio (opcional)
 * @returns {Promise<object>} - Configuración actualizada
 */
async function updateConfig(key, enabled, userId, reason = null) {
  try {
    // Actualizar en DB
    const result = await pool.query(`
      UPDATE integration_config
      SET enabled = $1, updated_by = $2
      WHERE key = $3
      RETURNING key, enabled, description, category, updated_at
    `, [enabled, userId, key]);

    if (result.rowCount === 0) {
      throw new Error(`Configuración '${key}' no encontrada`);
    }

    // Invalidar cache
    cacheTimestamp = 0;

    // Log del cambio
    const action = enabled ? 'HABILITADO' : 'DESHABILITADO';
    console.log(`🔧 [IntegrationConfig] ${key} ${action} por usuario ${userId}${reason ? ` - Razón: ${reason}` : ''}`);

    // Si hay razón, guardarla en el log
    if (reason) {
      await pool.query(`
        UPDATE integration_config_log
        SET reason = $1
        WHERE config_key = $2
        ORDER BY changed_at DESC
        LIMIT 1
      `, [reason, key]);
    }

    return result.rows[0];

  } catch (error) {
    console.error('❌ [IntegrationConfig] Error actualizando config:', error.message);
    throw error;
  }
}

/**
 * Actualizar metadata de una configuración
 */
async function updateConfigMetadata(key, metadata, userId) {
  try {
    const result = await pool.query(`
      UPDATE integration_config
      SET metadata = $1, updated_by = $2
      WHERE key = $3
      RETURNING key, enabled, description, category, metadata, updated_at
    `, [JSON.stringify(metadata), userId, key]);

    if (result.rowCount === 0) {
      throw new Error(`Configuración '${key}' no encontrada`);
    }

    cacheTimestamp = 0;
    console.log(`🔧 [IntegrationConfig] ${key} metadata actualizado por usuario ${userId}`);
    return result.rows[0];
  } catch (error) {
    console.error('❌ [IntegrationConfig] Error actualizando metadata:', error.message);
    throw error;
  }
}

/**
 * Obtener historial de cambios de una configuración
 *
 * @param {string} key - Clave de la configuración (opcional, null = todas)
 * @param {number} limit - Cantidad máxima de registros
 * @returns {Promise<Array>} - Historial de cambios
 */
async function getConfigHistory(key = null, limit = 50) {
  try {
    let query = `
      SELECT
        cl.config_key,
        cl.old_value,
        cl.new_value,
        cl.reason,
        cl.changed_at,
        u.email as changed_by_email
      FROM integration_config_log cl
      LEFT JOIN users u ON cl.changed_by = u.id
    `;

    const params = [];

    if (key) {
      query += ' WHERE cl.config_key = $1';
      params.push(key);
    }

    query += ' ORDER BY cl.changed_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows;

  } catch (error) {
    console.error('❌ [IntegrationConfig] Error obteniendo historial:', error.message);
    throw error;
  }
}

/**
 * Forzar recarga del cache
 */
async function invalidateCache() {
  cacheTimestamp = 0;
  await ensureCacheLoaded();
}

/**
 * Obtener estado del cache (para debugging)
 */
function getCacheStatus() {
  return {
    size: configCache.size,
    age_ms: Date.now() - cacheTimestamp,
    valid: isCacheValid(),
    ttl_ms: CACHE_TTL_MS
  };
}

// ─── Helpers para Tiendanube ──────────────────────────────

/**
 * Helpers específicos para Tiendanube
 * Hacen el código más legible en los puntos de uso
 */
const tiendanube = {
  async areWebhooksEnabled() {
    return isEnabled('tiendanube_webhooks_enabled', { context: 'webhook' });
  },

  async isValidateOrdersEnabled() {
    return isEnabled('tiendanube_validate_orders', { context: 'validate-order' });
  },

  async isFulfillmentEnabled() {
    return isEnabled('tiendanube_fulfillment_labels', { context: 'fulfillment' });
  },

  async isSyncOrdersEnabled() {
    return isEnabled('tiendanube_sync_orders', { context: 'sync-orders' });
  },

  async isSyncImagesEnabled() {
    return isEnabled('tiendanube_sync_images', { context: 'sync-images' });
  },

  async isResyncManualEnabled() {
    return isEnabled('tiendanube_resync_manual', { context: 'resync-manual' });
  },

  async isSyncCancelledEnabled() {
    return isEnabled('tiendanube_sync_cancelled', { context: 'sync-cancelled' });
  },

  async isMarkPaidEnabled() {
    return isEnabled('tiendanube_mark_paid', { context: 'mark-paid' });
  }
};

// ─── Exports ──────────────────────────────────────────────

module.exports = {
  // Core API
  isEnabled,
  areAllEnabled,
  getAllConfigs,
  updateConfig,
  updateConfigMetadata,
  getConfigHistory,

  // Cache management
  invalidateCache,
  getCacheStatus,

  // Tiendanube helpers
  tiendanube,

  // Constants
  CACHE_TTL_MS
};
