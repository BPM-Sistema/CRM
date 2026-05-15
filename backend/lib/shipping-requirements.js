/**
 * Tabla unica de requisitos por metodo de envio.
 *
 * Define que necesita un pedido para avanzar segun el metodo, y centraliza
 * los checks que antes estaban escritos a mano en 7+ lugares (pre-imprimir,
 * trigger post-empaquetado, validaciones HTTP, constraint DB).
 *
 * Reglas (definidas por negocio 2026-05-14):
 *   Retiro                   → pago en (parcial, total, a_favor). Sin datos.
 *   Via Cargo / Expreso elec → pago en (total, a_favor) + shipping_request cargado.
 *   Envio Nube / resto       → pago en (total, a_favor). Datos vienen de TN.
 *
 * Para "imprimir hoja de pedido" (pre-imprimir) chequeamos pago + datos.
 * Para "despachar" (avanzar de empaquetado a pendiente_retiro/por_enviar)
 * solo chequeamos pago — los datos ya fueron validados pre-imprimir.
 */

const { esRetiro, requiresShippingForm } = require('./estados-pedido');

const PAGOS_OK_PARCIAL = ['confirmado_parcial', 'confirmado_total', 'a_favor'];
const PAGOS_OK_TOTAL   = ['confirmado_total', 'a_favor'];

function getRequirements(shippingType) {
  if (esRetiro({ shipping_type: shippingType })) return { minPago: 'parcial', requiereDatos: false };
  if (requiresShippingForm(shippingType))        return { minPago: 'total',   requiereDatos: true  };
  return                                           { minPago: 'total',   requiereDatos: false };
}

function _pagoAlcanza(estadoPago, shippingType) {
  const { minPago } = getRequirements(shippingType);
  const lista = minPago === 'parcial' ? PAGOS_OK_PARCIAL : PAGOS_OK_TOTAL;
  return lista.includes(estadoPago);
}

/**
 * Chequeo pre-imprimir: pago + datos. Usado por resolveEstadoInicial.
 * @returns {boolean} true si el pedido puede pasar a a_imprimir.
 */
function cumpleRequisitosImpresion(estadoPago, shippingType, hasShippingRequest) {
  const { requiereDatos } = getRequirements(shippingType);
  if (requiereDatos && !hasShippingRequest) return false;
  return _pagoAlcanza(estadoPago, shippingType);
}

/**
 * Motivo de bloqueo pre-imprimir. Devuelve null si esta listo para imprimir,
 * o 'pago' / 'datos' segun que le falta. Usado para decidir entre los estados
 * pendiente_pago / pendiente_datos_envio / a_imprimir.
 */
function motivoBloqueoImpresion(estadoPago, shippingType, hasShippingRequest) {
  if (!_pagoAlcanza(estadoPago, shippingType)) return 'pago';
  const { requiereDatos } = getRequirements(shippingType);
  if (requiereDatos && !hasShippingRequest) return 'datos';
  return null;
}

/**
 * Chequeo post-empaquetado: solo pago. Usado por triggers que derivan de
 * empaquetado a pendiente_retiro / por_enviar.
 */
function pagoAlcanzaParaDespachar(estadoPago, shippingType) {
  return _pagoAlcanza(estadoPago, shippingType);
}

module.exports = {
  PAGOS_OK_PARCIAL,
  PAGOS_OK_TOTAL,
  getRequirements,
  cumpleRequisitosImpresion,
  motivoBloqueoImpresion,
  pagoAlcanzaParaDespachar,
};
