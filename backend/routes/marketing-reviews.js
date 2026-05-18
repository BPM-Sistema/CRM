/**
 * Marketing → Reseñas Google
 *
 * Pipeline:
 *   1. Operador entra a /marketing/resenas y ve los pedidos elegibles
 *      (enviados hace 0-8 días, con teléfono, sin link previo).
 *   2. Confirma el envío → backend genera un token único por pedido,
 *      inserta una fila en review_request_links (status='pending') y
 *      manda el template solicitud_resena_google por Waspy.
 *   3. Si Waspy responde OK → status='sent', sent_at=NOW().
 *      Si falla → status='failed', send_error=reason.
 *   4. El cliente recibe el WhatsApp con un botón cuyo link es
 *      https://blanqueriaxmayor.com/resena/{token}.
 *   5. Al clickear, GET /resena/:token registra clicked_at + click_count
 *      y redirige (302) a la URL pública de Google Maps.
 *
 * Endpoints:
 *   GET  /resena/:token                    (público) → redirect a Google
 *   GET  /marketing/reviews/eligible       (auth + view) → pedidos sin link
 *   GET  /marketing/reviews/list           (auth + view) → links enviados
 *   GET  /marketing/reviews/stats          (auth + view) → KPIs
 *   POST /marketing/reviews/send           (auth + send) → batch send
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const waspyOutbound = require('../services/waspyOutbound');
const { apiLogger: log } = require('../lib/logger');

const GOOGLE_REVIEW_URL = 'https://g.page/r/CUODLKG8ZZm5EBM/review';
const ELIGIBILITY_DAYS = 8;

function generateToken() {
  // 6 bytes base64url ≈ 8 chars, ~2.8e14 combinaciones — suficiente para
  // decenas de miles de envíos sin colisiones.
  return crypto.randomBytes(6).toString('base64url');
}

// ============================================================
// PÚBLICO — GET /resena/:token (no auth, registra click y redirige)
// ============================================================
async function redirectByToken(req, res) {
  const { token } = req.params;
  if (!token || token.length > 64) {
    return res.redirect(302, GOOGLE_REVIEW_URL);
  }
  try {
    await pool.query(
      `UPDATE review_request_links
         SET clicked_at = COALESCE(clicked_at, NOW()),
             click_count = click_count + 1
       WHERE token = $1`,
      [token]
    );
  } catch (err) {
    // Si la DB falla no bloqueamos al cliente — redirigimos igual.
    log.error({ err: err.message, token }, '[marketing-reviews] failed to track click');
  }
  return res.redirect(302, GOOGLE_REVIEW_URL);
}

// ============================================================
// ADMIN — GET /eligible
// Pedidos enviados hace 0–8 días, con teléfono, sin link 'sent' previo.
// ============================================================
router.get('/eligible', authenticate, requirePermission('marketing.reviews.view'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        ov.order_number,
        ov.customer_name,
        ov.customer_phone,
        ov.shipped_at,
        EXTRACT(EPOCH FROM (NOW() - ov.shipped_at))/86400 AS days_since_shipped
      FROM orders_validated ov
      WHERE ov.estado_pedido = 'enviado'
        AND ov.shipped_at IS NOT NULL
        AND ov.shipped_at >= NOW() - ($1 || ' days')::interval
        AND ov.customer_phone IS NOT NULL
        AND ov.customer_phone <> ''
        AND NOT EXISTS (
          SELECT 1 FROM review_request_links rrl
          WHERE rrl.order_number = ov.order_number
            AND rrl.status = 'sent'
        )
      ORDER BY ov.shipped_at DESC
      LIMIT 500
    `, [ELIGIBILITY_DAYS]);

    res.json({
      eligible: r.rows,
      total: r.rowCount,
      window_days: ELIGIBILITY_DAYS,
    });
  } catch (err) {
    log.error({ err: err.message }, '[marketing-reviews] eligible error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN — GET /list
// Todos los pedidos de reseña enviados (con filtro opcional).
// ============================================================
router.get('/list', authenticate, requirePermission('marketing.reviews.view'), async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const status = req.query.status; // 'sent' | 'failed' | 'clicked' | undefined

    const conditions = [`rrl.created_at >= NOW() - ($1 || ' days')::interval`];
    const params = [days];

    if (status === 'sent') conditions.push(`rrl.status = 'sent' AND rrl.clicked_at IS NULL`);
    else if (status === 'failed') conditions.push(`rrl.status = 'failed'`);
    else if (status === 'clicked') conditions.push(`rrl.clicked_at IS NOT NULL`);

    const r = await pool.query(`
      SELECT
        rrl.id,
        rrl.order_number,
        rrl.customer_name,
        rrl.customer_phone,
        rrl.token,
        rrl.status,
        rrl.send_error,
        rrl.created_at,
        rrl.sent_at,
        rrl.clicked_at,
        rrl.click_count
      FROM review_request_links rrl
      WHERE ${conditions.join(' AND ')}
      ORDER BY rrl.created_at DESC
      LIMIT 1000
    `, params);

    res.json({ items: r.rows, total: r.rowCount });
  } catch (err) {
    log.error({ err: err.message }, '[marketing-reviews] list error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN — GET /stats
// ============================================================
router.get('/stats', authenticate, requirePermission('marketing.reviews.view'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent') AS total_sent,
        COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
        COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS total_clicked,
        COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '7 days') AS sent_last_7d,
        COUNT(*) FILTER (WHERE clicked_at IS NOT NULL AND clicked_at >= NOW() - INTERVAL '7 days') AS clicked_last_7d,
        COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '30 days') AS sent_last_30d,
        COUNT(*) FILTER (WHERE clicked_at IS NOT NULL AND clicked_at >= NOW() - INTERVAL '30 days') AS clicked_last_30d
      FROM review_request_links
    `);
    const row = r.rows[0] || {};
    const sent = Number(row.total_sent || 0);
    const clicked = Number(row.total_clicked || 0);
    res.json({
      ...row,
      conversion_rate: sent > 0 ? Math.round((clicked / sent) * 1000) / 10 : 0, // % con 1 decimal
    });
  } catch (err) {
    log.error({ err: err.message }, '[marketing-reviews] stats error');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN — POST /send
// Body: { order_numbers?: number[] }
//   Si viene order_numbers, manda solo a esos pedidos (validando elegibilidad).
//   Si no, manda a TODOS los elegibles.
// ============================================================
router.post('/send', authenticate, requirePermission('marketing.reviews.send'), async (req, res) => {
  const { order_numbers } = req.body || {};
  let targetFilter = '';
  const params = [ELIGIBILITY_DAYS];

  if (Array.isArray(order_numbers) && order_numbers.length > 0) {
    const orderNums = order_numbers
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (orderNums.length === 0) {
      return res.status(400).json({ error: 'order_numbers vacío o inválido' });
    }
    if (orderNums.length > 500) {
      return res.status(400).json({ error: 'máximo 500 pedidos por batch' });
    }
    params.push(orderNums);
    targetFilter = 'AND ov.order_number = ANY($2::bigint[])';
  }

  try {
    // 1. Leer pedidos elegibles (con filtro opcional).
    const r = await pool.query(`
      SELECT
        ov.order_number,
        ov.customer_name,
        ov.customer_phone
      FROM orders_validated ov
      WHERE ov.estado_pedido = 'enviado'
        AND ov.shipped_at IS NOT NULL
        AND ov.shipped_at >= NOW() - ($1 || ' days')::interval
        AND ov.customer_phone IS NOT NULL
        AND ov.customer_phone <> ''
        AND NOT EXISTS (
          SELECT 1 FROM review_request_links rrl
          WHERE rrl.order_number = ov.order_number
            AND rrl.status = 'sent'
        )
        ${targetFilter}
      ORDER BY ov.shipped_at DESC
      LIMIT 500
    `, params);

    const targets = r.rows;
    if (targets.length === 0) {
      return res.json({ ok: true, attempted: 0, sent: 0, failed: 0, results: [] });
    }

    // 2. Para cada uno: insert pending → mandar Waspy → update sent/failed.
    const results = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const t of targets) {
      const token = generateToken();
      let linkId = null;
      try {
        const ins = await pool.query(`
          INSERT INTO review_request_links
            (order_number, customer_phone, customer_name, token, status)
          VALUES ($1, $2, $3, $4, 'pending')
          RETURNING id
        `, [t.order_number, t.customer_phone, t.customer_name, token]);
        linkId = ins.rows[0].id;
      } catch (err) {
        results.push({ order_number: t.order_number, sent: false, reason: 'db_insert_failed', error: err.message });
        failedCount++;
        continue;
      }

      // Primer nombre nada más (la plantilla pide "Holaa Sofia!" no "Holaa Sofia Perez!").
      const firstName = (t.customer_name || '').trim().split(/\s+/)[0] || 'amig@';

      const waspyRes = await waspyOutbound.sendReviewRequestTemplate({
        to: t.customer_phone,
        variables: { '1': firstName, token },
      });

      if (waspyRes.sent) {
        await pool.query(`
          UPDATE review_request_links
             SET status = 'sent',
                 sent_at = NOW(),
                 provider_message_id = $1
           WHERE id = $2
        `, [waspyRes.providerMessageId || null, linkId]);
        sentCount++;
        results.push({ order_number: t.order_number, sent: true, providerMessageId: waspyRes.providerMessageId });
      } else {
        await pool.query(`
          UPDATE review_request_links
             SET status = 'failed',
                 send_error = $1
           WHERE id = $2
        `, [waspyRes.reason || 'unknown', linkId]);
        failedCount++;
        results.push({ order_number: t.order_number, sent: false, reason: waspyRes.reason, error: waspyRes.error });
      }
    }

    log.info(
      { attempted: targets.length, sent: sentCount, failed: failedCount, userId: req.user?.id },
      '[marketing-reviews] batch send done'
    );

    res.json({
      ok: true,
      attempted: targets.length,
      sent: sentCount,
      failed: failedCount,
      results,
    });
  } catch (err) {
    log.error({ err: err.message }, '[marketing-reviews] send error');
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  redirectByToken,
};
