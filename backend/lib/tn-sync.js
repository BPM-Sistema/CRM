/**
 * Sincronización de estados BPM → Tiendanube
 *
 * Helper centralizado. Usado por:
 * - PATCH /orders/:orderNumber/status (index.js)
 * - POST /remitos/:id/confirm (routes/remitos.js)
 * - POST /comprobantes/:id/confirmar (index.js, via marcarPagadoEnTiendanube)
 * - POST /comprobantes/conciliacion-aplicar (idem)
 * - POST /pago-efectivo (idem)
 *
 * Garantías que ofrece este modulo:
 *   1. Cada call queda registrado en `tn_sync_log` con request/response.
 *   2. Para 'paid': despues del PUT se hace un GET de verificacion (TN devuelve
 *      el valor anterior en la respuesta inmediata, asi que no podemos confiar
 *      en el body del PUT).
 *   3. Si TN confirma 'paid' tras el GET, actualizamos localmente
 *      tn_payment_status y tn_paid_at — sin esperar webhook (que a veces no
 *      llega y deja la divergencia perpetua).
 */

const axios = require('axios');
const pool = require('../db');
const { callTiendanubeWrite } = require('./tnWriteClient');
const { isEnabled } = require('../services/integrationConfig');

const ESTADO_TN_MAP = {
  'armado':    { tnStatus: 'packed',    configKey: 'tiendanube_sync_estado_armado',    label: 'empaquetada' },
  'enviado':   { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',   label: 'despachada' },
  'retirado':  { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',   label: 'despachada' },
  'cancelado': { tnStatus: 'cancelled', configKey: 'tiendanube_sync_estado_cancelado', label: 'cancelada' },
};

const VERIFY_DELAY_MS = 1500;
const VERIFY_TIMEOUT_MS = 8000;

function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authentication': `bearer ${token}`,
    'User-Agent': 'BPM Administrador (netubpm@gmail.com)',
  };
}

