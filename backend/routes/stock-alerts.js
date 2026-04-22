/**
 * Stock Alerts — "Avisarme cuando vuelva a stock"
 *
 * Fase 1: solo captura de intención + listado/stats en BPM.
 * Fase 2 (NO implementada): disparo automático de WhatsApp cuando
 * el producto/variante vuelve a tener stock.
 *
 * Endpoints:
 *   POST /stock-alerts            (público, con rate limit)  — crear alerta desde TN
 *   GET  /stock-alerts            (auth)                     — listar con filtros
 *   GET  /stock-alerts/stats      (auth)                     — estadísticas agregadas
 *   PATCH /stock-alerts/:id/cancel (auth)                    — marcar como cancelada
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

// Ventana de deduplicación: mismo phone + product + variant en las últimas 24h
// en estado pending se considera duplicado.
const DEDUPE_WINDOW_HOURS = 24;

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  // Remover prefijo 54 (AR) si está presente
  if (digits.startsWith('54')) digits = digits.slice(2);
  // Remover el "9" de celulares AR si está después del código
  // (no lo removemos aquí para preservar el formato real recibido)
  return digits;
}

function isValidPhone(digits) {
  return typeof digits === 'string' && digits.length >= 10 && digits.length <= 15;
}

// =====================================================
// POST /stock-alerts  —  Endpoint público (desde Tiendanube)
// =====================================================
async function createStockAlert(req, res) {
  try {
    const {
      product_id,
      variant_id,
      product_name,
      variant_name,
      phone,
      source,
    } = req.body || {};

    if (!product_id) {
      return res.status(400).json({ success: false, error: 'product_id es obligatorio' });
    }
    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone es obligatorio' });
    }

    const phoneClean = normalizePhone(phone);
    if (!isValidPhone(phoneClean)) {
      return res.status(400).json({
        success: false,
        error: 'El teléfono debe tener entre 10 y 15 dígitos',
      });
    }

    const productIdStr = String(product_id);
    const variantIdStr = variant_id ? String(variant_id) : null;
    const sourceStr = typeof source === 'string' && source.trim() ? source.trim().slice(0, 50) : 'tiendanube';

    // Dedupe: si ya existe una alerta pending reciente para mismo phone + product + variant,
    // devolvemos éxito con flag `duplicate: true` en lugar de crear otra.
    const existing = await pool.query(
      `SELECT id
       FROM stock_alerts
       WHERE phone = $1
         AND product_id = $2
         AND COALESCE(variant_id, '') = COALESCE($3, '')
         AND status = 'pending'
         AND created_at > NOW() - INTERVAL '${DEDUPE_WINDOW_HOURS} hours'
       LIMIT 1`,
      [phoneClean, productIdStr, variantIdStr]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        id: existing.rows[0].id,
        message: 'Ya estás suscripto a esta alerta',
      });
    }

    const result = await pool.query(
      `INSERT INTO stock_alerts
        (product_id, variant_id, product_name, variant_name, phone, source, user_agent, referer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        productIdStr,
        variantIdStr,
        product_name ? String(product_name).slice(0, 500) : null,
        variant_name ? String(variant_name).slice(0, 500) : null,
        phoneClean,
        sourceStr,
        req.get('User-Agent') || null,
        req.get('Referer') || null,
      ]
    );

    return res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('[stock-alerts] POST error:', error.message);
    return res.status(500).json({ success: false, error: 'Error al procesar la solicitud' });
  }
}

// =====================================================
// Rutas administrativas (requieren auth)
// =====================================================
router.use(authenticate);

// GET /stock-alerts  —  Lista con filtros
router.get('/', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const {
      product_id,
      variant_id,
      status,
      from,
      to,
      q, // búsqueda por producto/variante/teléfono
      limit = '200',
      offset = '0',
    } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (product_id) {
      conditions.push(`product_id = $${idx++}`);
      params.push(String(product_id));
    }
    if (variant_id) {
      conditions.push(`variant_id = $${idx++}`);
      params.push(String(variant_id));
    }
    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(String(status));
    }
    if (from) {
      conditions.push(`created_at >= $${idx++}`);
      params.push(new Date(String(from)));
    }
    if (to) {
      conditions.push(`created_at <= $${idx++}`);
      params.push(new Date(String(to)));
    }
    if (q) {
      const needle = `%${String(q).trim()}%`;
      conditions.push(`(product_name ILIKE $${idx} OR variant_name ILIKE $${idx} OR phone ILIKE $${idx})`);
      params.push(needle);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const lim = Math.min(parseInt(limit, 10) || 200, 1000);
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    const rowsQ = await pool.query(
      `SELECT
        id, product_id, variant_id, product_name, variant_name,
        phone, source, status, created_at, notified_at, cancelled_at
       FROM stock_alerts
       ${where}
       ORDER BY created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      params
    );

    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM stock_alerts ${where}`,
      params
    );

    res.json({
      success: true,
      total: countQ.rows[0].total,
      limit: lim,
      offset: off,
      items: rowsQ.rows,
    });
  } catch (error) {
    console.error('[stock-alerts] GET error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /stock-alerts/stats  —  Estadísticas agregadas
router.get('/stats', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const totalQ = await pool.query(`SELECT COUNT(*)::int AS total FROM stock_alerts`);
    const byStatusQ = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM stock_alerts
       GROUP BY status`
    );

    const topProductsQ = await pool.query(
      `SELECT product_id,
              COALESCE(MAX(product_name), product_id) AS product_name,
              COUNT(*)::int AS count
       FROM stock_alerts
       WHERE status = 'pending'
       GROUP BY product_id
       ORDER BY count DESC
       LIMIT 10`
    );

    const topVariantsQ = await pool.query(
      `SELECT product_id, variant_id,
              COALESCE(MAX(product_name), product_id) AS product_name,
              COALESCE(MAX(variant_name), '') AS variant_name,
              COUNT(*)::int AS count
       FROM stock_alerts
       WHERE status = 'pending' AND variant_id IS NOT NULL
       GROUP BY product_id, variant_id
       ORDER BY count DESC
       LIMIT 10`
    );

    const byDayQ = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS day,
              COUNT(*)::int AS count
       FROM stock_alerts
       WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY day
       ORDER BY day ASC`
    );

    const byStatus = { pending: 0, notified: 0, cancelled: 0 };
    for (const row of byStatusQ.rows) byStatus[row.status] = row.count;

    res.json({
      success: true,
      total: totalQ.rows[0].total,
      byStatus,
      topProducts: topProductsQ.rows,
      topVariants: topVariantsQ.rows,
      byDay: byDayQ.rows,
    });
  } catch (error) {
    console.error('[stock-alerts] GET /stats error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /stock-alerts/:id/cancel  —  Cancelar manualmente
router.patch('/:id/cancel', requirePermission('stock_alerts.manage'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: 'id inválido' });
    }

    const result = await pool.query(
      `UPDATE stock_alerts
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Alerta no encontrada o ya procesada' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[stock-alerts] PATCH cancel error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
module.exports.createStockAlertHandler = createStockAlert;
