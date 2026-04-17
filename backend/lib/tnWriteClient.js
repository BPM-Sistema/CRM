/**
 * Tiendanube Write Client
 *
 * Wrapper centralizado para TODAS las escrituras (POST/PUT/DELETE/PATCH) a
 * api.tiendanube.com, con:
 *   - Token bucket local: 1.5 req/s sostenido, burst 10
 *   - Retry automático en 429 (respetando `x-rate-limit-reset`) y 5xx/timeout
 *   - Backoff exponencial con jitter
 *   - Logs por intento
 *
 * ⚠️ SCOPE: IMPORTANTE — el bucket es POR INSTANCIA (memoria local del proceso).
 *    NO es un rate limit global compartido entre instancias.
 *
 *    Cálculo de techo real considerando múltiples procesos:
 *      - Cada instancia de Cloud Run corre con su propio bucket
 *      - crm-workers + petlove-backend = 2 servicios
 *      - Si cada uno escala a M instancias: techo = 2 * M * 1.5 req/s
 *      - Límite oficial TN: 2 req/s (estándar) o 20 req/s (Next/Evolution)
 *
 *    Ejemplos:
 *      - 1 instancia por service: 3 req/s → puede pegar 429 ocasional (retry lo absorbe)
 *      - 2 instancias por service: 6 req/s → 429 frecuente, retry lo mantiene sano
 *      - 3+ instancias: 429 sostenido, posibles fallos definitivos tras 4 retries
 *
 *    Si el audit post-deploy muestra 429 recurrente o fallos finales,
 *    mover el bucket a Redis compartido (un solo bucket entre todas las
 *    instancias) o pasar a BullMQ con rate limiter distribuido.
 *
 *    NO interactúa con retry del circuit breaker: `callTiendanube` (opossum)
 *    solo aplica timeout + circuit breaking, no retry — no hay duplicación.
 */

const { callTiendanube } = require('./circuitBreaker');

// ─── Config ────────────────────────────────────────────────
const RATE_PER_SECOND = parseFloat(process.env.TN_WRITE_RATE_PER_SECOND || '1.5');
const BUCKET_CAPACITY = parseInt(process.env.TN_WRITE_BUCKET_CAPACITY || '10', 10);
const MAX_RETRIES = parseInt(process.env.TN_WRITE_MAX_RETRIES || '4', 10);
const BASE_BACKOFF_MS = parseInt(process.env.TN_WRITE_BASE_BACKOFF_MS || '500', 10);
const MAX_BACKOFF_MS = parseInt(process.env.TN_WRITE_MAX_BACKOFF_MS || '30000', 10);
const JITTER_MS = parseInt(process.env.TN_WRITE_JITTER_MS || '250', 10);

// ─── Token bucket (local, in-memory) ───────────────────────

const bucket = {
  tokens: BUCKET_CAPACITY,
  lastRefill: Date.now(),
};

function refillBucket() {
  const now = Date.now();
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(
    BUCKET_CAPACITY,
    bucket.tokens + elapsedSec * RATE_PER_SECOND
  );
  bucket.lastRefill = now;
}

async function acquireToken() {
  while (true) {
    refillBucket();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const needed = 1 - bucket.tokens;
    const waitMs = Math.ceil((needed / RATE_PER_SECOND) * 1000);
    await sleep(waitMs);
  }
}

// ─── Helpers ───────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter() {
  return Math.floor(Math.random() * JITTER_MS);
}

function isRetriable(err) {
  if (!err) return false;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return true;
  const status = err.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (err.message && /timeout/i.test(err.message)) return true;
  return false;
}

function computeDelay(err, attempt) {
  const headers = err?.response?.headers || {};
  const resetMs = parseInt(headers['x-rate-limit-reset'] || headers['X-Rate-Limit-Reset'] || '0', 10);
  if (err?.response?.status === 429 && resetMs > 0) {
    return Math.min(resetMs + jitter(), MAX_BACKOFF_MS);
  }
  const exp = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  return Math.min(exp + jitter(), MAX_BACKOFF_MS);
}

function summarizeUrl(url) {
  if (!url) return '?';
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search || ''}`;
  } catch {
    return url;
  }
}

// ─── API ───────────────────────────────────────────────────

/**
 * Ejecuta una escritura a Tiendanube con rate limit + retry.
 *
 * @param {object} config - config de axios (method, url, data, headers, timeout)
 * @param {object} [opts]
 * @param {string} [opts.context] - etiqueta libre para logs (ej. "mark-paid#123")
 * @returns {Promise<AxiosResponse>}
 */
async function callTiendanubeWrite(config, opts = {}) {
  const { context = '' } = opts;
  const method = (config.method || 'get').toUpperCase();
  const urlSummary = summarizeUrl(config.url);
  const tag = context ? `[${context}] ` : '';

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await acquireToken();
    const started = Date.now();
    try {
      const resp = await callTiendanube(config);
      const latency = Date.now() - started;
      const rem = resp?.headers?.['x-rate-limit-remaining'];
      console.log(
        `[tn-write] ${tag}${method} ${urlSummary} attempt=${attempt} status=${resp.status} latency=${latency}ms${rem !== undefined ? ` rate-remaining=${rem}` : ''}`
      );
      return resp;
    } catch (err) {
      lastErr = err;
      const latency = Date.now() - started;
      const status = err?.response?.status || err?.code || 'ERR';
      const retriable = isRetriable(err);
      const isFinal = attempt === MAX_RETRIES || !retriable;
      if (isFinal) {
        console.error(
          `[tn-write] ${tag}${method} ${urlSummary} FAILED attempt=${attempt} status=${status} latency=${latency}ms retriable=${retriable}`
        );
        throw err;
      }
      const delayMs = computeDelay(err, attempt);
      console.warn(
        `[tn-write] ${tag}${method} ${urlSummary} attempt=${attempt} status=${status} latency=${latency}ms → retry in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function getTnWriteMetrics() {
  refillBucket();
  return {
    rate_per_second: RATE_PER_SECOND,
    bucket_capacity: BUCKET_CAPACITY,
    tokens_available: Math.floor(bucket.tokens),
    max_retries: MAX_RETRIES,
  };
}

module.exports = {
  callTiendanubeWrite,
  getTnWriteMetrics,
};
