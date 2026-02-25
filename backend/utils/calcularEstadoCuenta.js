/**
 * Calcula el estado de cuenta basado en pagos y monto de TiendaNube
 *
 * Lógica extraída de index.js (líneas 3010-3021)
 * NO MODIFICAR sin actualizar también index.js
 *
 * @param {number} totalPagado - Suma de todos los comprobantes/pagos
 * @param {number} montoTiendanube - Monto total del pedido en TiendaNube
 * @returns {{ estado: string, cuenta: number }}
 */

const TOLERANCIA = 1000;

function calcularEstadoCuenta(totalPagado, montoTiendanube) {
  // Lógica EXACTA de index.js
  const cuenta = Math.round(montoTiendanube - totalPagado);

  let estado = 'pendiente'; // valor inicial (nunca se usa en práctica)

  if (Math.abs(cuenta) <= TOLERANCIA) {
    estado = 'ok';
  } else if (cuenta > 0) {
    estado = 'debe';
  } else {
    estado = 'a_favor';
  }

  return { estado, cuenta };
}

module.exports = {
  calcularEstadoCuenta,
  TOLERANCIA
};
