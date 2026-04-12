/**
 * Integration Config Routes
 *
 * Endpoints para gestionar feature flags de integraciones
 * desde el panel de administración.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authenticate, requirePermission } = require('../middleware/auth');
const {
  getAllConfigs,
  updateConfig,
  updateConfigMetadata,
  getConfigHistory,
  getCacheStatus,
  invalidateCache,
  whatsapp: waConfig
} = require('../services/integrationConfig');
const { getPlantillaTipos, getPlantillaFinal, clearCache } = require('../lib/plantilla-resolver');
const { getConfigKey } = require('../lib/whatsapp-helpers');
const pool = require('../db');
const { healthCheck: storageHealthCheck } = require('../lib/storage');

// ─── Health Check Helpers ────────────────────────────────

async function checkService(name, checkFn) {
  const start = Date.now();
  try {
    await checkFn();
    return {
      name,
      status: 'ok',
      latency: Date.now() - start
    };
  } catch (error) {
    return {
      name,
      status: 'error',
      latency: Date.now() - start,
      error: error.message
    };
  }
}

async function checkAllServices() {
  const checks = await Promise.all([
    // 1. Tiendanube API
    checkService('Tiendanube API', async () => {
      const storeId = process.env.TIENDANUBE_STORE_ID;
      const token = process.env.TIENDANUBE_ACCESS_TOKEN;
      if (!storeId || !token) throw new Error('Credenciales no configuradas');

      const res = await axios.get(`https://api.tiendanube.com/v1/${storeId}/store`, {
        headers: {
          'Authentication': `bearer ${token}`,
          'User-Agent': 'BPM Health Check'
        },
        timeout: 5000
      });
      if (!res.data?.id) throw new Error('Respuesta inválida');
    }),

    // 2. PostgreSQL Database
    checkService('Base de Datos', async () => {
      const result = await pool.query('SELECT 1 as ok');
      if (result.rows[0]?.ok !== 1) throw new Error('Query falló');
    }),

    // 3. Storage (GCS)
    checkService('Storage', async () => {
      await storageHealthCheck();
    }),

    // 4. Botmaker (WhatsApp)
    checkService('Botmaker (WhatsApp)', async () => {
      const token = process.env.BOTMAKER_ACCESS_TOKEN;
      if (!token) throw new Error('Token no configurado');
      const channelId = await waConfig.getChannelId();
      if (!channelId) throw new Error('Channel ID no configurado');
    }),

    // 5. Claude Vision (OCR) - Anthropic API
    checkService('Claude Vision (OCR)', async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('API key no configurada');

      const res = await axios.get('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 5000
      });
      if (!res.data) throw new Error('Respuesta inválida');
    }),

    // 6. Sentry
    checkService('Sentry', async () => {
      const dsn = process.env.SENTRY_DSN;
      if (!dsn) throw new Error('DSN no configurado');
      // Sentry doesn't have a simple ping - just verify config
    }),

  ]);

  return checks;
}

// ─── Middleware de autenticación ──────────────────────────

router.use(authenticate);

// ─── GET /integrations/plantillas ─────────────────────────
// Obtener plantillas resueltas para la financiera default
// Usado por el panel de integraciones para mostrar qué plantilla usa cada toggle

router.get('/plantillas', requirePermission('integrations.view'), async (req, res) => {
  try {
    // Get all template types from catalog
    const tipos = await getPlantillaTipos();

    // Resolve each template to its final Botmaker name
    const plantillas = await Promise.all(
      tipos.map(async (tipo) => {
        const resolved = await getPlantillaFinal(tipo.key);
        return {
          key: tipo.key,
          nombre: tipo.nombre,
          descripcion: tipo.descripcion,
          requiere_variante: tipo.requiere_variante,
          plantilla_default: tipo.plantilla_default,
          plantilla_resuelta: resolved,
          usa_default: resolved === tipo.plantilla_default
        };
      })
    );

    // Create a map for easy lookup by key
    const byKey = {};
    for (const p of plantillas) {
      byKey[p.key] = p;
    }

    res.json({
      ok: true,
      plantillas,
      byKey
    });

  } catch (error) {
    console.error('❌ GET /integrations/plantillas error:', error.message);
    res.status(500).json({ error: 'Error obteniendo plantillas' });
  }
});

// ─── GET /integrations/health ────────────────────────────
// Health check de todas las conexiones externas

router.get('/health', requirePermission('integrations.view'), async (req, res) => {
  try {
    const services = await checkAllServices();

    const allOk = services.every(s => s.status === 'ok');
    const totalLatency = services.reduce((sum, s) => sum + s.latency, 0);

    res.json({
      status: allOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      totalLatency,
      services
    });

  } catch (error) {
    console.error('❌ GET /integrations/health error:', error.message);
    res.status(500).json({ error: 'Error verificando conexiones' });
  }
});

// ─── GET /integrations ────────────────────────────────────
// Obtener todas las configuraciones de integraciones

router.get('/', requirePermission('integrations.view'), async (req, res) => {
  try {
    const configs = await getAllConfigs();

    // Agrupar por categoría
    const grouped = {};
    for (const config of configs) {
      const category = config.category || 'general';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(config);
    }

    res.json({
      configs,
      grouped,
      cache: getCacheStatus()
    });

  } catch (error) {
    console.error('❌ GET /integrations error:', error.message);
    res.status(500).json({ error: 'Error obteniendo configuraciones' });
  }
});

// ─── PATCH /integrations/:key ─────────────────────────────
// Actualizar una configuración

router.patch('/:key', requirePermission('integrations.update'), async (req, res) => {
  try {
    const { key } = req.params;
    const { enabled, reason } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'El campo "enabled" debe ser un booleano' });
    }

    const updated = await updateConfig(key, enabled, req.user.id, reason);

    res.json({
      success: true,
      config: updated,
      message: `Configuración '${key}' ${enabled ? 'habilitada' : 'deshabilitada'}`
    });

  } catch (error) {
    console.error('❌ PATCH /integrations/:key error:', error.message);

    if (error.message.includes('no encontrada')) {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({ error: 'Error actualizando configuración' });
  }
});

// ─── PATCH /integrations/:key/metadata ────────────────────
// Actualizar metadata de una configuración (ej: teléfono de testing)

router.patch('/:key/metadata', requirePermission('integrations.update'), async (req, res) => {
  try {
    const { key } = req.params;
    const { metadata } = req.body;

    if (!metadata || typeof metadata !== 'object') {
      return res.status(400).json({ error: 'El campo "metadata" debe ser un objeto' });
    }

    const updated = await updateConfigMetadata(key, metadata, req.user.id);

    res.json({
      success: true,
      config: updated,
      message: `Metadata de '${key}' actualizado`
    });

  } catch (error) {
    console.error('❌ PATCH /integrations/:key/metadata error:', error.message);
    if (error.message.includes('no encontrada')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Error actualizando metadata' });
  }
});

// ─── GET /integrations/plantilla-tipos ────────────────────
// Listar todos los tipos de plantilla (catálogo)

router.get('/plantilla-tipos', requirePermission('integrations.view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, key, nombre, descripcion, requiere_variante, plantilla_default, created_at
      FROM plantilla_tipos
      ORDER BY id
    `);

    res.json({
      ok: true,
      tipos: result.rows
    });

  } catch (error) {
    console.error('❌ GET /integrations/plantilla-tipos error:', error.message);
    res.status(500).json({ error: 'Error obteniendo tipos de plantilla' });
  }
});

// ─── POST /integrations/plantilla-tipos ───────────────────
// Crear un nuevo tipo de plantilla

router.post('/plantilla-tipos', requirePermission('integrations.update'), async (req, res) => {
  const client = await pool.connect();

  try {
    const { key, nombre, descripcion, requiere_variante, plantilla_default } = req.body;

    // Validaciones
    if (!key || !nombre || !plantilla_default) {
      return res.status(400).json({ error: 'key, nombre y plantilla_default son requeridos' });
    }

    // Validar formato de key (solo lowercase y underscore)
    if (!/^[a-z_]+$/.test(key)) {
      return res.status(400).json({ error: 'key solo puede contener letras minúsculas y guiones bajos' });
    }

    await client.query('BEGIN');

    // 1. Crear el tipo de plantilla
    const result = await client.query(`
      INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, key, nombre, descripcion, requiere_variante, plantilla_default, created_at
    `, [key, nombre, descripcion || null, requiere_variante ?? false, plantilla_default]);

    const nuevoTipo = result.rows[0];

    // 2. Auto-crear el toggle en integration_config
    const configKey = getConfigKey(key);
    await client.query(`
      INSERT INTO integration_config (key, enabled, description, category)
      VALUES ($1, true, $2, 'whatsapp')
      ON CONFLICT (key) DO NOTHING
    `, [configKey, `Enviar WhatsApp: ${nombre}`]);

    await client.query('COMMIT');

    // Limpiar cache del resolver
    clearCache();

    console.log(`📝 Plantilla tipo creado: ${key} (toggle: ${configKey})`);

    res.status(201).json({
      ok: true,
      tipo: nuevoTipo,
      configKey
    });

  } catch (error) {
    await client.query('ROLLBACK');

    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un tipo con esa key' });
    }

    console.error('❌ POST /integrations/plantilla-tipos error:', error.message);
    res.status(500).json({ error: 'Error creando tipo de plantilla' });
  } finally {
    client.release();
  }
});

// ─── PUT /integrations/plantilla-tipos/:id ────────────────
// Actualizar un tipo de plantilla

router.put('/plantilla-tipos/:id', requirePermission('integrations.update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion, plantilla_default } = req.body;

    // No permitir cambiar key (podría romper referencias)
    if (!nombre || !plantilla_default) {
      return res.status(400).json({ error: 'nombre y plantilla_default son requeridos' });
    }

    const result = await pool.query(`
      UPDATE plantilla_tipos
      SET nombre = $1, descripcion = $2, plantilla_default = $3
      WHERE id = $4
      RETURNING id, key, nombre, descripcion, requiere_variante, plantilla_default, created_at
    `, [nombre, descripcion || null, plantilla_default, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tipo de plantilla no encontrado' });
    }

    // Limpiar cache del resolver
    clearCache();

    console.log(`📝 Plantilla tipo actualizado: ${result.rows[0].key}`);

    res.json({
      ok: true,
      tipo: result.rows[0]
    });

  } catch (error) {
    console.error('❌ PUT /integrations/plantilla-tipos/:id error:', error.message);
    res.status(500).json({ error: 'Error actualizando tipo de plantilla' });
  }
});

// ─── DELETE /integrations/plantilla-tipos/:id ─────────────
// Eliminar un tipo de plantilla

router.delete('/plantilla-tipos/:id', requirePermission('integrations.update'), async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que no tenga mapeos en financiera_plantillas
    const mappings = await pool.query(
      'SELECT COUNT(*) as count FROM financiera_plantillas WHERE plantilla_tipo_id = $1',
      [id]
    );

    if (parseInt(mappings.rows[0].count) > 0) {
      return res.status(409).json({
        error: 'No se puede eliminar: tiene mapeos de financieras asociados',
        mappings_count: parseInt(mappings.rows[0].count)
      });
    }

    // Obtener key antes de eliminar para limpiar el toggle
    const tipo = await pool.query('SELECT key FROM plantilla_tipos WHERE id = $1', [id]);
    if (tipo.rowCount === 0) {
      return res.status(404).json({ error: 'Tipo de plantilla no encontrado' });
    }

    const tipoKey = tipo.rows[0].key;

    // Eliminar el tipo
    await pool.query('DELETE FROM plantilla_tipos WHERE id = $1', [id]);

    // Eliminar el toggle asociado
    const configKey = getConfigKey(tipoKey);
    await pool.query('DELETE FROM integration_config WHERE key = $1', [configKey]);

    // Limpiar cache del resolver
    clearCache();

    console.log(`🗑️ Plantilla tipo eliminado: ${tipoKey}`);

    res.json({
      ok: true,
      message: `Tipo "${tipoKey}" eliminado correctamente`
    });

  } catch (error) {
    console.error('❌ DELETE /integrations/plantilla-tipos/:id error:', error.message);
    res.status(500).json({ error: 'Error eliminando tipo de plantilla' });
  }
});

// ─── GET /integrations/history ────────────────────────────
// Obtener historial de cambios (todas las configs)

router.get('/history', requirePermission('integrations.view'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const history = await getConfigHistory(null, limit);

    res.json({ history });

  } catch (error) {
    console.error('❌ GET /integrations/history error:', error.message);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// ─── GET /integrations/:key/history ───────────────────────
// Obtener historial de cambios de una config específica

router.get('/:key/history', requirePermission('integrations.view'), async (req, res) => {
  try {
    const { key } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const history = await getConfigHistory(key, limit);

    res.json({ history });

  } catch (error) {
    console.error('❌ GET /integrations/:key/history error:', error.message);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// ─── POST /integrations/cache/invalidate ──────────────────
// Forzar recarga del cache (debug/admin)

router.post('/cache/invalidate', requirePermission('integrations.update'), async (req, res) => {
  try {
    await invalidateCache();
    res.json({
      success: true,
      message: 'Cache invalidado',
      cache: getCacheStatus()
    });

  } catch (error) {
    console.error('❌ POST /integrations/cache/invalidate error:', error.message);
    res.status(500).json({ error: 'Error invalidando cache' });
  }
});

module.exports = router;
