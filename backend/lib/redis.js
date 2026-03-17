const Redis = require('ioredis');

let redis = null;
let connected = false;

function createRedisClient() {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;

  if (!redisUrl && !redisHost) {
    console.warn('[Redis] No REDIS_URL or REDIS_HOST configured. Redis features disabled.');
    return null;
  }

  const options = {
    retryStrategy(times) {
      const delay = Math.min(times * 500, 30000);
      console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false
  };

  let client;

  if (redisUrl) {
    client = new Redis(redisUrl, options);
  } else {
    client = new Redis({
      host: redisHost,
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      ...options
    });
  }

  client.on('connect', () => {
    console.log('[Redis] Connected');
    connected = true;
  });

  client.on('ready', () => {
    console.log('[Redis] Ready');
    connected = true;
  });

  client.on('error', (err) => {
    console.error('[Redis] Error:', err.message);
    connected = false;
  });

  client.on('close', () => {
    console.log('[Redis] Connection closed');
    connected = false;
  });

  return client;
}

redis = createRedisClient();

function isRedisConnected() {
  return connected && redis !== null;
}

/**
 * Null-safe client - returns null if Redis is not available.
 * Usage: const client = getRedisClient(); if (client) { ... }
 */
function getRedisClient() {
  if (!redis || !connected) return null;
  return redis;
}

module.exports = {
  redis,
  isRedisConnected,
  getRedisClient
};
