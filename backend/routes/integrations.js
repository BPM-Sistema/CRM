/**
 * Integration Config Routes
 *
 * Endpoints para gestionar feature flags de integraciones
 * desde el panel de administración.
 */

const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const {
  getAllConfigs,
  updateConfig,
  getConfigHistory,
  getCacheStatus,
  invalidateCache
} = require('../services/integrationConfig');

// ─── Middleware de autenticación ──────────────────────────

router.use(authenticate);

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
