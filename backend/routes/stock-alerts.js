/**
 * Stock Alerts — "Avisarme cuando vuelva a stock"
 *
 * Fase 1: captura de intención + panel en BPM.
 * Fase 2 (NO implementada): disparo automático de WhatsApp al reingreso.
 *
 * Endpoints:
 *   POST  /stock-alerts                (público, rate limit)  — crear alerta
 *   GET   /stock-alerts                (auth)  — lista plana con filtros
 *   GET   /stock-alerts/stats          (auth)  — KPIs agregados
 *   GET   /stock-alerts/by-customer    (auth)  — agrupado por teléfono
 *   GET   /stock-alerts/by-product     (auth)  — agrupado por producto+variante
 *   GET   /stock-alerts/facets         (auth)  — listas para filtros (productos, variantes)
 *   PATCH /stock-alerts/:id/cancel     (auth)  — cancelar manualmente
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

const DEDUPE_WINDOW_HOURS = 24;

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('54')) digits = digits.slice(2);
  return digits;
}
function isValidPhone(digits) {
  return typeof digits === 'string' && digits.length >= 10 && digits.length <= 15;
}
function truncate(str, max) {
  if (str == null) return null;
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

// =====================================================
// POST /stock-alerts — público (rate-limitado en index.js)
// =====================================================
async function createStockAlert(req, res) {
  try {
    const {
      product_id,
      variant_id,
      product_name,
      variant_name,
      phone,
      first_name,
      wants_news,
      source,
    } = req.body || {};

    if (!product_id) return res.status(400).json({ success: false, error: 'product_id es obligatorio' });
    if (!phone) return res.status(400).json({ success: false, error: 'phone es obligatorio' });

    const phoneClean = normalizePhone(phone);
    if (!isValidPhone(phoneClean)) {
      return res.status(400).json({ success: false, error: 'El teléfono debe tener entre 10 y 15 dígitos' });
    }

    const productIdStr = String(product_id);
    const variantIdStr = variant_id ? String(variant_id) : null;
    const sourceStr = typeof source === 'string' && source.trim() ? source.trim().slice(0, 50) : 'tiendanube';
    const firstNameClean = first_name ? truncate(String(first_name).trim(), 100) : null;
    const wantsNewsBool = wants_news === true || wants_news === 'true';

    // Dedupe: mismo phone+product+variant en pending dentro de la ventana
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
      // Enriquecer con datos nuevos si llegaron
      if (wantsNewsBool || firstNameClean) {
        await pool.query(
          `UPDATE stock_alerts
           SET wants_news = wants_news OR $2,
               first_name = COALESCE($3, first_name)
           WHERE id = $1`,
          [existing.rows[0].id, wantsNewsBool, firstNameClean]
        );
      }
      return res.status(200).json({
        success: true,
        duplicate: true,
        id: existing.rows[0].id,
        message: 'Ya estás suscripto a esta alerta',
      });
    }

    const result = await pool.query(
      `INSERT INTO stock_alerts
        (product_id, variant_id, product_name, variant_name, phone, first_name, wants_news, source, user_agent, referer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        productIdStr,
        variantIdStr,
        truncate(product_name, 500),
        truncate(variant_name, 500),
        phoneClean,
        firstNameClean,
        wantsNewsBool,
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
// Rutas admin
// =====================================================
router.use(authenticate);

// Helper: WHERE común a partir de query params
function buildFilters(query) {
  const conditions = [];
  const params = [];
  let idx = 1;

  const { product_id, variant_id, status, from, to, q, wants_news } = query;

  if (product_id) { conditions.push(`product_id = $${idx++}`); params.push(String(product_id)); }
  if (variant_id) { conditions.push(`variant_id = $${idx++}`); params.push(String(variant_id)); }
  if (status) { conditions.push(`status = $${idx++}`); params.push(String(status)); }
  if (from) { conditions.push(`created_at >= $${idx++}`); params.push(new Date(String(from))); }
  if (to) { conditions.push(`created_at <= $${idx++}`); params.push(new Date(String(to))); }
  if (wants_news === 'true' || wants_news === '1') {
    conditions.push(`wants_news = TRUE`);
  }
  if (q) {
    const needle = `%${String(q).trim()}%`;
    conditions.push(`(product_name ILIKE $${idx} OR variant_name ILIKE $${idx} OR phone ILIKE $${idx} OR first_name ILIKE $${idx})`);
    params.push(needle);
    idx++;
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params, nextIdx: idx };
}

// =====================================================
// GET / — lista plana
// =====================================================
router.get('/', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const { limit = '200', offset = '0', min_requests } = req.query;
    const { where, params, nextIdx } = buildFilters(req.query);

    // Filtro adicional: phones con ≥ min_requests en toda la tabla
    let extraWhere = '';
    const extraParams = [...params];
    let idx = nextIdx;
    const minReq = parseInt(min_requests, 10);
    if (Number.isInteger(minReq) && minReq > 1) {
      extraWhere = `${where ? ' AND' : 'WHERE'} phone IN (
        SELECT phone FROM stock_alerts GROUP BY phone HAVING COUNT(*) >= $${idx}
      )`;
      extraParams.push(minReq);
      idx++;
    }

    const lim = Math.min(parseInt(limit, 10) || 200, 1000);
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    const rowsQ = await pool.query(
      `SELECT id, product_id, variant_id, product_name, variant_name,
              phone, first_name, wants_news,
              source, status, created_at, notified_at, cancelled_at
       FROM stock_alerts
       ${where}${extraWhere}
       ORDER BY created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      extraParams
    );

    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM stock_alerts ${where}${extraWhere}`,
      extraParams
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

// =====================================================
// GET /stats — KPIs
// =====================================================
router.get('/stats', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const totalQ = await pool.query(`SELECT COUNT(*)::int AS total FROM stock_alerts`);
    const byStatusQ = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM stock_alerts GROUP BY status`
    );
    const uniqueQ = await pool.query(
      `SELECT COUNT(DISTINCT phone)::int AS unique_customers FROM stock_alerts`
    );
    const wantsNewsQ = await pool.query(
      `SELECT COUNT(DISTINCT phone)::int AS count FROM stock_alerts WHERE wants_news = TRUE`
    );
    const topProductsQ = await pool.query(
      `SELECT product_id,
              COALESCE(MAX(product_name), product_id) AS product_name,
              COUNT(DISTINCT phone)::int AS count
       FROM stock_alerts
       WHERE status = 'pending'
       GROUP BY product_id
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
      uniqueCustomers: uniqueQ.rows[0].unique_customers,
      wantsNews: wantsNewsQ.rows[0].count,
      byStatus,
      topProducts: topProductsQ.rows,
      byDay: byDayQ.rows,
    });
  } catch (error) {
    console.error('[stock-alerts] GET /stats error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// GET /by-customer — agrupado por teléfono
// =====================================================
router.get('/by-customer', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const { limit = '200', offset = '0', min_requests } = req.query;
    const { where, params, nextIdx } = buildFilters(req.query);

    const lim = Math.min(parseInt(limit, 10) || 200, 1000);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    let idx = nextIdx;

    let having = '';
    const minReq = parseInt(min_requests, 10);
    if (Number.isInteger(minReq) && minReq > 1) {
      having = `HAVING COUNT(*) >= $${idx}`;
      params.push(minReq);
      idx++;
    }

    const q = `
      SELECT
        phone,
        MAX(first_name)                    AS first_name,
        COUNT(*)::int                      AS request_count,
        COUNT(DISTINCT product_id)::int    AS distinct_products,
        MAX(created_at)                    AS last_created_at,
        MIN(created_at)                    AS first_created_at,
        BOOL_OR(wants_news)                AS wants_news,
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'id', id,
            'product_id', product_id,
            'product_name', product_name,
            'variant_id', variant_id,
            'variant_name', variant_name,
            'created_at', created_at,
            'status', status
          ) ORDER BY created_at DESC
        )                                  AS alerts
      FROM stock_alerts
      ${where}
      GROUP BY phone
      ${having}
      ORDER BY request_count DESC, last_created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `;
    const rowsQ = await pool.query(q, params);

    res.json({ success: true, items: rowsQ.rows, limit: lim, offset: off });
  } catch (error) {
    console.error('[stock-alerts] GET /by-customer error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// GET /by-product — agrupado por producto + variante
// =====================================================
router.get('/by-product', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const { limit = '200', offset = '0', min_requests } = req.query;
    const { where, params, nextIdx } = buildFilters(req.query);

    const lim = Math.min(parseInt(limit, 10) || 200, 1000);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    let idx = nextIdx;

    let having = '';
    const minReq = parseInt(min_requests, 10);
    if (Number.isInteger(minReq) && minReq > 1) {
      having = `HAVING COUNT(DISTINCT phone) >= $${idx}`;
      params.push(minReq);
      idx++;
    }

    const q = `
      SELECT
        product_id,
        variant_id,
        COALESCE(MAX(product_name), product_id)               AS product_name,
        COALESCE(MAX(variant_name), '')                       AS variant_name,
        COUNT(DISTINCT phone)::int                            AS people_count,
        COUNT(*)::int                                         AS total_alerts,
        COUNT(DISTINCT phone) FILTER (WHERE wants_news)::int  AS wants_news_count,
        MIN(created_at)                                       AS first_created_at,
        MAX(created_at)                                       AS last_created_at
      FROM stock_alerts
      ${where}
      GROUP BY product_id, variant_id
      ${having}
      ORDER BY people_count DESC, last_created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `;
    const rowsQ = await pool.query(q, params);

    res.json({ success: true, items: rowsQ.rows, limit: lim, offset: off });
  } catch (error) {
    console.error('[stock-alerts] GET /by-product error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// GET /facets — dropdowns de filtros
// =====================================================
router.get('/facets', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const productsQ = await pool.query(
      `SELECT product_id, COALESCE(MAX(product_name), product_id) AS product_name, COUNT(*)::int AS count
       FROM stock_alerts
       GROUP BY product_id
       ORDER BY count DESC
       LIMIT 200`
    );
    const variantsQ = await pool.query(
      `SELECT product_id, variant_id,
              COALESCE(MAX(product_name), product_id) AS product_name,
              COALESCE(MAX(variant_name), '') AS variant_name,
              COUNT(*)::int AS count
       FROM stock_alerts
       WHERE variant_id IS NOT NULL
       GROUP BY product_id, variant_id
       ORDER BY count DESC
       LIMIT 400`
    );
    res.json({ success: true, products: productsQ.rows, variants: variantsQ.rows });
  } catch (error) {
    console.error('[stock-alerts] GET /facets error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// GET /config — lee plantilla actual + lista de plantillas HSM ya usadas
// =====================================================
router.get('/config', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT key, plantilla_default
       FROM plantilla_tipos
       WHERE key IN ('stock_alert_reingreso', 'novedades_ingresos')`
    );
    const map = {};
    for (const r of q.rows) map[r.key] = r.plantilla_default || '';

    const availableQ = await pool.query(
      `SELECT DISTINCT plantilla_default AS name
       FROM plantilla_tipos
       WHERE plantilla_default IS NOT NULL AND plantilla_default <> ''
       ORDER BY plantilla_default ASC`
    );

    res.json({
      success: true,
      stockAlertTemplate: map['stock_alert_reingreso'] || '',
      novedadesTemplate: map['novedades_ingresos'] || '',
      availableTemplates: availableQ.rows.map((r) => r.name),
    });
  } catch (error) {
    console.error('[stock-alerts] GET /config error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// PUT /config — actualiza plantilla_default del catálogo
// =====================================================
router.put('/config', requirePermission('stock_alerts.manage'), async (req, res) => {
  try {
    const { stockAlertTemplate, novedadesTemplate } = req.body || {};
    const updates = [];
    if (typeof stockAlertTemplate === 'string') {
      updates.push(['stock_alert_reingreso', stockAlertTemplate.trim().slice(0, 200)]);
    }
    if (typeof novedadesTemplate === 'string') {
      updates.push(['novedades_ingresos', novedadesTemplate.trim().slice(0, 200)]);
    }
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'Nada que actualizar' });
    }
    for (const [key, val] of updates) {
      await pool.query(
        `UPDATE plantilla_tipos SET plantilla_default = $2 WHERE key = $1`,
        [key, val]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[stock-alerts] PUT /config error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// GET /sent-messages — historial de WhatsApps enviados por el dispatcher
// =====================================================
router.get('/sent-messages', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const { from, to, phone, limit = '100' } = req.query;

    const conditions = [`template_key = 'stock_alert_reingreso'`];
    const params = [];
    let idx = 1;
    if (from) { conditions.push(`status_updated_at >= $${idx++}`); params.push(new Date(String(from))); }
    if (to)   { conditions.push(`status_updated_at <= $${idx++}`); params.push(new Date(String(to))); }
    if (phone) {
      conditions.push(`contact_id ILIKE $${idx++}`);
      params.push(`%${String(phone).replace(/[^0-9]/g, '')}%`);
    }

    const lim = Math.min(parseInt(limit, 10) || 100, 500);

    const rowsQ = await pool.query(
      `SELECT id, request_id, contact_id, variables, status, created_at, status_updated_at
       FROM whatsapp_messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(status_updated_at, created_at) DESC, id DESC
       LIMIT ${lim}`,
      params
    );

    // Contadores útiles
    const totalsQ = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status NOT IN ('sent','pending'))::int AS failed,
         COUNT(*) FILTER (
           WHERE status = 'sent'
             AND status_updated_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')
         )::int AS sent_today,
         COUNT(*) FILTER (
           WHERE status = 'sent' AND status_updated_at > NOW() - INTERVAL '7 days'
         )::int AS sent_last_7d
       FROM whatsapp_messages
       WHERE template_key = 'stock_alert_reingreso'`
    );

    res.json({ success: true, totals: totalsQ.rows[0], items: rowsQ.rows });
  } catch (error) {
    console.error('[stock-alerts] GET /sent-messages error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// GET /last-run — métricas de la última corrida del dispatcher
// =====================================================
router.get('/last-run', requirePermission('stock_alerts.view'), async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT id, started_at, finished_at, trigger_source, dry_run,
              pairs_checked, fetched, fetch_errors,
              dispatched_products, alerts_sent, alerts_send_errors,
              skipped_no_template, updated_state, error_message
       FROM stock_alert_runs
       ORDER BY started_at DESC
       LIMIT 1`
    );
    res.json({ success: true, run: q.rows[0] || null });
  } catch (error) {
    console.error('[stock-alerts] GET /last-run error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// Test send handler — envío único a un teléfono específico
// Se monta en index.js como POST /stock-alerts/cron/test-send (verifyCronAuth)
// =====================================================
async function testSendHandler(req, res) {
  try {
    const { phone, product_id, first_name } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, error: 'phone requerido' });
    if (!product_id) return res.status(400).json({ success: false, error: 'product_id requerido' });

    const axios = require('axios');
    const storeId = process.env.TIENDANUBE_STORE_ID;
    const token = process.env.TIENDANUBE_ACCESS_TOKEN;
    if (!storeId || !token) {
      return res.status(500).json({ success: false, error: 'TN credentials missing' });
    }

    // Fetch producto
    const { data: product } = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/products/${product_id}`,
      { headers: { Authentication: `bearer ${token}` }, timeout: 15000 }
    );

    const productName = (product.name && typeof product.name === 'object')
      ? (product.name.es || Object.values(product.name)[0])
      : (product.name || product_id);
    const productHandle = (product.handle && typeof product.handle === 'object')
      ? (product.handle.es || Object.values(product.handle)[0])
      : (product.handle || '');
    // Meta no acepta .webp como header de template → primera imagen PNG/JPG
    const headerImageUrl = (() => {
      const imgs = product.images;
      if (!Array.isArray(imgs) || imgs.length === 0) return null;
      const sup = imgs.find((img) => {
        const src = img && img.src;
        return typeof src === 'string' && /\.(png|jpe?g)(\?|$)/i.test(src);
      });
      return (sup && sup.src) || (imgs[0] && imgs[0].src) || null;
    })();

    const variables = {
      '1': first_name || 'Cliente',
      '2': productName,
      '3': productHandle,
    };
    if (headerImageUrl) variables.headerImageUrl = headerImageUrl;

    const queueWhatsApp = req.app.locals.queueWhatsApp;
    if (typeof queueWhatsApp !== 'function') {
      return res.status(500).json({ success: false, error: 'queueWhatsApp no disponible' });
    }

    await queueWhatsApp({
      telefono: String(phone),
      plantilla: 'stock_alert_reingreso',
      variables,
      orderNumber: null,
    });

    res.json({
      success: true,
      message: 'Encolado. Revisá que el mensaje llegue en ~5-30s.',
      phone,
      variables,
      productUrl: product.canonical_url || null,
    });
  } catch (err) {
    console.error('[stock-alerts] test-send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

// =====================================================
// Cron dispatch handler (exportado; se monta en index.js con verifyCronAuth)
// =====================================================
async function cronDispatchHandler(req, res) {
  try {
    const dryRun = req.query.dry_run === '1' || req.query.dryRun === '1';
    // queueWhatsApp vive en index.js; lo recibimos por closure inyectado (ver index.js)
    const { runDispatcher } = require('../services/stockAlertDispatcher');
    const queueWhatsApp = req.app.locals.queueWhatsApp;
    if (typeof queueWhatsApp !== 'function') {
      return res.status(500).json({ success: false, error: 'queueWhatsApp no disponible' });
    }
    const stats = await runDispatcher({
      queueWhatsApp,
      dryRun,
      triggerSource: req.cronAuth?.method === 'oidc' ? 'cron' : (req.cronAuth?.method === 'secret' ? 'cron-secret' : 'manual'),
    });
    res.json({ success: true, stats });
  } catch (error) {
    console.error('[stock-alerts] cron dispatch error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

// =====================================================
// PATCH /:id/cancel
// =====================================================
router.patch('/:id/cancel', requirePermission('stock_alerts.manage'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'id inválido' });

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
module.exports.cronDispatchHandler = cronDispatchHandler;
module.exports.testSendHandler = testSendHandler;
