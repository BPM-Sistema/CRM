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
const { callTiendanubeWrite } = require('../lib/tnWriteClient');
const { logEvento } = require('../utils/logging');

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
        o.tn_order_id,
        o.payment_reminder_note,
        o.payment_reminder_action_at,
        o.payment_reminder_action_type,
        ${buildStepSubqueries()},
        (SELECT COUNT(*)::int FROM whatsapp_inbound_messages
          WHERE order_number = o.order_number::int) AS inbound_count,
        (SELECT json_agg(row_to_json(x)) FROM (
          SELECT message_text, message_type, button_id, url_clicked, received_at, from_name
          FROM whatsapp_inbound_messages
          WHERE order_number = o.order_number::int
          ORDER BY received_at DESC
          LIMIT 5
        ) x) AS last_inbound,
        EXISTS (
          SELECT 1 FROM whatsapp_inbound_messages
          WHERE order_number = o.order_number::int
            AND message_type = 'url_click'
        ) AS has_url_click,
        EXISTS (
          SELECT 1 FROM comprobantes
          WHERE order_number = o.order_number
            AND COALESCE(estado, '') NOT IN ('rechazado')
        ) AS has_comprobante
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

    // Mensajes entrantes del cliente: por order_number directo (correlación que
    // hace el webhook al recibir) y como fallback por phone (por si la
    // correlación quedó null).
    const phone = orderRes.rows[0].customer_phone;
    const phoneClean = phone ? String(phone).replace(/[^\d+]/g, '') : null;
    const inboundRes = await pool.query(
      `SELECT id, contact_id, chat_id, message_id, message_type,
              message_text, button_id, url_clicked, received_at, order_number
         FROM whatsapp_inbound_messages
         WHERE order_number = $1::int
            OR ($2::text IS NOT NULL AND
                REPLACE(REPLACE(REPLACE(contact_id, ' ', ''), '-', ''), '(', '') ILIKE $3)
         ORDER BY received_at DESC
         LIMIT 200`,
      [orderNumber, phoneClean, phoneClean ? `%${phoneClean.replace(/^\+/, '')}%` : null]
    );

    res.json({
      ok: true,
      order: orderRes.rows[0],
      messages: messagesRes.rows,
      scheduled: scheduledRes.rows,
      inbound: inboundRes.rows
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

// ─── POST /admin/payment-reminders/:orderNumber/action ───
// Aplica acción de Melu a un pedido pendiente:
//   - { action: 'cancel' }: cancela en TN (restock=true) y CRM. Bloquea si ya
//     hay comprobante (cualquier estado distinto de 'rechazado').
//   - { action: 'wait', note: 'dice que paga' }: guarda nota.
// Una vez aplicada, payment_reminder_action_at queda seteado y la UI
// esconde los botones del pedido.
router.post('/:orderNumber/action', requirePermission('payment_reminders.view'), async (req, res) => {
  const { orderNumber } = req.params;
  const action = String(req.body?.action || '').trim();
  const note = String(req.body?.note || '').trim();

  if (!/^\d+$/.test(orderNumber)) {
    return res.status(400).json({ ok: false, error: 'orderNumber inválido' });
  }
  if (!['cancel', 'wait'].includes(action)) {
    return res.status(400).json({ ok: false, error: "action debe ser 'cancel' o 'wait'" });
  }
  if (action === 'wait' && note.length < 3) {
    return res.status(400).json({ ok: false, error: 'La nota debe tener al menos 3 caracteres' });
  }

  try {
    // 1. Pedido + idempotencia + comprobante
    const orderRes = await pool.query(
      `SELECT o.order_number, o.tn_order_id, o.estado_pedido,
              o.payment_reminder_action_at, o.payment_reminder_action_type,
              EXISTS (
                SELECT 1 FROM comprobantes
                WHERE order_number = o.order_number
                  AND COALESCE(estado,'') NOT IN ('rechazado')
              ) AS has_comprobante
         FROM orders_validated o
         WHERE o.order_number = $1`,
      [orderNumber]
    );
    if (orderRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
    }
    const order = orderRes.rows[0];

    if (order.payment_reminder_action_at) {
      return res.status(409).json({
        ok: false,
        error: `Ya se aplicó acción "${order.payment_reminder_action_type}" en este pedido`,
        action_applied: order.payment_reminder_action_type,
        action_at: order.payment_reminder_action_at
      });
    }

    if (action === 'wait') {
      await pool.query(
        `UPDATE orders_validated
            SET payment_reminder_note = $1,
                payment_reminder_action_at = NOW(),
                payment_reminder_action_type = 'wait'
          WHERE order_number = $2`,
        [note, orderNumber]
      );
      await logEvento({
        orderNumber,
        accion: `payment_reminder_wait: ${note.slice(0, 200)}`,
        origen: 'panel',
        userId: req.user?.id,
        username: req.user?.email || req.user?.name
      });
      return res.json({ ok: true, action: 'wait', note });
    }

    // action === 'cancel'
    if (order.has_comprobante) {
      return res.status(409).json({
        ok: false,
        error: 'El pedido tiene un comprobante cargado, no se puede cancelar desde acá. Revisar el comprobante primero.'
      });
    }
    if (order.estado_pedido === 'cancelado') {
      // Idempotencia silenciosa: si ya está cancelado, marcamos action_at y devolvemos OK.
      await pool.query(
        `UPDATE orders_validated
            SET payment_reminder_action_at = COALESCE(payment_reminder_action_at, NOW()),
                payment_reminder_action_type = COALESCE(payment_reminder_action_type, 'cancel')
          WHERE order_number = $1`,
        [orderNumber]
      );
      return res.json({ ok: true, action: 'cancel', note: 'Ya estaba cancelado' });
    }

    // 2. TN primero (si falla, NO tocamos DB → Melu reintenta sin queda inconsistente)
    if (!order.tn_order_id) {
      return res.status(409).json({
        ok: false,
        error: 'El pedido no tiene tn_order_id, no se puede cancelar en TiendaNube'
      });
    }
    const storeId = process.env.TIENDANUBE_STORE_ID;
    const token = process.env.TIENDANUBE_ACCESS_TOKEN;
    if (!storeId || !token) {
      return res.status(500).json({
        ok: false,
        error: 'Configuración de TiendaNube faltante en el servidor'
      });
    }

    try {
      await callTiendanubeWrite({
        method: 'POST',
        url: `https://api.tiendanube.com/v1/${storeId}/orders/${order.tn_order_id}/cancel`,
        headers: {
          'Authentication': `bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'BPM Administrador (netubpm@gmail.com)'
        },
        data: { reason: 'customer', email: true, restock: true }
      });
    } catch (tnErr) {
      const status = tnErr.response?.status;
      const data = tnErr.response?.data;
      console.error('[payment-reminders] TN cancel failed:', { status, data, msg: tnErr.message });
      // 404 (pedido borrado en TN) o si TN dice "ya estaba cancelado" → tratar como éxito y seguir
      const alreadyCancelled = status === 404 ||
        (typeof data === 'string' && /already.*cancel/i.test(data)) ||
        (data && typeof data === 'object' && JSON.stringify(data).match(/already.*cancel/i));
      if (!alreadyCancelled) {
        return res.status(502).json({
          ok: false,
          error: `No se pudo cancelar en TiendaNube (status=${status || 'sin respuesta'}). DB queda intacta, podés reintentar.`,
          tn_status: status,
          tn_data: data
        });
      }
    }

    // 3. DB después (TN OK o ya cancelado en TN)
    await pool.query(
      `UPDATE orders_validated
          SET estado_pedido = 'cancelado',
              payment_reminder_action_at = NOW(),
              payment_reminder_action_type = 'cancel',
              updated_at = NOW()
        WHERE order_number = $1`,
      [orderNumber]
    );
    await logEvento({
      orderNumber,
      accion: 'payment_reminder_cancel: TN restock=true',
      origen: 'panel',
      userId: req.user?.id,
      username: req.user?.email || req.user?.name
    });

    res.json({ ok: true, action: 'cancel', tn_restocked: true });
  } catch (err) {
    console.error('[payment-reminders] action error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
