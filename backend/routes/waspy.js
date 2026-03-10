/**
 * Rutas proxy para Waspy (WhatsApp integration)
 * Proxies CRM frontend requests to Waspy via waspyClient service
 */

const express = require('express');
const pool = require('../db');
const { authenticate, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { generateWaspyToken, waspyFetch } = require('../services/waspyClient');
const { normalizePhone } = require('../utils/phoneNormalize');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ---------------------------------------------------------------------------
// 1. GET /waspy/token - Generate Waspy JWT for current user
// ---------------------------------------------------------------------------
router.get('/token', requireAnyPermission(['inbox.view', 'inbox.send']), async (req, res) => {
  try {
    const token = generateWaspyToken(req.user);
    res.json({ ok: true, token });
  } catch (error) {
    console.error('Waspy token error:', error.message);
    res.status(500).json({ error: 'Error al generar token de Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /waspy/me - Get Waspy user profile
// ---------------------------------------------------------------------------
router.get('/me', requirePermission('inbox.view'), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'GET', '/api/v1/integration/me');
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 3. GET /waspy/channel/status - Get WhatsApp channel status
// ---------------------------------------------------------------------------
router.get('/channel/status', requirePermission('inbox.view'), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'GET', '/api/v1/integration/channel/status');
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 4. GET /waspy/conversations - List conversations
// ---------------------------------------------------------------------------
router.get('/conversations', requirePermission('inbox.view'), async (req, res) => {
  try {
    const query = new URLSearchParams(req.query).toString();
    const path = '/api/v1/integration/inbox/conversations' + (query ? `?${query}` : '');
    const result = await waspyFetch(req.user, 'GET', path);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 5. GET /waspy/conversations/:id/messages - Get messages for a conversation
// ---------------------------------------------------------------------------
router.get('/conversations/:id/messages', requirePermission('inbox.view'), async (req, res) => {
  try {
    const query = new URLSearchParams(req.query).toString();
    const path = `/api/v1/integration/inbox/conversations/${req.params.id}/messages` + (query ? `?${query}` : '');
    const result = await waspyFetch(req.user, 'GET', path);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 6. POST /waspy/messages - Send a message
// ---------------------------------------------------------------------------
router.post('/messages', requirePermission('inbox.send'), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'POST', '/api/v1/integration/inbox/messages', req.body);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 7. GET /waspy/templates - List templates
// ---------------------------------------------------------------------------
router.get('/templates', requireAnyPermission(['templates.view', 'templates.send']), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'GET', '/api/v1/integration/inbox/templates');
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 8. POST /waspy/templates/send - Send a template
// ---------------------------------------------------------------------------
router.post('/templates/send', requirePermission('templates.send'), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'POST', '/api/v1/integration/inbox/templates/send', req.body);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 9. GET /waspy/conversations/:id/context - Get conversation context
// ---------------------------------------------------------------------------
router.get('/conversations/:id/context', requirePermission('inbox.view'), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'GET', `/api/v1/integration/inbox/conversations/${req.params.id}/context`);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 10. POST /waspy/channel/connect/start - Start WhatsApp connection
// ---------------------------------------------------------------------------
router.post('/channel/connect/start', requirePermission('whatsapp.connect'), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'POST', '/api/v1/integration/channel/meta/connect/start', req.body);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 11. GET /waspy/channel/connect/status - Check connection status
// ---------------------------------------------------------------------------
router.get('/channel/connect/status', requirePermission('whatsapp.connect'), async (req, res) => {
  try {
    const result = await waspyFetch(req.user, 'GET', '/api/v1/integration/channel/meta/connect/status');
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 12. GET /waspy/orders/by-phone - Search orders by phone number
// ---------------------------------------------------------------------------
router.get('/orders/by-phone', requirePermission('inbox.view'), async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: 'El parámetro phone es requerido' });
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
      return res.status(400).json({ error: 'Teléfono inválido' });
    }
    // Use last 8 digits for flexible matching on customer_phone
    const last8 = normalized.slice(-8);

    const { rows } = await pool.query(
      `SELECT order_number, customer_name, customer_email, customer_phone,
              monto_tiendanube, total_pagado, estado_pago, estado_pedido, created_at
       FROM orders_validated
       WHERE customer_phone LIKE '%' || $1 || '%'
       ORDER BY created_at DESC
       LIMIT 20`,
      [last8]
    );

    res.json({ ok: true, orders: rows });
  } catch (error) {
    console.error('Orders by phone error:', error.message);
    res.status(500).json({ error: 'Error al buscar órdenes' });
  }
});

// ---------------------------------------------------------------------------
// 13. GET /waspy/conversations/:id/orders - Get orders linked to a conversation
// ---------------------------------------------------------------------------
router.get('/conversations/:id/orders', requirePermission('inbox.view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ov.order_number, ov.customer_name, ov.customer_email, ov.customer_phone,
              ov.monto_tiendanube, ov.total_pagado, ov.estado_pago, ov.estado_pedido,
              ov.created_at, co.created_by, co.created_at AS linked_at
       FROM conversation_orders co
       JOIN orders_validated ov ON ov.order_number = co.order_number
       WHERE co.conversation_id = $1
       ORDER BY co.created_at DESC`,
      [req.params.id]
    );

    res.json({ ok: true, orders: rows });
  } catch (error) {
    console.error('Conversation orders error:', error.message);
    res.status(500).json({ error: 'Error al obtener órdenes de la conversación' });
  }
});

// ---------------------------------------------------------------------------
// 14. POST /waspy/conversations/:id/orders - Link an order to a conversation
// ---------------------------------------------------------------------------
router.post('/conversations/:id/orders', requirePermission('inbox.assign'), async (req, res) => {
  try {
    const { order_number } = req.body;
    if (!order_number) {
      return res.status(400).json({ error: 'El campo order_number es requerido' });
    }

    await pool.query(
      `INSERT INTO conversation_orders (conversation_id, order_number, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, order_number, req.user.id]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error('Link order error:', error.message);
    res.status(500).json({ error: 'Error al vincular orden' });
  }
});

// ---------------------------------------------------------------------------
// 15. DELETE /waspy/conversations/:id/orders/:orderNumber - Unlink an order
// ---------------------------------------------------------------------------
router.delete('/conversations/:id/orders/:orderNumber', requirePermission('inbox.assign'), async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM conversation_orders
       WHERE conversation_id = $1 AND order_number = $2`,
      [req.params.id, req.params.orderNumber]
    );

    res.json({ ok: true });
  } catch (error) {
    console.error('Unlink order error:', error.message);
    res.status(500).json({ error: 'Error al desvincular orden' });
  }
});

module.exports = router;
