const pool = require('../db');
const { alerts } = require('../lib/alerts');

// Tolerancia en centavos para diferencias contables consideradas "ruido"
// (redondeos, IVA dec.). Antes era 1 centavo => generaba miles de falsos
// positivos por hora.
const PAYMENT_DIFF_TOLERANCE = 100;

async function runReconciliation() {
  const results = { checked: 0, autoResolved: 0, issues: [] };

  // 1. Check payment consistency
  // total_pagado should equal pago_online_tn + SUM(comprobantes confirmados) + SUM(pagos_efectivo)
  try {
    const inconsistent = await pool.query(`
      SELECT
        ov.order_number,
        ov.total_pagado as recorded_total,
        ov.pago_online_tn + COALESCE(comp.total, 0) + COALESCE(ef.total, 0) as calculated_total
      FROM orders_validated ov
      LEFT JOIN (
        SELECT order_number, SUM(monto) as total
        FROM comprobantes WHERE estado = 'confirmado'
        GROUP BY order_number
      ) comp ON ov.order_number = comp.order_number
      LEFT JOIN (
        SELECT order_number, SUM(monto) as total
        FROM pagos_efectivo
        GROUP BY order_number
      ) ef ON ov.order_number = ef.order_number
      WHERE ov.total_pagado > 0
        AND ov.estado_pedido != 'cancelado'
        AND ABS(ov.total_pagado - (ov.pago_online_tn + COALESCE(comp.total, 0) + COALESCE(ef.total, 0))) > $1
      LIMIT 50
    `, [PAYMENT_DIFF_TOLERANCE]);

    const inconsistentOrderNumbers = new Set(inconsistent.rows.map(r => String(r.order_number)));

    // Auto-resolver alertas viejas cuya diff actual ya esta dentro de tolerancia
    // (el problema se arreglo y la alerta quedo huerfana abierta).
    const autoResolveRes = await pool.query(`
      UPDATE system_alerts
      SET status = 'resolved',
          resolved_at = NOW()
      WHERE category = 'payment'
        AND status = 'open'
        AND COALESCE(metadata->>'orderNumber', '') NOT IN (
          SELECT UNNEST($1::text[])
        )
      RETURNING id
    `, [Array.from(inconsistentOrderNumbers)]);
    results.autoResolved = autoResolveRes.rowCount;

    results.checked += inconsistent.rowCount;
    for (const row of inconsistent.rows) {
      results.issues.push({
        type: 'payment_mismatch',
        orderNumber: row.order_number,
        recorded: row.recorded_total,
        calculated: row.calculated_total,
        diff: Math.abs(row.recorded_total - row.calculated_total)
      });

      // Deduplicar: si ya hay alerta abierta para este pedido, no crear otra.
      const existing = await pool.query(
        `SELECT 1 FROM system_alerts
         WHERE category='payment' AND status='open'
           AND metadata->>'orderNumber' = $1
         LIMIT 1`,
        [String(row.order_number)]
      );
      if (existing.rowCount > 0) continue;

      await alerts.paymentInconsistency(row.order_number, {
        recorded: row.recorded_total,
        calculated: row.calculated_total,
        diff: Math.abs(row.recorded_total - row.calculated_total)
      });
    }
  } catch (err) {
    console.error('Reconciliation payment check failed:', err.message);
  }

  // 2. Check stuck comprobantes (a_confirmar > 4 hours)
  try {
    const stuck = await pool.query(`
      SELECT order_number, id, created_at
      FROM comprobantes
      WHERE estado IN ('a_confirmar', 'procesando_ocr')
        AND created_at < NOW() - INTERVAL '4 hours'
      LIMIT 20
    `);

    if (stuck.rowCount > 5) {
      await alerts.sendAlert({
        level: 'warning',
        title: 'Stuck Comprobantes',
        message: `${stuck.rowCount} comprobantes llevan más de 4 horas sin procesar`,
        details: { count: stuck.rowCount }
      });
    }

    for (const row of stuck.rows) {
      results.issues.push({
        type: 'stuck_comprobante',
        orderNumber: row.order_number,
        comprobanteId: row.id,
        stuckSince: row.created_at
      });
    }
  } catch (err) {
    console.error('Reconciliation stuck check failed:', err.message);
  }

  // 3. Check sync queue failures
  try {
    const failed = await pool.query(`
      SELECT COUNT(*) as count FROM sync_queue WHERE status = 'failed'
    `);

    const failedCount = parseInt(failed.rows[0].count);
    if (failedCount > 10) {
      await alerts.syncFailure('sync_queue', `${failedCount} items fallidos en cola`);
      results.issues.push({
        type: 'sync_queue_failures',
        count: failedCount
      });
    }
  } catch (err) {
    console.error('Reconciliation sync check failed:', err.message);
  }

  return results;
}

module.exports = { runReconciliation };
