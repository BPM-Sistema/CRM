/**
 * Admin Divergence Routes
 *
 * POST /admin/divergences/audit   — Auditar divergencias de uno o varios pedidos
 * POST /admin/divergences/fix     — Corregir divergencias auto_fixable
 * GET  /admin/divergences/stats   — Resumen de divergencias recientes
 * GET  /admin/divergences/:orderNumber — Divergencias abiertas de un pedido
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { callTiendanube } = require('../lib/circuitBreaker');
const { isEnabled: isIntegrationEnabled } = require('../services/integrationConfig');
const {
  buildDivergenceReport,
  saveDivergences,
  applyAutoFixes,
  getBpmOrderForComparison,
  getOpenDivergences,
  getDivergenceStats,
} = require('../lib/divergence-detector');
const log = require('../lib/logger');

// ── POST /admin/divergences/audit ────────────────────────────────
// Auditar un pedido específico o un rango
// Body: { order_number?: string, from_order?: number, to_order?: number, days?: number }
router.post('/audit', authenticate, requirePermission('activity.view'), async (req, res) => {
  try {
    const { order_number, from_order, to_order, days } = req.body;
    const storeId = process.env.TIENDANUBE_STORE_ID;
    const results = [];

    // Obtener toggles una vez
    const toggles = {};
    const toggleKeys = [
      'tiendanube_webhook_sync_payment', 'tiendanube_webhook_sync_shipping',
      'tiendanube_webhook_sync_products', 'tiendanube_webhook_sync_customer',
      'tiendanube_webhook_sync_address', 'tiendanube_webhook_sync_notes',
    ];
    for (const key of toggleKeys) {
      toggles[key] = await isIntegrationEnabled(key, { context: 'manual_audit' });
    }

    let orders;

    if (order_number) {
      // Auditar un solo pedido
      orders = await pool.query(
        `SELECT order_number, tn_order_id FROM orders_validated WHERE order_number = $1`,
        [String(order_number)]
      );
    } else if (from_order && to_order) {
      // Rango de pedidos
      orders = await pool.query(
        `SELECT order_number, tn_order_id FROM orders_validated
         WHERE order_number::int BETWEEN $1 AND $2
           AND tn_order_id IS NOT NULL
         ORDER BY order_number::int`,
        [from_order, to_order]
      );
    } else {
      // Últimos N días (default 3)
      const d = Math.min(days || 3, 30);
      orders = await pool.query(
        `SELECT order_number, tn_order_id FROM orders_validated
         WHERE tn_order_id IS NOT NULL AND created_at > NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC`,
        [d]
      );
    }

    if (orders.rowCount === 0) {
      return res.json({ ok: true, message: 'No orders found', results: [] });
    }

    for (const row of orders.rows) {
      try {
        // Fetch de TN
        const tnResponse = await callTiendanube({
          method: 'get',
          url: `https://api.tiendanube.com/v1/${storeId}/orders/${row.tn_order_id}`,
          headers: {
            authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
            'User-Agent': 'bpm-divergence-audit',
          },
          timeout: 10000,
        });
        const tnOrder = tnResponse.data;

        // BPM order extendido
        const bpmOrder = await getBpmOrderForComparison(row.order_number);
        if (!bpmOrder) continue;

        // Generar reporte
        const report = buildDivergenceReport(tnOrder, bpmOrder, { toggles });

        // Persistir divergencias
        if (report.divergences.length > 0) {
          await saveDivergences(row.order_number, row.tn_order_id, report.divergences, 'manual_audit');
        }

        results.push({
          order_number: row.order_number,
          tn_order_id: row.tn_order_id,
          ...report.summary,
          divergences: report.divergences,
        });

        // Rate limit: 200ms entre pedidos para no saturar TN API
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        results.push({
          order_number: row.order_number,
          error: err.message,
        });
      }
    }

    const totalDivergences = results.reduce((sum, r) => sum + (r.total || 0), 0);
    const totalCritical = results.reduce((sum, r) => sum + (r.critical || 0), 0);

    res.json({
      ok: true,
      orders_audited: results.length,
      total_divergences: totalDivergences,
      total_critical: totalCritical,
      results,
    });
  } catch (error) {
    log.error({ err: error }, 'Error in divergence audit');
    res.status(500).json({ error: error.message });
  }
});

// ── POST /admin/divergences/fix ──────────────────────────────────
// Corregir divergencias auto_fixable abiertas
// Body: { order_number?: string, max_orders?: number }
router.post('/fix', authenticate, requirePermission('activity.view'), async (req, res) => {
  try {
    const { order_number, max_orders } = req.body;
    const fixedBy = `manual:${req.user.email}`;

    // Verificar toggle de autofix
    const autofixEnabled = await isIntegrationEnabled('tiendanube_divergence_autofix', { context: 'manual_fix' });
    if (!autofixEnabled) {
      return res.status(403).json({ ok: false, error: 'Toggle tiendanube_divergence_autofix está OFF' });
    }

    // Obtener toggles granulares
    const toggles = {};
    const toggleKeys = [
      'tiendanube_webhook_sync_payment', 'tiendanube_webhook_sync_shipping',
      'tiendanube_webhook_sync_products', 'tiendanube_webhook_sync_customer',
      'tiendanube_webhook_sync_address', 'tiendanube_webhook_sync_notes',
    ];
    for (const key of toggleKeys) {
      toggles[key] = await isIntegrationEnabled(key, { context: 'manual_fix' });
    }

    let query;
    let params;

    if (order_number) {
      query = `
        SELECT DISTINCT order_number FROM order_divergences
        WHERE order_number = $1 AND status = 'open' AND auto_fixable = true
      `;
      params = [String(order_number)];
    } else {
      const limit = Math.min(max_orders || 50, 200);
      query = `
        SELECT DISTINCT order_number FROM order_divergences
        WHERE status = 'open' AND auto_fixable = true
        ORDER BY order_number
        LIMIT $1
      `;
      params = [limit];
    }

    const ordersToFix = await pool.query(query, params);
    const results = [];

    for (const row of ordersToFix.rows) {
      const divergences = await getOpenDivergences(row.order_number);
      const fixable = divergences.filter(d => d.auto_fixable);

      if (fixable.length === 0) continue;

      // Mapear rows de DB al formato que espera applyAutoFixes
      const mapped = fixable.map(d => ({
        field_name: d.field_name,
        category: d.category,
        severity: d.severity,
        tn_value: d.tn_value,
        bpm_value: d.bpm_value,
        expected_value: d.expected_value,
        auto_fixable: true,
      }));

      const result = await applyAutoFixes(row.order_number, mapped, { fixedBy, toggles });
      results.push({ order_number: row.order_number, ...result });
    }

    const totalFixed = results.reduce((sum, r) => sum + r.fixed, 0);
    const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);

    log.info({ totalFixed, totalSkipped, fixedBy, orders: results.length }, 'Manual divergence fix completed');

    res.json({
      ok: true,
      orders_processed: results.length,
      total_fixed: totalFixed,
      total_skipped: totalSkipped,
      results,
    });
  } catch (error) {
    log.error({ err: error }, 'Error in divergence fix');
    res.status(500).json({ error: error.message });
  }
});

// ── GET /admin/divergences/stats ─────────────────────────────────
router.get('/stats', authenticate, requirePermission('activity.view'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const stats = await getDivergenceStats({ days });

    // Top pedidos con más divergencias abiertas
    const topOrders = await pool.query(`
      SELECT order_number, COUNT(*)::int as count,
             COUNT(*) FILTER (WHERE severity = 'critical')::int as critical
      FROM order_divergences
      WHERE status = 'open'
      GROUP BY order_number
      ORDER BY critical DESC, count DESC
      LIMIT 20
    `);

    res.json({ ok: true, days, stats, top_orders: topOrders.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /admin/divergences/:orderNumber ──────────────────────────
router.get('/:orderNumber', authenticate, requirePermission('activity.view'), async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { status } = req.query; // 'open', 'fixed', 'all'

    let query, params;
    if (status === 'all') {
      query = `SELECT * FROM order_divergences WHERE order_number = $1 ORDER BY created_at DESC`;
      params = [orderNumber];
    } else {
      query = `SELECT * FROM order_divergences WHERE order_number = $1 AND status = $2 ORDER BY created_at DESC`;
      params = [orderNumber, status || 'open'];
    }

    const r = await pool.query(query, params);
    res.json({ ok: true, order_number: orderNumber, count: r.rowCount, divergences: r.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
