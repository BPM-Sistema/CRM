/**
 * Tests para calcularEstadoCuenta
 *
 * Esta función es crítica para el sistema financiero.
 * Calcula si el cliente pagó exacto, debe plata, o pagó de más.
 */

const { calcularEstadoCuenta, TOLERANCIA } = require('../utils/calcularEstadoCuenta');

describe('calcularEstadoCuenta', () => {
  // ----------------------------------------
  // Verificar constantes
  // ----------------------------------------
  describe('Constantes', () => {
    it('TOLERANCIA debería ser 1000', () => {
      expect(TOLERANCIA).toBe(1000);
    });
  });

  // ----------------------------------------
  // Caso 1: Pago exacto
  // ----------------------------------------
  describe('Pago exacto', () => {
    it('totalPagado = 10000, montoTN = 10000 → ok', () => {
      const result = calcularEstadoCuenta(10000, 10000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(0);
    });

    it('totalPagado = 50000, montoTN = 50000 → ok', () => {
      const result = calcularEstadoCuenta(50000, 50000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(0);
    });
  });

  // ----------------------------------------
  // Caso 2: Pago menor (cliente debe)
  // ----------------------------------------
  describe('Pago menor (cliente debe)', () => {
    it('totalPagado = 8000, montoTN = 10000 → debe', () => {
      const result = calcularEstadoCuenta(8000, 10000);
      expect(result.estado).toBe('debe');
      expect(result.cuenta).toBe(2000);
    });

    it('totalPagado = 0, montoTN = 10000 → debe', () => {
      const result = calcularEstadoCuenta(0, 10000);
      expect(result.estado).toBe('debe');
      expect(result.cuenta).toBe(10000);
    });

    it('totalPagado = 5000, montoTN = 100000 → debe', () => {
      const result = calcularEstadoCuenta(5000, 100000);
      expect(result.estado).toBe('debe');
      expect(result.cuenta).toBe(95000);
    });
  });

  // ----------------------------------------
  // Caso 3: Pago mayor (cliente a favor)
  // ----------------------------------------
  describe('Pago mayor (cliente a favor)', () => {
    it('totalPagado = 12000, montoTN = 10000 → a_favor', () => {
      const result = calcularEstadoCuenta(12000, 10000);
      expect(result.estado).toBe('a_favor');
      expect(result.cuenta).toBe(-2000);
    });

    it('totalPagado = 55000, montoTN = 50000 → a_favor', () => {
      const result = calcularEstadoCuenta(55000, 50000);
      expect(result.estado).toBe('a_favor');
      expect(result.cuenta).toBe(-5000);
    });
  });

  // ----------------------------------------
  // Caso 4: Diferencia dentro de tolerancia
  // ----------------------------------------
  describe('Diferencia dentro de tolerancia (±1000)', () => {
    it('totalPagado = 9500, montoTN = 10000 → ok (debe 500, dentro tolerancia)', () => {
      const result = calcularEstadoCuenta(9500, 10000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(500);
    });

    it('totalPagado = 9001, montoTN = 10000 → ok (debe 999, dentro tolerancia)', () => {
      const result = calcularEstadoCuenta(9001, 10000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(999);
    });

    it('totalPagado = 9000, montoTN = 10000 → ok (debe 1000, en el límite)', () => {
      const result = calcularEstadoCuenta(9000, 10000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(1000);
    });

    it('totalPagado = 8999, montoTN = 10000 → debe (debe 1001, fuera tolerancia)', () => {
      const result = calcularEstadoCuenta(8999, 10000);
      expect(result.estado).toBe('debe');
      expect(result.cuenta).toBe(1001);
    });

    it('totalPagado = 10500, montoTN = 10000 → ok (a favor 500, dentro tolerancia)', () => {
      const result = calcularEstadoCuenta(10500, 10000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(-500);
    });

    it('totalPagado = 11000, montoTN = 10000 → ok (a favor 1000, en el límite)', () => {
      const result = calcularEstadoCuenta(11000, 10000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(-1000);
    });

    it('totalPagado = 11001, montoTN = 10000 → a_favor (a favor 1001, fuera tolerancia)', () => {
      const result = calcularEstadoCuenta(11001, 10000);
      expect(result.estado).toBe('a_favor');
      expect(result.cuenta).toBe(-1001);
    });
  });

  // ----------------------------------------
  // Caso 5: Sin pagos
  // ----------------------------------------
  describe('Sin pagos', () => {
    it('totalPagado = 0, montoTN = 10000 → debe', () => {
      const result = calcularEstadoCuenta(0, 10000);
      expect(result.estado).toBe('debe');
      expect(result.cuenta).toBe(10000);
    });

    it('totalPagado = 0, montoTN = 500 → ok (monto menor que tolerancia)', () => {
      const result = calcularEstadoCuenta(0, 500);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(500);
    });
  });

  // ----------------------------------------
  // Caso 6: Valores decimales
  // ----------------------------------------
  describe('Valores decimales', () => {
    it('totalPagado = 10000.50, montoTN = 10000 → ok (redondea a -0)', () => {
      const result = calcularEstadoCuenta(10000.50, 10000);
      expect(result.estado).toBe('ok');
      // Math.round(10000 - 10000.50) = Math.round(-0.50) = -0 (JavaScript quirk)
      // -0 === 0 es true, pero Object.is(-0, 0) es false
      expect(result.cuenta === 0).toBe(true);
    });

    it('totalPagado = 10000.99, montoTN = 10000 → ok (redondea a -1)', () => {
      const result = calcularEstadoCuenta(10000.99, 10000);
      expect(result.estado).toBe('ok');
      // Math.round(10000 - 10000.99) = Math.round(-0.99) = -1
      expect(result.cuenta).toBe(-1);
    });

    it('totalPagado = 8000.25, montoTN = 10000 → debe', () => {
      const result = calcularEstadoCuenta(8000.25, 10000);
      expect(result.estado).toBe('debe');
      // Math.round(10000 - 8000.25) = Math.round(1999.75) = 2000
      expect(result.cuenta).toBe(2000);
    });
  });

  // ----------------------------------------
  // Caso 7: Estructura del resultado
  // ----------------------------------------
  describe('Estructura del resultado', () => {
    it('debería devolver objeto con estado y cuenta', () => {
      const result = calcularEstadoCuenta(5000, 10000);
      expect(result).toHaveProperty('estado');
      expect(result).toHaveProperty('cuenta');
    });

    it('estado debería ser string', () => {
      const result = calcularEstadoCuenta(5000, 10000);
      expect(typeof result.estado).toBe('string');
    });

    it('cuenta debería ser número', () => {
      const result = calcularEstadoCuenta(5000, 10000);
      expect(typeof result.cuenta).toBe('number');
    });
  });

  // ----------------------------------------
  // Casos edge
  // ----------------------------------------
  describe('Casos edge', () => {
    it('ambos valores en 0 → ok', () => {
      const result = calcularEstadoCuenta(0, 0);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(0);
    });

    it('valores muy grandes', () => {
      const result = calcularEstadoCuenta(1000000, 1000000);
      expect(result.estado).toBe('ok');
      expect(result.cuenta).toBe(0);
    });

    it('diferencia exactamente en -1001 → a_favor', () => {
      const result = calcularEstadoCuenta(11001, 10000);
      expect(result.estado).toBe('a_favor');
    });

    it('diferencia exactamente en +1001 → debe', () => {
      const result = calcularEstadoCuenta(8999, 10000);
      expect(result.estado).toBe('debe');
    });
  });
});
