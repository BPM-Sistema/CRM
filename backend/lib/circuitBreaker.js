const CircuitBreaker = require('opossum');
const axios = require('axios');
const { alerts } = require('./alerts');

const breakers = new Map();

const DEFAULT_OPTIONS = {
  timeout: 15000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5
};

/**
 * Factory function to create a circuit breaker.
 * @param {string} name - Unique name for this breaker
 * @param {Function} fn - The function to wrap
 * @param {object} options - opossum options (merged with defaults)
 * @returns {CircuitBreaker}
 */
function createBreaker(name, fn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options, name };
  const breaker = new CircuitBreaker(fn, opts);

  breaker.on('open', () => {
    console.log(`[CircuitBreaker] ${name}: OPEN (requests will be rejected)`);
    alerts.circuitBreakerOpen(name);
  });

  breaker.on('halfOpen', () => {
    console.log(`[CircuitBreaker] ${name}: HALF-OPEN (testing next request)`);
  });

  breaker.on('close', () => {
    console.log(`[CircuitBreaker] ${name}: CLOSED (back to normal)`);
  });

  breaker.on('fallback', () => {
    console.log(`[CircuitBreaker] ${name}: Fallback invoked`);
  });

  breakers.set(name, breaker);
  return breaker;
}

// Wrapped functions for each external service
async function tiendanubeRequest(config) {
  return axios(config);
}

async function botmakerRequest(config) {
  return axios(config);
}

async function googleVisionRequest(config) {
  return axios(config);
}

async function supabaseStorageRequest(config) {
  return axios(config);
}

// Pre-configured breakers connected to real axios calls
const tiendanubeBreaker = createBreaker('tiendanube', tiendanubeRequest, { timeout: 20000 });
const botmakerBreaker = createBreaker('botmaker', botmakerRequest, { timeout: 10000 });
const googleVisionBreaker = createBreaker('googleVision', googleVisionRequest, { timeout: 30000 });
const supabaseStorageBreaker = createBreaker('supabaseStorage', supabaseStorageRequest, { timeout: 15000 });

/**
 * Call Tiendanube API through circuit breaker.
 * @param {object} config - axios request config
 * @returns {Promise} axios response
 */
async function callTiendanube(config) {
  return tiendanubeBreaker.fire(config);
}

/**
 * Call Botmaker API through circuit breaker.
 * @param {object} config - axios request config
 * @returns {Promise} axios response
 */
async function callBotmaker(config) {
  return botmakerBreaker.fire(config);
}

/**
 * Call Google Vision API through circuit breaker.
 * @param {object} config - axios request config
 * @returns {Promise} axios response
 */
async function callGoogleVision(config) {
  return googleVisionBreaker.fire(config);
}

/**
 * Call Supabase Storage through circuit breaker.
 * @param {object} config - axios request config
 * @returns {Promise} axios response
 */
async function callSupabaseStorage(config) {
  return supabaseStorageBreaker.fire(config);
}

/**
 * Returns status of all registered circuit breakers.
 */
function getBreakerStatus() {
  const status = {};
  for (const [name, breaker] of breakers) {
    const stats = breaker.stats;
    status[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'halfOpen' : 'closed',
      stats: {
        successes: stats.successes,
        failures: stats.failures,
        timeouts: stats.timeouts,
        rejects: stats.rejects
      }
    };
  }
  return status;
}

module.exports = {
  createBreaker,
  getBreakerStatus,
  tiendanubeBreaker,
  botmakerBreaker,
  googleVisionBreaker,
  supabaseStorageBreaker,
  callTiendanube,
  callBotmaker,
  callGoogleVision,
  callSupabaseStorage
};
