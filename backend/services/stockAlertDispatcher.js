/**
 * Stock Alert Dispatcher — Fase 2
 *
 * Ejecutado por Cloud Scheduler cada 1h (POST /stock-alerts/cron/dispatch).
 *
 * Lógica:
 *   1. Listar pares (product_id, variant_id) con alertas pending.
 *   2. Consultar stock actual en Tiendanube API.
 *   3. Disparar WhatsApp SOLO si:
 *        last_seen_stock = 0  AND  current_stock > 0   (edge detection)
 *   4. Cada envío usa queueWhatsApp (usa el worker/queue existente).
 *   5. Actualiza stock_alert_stock_state.last_seen_stock para prevenir
 *      reenvíos mientras el stock siga > 0.
 *
 * Garantías:
 *   - NO envía mientras stock sigue > 0 (updateamos last_seen en cada corrida).
 *   - NO envía si la plantilla no fue configurada aún (plantilla_default='').
 *   - NO envía duplicados: marcamos status='notified' inmediatamente.
 *   - Respeta el queueWhatsApp existente (NO llamadas directas a Botmaker).
 */

const axios = require('axios');
const pool = require('../db');
const { apiLogger: log } = require('../lib/logger');

const TN_BASE_URL = 'https://api.tiendanube.com/v1';
const TN_REQUEST_DELAY_MS = 650; // TN permite ~2 rps; quedamos cómodos con ~1.5 rps
const STOCK_ALERT_PLANTILLA_KEY = 'stock_alert_reingreso';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTnHeaders() {
  const token = process.env.TIENDANUBE_ACCESS_TOKEN;
  if (!token) throw new Error('TIENDANUBE_ACCESS_TOKEN no configurado');
  return {
    Authentication: `bearer ${token}`,
    'User-Agent': 'BPM-StockAlerts (admin@bpmadministrador.com)',
    'Content-Type': 'application/json',
  };
}

async function fetchProduct(productId) {
  const storeId = process.env.TIENDANUBE_STORE_ID;
  if (!storeId) throw new Error('TIENDANUBE_STORE_ID no configurado');
  const url = `${TN_BASE_URL}/${storeId}/products/${productId}`;
  const res = await axios.get(url, { headers: getTnHeaders(), timeout: 15000 });
  return res.data;
}

/**
 * Resolve plantilla_default for stock_alert_reingreso.
 * Retorna string no-vacío (OK) o null (no configurado).
 */
async function getConfiguredTemplate() {
  const q = await pool.query(
    `SELECT plantilla_default FROM plantilla_tipos WHERE key = $1 LIMIT 1`,
    [STOCK_ALERT_PLANTILLA_KEY]
  );
  const v = q.rows[0]?.plantilla_default;
  return v && String(v).trim() ? String(v).trim() : null;
}

/**
 * Stock total del producto (suma de variants) o de una variante específica.
 * Retorna número (puede ser 0) o null si no pudimos determinar.
 */
function computeStock(product, variantId) {
  if (!product || !Array.isArray(product.variants)) return null;

  if (variantId) {
    const v = product.variants.find((x) => String(x.id) === String(variantId));
    if (!v) return null;
    // stock_management=false → sin control de stock → considerar disponible (999)
    if (v.stock_management === false) return 999;
    return Number.isFinite(Number(v.stock)) ? Number(v.stock) : 0;
  }

  // Producto global: suma de variants
  let total = 0;
  for (const v of product.variants) {
    if (v.stock_management === false) return 999;
    total += Number(v.stock) || 0;
  }
  return total;
}

/**
 * URL al producto. Prefiere canonical_url/permalink; fallback por handle.
 */
function buildProductUrl(product, storeBaseUrl) {
  if (!product) return '';
  if (product.canonical_url) return product.canonical_url;
  if (product.permalink) return product.permalink;
  const handle = product.handle && typeof product.handle === 'object'
    ? (product.handle.es || product.handle.pt || Object.values(product.handle)[0])
    : product.handle;
  if (handle && storeBaseUrl) return `${storeBaseUrl.replace(/\/$/, '')}/productos/${handle}`;
  return '';
}

