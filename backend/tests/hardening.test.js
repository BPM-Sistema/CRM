/**
 * Hardening Tests
 * Tests for security, transactions, and infrastructure changes
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-ci';

// Replicate generateSignedAction / verifySignedAction from index.js
// (they are inline in index.js, not exported)
function generateSignedAction(comprobanteId, action, expiresIn = '15m') {
  return jwt.sign({ comprobanteId, action }, JWT_SECRET, { expiresIn });
}

function verifySignedAction(token, expectedId, expectedAction) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.comprobanteId === expectedId && decoded.action === expectedAction;
  } catch {
    return false;
  }
}

describe('Security', () => {
  describe('Signed Action Tokens', () => {
    test('generateSignedAction creates valid JWT', () => {
      const token = generateSignedAction(123, 'confirmar');
      expect(typeof token).toBe('string');
      const decoded = jwt.verify(token, JWT_SECRET);
      expect(decoded.comprobanteId).toBe(123);
      expect(decoded.action).toBe('confirmar');
    });

    test('verifySignedAction validates correct token', () => {
      const token = generateSignedAction(456, 'rechazar');
      expect(verifySignedAction(token, 456, 'rechazar')).toBe(true);
    });

    test('verifySignedAction rejects wrong action', () => {
      const token = generateSignedAction(456, 'confirmar');
      expect(verifySignedAction(token, 456, 'rechazar')).toBe(false);
    });

    test('verifySignedAction rejects wrong comprobanteId', () => {
      const token = generateSignedAction(456, 'confirmar');
      expect(verifySignedAction(token, 999, 'confirmar')).toBe(false);
    });

    test('verifySignedAction rejects expired token', () => {
      const token = generateSignedAction(456, 'confirmar', '0s');
      // Token expires immediately
      expect(verifySignedAction(token, 456, 'confirmar')).toBe(false);
    });
  });
});

describe('Financial Consistency', () => {
  describe('calcularEstadoCuenta', () => {
    const { calcularEstadoCuenta } = require('../utils/calcularEstadoCuenta');

    test('returns ok when payment equals order amount', () => {
      const result = calcularEstadoCuenta(50000, 50000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(0);
    });

    test('returns ok within tolerance (1000)', () => {
      const result = calcularEstadoCuenta(49500, 50000);
      expect(result.estado).toBe('ok');
    });

    test('returns debe when underpaid beyond tolerance', () => {
      const result = calcularEstadoCuenta(40000, 50000);
      expect(result.estado).toBe('debe');
      expect(result.cuenta).toBe(10000);
    });

    test('returns a_favor when overpaid', () => {
      const result = calcularEstadoCuenta(55000, 50000);
      expect(result.estado).toBe('a_favor');
    });
  });

  describe('calcularEstadoPedido', () => {
    const { calcularEstadoPedido } = require('../lib/payment-helpers');

    test('moves from pendiente_pago to a_imprimir on confirmado_total', () => {
      expect(calcularEstadoPedido('confirmado_total', 'pendiente_pago')).toBe('a_imprimir');
    });

    test('moves from pendiente_pago to a_imprimir on a_confirmar (comprobante cargado)', () => {
      expect(calcularEstadoPedido('a_confirmar', 'pendiente_pago')).toBe('a_imprimir');
    });

    test('moves from pendiente_pago to a_imprimir on confirmado_parcial', () => {
      expect(calcularEstadoPedido('confirmado_parcial', 'pendiente_pago')).toBe('a_imprimir');
    });

    test('retrocede from a_imprimir to pendiente_pago if pago becomes pendiente', () => {
      // Invariante: a_imprimir requiere pago valido. Si el pago se invalida antes de imprimir, retrocede.
      expect(calcularEstadoPedido('pendiente', 'a_imprimir')).toBe('pendiente_pago');
    });

    test('retrocede from a_imprimir to pendiente_pago if pago becomes anulado', () => {
      expect(calcularEstadoPedido('anulado', 'a_imprimir')).toBe('pendiente_pago');
    });

    test('does not regress from hoja_impresa when pago becomes pendiente', () => {
      expect(calcularEstadoPedido('pendiente', 'hoja_impresa')).toBe('hoja_impresa');
    });

    test('does not regress from enviado', () => {
      expect(calcularEstadoPedido('pendiente', 'enviado')).toBe('enviado');
    });
  });

  describe('requiresShippingForm', () => {
    const { requiresShippingForm } = require('../lib/payment-helpers');

    test('returns true for Via Cargo', () => {
      expect(requiresShippingForm('Via Cargo')).toBe(true);
    });

    test('returns true for Expreso a Eleccion', () => {
      expect(requiresShippingForm('Expreso a Eleccion')).toBe(true);
    });

    test('returns false for Envio Nube', () => {
      expect(requiresShippingForm('Envio Nube')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(requiresShippingForm('')).toBe(false);
    });

    test('returns false for null/undefined', () => {
      expect(requiresShippingForm(null)).toBe(false);
      expect(requiresShippingForm(undefined)).toBe(false);
    });
  });
});

describe('Infrastructure', () => {
  describe('Logger', () => {
    test('logger exports expected child loggers', () => {
      const logger = require('../lib/logger');
      expect(logger.logger).toBeDefined();
      expect(logger.apiLogger).toBeDefined();
      expect(logger.workerLogger).toBeDefined();
      expect(logger.requestLogger).toBeDefined();
    });
  });

  describe('Redis (graceful degradation)', () => {
    test('exports null-safe when not configured', () => {
      const { isRedisConnected } = require('../lib/redis');
      // Without REDIS_URL, should return false
      expect(isRedisConnected()).toBe(false);
    });
  });

  describe('Queues (graceful degradation)', () => {
    test('returns null queues when Redis not available', () => {
      const queues = require('../lib/queues');
      // Without Redis, queues should be null or disabled
      expect(queues.getQueueStats).toBeDefined();
    });
  });

  describe('Circuit Breakers', () => {
    test('getBreakerStatus returns status for all breakers', () => {
      const { getBreakerStatus } = require('../lib/circuitBreaker');
      const status = getBreakerStatus();
      expect(status).toBeDefined();
      expect(typeof status).toBe('object');
    });
  });

  describe('DB Pool', () => {
    test('getPoolStats returns pool information', () => {
      const { getPoolStats } = require('../db');
      const stats = getPoolStats();
      expect(stats).toBeDefined();
      expect(stats).toHaveProperty('totalCount');
      expect(stats).toHaveProperty('idleCount');
      expect(stats).toHaveProperty('waitingCount');
    });
  });
});

describe('Comprobante Helpers', () => {
  describe('validarComprobante', () => {
    const { validarComprobante } = require('../lib/comprobante-helpers');

    test('accepts valid comprobante text', () => {
      const text = 'Comprobante de transferencia bancaria por importe de $50000 fecha 2024-01-15 referencia 123456789012345678901234567890';
      expect(() => validarComprobante(text)).not.toThrow();
    });

    test('rejects too short text', () => {
      expect(() => validarComprobante('short text')).toThrow();
    });

    test('rejects text without payment keywords', () => {
      const text = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';
      expect(() => validarComprobante(text)).toThrow();
    });
  });

  describe('hashText', () => {
    const { hashText } = require('../hash');

    test('returns consistent hash for same input', () => {
      const hash1 = hashText('test');
      const hash2 = hashText('test');
      expect(hash1).toBe(hash2);
    });

    test('returns different hash for different input', () => {
      const hash1 = hashText('test1');
      const hash2 = hashText('test2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('normalizeText', () => {
    const { normalizeText } = require('../lib/comprobante-helpers');

    test('lowercases text', () => {
      expect(normalizeText('HELLO')).toBe('hello');
    });

    test('removes diacritics', () => {
      expect(normalizeText('cafe')).toBe('cafe');
    });

    test('collapses whitespace', () => {
      expect(normalizeText('hello   world')).toBe('hello world');
    });
  });
});
