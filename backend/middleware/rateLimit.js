/**
 * Rate limiting middleware for security
 * Uses Redis store when available, falls back to in-memory store
 */

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedisClient } = require('../lib/redis');

// Skip rate limiting in test environment
const skipInTest = process.env.NODE_ENV === 'test';

// Extract real client IP behind Cloud Run proxy
function realIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip;
}

/**
 * Create a RedisStore for rate limiting if Redis is available.
 * Returns undefined (fallback to in-memory) if Redis is not connected.
 */
function createStore(prefix) {
  const client = getRedisClient();
  if (!client) return undefined;
  return new RedisStore({
    sendCommand: (...args) => client.call(...args),
    prefix: `rl:${prefix}:`,
  });
}

// Login: 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  store: createStore('login'),
  keyGenerator: realIp,
  message: { error: 'Demasiados intentos de login. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// Public upload: 200 uploads per hour per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 200,
  store: createStore('upload'),
  keyGenerator: realIp,
  message: { error: 'Demasiadas subidas. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// Order validation: 100 requests per hour per IP
const validationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  store: createStore('validation'),
  keyGenerator: realIp,
  message: { error: 'Demasiadas consultas. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// Shipping form: 50 submissions per hour per IP
const shippingFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  store: createStore('shipping'),
  keyGenerator: realIp,
  message: { error: 'Demasiados envíos. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// WhatsApp leads: 20 submissions per hour per IP
const leadsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  store: createStore('leads'),
  keyGenerator: realIp,
  message: { error: 'Demasiados envíos. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// Stock alerts (back-in-stock): 30 submissions per hour per IP
const stockAlertsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  store: createStore('stock_alerts'),
  keyGenerator: realIp,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// General API: 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  store: createStore('api'),
  keyGenerator: realIp,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

module.exports = {
  loginLimiter,
  uploadLimiter,
  validationLimiter,
  shippingFormLimiter,
  leadsLimiter,
  stockAlertsLimiter,
  apiLimiter,
};
