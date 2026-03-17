/**
 * AI Bot Workers — Standalone Entry Point
 *
 * Ejecuta SOLO los workers del Bot IA en un proceso independiente.
 * Esto permite aislar completamente el bot del BPM:
 *   - Si el bot crashea, BPM sigue operando
 *   - Si BPM crashea, el bot sigue procesando
 *   - Cada uno tiene su propio lifecycle y health check
 *
 * Ejecutar:
 *   node workers/ai-bot-standalone.js
 *   NODE_ENV=production node workers/ai-bot-standalone.js
 *
 * Cloud Run: se despliega como un servicio separado.
 */

require('dotenv').config();

const { workerLogger: log } = require('../lib/logger');
const { redis } = require('../lib/redis');
const { createMetaEventsWorker, createAiGenerateWorker, createAiSendReplyWorker } = require('./ai-bot.worker');

const workers = [];

async function start() {
  log.info('=== AI Bot Workers (standalone) starting ===');

  // 1. Verify Redis
  if (!redis) {
    log.fatal('Redis not configured. AI Bot workers require Redis.');
    process.exit(1);
  }

  await new Promise((resolve, reject) => {
    if (redis.status === 'ready') {
      resolve();
    } else {
      redis.once('ready', resolve);
      redis.once('error', (err) => {
        log.fatal({ err: err.message }, 'Redis connection error');
        reject(err);
      });
      setTimeout(() => reject(new Error('Redis connection timeout (30s)')), 30000);
    }
  });

  log.info('Redis connected');

  // 2. Create dedicated BullMQ connection
  const Redis = require('ioredis');
  const bullmqOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false
  };

  let connection;
  if (process.env.REDIS_URL) {
    connection = new Redis(process.env.REDIS_URL, bullmqOptions);
  } else {
    connection = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD,
      ...bullmqOptions
    });
  }

  // 3. Start workers
  const metaEventsWorker = createMetaEventsWorker(connection);
  workers.push(metaEventsWorker);
  log.info('Meta Events worker started');

  const aiGenerateWorker = createAiGenerateWorker(connection);
  workers.push(aiGenerateWorker);
  log.info('AI Generate worker started');

  const aiSendReplyWorker = createAiSendReplyWorker(connection);
  workers.push(aiSendReplyWorker);
  log.info('AI Send Reply worker started');

  log.info({ workerCount: workers.length }, 'All AI Bot workers started');

  // 4. Health check HTTP server
  const http = require('http');
  const PORT = process.env.AI_BOT_WORKERS_PORT || process.env.PORT || 8081;
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        module: 'ai-bot-workers',
        workers: workers.length,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(PORT, () => {
    log.info({ port: PORT }, 'AI Bot workers health server listening');
  });
}

// Graceful shutdown
async function shutdown(signal) {
  log.info({ signal }, 'Shutting down AI Bot workers...');

  const closePromises = workers.map(async (worker) => {
    try {
      await worker.close();
    } catch (err) {
      log.error({ err: err.message }, 'Error closing worker');
    }
  });

  await Promise.allSettled(closePromises);

  if (redis) {
    try { await redis.quit(); } catch (e) { /* ignore */ }
  }

  log.info('AI Bot workers shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'AI Bot workers uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ reason: String(reason) }, 'AI Bot workers unhandled rejection');
  process.exit(1);
});

start().catch((err) => {
  log.fatal({ err: err.message }, 'AI Bot workers failed to start');
  process.exit(1);
});
