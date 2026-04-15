const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// =====================================================
// GET /api/local/alerts — Alertas activas del módulo LOCAL
// =====================================================
router.get('/', requirePermission('local.alerts.view'), async (req, res) => {
  try {
    const alerts = [];

    // 1. Reservas nuevas sin tomar por depósito (> 2 horas en estado reservado)
    const untouched = await pool.query(`
      SELECT id, local_order_number, created_at
      FROM local_orders
      WHERE status = 'reservado' AND created_at < NOW() - INTERVAL '2 hours'
      ORDER BY created_at ASC
    `);
    for (const row of untouched.rows) {
      alerts.push({
        type: 'reserva_sin_tomar',
        severity: 'warning',
        message: `Reserva #${row.local_order_number} sin tomar por depósito`,
        entity_type: 'local_order',
        entity_id: row.id,
        created_at: row.created_at,
        link: `/local/reservas/${row.id}`
      });
    }

    // 2. Impreso pero no armado (> 4 horas)
    const notPacked = await pool.query(`
      SELECT id, local_order_number, printed_at
      FROM local_orders
      WHERE status = 'impreso' AND printed_at < NOW() - INTERVAL '4 hours'
      ORDER BY printed_at ASC
    `);
    for (const row of notPacked.rows) {
      alerts.push({
        type: 'impreso_sin_armar',
        severity: 'warning',
        message: `Reserva #${row.local_order_number} impresa pero no armada`,
        entity_type: 'local_order',
        entity_id: row.id,
        created_at: row.printed_at,
        link: `/local/reservas/${row.id}`
      });
    }

    // 3. Armado pero no enviado (> 4 horas)
    const notShipped = await pool.query(`
      SELECT id, local_order_number, packed_at
      FROM local_orders
      WHERE status = 'armado' AND packed_at < NOW() - INTERVAL '4 hours'
      ORDER BY packed_at ASC
    `);
    for (const row of notShipped.rows) {
      alerts.push({
        type: 'armado_sin_enviar',
        severity: 'warning',
        message: `Reserva #${row.local_order_number} armada pero no enviada`,
        entity_type: 'local_order',
        entity_id: row.id,
        created_at: row.packed_at,
        link: `/local/reservas/${row.id}`
      });
    }

    // 4. Enviado pero no recibido (> 24 horas)
    const notReceived = await pool.query(`
      SELECT id, local_order_number, shipped_at
      FROM local_orders
      WHERE status = 'enviado' AND shipped_at < NOW() - INTERVAL '24 hours'
      ORDER BY shipped_at ASC
    `);
    for (const row of notReceived.rows) {
      alerts.push({
        type: 'enviado_sin_recibir',
        severity: 'error',
        message: `Reserva #${row.local_order_number} enviada hace más de 24hs sin recepción`,
        entity_type: 'local_order',
        entity_id: row.id,
        created_at: row.shipped_at,
        link: `/local/reservas/${row.id}`
      });
    }

    // 5. En control con diferencias
    const withDiffs = await pool.query(`
      SELECT id, local_order_number, updated_at
      FROM local_orders
      WHERE status = 'con_diferencias'
      ORDER BY updated_at ASC
    `);
    for (const row of withDiffs.rows) {
      alerts.push({
        type: 'con_diferencias',
        severity: 'error',
        message: `Reserva #${row.local_order_number} con diferencias en control`,
        entity_type: 'local_order',
        entity_id: row.id,
        created_at: row.updated_at,
        link: `/local/reservas/${row.id}`
      });
    }

    // 6. Pedido de caja pendiente de pago (> 24 horas)
    const unpaidBox = await pool.query(`
      SELECT id, local_box_order_number, created_at, total_amount, paid_amount
      FROM local_box_orders
      WHERE payment_status IN ('pendiente_pago', 'pagado_parcial')
        AND status != 'cancelado'
        AND created_at < NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `);
    for (const row of unpaidBox.rows) {
      alerts.push({
        type: 'caja_pendiente_pago',
        severity: 'warning',
        message: `Pedido caja #${row.local_box_order_number} pendiente de pago ($${parseFloat(row.total_amount) - parseFloat(row.paid_amount)})`,
        entity_type: 'local_box_order',
        entity_id: row.id,
        created_at: row.created_at,
        link: `/local/caja/${row.id}`
      });
    }

    // 7. Pedido de caja editado después de pagado
    const editedAfterPaid = await pool.query(`
      SELECT bo.id, bo.local_box_order_number, bo.updated_at, bo.total_amount, bo.paid_amount
      FROM local_box_orders bo
      WHERE bo.payment_status = 'pagado_parcial'
        AND bo.paid_amount > 0
        AND bo.total_amount != bo.paid_amount
        AND bo.status != 'cancelado'
      ORDER BY bo.updated_at DESC
    `);
    for (const row of editedAfterPaid.rows) {
      const diff = parseFloat(row.total_amount) - parseFloat(row.paid_amount);
      if (diff > 0) {
        alerts.push({
          type: 'caja_editado_post_pago',
          severity: 'warning',
          message: `Pedido caja #${row.local_box_order_number} modificado — diferencia pendiente: $${diff.toFixed(2)}`,
          entity_type: 'local_box_order',
          entity_id: row.id,
          created_at: row.updated_at,
          link: `/local/caja/${row.id}`
        });
      }
    }

    // Ordenar por severidad (error primero) y luego por fecha
    alerts.sort((a, b) => {
      const sev = { error: 0, warning: 1, info: 2 };
      if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
      return new Date(a.created_at) - new Date(b.created_at);
    });

    res.json({
      ok: true,
      alerts,
      total: alerts.length
    });
  } catch (error) {
    console.error('[LOCAL ALERTS] Error:', error);
    res.status(500).json({ error: 'Error al obtener alertas' });
  }
});

module.exports = router;
