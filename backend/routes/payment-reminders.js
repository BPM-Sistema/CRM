/**
 * Payment Reminders Panel
 *
 * /admin/payment-reminders          → listado paginado con estado de cada paso
 * /admin/payment-reminders/stats    → métricas resumen
 * /admin/payment-reminders/:order   → historial completo de mensajes WhatsApp del pedido
 * /admin/payment-reminders/:scheduledId/reprogramar → reprograma un envío descartado
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { nextBusinessSendAtAR } = require('../utils/businessHours');

router.use(authenticate);

const STEPS = [
  { key: 'pendiente_3hs', offsetHours: 3, label: 'Recordatorio 3hs' },
  { key: 'pendiente_10hs', offsetHours: 10, label: 'Recordatorio 10hs' }
];

function buildStepSubqueries() {
  return STEPS.flatMap(s => [
    `(SELECT id FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${s.key}' ORDER BY id DESC LIMIT 1) AS ${s.key}_id`,
    `(SELECT send_at FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${s.key}' ORDER BY id DESC LIMIT 1) AS ${s.key}_send_at`,
    `(SELECT sent_at FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${s.key}' ORDER BY id DESC LIMIT 1) AS ${s.key}_sent_at`,
    `(SELECT error FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${s.key}' ORDER BY id DESC LIMIT 1) AS ${s.key}_error`,
    `(SELECT wm.status FROM whatsapp_messages wm WHERE wm.order_number = o.order_number::int AND wm.template_key = '${s.key}' ORDER BY wm.created_at DESC LIMIT 1) AS ${s.key}_wa_status`,
    `(SELECT wm.status_updated_at FROM whatsapp_messages wm WHERE wm.order_number = o.order_number::int AND wm.template_key = '${s.key}' ORDER BY wm.created_at DESC LIMIT 1) AS ${s.key}_wa_status_at`,
    `(SELECT wm.error_message FROM whatsapp_messages wm WHERE wm.order_number = o.order_number::int AND wm.template_key = '${s.key}' ORDER BY wm.created_at DESC LIMIT 1) AS ${s.key}_wa_error`
  ]).join(',\n        ');
}

// ─── GET /admin/payment-reminders ────────────────────────
// Listado paginado de pedidos en pendiente_pago con estado de cada paso.
// Filtros: status (programado|enviado|descartado|sin_programar|cualquiera),
// step (3hs|10hs|any), search (nro pedido, nombre, teléfono).
router.get('/', requirePermission('payment_reminders.view'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const stepFilter = STEPS.find(s => s.key === `pendiente_${req.query.step}`)?.key || null;
    const statusFilter = req.query.status || 'any'; // programado | enviado | descartado | sin_programar | any

    const conditions = [`o.estado_pedido = 'pendiente_pago'`];
    const params = [];
    let i = 1;

    if (search) {
      conditions.push(`(CAST(o.order_number AS TEXT) ILIKE $${i} OR o.customer_name ILIKE $${i} OR o.customer_phone ILIKE $${i})`);
      params.push(`%${search}%`);
      i++;
    }

    // Filtro por status del paso seleccionado (o cualquier paso si step=any)
    if (statusFilter !== 'any') {
      const stepKeys = stepFilter ? [stepFilter] : STEPS.map(s => s.key);
      const orParts = stepKeys.map(k => {
        if (statusFilter === 'enviado') {
          return `EXISTS (SELECT 1 FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${k}' AND sent_at IS NOT NULL)`;
        }
        if (statusFilter === 'descartado') {
          return `EXISTS (SELECT 1 FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${k}' AND error IS NOT NULL AND sent_at IS NULL)`;
        }
        if (statusFilter === 'programado') {
          return `EXISTS (SELECT 1 FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${k}' AND sent_at IS NULL AND error IS NULL)`;
        }
        if (statusFilter === 'sin_programar') {
          return `NOT EXISTS (SELECT 1 FROM scheduled_whatsapp WHERE order_number = o.order_number AND plantilla = '${k}')`;
        }
        return '1=1';
      });
      conditions.push(`(${orParts.join(' OR ')})`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM orders_validated o ${whereClause}`,
      params
    );

    const rowsRes = await pool.query(
      `SELECT
        o.order_number,
        o.customer_name,
        o.customer_phone,
        o.monto_tiendanube,
        o.created_at,
        o.estado_pedido,
        o.estado_pago,
        ${buildStepSubqueries()}
      FROM orders_validated o
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${i++} OFFSET $${i}`,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      orders: rowsRes.rows,
      steps: STEPS,
      pagination: {
        page,
        limit,
        total: totalRes.rows[0].total,
        totalPages: Math.ceil(totalRes.rows[0].total / limit)
      }
    });
  } catch (err) {
    console.error('[payment-reminders] list error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/payment-reminders/stats ──────────────────
router.get('/stats', requirePermission('payment_reminders.view'), async (req, res) => {
  try {
    const stats = {};
    for (const step of STEPS) {
      const r = await pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE sent_at IS NULL AND error IS NULL AND send_at <= NOW()) AS vencidos_sin_enviar,
          COUNT(*) FILTER (WHERE sent_at IS NULL AND error IS NULL AND send_at > NOW()) AS programados,
          COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND DATE(sent_at) = CURRENT_DATE) AS enviados_hoy,
          COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS enviados_total,
          COUNT(*) FILTER (WHERE error IS NOT NULL AND sent_at IS NULL) AS descartados
         FROM scheduled_whatsapp
         WHERE plantilla = $1`,
        [step.key]
      );
      stats[step.key] = r.rows[0];
    }
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('[payment-reminders] stats error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/payment-reminders/:orderNumber/history ───
// Historial completo de WhatsApp del pedido (no solo recordatorios).
router.get('/:orderNumber/history', requirePermission('payment_reminders.view'), async (req, res) => {
  try {
    const orderNumber = req.params.orderNumber;
    if (!/^\d+$/.test(orderNumber)) {
      return res.status(400).json({ ok: false, error: 'orderNumber inválido' });
    }

    const orderRes = await pool.query(
      `SELECT order_number, customer_name, customer_phone, monto_tiendanube,
              created_at, estado_pedido, estado_pago
         FROM orders_validated WHERE order_number = $1`,
      [orderNumber]
    );
    if (orderRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
    }

    const messagesRes = await pool.query(
      `SELECT id, request_id, template, template_key, status, status_updated_at,
              error_message, created_at, variables
         FROM whatsapp_messages
         WHERE order_number = $1::int
         ORDER BY created_at DESC`,
      [orderNumber]
    );

    const scheduledRes = await pool.query(
      `SELECT id, plantilla, send_at, sent_at, error, created_at
         FROM scheduled_whatsapp
         WHERE order_number = $1
         ORDER BY id DESC`,
      [orderNumber]
    );

    res.json({
      ok: true,
      order: orderRes.rows[0],
      messages: messagesRes.rows,
      scheduled: scheduledRes.rows
    });
  } catch (err) {
    console.error('[payment-reminders] history error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /admin/payment-reminders/:scheduledId/reprogramar ──
// Reprograma un envío descartado para que se vuelva a intentar.
// Aplica el offset configurado del paso, recalculado desde NOW().
router.post('/:scheduledId/reprogramar', requirePermission('payment_reminders.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.scheduledId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'scheduledId inválido' });
    }

    const cur = await pool.query(
      `SELECT id, plantilla, order_number, telefono, variables, sent_at, error
         FROM scheduled_whatsapp WHERE id = $1`,
      [id]
    );
    if (cur.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'No encontrado' });
    }
    const row = cur.rows[0];
    const step = STEPS.find(s => s.key === row.plantilla);
    if (!step) {
      return res.status(400).json({ ok: false, error: `Plantilla ${row.plantilla} no es reprogramable` });
    }
    if (row.sent_at) {
      return res.status(400).json({ ok: false, error: 'Ya fue enviado, no se puede reprogramar' });
    }

    // Reprograma con offset 0h respecto a NOW (próximo horario laboral hábil ya).
    const sendAt = nextBusinessSendAtAR(new Date(), Number(row.order_number) || 0, 0);

    // Inserta una NUEVA fila en lugar de mutar la descartada — así queda histórico.
    const ins = await pool.query(
      `INSERT INTO scheduled_whatsapp (telefono, plantilla, variables, order_number, send_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, send_at`,
      [row.telefono, row.plantilla, row.variables || {}, row.order_number, sendAt]
    );

    res.json({ ok: true, scheduled: ins.rows[0] });
  } catch (err) {
    console.error('[payment-reminders] reprogramar error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
