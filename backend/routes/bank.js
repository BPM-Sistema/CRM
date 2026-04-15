/**
 * Rutas del Panel Admin Bancario
 *
 * Solo para visualización/observación de movimientos bancarios importados.
 * NO modifica el flujo de comprobantes ni la conciliación existente.
 */

const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logEvento } = require('../utils/logging');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────

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
    receiver_name: raw['Nombre Origen'] || raw.nombre_origen || null,
    receiver_account: raw.CuentaDestino || raw.cuenta_destino || null,
    description: raw.Descripcion || raw.descripcion || raw.Concepto || '',
    reference: raw.Referencia || raw.referencia || raw.ID || '',
    bank_name: raw.Banco || raw.banco || null,
    raw_row: raw,
    is_incoming: isIncoming,
    tipo_original: raw.Tipo || '',
    estado_original: raw.Estado || '',
  };
}

async function detectAssignment(client, amount, postedAt, senderName) {
  // Buscar comprobante confirmado con mismo monto y fecha cercana (±2 días)
  const res = await client.query(
    `SELECT c.id, c.order_number, c.monto, c.estado, c.created_at, c.fecha_comprobante,
            ov.customer_name
     FROM comprobantes c
     LEFT JOIN orders_validated ov ON ov.order_number = c.order_number
     WHERE c.estado = 'confirmado'
       AND c.monto = $1
       AND ABS(EXTRACT(EPOCH FROM (COALESCE(c.fecha_comprobante, c.created_at::date)::timestamp - $2::timestamp))) < 172800
     ORDER BY ABS(EXTRACT(EPOCH FROM (COALESCE(c.fecha_comprobante, c.created_at::date)::timestamp - $2::timestamp))) ASC
     LIMIT 1`,
    [amount, postedAt]
  );

  if (res.rows.length > 0) {
    return {
      status: 'assigned',
      comprobante_id: res.rows[0].id,
      order_number: res.rows[0].order_number,
    };
  }

  // Buscar comprobante pendiente con mismo monto (posible match futuro)
  const pendRes = await client.query(
    `SELECT c.id, c.order_number
     FROM comprobantes c
     WHERE c.estado IN ('pendiente', 'a_confirmar')
       AND c.monto = $1
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [amount]
  );

  if (pendRes.rows.length > 0) {
    return {
      status: 'review',
      comprobante_id: pendRes.rows[0].id,
      order_number: pendRes.rows[0].order_number,
    };
  }

  return { status: 'unassigned', comprobante_id: null, order_number: null };
}

// ── POST /bank/imports/preview ──────────────────────

router.post('/imports/preview', authenticate, requirePermission('bank.view'), async (req, res) => {
  try {
    const { movimientos, filename } = req.body;

    if (!Array.isArray(movimientos) || movimientos.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de movimientos' });
    }

    const parsed = movimientos.map(parseMovimiento);
    const incoming = parsed.filter(m => m.is_incoming);

    // Check duplicates against existing fingerprints
    const fingerprints = incoming.map(m => generateFingerprint(m));
    const existingRes = await pool.query(
      `SELECT fingerprint FROM bank_movements WHERE fingerprint = ANY($1)`,
      [fingerprints]
    );
    const existingSet = new Set(existingRes.rows.map(r => r.fingerprint));

    const preview = incoming.map((m, i) => {
      const fp = fingerprints[i];
      return {
        ...m,
        fingerprint: fp,
        is_duplicate: existingSet.has(fp),
      };
    });

    const newCount = preview.filter(p => !p.is_duplicate).length;
    const dupCount = preview.filter(p => p.is_duplicate).length;

    res.json({
      ok: true,
      summary: {
        total_rows: movimientos.length,
        total_incoming: incoming.length,
        total_new: newCount,
        total_duplicated: dupCount,
        total_outgoing: movimientos.length - incoming.length,
      },
      movements: preview,
    });
  } catch (error) {
    console.error('POST /bank/imports/preview error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /bank/imports/apply ────────────────────────

router.post('/imports/apply', authenticate, requirePermission('bank.view'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { movimientos, filename } = req.body;

    if (!Array.isArray(movimientos) || movimientos.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de movimientos' });
    }

    await client.query('BEGIN');

    const parsed = movimientos.map(parseMovimiento);
    const incoming = parsed.filter(m => m.is_incoming);

    // Create import record
    const importRes = await client.query(
      `INSERT INTO bank_imports (source, filename, uploaded_by, raw_payload, total_rows, total_incoming)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      ['manual', filename || 'import.json', req.user.id, JSON.stringify(movimientos), movimientos.length, incoming.length]
    );
    const importId = importRes.rows[0].id;

    let inserted = 0;
    let duplicated = 0;
    let assigned = 0;
    let unassigned = 0;
    let review = 0;
    const insertedMovements = [];
    const duplicatedMovements = [];

    for (const mov of incoming) {
      const fp = generateFingerprint(mov);

      // Check if already exists
      const existCheck = await client.query(
        `SELECT id FROM bank_movements WHERE fingerprint = $1`,
        [fp]
      );

      if (existCheck.rows.length > 0) {
        duplicated++;
        duplicatedMovements.push({ ...mov, fingerprint: fp, reason: 'fingerprint_exists' });
        continue;
      }

      // Detect assignment
      const assignment = await detectAssignment(client, mov.amount, mov.posted_at, mov.sender_name);

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

      inserted++;
      if (assignment.status === 'assigned') assigned++;
      else if (assignment.status === 'review') review++;
      else unassigned++;

      insertedMovements.push({
        id: insertRes.rows[0].id,
        ...mov,
        fingerprint: fp,
        assignment_status: assignment.status,
        linked_comprobante_id: assignment.comprobante_id,
        linked_order_number: assignment.order_number,
      });
    }

    // Update import summary
    await client.query(
      `UPDATE bank_imports SET total_inserted = $1, total_duplicated = $2, status = 'completed'
       WHERE id = $3`,
      [inserted, duplicated, importId]
    );

    await client.query('COMMIT');

    // Log event (outside transaction)
    await logEvento({
      accion: `bank_import: ${inserted} insertados, ${duplicated} duplicados, ${assigned} asignados`,
      origen: 'admin_banco',
      userId: req.user.id,
      username: req.user.name,
    });

    res.json({
      ok: true,
      import_id: importId,
      summary: {
        total_rows: movimientos.length,
        total_incoming: incoming.length,
        total_inserted: inserted,
        total_duplicated: duplicated,
        total_assigned: assigned,
        total_unassigned: unassigned,
        total_review: review,
      },
      inserted: insertedMovements,
      duplicated: duplicatedMovements,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('POST /bank/imports/apply error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ── GET /bank/movements ─────────────────────────────

router.get('/movements', authenticate, requirePermission('bank.view'), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      fecha = 'all',
      fecha_desde,
      fecha_hasta,
      assignment_status,
      amount_min,
      amount_max,
      bank_name,
      search,
      order_number,
      comprobante_id,
      import_id,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['bm.is_incoming = true'];
    const params = [];
    let paramIdx = 0;

    // Date filters
    if (fecha === 'hoy') {
      conditions.push(`bm.posted_at::date = CURRENT_DATE`);
    } else if (fecha === 'ayer') {
      conditions.push(`bm.posted_at::date = CURRENT_DATE - 1`);
    } else if (fecha === 'anteayer') {
      conditions.push(`bm.posted_at::date = CURRENT_DATE - 2`);
    } else if (fecha_desde) {
      paramIdx++;
      conditions.push(`bm.posted_at::date >= $${paramIdx}::date`);
      params.push(fecha_desde);
    }
    if (fecha_hasta) {
      paramIdx++;
      conditions.push(`bm.posted_at::date <= $${paramIdx}::date`);
      params.push(fecha_hasta);
    }

    // Assignment status
    if (assignment_status && assignment_status !== 'all') {
      paramIdx++;
      conditions.push(`bm.assignment_status = $${paramIdx}`);
      params.push(assignment_status);
    }

    // Amount range
    if (amount_min) {
      paramIdx++;
      conditions.push(`bm.amount >= $${paramIdx}`);
      params.push(parseFloat(amount_min));
    }
    if (amount_max) {
      paramIdx++;
      conditions.push(`bm.amount <= $${paramIdx}`);
      params.push(parseFloat(amount_max));
    }

    // Bank name
    if (bank_name) {
      paramIdx++;
      conditions.push(`bm.bank_name ILIKE $${paramIdx}`);
      params.push(`%${bank_name}%`);
    }

    // Order number
    if (order_number) {
      paramIdx++;
      conditions.push(`bm.linked_order_number = $${paramIdx}`);
      params.push(order_number);
    }

    // Comprobante ID
    if (comprobante_id) {
      paramIdx++;
      conditions.push(`bm.linked_comprobante_id = $${paramIdx}`);
      params.push(parseInt(comprobante_id));
    }

    // Import ID
    if (import_id) {
      paramIdx++;
      conditions.push(`bm.import_id = $${paramIdx}`);
      params.push(parseInt(import_id));
    }

    // Free text search
    if (search) {
      paramIdx++;
      conditions.push(`(
        bm.sender_name ILIKE $${paramIdx} OR
        bm.description ILIKE $${paramIdx} OR
        bm.reference ILIKE $${paramIdx} OR
        bm.movement_uid ILIKE $${paramIdx} OR
        bm.linked_order_number ILIKE $${paramIdx} OR
        CAST(bm.amount AS TEXT) LIKE $${paramIdx}
      )`);
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM bank_movements bm ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].count);

    // Fetch movements
    const movRes = await pool.query(
      `SELECT bm.*,
              bi.filename as import_filename,
              bi.uploaded_at as import_uploaded_at,
              c.estado as comprobante_estado,
              c.file_url as comprobante_file_url,
              ov.customer_name,
              ov.estado_pago
       FROM bank_movements bm
       LEFT JOIN bank_imports bi ON bi.id = bm.import_id
       LEFT JOIN comprobantes c ON c.id = bm.linked_comprobante_id
       LEFT JOIN orders_validated ov ON ov.order_number = bm.linked_order_number
       ${whereClause}
       ORDER BY bm.posted_at DESC
       LIMIT $${paramIdx + 1} OFFSET $${paramIdx + 2}`,
      [...params, limitNum, offset]
    );

    // Summary stats
    const statsRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE assignment_status = 'assigned') as assigned_count,
         COUNT(*) FILTER (WHERE assignment_status = 'unassigned') as unassigned_count,
         COALESCE(SUM(amount) FILTER (WHERE assignment_status = 'assigned'), 0) as assigned_total,
         COALESCE(SUM(amount) FILTER (WHERE assignment_status = 'unassigned'), 0) as unassigned_total,
         COALESCE(SUM(amount), 0) as total_ingresos
       FROM bank_movements bm
       ${whereClause}`,
      params
    );

    // Comprobantes pendientes de confirmar
    const pendingRes = await pool.query(
      `SELECT COUNT(*) as pending_count, COALESCE(SUM(monto), 0) as pending_total
       FROM comprobantes WHERE estado IN ('pendiente', 'a_confirmar')`
    );

    // Pagos efectivo con los mismos filtros de fecha
    const cashConditions = [];
    const cashParams = [];
    let cashIdx = 0;
    if (fecha === 'hoy') {
      cashConditions.push(`created_at::date = CURRENT_DATE`);
    } else if (fecha === 'ayer') {
      cashConditions.push(`created_at::date = CURRENT_DATE - 1`);
    } else if (fecha === 'anteayer') {
      cashConditions.push(`created_at::date = CURRENT_DATE - 2`);
    } else if (fecha_desde) {
      cashIdx++;
      cashConditions.push(`created_at::date >= $${cashIdx}::date`);
      cashParams.push(fecha_desde);
    }
    if (fecha_hasta) {
      cashIdx++;
      cashConditions.push(`created_at::date <= $${cashIdx}::date`);
      cashParams.push(fecha_hasta);
    }
    const cashWhere = cashConditions.length > 0 ? `WHERE ${cashConditions.join(' AND ')}` : '';
    const cashRes = await pool.query(
      `SELECT COUNT(*) as cash_count, COALESCE(SUM(monto), 0) as cash_total
       FROM pagos_efectivo ${cashWhere}`,
      cashParams
    );

    // Last import date
    const lastImportRes = await pool.query(
      `SELECT created_at FROM bank_imports ORDER BY created_at DESC LIMIT 1`
    );
    const stats = statsRes.rows[0] || {};
    const pending = pendingRes.rows[0] || {};
    const cash = cashRes.rows[0] || {};
    stats.pending_receipts_count = pending.pending_count;
    stats.pending_receipts_total = pending.pending_total;
    stats.cash_count = cash.cash_count;
    stats.cash_total = cash.cash_total;
    stats.total_real = Number(stats.total_ingresos || 0) + Number(cash.cash_total || 0);
    if (lastImportRes.rows.length > 0) {
      stats.last_import_at = lastImportRes.rows[0].created_at;
    }

    res.json({
      ok: true,
      data: movRes.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
      stats,
    });
  } catch (error) {
    console.error('GET /bank/movements error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /bank/movements/:id ─────────────────────────

router.get('/movements/:id', authenticate, requirePermission('bank.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const movRes = await pool.query(
      `SELECT bm.*,
              bi.filename as import_filename,
              bi.uploaded_at as import_uploaded_at,
              bi.source as import_source,
              c.id as comp_id, c.order_number as comp_order_number, c.monto as comp_monto,
              c.estado as comp_estado, c.file_url as comp_file_url, c.created_at as comp_created_at,
              c.numero_operacion as comp_numero_operacion,
              ov.customer_name, ov.customer_email, ov.monto_tiendanube as order_total,
              ov.estado_pago, ov.estado_pedido, ov.total_pagado, ov.saldo
       FROM bank_movements bm
       LEFT JOIN bank_imports bi ON bi.id = bm.import_id
       LEFT JOIN comprobantes c ON c.id = bm.linked_comprobante_id
       LEFT JOIN orders_validated ov ON ov.order_number = bm.linked_order_number
       WHERE bm.id = $1`,
      [id]
    );

    if (movRes.rows.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }

    res.json({ ok: true, data: movRes.rows[0] });
  } catch (error) {
    console.error('GET /bank/movements/:id error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /bank/imports ───────────────────────────────

router.get('/imports', authenticate, requirePermission('bank.view'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const countRes = await pool.query(`SELECT COUNT(*) FROM bank_imports`);
    const total = parseInt(countRes.rows[0].count);

    const importsRes = await pool.query(
      `SELECT bi.*, u.name as uploaded_by_name
       FROM bank_imports bi
       LEFT JOIN users u ON u.id = bi.uploaded_by
       ORDER BY bi.uploaded_at DESC
       LIMIT $1 OFFSET $2`,
      [limitNum, offset]
    );

    res.json({
      ok: true,
      data: importsRes.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('GET /bank/imports error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /bank/imports/:id ───────────────────────────

router.get('/imports/:id', authenticate, requirePermission('bank.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const importRes = await pool.query(
      `SELECT bi.*, u.name as uploaded_by_name
       FROM bank_imports bi
       LEFT JOIN users u ON u.id = bi.uploaded_by
       WHERE bi.id = $1`,
      [id]
    );

    if (importRes.rows.length === 0) {
      return res.status(404).json({ error: 'Import no encontrado' });
    }

    // Get movements for this import
    const movRes = await pool.query(
      `SELECT bm.*,
              c.estado as comprobante_estado,
              ov.customer_name
       FROM bank_movements bm
       LEFT JOIN comprobantes c ON c.id = bm.linked_comprobante_id
       LEFT JOIN orders_validated ov ON ov.order_number = bm.linked_order_number
       WHERE bm.import_id = $1
       ORDER BY bm.posted_at DESC`,
      [id]
    );

    res.json({
      ok: true,
      data: {
        ...importRes.rows[0],
        movements: movRes.rows,
      },
    });
  } catch (error) {
    console.error('GET /bank/imports/:id error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
