/**
 * Worker Entry Point
 *
 * Inicia todos los workers de BullMQ como un proceso separado.
 * Ejecutar: node workers/index.js
 */

require('dotenv').config();

const { logger, workerLogger: log } = require('../lib/logger');
const { redis } = require('../lib/redis');
const { createWhatsAppWorker } = require('./whatsapp.worker');
// AI Bot workers — loaded defensively so BPM workers always start even if bot code fails
// AI Bot workers — PAUSADOS, descomentar cuando se active el bot en prod
// let createMetaEventsWorker, createAiGenerateWorker, createAiSendReplyWorker;
// try {
//   ({ createMetaEventsWorker, createAiGenerateWorker, createAiSendReplyWorker } = require('./ai-bot.worker'));
// } catch (err) {
//   log.error({ err: err.message }, 'Failed to load AI Bot workers — bot disabled, BPM workers unaffected');
//   createMetaEventsWorker = null;
//   createAiGenerateWorker = null;
//   createAiSendReplyWorker = null;
// }
const createMetaEventsWorker = null, createAiGenerateWorker = null, createAiSendReplyWorker = null;

const pkg = require('../package.json');

// Workers activos (para graceful shutdown)
const workers = [];

async function start() {
  log.info({
    app: pkg.name,
    version: pkg.version,
    nodeVersion: process.version,
    pid: process.pid
  }, 'Iniciando workers');

  // Verificar conexion Redis
  if (!redis) {
    log.fatal('Redis no esta configurado. Los workers requieren Redis. Abortando.');
    process.exit(1);
  }

  // Esperar a que Redis este listo
  await new Promise((resolve, reject) => {
    if (redis.status === 'ready') {
      resolve();
      return;
    }
    redis.once('ready', resolve);
    redis.once('error', (err) => {
      log.fatal({ err: err.message }, 'Error conectando a Redis');
      reject(err);
    });
    // Timeout de conexion
    setTimeout(() => reject(new Error('Redis connection timeout (30s)')), 30000);
  });

  log.info('Redis conectado');

  // Crear conexion dedicada para BullMQ (requiere maxRetriesPerRequest: null)
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
      password: process.env.REDIS_PASSWORD || undefined,
      ...bullmqOptions
    });
  }

  // Iniciar workers
  const whatsappWorker = createWhatsAppWorker(connection);
  workers.push(whatsappWorker);
  log.info('WhatsApp worker iniciado');

  // AI Bot workers — isolated in try-catch so BPM workers survive if bot fails
  try {
    if (createMetaEventsWorker) {
      const metaEventsWorker = createMetaEventsWorker(connection);
      workers.push(metaEventsWorker);
      log.info('Meta Events worker iniciado');
    }
    if (createAiGenerateWorker) {
      const aiGenerateWorker = createAiGenerateWorker(connection);
      workers.push(aiGenerateWorker);
      log.info('AI Generate worker iniciado');
    }
    if (createAiSendReplyWorker) {
      const aiSendReplyWorker = createAiSendReplyWorker(connection);
      workers.push(aiSendReplyWorker);
      log.info('AI Send Reply worker iniciado');
    }
  } catch (botErr) {
    log.error({ err: botErr.message, stack: botErr.stack }, 'AI Bot workers failed to start — BPM workers unaffected');
  }

  log.info({ workerCount: workers.length }, 'Todos los workers iniciados');

  // Health check HTTP server (requerido por Cloud Run)
  const http = require('http');
  const PORT = process.env.PORT || 8080;
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        workers: workers.length,
        uptime: process.uptime()
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(PORT, () => {
    log.info({ port: PORT }, 'Worker health server listening');
  });
}

// Graceful shutdown
async function shutdown(signal) {
  log.info({ signal }, 'Senal recibida, cerrando workers...');

  const closePromises = workers.map(async (worker) => {
    try {
      await worker.close();
    } catch (err) {
      log.error({ err: err.message }, 'Error cerrando worker');
    }
  });

  await Promise.allSettled(closePromises);
  log.info('Todos los workers cerrados');

  // Cerrar Redis
  try {
    if (redis) {
      await redis.quit();
      log.info('Redis desconectado');
    }
  } catch (err) {
    log.error({ err: err.message }, 'Error cerrando Redis');
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Capturar errores no manejados
process.on('unhandledRejection', (err) => {
  log.fatal({ err: err?.message, stack: err?.stack }, 'Unhandled rejection en worker process');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception en worker process');
  process.exit(1);
});

// Iniciar
start().catch((err) => {
  log.fatal({ err: err.message }, 'Error fatal iniciando workers');
  process.exit(1);
});
