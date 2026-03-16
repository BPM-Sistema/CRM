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
  invalidateCache
} = require('../services/integrationConfig');
const pool = require('../db');
const supabase = require('../supabase');

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

    // 3. Supabase Storage
    checkService('Storage', async () => {
      const { data, error } = await supabase.storage.from('comprobantes').list('', { limit: 1 });
      if (error) throw error;
    }),

    // 4. Botmaker (WhatsApp)
    checkService('Botmaker (WhatsApp)', async () => {
      const token = process.env.BOTMAKER_ACCESS_TOKEN;
      if (!token) throw new Error('Token no configurado');

      const res = await axios.get('https://api.botmaker.com/v2.0/bots', {
        headers: { 'access-token': token },
        timeout: 5000
      });
      if (!res.data) throw new Error('Respuesta inválida');
    }),

    // 5. Google Cloud Vision (OCR)
    checkService('Google Vision (OCR)', async () => {
      const credentials = process.env.GOOGLE_CLOUD_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!credentials) throw new Error('Credenciales no configuradas');
      // Just verify credentials exist - actual API call would cost money
    }),

    // 6. Sentry
    checkService('Sentry', async () => {
      const dsn = process.env.SENTRY_DSN;
      if (!dsn) throw new Error('DSN no configurado');
      // Sentry doesn't have a simple ping - just verify config
    }),

    // 7. Waspy API
    checkService('Waspy API', async () => {
      const baseUrl = process.env.WASPY_API_URL;
      if (!baseUrl) throw new Error('URL no configurada');

      const res = await axios.get(`${baseUrl}/health`, { timeout: 5000 });
      if (res.status !== 200) throw new Error(`Status ${res.status}`);
    })
  ]);

  return checks;
}

// ─── Middleware de autenticación ──────────────────────────

router.use(authenticate);

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