async function insertSyncLog(row) {
  try {
    await pool.query(
      `INSERT INTO tn_sync_log (
         tn_order_id, order_number, action, http_method, endpoint, request_body,
         http_status, response_body, success, error_message, duration_ms,
         triggered_by, verified_after, verified_payment_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        row.tn_order_id || null,
        row.order_number || null,
        row.action,
        row.http_method || null,
        row.endpoint || null,
        row.request_body ? JSON.stringify(row.request_body) : null,
        row.http_status || null,
        row.response_body ? JSON.stringify(row.response_body) : null,
        row.success === true,
        row.error_message || null,
        row.duration_ms || null,
        row.triggered_by || null,
        row.verified_after === true,
        row.verified_payment_status || null,
      ]
    );
  } catch (err) {
    // Auditoria no debe romper el flujo principal — solo loggear si falla
    console.error('[tn-sync] No se pudo insertar tn_sync_log:', err.message);
  }
}

/**
 * GET /orders/:id para verificar estado real en TN.
 * Usa axios directo (no callTiendanubeWrite) porque es lectura.
 */
async function fetchTnOrder(tnOrderId, headers) {
  const storeId = process.env.TIENDANUBE_STORE_ID;
  const r = await axios.get(
    `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
    { headers, timeout: VERIFY_TIMEOUT_MS }
  );
  return r.data;
}

/**
 * Sincronizar un estado de pedido hacia Tiendanube.
 * Mapeo: pagado→paid, armado→packed, enviado→fulfilled, cancelado→cancelled
 *
 * @param {string} tnOrderId
 * @param {string} orderNumber
 * @param {string} tnStatus - 'paid' | 'packed' | 'fulfilled' | 'cancelled'
 * @param {string} labelEs - etiqueta para logs ('pagada' | 'empaquetada' | etc)
 * @param {object} [opts]
 * @param {string} [opts.triggeredBy='unknown'] - origen del call
 */
async function sincronizarEstadoTiendanube(tnOrderId, orderNumber, tnStatus, labelEs, opts = {}) {
  const triggeredBy = opts.triggeredBy || 'unknown';
  const storeId = process.env.TIENDANUBE_STORE_ID;
  const token = process.env.TIENDANUBE_ACCESS_TOKEN;

  if (!storeId || !token || !tnOrderId) {
    const msg = 'faltan credenciales TN o tn_order_id';
    console.log(`⚠️ [Orden ${orderNumber}] ${msg}`);
    await insertSyncLog({
      tn_order_id: tnOrderId, order_number: orderNumber,
      action: tnStatus === 'paid' ? 'mark_paid' : tnStatus,
      success: false, error_message: msg, triggered_by: triggeredBy,
    });
    return false;
  }

  const headers = buildHeaders(token);

  // === PATH 'paid' ===
  // Body legacy `{ status: 'paid' }` aceptado por TN (verificado contra API real:
  // TN devuelve el valor anterior en la respuesta inmediata, hay que GET despues).
  if (tnStatus === 'paid') {
    const url = `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`;
    const requestBody = { status: 'paid' };
    const start = Date.now();
    let httpStatus = null;
    let responseBody = null;
    let errorMsg = null;
    let writeOk = false;

    try {
      const resp = await callTiendanubeWrite(
        { method: 'put', url, data: requestBody, headers },
        { context: `mark-paid#${orderNumber}` }
      );
      httpStatus = resp?.status || 200;
      responseBody = resp?.data || null;
      writeOk = true;
    } catch (err) {
      httpStatus = err.response?.status || null;
      responseBody = err.response?.data || null;
      errorMsg = err.message;
    }

    let verifiedAfter = false;
    let verifiedPaymentStatus = null;

    if (writeOk) {
      // Verificar con GET porque TN responde con valores viejos en el PUT.
      try {
        await new Promise(r => setTimeout(r, VERIFY_DELAY_MS));
        const tnOrder = await fetchTnOrder(tnOrderId, headers);
        verifiedAfter = true;
        verifiedPaymentStatus = tnOrder.payment_status || null;

        if (verifiedPaymentStatus === 'paid') {
          // Sincronizar BPM local — sin esperar webhook (que a veces no llega).
          await pool.query(
            `UPDATE orders_validated
             SET tn_payment_status = 'paid',
                 tn_paid_at = COALESCE($1::timestamptz, tn_paid_at, NOW())
             WHERE order_number = $2`,
            [tnOrder.paid_at || null, orderNumber]
          );
          console.log(`✅ [Orden ${orderNumber}] Marcada como ${labelEs} en Tiendanube + BPM sincronizado`);
        } else {
          // PUT 200 pero TN no aplico el cambio — divergencia silenciosa.
          errorMsg = `TN no aplico el cambio: payment_status=${verifiedPaymentStatus}`;
          writeOk = false;
          console.error(`⚠️ [Orden ${orderNumber}] ${errorMsg}`);
        }
      } catch (verifyErr) {
        errorMsg = `verificacion fallo: ${verifyErr.message}`;
        console.error(`⚠️ [Orden ${orderNumber}] ${errorMsg}`);
      }
    } else {
      console.error(`❌ [Orden ${orderNumber}] Error marcando ${labelEs}: ${httpStatus} ${JSON.stringify(responseBody || errorMsg)}`);
    }

    await insertSyncLog({
      tn_order_id: tnOrderId,
      order_number: orderNumber,
      action: 'mark_paid',
      http_method: 'PUT',
      endpoint: `/orders/${tnOrderId}`,
      request_body: requestBody,
      http_status: httpStatus,
      response_body: responseBody,
      success: writeOk,
      error_message: errorMsg,
      duration_ms: Date.now() - start,
      triggered_by: triggeredBy,
      verified_after: verifiedAfter,
      verified_payment_status: verifiedPaymentStatus,
    });

    return writeOk;
  }

  // === PATH 'packed'/'fulfilled'/'cancelled' (endpoints especificos) ===
  const ENDPOINT_MAP = { packed: 'pack', fulfilled: 'fulfill', cancelled: 'close' };
  const action = ENDPOINT_MAP[tnStatus];
  if (!action) {
    console.log(`⚠️ [Orden ${orderNumber}] Estado ${tnStatus} no tiene endpoint TN`);
    return false;
  }

  const url = `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/${action}`;
  const start = Date.now();
  let httpStatus = null;
  let responseBody = null;
  let errorMsg = null;
  let writeOk = false;

  try {
    const resp = await callTiendanubeWrite(
      { method: 'post', url, data: {}, headers },
      { context: `${action}#${orderNumber}` }
    );
    httpStatus = resp?.status || 200;
    responseBody = resp?.data || null;
    writeOk = true;
    console.log(`✅ [Orden ${orderNumber}] Marcada como ${labelEs} en Tiendanube`);
  } catch (err) {
    httpStatus = err.response?.status || null;
    responseBody = err.response?.data || null;
    errorMsg = err.message;
    console.error(`❌ [Orden ${orderNumber}] Error marcando ${labelEs}: ${httpStatus} ${JSON.stringify(responseBody || errorMsg)}`);
  }

  await insertSyncLog({
    tn_order_id: tnOrderId,
    order_number: orderNumber,
    action,
    http_method: 'POST',
    endpoint: `/orders/${tnOrderId}/${action}`,
    request_body: {},
    http_status: httpStatus,
    response_body: responseBody,
    success: writeOk,
    error_message: errorMsg,
    duration_ms: Date.now() - start,
    triggered_by: triggeredBy,
  });

  return writeOk;
}

/**
 * Sincronizar un estado BPM hacia TN respetando el toggle de integración.
 */
async function syncEstadoToTN(tnOrderId, orderNumber, estadoPedido, opts = {}) {
  if (!tnOrderId) return;

  const syncConfig = ESTADO_TN_MAP[estadoPedido];
  if (!syncConfig) return;

  try {
    const enabled = await isEnabled(syncConfig.configKey, { context: `sync-estado-${estadoPedido}` });
    if (enabled) {
      await sincronizarEstadoTiendanube(
        tnOrderId, orderNumber, syncConfig.tnStatus, syncConfig.label, opts
      );
    }
  } catch (err) {
    console.error(`⚠️ Error checking sync toggle for ${estadoPedido}:`, err.message);
  }
}

module.exports = {
  sincronizarEstadoTiendanube,
  syncEstadoToTN,
  ESTADO_TN_MAP,
};
