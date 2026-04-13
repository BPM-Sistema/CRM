/**
 * Sincronización de estados BPM → Tiendanube
 *
 * Helper centralizado. Usado por:
 * - PATCH /orders/:orderNumber/status (index.js)
 * - POST /remitos/:id/confirm (routes/remitos.js)
 */

const { callTiendanube } = require('./circuitBreaker');
const { isEnabled } = require('../services/integrationConfig');

const ESTADO_TN_MAP = {
  'armado':    { tnStatus: 'packed',    configKey: 'tiendanube_sync_estado_armado',    label: 'empaquetada' },
  'enviado':   { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',   label: 'despachada' },
  'retirado':  { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',   label: 'despachada' },
  'cancelado': { tnStatus: 'cancelled', configKey: 'tiendanube_sync_estado_cancelado', label: 'cancelada' },
};

/**
 * Sincronizar un estado de pedido hacia Tiendanube
 * Mapeo: pagado→paid, armado→packed, enviado→fulfilled, cancelado→cancelled
 */
async function sincronizarEstadoTiendanube(tnOrderId, orderNumber, tnStatus, labelEs) {
  const storeId = process.env.TIENDANUBE_STORE_ID;
  const token = process.env.TIENDANUBE_ACCESS_TOKEN;

  if (!storeId || !token || !tnOrderId) {
    console.log(`⚠️ [Orden ${orderNumber}] No se puede sincronizar con Tiendanube - faltan credenciales o tn_order_id`);
    return false;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authentication': `bearer ${token}`,
    'User-Agent': 'BPM Administrador (netubpm@gmail.com)'
  };

  // Para 'paid', usar PUT con { status: 'paid' } (funciona en TN API)
  if (tnStatus === 'paid') {
    try {
      await callTiendanube({
        method: 'put',
        url: `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
        data: { status: 'paid' },
        headers
      });
      console.log(`✅ [Orden ${orderNumber}] Marcada como ${labelEs} en Tiendanube (tn_order_id: ${tnOrderId})`);
      return true;
    } catch (err) {
      console.error(`❌ [Orden ${orderNumber}] Error marcando ${labelEs} en Tiendanube: ${err.response?.status} ${JSON.stringify(err.response?.data || err.message)}`);
      return false;
    }
  }

  // Tiendanube usa endpoints POST específicos para cambios de estado de fulfillment
  // packed -> POST /orders/{id}/pack
  // fulfilled -> POST /orders/{id}/fulfill
  // cancelled -> POST /orders/{id}/close (cierra el pedido)
  const ENDPOINT_MAP = {
    'packed': 'pack',
    'fulfilled': 'fulfill',
    'cancelled': 'close'
  };

  const action = ENDPOINT_MAP[tnStatus];
  if (!action) {
    console.log(`⚠️ [Orden ${orderNumber}] Estado ${tnStatus} no tiene endpoint de sync en Tiendanube`);
    return false;
  }

  try {
    await callTiendanube({
      method: 'post',
      url: `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/${action}`,
      data: {},
      headers
    });
    console.log(`✅ [Orden ${orderNumber}] Marcada como ${labelEs} en Tiendanube (tn_order_id: ${tnOrderId})`);
    return true;
  } catch (err) {
    console.error(`❌ [Orden ${orderNumber}] Error marcando ${labelEs} en Tiendanube: ${err.response?.status} ${JSON.stringify(err.response?.data || err.message)}`);
    return false;
  }
}

/**
 * Sincronizar un estado BPM hacia TN respetando el toggle de integración.
 * Uso: syncEstadoToTN(tnOrderId, orderNumber, 'enviado')
 */
async function syncEstadoToTN(tnOrderId, orderNumber, estadoPedido) {
  if (!tnOrderId) return;

  const syncConfig = ESTADO_TN_MAP[estadoPedido];
  if (!syncConfig) return;

  try {
    const enabled = await isEnabled(syncConfig.configKey, { context: `sync-estado-${estadoPedido}` });
    if (enabled) {
      await sincronizarEstadoTiendanube(tnOrderId, orderNumber, syncConfig.tnStatus, syncConfig.label);
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
