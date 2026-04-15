/**
 * Bank Matching Service
 *
 * Pre-vincula comprobantes ↔ bank_movements sin confirmar.
 * Funciona en ambos sentidos:
 *   - Caso A: suben comprobante → buscar movimiento bancario
 *   - Caso B: importan JSON bancario → buscar comprobante pendiente
 */

const pool = require('../db');
const { logEvento } = require('../utils/logging');

/**
 * Caso A: Después de subir un comprobante, buscar movimiento bancario que matchee.
 *
 * Criterios (orden de prioridad):
 *   1. numero_operacion exacto (reference o movement_uid)
 *   2. monto exacto + fecha cercana (±2 días)
 *
 * Reglas:
 *   - Solo movimientos con assignment_status = 'unassigned'
 *   - Si hay más de 1 candidato fuerte → NO matchear (ambiguo)
 *   - No toca el estado del comprobante (sigue en a_confirmar)
 *
 * @param {number} comprobanteId
 * @param {string} orderNumber
 * @param {number} monto
 * @param {string|null} numeroOperacion
 * @param {string|null} fechaComprobante - YYYY-MM-DD
 * @returns {{ matched: boolean, movement_id?: number, criteria?: string }}
 */
async function matchFromComprobante(comprobanteId, orderNumber, monto, numeroOperacion, fechaComprobante) {
  try {
    // 1. Match por numero_operacion exacto
    if (numeroOperacion) {
      const res = await pool.query(
        `SELECT id, amount, posted_at, sender_name
         FROM bank_movements
         WHERE assignment_status = 'unassigned'
           AND is_incoming = true
           AND (reference = $1 OR movement_uid = $1)
         LIMIT 2`,
        [numeroOperacion]
      );

      if (res.rows.length === 1) {
        await applyMatch(res.rows[0].id, comprobanteId, orderNumber, 'numero_operacion', 'comprobante_upload');
        return { matched: true, movement_id: res.rows[0].id, criteria: 'numero_operacion' };
      }
      // Si hay 2+, es ambiguo — no matchear por operación, intentar por monto
    }

    // 2. Match por monto exacto + fecha cercana (±2 días)
    const fechaRef = fechaComprobante || new Date().toISOString().split('T')[0];
    const res = await pool.query(
      `SELECT id, amount, posted_at, sender_name
       FROM bank_movements
       WHERE assignment_status = 'unassigned'
         AND is_incoming = true
         AND amount = $1
         AND ABS(posted_at::date - $2::date) <= 2
       ORDER BY ABS(posted_at::date - $2::date) ASC
       LIMIT 2`,
      [monto, fechaRef]
    );

    if (res.rows.length === 1) {
      await applyMatch(res.rows[0].id, comprobanteId, orderNumber, 'monto_fecha', 'comprobante_upload');
      return { matched: true, movement_id: res.rows[0].id, criteria: 'monto_fecha' };
    }

    // 0 o 2+ candidatos → no matchear
    return { matched: false, reason: res.rows.length === 0 ? 'no_candidates' : 'ambiguous' };
  } catch (err) {
    console.error('matchFromComprobante error:', err.message);
    return { matched: false, reason: 'error', error: err.message };
  }
}

/**
 * Caso B: Después de importar un movimiento bancario nuevo, buscar comprobante pendiente.
 *
 * @param {object} client - DB client (dentro de transacción)
 * @param {number} movementId
 * @param {number} amount
 * @param {string} postedAt - ISO string
 * @param {string|null} reference - reference del movimiento (puede ser numero_operacion)
 * @param {string|null} movementUid
 * @returns {{ matched: boolean, comprobante_id?: number, order_number?: string, criteria?: string }}
 */
async function matchFromBankMovement(client, movementId, amount, postedAt, reference, movementUid) {
  try {
    // 1. Match por numero_operacion
    const opRef = reference || movementUid;
    if (opRef) {
      const res = await client.query(
        `SELECT id, order_number, monto
         FROM comprobantes
         WHERE estado IN ('pendiente', 'a_confirmar')
           AND numero_operacion = $1
         LIMIT 2`,
        [opRef]
      );

      if (res.rows.length === 1) {
        await applyMatchTx(client, movementId, res.rows[0].id, res.rows[0].order_number, 'numero_operacion', 'bank_import');
        return { matched: true, comprobante_id: res.rows[0].id, order_number: res.rows[0].order_number, criteria: 'numero_operacion' };
      }
    }

    // 2. Match por monto exacto + fecha cercana (±2 días)
    const res = await client.query(
      `SELECT id, order_number, monto
       FROM comprobantes
       WHERE estado IN ('pendiente', 'a_confirmar')
         AND monto = $1
         AND ABS(COALESCE(fecha_comprobante, created_at::date) - $2::date) <= 2
       ORDER BY ABS(COALESCE(fecha_comprobante, created_at::date) - $2::date) ASC
       LIMIT 2`,
      [amount, postedAt]
    );

    if (res.rows.length === 1) {
      await applyMatchTx(client, movementId, res.rows[0].id, res.rows[0].order_number, 'monto_fecha', 'bank_import');
      return { matched: true, comprobante_id: res.rows[0].id, order_number: res.rows[0].order_number, criteria: 'monto_fecha' };
    }

    return { matched: false };
  } catch (err) {
    console.error('matchFromBankMovement error:', err.message);
    return { matched: false };
  }
}

/**
 * Aplica el match: actualiza bank_movement a 'matched' (sin transacción)
 */
async function applyMatch(movementId, comprobanteId, orderNumber, criteria, matchedBy) {
  await pool.query(
    `UPDATE bank_movements
     SET assignment_status = 'matched',
         linked_comprobante_id = $1,
         linked_order_number = $2,
         matched_by = $3,
         matched_at = NOW()
     WHERE id = $4 AND assignment_status = 'unassigned'`,
    [comprobanteId, orderNumber, matchedBy, movementId]
  );

  logEvento({
    accion: 'bank_movement_matched_to_comprobante',
    origen: matchedBy,
    detalles: JSON.stringify({ movement_id: movementId, comprobante_id: comprobanteId, order_number: orderNumber, criteria }),
  });
}

/**
 * Aplica el match dentro de una transacción (para bank import)
 */
async function applyMatchTx(client, movementId, comprobanteId, orderNumber, criteria, matchedBy) {
  await client.query(
    `UPDATE bank_movements
     SET assignment_status = 'matched',
         linked_comprobante_id = $1,
         linked_order_number = $2,
         matched_by = $3,
         matched_at = NOW()
     WHERE id = $4 AND assignment_status = 'unassigned'`,
    [comprobanteId, orderNumber, matchedBy, movementId]
  );

  // Log fuera de transacción (fire and forget)
  logEvento({
    accion: 'bank_movement_matched_to_comprobante',
    origen: matchedBy,
    detalles: JSON.stringify({ movement_id: movementId, comprobante_id: comprobanteId, order_number: orderNumber, criteria }),
  }).catch(() => {});
}

module.exports = { matchFromComprobante, matchFromBankMovement };
