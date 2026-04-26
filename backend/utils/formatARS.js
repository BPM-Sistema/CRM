/**
 * Formatea un monto como pesos argentinos para mostrar al cliente.
 * Convención: redondea a entero (no manejamos centavos en pedidos), separa
 * miles con punto y prefija "$". Ejemplo: 112140 → "$112.140".
 *
 * Uso: variables de templates de WhatsApp que mostrarán un monto al cliente.
 * NO usar para almacenamiento ni cálculos — la DB guarda numeric.
 */
function formatARS(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return '$' + Math.round(n).toLocaleString('es-AR');
}

module.exports = { formatARS };
