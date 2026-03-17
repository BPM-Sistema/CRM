/**
 * AI Bot Routes
 *
 * SECTION 1: Public endpoints (NO auth)
 *   POST /webhooks/meta - Receive Meta webhook events
 *   GET  /webhooks/meta - Meta verification challenge
 *   GET  /health        - Internal health check
 *
 * SECTION 2: Authenticated admin endpoints
 *   GET    /dashboard        - Dashboard stats
 *   GET    /config           - All config
 *   PUT    /config/:key      - Update config
 *   GET    /events           - Paginated events
 *   GET    /events/:id       - Single event detail
 *   POST   /events/:id/approve - Approve pending reply
 *   POST   /events/:id/reject  - Reject pending reply
 *   GET    /replies          - Paginated replies
 *   GET    /failures         - Paginated failures
 *   POST   /failures/:id/resolve - Resolve a failure
 *   GET    /metrics          - Aggregated metrics
 *   GET    /system-prompt    - Current system prompt
 *   PUT    /system-prompt    - Update system prompt
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { apiLogger: log } = require('../lib/logger');
const { metaEventsQueue } = require('../lib/queues');
const { dedupEvent } = require('../lib/ai-bot/redis-utils');
const { getRedisClient } = require('../lib/redis');
const { verifyWebhookSignature } = require('../lib/ai-bot/meta-client');

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Public webhook endpoints (NO auth)
// ═══════════════════════════════════════════════════════════════

// ─── GET /webhooks/meta ─────────────────────────────────────
// Meta verification challenge
router.get('/webhooks/meta', (req, res) => {
  const requestId = crypto.randomUUID();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  log.info({ requestId, mode, tokenReceived: !!token }, 'Meta webhook verification request');

  if (mode !== 'subscribe') {
    log.warn({ requestId, mode }, 'Meta verification: invalid mode');
    return res.status(403).send('Invalid mode');
  }

  const expectedToken = process.env.META_VERIFY_TOKEN;
  if (!expectedToken) {
    log.error({ requestId }, 'META_VERIFY_TOKEN not configured');
    return res.status(500).send('Server misconfigured');
  }

  if (token !== expectedToken) {
    log.warn({ requestId }, 'Meta verification: token mismatch');
    return res.status(403).send('Token mismatch');
  }

  log.info({ requestId }, 'Meta webhook verified successfully');
  return res.status(200).send(parseInt(challenge, 10));
});

// ─── POST /webhooks/meta ────────────────────────────────────
// Receives Meta webhook events (Instagram + Facebook)
// FLOW: verify signature → persist to DB → respond 200 → enqueue async
router.post('/webhooks/meta', async (req, res) => {
  const requestId = crypto.randomUUID();

  // 1. Verify webhook signature (if META_APP_SECRET is configured)
  if (process.env.META_APP_SECRET) {
    const sigResult = verifyWebhookSignature(req);
    if (!sigResult.success) {
      log.warn({ requestId, error: sigResult.error?.message }, 'Meta webhook: signature verification failed');
      return res.status(403).json({ error: 'Invalid signature' });
    }
  }

  // 2. Validate payload structure
  const body = req.body;
  if (!body || !body.object || !Array.isArray(body.entry)) {
    log.warn({ requestId, body: JSON.stringify(body).slice(0, 500) }, 'Meta webhook: invalid payload structure');
    return res.status(200).json({ received: true }); // 200 to avoid Meta retries on bad payloads
  }

  const platform = body.object;
  const events = []; // Collect events to persist & enqueue

  // 3. Parse all events from the webhook payload
  for (const entry of body.entry) {
    const entryId = entry.id;
    const entryTime = entry.time;

    if (Array.isArray(entry.messaging)) {
      for (const msg of entry.messaging) {
        const eventId = `${platform}_msg_${entryId}_${msg.timestamp || Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        events.push({
          event_id: eventId,
          platform,
          entry_id: entryId,
          entry_time: entryTime,
          field: 'messages',
          value: msg,
          received_at: new Date().toISOString(),
          request_id: requestId
        });
      }
    }

    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        const field = change.field;
        const supportedFields = ['comments', 'mentions', 'feed', 'messages'];
        if (!supportedFields.includes(field)) continue;

        const eventId = `${platform}_${field}_${entryId}_${entryTime || Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        events.push({
          event_id: eventId,
          platform,
          entry_id: entryId,
          entry_time: entryTime,
          field,
          value: change.value,
          received_at: new Date().toISOString(),
          request_id: requestId
        });
      }
    }
  }

  // 4. Persist ALL events to DB BEFORE responding 200 (prevents event loss if Redis is down)
  let persistedCount = 0;
  for (const evt of events) {
    try {
      await pool.query(
        `INSERT INTO ai_bot_events (event_id, channel, platform, event_type, raw_payload, sender_id, sender_name, content_text, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received', NOW())
         ON CONFLICT (event_id) DO NOTHING`,
        [
          evt.event_id,
          evt.field === 'messages' ? 'messenger' : evt.field === 'comments' ? `${platform}_comment` : evt.field,
          evt.platform,
          evt.field,
          JSON.stringify(evt),
          evt.value?.from?.id || evt.value?.sender?.id || null,
          evt.value?.from?.username || evt.value?.from?.name || null,
          evt.value?.text || evt.value?.message?.text || null
        ]
      );
      persistedCount++;
    } catch (dbErr) {
      log.error({ requestId, eventId: evt.event_id, error: dbErr.message }, 'Failed to persist webhook event to DB');
    }
  }

  // 5. Respond 200 AFTER DB persistence — event is safe now
  res.status(200).json({ received: true, events: persistedCount });

  log.info({ requestId, platform, totalEvents: events.length, persisted: persistedCount }, 'Meta webhook received and persisted');

  // 6. Enqueue to BullMQ for async processing (best-effort — events are safe in DB)
  for (const evt of events) {
    try {
      const isNew = await dedupEvent(evt.event_id);
      if (!isNew) {
        log.info({ requestId, eventId: evt.event_id }, 'Duplicate webhook event in Redis, skipping enqueue');
        continue;
      }

      if (metaEventsQueue) {
        await metaEventsQueue.add('meta-event', { payload: evt, requestId }, { jobId: evt.event_id });
        log.info({ requestId, eventId: evt.event_id, field: evt.field }, 'Meta event enqueued');
      } else {
        log.warn({ requestId, eventId: evt.event_id }, 'Meta events queue not available — event persisted in DB, awaiting manual reprocess');
      }
    } catch (enqueueErr) {
      log.error({ requestId, eventId: evt.event_id, error: enqueueErr.message }, 'Failed to enqueue event — persisted in DB');
    }
  }
});

// ─── GET /health ──────────────────────────────────────────────
// Internal health check (NO auth required)
router.get('/health', async (req, res) => {
  const checks = {};

  // Check Redis
  try {
    const client = getRedisClient();
    if (client) {
      await client.ping();
      checks.redis = 'ok';
    } else {
      checks.redis = 'not_configured';
    }
  } catch (e) {
    checks.redis = 'down';
  }

  // Check DB
  try {
    await pool.query('SELECT 1 FROM ai_bot_config LIMIT 1');
    checks.database = 'ok';
  } catch (e) {
    checks.database = 'down';
  }

  // Check queues
  try {
    const { metaEventsQueue, aiGenerateQueue, aiSendReplyQueue } = require('../lib/queues');
    checks.queues = {
      meta_events: metaEventsQueue ? 'ready' : 'not_configured',
      ai_generate: aiGenerateQueue ? 'ready' : 'not_configured',
      ai_send_reply: aiSendReplyQueue ? 'ready' : 'not_configured'
    };
  } catch (e) {
    checks.queues = 'error';
  }

  // Check config
  try {
    const cfg = await pool.query("SELECT key, value FROM ai_bot_config WHERE key IN ('global_enabled', 'mode')");
    const config = {};
    cfg.rows.forEach(r => config[r.key] = r.value);
    checks.config = { enabled: config.global_enabled, mode: config.mode };
  } catch (e) {
    checks.config = 'error';
  }

  const allOk = checks.redis !== 'down' && checks.database !== 'down';
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    module: 'ai-bot',
    timestamp: new Date().toISOString(),
    checks
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Authenticated admin endpoints
// ═══════════════════════════════════════════════════════════════

router.use(authenticate);

// ─── GET /dashboard ─────────────────────────────────────────
router.get('/dashboard', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const [events24h, events7d, replies, failures, configStatus] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'processed') as processed,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM ai_bot_events
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
      pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'processed') as processed,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM ai_bot_events
        WHERE created_at > NOW() - INTERVAL '7 days'
      `),
      pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'sent') as sent,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected
        FROM ai_bot_replies
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
      pool.query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE resolved = false) as unresolved
        FROM ai_bot_failures
        WHERE created_at > NOW() - INTERVAL '7 days'
      `),
      pool.query(`
        SELECT key, value FROM ai_bot_config
        WHERE key IN ('enabled', 'mode', 'channels')
        ORDER BY key
      `)
    ]);

    // Queue stats (graceful if unavailable)
    let queueStats = { waiting: 0, active: 0, failed: 0, available: false };
    if (metaEventsQueue) {
      try {
        const [waiting, active, failed] = await Promise.all([
          metaEventsQueue.getWaitingCount(),
          metaEventsQueue.getActiveCount(),
          metaEventsQueue.getFailedCount()
        ]);
        queueStats = { waiting, active, failed, available: true };
      } catch (err) {
        log.warn({ requestId, error: err.message }, 'Failed to get queue stats');
      }
    }

    const config = {};
    for (const row of configStatus.rows) {
      config[row.key] = row.value;
    }

    res.json({
      ok: true,
      events_24h: events24h.rows[0],
      events_7d: events7d.rows[0],
      replies_24h: replies.rows[0],
      failures_7d: failures.rows[0],
      queue: queueStats,
      config
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /dashboard error');
    res.status(500).json({ error: 'Error obteniendo dashboard' });
  }
});

// ─── GET /config ────────────────────────────────────────────
router.get('/config', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const result = await pool.query(`
      SELECT key, value, description, updated_at, updated_by
      FROM ai_bot_config
      ORDER BY key
    `);

    res.json({ ok: true, config: result.rows });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /config error');
    res.status(500).json({ error: 'Error obteniendo configuración' });
  }
});

// ─── PUT /config/:key ───────────────────────────────────────
router.put('/config/:key', requirePermission('ai_bot.config'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'El campo "value" es requerido' });
    }

    // Check key exists
    const existing = await pool.query(
      'SELECT key, value FROM ai_bot_config WHERE key = $1',
      [key]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ error: `Config key "${key}" no encontrada` });
    }

    const previousValue = existing.rows[0].value;

    await pool.query(
      `UPDATE ai_bot_config
       SET value = $1, updated_at = NOW(), updated_by = $2
       WHERE key = $3`,
      [typeof value === 'string' ? value : JSON.stringify(value), req.user.id, key]
    );

    log.info({
      requestId,
      key,
      previousValue,
      newValue: value,
      userId: req.user.id,
      username: req.user.username
    }, 'AI Bot config updated');

    res.json({ ok: true, key, value, previous: previousValue });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'PUT /config/:key error');
    res.status(500).json({ error: 'Error actualizando configuración' });
  }
});

// ─── GET /events ────────────────────────────────────────────
router.get('/events', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const { status, channel, dateFrom, dateTo } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`e.status = $${paramIndex++}`);
      params.push(status);
    }
    if (channel) {
      conditions.push(`e.channel = $${paramIndex++}`);
      params.push(channel);
    }
    if (dateFrom) {
      conditions.push(`e.created_at >= $${paramIndex++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`e.created_at <= $${paramIndex++}`);
      params.push(dateTo);
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM ai_bot_events e ${whereClause}`,
      params
    );

    const eventsResult = await pool.query(
      `SELECT e.*,
        (SELECT json_agg(r.* ORDER BY r.created_at DESC)
         FROM ai_bot_replies r WHERE r.event_id = e.id
        ) as replies
       FROM ai_bot_events e
       ${whereClause}
       ORDER BY e.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const total = parseInt(countResult.rows[0].total, 10);

    res.json({
      ok: true,
      events: eventsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /events error');
    res.status(500).json({ error: 'Error obteniendo eventos' });
  }
});

// ─── GET /events/:id ────────────────────────────────────────
router.get('/events/:id', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const { id } = req.params;

    const eventResult = await pool.query(
      'SELECT * FROM ai_bot_events WHERE id = $1',
      [id]
    );

    if (eventResult.rowCount === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const [messagesResult, repliesResult] = await Promise.all([
      pool.query(
        `SELECT * FROM ai_bot_messages
         WHERE event_id = $1
         ORDER BY created_at ASC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM ai_bot_replies
         WHERE event_id = $1
         ORDER BY created_at DESC`,
        [id]
      )
    ]);

    res.json({
      ok: true,
      event: {
        ...eventResult.rows[0],
        messages: messagesResult.rows,
        replies: repliesResult.rows
      }
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /events/:id error');
    res.status(500).json({ error: 'Error obteniendo evento' });
  }
});

// ─── POST /events/:id/approve ───────────────────────────────
router.post('/events/:id/approve', requirePermission('ai_bot.manage'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const { id } = req.params;

    // Find the pending reply for this event
    const replyResult = await pool.query(
      `SELECT id, event_id, content, status
       FROM ai_bot_replies
       WHERE event_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [id]
    );

    if (replyResult.rowCount === 0) {
      return res.status(404).json({ error: 'No hay respuesta pendiente para aprobar' });
    }

    const reply = replyResult.rows[0];

    await pool.query('BEGIN');
    try {
      // Update reply status
      await pool.query(
        `UPDATE ai_bot_replies
         SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [req.user.id, reply.id]
      );

      // Update event status
      await pool.query(
        `UPDATE ai_bot_events
         SET status = 'approved', updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    log.info({
      requestId,
      eventId: id,
      replyId: reply.id,
      userId: req.user.id,
      username: req.user.username
    }, 'Reply approved');

    // Enqueue send job if ai-send-reply queue is available
    try {
      const { aiSendReplyQueue } = require('../lib/queues');
      if (aiSendReplyQueue) {
        await aiSendReplyQueue.add('send-reply', {
          reply_id: reply.id,
          event_id: id,
          approved_by: req.user.id,
          request_id: requestId
        });
        log.info({ requestId, replyId: reply.id }, 'Send-reply job enqueued');
      }
    } catch (queueErr) {
      log.warn({ requestId, error: queueErr.message }, 'Failed to enqueue send-reply job');
    }

    res.json({ ok: true, reply_id: reply.id, status: 'approved' });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'POST /events/:id/approve error');
    res.status(500).json({ error: 'Error aprobando respuesta' });
  }
});

// ─── POST /events/:id/reject ────────────────────────────────
router.post('/events/:id/reject', requirePermission('ai_bot.manage'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const replyResult = await pool.query(
      `SELECT id, event_id, status
       FROM ai_bot_replies
       WHERE event_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [id]
    );

    if (replyResult.rowCount === 0) {
      return res.status(404).json({ error: 'No hay respuesta pendiente para rechazar' });
    }

    const reply = replyResult.rows[0];

    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE ai_bot_replies
         SET status = 'rejected', rejected_by = $1, rejected_at = NOW(),
             rejection_reason = $2, updated_at = NOW()
         WHERE id = $3`,
        [req.user.id, reason || null, reply.id]
      );

      await pool.query(
        `UPDATE ai_bot_events
         SET status = 'rejected', updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    log.info({
      requestId,
      eventId: id,
      replyId: reply.id,
      reason,
      userId: req.user.id,
      username: req.user.username
    }, 'Reply rejected');

    res.json({ ok: true, reply_id: reply.id, status: 'rejected' });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'POST /events/:id/reject error');
    res.status(500).json({ error: 'Error rechazando respuesta' });
  }
});

// ─── GET /replies ───────────────────────────────────────────
router.get('/replies', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const { status, channel, dateFrom, dateTo } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`r.status = $${paramIndex++}`);
      params.push(status);
    }
    if (channel) {
      conditions.push(`e.channel = $${paramIndex++}`);
      params.push(channel);
    }
    if (dateFrom) {
      conditions.push(`r.created_at >= $${paramIndex++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`r.created_at <= $${paramIndex++}`);
      params.push(dateTo);
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM ai_bot_replies r
       LEFT JOIN ai_bot_events e ON e.id = r.event_id
       ${whereClause}`,
      params
    );

    const repliesResult = await pool.query(
      `SELECT r.*, e.channel, e.platform, e.external_user_id
       FROM ai_bot_replies r
       LEFT JOIN ai_bot_events e ON e.id = r.event_id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const total = parseInt(countResult.rows[0].total, 10);

    res.json({
      ok: true,
      replies: repliesResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /replies error');
    res.status(500).json({ error: 'Error obteniendo respuestas' });
  }
});

// ─── GET /failures ──────────────────────────────────────────
router.get('/failures', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const { resolved, dateFrom, dateTo } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (resolved !== undefined) {
      conditions.push(`f.resolved = $${paramIndex++}`);
      params.push(resolved === 'true');
    }
    if (dateFrom) {
      conditions.push(`f.created_at >= $${paramIndex++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`f.created_at <= $${paramIndex++}`);
      params.push(dateTo);
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM ai_bot_failures f ${whereClause}`,
      params
    );

    const failuresResult = await pool.query(
      `SELECT f.*, e.channel, e.platform
       FROM ai_bot_failures f
       LEFT JOIN ai_bot_events e ON e.id = f.event_id
       ${whereClause}
       ORDER BY f.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    const total = parseInt(countResult.rows[0].total, 10);

    res.json({
      ok: true,
      failures: failuresResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /failures error');
    res.status(500).json({ error: 'Error obteniendo failures' });
  }
});

// ─── POST /failures/:id/resolve ─────────────────────────────
router.post('/failures/:id/resolve', requirePermission('ai_bot.manage'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const result = await pool.query(
      `UPDATE ai_bot_failures
       SET resolved = true, resolved_by = $1, resolved_at = NOW(),
           resolution_notes = $2, updated_at = NOW()
       WHERE id = $3 AND resolved = false
       RETURNING id, event_id`,
      [req.user.id, notes || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Failure no encontrado o ya resuelto' });
    }

    log.info({
      requestId,
      failureId: id,
      userId: req.user.id,
      username: req.user.username
    }, 'Failure resolved');

    res.json({ ok: true, failure_id: id, status: 'resolved' });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'POST /failures/:id/resolve error');
    res.status(500).json({ error: 'Error resolviendo failure' });
  }
});

// ─── GET /metrics ───────────────────────────────────────────
router.get('/metrics', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const period = req.query.period || '24h';

    let interval;
    switch (period) {
      case '7d':  interval = '7 days';  break;
      case '30d': interval = '30 days'; break;
      case '24h':
      default:    interval = '24 hours'; break;
    }

    const [eventMetrics, replyMetrics, failureMetrics, channelBreakdown, hourlyVolume] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total_events,
          COUNT(*) FILTER (WHERE status = 'processed') as processed,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'failed') as failed,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected
        FROM ai_bot_events
        WHERE created_at > NOW() - INTERVAL '${interval}'
      `),
      pool.query(`
        SELECT
          COUNT(*) as total_replies,
          COUNT(*) FILTER (WHERE status = 'sent') as sent,
          COUNT(*) FILTER (WHERE status = 'approved') as approved,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
          AVG(EXTRACT(EPOCH FROM (created_at - (
            SELECT e.created_at FROM ai_bot_events e WHERE e.id = ai_bot_replies.event_id
          )))) as avg_response_time_seconds
        FROM ai_bot_replies
        WHERE created_at > NOW() - INTERVAL '${interval}'
      `),
      pool.query(`
        SELECT
          COUNT(*) as total_failures,
          COUNT(*) FILTER (WHERE resolved = true) as resolved,
          COUNT(*) FILTER (WHERE resolved = false) as unresolved
        FROM ai_bot_failures
        WHERE created_at > NOW() - INTERVAL '${interval}'
      `),
      pool.query(`
        SELECT channel, COUNT(*) as count
        FROM ai_bot_events
        WHERE created_at > NOW() - INTERVAL '${interval}'
        GROUP BY channel
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          date_trunc('hour', created_at) as hour,
          COUNT(*) as events
        FROM ai_bot_events
        WHERE created_at > NOW() - INTERVAL '${interval}'
        GROUP BY date_trunc('hour', created_at)
        ORDER BY hour ASC
      `)
    ]);

    res.json({
      ok: true,
      period,
      events: eventMetrics.rows[0],
      replies: replyMetrics.rows[0],
      failures: failureMetrics.rows[0],
      by_channel: channelBreakdown.rows,
      hourly_volume: hourlyVolume.rows
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /metrics error');
    res.status(500).json({ error: 'Error obteniendo métricas' });
  }
});

// ─── GET /system-prompt ─────────────────────────────────────
router.get('/system-prompt', requirePermission('ai_bot.view'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const result = await pool.query(
      `SELECT value, updated_at, updated_by
       FROM ai_bot_config
       WHERE key = 'system_prompt'`
    );

    if (result.rowCount === 0) {
      return res.json({ ok: true, system_prompt: null });
    }

    const row = result.rows[0];

    // Get updater username if available
    let updatedByUsername = null;
    if (row.updated_by) {
      const userResult = await pool.query(
        'SELECT username FROM users WHERE id = $1',
        [row.updated_by]
      );
      updatedByUsername = userResult.rows[0]?.username || null;
    }

    res.json({
      ok: true,
      system_prompt: row.value,
      updated_at: row.updated_at,
      updated_by: updatedByUsername
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'GET /system-prompt error');
    res.status(500).json({ error: 'Error obteniendo system prompt' });
  }
});

// ─── PUT /system-prompt ─────────────────────────────────────
router.put('/system-prompt', requirePermission('ai_bot.manage'), async (req, res) => {
  const requestId = crypto.randomUUID();
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'El campo "prompt" es requerido y debe ser un string' });
    }

    // Get current prompt to store as previous version
    const current = await pool.query(
      `SELECT value FROM ai_bot_config WHERE key = 'system_prompt'`
    );

    const previousPrompt = current.rows[0]?.value || null;

    // Upsert the system prompt
    await pool.query(
      `INSERT INTO ai_bot_config (key, value, description, updated_by, updated_at)
       VALUES ('system_prompt', $1, 'System prompt for Claude', $2, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = $1, updated_by = $2, updated_at = NOW()`,
      [prompt, req.user.id]
    );

    log.info({
      requestId,
      userId: req.user.id,
      promptLength: prompt.length,
      hadPrevious: !!previousPrompt
    }, 'System prompt updated');

    res.json({
      ok: true,
      system_prompt: prompt,
      previous_prompt: previousPrompt
    });
  } catch (error) {
    log.error({ requestId, error: error.message }, 'PUT /system-prompt error');
    res.status(500).json({ error: 'Error actualizando system prompt' });
  }
});

module.exports = router;
