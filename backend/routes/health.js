/**
 * Health Check Routes
 *
 * /health - Public liveness check
 * /health/deep - Authenticated deep check of all services
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { getPoolStats } = require('../db');
const { getRedisClient, isRedisConnected } = require('../lib/redis');
const { getQueueStats } = require('../lib/queues');
const { getBreakerStatus } = require('../lib/circuitBreaker');
const { authenticate, requirePermission } = require('../middleware/auth');
const axios = require('axios');

// ─── Helpers ─────────────────────────────────────────────

async function checkServiceWithTimeout(name, checkFn, timeoutMs = 5000) {
  const start = Date.now();
  try {
    await Promise.race([
      checkFn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);
    return {
      name,
      status: 'healthy',
      latency_ms: Date.now() - start,
      last_error: null,
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    const latency = Date.now() - start;
    return {
      name,
      status: latency >= timeoutMs ? 'degraded' : 'down',
      latency_ms: latency,
      last_error: error.message,
      checked_at: new Date().toISOString()
    };
  }
}

// ─── GET /health ─────────────────────────────────────────
// Public liveness check - no auth required

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ─── GET /health/deep ────────────────────────────────────
// Deep check of all services - requires auth

router.get('/deep', authenticate, requirePermission('integrations.view'), async (req, res) => {
  try {
    const { healthCheck: storageHealthCheck } = require('../lib/storage');

    const services = await Promise.all([
      // 1. Database
      checkServiceWithTimeout('Database', async () => {
        const result = await pool.query('SELECT 1 as ok');
        if (result.rows[0]?.ok !== 1) throw new Error('Query failed');
      }),

      // 2. Redis
      checkServiceWithTimeout('Redis', async () => {
        const client = getRedisClient();
        if (!client) throw new Error('Redis not configured');
        const pong = await client.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected response: ${pong}`);
      }),

      // 3. Storage (GCS)
      checkServiceWithTimeout('Storage', async () => {
        await storageHealthCheck();
      }),

      // 4. TiendaNube
      checkServiceWithTimeout('TiendaNube', async () => {
        const storeId = process.env.TIENDANUBE_STORE_ID;
        const token = process.env.TIENDANUBE_ACCESS_TOKEN;
        if (!storeId || !token) throw new Error('Credentials not configured');
        const r = await axios.get(`https://api.tiendanube.com/v1/${storeId}/store`, {
          headers: {
            'Authentication': `bearer ${token}`,
            'User-Agent': 'CRM Health Check'
          },
          timeout: 5000
        });
        if (!r.data?.id) throw new Error('Invalid response');
      }),

      // 5. Botmaker
      checkServiceWithTimeout('Botmaker', async () => {
        const token = process.env.BOTMAKER_ACCESS_TOKEN;
        if (!token) throw new Error('Token not configured');
        const r = await axios.get('https://api.botmaker.com/v2.0/intents/', {
          headers: { 'access-token': token },
          timeout: 5000
        });
        if (!r.data) throw new Error('Invalid response');
      }),

      // 6. Claude Vision (Anthropic)
      checkServiceWithTimeout('Claude Vision', async () => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('API key not configured');
      })
    ]);

    // Gather additional info
    const [poolStats, queueStats, breakerStatus] = await Promise.all([
      Promise.resolve(getPoolStats()),
      getQueueStats().catch(() => ({})),
      Promise.resolve(getBreakerStatus())
    ]);

    const memUsage = process.memoryUsage();

    const allHealthy = services.every(s => s.status === 'healthy');
    const anyDown = services.some(s => s.status === 'down');

    res.json({
      status: anyDown ? 'down' : allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services,
      pool_stats: poolStats,
      queue_stats: queueStats,
      circuit_breakers: breakerStatus,
      redis_connected: isRedisConnected(),
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
    console.error('[Health] Deep check error:', error.message);
    res.status(500).json({ error: 'Error running deep health check' });
  }
});

module.exports = router;
