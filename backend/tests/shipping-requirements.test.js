/**
 * Tests del helper central de requisitos por metodo de envio.
 *
 * Cubre las 3 ramas de getRequirements + las funciones que se apoyan en ella:
 *   - cumpleRequisitosImpresion (pre-imprimir, pago + datos)
 *   - motivoBloqueoImpresion    (pago / datos / null)
 *   - pagoAlcanzaParaDespachar  (post-empaquetado, solo pago)
 */

const {
  getRequirements,
  cumpleRequisitosImpresion,
  motivoBloqueoImpresion,
  pagoAlcanzaParaDespachar,
} = require('../lib/shipping-requirements');

describe('shipping-requirements', () => {
  describe('getRequirements', () => {
    test('retiro: minPago=parcial, requiereDatos=false', () => {
      expect(getRequirements('Retiro en deposito')).toEqual({ minPago: 'parcial', requiereDatos: false });
      expect(getRequirements('Pickup Gaona')).toEqual({ minPago: 'parcial', requiereDatos: false });
    });

    test('Via Cargo: minPago=total, requiereDatos=true', () => {
      expect(getRequirements('Via Cargo')).toEqual({ minPago: 'total', requiereDatos: true });
      expect(getRequirements('ViaCargo')).toEqual({ minPago: 'total', requiereDatos: true });
    });

    test('Expreso a elección: minPago=total, requiereDatos=true', () => {
      expect(getRequirements('Expreso a elección del cliente')).toEqual({ minPago: 'total', requiereDatos: true });
    });

    test('Envio Nube / resto: minPago=total, requiereDatos=false', () => {
      expect(getRequirements('Envio Nube')).toEqual({ minPago: 'total', requiereDatos: false });
      expect(getRequirements('Andreani')).toEqual({ minPago: 'total', requiereDatos: false });
      expect(getRequirements(null)).toEqual({ minPago: 'total', requiereDatos: false });
    });
  });

  describe('cumpleRequisitosImpresion', () => {
    test('retiro: confirmado_parcial alcanza sin datos', () => {
      expect(cumpleRequisitosImpresion('confirmado_parcial', 'Retiro', false)).toBe(true);
    });

    test('retiro: confirmado_total alcanza sin datos', () => {
      expect(cumpleRequisitosImpresion('confirmado_total', 'Retiro', false)).toBe(true);
    });

    test('retiro: a_favor alcanza sin datos', () => {
      expect(cumpleRequisitosImpresion('a_favor', 'Retiro', false)).toBe(true);
    });

    test('retiro: pendiente no alcanza', () => {
      expect(cumpleRequisitosImpresion('pendiente', 'Retiro', false)).toBe(false);
    });

    test('retiro: a_confirmar no alcanza (comprobante sin verificar)', () => {
      expect(cumpleRequisitosImpresion('a_confirmar', 'Retiro', false)).toBe(false);
    });

    test('Via Cargo: total + datos alcanza', () => {
      expect(cumpleRequisitosImpresion('confirmado_total', 'Via Cargo', true)).toBe(true);
    });

    test('Via Cargo: total sin datos NO alcanza', () => {
      expect(cumpleRequisitosImpresion('confirmado_total', 'Via Cargo', false)).toBe(false);
    });

    test('Via Cargo: parcial + datos NO alcanza (exige total)', () => {
      expect(cumpleRequisitosImpresion('confirmado_parcial', 'Via Cargo', true)).toBe(false);
    });

    test('Envio Nube: total alcanza sin necesidad de datos', () => {
      expect(cumpleRequisitosImpresion('confirmado_total', 'Envio Nube', false)).toBe(true);
    });

    test('Envio Nube: parcial no alcanza', () => {
      expect(cumpleRequisitosImpresion('confirmado_parcial', 'Envio Nube', false)).toBe(false);
    });
  });

  describe('motivoBloqueoImpresion', () => {
    test('retiro + parcial → null (listo)', () => {
      expect(motivoBloqueoImpresion('confirmado_parcial', 'Retiro', false)).toBeNull();
    });

    test('retiro + pendiente → "pago"', () => {
      expect(motivoBloqueoImpresion('pendiente', 'Retiro', false)).toBe('pago');
    });

    test('Via Cargo + total + datos → null (listo)', () => {
      expect(motivoBloqueoImpresion('confirmado_total', 'Via Cargo', true)).toBeNull();
    });

    test('Via Cargo + total + sin datos → "datos"', () => {
      expect(motivoBloqueoImpresion('confirmado_total', 'Via Cargo', false)).toBe('datos');
    });

    test('Via Cargo + parcial → "pago" (no llega a chequear datos)', () => {
      expect(motivoBloqueoImpresion('confirmado_parcial', 'Via Cargo', true)).toBe('pago');
    });

    test('Envio Nube + total → null', () => {
      expect(motivoBloqueoImpresion('confirmado_total', 'Envio Nube', false)).toBeNull();
    });
  });

  describe('pagoAlcanzaParaDespachar', () => {
    test('retiro + parcial alcanza (regla nueva 2026-05-14)', () => {
      expect(pagoAlcanzaParaDespachar('confirmado_parcial', 'Retiro')).toBe(true);
    });

    test('retiro + total alcanza', () => {
      expect(pagoAlcanzaParaDespachar('confirmado_total', 'Retiro')).toBe(true);
    });

    test('retiro + a_favor alcanza', () => {
      expect(pagoAlcanzaParaDespachar('a_favor', 'Retiro')).toBe(true);
    });

    test('retiro + pendiente NO alcanza', () => {
      expect(pagoAlcanzaParaDespachar('pendiente', 'Retiro')).toBe(false);
    });

    test('Envio Nube + parcial NO alcanza (envio exige total)', () => {
      expect(pagoAlcanzaParaDespachar('confirmado_parcial', 'Envio Nube')).toBe(false);
    });

    test('Envio Nube + total alcanza', () => {
      expect(pagoAlcanzaParaDespachar('confirmado_total', 'Envio Nube')).toBe(true);
    });

    test('Via Cargo + parcial NO alcanza', () => {
      expect(pagoAlcanzaParaDespachar('confirmado_parcial', 'Via Cargo')).toBe(false);
    });

    test('Via Cargo + total alcanza (datos ya fueron validados pre-imprimir)', () => {
      expect(pagoAlcanzaParaDespachar('confirmado_total', 'Via Cargo')).toBe(true);
    });
  });
});
