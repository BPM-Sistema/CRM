/**
 * Rutas Waspy — CRM backend
 *
 * Con el inbox embebido de Waspy, el CRM ya no proxea endpoints de chat
 * (conversaciones, mensajes, templates). Solo conserva:
 *   - Embed token (pedido a Waspy via API key)
 *   - Config management (guardar/verificar API key)
 *   - Channel status / connect (para WhatsAppSettings)
 *   - Order management (búsqueda por teléfono, vinculación conversación↔pedido)
 */

const express = require('express');
const pool = require('../db');
const { authenticate, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { getWaspyConfig, waspyFetch, getEmbedToken, verifyConnection, mapRole } = require('../services/waspyClient');
const { normalizePhone } = require('../utils/phoneNormalize');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ---------------------------------------------------------------------------
// 1. GET /waspy/token - Get embed token from Waspy
// ---------------------------------------------------------------------------
router.get('/token', requireAnyPermission(['inbox.view', 'inbox.send']), async (req, res) => {
  try {
    const waspyRole = mapRole(req.user.role_name);
    const { token } = await getEmbedToken(waspyRole);
    res.json({ ok: true, token });
  } catch (error) {
    console.error('Waspy embed token error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /waspy/config - Get current Waspy config (without full API key)
// ---------------------------------------------------------------------------
router.get('/config', requireAnyPermission(['whatsapp.connect', 'inbox.view']), async (req, res) => {
  try {
    const config = await getWaspyConfig();
    res.json({
      ok: true,
      config: {
        tenantId: config.tenant_id,
        tenantName: config.tenant_name,
        waspyUrl: config.waspy_url,
        embedUrl: config.embed_url,
        apiKeyPrefix: config.api_key.substring(0, 12) + '...',
        verifiedAt: config.verified_at,
      },
    });
  } catch {
    // Not configured yet — that's fine
    res.json({ ok: true, config: null });
  }
});

// ---------------------------------------------------------------------------
// 3. POST /waspy/config - Save and verify API key
// ---------------------------------------------------------------------------
router.post('/config', requirePermission('whatsapp.connect'), async (req, res) => {
  const {
    apiKey,
    waspyUrl = process.env.WASPY_DEFAULT_URL || 'https://waspy-api-261840423811.us-central1.run.app',
    embedUrl = process.env.WASPY_DEFAULT_EMBED_URL || 'https://web-m2q3m7ufqa-uc.a.run.app/embed/inbox',
  } = req.body;

  if (!apiKey || !apiKey.startsWith('wspy_')) {
    return res.status(400).json({ ok: false, error: 'API Key inválido. Debe empezar con wspy_' });
  }

  try {
    const info = await verifyConnection(apiKey, waspyUrl);

    await pool.query(
      `INSERT INTO waspy_config (api_key, tenant_id, tenant_name, waspy_url, embed_url, verified_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT ((true)) DO UPDATE SET
         api_key = $1, tenant_id = $2, tenant_name = $3,
         waspy_url = $4, embed_url = $5,
         verified_at = now(), updated_at = now()`,
      [apiKey, info.tenant.id, info.tenant.name, waspyUrl, embedUrl]
    );

    res.json({
      ok: true,
      tenant: info.tenant,
      phoneNumbers: info.phoneNumbers,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: `No se pudo verificar: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// 4. DELETE /waspy/config - Disconnect Waspy
// ---------------------------------------------------------------------------
router.delete('/config', requirePermission('whatsapp.connect'), async (req, res) => {
  await pool.query('DELETE FROM waspy_config');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 5. GET /waspy/channel/status - Get WhatsApp channel status
// ---------------------------------------------------------------------------
router.get('/channel/status', requirePermission('inbox.view'), async (req, res) => {
  try {
    const result = await waspyFetch('GET', '/api/v1/integration/channel/status');
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 6. POST /waspy/channel/connect/start - Start WhatsApp connection
// ---------------------------------------------------------------------------
router.post('/channel/connect/start', requirePermission('whatsapp.connect'), async (req, res) => {
  try {
    const result = await waspyFetch('POST', '/api/v1/integration/channel/meta/connect/start', req.body);
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 7. GET /waspy/channel/connect/status - Check connection status
// ---------------------------------------------------------------------------
router.get('/channel/connect/status', requirePermission('whatsapp.connect'), async (req, res) => {
  try {
    const result = await waspyFetch('GET', '/api/v1/integration/channel/meta/connect/status');
    res.status(result.status).json(result.data);
  } catch (error) {
    console.error('Waspy proxy error:', error.message);
    res.status(502).json({ error: 'Error al comunicarse con Waspy' });
  }
});

// ---------------------------------------------------------------------------
// 8. GET /waspy/orders/by-phone - Search orders by phone number
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
// 9. GET /waspy/conversations/:id/orders - Get orders linked to a conversation
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
// 10. POST /waspy/conversations/:id/orders - Link an order to a conversation
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
// 11. DELETE /waspy/conversations/:id/orders/:orderNumber - Unlink an order
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
