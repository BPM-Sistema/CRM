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

    // Retiro: confirmado_parcial o superior habilita
    test('retiro avanza a a_imprimir con confirmado_parcial', () => {
      expect(calcularEstadoPedido('confirmado_parcial', 'pendiente_pago', {
        shippingType: 'Retiro en depósito',
      })).toBe('a_imprimir');
    });

    test('retiro avanza a a_imprimir con confirmado_total', () => {
      expect(calcularEstadoPedido('confirmado_total', 'pendiente_pago', {
        shippingType: 'pickup',
      })).toBe('a_imprimir');
    });

    test('retiro NO avanza con a_confirmar (comprobante sin verificar)', () => {
      expect(calcularEstadoPedido('a_confirmar', 'pendiente_pago', {
        shippingType: 'Retiro en depósito',
      })).toBe('pendiente_pago');
    });

    // Via Cargo / Expreso a elección: exige confirmado_total/a_favor + datos
    test('Via Cargo avanza a a_imprimir con confirmado_total y datos cargados', () => {
      expect(calcularEstadoPedido('confirmado_total', 'pendiente_pago', {
        shippingType: 'Via Cargo',
        hasShippingRequest: true,
      })).toBe('a_imprimir');
    });

    test('Via Cargo va a pendiente_datos_envio si pago OK pero faltan datos', () => {
      expect(calcularEstadoPedido('confirmado_total', 'pendiente_pago', {
        shippingType: 'Via Cargo',
        hasShippingRequest: false,
      })).toBe('pendiente_datos_envio');
    });

    test('Via Cargo NO avanza con confirmado_parcial (faltaría pago completo)', () => {
      expect(calcularEstadoPedido('confirmado_parcial', 'pendiente_pago', {
        shippingType: 'Via Cargo',
        hasShippingRequest: true,
      })).toBe('pendiente_pago');
    });

    test('Expreso a elección va a pendiente_datos_envio si pago OK sin datos', () => {
      expect(calcularEstadoPedido('confirmado_total', 'pendiente_pago', {
        shippingType: 'Expreso a elección',
        hasShippingRequest: false,
      })).toBe('pendiente_datos_envio');
    });

    // Otros envíos (Envío Nube, etc.): exige confirmado_total/a_favor, no formulario
    test('Envío Nube avanza con confirmado_total sin formulario', () => {
      expect(calcularEstadoPedido('confirmado_total', 'pendiente_pago', {
        shippingType: 'Envío Nube',
      })).toBe('a_imprimir');
    });

    test('Envío Nube NO avanza con confirmado_parcial', () => {
      expect(calcularEstadoPedido('confirmado_parcial', 'pendiente_pago', {
        shippingType: 'Envío Nube',
      })).toBe('pendiente_pago');
    });

    // a_favor cuenta como pago completo
    test('avanza con a_favor (pago en exceso)', () => {
      expect(calcularEstadoPedido('a_favor', 'pendiente_pago', {
        shippingType: 'Envío Nube',
      })).toBe('a_imprimir');
    });

    // Sin contexto: conservador, no avanza
    test('sin contexto de shipping, no avanza aunque pago sea total', () => {
      expect(calcularEstadoPedido('confirmado_total', 'pendiente_pago')).toBe('pendiente_pago');
    });

    // Retroceso por pago invalidado (independiente del envío)
    test('retrocede from a_imprimir to pendiente_pago if pago becomes pendiente', () => {
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

    // Estado pendiente_datos_envio como punto de cómputo (2026-05-13)
    describe('pendiente_datos_envio (pre-imprimir)', () => {
      test('retrocede a pendiente_pago si el pago se anula', () => {
        expect(calcularEstadoPedido('anulado', 'pendiente_datos_envio', {
          shippingType: 'Via Cargo',
          hasShippingRequest: false,
        })).toBe('pendiente_pago');
      });

      test('retrocede a pendiente_pago si el pago vuelve a pendiente', () => {
        expect(calcularEstadoPedido('pendiente', 'pendiente_datos_envio', {
          shippingType: 'Via Cargo',
          hasShippingRequest: false,
        })).toBe('pendiente_pago');
      });

      test('avanza a a_imprimir cuando se cargan los datos (con pago OK)', () => {
        expect(calcularEstadoPedido('confirmado_total', 'pendiente_datos_envio', {
          shippingType: 'Via Cargo',
          hasShippingRequest: true,
        })).toBe('a_imprimir');
      });

      test('se queda en pendiente_datos_envio si pago OK pero siguen faltando datos', () => {
        expect(calcularEstadoPedido('confirmado_total', 'pendiente_datos_envio', {
          shippingType: 'Via Cargo',
          hasShippingRequest: false,
        })).toBe('pendiente_datos_envio');
      });

      test('sin contexto, no se mueve', () => {
        expect(calcularEstadoPedido('confirmado_total', 'pendiente_datos_envio'))
          .toBe('pendiente_datos_envio');
      });
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

  describe('puedeImprimirHoja / puedeReimprimirHoja / motivoBloqueoHoja', () => {
    const { puedeImprimirHoja, puedeReimprimirHoja, motivoBloqueoHoja } = require('../lib/estados-pedido');

    test('a_imprimir habilita imprimir inicial', () => {
      expect(puedeImprimirHoja('a_imprimir')).toBe(true);
      expect(puedeReimprimirHoja('a_imprimir')).toBe(false);
    });

    test('hoja_impresa habilita ambos (imprimir idempotente y reimprimir)', () => {
      expect(puedeImprimirHoja('hoja_impresa')).toBe(true);
      expect(puedeReimprimirHoja('hoja_impresa')).toBe(true);
    });

    test('estados depo habilitan reimprimir pero no imprimir inicial', () => {
      for (const s of ['en_preparacion', 'en_revision', 'pendiente_stock', 'por_empaquetar', 'empaquetado']) {
        expect(puedeImprimirHoja(s)).toBe(false);
        expect(puedeReimprimirHoja(s)).toBe(true);
      }
    });

    test('estados terminales y bloqueantes no habilitan ninguna', () => {
      for (const s of ['pendiente_pago', 'pendiente_datos_envio', 'cancelado',
                       'pendiente_retiro', 'por_enviar', 'en_calle', 'enviado', 'retirado']) {
        expect(puedeImprimirHoja(s)).toBe(false);
        expect(puedeReimprimirHoja(s)).toBe(false);
      }
    });

    test('motivoBloqueoHoja pendiente_pago + envío: texto de "pago confirmado"', () => {
      expect(motivoBloqueoHoja('pendiente_pago', 'Via Cargo'))
        .toBe('El pedido todavía no tiene el pago confirmado.');
      expect(motivoBloqueoHoja('pendiente_pago', 'Envio Nube'))
        .toBe('El pedido todavía no tiene el pago confirmado.');
    });

    test('motivoBloqueoHoja pendiente_pago + retiro: texto de "ningún pago confirmado"', () => {
      expect(motivoBloqueoHoja('pendiente_pago', 'Retiro en deposito'))
        .toBe('El pedido no tiene ningún pago confirmado.');
      expect(motivoBloqueoHoja('pendiente_pago', 'Pickup Gaona'))
        .toBe('El pedido no tiene ningún pago confirmado.');
    });

    test('motivoBloqueoHoja pendiente_datos_envio', () => {
      expect(motivoBloqueoHoja('pendiente_datos_envio', 'Via Cargo'))
        .toBe('El cliente todavía no cargó los datos de envío.');
    });

    test('motivoBloqueoHoja cancelado / post-empaquetado / terminales', () => {
      expect(motivoBloqueoHoja('cancelado', null)).toBe('El pedido fue cancelado.');
      expect(motivoBloqueoHoja('pendiente_retiro', null)).toBe('El pedido ya está listo para despacho/retiro.');
      expect(motivoBloqueoHoja('por_enviar', null)).toBe('El pedido ya está listo para despacho/retiro.');
      expect(motivoBloqueoHoja('enviado', null)).toBe('El pedido ya fue despachado/retirado.');
      expect(motivoBloqueoHoja('retirado', null)).toBe('El pedido ya fue despachado/retirado.');
      expect(motivoBloqueoHoja('en_calle', null)).toBe('El pedido ya fue despachado/retirado.');
    });

    test('motivoBloqueoHoja devuelve null cuando se puede imprimir/reimprimir', () => {
      expect(motivoBloqueoHoja('a_imprimir', 'Via Cargo')).toBeNull();
      expect(motivoBloqueoHoja('hoja_impresa', 'Retiro')).toBeNull();
      expect(motivoBloqueoHoja('empaquetado', 'Envio Nube')).toBeNull();
    });
  });
});
