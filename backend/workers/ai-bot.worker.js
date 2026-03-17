/**
 * AI Bot Workers
 *
 * Procesa eventos de Meta (IG/FB), genera respuestas con AI y las envia.
 * Tres workers independientes conectados por colas BullMQ.
 *
 * Colas: meta-events, ai-generate, ai-send-reply
 */

const { Worker } = require('bullmq');
const pool = require('../db');
const { workerLogger: log } = require('../lib/logger');
const { dedupEvent, acquireLock, releaseLock, checkRateLimit } = require('../lib/ai-bot/redis-utils');

// ---------------------------------------------------------------------------
// Worker 1: meta-events — Parse & triage incoming webhook events
// ---------------------------------------------------------------------------

/**
 * Procesador principal del job meta-events
 */
async function parseMetaEvent(job) {
  const { payload, requestId } = job.data;

  const jobLog = log.child({ requestId, jobId: job.id, queue: 'meta-events' });
  jobLog.info('Procesando evento Meta');

  // 1. Parse raw webhook payload
  const eventId = payload.event_id || payload.id || `evt_${Date.now()}_${job.id}`;
  const channel = payload.channel || 'instagram';
  const senderId = payload.sender_id || payload.from;
  const messageText = payload.message?.text || payload.text || '';
  const messageType = payload.message?.type || payload.type || 'text';

  // Redis-level dedup (fast, before hitting DB)
  const isNew = await dedupEvent(eventId);
  if (!isNew) {
    jobLog.info({ eventId }, 'Duplicate event detected via Redis, skipping');
    return { status: 'duplicate', eventId };
  }

  // 2. Upsert ai_bot_events (idempotent on event_id)
  const upsertResult = await pool.query(
    `INSERT INTO ai_bot_events (event_id, channel, sender_id, message_text, message_type, raw_payload, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing', NOW())
     ON CONFLICT (event_id) DO UPDATE SET
       raw_payload = EXCLUDED.raw_payload,
       updated_at = NOW()
     RETURNING id, status`,
    [eventId, channel, senderId, messageText, messageType, JSON.stringify(payload)]
  );

  const eventRow = upsertResult.rows[0];
  const eventDbId = eventRow.id;
  jobLog.info({ eventDbId, eventId }, 'Evento upserted');

  // 3. Rules engine: decide action (async — checks DB for duplicates)
  const decision = await evaluateRules(payload, messageText, messageType);
  jobLog.info({ decision: decision.action, reason: decision.reason }, 'Decision del rules engine');

  // 3a. Skip
  if (decision.action === 'skip') {
    await pool.query(
      `UPDATE ai_bot_events SET status = 'skipped', skip_reason = $2, updated_at = NOW() WHERE id = $1`,
      [eventDbId, decision.reason]
    );
    return { status: 'skipped', eventDbId, reason: decision.reason };
  }

  // 3b. Emoji only — no Claude needed
  if (decision.action === 'emoji_only') {
    const { aiSendReplyQueue } = require('../lib/queues');
    if (aiSendReplyQueue) {
      await aiSendReplyQueue.add('send-emoji', {
        eventDbId,
        eventId,
        channel,
        senderId,
        replyText: decision.emoji || '❤️',
        replyType: 'emoji',
        requestId
      });
      jobLog.info('Emoji reply encolado en ai-send-reply');
    }
    await pool.query(
      `UPDATE ai_bot_events SET status = 'emoji_queued', updated_at = NOW() WHERE id = $1`,
      [eventDbId]
    );
    return { status: 'emoji_queued', eventDbId };
  }

  // 3c. Respond — check bot mode
  const modeResult = await pool.query(
    `SELECT value FROM ai_bot_config WHERE key = 'mode' LIMIT 1`
  );
  const botMode = modeResult.rows[0]?.value || 'off';
  jobLog.info({ botMode }, 'Bot mode');

  if (botMode === 'off') {
    await pool.query(
      `UPDATE ai_bot_events SET status = 'skipped', skip_reason = 'bot_off', updated_at = NOW() WHERE id = $1`,
      [eventDbId]
    );
    return { status: 'skipped', eventDbId, reason: 'bot_off' };
  }

  // Mode is 'suggestion' or 'automatic' — enqueue to ai-generate
  const { aiGenerateQueue } = require('../lib/queues');
  if (aiGenerateQueue) {
    await aiGenerateQueue.add('generate', {
      eventDbId,
      eventId,
      channel,
      senderId,
      messageText,
      messageType,
      botMode,
      requestId
    });
    jobLog.info('Evento encolado en ai-generate');
  }

  await pool.query(
    `UPDATE ai_bot_events SET status = 'generate_queued', updated_at = NOW() WHERE id = $1`,
    [eventDbId]
  );

  return { status: 'generate_queued', eventDbId, botMode };
}

