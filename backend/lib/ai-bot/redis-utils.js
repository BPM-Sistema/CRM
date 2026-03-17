const { getRedisClient } = require('../redis');
const { integrationLogger: log } = require('../logger');

/**
 * Distributed deduplication using Redis SET NX with TTL
 * Returns true if this is a NEW event (not a duplicate)
 */
async function dedupEvent(eventId, ttlSeconds = 86400) {
  const client = getRedisClient();
  if (!client) return true; // If no Redis, allow through (DB will catch dupes)

  const key = `aibot:dedup:${eventId}`;
  const result = await client.set(key, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK'; // true = new, false = duplicate
}

/**
 * Distributed rate limiter using Redis sliding window
 * Returns { allowed: boolean, remaining: number, resetIn: number }
 */
async function checkRateLimit(limitKey, maxRequests, windowSeconds) {
  const client = getRedisClient();
  if (!client) return { allowed: true, remaining: maxRequests, resetIn: 0 };

  const key = `aibot:ratelimit:${limitKey}`;
  const now = Date.now();
  const windowStart = now - (windowSeconds * 1000);

  // Use Redis pipeline for atomicity
  const pipeline = client.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart); // Remove old entries
  pipeline.zadd(key, now, `${now}:${Math.random()}`); // Add current
  pipeline.zcard(key); // Count in window
  pipeline.expire(key, windowSeconds); // Set TTL

  const results = await pipeline.exec();
  const count = results[2][1]; // zcard result

  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetIn: windowSeconds
  };
}

/**
 * Distributed lock using Redis SET NX with TTL
 * For preventing concurrent processing of same event
 */
async function acquireLock(lockKey, ttlMs = 30000) {
  const client = getRedisClient();
  if (!client) return true;

  const key = `aibot:lock:${lockKey}`;
  const result = await client.set(key, process.pid.toString(), 'PX', ttlMs, 'NX');
  return result === 'OK';
}

async function releaseLock(lockKey) {
  const client = getRedisClient();
  if (!client) return;

  const key = `aibot:lock:${lockKey}`;
  await client.del(key);
}

/**
 * Simple cache with TTL
 */
async function cacheGet(cacheKey) {
  const client = getRedisClient();
  if (!client) return null;

  const val = await client.get(`aibot:cache:${cacheKey}`);
  return val ? JSON.parse(val) : null;
}

async function cacheSet(cacheKey, value, ttlSeconds = 60) {
  const client = getRedisClient();
  if (!client) return;

  await client.set(`aibot:cache:${cacheKey}`, JSON.stringify(value), 'EX', ttlSeconds);
}

module.exports = { dedupEvent, checkRateLimit, acquireLock, releaseLock, cacheGet, cacheSet };
