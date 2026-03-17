const CircuitBreaker = require('opossum');

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

// Pre-configured breakers with dummy functions (to be connected to real functions later)
const dummyFn = async () => {
  throw new Error('Breaker not connected to a real function yet');
};

const tiendanubeBreaker = createBreaker('tiendanube', dummyFn, { timeout: 20000 });
const botmakerBreaker = createBreaker('botmaker', dummyFn, { timeout: 10000 });
const googleVisionBreaker = createBreaker('googleVision', dummyFn, { timeout: 30000 });
const supabaseStorageBreaker = createBreaker('supabaseStorage', dummyFn, { timeout: 15000 });

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
  supabaseStorageBreaker
};