/**
 * Rules engine wrapper: usa el rules-engine completo de lib/ai-bot/
 * Adapta la interfaz del payload del worker al formato esperado por shouldRespond()
 */
async function evaluateRules(payload, messageText, messageType) {
  const rulesEngine = require('../lib/ai-bot/rules-engine');

  // Quick checks que no necesitan DB
  if (messageType === 'story_mention' || messageType === 'story_reply') {
    return { action: 'emoji_only', emoji: '❤️', reason: 'story_interaction' };
  }
  if (messageType === 'reaction') {
    return { action: 'skip', reason: 'reaction_event' };
  }
  if (!messageText || messageText.trim().length === 0) {
    return { action: 'skip', reason: 'empty_message' };
  }
  if (['image', 'audio', 'video', 'sticker'].includes(messageType) && !messageText) {
    return { action: 'skip', reason: 'media_only' };
  }

  // Usar rules engine completo (incluye emoji detection, tags, spam, testimonials, keywords, DB dedup)
  const event = {
    eventId: payload.event_id,
    channel: payload.channel || payload.field || 'unknown',
    platform: payload.platform,
    senderId: payload.sender_id || payload.value?.from?.id || payload.value?.sender?.id,
    senderName: payload.value?.from?.username || payload.value?.from?.name || '',
    contentText: messageText,
    mediaId: payload.value?.media_id || payload.value?.post_id || null,
    parentId: payload.value?.parent_id || null
  };

  const decision = await rulesEngine.shouldRespond(event);

  // Mapear formato rules-engine → formato worker
  if (decision.action === 'emoji_only') {
    return { action: 'emoji_only', emoji: rulesEngine.getEmojiResponse(), reason: decision.reason };
  }
  if (!decision.respond) {
    return { action: 'skip', reason: decision.reason };
  }
  return { action: 'respond', reason: decision.reason };
}

// ---------------------------------------------------------------------------
// Worker 2: ai-generate — Generate AI reply via ai-engine
// ---------------------------------------------------------------------------

/**
 * Procesador principal del job ai-generate
 */
