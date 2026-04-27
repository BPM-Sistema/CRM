/**
 * Formatea un monto como número argentino con separador de miles.
 * Devuelve SIN símbolo "$" — el "$" lo trae hardcoded el copy del template
 * de Botmaker (ej. "Tu pago de ${{2}}"). Si la variable también lo trajera,
 * se duplicaría ("$$112.140"). Redondea a entero (los pedidos no manejan
 * centavos). Ejemplo: 112140 → "112.140".
 *
 * Uso: variables de templates de WhatsApp que mostrarán un monto al cliente.
 * NO usar para almacenamiento ni cálculos — la DB guarda numeric.
 */
function formatARS(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Math.round(n).toLocaleString('es-AR');
}

module.exports = { formatARS };
