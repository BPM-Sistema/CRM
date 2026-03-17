/**
 * Rate limiting middleware for security
 */

const rateLimit = require('express-rate-limit');

// Skip rate limiting in test environment
const skipInTest = process.env.NODE_ENV === 'test';

// Login: 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Demasiados intentos de login. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// Public upload: 20 uploads per hour per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: 'Demasiadas subidas. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// Order validation: 30 requests per hour per IP
const validationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: { error: 'Demasiadas consultas. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// Shipping form: 10 submissions per hour per IP
const shippingFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Demasiados envíos. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// General API: 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipInTest,
});

// WhatsApp leads: 10 submissions per hour per IP
const leadsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Demasiados envíos. Intenta de nuevo más tarde.' },
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
  apiLimiter,
};