async function generateAiReply(job) {
  const {
    eventDbId,
    eventId,
    channel,
    senderId,
    messageText,
    messageType,
    botMode,
    requestId
  } = job.data;

  const jobLog = log.child({ requestId, jobId: job.id, queue: 'ai-generate', eventDbId });
  jobLog.info('Generando respuesta AI');

  const lockKey = `generate:${eventId}`;
  const locked = await acquireLock(lockKey, 60000); // 60s lock
  if (!locked) {
    jobLog.warn({ eventId }, 'Event already being processed by another worker');
    return { status: 'locked', eventId };
  }

  try {
    // 1. Load event from DB
    const eventResult = await pool.query(
      `SELECT * FROM ai_bot_events WHERE id = $1`,
      [eventDbId]
    );

    if (eventResult.rows.length === 0) {
      jobLog.error('Evento no encontrado en DB');
      throw new Error(`Event ${eventDbId} not found`);
    }

    const event = eventResult.rows[0];

    // 2. Call ai-engine to generate reply
    const aiEngine = require('../lib/ai-bot/ai-engine');
    const response = await aiEngine.generateReply({
      channel: event.channel,
      contentText: event.content_text || messageText,
      senderName: event.sender_name || senderId,
      mediaId: event.media_id,
      platform: event.platform
    });

    // 3. Validate response (pass text string, not the full response object)
    const validation = aiEngine.validateResponse(response.text);
    if (!validation.valid) {
      jobLog.warn({ reason: validation.reason }, 'Respuesta AI no paso validacion');
      throw new Error(`AI response validation failed: ${validation.reason}`);
    }

    // 4. Save to ai_bot_messages (schema from migration 038)
    const messageResult = await pool.query(
      `INSERT INTO ai_bot_messages (event_id, generated_text, model, prompt_tokens, completion_tokens, confidence, generation_time_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id`,
      [eventDbId, response.text, response.model, response.promptTokens, response.completionTokens, response.confidence, response.generationTimeMs]
    );

    // Also save to ai_bot_replies (tracks actual send status)
    const replyStatus = botMode === 'automatic' ? 'pending' : 'pending_approval';
    await pool.query(
      `INSERT INTO ai_bot_replies (event_id, message_id, reply_text, channel, status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [eventDbId, messageResult.rows[0].id, response.text, channel, replyStatus]
    );

    const messageDbId = messageResult.rows[0].id;
    jobLog.info({ messageDbId, replyStatus }, 'Respuesta AI guardada');

    // 5. If automatic mode, enqueue to send
    if (botMode === 'automatic') {
      const { aiSendReplyQueue } = require('../lib/queues');
      if (aiSendReplyQueue) {
        await aiSendReplyQueue.add('send-reply', {
          eventDbId,
          messageDbId,
          eventId,
          channel,
          senderId,
          replyText: response.text,
          replyType: response.type || 'text',
          requestId
        });
        jobLog.info('Respuesta encolada en ai-send-reply');
      }
    }

    // 6. Update event status
    await pool.query(
      `UPDATE ai_bot_events SET status = $2, updated_at = NOW() WHERE id = $1`,
      [eventDbId, botMode === 'automatic' ? 'send_queued' : 'pending_approval']
    );

    return { status: replyStatus, messageDbId, eventDbId };

  } catch (err) {
    jobLog.error({ err: err.message, stack: err.stack }, 'Error generando respuesta AI');

    // Save to ai_bot_failures
    try {
      await pool.query(
        `INSERT INTO ai_bot_failures (event_id, stage, error_message, error_stack, created_at)
         VALUES ($1, 'generate', $2, $3, NOW())`,
        [eventDbId, err.message, err.stack]
      );
    } catch (dbErr) {
      jobLog.error({ dbErr: dbErr.message }, 'Error guardando failure en DB');
    }

    // Update event status
    try {
      await pool.query(
        `UPDATE ai_bot_events SET status = 'generate_failed', updated_at = NOW() WHERE id = $1`,
        [eventDbId]
      );
    } catch (dbErr) {
      jobLog.error({ dbErr: dbErr.message }, 'Error actualizando evento');
    }

    throw err; // Re-throw para que BullMQ maneje el retry
  } finally {
    await releaseLock(lockKey);
  }
}

// ---------------------------------------------------------------------------
// Worker 3: ai-send-reply — Send the reply via Meta API
// ---------------------------------------------------------------------------

/**
 * Procesador principal del job ai-send-reply
 */
async function sendReply(job) {
  const {
    eventDbId,
    messageDbId,
    eventId,
    channel,
    senderId,
    replyText,
    replyType,
    requestId
  } = job.data;

  const jobLog = log.child({ requestId, jobId: job.id, queue: 'ai-send-reply', eventDbId, messageDbId });
  jobLog.info('Enviando respuesta AI');

  const { allowed, remaining } = await checkRateLimit(`reply:${channel}`, 10, 60); // 10 per minute per channel
  if (!allowed) {
    jobLog.warn({ channel, remaining }, 'Rate limit reached, will retry');
    throw new Error('RATE_LIMITED'); // Let BullMQ retry with backoff
  }

  try {
    // 1. Load event and reply from DB (validate they exist)
    const eventResult = await pool.query(
      `SELECT * FROM ai_bot_events WHERE id = $1`,
      [eventDbId]
    );

    if (eventResult.rows.length === 0) {
      throw new Error(`Event ${eventDbId} not found`);
    }

    let replyRow = null;
    if (messageDbId) {
      const replyResult = await pool.query(
        `SELECT * FROM ai_bot_messages WHERE id = $1`,
        [messageDbId]
      );
      replyRow = replyResult.rows[0] || null;
    }

    // 2. Send via meta-client (channel-specific functions)
    const metaClient = require('../lib/ai-bot/meta-client');
    let sendResult;

    if (channel === 'instagram_comment') {
      // For IG comments, senderId is the comment ID to reply to
      const commentId = eventResult.rows[0].media_id || senderId;
      sendResult = await metaClient.replyToInstagramComment(commentId, replyText);
    } else if (channel === 'facebook_comment') {
      const commentId = eventResult.rows[0].media_id || senderId;
      sendResult = await metaClient.replyToFacebookComment(commentId, replyText);
    } else if (channel === 'messenger') {
      sendResult = await metaClient.sendMessengerMessage(senderId, replyText);
    } else {
      throw new Error(`Unknown channel: ${channel}`);
    }

    if (!sendResult.success) {
      throw new Error(sendResult.error?.message || `Meta API error for channel ${channel}`);
    }

    const metaReplyId = sendResult.data?.id || sendResult.data?.message_id || null;
    jobLog.info({ metaReplyId }, 'Respuesta enviada via Meta');

    // 3. Update ai_bot_replies with send result
    if (messageDbId) {
      await pool.query(
        `UPDATE ai_bot_replies
         SET meta_reply_id = $2, status = 'sent', sent_at = NOW(), attempts = attempts + 1
         WHERE event_id = $1 AND message_id = $3`,
        [eventDbId, metaReplyId, messageDbId]
      );
    } else {
      // Emoji reply (no message_id) — insert reply record
      await pool.query(
        `INSERT INTO ai_bot_replies (event_id, reply_text, channel, status, meta_reply_id, sent_at, attempts, created_at)
         VALUES ($1, $2, $3, 'sent', $4, NOW(), 1, NOW())
         ON CONFLICT DO NOTHING`,
        [eventDbId, replyText, channel, metaReplyId]
      );
    }

    // 4. Update ai_bot_events status
    await pool.query(
      `UPDATE ai_bot_events SET status = 'responded', updated_at = NOW() WHERE id = $1`,
      [eventDbId]
    );

    return { status: 'sent', eventDbId, messageDbId, metaReplyId };

  } catch (err) {
    jobLog.error({ err: err.message, stack: err.stack }, 'Error enviando respuesta AI');

    // Update reply status to failed
    if (messageDbId) {
      try {
        await pool.query(
          `UPDATE ai_bot_replies SET status = 'failed', error_message = $2, attempts = attempts + 1 WHERE event_id = $1 AND message_id = $3`,
          [eventDbId, err.message, messageDbId]
        );
      } catch (dbErr) {
        jobLog.error({ dbErr: dbErr.message }, 'Error actualizando reply status');
      }
    }

    // Save to ai_bot_failures
    try {
      await pool.query(
        `INSERT INTO ai_bot_failures (event_id, stage, error_message, error_stack, created_at)
         VALUES ($1, 'send', $2, $3, NOW())`,
        [eventDbId, err.message, err.stack]
      );
    } catch (dbErr) {
      jobLog.error({ dbErr: dbErr.message }, 'Error guardando failure en DB');
    }

    // Update event status
    try {
      await pool.query(
        `UPDATE ai_bot_events SET status = 'send_failed', updated_at = NOW() WHERE id = $1`,
        [eventDbId]
      );
    } catch (dbErr) {
      jobLog.error({ dbErr: dbErr.message }, 'Error actualizando evento');
    }

    throw err; // Re-throw para que BullMQ maneje el retry
  }
}

// ---------------------------------------------------------------------------
// Worker factory functions
// ---------------------------------------------------------------------------

/**
 * Crea e inicia el Meta Events worker
 */
function createMetaEventsWorker(connection) {
  const worker = new Worker('meta-events', parseMetaEvent, {
    connection,
    concurrency: 5,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 3000
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 }
    }
  });

  worker.on('completed', (job, result) => {
    log.info({
      jobId: job.id,
      eventDbId: result?.eventDbId,
      status: result?.status
    }, 'Meta events job completado');
  });

  worker.on('failed', async (job, err) => {
    log.error({
      jobId: job?.id,
      eventId: job?.data?.payload?.event_id,
      err: err.message,
      attemptsMade: job?.attemptsMade
    }, 'Meta events job fallido');

    // Dead Letter Queue: all retries exhausted
    if (job && job.attemptsMade >= job.opts.attempts) {
      log.error({
        jobId: job.id,
        eventId: job.data?.payload?.event_id,
        attemptsMade: job.attemptsMade
      }, 'Meta events job moved to dead letter queue');
      try {
        await pool.query(
          `INSERT INTO ai_bot_failures (event_id, stage, error_message, error_stack, created_at)
           VALUES ($1, 'dead_letter', $2, $3, NOW())`,
          [job.data?.payload?.event_id || null, `[meta-events DLQ] ${err.message}`, err.stack]
        );
      } catch (dbErr) {
        log.error({ dbErr: dbErr.message }, 'Error saving dead letter record');
      }
    }
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'Meta events worker error');
  });

  return worker;
}

/**
 * Crea e inicia el AI Generate worker
 */
function createAiGenerateWorker(connection) {
  const worker = new Worker('ai-generate', generateAiReply, {
    connection,
    concurrency: 3,
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 }
    }
  });

  worker.on('completed', (job, result) => {
    log.info({
      jobId: job.id,
      eventDbId: result?.eventDbId,
      messageDbId: result?.messageDbId,
      status: result?.status
    }, 'AI generate job completado');
  });

  worker.on('failed', async (job, err) => {
    log.error({
      jobId: job?.id,
      eventDbId: job?.data?.eventDbId,
      err: err.message,
      attemptsMade: job?.attemptsMade
    }, 'AI generate job fallido');

    // Dead Letter Queue: all retries exhausted
    if (job && job.attemptsMade >= job.opts.attempts) {
      log.error({
        jobId: job.id,
        eventDbId: job.data?.eventDbId,
        attemptsMade: job.attemptsMade
      }, 'AI generate job moved to dead letter queue');
      try {
        await pool.query(
          `INSERT INTO ai_bot_failures (event_id, stage, error_message, error_stack, created_at)
           VALUES ($1, 'dead_letter', $2, $3, NOW())`,
          [job.data?.eventDbId || null, `[ai-generate DLQ] ${err.message}`, err.stack]
        );
      } catch (dbErr) {
        log.error({ dbErr: dbErr.message }, 'Error saving dead letter record');
      }
    }
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'AI generate worker error');
  });

  return worker;
}

/**
 * Crea e inicia el AI Send Reply worker
 */
function createAiSendReplyWorker(connection) {
  const worker = new Worker('ai-send-reply', sendReply, {
    connection,
    concurrency: 3,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      removeOnComplete: { count: 2000 },
      removeOnFail: { count: 5000 }
    }
  });

  worker.on('completed', (job, result) => {
    log.info({
      jobId: job.id,
      eventDbId: result?.eventDbId,
      messageDbId: result?.messageDbId,
      metaReplyId: result?.metaReplyId,
      status: result?.status
    }, 'AI send reply job completado');
  });

  worker.on('failed', async (job, err) => {
    log.error({
      jobId: job?.id,
      eventDbId: job?.data?.eventDbId,
      messageDbId: job?.data?.messageDbId,
      err: err.message,
      attemptsMade: job?.attemptsMade
    }, 'AI send reply job fallido');

    // Dead Letter Queue: all retries exhausted
    if (job && job.attemptsMade >= job.opts.attempts) {
      log.error({
        jobId: job.id,
        eventDbId: job.data?.eventDbId,
        messageDbId: job.data?.messageDbId,
        attemptsMade: job.attemptsMade
      }, 'AI send reply job moved to dead letter queue');
      try {
        await pool.query(
          `INSERT INTO ai_bot_failures (event_id, stage, error_message, error_stack, created_at)
           VALUES ($1, 'dead_letter', $2, $3, NOW())`,
          [job.data?.eventDbId || null, `[ai-send-reply DLQ] ${err.message}`, err.stack]
        );
      } catch (dbErr) {
        log.error({ dbErr: dbErr.message }, 'Error saving dead letter record');
      }
    }
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'AI send reply worker error');
  });

  return worker;
}

module.exports = {
  createMetaEventsWorker,
  createAiGenerateWorker,
  createAiSendReplyWorker
};