/**
 * Handler principal. El caller debe inyectar queueWhatsApp desde el scope del index.js.
 */
async function runDispatcher({ queueWhatsApp, dryRun = false, triggerSource = 'cron' } = {}) {
  const stats = {
    pairs: 0,
    fetched: 0,
    fetch_errors: 0,
    dispatched_products: 0,
    alerts_sent: 0,
    alerts_send_errors: 0,
    skipped_no_template: false,
    updated_state: 0,
    dry_run: !!dryRun,
  };

  // Registrar arranque de la corrida
  let runId = null;
  try {
    const ins = await pool.query(
      `INSERT INTO stock_alert_runs (trigger_source, dry_run)
       VALUES ($1, $2) RETURNING id`,
      [triggerSource, !!dryRun]
    );
    runId = ins.rows[0].id;
  } catch (e) {
    log.warn({ err: e.message }, '[stockAlertDispatcher] no se pudo registrar run (continuando igual)');
  }

  const plantillaKey = STOCK_ALERT_PLANTILLA_KEY;
  const configuredTemplate = await getConfiguredTemplate();
  if (!configuredTemplate) {
    log.warn('[stockAlertDispatcher] plantilla_default vacío para stock_alert_reingreso — se actualiza estado pero NO se envía');
    stats.skipped_no_template = true;
  }

  const storeBaseUrl = process.env.TIENDANUBE_STORE_URL || 'https://blanqueriaxmayorista.com';

  // 1. Pares con alertas pending
  const pairsQ = await pool.query(`
    SELECT product_id, COALESCE(variant_id, '') AS variant_id
    FROM stock_alerts
    WHERE status = 'pending'
    GROUP BY product_id, variant_id
    ORDER BY product_id, variant_id
  `);
  stats.pairs = pairsQ.rows.length;
  log.info({ pairs: stats.pairs }, '[stockAlertDispatcher] starting');

  // Cache por productId para no pedir dos veces el mismo producto
  const productCache = new Map();

  for (const row of pairsQ.rows) {
    const productId = row.product_id;
    const variantId = row.variant_id || null;
    const pairLabel = `${productId}/${variantId || 'null'}`;

    try {
      // 2. Fetch producto (con cache)
      let product = productCache.get(productId);
      if (!product) {
        await sleep(TN_REQUEST_DELAY_MS);
        try {
          product = await fetchProduct(productId);
          productCache.set(productId, product);
          stats.fetched++;
        } catch (err) {
          stats.fetch_errors++;
          log.warn({ err: err.message, productId }, '[stockAlertDispatcher] fetch error');
          continue;
        }
      }

      const currentStock = computeStock(product, variantId);
      if (currentStock == null) {
        log.warn({ productId, variantId }, '[stockAlertDispatcher] variant not found, skipping');
        continue;
      }

      // 3. Last seen
      const stateQ = await pool.query(
        `SELECT last_seen_stock
         FROM stock_alert_stock_state
         WHERE product_id = $1 AND variant_id = $2`,
        [productId, variantId || '']
      );
      const lastSeen = stateQ.rows[0]?.last_seen_stock;
      const firstTime = lastSeen == null;

      // 4. Edge detection: dispara si last=0 y current>0
      const shouldDispatch =
        !firstTime &&
        lastSeen === 0 &&
        currentStock > 0 &&
        !!configuredTemplate;

      if (shouldDispatch) {
        // 5. Traer todas las alertas pending para este par y disparar
        const alertsQ = await pool.query(
          `SELECT id, phone, first_name, product_name, variant_name
           FROM stock_alerts
           WHERE product_id = $1
             AND COALESCE(variant_id, '') = $2
             AND status = 'pending'
           ORDER BY created_at ASC`,
          [productId, variantId || '']
        );

        const productUrl = buildProductUrl(product, storeBaseUrl);
        const productName = product.name && typeof product.name === 'object'
          ? (product.name.es || Object.values(product.name)[0])
          : (product.name || productId);
        const headerImageUrl = (product.images && product.images[0] && product.images[0].src) || null;
        // Handle para URL dinámica del botón (https://blanqueriaxmayorista.com/productos/${1}/)
        const productHandle = product.handle && typeof product.handle === 'object'
          ? (product.handle.es || Object.values(product.handle)[0])
          : (product.handle || '');

        stats.dispatched_products++;

        for (const a of alertsQ.rows) {
          // Variables Botmaker (convención global — misma variable sirve en body/header/botón):
          //   headerImageUrl → header IMAGE dinámico (patrón probado en 'enviado_transporte')
          //   {{1}} = nombre (fallback "Cliente")
          //   {{2}} = producto
          //   {{3}} = handle del producto → usado en URL dinámica del botón CTA
          //           (https://blanqueriaxmayorista.com/productos/${3}/)
          const variables = {
            '1': a.first_name || 'Cliente',
            '2': a.product_name || productName || '',
            '3': productHandle || '',
          };
          if (headerImageUrl) variables.headerImageUrl = headerImageUrl;

          try {
            if (!dryRun) {
              await queueWhatsApp({
                telefono: a.phone,
                plantilla: plantillaKey,
                variables,
                orderNumber: null, // esta alerta no está asociada a un pedido
              });
              await pool.query(
                `UPDATE stock_alerts
                 SET status = 'notified',
                     notified_at = NOW(),
                     notified_template = $2
                 WHERE id = $1 AND status = 'pending'`,
                [a.id, plantillaKey]
              );
            }
            stats.alerts_sent++;
          } catch (err) {
            stats.alerts_send_errors++;
            log.error({ err: err.message, alertId: a.id, pair: pairLabel }, '[stockAlertDispatcher] send error');
          }
        }
      }

      // 6. Upsert state (siempre, para prevenir reenvíos)
      if (!dryRun) {
        await pool.query(
          `INSERT INTO stock_alert_stock_state (product_id, variant_id, last_seen_stock, last_checked_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (product_id, variant_id) DO UPDATE SET
             last_seen_stock = EXCLUDED.last_seen_stock,
             last_checked_at = NOW()`,
          [productId, variantId || '', currentStock]
        );
        stats.updated_state++;
      }

      log.info({
        pair: pairLabel,
        lastSeen,
        currentStock,
        firstTime,
        dispatched: shouldDispatch,
      }, '[stockAlertDispatcher] pair processed');
    } catch (err) {
      log.error({ err: err.message, pair: pairLabel }, '[stockAlertDispatcher] unexpected error');
    }
  }

  // Cerrar el run con métricas finales
  if (runId) {
    try {
      await pool.query(
        `UPDATE stock_alert_runs SET
           finished_at = NOW(),
           pairs_checked = $2,
           fetched = $3,
           fetch_errors = $4,
           dispatched_products = $5,
           alerts_sent = $6,
           alerts_send_errors = $7,
           skipped_no_template = $8,
           updated_state = $9,
           stats_raw = $10
         WHERE id = $1`,
        [
          runId,
          stats.pairs,
          stats.fetched,
          stats.fetch_errors,
          stats.dispatched_products,
          stats.alerts_sent,
          stats.alerts_send_errors,
          stats.skipped_no_template,
          stats.updated_state,
          JSON.stringify(stats),
        ]
      );
    } catch (e) {
      log.warn({ err: e.message, runId }, '[stockAlertDispatcher] no se pudo cerrar run (métricas se pierden)');
    }
  }

  log.info({ ...stats, runId }, '[stockAlertDispatcher] finished');
  return { ...stats, runId };
}

module.exports = {
  runDispatcher,
  // exports para testing
  _internal: { computeStock, buildProductUrl, getConfiguredTemplate },
};
