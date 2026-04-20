/**
 * Bank Import Service
 *
 * Persiste movimientos bancarios en bank_imports / bank_movements.
 * Llamado solo desde conciliacion-aplicar (nunca desde preview).
 */

const crypto = require('crypto');
const pool = require('../db');
const { matchFromBankMovement } = require('./bankMatchingService');

function generateFingerprint(mov) {
  const parts = [
    mov.posted_at || '',
    String(mov.amount || ''),
    (mov.sender_name || '').trim().toLowerCase(),
    (mov.description || '').trim().toLowerCase(),
    (mov.reference || '').trim().toLowerCase(),
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex');
}

function parseMovimiento(raw) {
  const importe = parseFloat(raw.Importe);
  const fechaHora = raw['Fecha/Hora'] || '';
  const [fecha, hora] = fechaHora.split(' ');

  let postedAt;
  if (fecha && hora) {
    postedAt = new Date(`${fecha}T${hora}-03:00`);
  } else if (fecha) {
    postedAt = new Date(`${fecha}T00:00:00-03:00`);
  } else {
    postedAt = new Date();
  }

  const isIncoming = raw.Tipo === 'Transferencia entrante' && raw.Estado === 'Ejecutado' && importe > 0;

  return {
    movement_uid: raw.ID || null,
    posted_at: postedAt.toISOString(),
    amount: Math.floor(importe),
    currency: 'ARS',
    sender_name: (raw['Nombre Destino'] || '').trim(),
    sender_tax_id: raw.CUIT || raw.cuit || null,
    sender_account: raw.CuentaOrigen || raw.cuenta_origen || null,
    receiver_name: (raw['Nombre Origen'] || raw.nombre_origen || '').trim(),
    receiver_account: raw.CuentaDestino || raw.cuenta_destino || null,
    description: raw.Descripcion || raw.descripcion || raw.Concepto || '',
    reference: raw.Referencia || raw.referencia || raw.ID || '',
    bank_name: raw.Banco || raw.banco || null,
    raw_row: raw,
    is_incoming: isIncoming,
  };
}

async function detectAssignment(client, amount, postedAt, senderName) {
  const res = await client.query(
    `SELECT c.id, c.order_number
     FROM comprobantes c
     WHERE c.estado = 'confirmado'
       AND c.monto = $1
       AND ABS(EXTRACT(EPOCH FROM (c.created_at - $2::timestamptz))) < 172800
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [amount, postedAt]
  );

  if (res.rows.length > 0) {
    return { status: 'assigned', comprobante_id: res.rows[0].id, order_number: res.rows[0].order_number };
  }

  // Check approximate match
  const approx = await client.query(
    `SELECT c.id, c.order_number
     FROM comprobantes c
     WHERE c.estado = 'confirmado'
       AND ABS(c.monto - $1) <= 1
       AND ABS(EXTRACT(EPOCH FROM (c.created_at - $2::timestamptz))) < 604800
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [amount, postedAt]
  );

  if (approx.rows.length > 0) {
    return { status: 'review', comprobante_id: approx.rows[0].id, order_number: approx.rows[0].order_number };
  }

  return { status: 'unassigned', comprobante_id: null, order_number: null };
}

/**
 * Importa movimientos bancarios a bank_imports + bank_movements.
 * Solo llamar desde conciliacion-aplicar.
 *
 * @param {Array} movimientos - Movimientos raw del JSON bancario
 * @param {string} userId - ID del usuario que aplica
 * @param {Array} resolvedMatches - Matches ya resueltos por la conciliación
 *   Cada uno: { banco_id, comprobante_id, order_number }
 *   Si viene, se usa para asignar directamente sin detectAssignment.
 */
async function importMovimientos(movimientos, userId, resolvedMatches) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const CUTOFF = '2026-04-06T15:11:00';
    const parsed = movimientos.map(parseMovimiento);
    let incoming = parsed.filter(m => m.is_incoming && m.posted_at >= CUTOFF);

    if (incoming.length === 0) {
      await client.query('ROLLBACK');
      return { inserted: 0, duplicated: 0 };
    }

    const ignoredRes = await client.query(
      `SELECT movement_uid FROM bank_movements_ignored`
    );
    const ignoredSet = new Set(ignoredRes.rows.map(r => r.movement_uid));
    let ignored = 0;
    if (ignoredSet.size > 0) {
      const before = incoming.length;
      incoming = incoming.filter(m => !ignoredSet.has(m.movement_uid));
      ignored = before - incoming.length;
    }

    // Indexar matches resueltos por banco_id para lookup rápido
    const matchByBancoId = {};
    if (Array.isArray(resolvedMatches)) {
      for (const m of resolvedMatches) {
        matchByBancoId[String(m.banco_id)] = m;
      }
    }

    const importRes = await client.query(
      `INSERT INTO bank_imports (source, filename, uploaded_by, raw_payload, total_rows, total_incoming)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      ['conciliacion_comprobantes', 'conciliacion.json', userId, JSON.stringify(movimientos), movimientos.length, incoming.length]
    );
    const importId = importRes.rows[0].id;

    let inserted = 0, duplicated = 0, updated = 0;

    for (const mov of incoming) {
      const fp = generateFingerprint(mov);

      // Resolver assignment desde conciliación
      const resolved = matchByBancoId[String(mov.movement_uid)];

      // Dedup: buscar por fingerprint O por movement_uid (cubre cambios de timezone)
      const existCheck = await client.query(
        `SELECT id, assignment_status FROM bank_movements
         WHERE fingerprint = $1 OR (movement_uid IS NOT NULL AND movement_uid = $2)
         LIMIT 1`,
        [fp, mov.movement_uid]
      );

      if (existCheck.rows.length > 0) {
        const existing = existCheck.rows[0];
        // Si tenemos un match resuelto de conciliación, actualizar
        if (resolved && existing.assignment_status !== 'assigned') {
          await client.query(
            `UPDATE bank_movements
             SET assignment_status = 'assigned',
                 linked_comprobante_id = $1,
                 linked_order_number = $2,
                 fingerprint = $3, posted_at = $4
             WHERE id = $5`,
            [resolved.comprobante_id, resolved.order_number, fp, mov.posted_at, existing.id]
          );
          updated++;
        } else if (!resolved && existing.assignment_status === 'unassigned') {
          // Intentar detectar assignment contra comprobantes existentes
          const detected = await detectAssignment(client, mov.amount, mov.posted_at, mov.sender_name);
          if (detected.status !== 'unassigned') {
            await client.query(
              `UPDATE bank_movements
               SET assignment_status = $1,
                   linked_comprobante_id = $2,
                   linked_order_number = $3,
                   fingerprint = $4, posted_at = $5
               WHERE id = $6`,
              [detected.status, detected.comprobante_id, detected.order_number, fp, mov.posted_at, existing.id]
            );
            updated++;
          } else {
            // Actualizar fingerprint/posted_at por si cambió el timezone
            await client.query(
              `UPDATE bank_movements SET fingerprint = $1, posted_at = $2 WHERE id = $3`,
              [fp, mov.posted_at, existing.id]
            );
          }
        }
        duplicated++;
        continue;
      }

      // Nuevo movimiento: resolver assignment
      let assignment;
      let matchedBy = null;
      if (resolved) {
        assignment = { status: 'assigned', comprobante_id: resolved.comprobante_id, order_number: resolved.order_number };
      } else {
        // Intentar detectar match con comprobantes confirmados
        assignment = await detectAssignment(client, mov.amount, mov.posted_at, mov.sender_name);
      }

      // Insertar movimiento
      const insertRes = await client.query(
        `INSERT INTO bank_movements
         (import_id, movement_uid, fingerprint, posted_at, amount, currency,
          sender_name, sender_tax_id, sender_account, receiver_name, receiver_account,
          description, reference, bank_name, raw_row, is_incoming,
          assignment_status, linked_comprobante_id, linked_order_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          importId, mov.movement_uid, fp, mov.posted_at, mov.amount, mov.currency,
          mov.sender_name, mov.sender_tax_id, mov.sender_account, mov.receiver_name, mov.receiver_account,
          mov.description, mov.reference, mov.bank_name, JSON.stringify(mov.raw_row), mov.is_incoming,
          assignment.status, assignment.comprobante_id, assignment.order_number,
        ]
      );

      // Caso B: si quedó unassigned, intentar pre-vincular con comprobante pendiente
      if (assignment.status === 'unassigned') {
        const movId = insertRes.rows[0].id;
        await matchFromBankMovement(client, movId, mov.amount, mov.posted_at, mov.reference, mov.movement_uid);
      }

      inserted++;
    }

    await client.query(
      `UPDATE bank_imports SET total_inserted = $1, total_duplicated = $2, status = 'completed' WHERE id = $3`,
      [inserted, duplicated, importId]
    );
    await client.query('COMMIT');
    return { inserted, duplicated, updated, ignored };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('importMovimientos error:', err.message);
    return { inserted: 0, duplicated: 0, updated: 0, ignored: 0, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = { importMovimientos, parseMovimiento, generateFingerprint };
