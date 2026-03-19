/**
 * Admin Status Routes
 *
 * /admin/status/overview - High-level system status
 * /admin/status/incidents - Recent problems timeline
 * /admin/status/queues - Queue details with failed jobs
 * /admin/status/retry-failed/:queueName - Retry failed jobs
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { getPoolStats } = require('../db');
const { getRedisClient, isRedisConnected } = require('../lib/redis');
const { queues, getQueueStats, QUEUE_NAMES } = require('../lib/queues');
const { getBreakerStatus } = require('../lib/circuitBreaker');
const { authenticate, requirePermission } = require('../middleware/auth');
const axios = require('axios');

// All routes require authentication
router.use(authenticate);

// ─── Helpers ─────────────────────────────────────────────

async function checkServiceQuick(name, checkFn) {
  const start = Date.now();
  try {
    await Promise.race([
      checkFn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    return { name, status: 'healthy', latency_ms: Date.now() - start };
  } catch (error) {
    return { name, status: 'down', latency_ms: Date.now() - start, error: error.message };
  }
}

// ─── GET /admin/status/overview ──────────────────────────

router.get('/overview', requirePermission('integrations.view'), async (req, res) => {
  try {
    const { healthCheck: storageHealthCheck } = require('../lib/storage');

    // Check all services in parallel
    const [services, queueStats, breakerStatus, poolStats] = await Promise.all([
      Promise.all([
        checkServiceQuick('Database', async () => {
          await pool.query('SELECT 1');
        }),
        checkServiceQuick('Redis', async () => {
          const client = getRedisClient();
          if (!client) throw new Error('Not configured');
          await client.ping();
        }),
        checkServiceQuick('TiendaNube', async () => {
          const storeId = process.env.TIENDANUBE_STORE_ID;
          const token = process.env.TIENDANUBE_ACCESS_TOKEN;
          if (!storeId || !token) throw new Error('Not configured');
          await axios.get(`https://api.tiendanube.com/v1/${storeId}/store`, {
            headers: { 'Authentication': `bearer ${token}`, 'User-Agent': 'CRM Health' },
            timeout: 5000
          });
        }),
        checkServiceQuick('Botmaker', async () => {
          const token = process.env.BOTMAKER_ACCESS_TOKEN;
          if (!token) throw new Error('Not configured');
          await axios.get('https://api.botmaker.com/v2.0/intents/', {
            headers: { 'access-token': token },
            timeout: 5000
          });
        }),
        checkServiceQuick('Claude Vision', async () => {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) throw new Error('API key not configured');
        }),
        checkServiceQuick('Storage', async () => {
          await storageHealthCheck();
        })
      ]),
      getQueueStats().catch(() => ({})),
      Promise.resolve(getBreakerStatus()),
      Promise.resolve(getPoolStats())
    ]);

    // Recent errors count (last hour)
    let recentErrorsCount = 0;
    try {
      const errResult = await pool.query(`
        SELECT COUNT(*) as count FROM logs
        WHERE level = 'error' AND created_at > NOW() - INTERVAL '1 hour'
      `);
      recentErrorsCount = parseInt(errResult.rows[0]?.count || '0', 10);
    } catch {
      // logs table may not exist
    }

    // Active workers (from Redis)
    let activeWorkers = 0;
    const client = getRedisClient();
    if (client) {
      try {
        const keys = await client.keys('bull:*:active');
        for (const key of keys) {
          const count = await client.llen(key);
          activeWorkers += count;
        }
      } catch {
        // ignore
      }
    }

    // Last sync run info
    let lastSyncRun = null;
    try {
      const syncResult = await pool.query(`
        SELECT key, value, updated_at FROM sync_state
        WHERE key IN ('last_order_sync', 'last_image_sync')
        ORDER BY key
      `);
      lastSyncRun = syncResult.rows.reduce((acc, row) => {
        acc[row.key] = { value: row.value, updated_at: row.updated_at };
        return acc;
      }, {});
    } catch {
      // sync_state table may not exist
    }

    // Queue depths
    const queueDepths = {};
    for (const [name, stats] of Object.entries(queueStats)) {
      queueDepths[name] = {
        waiting: stats.waiting || 0,
        active: stats.active || 0,
        failed: stats.failed || 0
      };
    }

    // Overall status
    const allHealthy = services.every(s => s.status === 'healthy');
    const anyDown = services.some(s => s.status === 'down');

    const memUsage = process.memoryUsage();

    res.json({
      overall_status: anyDown ? 'degraded' : allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services,
      queue_depths: queueDepths,
      recent_errors_count: recentErrorsCount,
      active_workers: activeWorkers,
      last_sync: lastSyncRun,
      circuit_breakers: breakerStatus,
      pool_stats: poolStats,
      system: {
        uptime_seconds: Math.floor(process.uptime()),
        memory: {
          rss_mb: Math.round(memUsage.rss / 1024 / 1024),
          heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024)
        },
        node_version: process.version
      }
    });
  } catch (error) {
    console.error('[AdminStatus] overview error:', error.message);
    res.status(500).json({ error: 'Error fetching system overview' });
  }
});

// ─── GET /admin/status/incidents ─────────────────────────

router.get('/incidents', requirePermission('integrations.view'), async (req, res) => {
  try {
    const incidents = [];

    // 1. Failed webhooks (last 24h)
    try {
      const webhookResult = await pool.query(`
        SELECT id, message, created_at FROM logs
        WHERE level = 'error'
          AND message ILIKE '%webhook%'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 20
      `);
      for (const row of webhookResult.rows) {
        incidents.push({
          type: 'webhook_failure',
          severity: 'error',
          message: row.message,
          timestamp: row.created_at
        });
      }
    } catch {
      // logs table may not exist
    }

    // 2. Failed WhatsApp sends (last 24h)
    try {
      const waResult = await pool.query(`
        SELECT id, message, created_at FROM logs
        WHERE level = 'error'
          AND (message ILIKE '%whatsapp%' OR message ILIKE '%botmaker%')
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 20
      `);
      for (const row of waResult.rows) {
        incidents.push({
          type: 'whatsapp_failure',
          severity: 'error',
          message: row.message,
          timestamp: row.created_at
        });
      }
    } catch {
      // logs table may not exist
    }

    // 3. Failed sync items
    try {
      const syncResult = await pool.query(`
        SELECT id, order_number, error_message, updated_at FROM sync_queue
        WHERE status = 'failed'
        ORDER BY updated_at DESC
        LIMIT 20
      `);
      for (const row of syncResult.rows) {
        incidents.push({
          type: 'sync_failure',
          severity: 'warning',
          message: `Sync failed for order ${row.order_number}: ${row.error_message || 'Unknown error'}`,
          timestamp: row.updated_at
        });
      }
    } catch {
      // sync_queue table may not exist
    }

    // 5. Orders with unresolved inconsistencies
    try {
      const inconsResult = await pool.query(`
        SELECT id, order_number, tipo, descripcion, created_at
        FROM order_inconsistencies
        WHERE resuelta = false
        ORDER BY created_at DESC
        LIMIT 20
      `);
      for (const row of inconsResult.rows) {
        incidents.push({
          type: 'order_inconsistency',
          severity: 'warning',
          message: `Inconsistencia en pedido ${row.order_number}: ${row.descripcion}`,
          timestamp: row.created_at
        });
      }
    } catch {
      // table may not exist
    }

    // Sort by timestamp descending
    incidents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      count: incidents.length,
      incidents: incidents.slice(0, 50)
    });
  } catch (error) {
    console.error('[AdminStatus] incidents error:', error.message);
    res.status(500).json({ error: 'Error fetching incidents' });
  }
});

// ─── GET /admin/status/queues ────────────────────────────

router.get('/queues', requirePermission('integrations.view'), async (req, res) => {
  try {
    const result = {};

    for (const name of QUEUE_NAMES) {
      const queue = queues[name];
      if (!queue) {
        result[name] = {
          available: false,
          waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0,
          recent_failures: []
        };
        continue;
      }

      try {
        const [waiting, active, completed, failed, delayed, failedJobs] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
          queue.getFailed(0, 9) // last 10 failed jobs
        ]);

        const recentFailures = failedJobs.map(job => ({
          id: job.id,
          name: job.name,
          error: job.failedReason || 'Unknown error',
          failed_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          attempts: job.attemptsMade
        }));

        result[name] = {
          available: true,
          waiting,
          active,
          completed,
          failed,
          delayed,
          recent_failures: recentFailures
        };
      } catch (err) {
        result[name] = {
          available: false,
          error: err.message,
          waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0,
          recent_failures: []
        };
      }
    }

    res.json({ queues: result });
  } catch (error) {
    console.error('[AdminStatus] queues error:', error.message);
    res.status(500).json({ error: 'Error fetching queue details' });
  }
});

// ─── POST /admin/status/retry-failed/:queueName ─────────

router.post('/retry-failed/:queueName', requirePermission('integrations.update'), async (req, res) => {
  try {
    const { queueName } = req.params;

    if (!QUEUE_NAMES.includes(queueName)) {
      return res.status(400).json({ error: `Queue "${queueName}" not found` });
    }

    const queue = queues[queueName];
    if (!queue) {
      return res.status(400).json({ error: `Queue "${queueName}" is not available (Redis not connected)` });
    }

    const failedJobs = await queue.getFailed(0, 999);
    let retried = 0;

    for (const job of failedJobs) {
      try {
        await job.retry();
        retried++;
      } catch {
        // Job may have been removed or is in an invalid state
      }
    }

    res.json({
      ok: true,
      queue: queueName,
      total_failed: failedJobs.length,
      retried
    });
  } catch (error) {
    console.error('[AdminStatus] retry-failed error:', error.message);
    res.status(500).json({ error: 'Error retrying failed jobs' });
  }
});

// ─── POST /admin/status/reconcile ────────────────────────

router.post('/reconcile', requirePermission('integrations.update'), async (req, res) => {
  try {
    const { runReconciliation } = require('../workers/reconciliation.worker');
    const results = await runReconciliation();
    res.json({
      ok: true,
      ...results,
      message: `Reconciliación completada. ${results.issues.length} problemas encontrados.`
    });
  } catch (error) {
    console.error('Reconciliation error:', error.message);
    res.status(500).json({ error: 'Error ejecutando reconciliación' });
  }
});

// ─── POST /admin/status/dismiss-incidents ────────────────

router.post('/dismiss-incidents', requirePermission('integrations.update'), async (req, res) => {
  try {
    // Marcar comprobantes stuck como "revisados" cambiando a rechazado
    // o simplemente los ignoramos filtrando por fecha más reciente
    const result = await pool.query(`
      UPDATE comprobantes
      SET estado = 'rechazado'
      WHERE estado = 'a_confirmar'
        AND created_at < NOW() - INTERVAL '2 hours'
      RETURNING id
    `);

    res.json({
      ok: true,
      dismissed: result.rowCount,
      message: `${result.rowCount} comprobantes antiguos marcados como rechazados`
    });
  } catch (error) {
    console.error('[AdminStatus] dismiss-incidents error:', error.message);
    res.status(500).json({ error: 'Error limpiando incidentes' });
  }
});

module.exports = router;
