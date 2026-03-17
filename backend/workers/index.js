/**
 * Worker Entry Point
 *
 * Inicia todos los workers de BullMQ como un proceso separado.
 * Ejecutar: node workers/index.js
 */

require('dotenv').config();

const { logger, workerLogger: log } = require('../lib/logger');
const { redis } = require('../lib/redis');
const { createOcrWorker } = require('./ocr.worker');
const { createWhatsAppWorker } = require('./whatsapp.worker');

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
  const connection = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false
  });

  // Iniciar workers
  const ocrWorker = createOcrWorker(connection);
  workers.push(ocrWorker);
  log.info('OCR worker iniciado');

  const whatsappWorker = createWhatsAppWorker(connection);
  workers.push(whatsappWorker);
  log.info('WhatsApp worker iniciado');

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
