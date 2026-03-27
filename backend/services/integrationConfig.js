/**
 * Integration Config Service
 *
 * Servicio centralizado para gestionar feature flags de integraciones.
 * Usa Redis como cache compartido entre todas las instancias de Cloud Run.
 * Fallback a memoria local si Redis no está disponible.
 *
 * Características:
 * - Cache en Redis compartido (todas las instancias ven el mismo valor)
 * - Fallback a memoria local si Redis falla
 * - TTL configurable (default 60s)
 * - Invalidación automática al actualizar config
 */

const pool = require('../db');
const { getRedisClient } = require('../lib/redis');

// ─── Configuración ────────────────────────────────────────

const CACHE_TTL_MS = 60 * 1000; // 60 segundos
const REDIS_CACHE_KEY = 'integration_config:all';
const REDIS_TTL_SECONDS = 60;

// ─── Cache en memoria (fallback) ──────────────────────────

let memoryCache = new Map();
let memoryCacheTimestamp = 0;

// ─── Funciones internas ───────────────────────────────────

/**
 * Asegurar que configs críticas existan (auto-migración)
 */
async function ensureCriticalConfigs() {
  try {
    await pool.query(`
      INSERT INTO integration_config (key, enabled, description, category, metadata)
      VALUES (
        'botmaker_channel',
        true,
        'Canal de WhatsApp Business (número desde el cual se envían mensajes)',
        'whatsapp',
        '{"channel_id": "blanqueriaxmayor-whatsapp-5491136914124"}'
      )
      ON CONFLICT (key) DO NOTHING
    `);
  } catch (err) {
    console.warn('[IntegrationConfig] Error en auto-migración:', err.message);
  }
}

/**
 * Cargar toda la configuración desde DB
 */
async function loadConfigFromDB() {
  try {
    // Auto-migrar configs críticas si no existen
    await ensureCriticalConfigs();

    const result = await pool.query(`
      SELECT key, enabled, description, category, metadata, updated_at
      FROM integration_config
    `);

    const configMap = {};
    for (const row of result.rows) {
      configMap[row.key] = {
        enabled: row.enabled,
        description: row.description,
        category: row.category,
        metadata: row.metadata,
        updated_at: row.updated_at
      };
    }

    // Intentar guardar en Redis
    const redis = getRedisClient();
    if (redis) {
      try {
        await redis.setex(REDIS_CACHE_KEY, REDIS_TTL_SECONDS, JSON.stringify(configMap));
        console.log('[IntegrationConfig] Cache guardado en Redis');
      } catch (redisErr) {
        console.warn('[IntegrationConfig] No se pudo guardar en Redis:', redisErr.message);
      }
    }

    // También guardar en memoria como fallback
    memoryCache = new Map(Object.entries(configMap));
    memoryCacheTimestamp = Date.now();

    return configMap;
  } catch (error) {
    console.error('⚠️ [IntegrationConfig] Error cargando config desde DB:', error.message);
    return null;
  }
}

/**
 * Obtener config desde Redis o memoria
 */
async function getConfigFromCache() {
  // 1. Intentar Redis primero
  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get(REDIS_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (redisErr) {
      console.warn('[IntegrationConfig] Error leyendo Redis:', redisErr.message);
    }
  }

  // 2. Fallback a memoria local
  if (memoryCache.size > 0 && (Date.now() - memoryCacheTimestamp) < CACHE_TTL_MS) {
    return Object.fromEntries(memoryCache);
  }

  return null;
}

/**
 * Asegurar que el cache esté actualizado
 * Retorna el objeto de config o null si falla
 */
async function ensureCacheLoaded() {
  // Primero intentar cache
  let config = await getConfigFromCache();
  if (config) {
    return config;
  }

  // Si no hay cache, cargar desde DB
  config = await loadConfigFromDB();
  return config;
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
    const allConfig = await ensureCacheLoaded();

    // Si no se pudo cargar nada, fallback a enabled
    if (!allConfig) {
      console.warn(`⚠️ [IntegrationConfig] No se pudo cargar config, usando fallback enabled=true`);
      return true;
    }

    // Buscar la config específica
    const config = allConfig[key];

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
 * Invalidar cache en Redis y memoria
 */
async function invalidateCacheInternal() {
  // Invalidar Redis
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(REDIS_CACHE_KEY);
      console.log('[IntegrationConfig] Cache Redis invalidado');
    } catch (redisErr) {
      console.warn('[IntegrationConfig] Error invalidando Redis:', redisErr.message);
    }
  }

  // Invalidar memoria local
  memoryCacheTimestamp = 0;
  memoryCache.clear();
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

    // Invalidar cache en Redis y memoria
    await invalidateCacheInternal();

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

    // Invalidar cache en Redis y memoria
    await invalidateCacheInternal();

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
  await invalidateCacheInternal();
  await loadConfigFromDB();
}

/**
 * Obtener estado del cache (para debugging)
 */
async function getCacheStatus() {
  const redis = getRedisClient();
  let redisStatus = 'disconnected';
  let redisTTL = -1;

  if (redis) {
    try {
      redisTTL = await redis.ttl(REDIS_CACHE_KEY);
      redisStatus = redisTTL > 0 ? 'active' : 'expired';
    } catch (e) {
      redisStatus = 'error';
    }
  }

  return {
    redis: {
      status: redisStatus,
      ttl_seconds: redisTTL
    },
    memory: {
      size: memoryCache.size,
      age_ms: Date.now() - memoryCacheTimestamp,
      valid: memoryCache.size > 0 && (Date.now() - memoryCacheTimestamp) < CACHE_TTL_MS
    },
    ttl_ms: CACHE_TTL_MS
  };
}

/**
 * Obtener config completa con metadata (para configs que necesitan más que enabled/disabled)
 */
async function getConfigWithMetadata(key) {
  try {
    const allConfig = await ensureCacheLoaded();
    if (!allConfig) return null;
    return allConfig[key] || null;
  } catch (error) {
    console.error(`⚠️ [IntegrationConfig] Error obteniendo config '${key}':`, error.message);
    return null;
  }
}

// ─── Helpers para WhatsApp ────────────────────────────────

const whatsapp = {
  async getTestingConfig() {
    const config = await getConfigWithMetadata('whatsapp_testing_mode');
    if (!config) return null;
    return {
      enabled: config.enabled,
      testingPhone: config.metadata?.active_phone || config.metadata?.testing_phone || null
    };
  },

  /**
   * Obtener el channelId de Botmaker desde config
   * Fallback a process.env si no está configurado
   */
  async getChannelId() {
    try {
      const config = await getConfigWithMetadata('botmaker_channel');
      const channelId = config?.metadata?.channel_id;
      if (channelId) {
        return channelId;
      }
    } catch (err) {
      console.warn('[IntegrationConfig] Error obteniendo botmaker_channel:', err.message);
    }
    // Fallback a env var
    return process.env.BOTMAKER_CHANNEL_ID;
  }
};

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
  getConfigWithMetadata,

  // Cache management
  invalidateCache,
  getCacheStatus,

  // Integration helpers
  tiendanube,
  whatsapp,

  // Constants
  CACHE_TTL_MS
};
