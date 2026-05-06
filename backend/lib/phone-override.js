/**
 * Phone Override Helper
 *
 * Centraliza la lógica de actualizar customer_phone "manualmente"
 * (sin pasar por el sync con TN). Usado por:
 *   - POST /upload (cliente verifica vía /comprobantes-wpp)
 *   - PATCH /orders/:orderNumber/customer-phone (admin desde detalle)
 *
 * Setea customer_phone_overridden_at para que los webhooks de TN y el
 * divergence-detector no pisen el valor con el de TN.
 *
 * Comparación inteligente: por últimos 10 dígitos, así "el mismo número
 * en otro formato" no dispara override falso. Soporta el formato viejo
 * argentino con "15" para áreas de 2 dígitos (CABA/GBA).
 */

const pool = require('../db');
const { apiLogger: log } = require('./logger');
const { logEvento } = require('../utils/logging');
const { normalizeArgentinaPhone } = require('./whatsapp-helpers');

/**
 * Sanea, valida y normaliza el phone que escribió el usuario.
 * @param {string} rawPhone
 * @returns {{ digits: string|null, error: string|null }}
 */
function sanitizeAndValidate(rawPhone) {
  if (rawPhone === null || rawPhone === undefined) return { digits: null, error: 'empty' };
  const str = String(rawPhone).trim();
  if (str === '') return { digits: null, error: 'empty' };
  const digits = str.replace(/\D/g, '');
  if (digits.length < 10) return { digits: null, error: 'too_short' };
  if (digits.length > 15) return { digits: null, error: 'too_long' };
  return { digits, error: null };
}

/**
 * Convierte dígitos limpios a formato +549... (móvil AR).
 *   10 dig sin código país          → "1166778899"        → +5491166778899
 *   11 dig arrancando con 9         → "91166778899"       → +5491166778899
 *   12 dig con "15" viejo (CABA/GBA)→ "111566778899"      → +5491166778899
 *   12 dig con +54 sin 9            → "541166778899"      → +5491166778899
 *   13 dig con +549                 → "5491166778899"     → +5491166778899
 *
 * Heurística del 15: solo para 12 dígitos donde pos 3-4 = "15" (área 2-dig).
 * Para áreas 3-dig (351 Córdoba, 221 La Plata, etc.) el cliente debe
 * escribirlo sin el 15.
 */
function normalizeForArgentina(digits) {
  let working = digits;
  if (working.length === 12 && working.substring(2, 4) === '15') {
    working = working.substring(0, 2) + working.substring(4);
  }
  const candidate = working.length === 10
    ? '+549' + working
    : working.length === 11 && working.startsWith('9')
      ? '+54' + working
      : '+' + working;
  return normalizeArgentinaPhone(candidate);
}

/**
 * Aplica el override de customer_phone al pedido.
 *
 * @param {string} orderNumber
 * @param {string} rawPhone - input del usuario, cualquier formato
 * @param {object} opts
 * @param {'cliente'|'admin'} opts.triggeredBy
 * @param {string} [opts.username] - solo si triggeredBy='admin'
 * @param {Set<string>} [opts.allowedStates] - si está, restringe a estos estado_pedido
 * @returns {Promise<{
 *   applied: boolean,
 *   normalized: string|null,
 *   oldPhone: string|null,
 *   reason: 'ok'|'empty'|'too_short'|'too_long'|'order_not_found'|'state_not_allowed'|'same_phone'
 * }>}
 */
async function applyCustomerPhoneOverride(orderNumber, rawPhone, opts = {}) {
  const { triggeredBy = 'cliente', username = null, allowedStates = null } = opts;

  // 1. Validar input
  const { digits, error } = sanitizeAndValidate(rawPhone);
  if (error) {
    return { applied: false, normalized: null, oldPhone: null, reason: error };
  }

  // 2. Cargar estado actual del pedido
  const stateRes = await pool.query(
    `SELECT estado_pedido, customer_phone FROM orders_validated WHERE order_number = $1`,
    [orderNumber]
  );
  const orderRow = stateRes.rows[0];
  if (!orderRow) {
    return { applied: false, normalized: null, oldPhone: null, reason: 'order_not_found' };
  }

  // 3. Restricción de estado (opcional, solo si el caller la pidió)
  if (allowedStates && !allowedStates.has(orderRow.estado_pedido)) {
    log.info({ orderNumber, estado: orderRow.estado_pedido, triggeredBy }, 'phone override skipped: estado fuera de allowed');
    return { applied: false, normalized: null, oldPhone: orderRow.customer_phone, reason: 'state_not_allowed' };
  }

  // 4. Comparar últimos 10 dígitos (mismo número en distinto formato → no override)
  const currentDigits = (orderRow.customer_phone || '').replace(/\D/g, '');
  if (currentDigits && currentDigits.slice(-10) === digits.slice(-10)) {
    return { applied: false, normalized: orderRow.customer_phone, oldPhone: orderRow.customer_phone, reason: 'same_phone' };
  }

  // 5. Normalizar a formato +549...
  const normalized = normalizeForArgentina(digits);

  // 6. UPDATE customer_phone + flag + scheduled_whatsapp pendientes
  await pool.query(
    `UPDATE orders_validated
       SET customer_phone = $1,
           customer_phone_overridden_at = NOW(),
           updated_at = NOW()
     WHERE order_number = $2`,
    [normalized, orderNumber]
  );
  await pool.query(
    `UPDATE scheduled_whatsapp
       SET telefono = $1
     WHERE order_number = $2 AND sent_at IS NULL AND error IS NULL`,
    [normalized, orderNumber]
  );

  // 7. Log evento
  const accion = triggeredBy === 'admin'
    ? `Teléfono actualizado manualmente: ${orderRow.customer_phone || '(vacío)'} → ${normalized}`
    : `Teléfono actualizado por cliente: ${orderRow.customer_phone || '(vacío)'} → ${normalized}`;
  await logEvento({
    orderNumber,
    accion,
    origen: triggeredBy === 'admin' ? 'admin' : 'cliente',
    username,
  }).catch(() => {});

  log.info({ orderNumber, from: orderRow.customer_phone, to: normalized, triggeredBy }, 'customer_phone overrideado');

  return { applied: true, normalized, oldPhone: orderRow.customer_phone, reason: 'ok' };
}

module.exports = {
  applyCustomerPhoneOverride,
  sanitizeAndValidate,
  normalizeForArgentina,
};
