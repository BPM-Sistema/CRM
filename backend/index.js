
require('dotenv').config();

// Sentry - Error monitoring (inicializar ANTES de todo lo demás)
const Sentry = require('@sentry/node');
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.1, // 10% de transacciones para performance
  beforeSend(event) {
    // No enviar errores en desarrollo local
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 Sentry (dev mode - not sent):', event.exception?.values?.[0]?.value);
      return null;
    }
    return event;
  }
});

// Forzar IPv4 (Windows / pooler)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { callTiendanube, callBotmaker } = require('./lib/circuitBreaker');

const { uploadFile: storageUploadFile, getPublicUrl: storageGetPublicUrl } = require('./lib/storage');
const { calcularEstadoCuenta } = require('./utils/calcularEstadoCuenta');
const pool = require('./db');
const { hashText } = require('./hash');
const { analizarComprobante, convertirAFormatoLegacy } = require('./services/claudeVision');
const { authenticate, requirePermission, JWT_SECRET } = require('./middleware/auth');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { uploadLimiter, validationLimiter, shippingFormLimiter, leadsLimiter } = require('./middleware/rateLimit');
const { verifyCronAuth } = require('./middleware/cronAuth');
const crypto = require('crypto');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib } = require('pdf-lib');
const { runSyncJob } = require('./services/orderSync');
const { getQueueStats, getSyncState, markCompleted: markQueueCompleted, markFailed: markQueueFailed } = require('./services/syncQueue');
const { tiendanube: tnConfig, whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('./services/integrationConfig');
const { verificarConsistencia, getInconsistencias } = require('./utils/orderVerification');
const { getNotificaciones, contarNoLeidas, marcarLeida, marcarTodasLeidas, crearNotificacion } = require('./utils/notifications');
const { enviarWhatsAppPlantilla } = require('./lib/whatsapp-helpers');
const { calcularTotalPagado, calcularEstadoPedido, requiresShippingForm, normalizePhoneForComparison, mapShippingToEstadoPedido } = require('./lib/payment-helpers');
const { recalcularPagos } = require('./lib/recalcularPagos');
const { syncEstadoToTN, sincronizarEstadoTiendanube } = require('./lib/tn-sync');
const { watermarkReceipt, isValidDestination, detectarFinancieraDesdeOCR } = require('./lib/comprobante-helpers');
const { buildDivergenceReport, saveDivergences, applyAutoFixes, getBpmOrderForComparison } = require('./lib/divergence-detector');
const { hashPaymentChange, hashProductChange, hashShippingChange, markEventProcessed } = require('./lib/webhookDedup');
const customerSync = require('./services/customerSync');
const customerMetrics = require('./services/customerMetrics');
const customerSegmentation = require('./services/customerSegmentation');
const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// Desactivar ETag globalmente para evitar respuestas 304
app.set('etag', false);

app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// CORS para permitir requests del frontend
// En producción FRONTEND_URL es requerido - en dev/test permite localhost
if (!process.env.FRONTEND_URL && process.env.NODE_ENV === 'production') {
  console.error('❌ CRITICAL: FRONTEND_URL must be set in production!');
  process.exit(1);
}
const allowedOrigins = process.env.FRONTEND_URL
  ? [
      process.env.FRONTEND_URL,
      process.env.FRONTEND_URL.replace('https://', 'https://www.'),
      process.env.FRONTEND_URL.replace('https://www.', 'https://'),
      'https://blanqueriaxmayorista.com',
      'https://www.blanqueriaxmayorista.com',
      'http://localhost:5173',
      'http://localhost:3001'
    ]
  : ['http://localhost:5173', 'http://localhost:3001'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'X-Permissions-Hash');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Security headers (con exclusión para rutas embebibles)
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
});

app.use((req, res, next) => {
  // Excluir /leads de Helmet (necesita ser embebible en Tiendanube)
  if (req.path === '/leads') {
    return next();
  }
  return helmetMiddleware(req, res, next);
});

// Structured logging middleware (request IDs + duration)
const { requestLogger } = require('./lib/logger');
const { apiLogger: log } = require('./lib/logger');
app.use(requestLogger);

app.use(express.static(path.join(__dirname, 'public')));

// Ruta explícita para el form de leads (embebible desde cualquier dominio)
// Helmet está excluido para esta ruta (ver middleware arriba)
app.get('/leads', (req, res) => {
  // Forzar no-cache para evitar problemas con versiones anteriores
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'leads.html'));
});

const { logEvento } = require('./utils/logging');

/* =====================================================
   UTIL — SIGNED ACTION TOKENS (para links /confirmar /rechazar)
===================================================== */
function generateSignedAction(comprobanteId, action) {
  return jwt.sign({ comprobanteId, action }, JWT_SECRET, { expiresIn: '15m' });
}

function verifySignedAction(token, expectedId, expectedAction) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.comprobanteId === expectedId && decoded.action === expectedAction;
  } catch {
    return false;
  }
}

/* =====================================================
   UTIL — CLAVE ÚNICA DE PRODUCTO (centralizado)
===================================================== */
function getProductKey(p) {
  // Usar product_id + variant_id como identificador único
  // Si viene de TiendaNube: p.product_id, p.variant_id
  // Si viene de DB: p.product_id, p.variant_id
  return `${p.product_id}_${p.variant_id || 'null'}`;
}

/* =====================================================
   UTIL — MENSAJE DE ACTUALIZACIÓN DE PEDIDO
===================================================== */
function buildOrderUpdateMessage(oldProducts, newProducts, montoNuevo) {
  const lineas = [];

  const oldMap = new Map();
  const newMap = new Map();

  for (const p of oldProducts) {
    oldMap.set(getProductKey(p), { name: p.name, qty: Number(p.quantity) });
  }

  for (const p of newProducts) {
    newMap.set(getProductKey(p), { name: p.name, qty: Number(p.quantity) });
  }

  // Productos eliminados
  for (const [id, old] of oldMap) {
    if (!newMap.has(id)) {
      lineas.push(`${old.name} — eliminado −${old.qty}`);
    }
  }

  // Productos agregados o cantidad modificada
  for (const [id, nuevo] of newMap) {
    const old = oldMap.get(id);
    if (!old) {
      lineas.push(`${nuevo.name} — añadido +${nuevo.qty}`);
    } else if (nuevo.qty > old.qty) {
      lineas.push(`${nuevo.name} — añadido +${nuevo.qty - old.qty}`);
    } else if (nuevo.qty < old.qty) {
      lineas.push(`${nuevo.name} — disminuido −${old.qty - nuevo.qty}`);
    }
  }

  // Retornar productos y monto POR SEPARADO para logs individuales
  const montoFormateado = montoNuevo.toLocaleString('es-AR');
  return {
    productChanges: lineas,
    montoLine: `Monto actualizado: $${montoFormateado}`,
    // Backwards compat: toString retorna todo junto
    toString() { return [...lineas, this.montoLine].join('\n'); }
  };
}

/* =====================================================
   UTIL — OBTENER ETIQUETAS ENVÍO NUBE DE TIENDANUBE
===================================================== */
async function obtenerEtiquetasEnvioNube(tnOrderId) {
  // Check de integración habilitada
  const fulfillmentEnabled = await tnConfig.isFulfillmentEnabled();
  if (!fulfillmentEnabled) {
    return { ok: false, error: 'Integración de etiquetas temporalmente deshabilitada', disabled: true };
  }

  const storeId = process.env.TIENDANUBE_STORE_ID;
  const token = process.env.TIENDANUBE_ACCESS_TOKEN;

  try {
    // 1. Obtener fulfillment orders del pedido
    const response = await callTiendanube({
      method: 'get',
      url: `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfillment-orders`,
      headers: {
        authentication: `bearer ${token}`,
        'User-Agent': 'bpm-validator'
      },
      timeout: 15000
    });

    const fulfillmentOrders = response.data;

    if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
      return { ok: false, error: 'No hay fulfillment orders para este pedido' };
    }

    // 2. Filtrar solo los FO con Envío Nube
    const envioNubeFOs = fulfillmentOrders.filter(fo =>
      fo.shipping?.carrier?.name?.toLowerCase().includes('nube') ||
      fo.shipping?.carrier?.app_id === '9075'
    );

    if (envioNubeFOs.length === 0) {
      return { ok: false, error: 'Este pedido no tiene Envío Nube' };
    }

    const labels = [];

    for (const fo of envioNubeFOs) {
      console.log(`📦 FO ${fo.id} - status: ${fo.status}, labels: ${fo.labels?.length || 0}`);

      // 3. Verificar si ya hay labels listos (READY_TO_USE o DOWNLOADED)
      let readyLabel = fo.labels?.find(l => l.status === 'READY_TO_USE' || l.status === 'DOWNLOADED');

      // 4. Si no hay label, solicitar generación
      if (!readyLabel) {
        console.log(`🚀 Solicitando generación de etiqueta para FO ${fo.id}...`);

        try {
          // POST al endpoint correcto de creación de labels
          const createRes = await callTiendanube({
            method: 'post',
            url: `https://api.tiendanube.com/v1/${storeId}/fulfillment-orders/labels`,
            data: [{ id: fo.id }],
            headers: {
              authentication: `bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': 'bpm-validator'
            },
            timeout: 30000
          });

          console.log(`✅ Label solicitado:`, JSON.stringify(createRes.data));

          // Esperar a que se genere (polling con timeout)
          const maxAttempts = 10;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const checkRes = await callTiendanube({
              method: 'get',
              url: `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfillment-orders`,
              headers: { authentication: `bearer ${token}`, 'User-Agent': 'bpm-validator' },
              timeout: 15000
            });

            const updatedFO = checkRes.data.find(f => f.id === fo.id);
            readyLabel = updatedFO?.labels?.find(l => l.status === 'READY_TO_USE' || l.status === 'DOWNLOADED');

            if (readyLabel) {
              console.log(`✅ Label listo después de ${attempt + 1} intentos`);
              break;
            }

            console.log(`⏳ Esperando label... (intento ${attempt + 1}/${maxAttempts})`);
          }
        } catch (createErr) {
          console.error(`❌ Error creando label:`, createErr.response?.status, createErr.response?.data);
          continue;
        }
      }

      // 5. Si hay label READY_TO_USE, obtener URL de descarga
      if (readyLabel) {
        try {
          // POST al endpoint de download para obtener URL presignada
          const downloadRes = await callTiendanube({
            method: 'post',
            url: `https://api.tiendanube.com/v1/${storeId}/fulfillment-orders/${fo.id}/labels/${readyLabel.id}/download`,
            data: {},
            headers: {
              authentication: `bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': 'bpm-validator'
            },
            timeout: 15000
          });

          // La respuesta es un array con URLs presignadas
          const labelDoc = downloadRes.data.find(d => d.type === 'LABEL');

          if (labelDoc?.url) {
            labels.push({
              fulfillment_id: fo.id,
              label_id: readyLabel.id,
              url: labelDoc.url,
              format: labelDoc.format || 'PDF',
              expires_at: labelDoc.expires_at,
              tracking_code: readyLabel.tracking_info?.code || fo.tracking_info?.code
            });
          }
        } catch (downloadErr) {
          console.error(`❌ Error obteniendo URL de descarga:`, downloadErr.response?.status, downloadErr.response?.data);
        }
      }
    }

    if (labels.length === 0) {
      return { ok: false, error: 'No se pudo obtener la etiqueta. Verifica que el pedido esté listo para despacho.' };
    }

    return { ok: true, labels };

  } catch (error) {
    console.error(`❌ Error obteniendo etiquetas de TN para orden ${tnOrderId}:`, error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data));
    }
    return { ok: false, error: error.message };
  }
}

/* =====================================================
   UTIL — OBTENER PEDIDO TIENDANUBE (UNA SOLA FUNCIÓN)
===================================================== */
async function obtenerPedidoPorId(storeId, orderId) {
  try {
    const response = await callTiendanube({
      method: 'get',
      url: `https://api.tiendanube.com/v1/${storeId}/orders/${orderId}`,
      headers: {
        authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
        'User-Agent': 'bpm-validator'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error(`❌ Error obteniendo pedido ${orderId} de Tiendanube:`, error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data));
    }
    return null;
  }
}

/* =====================================================
   UTIL — GUARDAR PRODUCTOS DE UN PEDIDO EN DB
   - UPSERT productos que existen en TiendaNube
   - DELETE productos que ya no existen en TiendaNube
   - Retorna resultado con conteos para verificacion
===================================================== */
async function guardarProductos(orderNumber, products) {
  const result = { expected: 0, saved: 0, deleted: 0, errors: [] };

  if (!products || products.length === 0) {
    console.log(`⚠️ Pedido #${orderNumber} sin productos para guardar`);
    return result;
  }

  result.expected = products.length;
  console.log(`📦 Guardando ${products.length} productos para pedido #${orderNumber}`);

  // 1. Crear Set de claves de productos que vienen de TiendaNube
  const productKeys = new Set(
    products.map(p => `${p.product_id || 'null'}_${p.variant_id || 'null'}`)
  );

  // 2. Obtener productos actuales en DB para este pedido
  const currentProducts = await pool.query(
    `SELECT id, product_id, variant_id FROM order_products WHERE order_number = $1`,
    [orderNumber]
  );

  // 3. Eliminar productos que ya no existen en TiendaNube
  const idsToDelete = currentProducts.rows
    .filter(row => {
      const key = `${row.product_id || 'null'}_${row.variant_id || 'null'}`;
      return !productKeys.has(key);
    })
    .map(row => row.id);

  if (idsToDelete.length > 0) {
    await pool.query(
      `DELETE FROM order_products WHERE id = ANY($1)`,
      [idsToDelete]
    );
    result.deleted = idsToDelete.length;
    console.log(`🗑️ Eliminados ${idsToDelete.length} productos removidos del pedido #${orderNumber}`);
  }

  // 4. UPSERT productos en batch
  if (products.length > 0) {
    try {
      const values = [];
      const params = [];
      products.forEach((p, i) => {
        const offset = i * 8;
        values.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8})`);
        params.push(
          orderNumber,
          p.product_id || null,
          p.variant_id || null,
          p.name,
          p.variant_values ? p.variant_values.join(' / ') : null,
          p.quantity,
          Number(p.price),
          p.sku || null
        );
      });

      await pool.query(`
        INSERT INTO order_products (order_number, product_id, variant_id, name, variant, quantity, price, sku)
        VALUES ${values.join(', ')}
        ON CONFLICT (order_number, product_id, variant_id_safe)
        DO UPDATE SET
          name = EXCLUDED.name,
          variant = EXCLUDED.variant,
          quantity = EXCLUDED.quantity,
          price = EXCLUDED.price,
          sku = EXCLUDED.sku
      `, params);
      result.saved = products.length;
    } catch (batchErr) {
      console.warn(`⚠️ Batch insert falló para #${orderNumber}, fallback a individual:`, batchErr.message);
      // Fallback: insert individual
      for (const p of products) {
        try {
          await pool.query(`
            INSERT INTO order_products (order_number, product_id, variant_id, name, variant, quantity, price, sku)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (order_number, product_id, variant_id_safe)
            DO UPDATE SET
              name = EXCLUDED.name,
              variant = EXCLUDED.variant,
              quantity = EXCLUDED.quantity,
              price = EXCLUDED.price,
              sku = EXCLUDED.sku
          `, [
            orderNumber,
            p.product_id || null,
            p.variant_id || null,
            p.name,
            p.variant_values ? p.variant_values.join(' / ') : null,
            p.quantity,
            Number(p.price),
            p.sku || null
          ]);
          result.saved++;
        } catch (err) {
          const errorMsg = `${err.message} | Producto: ${p.name} (${p.product_id})`;
          result.errors.push(errorMsg);
          console.error(`❌ Error INSERT producto en #${orderNumber}:`, err.message);
          console.error('   Producto:', JSON.stringify(p));
        }
      }
    }
  }

  // 5. Log resultado
  if (result.errors.length > 0) {
    console.error(`⚠️ Pedido #${orderNumber}: ${result.saved}/${result.expected} productos guardados, ${result.errors.length} errores`);
  } else {
    console.log(`✅ Pedido #${orderNumber}: ${result.saved}/${result.expected} productos guardados correctamente`);
  }

  // 6. Auto-resolver inconsistencias pendientes para este pedido
  try {
    const resolved = await pool.query(`
      UPDATE order_inconsistencies
      SET resolved = true, resolved_at = NOW()
      WHERE order_number = $1 AND resolved = false
      RETURNING id
    `, [orderNumber]);

    if (resolved.rowCount > 0) {
      console.log(`✅ Auto-resueltas ${resolved.rowCount} inconsistencias del pedido #${orderNumber}`);

      // También marcar notificaciones relacionadas como leídas
      await pool.query(`
        UPDATE notifications
        SET leida = true
        WHERE tipo = 'inconsistencia'
          AND referencia_tipo = 'order'
          AND referencia_id = $1
          AND leida = false
      `, [orderNumber]);
    }
  } catch (err) {
    // No bloquear el flujo si falla la auto-resolución
    console.error(`⚠️ Error auto-resolviendo inconsistencias #${orderNumber}:`, err.message);
  }

  return result;
}

/* =====================================================
   UTIL — GUARDAR PEDIDO COMPLETO EN DB (UPSERT)
===================================================== */
async function guardarPedidoCompleto(pedido) {
  const orderNumber = String(pedido.number);

  // Estructurar shipping_address como JSON
  const shippingAddress = pedido.shipping_address ? {
    name: pedido.shipping_address.name,
    address: pedido.shipping_address.address,
    number: pedido.shipping_address.number,
    floor: pedido.shipping_address.floor,
    locality: pedido.shipping_address.locality,
    city: pedido.shipping_address.city,
    province: pedido.shipping_address.province,
    zipcode: pedido.shipping_address.zipcode,
    phone: pedido.shipping_address.phone,
    between_streets: pedido.shipping_address.between_streets,
    reference: pedido.shipping_address.reference,
  } : null;

  // Extraer datos del cliente
  const customerName = pedido.customer?.name || pedido.contact_name || null;
  const customerEmail = pedido.customer?.email || pedido.contact_email || null;
  const customerPhone = pedido.contact_phone || pedido.customer?.phone ||
                        pedido.shipping_address?.phone || pedido.customer?.default_address?.phone || null;

  // Upsert en orders_validated con todos los datos
  await pool.query(`
    INSERT INTO orders_validated (
      order_number, tn_order_id, tn_order_token, monto_tiendanube, monto_original, subtotal, discount, shipping_cost,
      currency, customer_name, customer_email, customer_phone,
      shipping_type, shipping_tracking, shipping_address,
      note, owner_note, tn_payment_status, tn_shipping_status,
      tn_paid_at, tn_total_paid, tn_gateway,
      estado_pedido, tn_created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'pendiente_pago', $22, NOW())
    ON CONFLICT (order_number) DO UPDATE SET
      tn_order_id = COALESCE(EXCLUDED.tn_order_id, orders_validated.tn_order_id),
      tn_order_token = COALESCE(EXCLUDED.tn_order_token, orders_validated.tn_order_token),
      monto_tiendanube = EXCLUDED.monto_tiendanube,
      monto_original = COALESCE(orders_validated.monto_original, EXCLUDED.monto_original),
      subtotal = EXCLUDED.subtotal,
      discount = EXCLUDED.discount,
      shipping_cost = EXCLUDED.shipping_cost,
      customer_name = COALESCE(EXCLUDED.customer_name, orders_validated.customer_name),
      customer_email = COALESCE(EXCLUDED.customer_email, orders_validated.customer_email),
      customer_phone = COALESCE(EXCLUDED.customer_phone, orders_validated.customer_phone),
      shipping_type = EXCLUDED.shipping_type,
      shipping_tracking = EXCLUDED.shipping_tracking,
      shipping_address = EXCLUDED.shipping_address,
      note = EXCLUDED.note,
      owner_note = EXCLUDED.owner_note,
      tn_payment_status = EXCLUDED.tn_payment_status,
      tn_shipping_status = EXCLUDED.tn_shipping_status,
      tn_paid_at = EXCLUDED.tn_paid_at,
      tn_total_paid = EXCLUDED.tn_total_paid,
      tn_gateway = EXCLUDED.tn_gateway,
      tn_created_at = COALESCE(orders_validated.tn_created_at, EXCLUDED.tn_created_at),
      updated_at = NOW()
  `, [
    orderNumber,
    pedido.id,
    pedido.token || null,
    Math.round(Number(pedido.total)),
    Number(pedido.subtotal) || 0,
    Number(pedido.discount) || 0,
    Number(pedido.shipping_cost_customer) || 0,
    pedido.currency || 'ARS',
    customerName,
    customerEmail,
    customerPhone,
    (() => {
      const option = (typeof pedido.shipping_option === 'string' ? pedido.shipping_option : pedido.shipping_option?.name) || pedido.shipping || null;
      // "Punto de retiro" es genérico - enriquecer con el carrier real desde shipping_option_code
      if (option && option.toLowerCase().includes('punto de retiro') && pedido.shipping_option_code) {
        const code = pedido.shipping_option_code.toLowerCase();
        if (code.includes('andreani')) return 'Envío Nube - Andreani a sucursal';
        if (code.includes('correo')) return 'Envío Nube - Correo Argentino a sucursal';
        if (code.includes('oca')) return 'Envío Nube - OCA a sucursal';
      }
      return option;
    })(),
    pedido.shipping_tracking_number || null,
    shippingAddress ? JSON.stringify(shippingAddress) : null,
    pedido.note || null,
    pedido.owner_note || null,
    pedido.payment_status || null,
    pedido.shipping_status || null,
    pedido.paid_at || null,
    Math.round(Number(pedido.total_paid || 0)),
    pedido.gateway || pedido.gateway_name || null,
    pedido.created_at || null
  ]);

  // Guardar productos
  const saveResult = await guardarProductos(orderNumber, pedido.products);

  // Auto-resync si hubo errores (una sola vez para evitar loops)
  if (saveResult.errors.length > 0) {
    console.log(`🔄 Auto-resync para pedido #${orderNumber} por ${saveResult.errors.length} errores`);
    try {
      const pedidoFresh = await obtenerPedidoPorId(pedido.id);
      if (pedidoFresh && pedidoFresh.products) {
        const retryResult = await guardarProductos(orderNumber, pedidoFresh.products);
        if (retryResult.errors.length === 0) {
          console.log(`✅ Auto-resync exitoso para pedido #${orderNumber}`);
        } else {
          console.error(`❌ Auto-resync fallido para pedido #${orderNumber}: ${retryResult.errors.length} errores persisten`);
        }
      }
    } catch (resyncErr) {
      console.error(`❌ Error en auto-resync #${orderNumber}:`, resyncErr.message);
    }
  }

  return orderNumber;
}


/**
 * Queue a WhatsApp message via BullMQ if available, otherwise send directly.
 * Testing mode filter is applied in worker/helper (NOT here).
 */
const _recentWhatsApp = new Map();
async function queueWhatsApp({ telefono, plantilla, variables, orderNumber }) {
  // Bloquear todos los WhatsApp para "local local" (excepto resenia_maps)
  if (orderNumber && plantilla !== 'resenia_maps') {
    try {
      const localCheck = await pool.query(
        `SELECT customer_name FROM orders_validated WHERE order_number = $1`,
        [String(orderNumber).replace('#', '').trim()]
      );
      if (localCheck.rows[0] && localCheck.rows[0].customer_name?.trim().toLowerCase() === 'local local') {
        log.info({ orderNumber, plantilla }, 'WhatsApp skipped — local local customer');
        return;
      }
    } catch { /* si falla el check, continuar normalmente */ }
  }

  // Deduplicar: misma plantilla + pedido en los últimos 5 minutos → skip
  if (orderNumber) {
    const varSuffix = variables?.['3'] ? `:${variables['3']}` : '';
    const dedupeKey = `${orderNumber}:${plantilla}${varSuffix}`;
    const lastSent = _recentWhatsApp.get(dedupeKey);
    if (lastSent && Date.now() - lastSent < 5 * 60 * 1000) {
      log.info({ orderNumber, plantilla }, 'WhatsApp skipped — duplicate within 5min');
      return;
    }
    _recentWhatsApp.set(dedupeKey, Date.now());
    // Limpiar entradas viejas cada 100 entries
    if (_recentWhatsApp.size > 500) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, v] of _recentWhatsApp) { if (v < cutoff) _recentWhatsApp.delete(k); }
    }
  }

  log.info({ orderNumber, plantilla }, '[WHATSAPP] Encolando mensaje');

  const msgRequestId = crypto.randomUUID();

  const { whatsappQueue } = require('./lib/queues');
  if (whatsappQueue) {
    // Crear registro pending ANTES de encolar
    if (orderNumber) {
      try {
        await pool.query(
          `INSERT INTO whatsapp_messages (request_id, order_number, template, template_key, contact_id, variables, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           ON CONFLICT (request_id) DO NOTHING`,
          [msgRequestId, orderNumber, plantilla, plantilla, telefono, JSON.stringify(variables)]
        );
      } catch (dbErr) {
        log.error({ err: dbErr.message }, 'Error creando registro pending WhatsApp');
      }
    }

    await whatsappQueue.add('send-whatsapp', {
      telefono, plantilla, variables, orderNumber,
      requestId: msgRequestId
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 }
    });
    log.info({ orderNumber, plantilla }, 'WhatsApp message enqueued');
    if (orderNumber) {
      await logEvento({ orderNumber: String(orderNumber), accion: `whatsapp_encolado: ${plantilla}`, origen: 'sistema' });
    }
    return;
  }
  // Fallback to direct send
  log.warn({ orderNumber, plantilla }, 'WhatsApp queue unavailable, sending directly (fallback)');
  return enviarWhatsAppPlantilla({ telefono, plantilla, variables, orderNumber });
}





/* =====================================================
   MULTER
===================================================== */
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

/* =====================================================
   HEALTH
===================================================== */
app.get('/health', (_, res) => res.json({ ok: true }));


/* =====================================================
   GET — COLA DE SINCRONIZACIÓN DE PAGOS
   Pedidos pagados en nuestro sistema pero no en Tiendanube
===================================================== */
app.get('/sync-queue/payments', authenticate, requirePermission('activity.view'), async (req, res) => {
  try {
    // Pedidos que están COMPLETAMENTE pagados en nuestro sistema pero NO en Tiendanube
    // Solo confirmado_total (no parcial) y verificamos saldo <= 0 por seguridad
    const result = await pool.query(`
      SELECT
        order_number,
        tn_order_id,
        customer_name,
        customer_email,
        customer_phone,
        monto_tiendanube,
        total_pagado,
        saldo,
        estado_pago,
        estado_pedido,
        tn_payment_status,
        created_at,
        tn_created_at
      FROM orders_validated
      WHERE estado_pago = 'confirmado_total'
        AND (saldo IS NULL OR saldo <= 0)
        AND (tn_payment_status IS NULL OR tn_payment_status != 'paid')
        AND estado_pedido != 'cancelado'
      ORDER BY created_at DESC
    `);

    res.json({
      ok: true,
      count: result.rowCount,
      orders: result.rows
    });

  } catch (error) {
    console.error('❌ /sync-queue/payments error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — SINCRONIZAR ESTADO DE PAGO DESDE TIENDANUBE
   Para resolver divergencias donde TN tiene paid pero BPM no recibió webhook
===================================================== */
app.post('/orders/:orderNumber/sync-tn-payment', authenticate, requirePermission('orders.update_status'), async (req, res) => {
  const { orderNumber } = req.params;

  try {
    // 1. Buscar el pedido
    const orderRes = await pool.query(
      `SELECT order_number, tn_order_id, tn_payment_status, estado_pago
       FROM orders_validated WHERE order_number = $1`,
      [orderNumber]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderRes.rows[0];

    if (!order.tn_order_id) {
      return res.status(400).json({ error: 'Pedido sin tn_order_id, no se puede consultar TN' });
    }

    // 2. Consultar estado real en TN
    const { getTnPaymentStatus, syncTnPaymentStatus } = require('./lib/tnPaymentDivergence');
    const tnStatus = await getTnPaymentStatus(order.tn_order_id);

    if (!tnStatus) {
      return res.status(503).json({ error: 'No se pudo consultar Tiendanube' });
    }

    // 3. Si hay divergencia, sincronizar
    if (tnStatus.payment_status !== order.tn_payment_status) {
      await syncTnPaymentStatus(orderNumber, tnStatus.payment_status, tnStatus.paid_at);

      await logEvento({
        orderNumber,
        accion: `tn_payment_status sincronizado: ${order.tn_payment_status || 'null'} → ${tnStatus.payment_status}`,
        origen: 'operador',
        userId: req.user?.id,
        username: req.user?.name
      });

      return res.json({
        ok: true,
        synced: true,
        previous: order.tn_payment_status,
        current: tnStatus.payment_status,
        tn_paid_at: tnStatus.paid_at
      });
    }

    // Ya estaba sincronizado
    res.json({
      ok: true,
      synced: false,
      message: 'Ya estaba sincronizado',
      tn_payment_status: tnStatus.payment_status
    });

  } catch (error) {
    console.error('❌ /orders/:orderNumber/sync-tn-payment error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — BOTMAKER CHAT LOOKUP BY PHONE
===================================================== */
app.get('/botmaker/chat-by-phone/:phone', authenticate, async (req, res) => {
  try {
    const token = process.env.BOTMAKER_ACCESS_TOKEN;
    if (!token) return res.status(503).json({ error: 'Botmaker no configurado' });

    const channelId = process.env.BOTMAKER_CHANNEL_ID;
    if (!channelId) return res.status(503).json({ error: 'Botmaker channel no configurado' });

    const raw = req.params.phone.replace(/[^0-9]/g, '');
    if (!raw) return res.status(400).json({ error: 'Teléfono inválido' });

    // Generar variantes del número para buscar con la API
    const variants = [raw];
    if (raw.startsWith('54') && !raw.startsWith('549')) variants.push('549' + raw.slice(2));
    if (raw.startsWith('549')) variants.push('54' + raw.slice(3));
    if (!raw.startsWith('54')) { variants.push('54' + raw); variants.push('549' + raw); }

    // Buscar por contact-id + channel-id (endpoint filtrado de Botmaker)
    let found = null;
    for (const variant of variants) {
      const url = `https://api.botmaker.com/v2.0/chats/?channel-id=${encodeURIComponent(channelId)}&contact-id=${variant}`;
      const resp = await fetch(url, { headers: { 'access-token': token } });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.items?.length > 0) {
        found = data.items[0];
        break;
      }
    }

    if (!found) {
      return res.json({
        ok: true,
        chatId: null,
        url: `https://go.botmaker.com/#/chats?text=${raw}`
      });
    }

    const chatId = found.chat?.chatId || found.chatId;
    res.json({
      ok: true,
      chatId,
      url: `https://go.botmaker.com/#/chats/${chatId}`,
      name: `${found.firstName || ''} ${found.lastName || ''}`.trim()
    });
  } catch (err) {
    console.error('Error botmaker chat lookup:', err.message);
    res.status(500).json({ error: 'Error buscando chat' });
  }
});

/* =====================================================
   GET — HISTORIAL DE ACTIVIDAD
===================================================== */
app.get('/activity-log', authenticate, requirePermission('activity.view'), async (req, res) => {
  try {
    const { page = 1, limit = 50, user_id, accion, order_number, fecha_desde, fecha_hasta } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Construir WHERE dinámico
    let conditions = [];
    let params = [];
    let paramIndex = 1;

    if (user_id) {
      conditions.push(`l.user_id = $${paramIndex++}`);
      params.push(user_id);
    }

    if (accion) {
      conditions.push(`l.accion ILIKE $${paramIndex++}`);
      params.push(`%${accion}%`);
    }

    if (order_number) {
      conditions.push(`l.order_number ILIKE $${paramIndex++}`);
      params.push(`%${order_number}%`);
    }

    if (fecha_desde) {
      conditions.push(`l.created_at >= $${paramIndex++}`);
      params.push(fecha_desde);
    }

    if (fecha_hasta) {
      conditions.push(`l.created_at <= $${paramIndex++}`);
      params.push(fecha_hasta + ' 23:59:59');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Contar total
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM logs l ${whereClause}`,
      params
    );
    const total = Number(countRes.rows[0].count);

    // Obtener logs con paginación (to_char devuelve string sin Z - valor ya está en hora Argentina)
    const logsRes = await pool.query(`
      SELECT
        l.id,
        l.comprobante_id,
        l.order_number,
        l.accion,
        l.origen,
        l.user_id,
        l.username,
        to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at,
        u.name as user_name,
        u.email as user_email
      FROM logs l
      LEFT JOIN users u ON l.user_id = u.id
      ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [...params, Number(limit), offset]);

    // Obtener usuarios para filtro
    const usersRes = await pool.query(`
      SELECT DISTINCT l.user_id, l.username, u.name, u.email
      FROM logs l
      LEFT JOIN users u ON l.user_id = u.id
      WHERE l.user_id IS NOT NULL
      ORDER BY u.name
    `);

    // Obtener acciones distintas para filtro
    const accionesRes = await pool.query(`
      SELECT DISTINCT accion FROM logs ORDER BY accion
    `);

    res.json({
      logs: logsRes.rows,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
      filters: {
        users: usersRes.rows,
        acciones: accionesRes.rows.map(r => r.accion)
      }
    });

  } catch (error) {
    console.error('❌ /activity-log error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — DASHBOARD STATS (KPIs agrupados por elemento)
===================================================== */
app.get('/dashboard/stats', authenticate, async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta } = req.query;
    // Si vienen fechas, usar rango; si no, usar "hoy"
    const params = [];
    let fechaDesdeExpr, fechaHastaExpr;
    if (fecha_desde && fecha_hasta) {
      params.push(fecha_desde, fecha_hasta);
      fechaDesdeExpr = `$1::date`;
      fechaHastaExpr = `$2::date`;
    } else if (fecha_desde) {
      params.push(fecha_desde);
      fechaDesdeExpr = `$1::date`;
      fechaHastaExpr = `$1::date`;
    } else {
      fechaDesdeExpr = `(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
      fechaHastaExpr = `(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;
    }

    const result = await pool.query(`
      WITH rango AS (
        SELECT ${fechaDesdeExpr} as fecha_desde, ${fechaHastaExpr} as fecha_hasta
      ),
      comprobantes_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE estado IN ('pendiente', 'a_confirmar')) as a_confirmar,
          COUNT(*) FILTER (WHERE estado = 'confirmado' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)) as confirmados_hoy,
          COUNT(*) FILTER (WHERE estado = 'rechazado' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)) as rechazados_hoy,
          COALESCE(SUM(monto) FILTER (WHERE estado = 'confirmado' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)), 0) as monto_confirmado_hoy
        FROM comprobantes
      ),
      facturacion_comprobantes AS (
        SELECT
          COALESCE(SUM(monto) FILTER (WHERE estado = 'confirmado' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)), 0) as facturacion_confirmada,
          COALESCE(SUM(monto) FILTER (WHERE estado IN ('pendiente', 'a_confirmar') AND (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)), 0) as facturacion_pendiente
        FROM comprobantes
      ),
      facturacion_efectivo AS (
        SELECT COALESCE(SUM(monto), 0) as efectivo_periodo
        FROM pagos_efectivo
        WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)
      ),
      remitos_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'processing') as procesando,
          COUNT(*) FILTER (WHERE status = 'ready') as listos,
          COUNT(*) FILTER (WHERE status = 'confirmed' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)) as confirmados_hoy,
          COUNT(*) FILTER (WHERE status = 'error') as con_error
        FROM shipping_documents
      ),
      pedidos_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)) as nuevos_hoy,
          COUNT(*) FILTER (WHERE estado_pedido = 'a_imprimir') as a_imprimir,
          COUNT(*) FILTER (WHERE estado_pedido = 'armado') as armados,
          COUNT(*) FILTER (WHERE estado_pedido IN ('enviado', 'en_calle', 'retirado')) as enviados,
          COUNT(*) FILTER (WHERE estado_pedido = 'cancelado' AND (updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)) as cancelados_hoy
        FROM orders_validated
      ),
      pagos_stats AS (
        SELECT
          COALESCE(SUM(total_pagado) FILTER (WHERE estado_pago IN ('confirmado_total', 'a_favor') AND (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)), 0) as recaudado_hoy,
          COALESCE(SUM(saldo) FILTER (WHERE saldo > 0), 0) as saldo_pendiente,
          COUNT(*) FILTER (WHERE estado_pago = 'confirmado_parcial') as parciales
        FROM orders_validated
      ),
      efectivo_stats AS (
        SELECT COALESCE(SUM(monto), 0) as efectivo_hoy
        FROM pagos_efectivo
        WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN (SELECT fecha_desde FROM rango) AND (SELECT fecha_hasta FROM rango)
      )
      SELECT
        json_build_object(
          'a_confirmar', cs.a_confirmar,
          'confirmados_hoy', cs.confirmados_hoy,
          'rechazados_hoy', cs.rechazados_hoy,
          'monto_confirmado_hoy', cs.monto_confirmado_hoy
        ) as comprobantes,
        json_build_object(
          'facturacion_confirmada', fc.facturacion_confirmada,
          'facturacion_pendiente', fc.facturacion_pendiente,
          'efectivo_periodo', fe.efectivo_periodo
        ) as facturacion,
        json_build_object(
          'procesando', rs.procesando,
          'listos', rs.listos,
          'confirmados_hoy', rs.confirmados_hoy,
          'con_error', rs.con_error
        ) as remitos,
        json_build_object(
          'nuevos_hoy', ps.nuevos_hoy,
          'a_imprimir', ps.a_imprimir,
          'armados', ps.armados,
          'enviados', ps.enviados,
          'cancelados_hoy', ps.cancelados_hoy
        ) as pedidos,
        json_build_object(
          'recaudado_hoy', pgs.recaudado_hoy,
          'efectivo_hoy', es.efectivo_hoy,
          'saldo_pendiente', pgs.saldo_pendiente,
          'parciales', pgs.parciales
        ) as pagos
      FROM comprobantes_stats cs, facturacion_comprobantes fc, facturacion_efectivo fe, remitos_stats rs, pedidos_stats ps, pagos_stats pgs, efectivo_stats es
    `, params);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ /dashboard/stats error:', error.message);
    Sentry.captureException(error);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — CONTEOS PARA MODAL DE IMPRESIÓN (TODOS los pedidos)
===================================================== */
app.get('/orders/print-counts', authenticate, requirePermission('orders.view'), async (req, res) => {
  try {
    // Contar TODOS los pedidos por estado_pedido
    const countsRes = await pool.query(`
      SELECT
        estado_pedido,
        COUNT(*) as count
      FROM orders_validated
      GROUP BY estado_pedido
    `);

    // Convertir a objeto
    const counts = {
      pendiente_pago: 0,
      a_imprimir: 0,
      hoja_impresa: 0,
      armado: 0,
      retirado: 0,
      en_calle: 0,
      enviado: 0,
      cancelado: 0,
    };

    countsRes.rows.forEach(row => {
      if (row.estado_pedido && counts.hasOwnProperty(row.estado_pedido)) {
        counts[row.estado_pedido] = Number(row.count);
      }
    });

    res.json({ ok: true, counts });

  } catch (error) {
    console.error('❌ /orders/print-counts error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — OBTENER PEDIDOS PARA IMPRIMIR (por estados)
===================================================== */
app.post('/orders/to-print', authenticate, requirePermission('orders.print'), async (req, res) => {
  try {
    const { statuses } = req.body;

    if (!statuses || !Array.isArray(statuses) || statuses.length === 0) {
      return res.status(400).json({ error: 'Debe seleccionar al menos un estado' });
    }

    // Validar que los estados sean válidos
    const validStatuses = ['pendiente_pago', 'a_imprimir', 'hoja_impresa', 'armado', 'retirado', 'en_calle', 'enviado', 'cancelado'];
    const invalidStatuses = statuses.filter(s => !validStatuses.includes(s));
    if (invalidStatuses.length > 0) {
      return res.status(400).json({ error: `Estados inválidos: ${invalidStatuses.join(', ')}` });
    }

    // Obtener pedidos con los estados seleccionados, incluyendo info de shipping
    const result = await pool.query(`
      SELECT
        o.order_number,
        o.shipping_type,
        EXISTS(SELECT 1 FROM shipping_requests WHERE order_number = o.order_number) as has_shipping_request
      FROM orders_validated o
      WHERE o.estado_pedido = ANY($1)
      ORDER BY o.created_at ASC
    `, [statuses]);

    // Separar pedidos que se pueden imprimir de los excluidos
    const printable = [];
    const excluded = [];

    for (const row of result.rows) {
      const needsShippingForm = requiresShippingForm(row.shipping_type);

      if (needsShippingForm && !row.has_shipping_request) {
        excluded.push(row.order_number);
      } else {
        printable.push(row.order_number);
      }
    }

    // Crear notificación si hay pedidos excluidos
    if (excluded.length > 0) {
      const pedidosTexto = excluded.length <= 5
        ? excluded.map(n => `#${n}`).join(', ')
        : `${excluded.slice(0, 5).map(n => `#${n}`).join(', ')} y ${excluded.length - 5} más`;

      await crearNotificacion({
        userId: req.user.id,
        tipo: 'impresion_excluida',
        titulo: `${excluded.length} pedido(s) no impreso(s)`,
        descripcion: `Pedidos con Transporte a elección sin datos de envío: ${pedidosTexto}`,
        referenciaTipo: null,
        referenciaId: null
      });
    }

    res.json({
      ok: true,
      orderNumbers: printable,
      count: printable.length,
      excluded: excluded,
      excludedCount: excluded.length
    });

  } catch (error) {
    console.error('❌ /orders/to-print error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — LISTAR TODOS LOS PEDIDOS
===================================================== */
app.get('/orders', authenticate, requirePermission('orders.view'), async (req, res) => {
  // Deshabilitar cache completamente - siempre datos frescos
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });

  try {
    // Paginación
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    // Filtros
    const { estado_pago, estado_pedido, search, fecha, shipping_data, shipping_type } = req.query;

    // Mapeo de permisos granulares a estados
    const estadoPagoPermisos = {
      'orders.view_pendiente': 'pendiente',
      'orders.view_a_confirmar': 'a_confirmar',
      'orders.view_parcial': 'parcial',
      'orders.view_total': 'total',
      'orders.view_rechazado': 'rechazado',
    };
    const estadoPedidoPermisos = {
      'orders.view_pendiente_pago': 'pendiente_pago',
      'orders.view_a_imprimir': 'a_imprimir',
      'orders.view_hoja_impresa': 'hoja_impresa',
      'orders.view_armado': 'armado',
      'orders.view_retirado': 'retirado',
      'orders.view_en_calle': 'en_calle',
      'orders.view_enviado': 'enviado',
      'orders.view_cancelado': 'cancelado',
    };

    // Obtener estados permitidos según permisos del usuario
    const userPerms = req.user.permissions || [];
    const estadosPagoPermitidos = Object.entries(estadoPagoPermisos)
      .filter(([perm]) => userPerms.includes(perm))
      .map(([, estado]) => estado);
    const estadosPedidoPermitidos = Object.entries(estadoPedidoPermisos)
      .filter(([perm]) => userPerms.includes(perm))
      .map(([, estado]) => estado);

    // Si no tiene NINGÚN permiso granular (ni de pago ni de pedido), no puede ver nada
    if (estadosPagoPermitidos.length === 0 && estadosPedidoPermitidos.length === 0) {
      return res.json({
        ok: true,
        orders: [],
        pagination: { page, limit, total: 0, totalPages: 0 }
      });
    }

    // Construir WHERE dinámico
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // Filtro por permisos granulares (OR): puede ver si tiene permiso de estado_pago O estado_pedido
    const permConditions = [];
    if (estadosPagoPermitidos.length > 0) {
      permConditions.push(`o.estado_pago = ANY($${paramIndex++})`);
      params.push(estadosPagoPermitidos);
    }
    if (estadosPedidoPermitidos.length > 0) {
      permConditions.push(`o.estado_pedido = ANY($${paramIndex++})`);
      params.push(estadosPedidoPermitidos);
    }
    if (permConditions.length > 0) {
      conditions.push(`(${permConditions.join(' OR ')})`);
    }

    if (estado_pago && estado_pago !== 'all') {
      conditions.push(`o.estado_pago = $${paramIndex++}`);
      params.push(estado_pago);
    }

    if (estado_pedido && estado_pedido !== 'all') {
      conditions.push(`o.estado_pedido = $${paramIndex++}`);
      params.push(estado_pedido);
    }

    if (search) {
      // Buscar por número de pedido o nombre de cliente
      conditions.push(`(o.order_number ILIKE $${paramIndex} OR o.customer_name ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (fecha) {
      if (fecha === 'hoy') {
        // Usar fecha original de Tiendanube (tn_created_at), con fallback a created_at
        // Convertir a timezone Argentina para comparar con fecha calendario local
        conditions.push(`DATE(COALESCE(o.tn_created_at, o.created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires') = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`);
      } else {
        // Fecha específica (formato YYYY-MM-DD)
        conditions.push(`DATE(COALESCE(o.tn_created_at, o.created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires') = $${paramIndex++}`);
        params.push(fecha);
      }
    }

    // Filtro por estado de datos de envío (para pedidos que requieren formulario)
    // shipping_data: 'pending' = requiere form pero no tiene datos, 'complete' = tiene datos
    // shipping_data: 'label_printed' = etiqueta impresa, 'label_not_printed' = etiqueta no impresa
    const requiresFormCondition = `(
      (LOWER(COALESCE(o.shipping_type, '')) LIKE '%expreso%' AND LOWER(COALESCE(o.shipping_type, '')) LIKE '%elec%')
      OR LOWER(COALESCE(o.shipping_type, '')) LIKE '%via cargo%'
      OR LOWER(COALESCE(o.shipping_type, '')) LIKE '%viacargo%'
    )`;

    if (shipping_data === 'pending') {
      // Solo pedidos que requieren form, no tienen datos cargados, Y ya tienen al menos un pago
      conditions.push(requiresFormCondition);
      conditions.push(`NOT EXISTS (SELECT 1 FROM shipping_requests sr2 WHERE sr2.order_number = o.order_number)`);
      conditions.push(`o.estado_pago != 'pendiente'`);
    } else if (shipping_data === 'complete') {
      // Solo pedidos que requieren form Y ya tienen datos cargados
      conditions.push(requiresFormCondition);
      conditions.push(`EXISTS (SELECT 1 FROM shipping_requests sr2 WHERE sr2.order_number = o.order_number)`);
    } else if (shipping_data === 'label_printed') {
      // Solo pedidos que requieren form, tienen datos Y etiqueta impresa
      conditions.push(requiresFormCondition);
      conditions.push(`EXISTS (SELECT 1 FROM shipping_requests sr2 WHERE sr2.order_number = o.order_number AND sr2.label_printed_at IS NOT NULL)`);
    } else if (shipping_data === 'label_not_printed') {
      // Solo pedidos que requieren form, tienen datos PERO etiqueta NO impresa
      conditions.push(requiresFormCondition);
      conditions.push(`EXISTS (SELECT 1 FROM shipping_requests sr2 WHERE sr2.order_number = o.order_number AND sr2.label_printed_at IS NULL)`);
    }

    // Filtro por tipo de envío
    if (shipping_type && shipping_type !== 'all') {
      const st = 'LOWER(COALESCE(o.shipping_type, \'\'))';
      switch (shipping_type) {
        case 'envio_nube':
          conditions.push(`(${st} LIKE '%envío nube%' OR ${st} LIKE '%envio nube%')`);
          break;
        case 'via_cargo':
          conditions.push(`(${st} LIKE '%via cargo%' OR ${st} LIKE '%viacargo%')`);
          break;
        case 'expreso':
          conditions.push(`(${st} LIKE '%expreso%' AND ${st} LIKE '%elec%')`);
          break;
        case 'retiro':
          conditions.push(`(${st} LIKE '%retiro%' OR ${st} LIKE '%pickup%' OR ${st} LIKE '%deposito%' OR ${st} LIKE '%depósito%' OR ${st} LIKE '%punto de retiro%')`);
          break;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Contar total con filtros
    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM orders_validated o ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].total);

    // Query con filtros (subconsultas para shipping_requests para evitar duplicados)
    const ordersRes = await pool.query(`
      SELECT
        o.order_number,
        o.monto_tiendanube,
        o.total_pagado,
        o.saldo,
        o.estado_pago,
        o.estado_pedido,
        o.currency,
        COALESCE(o.tn_created_at, o.created_at) as created_at,
        o.customer_name,
        o.customer_email,
        o.customer_phone,
        o.printed_at,
        o.packed_at,
        o.shipped_at,
        o.shipping_type,
        o.tn_payment_status,
        o.tn_shipping_status,
        o.envio_nube_label_printed_at,
        COUNT(c.id) as comprobantes_count,
        COUNT(c.id) FILTER (WHERE c.estado IN ('a_confirmar', 'pendiente')) as pending_receipts_count,
        (SELECT COALESCE(SUM(op.quantity), 0) FROM order_products op WHERE op.order_number = o.order_number)::int as productos_count,
        CASE
          WHEN o.estado_pago = 'pendiente' THEN false
          WHEN LOWER(COALESCE(o.shipping_type, '')) LIKE '%expreso%' AND LOWER(COALESCE(o.shipping_type, '')) LIKE '%elec%' THEN true
          WHEN LOWER(COALESCE(o.shipping_type, '')) LIKE '%via cargo%' THEN true
          WHEN LOWER(COALESCE(o.shipping_type, '')) LIKE '%viacargo%' THEN true
          ELSE false
        END as requires_shipping_form,
        EXISTS(SELECT 1 FROM shipping_requests WHERE order_number = o.order_number) as has_shipping_data,
        (SELECT MAX(label_printed_at) FROM shipping_requests WHERE order_number = o.order_number) as shipping_label_printed_at
      FROM orders_validated o
      LEFT JOIN comprobantes c ON o.order_number = c.order_number
      ${whereClause}
      GROUP BY o.order_number, o.order_number_int, o.monto_tiendanube, o.total_pagado, o.saldo, o.estado_pago, o.estado_pedido, o.currency, o.tn_created_at, o.created_at, o.customer_name, o.customer_email, o.customer_phone, o.printed_at, o.packed_at, o.shipped_at, o.shipping_type, o.tn_payment_status, o.tn_shipping_status, o.envio_nube_label_printed_at
      ORDER BY o.order_number_int DESC NULLS LAST
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [...params, limit, offset]);

    res.json({
      ok: true,
      orders: ordersRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('❌ /orders error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — LISTAR TODOS LOS COMPROBANTES
===================================================== */
app.get('/comprobantes', authenticate, requirePermission('receipts.view'), async (req, res) => {
  try {
    // Paginación
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    // Filtros opcionales
    const financieraId = req.query.financiera_id ? parseInt(req.query.financiera_id) : null;
    const estado = req.query.estado || null; // 'a_confirmar', 'confirmado', 'rechazado'
    const fecha = req.query.fecha || null; // 'hoy' o 'YYYY-MM-DD'

    // Construir WHERE dinámico
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (financieraId) {
      conditions.push(`c.financiera_id = $${paramIndex++}`);
      params.push(financieraId);
    }

    if (estado) {
      // 'a_confirmar' también matchea 'pendiente' (datos legacy)
      if (estado === 'a_confirmar') {
        conditions.push(`(c.estado = $${paramIndex} OR c.estado = 'pendiente' OR c.estado IS NULL)`);
        params.push('a_confirmar');
        paramIndex++;
      } else {
        conditions.push(`c.estado = $${paramIndex++}`);
        params.push(estado);
      }
    }

    if (fecha) {
      if (fecha === 'hoy') {
        // Filtrar por fecha de hoy (timezone Argentina)
        conditions.push(`DATE(c.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`);
      } else {
        // Filtrar por fecha específica (formato YYYY-MM-DD)
        conditions.push(`DATE(c.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = $${paramIndex++}`);
        params.push(fecha);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Contar total (con filtros)
    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM comprobantes c ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].total);

    // Query principal con JOIN a financieras
    const queryParams = [...params, limit, offset];
    const limitParam = paramIndex;
    const offsetParam = paramIndex + 1;

    const comprobantesRes = await pool.query(`
      SELECT
        c.id,
        c.order_number,
        c.monto,
        c.monto_tiendanube,
        c.estado,
        'transferencia' as tipo,
        c.file_url,
        NULL as registrado_por,
        to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at,
        to_char(c.confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS') as confirmed_at,
        c.financiera_id,
        f.nombre as financiera_nombre,
        o.customer_name,
        o.estado_pago as orden_estado_pago
      FROM comprobantes c
      LEFT JOIN orders_validated o ON c.order_number = o.order_number
      LEFT JOIN financieras f ON c.financiera_id = f.id
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, queryParams);

    // Total facturación pendiente de confirmar (global, sin filtros)
    const pendienteRes = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(monto), 0) as total
       FROM comprobantes
       WHERE estado IN ('a_confirmar', 'pendiente') OR estado IS NULL`
    );

    res.json({
      ok: true,
      comprobantes: comprobantesRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      },
      pendiente: {
        count: parseInt(pendienteRes.rows[0].count),
        total: Math.round(Number(pendienteRes.rows[0].total))
      }
    });

  } catch (error) {
    console.error('❌ /comprobantes error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — DETALLE DE UN COMPROBANTE
===================================================== */
app.get('/comprobantes/:id', authenticate, requirePermission('receipts.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const compRes = await pool.query(`
      SELECT
        c.id,
        c.order_number,
        c.monto,
        c.monto_tiendanube,
        c.estado,
        'transferencia' as tipo,
        c.file_url,
        c.texto_ocr,
        NULL as registrado_por,
        to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at,
        c.financiera_id,
        f.nombre as financiera_nombre,
        o.customer_name,
        o.customer_email,
        o.customer_phone,
        o.monto_tiendanube as orden_total,
        o.total_pagado as orden_pagado,
        o.saldo as orden_saldo,
        o.estado_pago as orden_estado_pago
      FROM comprobantes c
      LEFT JOIN orders_validated o ON c.order_number = o.order_number
      LEFT JOIN financieras f ON c.financiera_id = f.id
      WHERE c.id = $1
    `, [id]);

    if (compRes.rowCount === 0) {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    // Obtener logs del comprobante (to_char sin Z - valor ya está en hora Argentina)
    const logsRes = await pool.query(`
      SELECT id, accion, origen,
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at
      FROM logs
      WHERE comprobante_id = $1
      ORDER BY created_at DESC
    `, [id]);

    res.json({
      ok: true,
      comprobante: compRes.rows[0],
      logs: logsRes.rows
    });

  } catch (error) {
    console.error('❌ /comprobantes/:id error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — CONFIRMAR COMPROBANTE (API JSON)
===================================================== */
app.post('/comprobantes/:id/confirmar', authenticate, requirePermission('receipts.confirm'), async (req, res) => {
  const { id } = req.params;
  const requestTime = Date.now();
  const requestId = `${id}-${req.user?.id}-${requestTime}`;

  log.info({ requestId, comprobanteId: id, action: 'confirm_start' }, 'Starting comprobante confirmation');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1️⃣ Buscar comprobante con row lock
    const compRes = await client.query(
      `SELECT id, order_number, monto, estado FROM comprobantes WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (compRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    const comprobante = compRes.rows[0];

    if (comprobante.estado !== 'pendiente' && comprobante.estado !== 'a_confirmar') {
      await client.query('ROLLBACK');
      log.warn({ requestId, comprobanteId: id, estado: comprobante.estado }, 'Comprobante already processed');
      return res.status(400).json({ error: 'Este comprobante ya fue procesado' });
    }

    // 2️⃣ Confirmar comprobante
    await client.query(`UPDATE comprobantes SET estado = 'confirmado' WHERE id = $1`, [id]);

    // 3️⃣ Recalcular pagos (centralizado: pago_online_tn + comprobantes + efectivo)
    const pagoResult = await recalcularPagos(client, comprobante.order_number);
    const { totalPagado, saldo, estadoPago } = pagoResult;
    const nuevoEstadoPedido = pagoResult.estadoPedido;

    // 4️⃣ Obtener datos de cliente del pedido
    const orderRes = await client.query(
      `SELECT monto_tiendanube, estado_pedido, customer_name, customer_phone, shipping_type, tn_order_id FROM orders_validated WHERE order_number = $1`,
      [comprobante.order_number]
    );

    const orderData = orderRes.rows[0];
    const montoPedido = Number(orderData.monto_tiendanube);
    const estadoPedidoActual = orderData.estado_pedido;

    await client.query('COMMIT');

    // 7.5️⃣ Sincronizar con Tiendanube si está completamente pagado (after commit)
    if (estadoPago === 'confirmado_total' && orderData.tn_order_id) {
      marcarPagadoEnTiendanube(orderData.tn_order_id, comprobante.order_number);
      // No await - no bloqueamos la respuesta
    }

    // 8️⃣ Log
    log.info({ requestId, comprobanteId: id, orderNumber: comprobante.order_number, action: 'confirm_log' }, 'Inserting confirmation log');
    await logEvento({
      comprobanteId: id,
      orderNumber: comprobante.order_number,
      accion: 'comprobante_confirmado',
      origen: 'operador',
      userId: req.user?.id,
      username: req.user?.name
    });

    log.info({ requestId, comprobanteId: id, orderNumber: comprobante.order_number, estadoPago, totalPagado, saldo, action: 'confirm_success' }, 'Comprobante confirmed successfully');
    if (nuevoEstadoPedido !== estadoPedidoActual) {
      log.info({ requestId, orderNumber: comprobante.order_number, estadoPedidoAnterior: estadoPedidoActual, nuevoEstadoPedido }, 'Order status changed');
    }

    // 9️⃣ Enviar WhatsApp si hay teléfono
    const customerPhone = orderData.customer_phone;
    if (customerPhone) {
      const customerName = orderData.customer_name || 'Cliente';
      const shippingType = orderData.shipping_type || '';

      // Enviar comprobante_confirmado siempre al confirmar
      try {
        await queueWhatsApp({
          telefono: customerPhone,
          plantilla: 'comprobante_confirmado',
          variables: { '1': customerName, '2': String(comprobante.monto), '3': comprobante.order_number },
          orderNumber: comprobante.order_number
        });
      } catch (waErr) {
        log.error({ err: waErr.message, orderNumber: comprobante.order_number, plantilla: 'comprobante_confirmado' }, 'Error encolando WhatsApp');
      }

      // Enviar datos__envio si es el primer comprobante confirmado y requiere formulario
      if (requiresShippingForm(shippingType)) {
        const countRes = await pool.query(
          `SELECT COUNT(*) as count FROM comprobantes WHERE order_number = $1 AND estado = 'confirmado'`,
          [comprobante.order_number]
        );
        if (parseInt(countRes.rows[0].count) === 1) {
          try {
            await queueWhatsApp({
              telefono: customerPhone,
              plantilla: 'datos__envio',
              variables: { '1': customerName, '2': comprobante.order_number },
              orderNumber: comprobante.order_number
            });
          } catch (waErr) {
            log.error({ err: waErr.message, orderNumber: comprobante.order_number, plantilla: 'datos__envio' }, 'Error encolando WhatsApp');
          }
        }
      }
    }

    res.json({
      ok: true,
      comprobante_id: id,
      order_number: comprobante.order_number,
      total_pagado: totalPagado,
      saldo,
      estado_pago: estadoPago,
      estado_pedido: nuevoEstadoPedido || undefined
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    log.error({ err: error, requestId, comprobanteId: id }, '/comprobantes/:id/confirmar error');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});


/* =====================================================
   POST — RECHAZAR COMPROBANTE (API JSON)
===================================================== */
/* =====================================================
   AUTO-CONFIRMAR COMPROBANTES DESDE JSON DEL BANCO
   Matchea transferencias entrantes contra comprobantes pendientes
   por monto exacto + misma fecha
===================================================== */

/* ── PASO 1: PREVIEW — cruza movimientos vs comprobantes, NO aplica nada ── */
app.post('/comprobantes/conciliacion-preview', authenticate, requirePermission('receipts.confirm'), async (req, res) => {
  try {
    const { movimientos } = req.body;

    if (!Array.isArray(movimientos) || movimientos.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de movimientos' });
    }

    const entrantes = movimientos.filter(m =>
      m.Tipo === 'Transferencia entrante' &&
      m.Estado === 'Ejecutado' &&
      parseFloat(m.Importe) > 0
    );

    log.info({ total: movimientos.length, entrantes: entrantes.length }, 'Conciliación preview: inicio');

    const matched = [];
    const unmatched = [];
    const usedComprobanteIds = new Set();

    for (const mov of entrantes) {
      const importe = Math.round(parseFloat(mov.Importe));
      const fechaBanco = mov['Fecha/Hora'].split(' ')[0];
      const horaBanco = mov['Fecha/Hora'].split(' ')[1] || '';
      const nombreOrigen = (mov['Nombre Destino'] || '').trim();

      // Buscar comprobante pendiente con monto ±1 (tolerancia redondeo) y misma fecha
      const compRes = await pool.query(
        `SELECT c.id, c.order_number, c.monto, c.estado, c.created_at, c.numero_operacion,
                c.fecha_comprobante,
                ov.customer_name, ov.monto_tiendanube
         FROM comprobantes c
         LEFT JOIN orders_validated ov ON ov.order_number = c.order_number
         WHERE c.estado IN ('pendiente', 'a_confirmar')
           AND ABS(c.monto - $1) <= 1
           AND COALESCE(c.fecha_comprobante, c.created_at::date) = $2::date
         ORDER BY c.created_at ASC`,
        [importe, fechaBanco]
      );

      // Tomar el primer comprobante que no haya sido usado en otro match
      const comprobante = compRes.rows.find(r => !usedComprobanteIds.has(r.id));

      if (!comprobante) {
        // Buscar posible match con mismo monto pero fecha distinta
        const posibleRes = await pool.query(
          `SELECT c.id, c.order_number, c.monto, c.created_at,
                  c.fecha_comprobante,
                  ov.customer_name, ov.monto_tiendanube
           FROM comprobantes c
           LEFT JOIN orders_validated ov ON ov.order_number = c.order_number
           WHERE c.estado IN ('pendiente', 'a_confirmar')
             AND ABS(c.monto - $1) <= 1
             AND COALESCE(c.fecha_comprobante, c.created_at::date) != $2::date
           ORDER BY c.created_at DESC
           LIMIT 1`,
          [importe, fechaBanco]
        );
        const posible = posibleRes.rows[0] || null;

        if (posible && !usedComprobanteIds.has(posible.id)) {
          // Posible match → va a la lista de matched pero con tipo 'posible'
          usedComprobanteIds.add(posible.id);

          // Calcular diferencia de tiempo
          const fechaBancoDate = new Date(mov['Fecha/Hora']);
          const fechaCompDate = new Date(posible.created_at);
          const diffMs = Math.abs(fechaBancoDate - fechaCompDate);
          const diffHoras = Math.round(diffMs / (1000 * 60 * 60));
          const diffTexto = diffHoras < 24 ? `${diffHoras}h de diferencia` : `${Math.round(diffHoras / 24)}d de diferencia`;

          matched.push({
            banco_id: mov.ID,
            comprobante_id: posible.id,
            order_number: posible.order_number,
            monto: importe,
            monto_pedido: posible.monto_tiendanube || null,
            nombre_banco: nombreOrigen,
            nombre_cliente: posible.customer_name || '',
            fecha_banco: fechaBanco,
            hora_banco: horaBanco,
            fecha_comprobante: posible.created_at,
            numero_operacion: posible.numero_operacion || null,
            tipo: 'posible',
            diff: diffTexto
          });
        } else {
          // Sin match → motivo claro
          let motivo = 'No hay comprobante pendiente por $' + importe.toLocaleString('es-AR');
          if (posible) {
            motivo = 'Comprobante por este monto ya asignado a otro movimiento';
          }
          unmatched.push({
            banco_id: mov.ID,
            importe,
            fecha: fechaBanco,
            hora: horaBanco,
            nombre: nombreOrigen,
            motivo
          });
        }
        continue;
      }

      usedComprobanteIds.add(comprobante.id);

      matched.push({
        banco_id: mov.ID,
        comprobante_id: comprobante.id,
        order_number: comprobante.order_number,
        monto: importe,
        monto_pedido: comprobante.monto_tiendanube || null,
        nombre_banco: nombreOrigen,
        nombre_cliente: comprobante.customer_name || '',
        fecha_banco: fechaBanco,
        hora_banco: horaBanco,
        fecha_comprobante: comprobante.created_at,
        numero_operacion: comprobante.numero_operacion || null,
        tipo: 'exacto'
      });
    }

    // Comprobantes pendientes que no conciliaron con ningún movimiento
    const usedIds = Array.from(usedComprobanteIds);
    const sinConciliarRes = await pool.query(
      `SELECT c.id, c.order_number, c.monto, c.estado, c.created_at, c.numero_operacion,
              ov.customer_name
       FROM comprobantes c
       LEFT JOIN orders_validated ov ON ov.order_number = c.order_number
       WHERE c.estado IN ('pendiente', 'a_confirmar')
         ${usedIds.length > 0 ? `AND c.id NOT IN (${usedIds.map((_, i) => `$${i + 1}`).join(',')})` : ''}
       ORDER BY c.created_at DESC`,
      usedIds.length > 0 ? usedIds : []
    );

    const sin_conciliar = sinConciliarRes.rows.map(c => ({
      comprobante_id: c.id,
      order_number: c.order_number,
      monto: Number(c.monto),
      estado: c.estado,
      cliente: c.customer_name || '',
      fecha: c.created_at,
      numero_operacion: c.numero_operacion || null
    }));

    log.info({ matched: matched.length, unmatched: unmatched.length, sin_conciliar: sin_conciliar.length }, 'Conciliación preview: fin');

    // Persistir movimientos bancarios en Admin Banco (sin assignments)
    // para que se actualice aunque no haya matches y no se toque "Aplicar"
    let bankImportResult = null;
    try {
      bankImportResult = await importMovimientos(movimientos, req.user?.id, []);
      log.info({ inserted: bankImportResult.inserted, duplicated: bankImportResult.duplicated }, 'Bank import from conciliación preview');
    } catch (err) {
      log.error({ err: err.message }, 'Bank import from conciliación preview failed');
    }

    res.json({
      ok: true,
      preview: true,
      summary: {
        total_movimientos: movimientos.length,
        transferencias_entrantes: entrantes.length,
        matched: matched.length,
        unmatched: unmatched.length,
        sin_conciliar: sin_conciliar.length,
        bank_import: bankImportResult
      },
      matched,
      unmatched,
      sin_conciliar
    });

  } catch (error) {
    log.error({ err: error }, '/comprobantes/conciliacion-preview error');
    res.status(500).json({ error: error.message });
  }
});

/* ── PASO 2: APLICAR — confirma solo los comprobantes seleccionados ── */
app.post('/comprobantes/conciliacion-aplicar', authenticate, requirePermission('receipts.confirm'), async (req, res) => {
  try {
    const { matches, fecha_max, movimientos_banco } = req.body;

    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de matches a confirmar' });
    }

    log.info({ count: matches.length }, 'Conciliación aplicar: inicio');

    const confirmed = [];
    const errors = [];

    for (const match of matches) {
      const { comprobante_id, banco_id } = match;

      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // Verificar que el comprobante sigue pendiente
          const compRes = await client.query(
            `SELECT id, order_number, monto, estado
             FROM comprobantes
             WHERE id = $1 AND estado IN ('pendiente', 'a_confirmar')
             FOR UPDATE`,
            [comprobante_id]
          );

          if (compRes.rowCount === 0) {
            await client.query('ROLLBACK');
            errors.push({ comprobante_id, banco_id, error: 'Comprobante ya no está pendiente' });
            continue;
          }

          const comprobante = compRes.rows[0];

          // Confirmar
          await client.query(`UPDATE comprobantes SET estado = 'confirmado', confirmed_at = NOW() WHERE id = $1`, [comprobante.id]);

          const pagoResult = await recalcularPagos(client, comprobante.order_number);
          const { estadoPago } = pagoResult;

          const orderRes = await client.query(
            `SELECT monto_tiendanube, estado_pedido, customer_name, customer_phone, shipping_type, tn_order_id
             FROM orders_validated WHERE order_number = $1`,
            [comprobante.order_number]
          );
          const orderData = orderRes.rows[0];

          await client.query('COMMIT');

          // Post-commit actions
          if (estadoPago === 'confirmado_total' && orderData?.tn_order_id) {
            marcarPagadoEnTiendanube(orderData.tn_order_id, comprobante.order_number);
          }

          logEvento({
            comprobanteId: comprobante.id,
            orderNumber: comprobante.order_number,
            accion: 'comprobante_confirmado',
            origen: 'conciliacion_banco',
            userId: req.user?.id,
            username: req.user?.name
          });

          if (orderData?.customer_phone) {
            try {
              await queueWhatsApp({
                telefono: orderData.customer_phone,
                plantilla: 'comprobante_confirmado',
                variables: { '1': orderData.customer_name || 'Cliente', '2': String(comprobante.monto), '3': comprobante.order_number },
                orderNumber: comprobante.order_number
              });
            } catch (waErr) {
              log.error({ err: waErr.message, orderNumber: comprobante.order_number, plantilla: 'comprobante_confirmado' }, 'Error encolando WhatsApp en conciliación');
            }

            if (requiresShippingForm(orderData.shipping_type)) {
              const countRes = await pool.query(
                `SELECT COUNT(*) as count FROM comprobantes WHERE order_number = $1 AND estado = 'confirmado'`,
                [comprobante.order_number]
              );
              if (parseInt(countRes.rows[0].count) === 1) {
                try {
                  await queueWhatsApp({
                    telefono: orderData.customer_phone,
                    plantilla: 'datos__envio',
                    variables: { '1': orderData.customer_name || 'Cliente', '2': comprobante.order_number },
                    orderNumber: comprobante.order_number
                  });
                } catch (waErr) {
                  log.error({ err: waErr.message, orderNumber: comprobante.order_number, plantilla: 'datos__envio' }, 'Error encolando WhatsApp en conciliación');
                }
              }
            }
          }

          console.log(`✅ Conciliación: comprobante #${comprobante.id} (pedido #${comprobante.order_number}) confirmado — banco ID ${banco_id}`);

          confirmed.push({
            banco_id,
            comprobante_id: comprobante.id,
            order_number: comprobante.order_number,
            monto: comprobante.monto
          });

        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {});
          console.error(`❌ Conciliación error: comprobante #${comprobante_id} — ${txErr.message}`);
          errors.push({ comprobante_id, banco_id, error: txErr.message });
        } finally {
          client.release();
        }
      } catch (connErr) {
        errors.push({ comprobante_id, banco_id, error: connErr.message });
      }
    }

    log.info({ confirmed: confirmed.length, errors: errors.length }, 'Conciliación aplicar: fin');

    // Persistir movimientos bancarios en Admin Banco con assignments resueltos
    let bankImportResult = null;
    if (Array.isArray(movimientos_banco) && movimientos_banco.length > 0) {
      const resolvedMatches = confirmed.map(c => ({
        banco_id: c.banco_id,
        comprobante_id: c.comprobante_id,
        order_number: c.order_number
      }));
      try {
        bankImportResult = await importMovimientos(movimientos_banco, req.user?.id, resolvedMatches);
        log.info({ inserted: bankImportResult.inserted, duplicated: bankImportResult.duplicated, updated: bankImportResult.updated }, 'Bank import from conciliación aplicar');
      } catch (err) {
        log.error({ err: err.message }, 'Bank import from conciliación aplicar failed');
        bankImportResult = { error: err.message };
      }
    }

    res.json({
      ok: true,
      summary: {
        confirmed: confirmed.length,
        errors: errors.length,
        bank_import: bankImportResult
      },
      confirmed,
      errors
    });

  } catch (error) {
    log.error({ err: error }, '/comprobantes/conciliacion-aplicar error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/comprobantes/:id/rechazar', authenticate, requirePermission('receipts.reject'), async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body;
  const requestTime = Date.now();
  const requestId = `${id}-${req.user?.id}-${requestTime}`;

  log.info({ requestId, comprobanteId: id, action: 'reject_start' }, 'Starting comprobante rejection');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Query optimizada con row lock: trae comprobante + datos del cliente
    const compRes = await client.query(
      `SELECT c.id, c.order_number, c.estado, c.monto,
              ov.customer_name, ov.customer_phone
       FROM comprobantes c
       LEFT JOIN orders_validated ov ON c.order_number = ov.order_number
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [id]
    );

    if (compRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    const comprobante = compRes.rows[0];

    if (comprobante.estado !== 'pendiente' && comprobante.estado !== 'a_confirmar') {
      await client.query('ROLLBACK');
      log.warn({ requestId, comprobanteId: id, estado: comprobante.estado }, 'Comprobante already processed');
      return res.status(400).json({ error: 'Este comprobante ya fue procesado' });
    }

    // Rechazar comprobante (guardar fecha de procesamiento en confirmed_at)
    await client.query(`UPDATE comprobantes SET estado = 'rechazado', confirmed_at = NOW(), confirmed_by = $2 WHERE id = $1`, [id, req.user?.id]);

    await client.query('COMMIT');

    // Log (after commit)
    log.info({ requestId, comprobanteId: id, orderNumber: comprobante.order_number, action: 'reject_log' }, 'Inserting rejection log');
    await logEvento({
      comprobanteId: id,
      orderNumber: comprobante.order_number,
      accion: motivo ? `comprobante_rechazado: ${motivo}` : 'comprobante_rechazado',
      origen: 'operador',
      userId: req.user?.id,
      username: req.user?.name
    });

    // WhatsApp al cliente - comprobante_rechazado
    if (comprobante.customer_phone) {
      try {
        await queueWhatsApp({
          telefono: comprobante.customer_phone,
          plantilla: 'comprobante_rechazado',
          variables: {
            '1': comprobante.customer_name || 'Cliente',
            '2': String(comprobante.monto),
            '3': comprobante.order_number
          },
          orderNumber: comprobante.order_number
        });
      } catch (waErr) {
        log.error({ err: waErr.message, orderNumber: comprobante.order_number, plantilla: 'comprobante_rechazado' }, 'Error encolando WhatsApp');
      }
    }

    log.info({ requestId, comprobanteId: id, orderNumber: comprobante.order_number, motivo, action: 'reject_success' }, 'Comprobante rejected successfully');

    res.json({
      ok: true,
      comprobante_id: id,
      order_number: comprobante.order_number
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    log.error({ err: error, requestId, comprobanteId: id }, '/comprobantes/:id/rechazar error');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});


/* =====================================================
   GET — DATOS PARA IMPRIMIR PEDIDO (DESDE DB LOCAL)
===================================================== */
app.get('/orders/:orderNumber/print', authenticate, requirePermission('orders.print'), async (req, res) => {
  try {
    const { orderNumber } = req.params;

    console.log(`🖨️ Obteniendo datos de impresión para pedido #${orderNumber}`);

    // 1️⃣ Obtener pedido completo de la DB
    const orderRes = await pool.query(`
      SELECT
        order_number,
        monto_tiendanube,
        subtotal,
        discount,
        shipping_cost,
        currency,
        customer_name,
        customer_email,
        customer_phone,
        shipping_type,
        shipping_tracking,
        shipping_address,
        note,
        owner_note,
        tn_payment_status,
        tn_shipping_status,
        tn_created_at,
        estado_pago,
        estado_pedido,
        total_pagado,
        saldo
      FROM orders_validated
      WHERE order_number = $1
    `, [orderNumber]);

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderRes.rows[0];

    // 2️⃣ Obtener productos de la DB
    const productosRes = await pool.query(`
      SELECT
        product_id as id,
        name,
        variant,
        quantity,
        price,
        price * quantity as total,
        sku
      FROM order_products
      WHERE order_number = $1
      ORDER BY name ASC
    `, [orderNumber]);

    const productos = productosRes.rows.map(p => ({
      ...p,
      price: Number(p.price),
      total: Number(p.total)
    }));

    // 2.5️⃣ Buscar datos de envío del formulario /envio (shipping_requests)
    // Tiene prioridad sobre orders_validated.shipping_address
    const shippingReqRes = await pool.query(`
      SELECT * FROM shipping_requests
      WHERE order_number = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [orderNumber]);

    const shippingRequest = shippingReqRes.rows[0] || null;

    // Determinar si requiere formulario de envío (Via Cargo, Expreso a elección)
    const needsShippingForm = requiresShippingForm(order.shipping_type);

    // Si requiere formulario y no lo tiene → BLOQUEAR
    if (needsShippingForm && !shippingRequest) {
      return res.status(400).json({
        error: 'No se puede imprimir: el cliente no completó el formulario de datos de envío',
        code: 'MISSING_SHIPPING_DATA'
      });
    }

    // Determinar shipping_address: prioridad a shipping_requests, fallback a orders_validated
    let shippingAddress = null;
    if (shippingRequest) {
      // Usar datos del formulario /envio
      const empresaEnvio = shippingRequest.empresa_envio === 'OTRO'
        ? shippingRequest.empresa_envio_otro
        : 'Via Cargo';
      shippingAddress = {
        name: shippingRequest.nombre_apellido,
        address: shippingRequest.direccion_entrega,
        number: '',
        floor: shippingRequest.destino_tipo === 'SUCURSAL' ? `Sucursal ${empresaEnvio}` : null,
        locality: shippingRequest.localidad,
        city: shippingRequest.localidad,
        province: shippingRequest.provincia,
        zipcode: shippingRequest.codigo_postal,
        phone: shippingRequest.telefono,
        between_streets: null,
        reference: shippingRequest.comentarios || `Envío: ${empresaEnvio}`,
      };
      console.log(`   📦 Usando datos de /envio para pedido #${orderNumber}`);
    } else if (order.shipping_address) {
      // Fallback: usar datos de Tiendanube (para Envío Nube, Retiro, etc.)
      shippingAddress = order.shipping_address;
      console.log(`   📦 Usando datos de Tiendanube para pedido #${orderNumber}`);
    }

    // 3️⃣ Estructurar respuesta
    const printData = {
      // Info del pedido
      order_number: order.order_number,
      created_at: order.tn_created_at,
      payment_status: order.tn_payment_status,
      shipping_status: order.tn_shipping_status,

      // Cliente
      customer: {
        name: order.customer_name || 'Sin nombre',
        email: order.customer_email || null,
        phone: order.customer_phone || null,
        identification: null,
      },

      // Dirección de envío (prioridad: shipping_requests > orders_validated)
      shipping_address: shippingAddress,

      // Envío - inferir si es retiro o envío
      // Si hay datos del formulario /envio, usar la empresa elegida por el cliente
      shipping: (() => {
        let type = order.shipping_type || 'No especificado';

        // Prioridad: empresa de envío elegida en formulario /envio
        if (shippingRequest) {
          const empresa = shippingRequest.empresa_envio === 'OTRO'
            ? shippingRequest.empresa_envio_otro
            : shippingRequest.empresa_envio;
          if (empresa) {
            type = empresa;
          }
        }

        const typeLower = type.toLowerCase();
        const isPickup = typeLower.includes('pickup') ||
                         typeLower.includes('retiro') ||
                         typeLower.includes('deposito') ||
                         typeLower.includes('depósito');
        return {
          type,
          pickup_type: isPickup ? 'pickup' : 'ship',
          cost: Number(order.shipping_cost) || 0,
          tracking_number: order.shipping_tracking || null,
        };
      })(),

      // Productos (ya ordenados alfabéticamente)
      products: productos,

      // Totales
      totals: {
        subtotal: Number(order.subtotal) || 0,
        discount: Number(order.discount) || 0,
        shipping: Number(order.shipping_cost) || 0,
        total: Number(order.monto_tiendanube) || 0,
      },

      // Notas
      note: order.note || null,
      owner_note: order.owner_note || null,

      // Estado interno
      internal: {
        estado_pago: order.estado_pago,
        estado_pedido: order.estado_pedido,
        total_pagado: order.total_pagado,
        saldo: order.saldo
      },
    };

    res.json({
      ok: true,
      print_data: printData
    });

  } catch (error) {
    console.error('❌ /orders/:orderNumber/print error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — DETALLE DE UN PEDIDO
===================================================== */
app.get('/orders/:orderNumber', authenticate, requirePermission('orders.view'), async (req, res) => {
  try {
    const { orderNumber } = req.params;

    // Obtener pedido
    const orderRes = await pool.query(`
      SELECT
        order_number,
        monto_tiendanube,
        total_pagado,
        saldo,
        estado_pago,
        estado_pedido,
        currency,
        created_at,
        customer_name,
        customer_email,
        customer_phone,
        printed_at,
        packed_at,
        shipped_at,
        shipping_type,
        monto_original,
        tn_payment_status,
        tn_shipping_status,
        envio_nube_label_printed_at,
        subtotal,
        discount,
        shipping_cost
      FROM orders_validated
      WHERE order_number = $1
    `, [orderNumber]);

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderRes.rows[0];

    // Verificar permisos granulares para este pedido
    const estadoPagoPermisos = {
      'pendiente': 'orders.view_pendiente',
      'a_confirmar': 'orders.view_a_confirmar',
      'parcial': 'orders.view_parcial',
      'total': 'orders.view_total',
      'rechazado': 'orders.view_rechazado',
    };
    const estadoPedidoPermisos = {
      'pendiente_pago': 'orders.view_pendiente_pago',
      'a_imprimir': 'orders.view_a_imprimir',
      'hoja_impresa': 'orders.view_hoja_impresa',
      'armado': 'orders.view_armado',
      'retirado': 'orders.view_retirado',
      'en_calle': 'orders.view_en_calle',
      'enviado': 'orders.view_enviado',
      'cancelado': 'orders.view_cancelado',
    };

    const userPerms = req.user.permissions || [];
    const requiredPagoPerm = estadoPagoPermisos[order.estado_pago];
    const requiredPedidoPerm = estadoPedidoPermisos[order.estado_pedido];

    // Lógica OR: puede ver si tiene permiso para el estado_pago O para el estado_pedido
    const hasPagoPerm = requiredPagoPerm && userPerms.includes(requiredPagoPerm);
    const hasPedidoPerm = requiredPedidoPerm && userPerms.includes(requiredPedidoPerm);

    if (!hasPagoPerm && !hasPedidoPerm) {
      return res.status(403).json({ error: 'No tienes permiso para ver este pedido' });
    }

    // Obtener comprobantes del pedido (transferencias)
    const comprobantesRes = await pool.query(`
      SELECT
        id,
        monto,
        estado,
        'transferencia' as tipo,
        file_url,
        texto_ocr,
        NULL as registrado_por,
        created_at
      FROM comprobantes
      WHERE order_number = $1
      ORDER BY created_at DESC
    `, [orderNumber]);

    // Obtener pagos en efectivo del pedido
    const pagosEfectivoRes = await pool.query(`
      SELECT
        id,
        monto,
        registrado_por,
        notas,
        created_at
      FROM pagos_efectivo
      WHERE order_number = $1
      ORDER BY created_at DESC
    `, [orderNumber]);

    // Obtener logs del pedido (por comprobante O por order_number directo)
    // Usando UNION (sin ALL) para eliminar duplicados cuando un log tiene ambos comprobante_id y order_number
    // to_char() devuelve string sin Z - el valor ya está en hora Argentina
    const logsRes = await pool.query(`
      SELECT id, accion, origen, username, created_at FROM (
        -- Logs vinculados a comprobantes del pedido
        SELECT
          l.id,
          l.accion,
          l.origen,
          l.username,
          to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at
        FROM logs l
        JOIN comprobantes c ON l.comprobante_id = c.id
        WHERE c.order_number = $1

        UNION

        -- Logs directos del pedido (ej: webhook tiendanube, hoja_impresa)
        SELECT
          l.id,
          l.accion,
          l.origen,
          l.username,
          to_char(l.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at
        FROM logs l
        WHERE l.order_number = $1
      ) combined
      ORDER BY created_at DESC
    `, [orderNumber]);

    // Obtener productos de la DB local
    const productosRes = await pool.query(`
      SELECT
        product_id as id,
        name,
        variant,
        quantity,
        price,
        price * quantity as total,
        sku
      FROM order_products
      WHERE order_number = $1
      ORDER BY name ASC
    `, [orderNumber]);

    const productos = productosRes.rows.map(p => ({
      ...p,
      price: Number(p.price),
      total: Number(p.total)
    }));

    // 🔍 Verificar si hay inconsistencias activas
    const inconsistencias = await getInconsistencias(orderNumber);

    res.json({
      ok: true,
      order: order,
      comprobantes: comprobantesRes.rows,
      pagos_efectivo: pagosEfectivoRes.rows,
      logs: logsRes.rows,
      productos: productos,
      has_inconsistency: inconsistencias.length > 0,
      inconsistencies: inconsistencias
    });

  } catch (error) {
    console.error('❌ /orders/:orderNumber error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — RESYNC PEDIDO DESDE TIENDANUBE
===================================================== */
app.post('/orders/:orderNumber/resync', authenticate, requirePermission('orders.view'), async (req, res) => {
  try {
    const { orderNumber } = req.params;

    // Check de integración habilitada
    const resyncEnabled = await tnConfig.isResyncManualEnabled();
    if (!resyncEnabled) {
      return res.status(503).json({ error: 'Resync manual está deshabilitado temporalmente' });
    }
    const singleEnabled = await isIntegrationEnabled('tiendanube_resync_single', { context: 'resync-single' });
    if (!singleEnabled) {
      return res.status(503).json({ error: 'Resync individual está deshabilitado' });
    }

    // 1. Buscar tn_order_id en nuestra DB
    const orderRes = await pool.query(
      'SELECT tn_order_id FROM orders_validated WHERE order_number = $1',
      [orderNumber]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado en DB' });
    }

    let tnOrderId = orderRes.rows[0].tn_order_id;

    // 2. Si no tenemos tn_order_id, buscar en TiendaNube por número
    if (!tnOrderId) {
      const storeId = process.env.TIENDANUBE_STORE_ID;
      const searchRes = await callTiendanube({
        method: 'get',
        url: `https://api.tiendanube.com/v1/${storeId}/orders`,
        headers: {
          authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-validator'
        },
        params: { q: orderNumber },
        timeout: 10000
      });

      const found = searchRes.data.find(o => String(o.number) === orderNumber);
      if (!found) {
        return res.status(404).json({ error: 'Pedido no encontrado en TiendaNube' });
      }
      tnOrderId = found.id;

      // Guardar tn_order_id para futuras consultas
      await pool.query(
        'UPDATE orders_validated SET tn_order_id = $1 WHERE order_number = $2',
        [tnOrderId, orderNumber]
      );
    }

    // 3. Obtener pedido completo de TiendaNube
    const storeId = process.env.TIENDANUBE_STORE_ID;
    const pedidoRes = await callTiendanube({
      method: 'get',
      url: `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
      headers: {
        authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
        'User-Agent': 'bpm-validator'
      },
      timeout: 10000
    });

    const pedido = pedidoRes.data;
    const productosTN = pedido.products || [];

    // 4. Sincronizar productos (UPSERT + DELETE de removidos)
    const saveResult = await guardarProductos(orderNumber, productosTN);

    // 5. Resolver inconsistencias previas (ya lo hace guardarProductos, pero por si acaso)
    await pool.query(`
      UPDATE order_inconsistencies
      SET resolved = TRUE, resolved_at = NOW()
      WHERE order_number = $1 AND resolved = FALSE
    `, [orderNumber]);

    // 6. Verificar resultado post-sync
    const dbProductsRes = await pool.query(
      `SELECT COUNT(*) as count FROM order_products WHERE order_number = $1`,
      [orderNumber]
    );
    const dbProductCount = parseInt(dbProductsRes.rows[0].count);

    const isFullySync = dbProductCount === productosTN.length && saveResult.errors.length === 0;

    if (isFullySync) {
      console.log(`✅ Pedido #${orderNumber} re-sincronizado correctamente (${dbProductCount} productos)`);
    } else {
      console.warn(`⚠️ Pedido #${orderNumber} resync parcial: TN=${productosTN.length}, DB=${dbProductCount}, Errores=${saveResult.errors.length}`);
    }

    res.json({
      ok: isFullySync,
      message: isFullySync
        ? `Pedido #${orderNumber} re-sincronizado correctamente`
        : `Pedido #${orderNumber} re-sincronizado con advertencias`,
      productos_tiendanube: productosTN.length,
      productos_guardados: saveResult.saved,
      productos_en_db: dbProductCount,
      productos_eliminados: saveResult.deleted,
      errores: saveResult.errors
    });

  } catch (error) {
    console.error('❌ /orders/:orderNumber/resync error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — RESYNC SOLO PEDIDOS CON INCONSISTENCIAS
===================================================== */
app.post('/admin/resync-inconsistent-orders', authenticate, requirePermission('users.view'), async (req, res) => {
  try {
    // Check de integración habilitada
    const resyncEnabled = await tnConfig.isResyncManualEnabled();
    if (!resyncEnabled) {
      return res.status(503).json({ error: 'Resync manual está deshabilitado temporalmente' });
    }
    const inconsistentEnabled = await isIntegrationEnabled('tiendanube_resync_inconsistent', { context: 'resync-inconsistent' });
    if (!inconsistentEnabled) {
      return res.status(503).json({ error: 'Resync de inconsistencias está deshabilitado' });
    }

    const storeId = process.env.TIENDANUBE_STORE_ID;

    // 1. Obtener pedidos con inconsistencias no resueltas
    const ordersRes = await pool.query(`
      SELECT DISTINCT oi.order_number, ov.tn_order_id
      FROM order_inconsistencies oi
      JOIN orders_validated ov ON oi.order_number = ov.order_number
      WHERE oi.resolved = FALSE AND ov.tn_order_id IS NOT NULL
    `);

    const orders = ordersRes.rows;
    console.log(`🔄 Resync de ${orders.length} pedidos con inconsistencias...`);

    if (orders.length === 0) {
      return res.json({ ok: true, message: 'No hay pedidos con inconsistencias', total: 0 });
    }

    // Responder inmediatamente
    res.json({
      ok: true,
      message: `Resync iniciado para ${orders.length} pedidos con inconsistencias. Revisá los logs.`,
      total_pedidos: orders.length
    });

    // 2. Procesar en background
    let exitosos = 0;
    let fallidos = 0;

    for (const { order_number, tn_order_id } of orders) {
      try {
        const pedidoRes = await callTiendanube({
          method: 'get',
          url: `https://api.tiendanube.com/v1/${storeId}/orders/${tn_order_id}`,
          headers: {
            authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
            'User-Agent': 'bpm-validator'
          },
          timeout: 10000
        });

        const pedido = pedidoRes.data;
        await guardarProductos(order_number, pedido.products || []);

        // Marcar inconsistencias como resueltas
        await pool.query(`
          UPDATE order_inconsistencies
          SET resolved = TRUE, resolved_at = NOW()
          WHERE order_number = $1 AND resolved = FALSE
        `, [order_number]);

        exitosos++;
        console.log(`✅ Resync #${order_number} OK (${exitosos}/${orders.length})`);

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (err) {
        fallidos++;
        console.error(`❌ Resync #${order_number} error:`, err.message);
      }
    }

    console.log(`🏁 Resync completado: ${exitosos} OK, ${fallidos} errores`);

  } catch (error) {
    console.error('❌ /admin/resync-inconsistent-orders error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});


/* =====================================================
   POST — BACKFILL FINANCIERAS EN COMPROBANTES
   Detecta financiera desde OCR para comprobantes sin asignar
===================================================== */
app.post('/admin/backfill-financieras', authenticate, requirePermission('users.view'), async (req, res) => {
  try {
    // 1. Obtener comprobantes sin financiera pero con texto OCR
    const comprobantesRes = await pool.query(`
      SELECT id, texto_ocr
      FROM comprobantes
      WHERE financiera_id IS NULL
        AND texto_ocr IS NOT NULL
        AND texto_ocr != ''
    `);

    const comprobantes = comprobantesRes.rows;
    console.log(`🔄 Backfill: ${comprobantes.length} comprobantes sin financiera`);

    if (comprobantes.length === 0) {
      return res.json({
        message: 'No hay comprobantes pendientes de asignar',
        total: 0,
        assigned: 0
      });
    }

    let assigned = 0;
    let skipped = 0;
    const details = [];

    for (const comp of comprobantes) {
      const detection = await detectarFinancieraDesdeOCR(comp.texto_ocr);

      if (detection) {
        await pool.query(
          'UPDATE comprobantes SET financiera_id = $1 WHERE id = $2',
          [detection.financieraId, comp.id]
        );
        assigned++;
        details.push({
          id: comp.id,
          financiera: detection.nombre,
          keyword: detection.keyword
        });
        console.log(`✅ Comprobante #${comp.id} → ${detection.nombre} (keyword: "${detection.keyword}")`);
      } else {
        skipped++;
      }
    }

    console.log(`🏁 Backfill completado: ${assigned} asignados, ${skipped} sin match`);

    res.json({
      message: 'Backfill completado',
      total: comprobantes.length,
      assigned,
      skipped,
      details
    });

  } catch (error) {
    console.error('❌ /admin/backfill-financieras error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — RESYNC MASIVO DE TODOS LOS PEDIDOS
===================================================== */
app.post('/admin/resync-all-orders', authenticate, requirePermission('users.view'), async (req, res) => {
  try {
    // Check de integración habilitada
    const resyncEnabled = await tnConfig.isResyncManualEnabled();
    if (!resyncEnabled) {
      return res.status(503).json({ error: 'Resync manual está deshabilitado temporalmente' });
    }
    const bulkEnabled = await isIntegrationEnabled('tiendanube_resync_bulk', { context: 'resync-bulk' });
    if (!bulkEnabled) {
      return res.status(503).json({ error: 'Resync masivo está deshabilitado' });
    }

    const storeId = process.env.TIENDANUBE_STORE_ID;

    // 1. Obtener todos los pedidos con tn_order_id
    const ordersRes = await pool.query(`
      SELECT order_number, tn_order_id
      FROM orders_validated
      WHERE tn_order_id IS NOT NULL
      ORDER BY created_at DESC
    `);

    const orders = ordersRes.rows;
    console.log(`🔄 Iniciando resync masivo de ${orders.length} pedidos...`);

    // Responder inmediatamente para evitar timeout
    res.json({
      ok: true,
      message: `Resync iniciado para ${orders.length} pedidos. Revisá los logs de Cloud Run para ver el progreso.`,
      total_pedidos: orders.length
    });

    // 2. Procesar en background
    let exitosos = 0;
    let fallidos = 0;
    const errores = [];

    for (let i = 0; i < orders.length; i++) {
      const { order_number, tn_order_id } = orders[i];

      try {
        // Obtener pedido de TiendaNube
        const pedidoRes = await callTiendanube({
          method: 'get',
          url: `https://api.tiendanube.com/v1/${storeId}/orders/${tn_order_id}`,
          headers: {
            authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
            'User-Agent': 'bpm-validator'
          },
          timeout: 10000
        });

        const pedido = pedidoRes.data;

        // Sincronizar productos (UPSERT + DELETE de removidos)
        await guardarProductos(order_number, pedido.products || []);

        // Resolver inconsistencias
        await pool.query(`
          UPDATE order_inconsistencies
          SET resolved = TRUE, resolved_at = NOW()
          WHERE order_number = $1 AND resolved = FALSE
        `, [order_number]);

        exitosos++;

        // Log progreso cada 50 pedidos
        if ((i + 1) % 50 === 0) {
          console.log(`📊 Progreso: ${i + 1}/${orders.length} (${exitosos} OK, ${fallidos} errores)`);
        }

        // Delay para respetar rate limit (200ms = 300 req/min)
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (err) {
        fallidos++;
        errores.push({ order_number, error: err.message });
      }
    }

    console.log(`✅ Resync masivo completado: ${exitosos} exitosos, ${fallidos} fallidos`);
    if (errores.length > 0) {
      console.log('❌ Errores:', errores.slice(0, 10)); // Solo los primeros 10
    }

  } catch (error) {
    console.error('❌ /admin/resync-all-orders error:', error.message);
    // Si ya respondimos, solo loguear
  }
});


/* =====================================================
   POST — RESYNC ESTADOS DESDE TIENDANUBE
   Compara estados de TN vs BPM y corrige desvíos.
   Respeta toggles: solo sincroniza categorías habilitadas.
   Puede ejecutarse manualmente o via cron.
===================================================== */
app.post('/admin/resync-estados', authenticate, requirePermission('users.view'), async (req, res) => {
  try {
    const resyncEnabled = await tnConfig.isResyncManualEnabled();
    if (!resyncEnabled) {
      return res.status(503).json({ error: 'Resync manual está deshabilitado' });
    }

    const storeId = process.env.TIENDANUBE_STORE_ID;
    const [syncPayment, syncShipping] = await Promise.all([
      isIntegrationEnabled('tiendanube_webhook_sync_payment', { context: 'resync-estados:payment' }),
      isIntegrationEnabled('tiendanube_webhook_sync_shipping', { context: 'resync-estados:shipping' }),
    ]);

    // Obtener pedidos no cancelados con tn_order_id
    const ordersRes = await pool.query(`
      SELECT order_number, tn_order_id, tn_payment_status, tn_shipping_status,
             estado_pago, estado_pedido, monto_tiendanube, shipping_type
      FROM orders_validated
      WHERE tn_order_id IS NOT NULL AND estado_pedido != 'cancelado'
      ORDER BY created_at DESC
    `);

    const total = ordersRes.rows.length;
    console.log(`🔄 Resync estados: ${total} pedidos, toggles: payment=${syncPayment}, shipping=${syncShipping}`);

    res.json({ ok: true, message: `Resync estados iniciado para ${total} pedidos`, total });

    let corregidos = 0, errores = 0, sinCambios = 0;

    for (let i = 0; i < ordersRes.rows.length; i++) {
      const db = ordersRes.rows[i];
      try {
        const pedidoRes = await callTiendanube({
          method: 'get',
          url: `https://api.tiendanube.com/v1/${storeId}/orders/${db.tn_order_id}`,
          headers: { authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`, 'User-Agent': 'bpm-resync' },
          timeout: 10000
        });
        const tn = pedidoRes.data;

        const setClauses = ['updated_at = NOW()'];
        const setParams = [];
        let paramIdx = 2;
        let cambios = [];

        // Cancelado en TN
        if (tn.status === 'cancelled' && db.estado_pedido !== 'cancelado') {
          setClauses.push(`estado_pedido = 'cancelado'`);
          cambios.push('cancelado');
        }

        // Payment sync (si toggle ON)
        if (syncPayment && tn.payment_status !== db.tn_payment_status) {
          setClauses.push(`tn_payment_status = $${paramIdx++}`);
          setParams.push(tn.payment_status);
          setClauses.push(`tn_paid_at = $${paramIdx++}`);
          setParams.push(tn.paid_at || null);
          const tnTotalPaid = Math.round(Number(tn.total_paid || 0));
          setClauses.push(`tn_total_paid = $${paramIdx++}`);
          setParams.push(tnTotalPaid);
          setClauses.push(`tn_gateway = $${paramIdx++}`);
          setParams.push(tn.gateway || null);

          if (tn.payment_status === 'paid') {
            const pagoOnline = tnTotalPaid > 0 ? tnTotalPaid : Math.round(Number(tn.total));
            setClauses.push(`pago_online_tn = $${paramIdx++}`);
            setParams.push(pagoOnline);
          } else if (tn.payment_status === 'partially_paid') {
            setClauses.push(`pago_online_tn = $${paramIdx++}`);
            setParams.push(tnTotalPaid);
          } else if (tn.payment_status === 'refunded') {
            setClauses.push(`estado_pago = 'reembolsado'`);
            setClauses.push(`pago_online_tn = 0`);
          } else if (tn.payment_status === 'voided') {
            setClauses.push(`estado_pago = 'anulado'`);
            setClauses.push(`pago_online_tn = 0`);
          } else if (tn.payment_status === 'partially_refunded') {
            setClauses.push(`pago_online_tn = $${paramIdx++}`);
            setParams.push(tnTotalPaid);
          } else if (tn.payment_status === 'pending') {
            setClauses.push(`pago_online_tn = 0`);
          }
          cambios.push(`pago: ${db.tn_payment_status} → ${tn.payment_status}`);
        }

        // Shipping sync (si toggle ON y no cancelado)
        const tnShipStatus = tn.shipping_status || null;
        const tnShipCarrier = tn.shipping || null;
        const tnFulfillStatus = tn.fulfillments?.[0]?.status || null;
        // Solo comparar shipping_status real (no carrier) — y solo si realmente cambió
        if (syncShipping && tn.status !== 'cancelled' && (tnShipStatus !== db.tn_shipping_status || (tnFulfillStatus && tnFulfillStatus !== 'UNPACKED'))) {
          setClauses.push(`tn_shipping_status = $${paramIdx++}`);
          setParams.push(tnShipStatus);

          const nuevoEstado = mapShippingToEstadoPedido(tnShipStatus, tnShipCarrier, db.shipping_type || '', db.estado_pedido, { fulfillmentStatus: tnFulfillStatus });
          if (nuevoEstado) {
            setClauses.push(`estado_pedido = $${paramIdx++}`);
            setParams.push(nuevoEstado);
            if (['enviado', 'en_calle', 'retirado'].includes(nuevoEstado)) {
              setClauses.push(`shipped_at = COALESCE(shipped_at, NOW())`);
            }
            if (nuevoEstado === 'armado') {
              setClauses.push(`packed_at = COALESCE(packed_at, NOW())`);
            }
            cambios.push(`envío: ${db.tn_shipping_status} → ${tnShipStatus} (estado: ${nuevoEstado})`);
          } else {
            cambios.push(`envío TN: ${db.tn_shipping_status} → ${tnShipStatus}`);
          }
        }

        if (setClauses.length > 1) {
          await pool.query(
            `UPDATE orders_validated SET ${setClauses.join(', ')} WHERE order_number = $1`,
            [db.order_number, ...setParams]
          );
          // Recalcular pagos si hubo cambio de payment
          if (syncPayment && tn.payment_status !== db.tn_payment_status) {
            await recalcularPagos(pool, db.order_number);
          }
          await logEvento({ orderNumber: db.order_number, accion: `Resync: ${cambios.join(', ')}`, origen: 'resync_estados' });
          corregidos++;
        } else {
          sinCambios++;
        }

        if ((i + 1) % 100 === 0) {
          console.log(`📊 Resync: ${i + 1}/${total} (${corregidos} corregidos, ${sinCambios} OK, ${errores} errores)`);
        }
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        errores++;
      }
    }

    console.log(`✅ Resync estados completado: ${corregidos} corregidos, ${sinCambios} sin cambios, ${errores} errores`);
  } catch (error) {
    console.error('❌ /admin/resync-estados error:', error.message);
  }
});


/* =====================================================
   POST — SYNC PEDIDOS CANCELADOS (RÁPIDO)
   Solo sincroniza el estado cancelado, no productos
   Approach: verificar nuestros pedidos contra TiendaNube
===================================================== */
app.post('/admin/sync-cancelled', authenticate, requirePermission('users.view'), async (req, res) => {
  // Check de integración habilitada
  const syncCancelledEnabled = await tnConfig.isSyncCancelledEnabled();
  if (!syncCancelledEnabled) {
    return res.status(503).json({ error: 'Sync de cancelados está deshabilitado temporalmente' });
  }

  const storeId = process.env.TIENDANUBE_STORE_ID;
  const accessToken = process.env.TIENDANUBE_ACCESS_TOKEN;

  console.log('🔄 Iniciando sync de pedidos cancelados...');

  // Responder inmediatamente
  res.json({
    ok: true,
    message: 'Sync de cancelados iniciado. Revisá los logs de Cloud Run para ver el progreso.'
  });

  // Procesar en background
  try {
    // 1. Obtener nuestros pedidos que NO están cancelados y tienen tn_order_id
    const dbResult = await pool.query(`
      SELECT order_number, tn_order_id
      FROM orders_validated
      WHERE estado_pedido != 'cancelado'
        AND tn_order_id IS NOT NULL
      ORDER BY created_at DESC
    `);

    const ourOrders = dbResult.rows;
    console.log(`📋 Pedidos en nuestra DB (no cancelados): ${ourOrders.length}`);

    if (ourOrders.length === 0) {
      console.log('✅ No hay pedidos para verificar');
      return;
    }

    // 2. Verificar cada pedido en TiendaNube (en batches para no saturar)
    const toUpdate = [];
    let checked = 0;

    for (const { order_number, tn_order_id } of ourOrders) {
      try {
        const tnResponse = await callTiendanube({
          method: 'get',
          url: `https://api.tiendanube.com/v1/${storeId}/orders/${tn_order_id}`,
          headers: {
            authentication: `bearer ${accessToken}`,
            'User-Agent': 'bpm-validator'
          },
          timeout: 10000
        });

        if (tnResponse.data.status === 'cancelled') {
          toUpdate.push(order_number);
          console.log(`   🚫 #${order_number} está cancelado en TN`);
        }

        checked++;
        if (checked % 50 === 0) {
          console.log(`   Verificados: ${checked}/${ourOrders.length}`);
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 200));

      } catch (err) {
        // Si es 404, el pedido fue eliminado - lo marcamos como cancelado
        if (err.response?.status === 404) {
          toUpdate.push(order_number);
          console.log(`   ❓ #${order_number} no existe en TN (404) - marcar cancelado`);
        }
        // Otros errores los ignoramos
      }
    }

    console.log(`🔍 Pedidos a actualizar: ${toUpdate.length}`);

    if (toUpdate.length === 0) {
      console.log('✅ Todos los pedidos ya están sincronizados');
      return;
    }

    // 3. Actualizar en batch
    const updateResult = await pool.query(`
      UPDATE orders_validated
      SET estado_pedido = 'cancelado'
      WHERE order_number = ANY($1)
      RETURNING order_number
    `, [toUpdate]);

    // 4. Log de cada actualización
    for (const row of updateResult.rows) {
      await logEvento({
        orderNumber: row.order_number,
        accion: 'pedido_cancelado (sync)',
        origen: 'admin_sync'
      });
    }

    console.log(`✅ Sync completado: ${updateResult.rowCount} pedidos actualizados`);
    console.log(`   Pedidos: ${updateResult.rows.map(r => r.order_number).join(', ')}`);

  } catch (error) {
    console.error('❌ /admin/sync-cancelled error:', error.message);
  }
});


/* =====================================================
   PATCH — ACTUALIZAR ESTADO DE PEDIDO
===================================================== */
app.patch('/orders/:orderNumber/status', authenticate, requirePermission('orders.update_status'), async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { estado_pedido } = req.body;

    // Validar estado_pedido
    const estadosValidos = ['pendiente_pago', 'a_imprimir', 'hoja_impresa', 'armado', 'retirado', 'en_calle', 'enviado', 'cancelado'];
    if (!estado_pedido || !estadosValidos.includes(estado_pedido)) {
      return res.status(400).json({
        error: `Estado inválido. Valores permitidos: ${estadosValidos.join(', ')}`
      });
    }

    // Verificar que existe el pedido
    const orderRes = await pool.query(
      `SELECT order_number, estado_pago, estado_pedido, tn_order_id, tn_order_token,
              customer_name, customer_phone, shipping_type
       FROM orders_validated WHERE order_number = $1`,
      [orderNumber]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const pedido = orderRes.rows[0];

    // Validar reglas de negocio
    // No se puede enviar (enviado, en_calle) si el pago no es total
    if (['enviado', 'en_calle'].includes(estado_pedido)) {
      if (pedido.estado_pago !== 'confirmado_total' && pedido.estado_pago !== 'a_favor') {
        return res.status(400).json({
          error: 'No se puede enviar un pedido sin pago completo'
        });
      }
    }

    // Determinar timestamps según el estado
    let updateFields = ['estado_pedido = $1'];
    let updateValues = [estado_pedido];
    let paramIndex = 2;

    if (estado_pedido === 'hoja_impresa' && !pedido.printed_at) {
      // Cuando se imprime la etiqueta, marcamos printed_at
      updateFields.push(`printed_at = NOW()`);
    } else if (estado_pedido === 'armado' && !pedido.packed_at) {
      updateFields.push(`packed_at = NOW()`);
    } else if (['enviado', 'en_calle', 'retirado'].includes(estado_pedido) && !pedido.shipped_at) {
      updateFields.push(`shipped_at = NOW()`);
    }

    // Actualizar
    await pool.query(
      `UPDATE orders_validated SET ${updateFields.join(', ')} WHERE order_number = $${paramIndex}`,
      [...updateValues, orderNumber]
    );

    // Log del evento
    const accionesEstado = {
      'hoja_impresa': 'hoja_impresa',
      'armado': 'pedido_armado',
      'retirado': 'pedido_retirado',
      'en_calle': 'pedido_en_calle',
      'enviado': 'pedido_enviado',
      'cancelado': 'pedido_cancelado'
    };
    const accionLog = accionesEstado[estado_pedido] || `estado_${estado_pedido}`;

    await logEvento({
      orderNumber,
      accion: accionLog,
      origen: 'logistica',
      userId: req.user?.id,
      username: req.user?.name
    });

    console.log(`📦 Estado de pedido ${orderNumber} actualizado a: ${estado_pedido}`);

    // WhatsApp automático cuando se marca como "enviado" con Envío Nube
    if (estado_pedido === 'enviado') {
      const shippingType = (pedido.shipping_type || '').toLowerCase();
      const esEnvioNube = shippingType.includes('envío nube') || shippingType.includes('envio nube');

      if (esEnvioNube && pedido.customer_phone && pedido.tn_order_id && pedido.tn_order_token) {
        const trackingParam = `${pedido.tn_order_id}/${pedido.tn_order_token}`;
        try {
          await queueWhatsApp({
            telefono: pedido.customer_phone,
            plantilla: 'enviado_env_nube',
            variables: {
              '1': pedido.customer_name || 'Cliente',
              '2': orderNumber,
              '3': trackingParam
            },
            orderNumber
          });
        } catch (waErr) {
          log.error({ err: waErr.message, orderNumber, plantilla: 'enviado_env_nube' }, 'Error encolando WhatsApp');
        }
      } else if (esEnvioNube) {
        console.log(`⚠️ No se envió WhatsApp enviado_env_nube: faltan datos (phone: ${!!pedido.customer_phone}, order_id: ${!!pedido.tn_order_id}, token: ${!!pedido.tn_order_token})`);
      }
      // Nota: enviado_transporte se envía desde remitos.js al confirmar remito (con imagen)
    }

    // WhatsApp automático cuando se marca como "cancelado"
    if (estado_pedido === 'cancelado' && pedido.customer_phone) {
      const tnPath = pedido.tn_order_id && pedido.tn_order_token
        ? `${pedido.tn_order_id}/${pedido.tn_order_token}`
        : orderNumber;
      try {
        await queueWhatsApp({
          telefono: pedido.customer_phone,
          plantilla: 'pedido_cancelado',
          variables: {
            '1': pedido.customer_name || 'Cliente',
            '2': orderNumber,
            '3': tnPath
          },
          orderNumber
        });
      } catch (waErr) {
        log.error({ err: waErr.message, orderNumber, plantilla: 'pedido_cancelado' }, 'Error encolando WhatsApp');
      }
    }

    // Sincronizar estado hacia Tiendanube (async, no bloquea respuesta)
    if (pedido.tn_order_id) {
      syncEstadoToTN(pedido.tn_order_id, orderNumber, estado_pedido);
    }

    // Obtener pedido actualizado
    const updatedRes = await pool.query(
      `SELECT order_number, estado_pedido, estado_pago, printed_at, packed_at, shipped_at
       FROM orders_validated WHERE order_number = $1`,
      [orderNumber]
    );

    res.json({
      ok: true,
      order: updatedRes.rows[0]
    });

  } catch (error) {
    console.error('❌ /orders/:orderNumber/status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


function verifyTiendaNubeSignature(req) {
  const received = req.headers['x-linkedstore-hmac-sha256'];

  // Si no existe el header, rechazar
  if (!received) return false;

  const secret = process.env.TIENDANUBE_CLIENT_SECRET;
  if (!secret) return false;

  const computed = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  // Si largos no coinciden, rechazar (evita crash de timingSafeEqual)
  if (received.length !== computed.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(received),
    Buffer.from(computed)
  );
}


// ===========================================
// WEBHOOK: Botmaker Message Status
// ===========================================
// GET para validación de Botmaker
app.get('/webhook/botmaker-status', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Webhook endpoint ready' });
});

app.post('/webhook/botmaker-status', async (req, res) => {
  try {
    const authToken = req.headers['auth-bm-token'];
    const expectedToken = process.env.BOTMAKER_WEBHOOK_SECRET;

    // Validar token - requerido siempre
    if (!expectedToken) {
      log.error('Botmaker webhook: BOTMAKER_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    if (authToken !== expectedToken) {
      log.warn('Botmaker webhook: invalid token');
      return res.status(401).send('Invalid token');
    }

    const payload = req.body;

    // Solo loguear si es un status (no mensajes de usuario)
    if (payload.type === 'status') {
      log.info({ payload }, 'Botmaker status webhook received');
    }

    // Extraer datos relevantes
    const {
      type,
      status,
      contactId,
      messageId,
      intentTxId
    } = payload;

    // Solo procesar webhooks de tipo status
    if (type !== 'status') {
      return res.status(200).json({ received: true, ignored: true });
    }

    // Actualizar estado en whatsapp_messages si tenemos intentTxId
    if (intentTxId) {
      const isSuccess = status === 'delivered' || status === 'read' || status === 'sent';
      const isFailed = status === 'failed' || status === 'error';

      if (isSuccess) {
        await pool.query(`
          UPDATE whatsapp_messages
          SET status = $1, status_updated_at = NOW()
          WHERE request_id = $2
        `, [status, intentTxId]);
        log.info({ status, intentTxId }, 'WhatsApp status updated');
      } else if (isFailed) {
        // Obtener mensaje para posible retry
        const msgResult = await pool.query(`
          SELECT * FROM whatsapp_messages WHERE request_id = $1
        `, [intentTxId]);

        if (msgResult.rows.length > 0) {
          const msg = msgResult.rows[0];
          const errorMsg = payload.error || payload.reason || 'Unknown error';

          // Actualizar como fallido
          await pool.query(`
            UPDATE whatsapp_messages
            SET status = 'failed', status_updated_at = NOW(), error_message = $1
            WHERE request_id = $2
          `, [errorMsg, intentTxId]);

          log.error({ intentTxId, errorMsg, contactId }, 'WhatsApp delivery failed');

          // Loguear el fallo
          await pool.query(`
            INSERT INTO logs (order_number, accion, detalle, created_at)
            VALUES ($1, $2, $3, NOW())
          `, [
            msg.order_number || 0,
            'whatsapp_failed',
            JSON.stringify({ template: msg.template, contactId, error: errorMsg, intentTxId })
          ]);

          // No retry automático - el mensaje podría haberse entregado
          // Los fallos quedan logueados para revisión manual en tabla logs
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    log.error({ err: error }, 'Error in Botmaker webhook');
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook/tiendanube', async (req, res) => {
  // 0️⃣ Check de integración habilitada
  const webhooksEnabled = await tnConfig.areWebhooksEnabled();
  if (!webhooksEnabled) {
    // Responder 200 para que TN no reintente, pero no procesar
    log.info('Webhook Tiendanube ignored - integration disabled');
    return res.status(200).json({ ok: true, ignored: true, reason: 'integration_disabled' });
  }

  // 1️⃣ Validación de firma
  if (!verifyTiendaNubeSignature(req)) {
    log.warn('Tiendanube webhook: invalid signature');
    return res.status(401).send('Invalid signature');
  }

  const { event, store_id, id: orderId } = req.body;

  log.info({ event, orderId, store_id }, 'Tiendanube webhook received');

  // 2️⃣ Registro durable ANTES de responder 200
  // Si el procesamiento falla después, el polling lo recupera
  let queueId = null;
  try {
    const qResult = await pool.query(`
      INSERT INTO sync_queue (type, resource_id, order_number, payload, status, max_attempts)
      VALUES ($1, $2, NULL, $3, 'pending', 5)
      ON CONFLICT (type, resource_id, status) DO NOTHING
      RETURNING id
    `, [
      event.replace('/', '_'),
      String(orderId),
      JSON.stringify({ orderId, event, store_id, received_at: new Date().toISOString() })
    ]);
    if (!qResult.rows[0]) {
      log.info({ event, orderId }, 'Webhook already enqueued, skipping');
      return res.status(200).json({ ok: true, skipped: true, reason: 'already_enqueued' });
    }
    queueId = qResult.rows[0].id;
  } catch (qErr) {
    // 23505 = unique_violation - backup por race conditions extremas
    if (qErr.code === '23505') {
      log.info({ event, orderId }, 'Webhook already enqueued (catch), skipping');
      return res.status(200).json({ ok: true, skipped: true, reason: 'already_enqueued' });
    } else {
      log.error({ err: qErr, event, orderId }, 'Error enqueuing webhook');
    }
  }

  // 3️⃣ Respuesta inmediata
  res.status(200).json({ ok: true });

  // 4️⃣ Procesar async
  try {

    // 📛 order/cancelled - Marcar pedido como cancelado
    if (event === 'order/cancelled') {
      const cancelEnabled = await isIntegrationEnabled('tiendanube_webhook_order_cancelled', { context: 'webhook:order/cancelled' });
      if (!cancelEnabled) {
        log.info({ event, orderId }, 'Webhook order/cancelled disabled by sub-toggle');
        return;
      }
      // Buscar el número de pedido desde TiendaNube
      const pedido = await obtenerPedidoPorId(store_id, orderId);
      const orderNumber = pedido?.number ? String(pedido.number) : null;

      log.info({ event: 'order/cancelled', store_id, orderId, orderNumber }, 'Order cancelled via webhook');

      if (orderNumber) {
        // Actualizar estado en DB + campos TN del pedido cancelado
        const cancelPaymentStatus = pedido.payment_status || null;
        const cancelUpdateFields = ['estado_pedido = \'cancelado\''];
        const cancelParams = [orderNumber];
        let cancelIdx = 2;
        if (cancelPaymentStatus) {
          cancelUpdateFields.push(`tn_payment_status = $${cancelIdx++}`);
          cancelParams.push(cancelPaymentStatus);
        }
        if (cancelPaymentStatus === 'refunded') {
          cancelUpdateFields.push(`estado_pago = 'reembolsado'`);
          cancelUpdateFields.push(`pago_online_tn = 0`);
        } else if (cancelPaymentStatus === 'voided') {
          cancelUpdateFields.push(`estado_pago = 'anulado'`);
          cancelUpdateFields.push(`pago_online_tn = 0`);
        } else if (cancelPaymentStatus === 'pending' || !cancelPaymentStatus) {
          // Pedido cancelado sin pago → anular para no esperar pago que nunca llegará
          cancelUpdateFields.push(`estado_pago = 'anulado'`);
        }
        await pool.query(
          `UPDATE orders_validated SET ${cancelUpdateFields.join(', ')} WHERE order_number = $1`,
          cancelParams
        );

        // Recalcular pagos si cambió el estado de pago
        if (cancelPaymentStatus === 'refunded' || cancelPaymentStatus === 'voided' || cancelPaymentStatus === 'pending' || !cancelPaymentStatus) {
          await recalcularPagos(pool, orderNumber);
        }

        // Registrar en log de actividad
        await logEvento({
          orderNumber,
          accion: 'pedido_cancelado',
          origen: 'webhook_tiendanube'
        });

        // WhatsApp al cliente - pedido_cancelado
        const clienteCancelRes = await pool.query(
          `SELECT customer_name, customer_phone, tn_order_id, tn_order_token FROM orders_validated WHERE order_number = $1`,
          [orderNumber]
        );
        const clienteCancel = clienteCancelRes.rows[0];
        if (clienteCancel?.customer_phone) {
          const tnPathCancel = clienteCancel.tn_order_id && clienteCancel.tn_order_token
            ? `${clienteCancel.tn_order_id}/${clienteCancel.tn_order_token}`
            : orderNumber;
          try {
            await queueWhatsApp({
              telefono: clienteCancel.customer_phone,
              plantilla: 'pedido_cancelado',
              variables: {
                '1': clienteCancel.customer_name || 'Cliente',
                '2': orderNumber,
                '3': tnPathCancel
              },
              orderNumber
            });
          } catch (waErr) {
            log.error({ err: waErr.message, orderNumber, plantilla: 'pedido_cancelado' }, 'Error encolando WhatsApp');
          }
        }

        log.info({ orderNumber, orderId }, 'Order marked as cancelled in DB');
      }
      return;
    }

    // Procesar order/created, order/updated, order/paid, order/fulfilled
    const updatedEvents = ['order/updated', 'order/paid', 'order/fulfilled'];
    if (event !== 'order/created' && !updatedEvents.includes(event)) return;

    // Check sub-toggle por evento (paid/fulfilled usan el toggle de updated)
    const eventSubKey = event === 'order/created' ? 'tiendanube_webhook_order_created' : 'tiendanube_webhook_order_updated';
    const eventEnabled = await isIntegrationEnabled(eventSubKey, { context: `webhook:${event}` });
    if (!eventEnabled) {
      log.info({ event, orderId }, `Webhook ${event} disabled by sub-toggle`);
      return;
    }

    // 3️⃣ Buscar pedido en Tiendanube
    const pedido = await obtenerPedidoPorId(store_id, orderId);

    if (!pedido) {
      log.warn({ orderId }, 'Order not found in Tiendanube');
      return;
    }

    // Validar que el pedido tenga number antes de procesar
    if (!pedido.number) {
      log.warn({ orderId }, 'Webhook received without order number, ignoring');
      return;
    }

    // 4️⃣ Procesar según el evento
    if (updatedEvents.includes(event)) {
      // Verificar si existe en nuestra DB
      const existente = await pool.query(
        `SELECT order_number, monto_tiendanube, total_pagado, estado_pago, estado_pedido,
                tn_payment_status, tn_shipping_status, tn_paid_at, tn_total_paid, tn_gateway,
                shipping_type
         FROM orders_validated WHERE order_number = $1`,
        [String(pedido.number)]
      );

      if (existente.rowCount === 0) {
        log.warn({ orderNumber: pedido.number, orderId }, 'order/updated for non-existent order in DB, ignoring');
        return;
      }

      const db = existente.rows[0];

      // Si el pedido está cancelado en BPM, verificar si TN lo reabrió
      if (db.estado_pedido === 'cancelado') {
        if (pedido.status === 'cancelled') {
          // TN también dice cancelado → skip (evita falsos logs de pago/address junto con cancelación)
          log.info({ orderNumber: String(pedido.number), tnStatus: pedido.status }, 'order/updated skipped — order cancelled in both BPM and TN');
          return;
        }
        // TN ya no dice cancelado → reabrir el pedido
        log.info({ orderNumber: String(pedido.number), tnStatus: pedido.status }, 'Reopening cancelled order — TN no longer cancelled');
        await pool.query(
          `UPDATE orders_validated SET estado_pedido = 'a_imprimir', updated_at = NOW() WHERE order_number = $1`,
          [String(pedido.number)]
        );
        await logEvento({ orderNumber: String(pedido.number), accion: 'Pedido reabierto desde TN', origen: 'webhook_tiendanube' });
        db.estado_pedido = 'a_imprimir';
      }

      // Valores nuevos de Tiendanube
      const montoNuevo = Math.round(Number(pedido.total));
      const paymentStatusNuevo = pedido.payment_status || null;
      const shippingStatusNuevo = pedido.shipping_status || null;
      const shippingCarrier = pedido.shipping || null;
      const fulfillmentStatus = pedido.fulfillments?.[0]?.status || null;

      // Valores actuales en DB
      const montoAnterior = Number(db.monto_tiendanube);
      const paymentStatusAnterior = db.tn_payment_status;
      const shippingStatusAnterior = db.tn_shipping_status;

      // Granular toggles: qué tipos de cambios procesar
      const [syncPayment, syncShipping, syncProducts, syncCustomer, syncAddress, syncNotes, syncCosts, syncTracking] = await Promise.all([
        isIntegrationEnabled('tiendanube_webhook_sync_payment', { context: 'webhook:order/updated:payment' }),
        isIntegrationEnabled('tiendanube_webhook_sync_shipping', { context: 'webhook:order/updated:shipping' }),
        isIntegrationEnabled('tiendanube_webhook_sync_products', { context: 'webhook:order/updated:products' }),
        isIntegrationEnabled('tiendanube_webhook_sync_customer', { context: 'webhook:order/updated:customer' }),
        isIntegrationEnabled('tiendanube_webhook_sync_address', { context: 'webhook:order/updated:address' }),
        isIntegrationEnabled('tiendanube_webhook_sync_notes', { context: 'webhook:order/updated:notes' }),
        isIntegrationEnabled('tiendanube_webhook_sync_costs', { context: 'webhook:order/updated:costs' }),
        isIntegrationEnabled('tiendanube_webhook_sync_tracking', { context: 'webhook:order/updated:tracking' }),
      ]);

      // Datos actuales extendidos para detectar cambios
      const dbExtended = await pool.query(
        `SELECT customer_name, customer_email, customer_phone,
                shipping_address, note, owner_note, discount, shipping_cost,
                shipping_tracking
         FROM orders_validated WHERE order_number = $1`,
        [String(pedido.number)]
      );
      const dbExt = dbExtended.rows[0] || {};

      // Datos de pago de TN (campos reales, no solo payment_status)
      const tnTotalPaid = Math.round(Number(pedido.total_paid || 0));
      const tnPaidAt = pedido.paid_at || null;
      // Preferir gateway_name si es descriptivo, sino gateway
      const tnGateway = (pedido.gateway_name && pedido.gateway_name !== 'not-provided')
        ? pedido.gateway_name
        : (pedido.gateway && pedido.gateway !== 'not-provided' ? pedido.gateway : 'manual');
      const dbPaidAt = db.tn_paid_at || null;
      const dbTotalPaid = Number(db.tn_total_paid || 0);

      // Detectar qué cambió por categoría
      // Para pago: detectar cambio en payment_status O en paid_at O en total_paid
      const cambioPaymentStatus = paymentStatusAnterior !== paymentStatusNuevo;
      const cambioPaidAt = (dbPaidAt ? new Date(dbPaidAt).toISOString() : null) !== (tnPaidAt ? new Date(tnPaidAt).toISOString() : null);
      const cambioTotalPaid = dbTotalPaid !== tnTotalPaid;
      const cambioPayment = cambioPaymentStatus || cambioPaidAt || cambioTotalPaid;
      const cambioShipping = shippingStatusAnterior !== shippingStatusNuevo;
      const cambioMonto = montoAnterior !== montoNuevo;

      const customerNameNuevo = pedido.customer?.name || pedido.contact_name || null;
      const customerEmailNuevo = pedido.customer?.email || pedido.contact_email || null;
      const customerPhoneNuevo = pedido.contact_phone || pedido.customer?.phone || pedido.shipping_address?.phone || null;
      const cambioCustomer = (dbExt.customer_name !== customerNameNuevo) ||
                             (dbExt.customer_email !== customerEmailNuevo) ||
                             (dbExt.customer_phone !== customerPhoneNuevo);

      // Comparar address campo a campo (JSONB reordena keys alfabéticamente, JSON.stringify no sirve)
      const addressFields = ['name', 'address', 'number', 'floor', 'locality', 'city', 'province', 'zipcode', 'phone', 'between_streets', 'reference'];
      const dbAddr = dbExt.shipping_address || {};
      const tnAddr = pedido.shipping_address || {};
      const cambioAddress = pedido.shipping_address
        ? addressFields.some(f => (dbAddr[f] || null) !== (tnAddr[f] || null))
        : (dbExt.shipping_address !== null);
      // DEBUG: log qué campo difiere para diagnosticar falsos positivos
      if (cambioAddress && pedido.shipping_address) {
        const diffs = addressFields.filter(f => (dbAddr[f] || null) !== (tnAddr[f] || null));
        log.info({ orderNumber: String(pedido.number), addressDiffs: diffs, diffDetails: diffs.map(f => ({ field: f, db: dbAddr[f], tn: tnAddr[f], dbType: typeof dbAddr[f], tnType: typeof tnAddr[f] })) }, 'Address change detected — field diff');
      }
      const addressNuevo = pedido.shipping_address ? JSON.stringify({
        name: tnAddr.name, address: tnAddr.address, number: tnAddr.number,
        floor: tnAddr.floor, locality: tnAddr.locality, city: tnAddr.city,
        province: tnAddr.province, zipcode: tnAddr.zipcode, phone: tnAddr.phone,
        between_streets: tnAddr.between_streets, reference: tnAddr.reference,
      }) : null;

      const cambioNotes = (dbExt.note !== (pedido.note || null)) || (dbExt.owner_note !== (pedido.owner_note || null));
      const cambioCosts = (Number(dbExt.discount) !== (Number(pedido.discount) || 0)) ||
                          (Number(dbExt.shipping_cost) !== (Number(pedido.shipping_cost_customer) || 0));
      const cambioTracking = (dbExt.shipping_tracking || null) !== (pedido.shipping_tracking_number || null);

      // Obtener productos ANTES de actualizar
      const productosDB = await pool.query(
        `SELECT product_id, variant_id, name, quantity FROM order_products WHERE order_number = $1`,
        [String(pedido.number)]
      );

      const mensaje = buildOrderUpdateMessage(
        productosDB.rows,
        pedido.products || [],
        montoNuevo
      );

      const hayProductosCambiados = mensaje.productChanges.length > 0;

      // Mapa de cambios vs toggles
      const cambios = [
        { tipo: 'payment', cambio: cambioPayment, habilitado: syncPayment },
        { tipo: 'shipping', cambio: cambioShipping, habilitado: syncShipping },
        { tipo: 'products', cambio: cambioMonto || hayProductosCambiados, habilitado: syncProducts },
        { tipo: 'customer', cambio: cambioCustomer, habilitado: syncCustomer },
        { tipo: 'address', cambio: cambioAddress, habilitado: syncAddress },
        { tipo: 'notes', cambio: cambioNotes, habilitado: syncNotes },
        { tipo: 'costs', cambio: cambioCosts, habilitado: syncCosts },
        { tipo: 'tracking', cambio: cambioTracking, habilitado: syncTracking },
      ];

      const cambiosDetectados = cambios.filter(c => c.cambio);
      const cambiosPermitidos = cambiosDetectados.filter(c => c.habilitado);
      const cambiosBloqueados = cambiosDetectados.filter(c => !c.habilitado);

      if (cambiosDetectados.length === 0) {
        return; // Sin cambios relevantes
      }

      if (cambiosPermitidos.length === 0) {
        log.info({
          orderNumber: String(pedido.number),
          blocked: cambiosBloqueados.map(c => c.tipo),
        }, 'Order updated but all changes filtered by sub-toggles');
        return;
      }

      // Construir UPDATE selectivo — solo actualizar los campos permitidos
      const setClauses = ['updated_at = NOW()'];
      const setParams = [];
      let paramIdx = 2; // $1 = order_number

      if (syncPayment && cambioPayment) {
        setClauses.push(`tn_payment_status = $${paramIdx++}`);
        setParams.push(paymentStatusNuevo);
        setClauses.push(`tn_paid_at = $${paramIdx++}`);
        setParams.push(tnPaidAt);
        setClauses.push(`tn_total_paid = $${paramIdx++}`);
        setParams.push(tnTotalPaid);
        setClauses.push(`tn_gateway = $${paramIdx++}`);
        setParams.push(tnGateway);

        // Lógica de pago: escribir en pago_online_tn (NO en total_pagado)
        // total_pagado se recalcula después con recalcularPagos()
        if (paymentStatusNuevo === 'refunded') {
          setClauses.push(`estado_pago = 'reembolsado'`);
          setClauses.push(`pago_online_tn = 0`);
        } else if (paymentStatusNuevo === 'voided') {
          setClauses.push(`estado_pago = 'anulado'`);
          setClauses.push(`pago_online_tn = 0`);
        } else if (paymentStatusNuevo === 'partially_refunded') {
          // Reembolso parcial: total_paid de TN refleja lo que queda pagado
          setClauses.push(`pago_online_tn = $${paramIdx++}`);
          setParams.push(tnTotalPaid);
        } else if (paymentStatusNuevo === 'paid' || paymentStatusNuevo === 'partially_paid') {
          // Actualizar pago_online_tn solo si hubo un pago real:
          // - payment_status cambió (pending→paid), o
          // - paid_at cambió (pago adicional con gateway que trackea), o
          // - evento es order/paid (TN confirma pago, aunque campos no cambien)
          // NO actualizar en order/updated sin pago (es un edit de monto, no un pago)
          // IMPORTANTE: NO actualizar si el pedido ya está confirmado_total por pagos locales
          // (evita duplicar cuando nosotros marcamos pagado en TN y TN envía webhook de vuelta)
          const yaConfirmadoLocal = db.estado_pago === 'confirmado_total' && Number(db.total_pagado) >= Number(db.monto_tiendanube);

          // ANTI-DUPLICACIÓN: Verificar si ya hay comprobantes confirmados por monto similar
          // (previene race condition cuando operador confirma y webhook llega casi simultáneo)
          let tieneComprobantesSimilares = false;
          if (tnTotalPaid > 0) {
            const compCheck = await pool.query(`
              SELECT COALESCE(SUM(monto), 0) as total_comp
              FROM comprobantes
              WHERE order_number = $1 AND estado = 'confirmado'
            `, [String(pedido.number)]);
            const totalComp = Number(compCheck.rows[0]?.total_comp || 0);
            // Si comprobantes confirmados ≈ pago de TN (tolerancia 5%), es el mismo pago
            if (totalComp > 0) {
              const diff = Math.abs(totalComp - tnTotalPaid);
              const pctDiff = diff / Math.max(totalComp, tnTotalPaid);
              tieneComprobantesSimilares = pctDiff < 0.05;
              if (tieneComprobantesSimilares) {
                log.info({ orderNumber: String(pedido.number), tnTotalPaid, totalComp, pctDiff },
                  'Skipping pago_online_tn — comprobantes confirmados ya cubren este monto');
              }
            }
          }

          if ((cambioPaymentStatus || cambioPaidAt || event === 'order/paid') && !yaConfirmadoLocal && !tieneComprobantesSimilares) {
            let pagoOnline = 0;
            if (paymentStatusNuevo === 'partially_paid' && tnTotalPaid > 0) {
              pagoOnline = tnTotalPaid;
            } else if (paymentStatusNuevo === 'paid') {
              pagoOnline = tnTotalPaid > 0 ? tnTotalPaid : montoAnterior;
            }
            setClauses.push(`pago_online_tn = $${paramIdx++}`);
            setParams.push(pagoOnline);
          } else if (yaConfirmadoLocal) {
            log.info({ orderNumber: String(pedido.number), estadoPago: db.estado_pago }, 'Skipping pago_online_tn update — order already paid locally');
          }
        }
      }
      let shippingDerivedEstado = null;
      if (syncShipping && cambioShipping) {
        setClauses.push(`tn_shipping_status = $${paramIdx++}`);
        setParams.push(shippingStatusNuevo);

        shippingDerivedEstado = mapShippingToEstadoPedido(
          shippingStatusNuevo,
          shippingCarrier,
          db.shipping_type || '',
          db.estado_pedido,
          { fulfillmentStatus }
        );
        if (shippingDerivedEstado) {
          setClauses.push(`estado_pedido = $${paramIdx++}`);
          setParams.push(shippingDerivedEstado);
          if (['enviado', 'en_calle', 'retirado'].includes(shippingDerivedEstado)) {
            setClauses.push(`shipped_at = COALESCE(shipped_at, NOW())`);
          }
          if (shippingDerivedEstado === 'armado') {
            setClauses.push(`packed_at = COALESCE(packed_at, NOW())`);
          }
        }
      }
      if (syncProducts && (cambioMonto || hayProductosCambiados)) {
        setClauses.push(`monto_tiendanube = $${paramIdx++}`);
        setParams.push(montoNuevo);
        setClauses.push(`subtotal = $${paramIdx++}`);
        setParams.push(Number(pedido.subtotal) || 0);
        // Also update products
        await guardarProductos(String(pedido.number), pedido.products);
      }
      if (syncCustomer && cambioCustomer) {
        if (customerNameNuevo) { setClauses.push(`customer_name = $${paramIdx++}`); setParams.push(customerNameNuevo); }
        if (customerEmailNuevo) { setClauses.push(`customer_email = $${paramIdx++}`); setParams.push(customerEmailNuevo); }
        if (customerPhoneNuevo) { setClauses.push(`customer_phone = $${paramIdx++}`); setParams.push(customerPhoneNuevo); }
      }
      if (syncAddress && cambioAddress) {
        setClauses.push(`shipping_address = $${paramIdx++}`);
        setParams.push(addressNuevo);
      }
      if (syncNotes && cambioNotes) {
        setClauses.push(`note = $${paramIdx++}`);
        setParams.push(pedido.note || null);
        setClauses.push(`owner_note = $${paramIdx++}`);
        setParams.push(pedido.owner_note || null);
      }
      if (syncCosts && cambioCosts) {
        setClauses.push(`discount = $${paramIdx++}`);
        setParams.push(Number(pedido.discount) || 0);
        setClauses.push(`shipping_cost = $${paramIdx++}`);
        setParams.push(Number(pedido.shipping_cost_customer) || 0);
      }
      if (syncTracking && cambioTracking) {
        setClauses.push(`shipping_tracking = $${paramIdx++}`);
        setParams.push(pedido.shipping_tracking_number || null);
      }

      // Ejecutar update selectivo
      if (setClauses.length > 1) {
        await pool.query(
          `UPDATE orders_validated SET ${setClauses.join(', ')} WHERE order_number = $1`,
          [String(pedido.number), ...setParams]
        );
      }

      // 🔍 Verificar consistencia con TiendaNube
      await verificarConsistencia(String(pedido.number), pedido);

      log.info({
        orderNumber: String(pedido.number),
        changes: mensaje.toString(),
        synced: cambiosPermitidos.map(c => c.tipo),
        blocked: cambiosBloqueados.map(c => c.tipo),
      }, 'Order updated via webhook (selective sync)');

      // Recalcular total_pagado = pago_online_tn + pagos_locales, saldo y estado
      if ((cambioMonto && syncProducts) || (cambioPayment && syncPayment)) {
        await recalcularPagos(pool, String(pedido.number));
      }

      // 🔍 Detectar divergencias BPM vs TN (post-sync)
      try {
        const divDetectionEnabled = await isIntegrationEnabled('tiendanube_divergence_detection', { context: 'webhook:divergence' });
        if (divDetectionEnabled) {
          const bpmPostSync = await getBpmOrderForComparison(String(pedido.number));
          if (bpmPostSync) {
            const toggleMap = {
              tiendanube_webhook_sync_payment: syncPayment,
              tiendanube_webhook_sync_shipping: syncShipping,
              tiendanube_webhook_sync_products: syncProducts,
              tiendanube_webhook_sync_customer: syncCustomer,
              tiendanube_webhook_sync_address: syncAddress,
              tiendanube_webhook_sync_notes: syncNotes,
            };
            const divReport = buildDivergenceReport(pedido, bpmPostSync, { toggles: toggleMap });
            if (divReport.divergences.length > 0) {
              await saveDivergences(String(pedido.number), pedido.id, divReport.divergences, 'webhook');
              log.warn({ orderNumber: String(pedido.number), ...divReport.summary }, 'Divergences detected post-webhook');

              // Auto-fix si toggle habilitado
              const autofixEnabled = await isIntegrationEnabled('tiendanube_divergence_autofix', { context: 'webhook:autofix' });
              if (autofixEnabled) {
                const fixResult = await applyAutoFixes(String(pedido.number), divReport.divergences, {
                  fixedBy: 'auto:webhook',
                  toggles: toggleMap,
                });
                if (fixResult.fixed > 0) {
                  log.info({ orderNumber: String(pedido.number), ...fixResult }, 'Divergences auto-fixed via webhook');
                }
              }
            }
          }
        }
      } catch (divErr) {
        log.error({ err: divErr, orderNumber: String(pedido.number) }, 'Error detecting divergences in webhook');
      }

      // Guardar en historial — logs separados por tipo de cambio
      const orderNum = String(pedido.number);

      // Log cada cambio de producto individualmente (solo si toggle ON)
      if (syncProducts) {
        for (const productLine of mensaje.productChanges) {
          await logEvento({ orderNumber: orderNum, accion: productLine, origen: 'webhook_tiendanube' });
        }

        // Log cambio de monto como evento separado (solo si realmente cambió)
        if (cambioMonto) {
          await logEvento({ orderNumber: orderNum, accion: mensaje.montoLine, origen: 'webhook_tiendanube' });
        }
      }

      // Log cambio de pago (con deduplicación para evitar logs duplicados por retries de TN)
      if (cambioPayment && syncPayment) {
        const paymentHash = hashPaymentChange(orderId, paymentStatusNuevo, tnPaidAt, tnTotalPaid);
        const isNewEvent = await markEventProcessed({
          eventHash: paymentHash,
          eventType: 'order_updated',
          orderId: String(orderId),
          orderNumber: orderNum,
          changeType: 'payment'
        });

        if (isNewEvent) {
          const pagoMsg = paymentStatusNuevo === 'paid'
            ? `Pago confirmado en TiendaNube (${tnGateway || 'manual'}${tnTotalPaid > 0 ? ', $' + tnTotalPaid.toLocaleString('es-AR') : ''})`
            : paymentStatusNuevo === 'partially_paid'
            ? `Pago parcial en TiendaNube ($${tnTotalPaid.toLocaleString('es-AR')})`
            : `Estado de pago cambiado a: ${paymentStatusNuevo}`;
          await logEvento({ orderNumber: orderNum, accion: pagoMsg, origen: 'webhook_tiendanube' });

          // WhatsApp automático cuando TN marca como pagado (misma plantilla que comprobante_confirmado)
          if (paymentStatusNuevo === 'paid') {
            const clientePagoRes = await pool.query(
              `SELECT customer_name, customer_phone, monto_tiendanube, shipping_type FROM orders_validated WHERE order_number = $1`,
              [orderNum]
            );
            const clientePago = clientePagoRes.rows[0];

            if (clientePago?.customer_phone) {
              const montoFormateado = Number(clientePago.monto_tiendanube || tnTotalPaid).toLocaleString('es-AR');
              try {
                await queueWhatsApp({
                  telefono: clientePago.customer_phone,
                  plantilla: 'comprobante_confirmado',
                  variables: {
                    '1': clientePago.customer_name || 'Cliente',
                    '2': montoFormateado,
                    '3': orderNum
                  },
                  orderNumber: orderNum
                });
              } catch (waErr) {
                log.error({ err: waErr.message, orderNumber: orderNum, plantilla: 'comprobante_confirmado' }, 'Error encolando WhatsApp');
              }

              // Enviar datos__envio si requiere formulario de envío y no existe shipping_request
              if (requiresShippingForm(clientePago.shipping_type)) {
                const shippingReqRes = await pool.query(
                  `SELECT 1 FROM shipping_requests WHERE order_number = $1 LIMIT 1`,
                  [orderNum]
                );
                if (shippingReqRes.rows.length === 0) {
                  try {
                    await queueWhatsApp({
                      telefono: clientePago.customer_phone,
                      plantilla: 'datos__envio',
                      variables: { '1': clientePago.customer_name || 'Cliente', '2': orderNum },
                      orderNumber: orderNum
                    });
                  } catch (waErr) {
                    log.error({ err: waErr.message, orderNumber: orderNum, plantilla: 'datos__envio' }, 'Error encolando WhatsApp');
                  }
                } else {
                  log.info({ orderNumber: orderNum }, 'Skipping datos__envio - shipping_request already exists');
                }
              }
            }
          }
        } else {
          log.info({ orderNumber: orderNum, paymentStatus: paymentStatusNuevo }, 'Skipping duplicate payment log (already processed)');
        }
      }

      // Log cambio de envío (con deduplicación para evitar logs duplicados por order/updated + order/fulfilled)
      if (cambioShipping && syncShipping) {
        const shippingHash = hashShippingChange(orderId, shippingStatusNuevo);
        const isNewShippingEvent = await markEventProcessed({
          eventHash: shippingHash,
          eventType: event.replace('/', '_'),
          orderId: String(orderId),
          orderNumber: orderNum,
          changeType: 'shipping'
        });

        if (isNewShippingEvent) {
          await logEvento({ orderNumber: orderNum, accion: `Estado envío TN: ${shippingStatusAnterior || 'N/A'} → ${shippingStatusNuevo}`, origen: 'webhook_tiendanube' });
          if (shippingDerivedEstado) {
            await logEvento({ orderNumber: orderNum, accion: `Estado pedido actualizado a "${shippingDerivedEstado}" (sync envío TN)`, origen: 'webhook_tiendanube' });
          }

          // WhatsApp automático cuando TN marca como "enviado" (Envío Nube)
          if (shippingDerivedEstado === 'enviado') {
            const shippingTypeLower = (db.shipping_type || '').toLowerCase();
            const esEnvioNube = shippingTypeLower.includes('envío nube') || shippingTypeLower.includes('envio nube');

            if (esEnvioNube) {
              // Obtener datos del cliente para WhatsApp
              const clienteWebhookRes = await pool.query(
                `SELECT customer_name, customer_phone, tn_order_id, tn_order_token FROM orders_validated WHERE order_number = $1`,
                [orderNum]
              );
              const clienteWebhook = clienteWebhookRes.rows[0];

              if (clienteWebhook?.customer_phone && clienteWebhook.tn_order_id && clienteWebhook.tn_order_token) {
                const trackingParam = `${clienteWebhook.tn_order_id}/${clienteWebhook.tn_order_token}`;
                try {
                  await queueWhatsApp({
                    telefono: clienteWebhook.customer_phone,
                    plantilla: 'enviado_env_nube',
                    variables: {
                      '1': clienteWebhook.customer_name || 'Cliente',
                      '2': orderNum,
                      '3': trackingParam
                    },
                    orderNumber: orderNum
                  });
                } catch (waErr) {
                  log.error({ err: waErr.message, orderNumber: orderNum, plantilla: 'enviado_env_nube' }, 'Error encolando WhatsApp');
                }
              } else {
                log.warn({ orderNumber: orderNum, hasPhone: !!clienteWebhook?.customer_phone, hasOrderId: !!clienteWebhook?.tn_order_id, hasToken: !!clienteWebhook?.tn_order_token }, 'WhatsApp enviado_env_nube skipped - missing data');
              }
            }
          }
        } else {
          log.info({ orderNumber: orderNum, shippingStatus: shippingStatusNuevo }, 'Skipping duplicate shipping log (already processed)');
        }
      }

      // Log cambio de cliente
      if (cambioCustomer && syncCustomer) {
        await logEvento({ orderNumber: orderNum, accion: `Datos de cliente actualizados desde TN`, origen: 'webhook_tiendanube' });
      }

      // Log cambio de dirección
      if (cambioAddress && syncAddress) {
        await logEvento({ orderNumber: orderNum, accion: `Dirección de envío actualizada desde TN`, origen: 'webhook_tiendanube' });
      }

      // Log cambio de notas
      if (cambioNotes && syncNotes) {
        await logEvento({ orderNumber: orderNum, accion: `Notas del pedido actualizadas desde TN`, origen: 'webhook_tiendanube' });
      }

      // Log cambio de costos
      if (cambioCosts && syncCosts) {
        await logEvento({ orderNumber: orderNum, accion: `Descuentos/costos actualizados desde TN`, origen: 'webhook_tiendanube' });
      }

      // Log cambio de tracking
      if (cambioTracking && syncTracking) {
        await logEvento({ orderNumber: orderNum, accion: `Nro. de seguimiento actualizado desde TN: ${pedido.shipping_tracking_number}`, origen: 'webhook_tiendanube' });
      }

      return;
    }

    // order/created: Guardar pedido completo (datos + productos)
    await guardarPedidoCompleto(pedido);
    log.info({ orderNumber: String(pedido.number), orderId }, 'Order saved in DB (order/created)');
    await logEvento({ orderNumber: String(pedido.number), accion: 'pedido_creado', origen: 'webhook_tiendanube' });

    // 🔍 Verificar consistencia con TiendaNube
    await verificarConsistencia(String(pedido.number), pedido);

    // 5️⃣ Teléfono
    const telefono =
      pedido.contact_phone ||
      pedido.customer?.phone ||
      pedido.shipping_address?.phone ||
      pedido.customer?.default_address?.phone;

    if (!telefono) {
      log.warn({ orderNumber: String(pedido.number) }, 'Order has no phone number');
      return;
    }

    // 6️⃣ Botmaker - envía WhatsApp a pedidos nuevos
    const customerName = (pedido.customer?.name || '').trim().toLowerCase();
    const isLocalLocal = customerName === 'local local';

    if (isLocalLocal) {
      // Cliente "local local": no enviar ninguna plantilla, solo programar reseña para las 21:30
      try {
        const now = new Date();
        const sendAt = new Date(now);
        // 21:30 Argentina = 00:30 UTC del día siguiente
        sendAt.setUTCHours(0, 30, 0, 0);
        sendAt.setUTCDate(sendAt.getUTCDate() + 1);
        // Si ya pasaron las 00:30 UTC (21:30 Arg), programar para mañana
        if (sendAt <= now) {
          sendAt.setUTCDate(sendAt.getUTCDate() + 1);
        }

        await pool.query(
          `INSERT INTO scheduled_whatsapp (telefono, plantilla, variables, send_at)
           VALUES ($1, 'resenia_maps', '{}', $2)`,
          [telefono, sendAt]
        );
        log.info({ orderNumber: String(pedido.number), sendAt: sendAt.toISOString() }, 'Local Local: resenia_maps programado para 21:30');
      } catch (schedErr) {
        log.error({ err: schedErr.message, orderNumber: String(pedido.number) }, 'Error programando resenia_maps');
      }
    } else {
      // Cliente normal: enviar pedido_creado
      try {
        await queueWhatsApp({
          telefono,
          plantilla: 'pedido_creado',
          variables: {
            '1': pedido.customer?.name || 'Cliente',
            '2': String(pedido.number)
          },
          orderNumber: pedido.number
        });
      } catch (waErr) {
        log.error({ err: waErr.message, orderNumber: String(pedido.number), plantilla: 'pedido_creado' }, 'Error encolando WhatsApp');
      }
    }

    // 7️⃣ Si requiere formulario de envío (Expreso a elección o Via Cargo)
    const shippingOption = (typeof pedido.shipping_option === 'string'
      ? pedido.shipping_option
      : pedido.shipping_option?.name) || '';

    // datos__envio se envía al confirmar el primer comprobante (no aquí)
    if (requiresShippingForm(shippingOption)) {
      log.info({ orderNumber: String(pedido.number), shippingOption }, 'Order requires shipping form (will be requested on comprobante confirmation)');
    }

  } catch (err) {
    log.error({ err, event, orderId }, 'Error processing Tiendanube webhook');
    // ❌ Procesamiento falló — marcar en sync_queue para retry
    if (queueId) {
      await markQueueFailed(queueId, err.message).catch(e => log.error({ err: e, queueId }, 'Error marking queue failed'));
      queueId = null; // evitar doble mark en finally
    }
  } finally {
    // ✅ Liberar slot en sync_queue (finally corre incluso después de return)
    if (queueId) {
      await markQueueCompleted(queueId).catch(e => log.error({ err: e, queueId }, 'Error marking queue completed'));
    }
  }
});




/* =====================================================
   CHECK SI PEDIDO TIENE COMPROBANTES (público)
===================================================== */

app.get('/orders/:orderNumber/has-receipts', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const sanitized = String(orderNumber).replace(/\D/g, '');

    if (!sanitized) {
      return res.json({ hasReceipts: false });
    }

    const result = await pool.query(
      `SELECT COUNT(*) as count FROM comprobantes WHERE order_number = $1 AND estado IN ('a_confirmar', 'confirmado')`,
      [sanitized]
    );

    res.json({ hasReceipts: parseInt(result.rows[0].count) > 0 });
  } catch (error) {
    console.error('❌ /orders/:orderNumber/has-receipts error:', error.message);
    res.json({ hasReceipts: false });
  }
});

/* =====================================================
   PASO 1 — VALIDAR PEDIDO
===================================================== */

app.post('/validate-order', validationLimiter, async (req, res) => {
  try {
    // Check de integración habilitada
    const validateEnabled = await tnConfig.isValidateOrdersEnabled();
    if (!validateEnabled) {
      return res.status(503).json({
        error: 'Validación de pedidos temporalmente deshabilitada',
        retry: true
      });
    }

    const { orderNumber } = req.body;

    if (!orderNumber) {
      return res.status(400).json({ error: 'Falta orderNumber' });
    }

    // Validación de seguridad: orderNumber debe ser numérico y razonable
    // También quita el # inicial si el usuario lo incluye
    const sanitized = String(orderNumber).replace(/\D/g, '');
    if (!sanitized || sanitized.length > 20) {
      return res.status(400).json({ error: 'Número de pedido inválido' });
    }

    /* ===============================
       1️⃣ CONSULTAR TIENDANUBE
    ================================ */
    const storeId = process.env.TIENDANUBE_STORE_ID;
    const accessToken = process.env.TIENDANUBE_ACCESS_TOKEN;

    const tnResponse = await callTiendanube({
      method: 'get',
      url: `https://api.tiendanube.com/v1/${storeId}/orders`,
      headers: {
        authentication: `bearer ${accessToken}`,
        'User-Agent': 'bpm-validator'
      },
      params: {
        q: sanitized
      }
    });

    if (!tnResponse.data || tnResponse.data.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado en Tiendanube' });
    }

    const pedido = tnResponse.data[0];
    const montoTiendanube = Number(pedido.total);
    const currency = pedido.currency || 'ARS';

    // Datos del cliente
    const customerName = pedido.customer?.name || pedido.contact_name || null;
    const customerEmail = pedido.customer?.email || pedido.contact_email || null;
    const customerPhone = pedido.contact_phone || pedido.customer?.phone ||
                          pedido.shipping_address?.phone || pedido.customer?.default_address?.phone || null;

    /* ===============================
       2️⃣ GUARDAR EN DB (SI NO EXISTE)
    ================================ */
    await pool.query(
      `
      insert into orders_validated (order_number, monto_tiendanube, currency, customer_name, customer_email, customer_phone, estado_pedido)
      values ($1, $2, $3, $4, $5, $6, 'pendiente_pago')
      on conflict (order_number) do update set
        customer_name = coalesce(orders_validated.customer_name, excluded.customer_name),
        customer_email = coalesce(orders_validated.customer_email, excluded.customer_email),
        customer_phone = coalesce(orders_validated.customer_phone, excluded.customer_phone)
      `,
      [sanitized, montoTiendanube, currency, customerName, customerEmail, customerPhone]
    );

    /* ===============================
       3️⃣ RESPUESTA
    ================================ */
    res.json({
      ok: true,
      orderNumber: sanitized,
      monto_tiendanube: montoTiendanube,
      currency
    });

  } catch (error) {
    console.error('❌ /validate-order error:', error);

    // Error 404 de Tiendanube = pedido no encontrado
    if (error.response?.status === 404 || error.message.includes('404')) {
      return res.status(404).json({ error: 'Pedido no encontrado, intentar de nuevo' });
    }

    res.status(500).json({ error: 'Error al validar pedido, intentar de nuevo' });
  }
});

/* =====================================================
   PASO 2 — UPLOAD + OCR + COMPARACIÓN
===================================================== */
app.post('/upload', uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('❌ Multer error:', err.message);
      return res.status(400).json({ error: 'Error al subir archivo: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { orderNumber: rawOrderNumber } = req.body;
    const file = req.file;

    log.info({ requestId: req.requestId, orderNumber: rawOrderNumber }, '/upload started');

    if (!rawOrderNumber || !file) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    // Validación de seguridad: orderNumber debe ser numérico y razonable
    // También quita el # inicial si el usuario lo incluye
    const orderNumber = String(rawOrderNumber).replace(/\D/g, '');
    if (!orderNumber || orderNumber.length > 20) {
      return res.status(400).json({ error: 'Número de pedido inválido' });
    }

    /* ===============================
       1️⃣ OBTENER PEDIDO DESDE TIENDANUBE
    ================================ */
    const tnResponse = await callTiendanube({
      method: 'get',
      url: `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}/orders`,
      headers: {
        authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
        'User-Agent': 'bpm-validator'
      },
      params: { q: orderNumber }
    });

    if (!tnResponse.data || tnResponse.data.length === 0) {
      return res.status(404).json({ error: 'El número de pedido no existe. Verificá que esté bien escrito.' });
    }

    const pedido = tnResponse.data[0];
    const nombre = pedido.customer?.name || 'Cliente';
    const telefono = pedido.customer?.phone || null;
    const montoTiendanube = Math.round(Number(pedido.total));
    const currency = pedido.currency || 'ARS';

    // Datos del cliente para orders_validated
    const customerName = pedido.customer?.name || pedido.contact_name || null;
    const customerEmail = pedido.customer?.email || pedido.contact_email || null;
    const customerPhone = pedido.contact_phone || pedido.customer?.phone ||
                          pedido.shipping_address?.phone || pedido.customer?.default_address?.phone || null;

    console.log('📦 Pedido encontrado:', pedido.number);

    /* ===============================
       1️⃣b REGISTRAR EN ORDERS_VALIDATED
    ================================ */
    await pool.query(
      `
      insert into orders_validated (order_number, monto_tiendanube, currency, customer_name, customer_email, customer_phone, estado_pedido)
      values ($1, $2, $3, $4, $5, $6, 'pendiente_pago')
      on conflict (order_number) do update set
        customer_name = coalesce(orders_validated.customer_name, excluded.customer_name),
        customer_email = coalesce(orders_validated.customer_email, excluded.customer_email),
        customer_phone = coalesce(orders_validated.customer_phone, excluded.customer_phone)
      `,
      [orderNumber, montoTiendanube, currency, customerName, customerEmail, customerPhone]
    );

    /* ===============================
       1.5️⃣ CONVERTIR PDF A JPG (antes de análisis)
    ================================ */
    const fileBufPre = fs.readFileSync(file.path);
    const isPdfPre = path.extname(file.path).toLowerCase() === '.pdf' || (fileBufPre.length > 1 && fileBufPre[0] === 0x25 && fileBufPre[1] === 0x50);
    if (isPdfPre) {
      const ppmPrefix = file.path.replace(/\.pdf$/i, '') + '_converted';
      const { execSync } = require('child_process');
      try {
        execSync(`pdftoppm -jpeg -r 200 -singlefile "${file.path}" "${ppmPrefix}"`);
        const jpgPath = ppmPrefix + '.jpg';
        if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 0) {
          fs.unlinkSync(file.path);
          file.path = jpgPath;
          file.mimetype = 'image/jpeg';
          file.originalname = file.originalname.replace(/\.pdf$/i, '.jpg');
          console.log('📄→🖼️ PDF convertido a JPG (pre-análisis):', jpgPath);
        } else {
          console.error('❌ pdftoppm no generó JPG válido');
        }
      } catch (pdfErr) {
        console.error('❌ pdftoppm falló:', pdfErr.message);
      }
    }

    /* ===============================
       2️⃣ ANÁLISIS CON CLAUDE VISION
    ================================ */
    const datosClaudeRaw = await analizarComprobante(file.path);
    const datosClaude = convertirAFormatoLegacy(datosClaudeRaw);

    // Validar que sea un comprobante real
    if (!datosClaude.esComprobante) {
      fs.unlinkSync(file.path);
      return res.status(400).json({
        error: 'El archivo no parece ser un comprobante válido. Contactate con nosotros por WhatsApp para que te ayudemos.'
      });
    }
    console.log('🧠 Claude Vision OK | monto:', datosClaude.monto, '| banco:', datosClaude.banco);

    const textoOcr = datosClaude.textoOcr || '';
    const cuentaDestino = datosClaude.cuenta;

    /* ===============================
       2.5️⃣ VALIDAR CUENTA DESTINO
    ================================ */
    console.log('🔍 Cuenta destino extraída:', cuentaDestino);

    const destinoValidation = await isValidDestination(cuentaDestino, textoOcr);
    if (!destinoValidation.valid) {
      fs.unlinkSync(file.path);
      console.log('❌ Cuenta destino inválida:', destinoValidation);
      return res.status(400).json({
        error: 'El comprobante no corresponde a una cuenta válida de la empresa',
        reason: destinoValidation.reason,
        extracted: cuentaDestino
      });
    }
    console.log('✅ Cuenta destino válida:', destinoValidation.cuenta?.alias || destinoValidation.cuenta?.cbu);

    /* ===============================
       3️⃣ DUPLICADOS (hash + número de operación)
    ================================ */
    const hash = hashText(textoOcr);
    const numeroOperacion = datosClaude.numeroOperacion || null;

    // Chequear por hash (imagen idéntica)
    const dupHash = await pool.query(
      'select id from comprobantes where hash_ocr = $1',
      [hash]
    );

    // Chequear por número de operación (mismo comprobante, distinta imagen)
    let dupOp = { rows: [] };
    if (numeroOperacion) {
      dupOp = await pool.query(
        'select id from comprobantes where numero_operacion = $1',
        [numeroOperacion]
      );
    }

    // Chequear por monto+pedido ya confirmado (mismo comprobante con distinto OCR/imagen)
    const dupConfirmado = await pool.query(
      `SELECT id FROM comprobantes
       WHERE order_number = $1 AND monto = $2 AND estado = 'confirmado'
       LIMIT 1`,
      [orderNumber, datosClaude.monto]
    );

    if (dupHash.rows.length > 0 || dupOp.rows.length > 0 || dupConfirmado.rows.length > 0) {
      const dupId = dupHash.rows[0]?.id || dupOp.rows[0]?.id || dupConfirmado.rows[0]?.id;
      const dupTipo = dupHash.rows.length > 0 ? 'hash' : dupOp.rows.length > 0 ? 'numero_operacion' : 'monto_confirmado';
      await logEvento({
        orderNumber,
        accion: 'comprobante_duplicado',
        origen: 'sistema'
      });
      console.log(`⚠️ Comprobante duplicado (${dupTipo}) - Order: ${orderNumber}, Original ID: ${dupId}`);

      fs.unlinkSync(file.path);
      const mensajes = {
        hash: `Comprobante duplicado — ya fue subido anteriormente (comprobante #${dupId})`,
        numero_operacion: `Comprobante duplicado — mismo número de operación que comprobante #${dupId}`,
        monto_confirmado: `Comprobante duplicado — ya existe comprobante #${dupId} confirmado por el mismo monto`,
      };
      return res.status(409).json({ error: mensajes[dupTipo] });
    }

    /* ===============================
       4️⃣ MONTO DESDE CLAUDE
    ================================ */
    const montoDetectado = datosClaude.monto;

    /* ===============================
       5️⃣ PREPARAR URL DE STORAGE
    ================================ */
    // Sanitizar nombre de archivo (remover caracteres especiales y espacios)
    const sanitizedFilename = file.originalname
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remover acentos
      .replace(/[^\w.-]/g, '_') // Reemplazar caracteres especiales por _
      .replace(/_+/g, '_'); // Colapsar múltiples _
    const storagePath = `pendientes/${Date.now()}-${sanitizedFilename}`;
    const fileUrl = storageGetPublicUrl(storagePath);

    /* ===============================
       6️⃣ INSERTAR COMPROBANTE
    ================================ */
    const financieraId = destinoValidation.cuenta?.id || null;

    // Parsear fecha del comprobante (formato DD/MM/YYYY de Claude Vision)
    let fechaComprobante = null;
    if (datosClaude.fecha) {
      const parts = datosClaude.fecha.split('/');
      if (parts.length === 3) {
        fechaComprobante = `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
      }
    }

    const insert = await pool.query(
      `insert into comprobantes
       (order_number, hash_ocr, texto_ocr, monto, monto_tiendanube, file_url, estado, financiera_id, numero_operacion, fecha_comprobante)
       values ($1,$2,$3,$4,$5,$6,'a_confirmar',$7,$8,$9)
       returning id`,
      [
        orderNumber,
        hash,
        textoOcr,
        montoDetectado,
        montoTiendanube,
        fileUrl,
        financieraId,
        numeroOperacion,
        fechaComprobante
      ]
    );

    const comprobanteId = insert.rows[0].id;

    await logEvento({
      comprobanteId,
      accion: 'upload',
      origen: 'cliente'
    });

    console.log('🧾 Comprobante guardado ID:', comprobanteId);

    /* ===============================
       7️⃣ WATERMARK (con ID real)
    ================================ */
    await watermarkReceipt(file.path, {
      id: comprobanteId,
      orderNumber
    });

    /* ===============================
       8️⃣ SUBIR ARCHIVO A STORAGE (GCS)
    ================================ */
    const finalBuffer = await fs.promises.readFile(file.path);

    await storageUploadFile(storagePath, finalBuffer, file.mimetype);

    console.log('☁️ Archivo subido:', fileUrl);

    /* ===============================
       9️⃣ ELIMINAR ARCHIVO TEMPORAL
    ================================ */
    fs.unlinkSync(file.path);
    console.log('🗑️ Temp file eliminado');

    /* ===============================
       🔟 RECALCULAR CUENTA
    ================================ */
    const totalPagadoResult = await pool.query(
      `select coalesce(sum(monto), 0) as total_pagado
       from comprobantes
       where order_number = $1`,
      [orderNumber]
    );

    const totalPagado = Number(totalPagadoResult.rows[0].total_pagado);

    const resultado = calcularEstadoCuenta(totalPagado, montoTiendanube);
    const estadoCuenta = resultado.estado;
    const cuentaActual = resultado.cuenta;

    /* ===============================
       1️⃣1️⃣ WHATSAPP AL CLIENTE (solo pago parcial)
    ================================ */
    console.log('CEL: ',telefono, 'ESTADO CUENTA:', estadoCuenta)
    if (telefono && estadoCuenta === 'debe') {
      // Solo enviar WhatsApp si hay saldo pendiente (partial_paid)
      const plantilla = 'partial_paid';
      const variables = {
        '1': nombre,
        '2': montoDetectado,
        '3': cuentaActual
      };

      try {
        await queueWhatsApp({
          telefono,
          plantilla,
          variables,
          orderNumber
        });
      } catch (waErr) {
        log.error({ err: waErr.message, orderNumber, plantilla: 'partial_paid' }, 'Error encolando WhatsApp');
      }
    }

    /* ===============================
       1️⃣2️⃣ UPDATE CUENTA
    ================================ */
    await pool.query(
      `update comprobantes set cuenta = $2 where id = $1`,
      [comprobanteId, cuentaActual]
    );

    /* ===============================
       1️⃣4️⃣ UPDATE ESTADO PAGO A "A CONFIRMAR" Y HABILITAR IMPRESIÓN
    ================================ */
    await pool.query(
      `update orders_validated
       set estado_pago = 'a_confirmar',
           estado_pedido = CASE
             WHEN estado_pedido = 'pendiente_pago' THEN 'a_imprimir'
             ELSE estado_pedido
           END
       where order_number = $1 and estado_pago = 'pendiente'`,
      [orderNumber]
    );

    /* ===============================
       1️⃣4️⃣ RESPUESTA FINAL
    ================================ */
    res.json({
      ok: true,
      comprobante_id: comprobanteId,
      orderNumber,
      monto_detectado: montoDetectado,
      total_pagado: totalPagado,
      monto_tiendanube: montoTiendanube,
      cuenta: cuentaActual,
      estado_cuenta: estadoCuenta
    });

  } catch (error) {
    console.error('❌ /upload error:', error.message);

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Error de Tiendanube (pedido no encontrado)
    const status = error.response?.status;
    const errorData = error.response?.data;
    if (status === 404 || errorData?.code === 404 || error.message?.includes('404') || error.message?.includes('Not Found')) {
      return res.status(404).json({ error: 'El número de pedido no existe. Verificá que esté bien escrito.' });
    }

    res.status(500).json({ error: error.message || 'Error al procesar comprobante' });
  }
});


app.get('/revisar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, estado, file_url
       FROM comprobantes
       WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).send(`
        <h2>❌ Comprobante no encontrado</h2>
        <p>ID: ${id}</p>
      `);
    }

    const comprobante = result.rows[0];

    res.send(`
      <html>
        <head>
          <title>Revisión de comprobante</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <style>
            body {
              font-family: Arial, sans-serif;
              background: #f4f6f8;
              margin: 0;
              padding: 0;
            }
            .container {
              max-width: 420px;
              margin: 40px auto;
              background: white;
              padding: 20px;
              border-radius: 10px;
              box-shadow: 0 4px 10px rgba(0,0,0,0.1);
              text-align: center;
            }
            img {
              width: 100%;
              border-radius: 8px;
              margin: 15px 0;
            }
            .estado {
              font-weight: bold;
              margin-bottom: 10px;
            }
            .ok { color: green; }
            .rechazado { color: red; }
            .pendiente { color: orange; }

            .btn {
              display: block;
              width: 100%;
              padding: 12px;
              margin: 10px 0;
              border-radius: 6px;
              font-size: 16px;
              text-decoration: none;
              color: white;
            }
            .confirmar { background: #28a745; }
            .rechazar { background: #dc3545; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>📄 Comprobante</h2>
            <p><strong>ID:</strong> ${comprobante.id}</p>

            <p class="estado ${comprobante.estado}">
              Estado: ${comprobante.estado}
            </p>

            <img src="${comprobante.file_url}" alt="Comprobante" />

            ${
              (comprobante.estado === 'pendiente' || comprobante.estado === 'a_confirmar')
                ? (() => {
                    const confirmToken = generateSignedAction(comprobante.id, 'confirmar');
                    const rejectToken = generateSignedAction(comprobante.id, 'rechazar');
                    return `
                  <a class="btn confirmar" href="/confirmar/${comprobante.id}?token=${confirmToken}">
                    ✅ Confirmar
                  </a>

                  <a class="btn rechazar" href="/rechazar/${comprobante.id}?token=${rejectToken}">
                    ❌ Rechazar
                  </a>
                `;
                  })()
                : `<p>Este comprobante ya fue procesado.</p>`
            }
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar comprobante');
  }
});


app.get('/confirmar/:id', async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  // Verify signed token
  if (!token || !verifySignedAction(token, id, 'confirmar')) {
    return res.status(403).send('<h2>Link invalido o expirado</h2><p>Solicita un nuevo link de revision.</p>');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1️⃣ Buscar comprobante con row lock
    const compRes = await client.query(
      `SELECT id, order_number, monto, estado
       FROM comprobantes
       WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (compRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Comprobante no encontrado');
    }

    const comprobante = compRes.rows[0];

    if (comprobante.estado !== 'pendiente' && comprobante.estado !== 'a_confirmar') {
      await client.query('ROLLBACK');
      return res.send('Este comprobante ya fue procesado.');
    }

    // 2️⃣ Confirmar comprobante
    await client.query(
      `UPDATE comprobantes SET estado = 'confirmado' WHERE id = $1`,
      [id]
    );

    // 3️⃣ Recalcular pagos (centralizado: pago_online_tn + comprobantes + efectivo)
    const pagoResult = await recalcularPagos(client, comprobante.order_number);
    const { totalPagado, saldo, estadoPago } = pagoResult;
    const nuevoEstadoPedido = pagoResult.estadoPedido;

    await client.query('COMMIT');

    return res.send(`
      <h2>Comprobante confirmado</h2>
      <p>Pedido: ${comprobante.order_number}</p>
      <p>Total pagado: $${totalPagado}</p>
      <p>Estado pago: ${estadoPago}</p>
      <p>Estado pedido: ${nuevoEstadoPedido}</p>
    `);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).send('Error al confirmar comprobante');
  } finally {
    client.release();
  }
});



app.get('/rechazar/:id', async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  // Verify signed token
  if (!token || !verifySignedAction(token, id, 'rechazar')) {
    return res.status(403).send('<h2>Link invalido o expirado</h2><p>Solicita un nuevo link de revision.</p>');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const compRes = await client.query(
      `SELECT id, order_number, estado
       FROM comprobantes
       WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (compRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Comprobante no encontrado');
    }

    if (compRes.rows[0].estado !== 'pendiente' && compRes.rows[0].estado !== 'a_confirmar') {
      await client.query('ROLLBACK');
      return res.send('Este comprobante ya fue procesado.');
    }

    // Rechazar comprobante
    await client.query(
      `UPDATE comprobantes SET estado = 'rechazado' WHERE id = $1`,
      [id]
    );

    // El estado de la orden pasa a rechazado
    await client.query(
      `UPDATE orders_validated SET estado_pago = 'rechazado' WHERE order_number = $1`,
      [compRes.rows[0].order_number]
    );

    await client.query('COMMIT');

    return res.send(`
      <h2>Comprobante rechazado</h2>
      <p>ID: ${id}</p>
    `);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).send('Error al rechazar comprobante');
  } finally {
    client.release();
  }
});


/* =====================================================
   UTIL — MARCAR PAGADO EN TIENDANUBE
   Sincroniza estado de pago cuando está completamente pagado
===================================================== */
async function marcarPagadoEnTiendanube(tnOrderId, orderNumber) {
  // Check de integración habilitada (master + sub-toggle)
  const markPaidEnabled = await tnConfig.isMarkPaidEnabled();
  if (!markPaidEnabled) {
    console.log(`🚫 [Orden ${orderNumber}] Marcar pagado en TN deshabilitado`);
    return false;
  }
  const subEnabled = await isIntegrationEnabled('tiendanube_sync_estado_pagado', { context: 'sync-estado-pagado' });
  if (!subEnabled) {
    console.log(`🚫 [Orden ${orderNumber}] Sub-toggle sync estado pagado deshabilitado`);
    return false;
  }

  return sincronizarEstadoTiendanube(tnOrderId, orderNumber, 'paid', 'pagada');
}

// sincronizarEstadoTiendanube ahora vive en lib/tn-sync.js


/* =====================================================
   PAGO EN EFECTIVO
===================================================== */
app.post('/pago-efectivo', authenticate, requirePermission('orders.create_cash_payment'), async (req, res) => {
  const { orderNumber, monto, registradoPor, notas } = req.body;

  // Validaciones (before acquiring connection)
  if (!orderNumber || !monto) {
    return res.status(400).json({ error: 'Faltan datos: orderNumber y monto son requeridos' });
  }

  const montoNumerico = Math.round(Number(monto));
  if (isNaN(montoNumerico) || montoNumerico <= 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }

  log.info({ requestId: req.requestId, orderNumber, monto: montoNumerico, registradoPor: registradoPor || 'sistema', action: 'cash_payment_start' }, 'Registering cash payment');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* ===============================
       1️⃣ VERIFICAR QUE EXISTE EL PEDIDO (con lock)
    ================================ */
    const orderRes = await client.query(
      `SELECT order_number, monto_tiendanube, estado_pedido, tn_order_id
       FROM orders_validated
       WHERE order_number = $1
       FOR UPDATE`,
      [orderNumber]
    );

    if (orderRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const montoTiendanube = Number(orderRes.rows[0].monto_tiendanube);
    const estadoPedidoActual = orderRes.rows[0].estado_pedido;
    const tnOrderId = orderRes.rows[0].tn_order_id;

    /* ===============================
       2️⃣ INSERTAR EN PAGOS_EFECTIVO
    ================================ */
    const insert = await client.query(
      `INSERT INTO pagos_efectivo (order_number, monto, registrado_por, notas)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [orderNumber, montoNumerico, registradoPor || 'sistema', notas || null]
    );

    const pagoId = insert.rows[0].id;
    log.info({ requestId: req.requestId, orderNumber, pagoId }, 'Cash payment record inserted');

    /* ===============================
       3️⃣ RECALCULAR PAGOS (centralizado: pago_online_tn + comprobantes + efectivo)
    ================================ */
    const pagoResult = await recalcularPagos(client, orderNumber);
    const { totalPagado, saldo, estadoPago } = pagoResult;
    const nuevoEstadoPedido = pagoResult.estadoPedido;

    await client.query('COMMIT');

    // 6.5️⃣ Sincronizar con Tiendanube si está completamente pagado (after commit)
    if (estadoPago === 'confirmado_total' && tnOrderId) {
      marcarPagadoEnTiendanube(tnOrderId, orderNumber);
    }

    // Log de actividad (after commit)
    await logEvento({
      orderNumber,
      accion: 'pago_efectivo_registrado',
      origen: 'caja',
      userId: req.user?.id,
      username: req.user?.name
    });

    log.info({ requestId: req.requestId, orderNumber, pagoId, totalPagado, saldo, estadoPago, action: 'cash_payment_success' }, 'Cash payment processed successfully');
    if (nuevoEstadoPedido !== estadoPedidoActual) {
      log.info({ requestId: req.requestId, orderNumber, estadoPedidoAnterior: estadoPedidoActual, nuevoEstadoPedido }, 'Order status changed');
    }

    /* ===============================
       7️⃣ RESPUESTA
    ================================ */
    res.json({
      ok: true,
      pago_id: pagoId,
      orderNumber,
      monto_registrado: montoNumerico,
      total_pagado: totalPagado,
      monto_tiendanube: montoTiendanube,
      saldo,
      estado_pago: estadoPago
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    log.error({ err: error, requestId: req.requestId, orderNumber }, '/pago-efectivo error');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});


/* =====================================================
   GET — HISTORIAL DE PAGOS DE UN PEDIDO
===================================================== */
app.get('/pagos/:orderNumber', authenticate, requirePermission('orders.view'), async (req, res) => {
  try {
    const { orderNumber } = req.params;

    // Comprobantes (transferencias)
    const comprobantesRes = await pool.query(
      `SELECT id, monto, estado, 'transferencia' as tipo, NULL as registrado_por, created_at, 'comprobante' as origen
       FROM comprobantes
       WHERE order_number = $1
       ORDER BY created_at DESC`,
      [orderNumber]
    );

    // Pagos en efectivo
    const efectivoRes = await pool.query(
      `SELECT id, monto, 'confirmado' as estado, 'efectivo' as tipo, registrado_por, created_at, 'efectivo' as origen
       FROM pagos_efectivo
       WHERE order_number = $1
       ORDER BY created_at DESC`,
      [orderNumber]
    );

    const orderRes = await pool.query(
      `SELECT order_number, monto_tiendanube, total_pagado, saldo, estado_pago
       FROM orders_validated
       WHERE order_number = $1`,
      [orderNumber]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Combinar y ordenar por fecha
    const todosPagos = [...comprobantesRes.rows, ...efectivoRes.rows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      ok: true,
      pedido: orderRes.rows[0],
      pagos: todosPagos,
      comprobantes: comprobantesRes.rows,
      pagos_efectivo: efectivoRes.rows
    });

  } catch (error) {
    console.error('❌ /pagos error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   RBAC ROUTES
===================================================== */
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const rolesRoutes = require('./routes/roles');
const financierasRoutes = require('./routes/financieras');
const remitosRoutes = require('./routes/remitos');
const integrationsRoutes = require('./routes/integrations');
const healthRoutes = require('./routes/health');
const adminStatusRoutes = require('./routes/admin-status');
const systemAlertsRoutes = require('./routes/system-alerts');
const adminDivergencesRoutes = require('./routes/admin-divergences');
const bankRoutes = require('./routes/bank');
const localOrdersRoutes = require('./routes/local-orders');
const localBoxRoutes = require('./routes/local-box');
const localAlertsRoutes = require('./routes/local-alerts');
const { importMovimientos } = require('./services/bankImportService');
// AI Bot routes — PAUSADO, descomentar cuando se active el bot en prod
// let aiBotRoutes;
// try {
//   aiBotRoutes = require('./routes/ai-bot');
// } catch (err) {
//   console.error('[AI Bot] Failed to load routes — bot disabled, BPM unaffected:', err.message);
//   aiBotRoutes = null;
// }
const aiBotRoutes = null;
const { serverAdapter: bullBoardAdapter, bullBoardAuth } = require('./routes/bull-board');

app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/roles', rolesRoutes);
app.use('/financieras', financierasRoutes);
app.use('/remitos', remitosRoutes);
app.use('/integrations', integrationsRoutes);
app.use('/health', healthRoutes);
app.use('/admin/status', adminStatusRoutes);
app.use('/system-alerts', systemAlertsRoutes);
app.use('/admin/divergences', adminDivergencesRoutes);
app.use('/bank', bankRoutes);
app.use('/local', localOrdersRoutes);
app.use('/local/box-orders', localBoxRoutes);
app.use('/local/alerts', localAlertsRoutes);
if (aiBotRoutes) app.use('/ai-bot', aiBotRoutes);
app.use('/admin/queues', bullBoardAuth, bullBoardAdapter.getRouter());

/* =====================================================
   SYNC QUEUE - Endpoints y Scheduler
===================================================== */

// Estado de la cola de sincronización
app.get('/sync/status', authenticate, async (req, res) => {
  try {
    const [stats, lastSync] = await Promise.all([
      getQueueStats(),
      getSyncState('last_order_sync')
    ]);

    res.json({
      ok: true,
      queue: stats,
      lastSync: lastSync || { last_synced_at: null }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SYNC LOCK: Distributed lock usando tabla
// ═══════════════════════════════════════════════════════════════
const SYNC_LOCK_KEY = 'sync_job_lock';
const SYNC_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos máximo

// Estado local (para monitoring, no para locking)
let syncRunId = 0;
let lastStartAt = null;
let lastEndAt = null;
let lastSource = null;
let lastError = null;
let lastResult = null;
let localSyncRunning = false;

/**
 * Intentar obtener lock distribuido usando tabla sync_state
 * Retorna true si se obtuvo el lock, false si otra instancia lo tiene
 */
async function tryAcquireSyncLock(source) {
  const now = new Date();
  const lockExpiry = new Date(now.getTime() + SYNC_LOCK_TIMEOUT_MS);

  try {
    // Intentar obtener lock: INSERT si no existe, o UPDATE si expiró
    const result = await pool.query(`
      INSERT INTO sync_state (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET
        value = $2,
        updated_at = NOW()
      WHERE sync_state.value->>'locked_until' IS NULL
         OR (sync_state.value->>'locked_until')::timestamptz < NOW()
      RETURNING key
    `, [
      SYNC_LOCK_KEY,
      JSON.stringify({ locked_by: source, locked_until: lockExpiry.toISOString() })
    ]);

    return result.rowCount > 0;
  } catch (err) {
    log.error({ err }, 'SYNC: Error acquiring lock');
    return false;
  }
}

/**
 * Liberar lock distribuido
 */
async function releaseSyncLock() {
  try {
    await pool.query(`
      UPDATE sync_state SET value = $1, updated_at = NOW()
      WHERE key = $2
    `, [
      JSON.stringify({ locked_by: null, locked_until: null }),
      SYNC_LOCK_KEY
    ]);
  } catch (err) {
    log.error({ err }, 'SYNC: Error releasing lock');
  }
}

/**
 * Wrapper único para ejecutar sync desde cualquier punto de entrada
 * Usa lock basado en tabla para garantizar máximo 1 sync
 * corriendo a la vez ENTRE TODAS LAS INSTANCIAS de Cloud Run
 */
async function triggerSync(source) {
  const timestamp = new Date().toISOString();

  // Check de integración habilitada
  const syncEnabled = await tnConfig.isSyncOrdersEnabled();
  if (!syncEnabled) {
    log.info({ source, reason: 'integration_disabled' }, 'SYNC: Skipped - integration disabled');
    return { status: 'skipped', message: 'Order sync integration is disabled' };
  }

  const currentRunId = ++syncRunId;

  // Intentar obtener distributed lock
  const lockAcquired = await tryAcquireSyncLock(source);

  if (!lockAcquired) {
    // Otra instancia tiene el lock - salir silenciosamente
    log.info({ source, reason: 'distributed_lock_held' }, 'SYNC: Skipped - another instance running');
    return { status: 'skipped', message: 'Another instance is running sync' };
  }

  // Lock adquirido - ejecutar sync
  localSyncRunning = true;
  const startTime = Date.now();
  lastStartAt = timestamp;
  lastSource = source;
  lastError = null;
  lastResult = null;

  log.info({ runId: currentRunId, source }, 'SYNC: Started');

  try {
    const result = await runSyncJob();
    lastResult = result;
    return { status: 'completed', runId: currentRunId, result };

  } catch (error) {
    lastError = error.message;
    log.error({ err: error, runId: currentRunId, source }, 'SYNC: Error');
    throw error;

  } finally {
    const duration = Date.now() - startTime;
    lastEndAt = new Date().toISOString();
    localSyncRunning = false;

    // Liberar distributed lock
    await releaseSyncLock();

    log.info({ runId: currentRunId, source, durationMs: duration }, 'SYNC: Completed');
  }
}

/**
 * Obtener estado actual del sync (para debugging/monitoring)
 */
function getSyncStatus() {
  return {
    running: localSyncRunning,
    runId: syncRunId,
    lastStartAt,
    lastEndAt,
    lastSource,
    lastError,
    lastResult
  };
}
// ═══════════════════════════════════════════════════════════════

// Ejecutar sincronización desde Cloud Scheduler (cron)
// Protegido por OIDC token (Cloud Scheduler) o shared secret (fallback)
app.post('/sync/cron', verifyCronAuth, async (req, res) => {
  log.info({ authMethod: req.cronAuth?.method }, 'Cron sync started');

  try {
    const result = await triggerSync('cloud-scheduler');
    res.json({ ok: true, status: result.status, result: result.result });
  } catch (error) {
    log.error({ err: error }, 'Cron sync error');
    res.status(500).json({ error: error.message });
  }
});

// Ejecutar cleanup desde Cloud Scheduler
app.post('/cleanup/cron', verifyCronAuth, async (req, res) => {
  log.info({ authMethod: req.cronAuth?.method }, 'Cron cleanup started');
  try {
    const { runCleanup } = require('./lib/cleanup');
    const results = await runCleanup();
    res.json({ ok: true, ...results });
  } catch (error) {
    log.error({ err: error }, 'Cron cleanup error');
    res.status(500).json({ error: error.message });
  }
});

// Ejecutar reconciliación desde Cloud Scheduler
app.post('/reconcile/cron', verifyCronAuth, async (req, res) => {
  log.info({ authMethod: req.cronAuth?.method }, 'Cron reconciliation started');
  try {
    const { runReconciliation } = require('./workers/reconciliation.worker');
    const results = await runReconciliation();
    res.json({ ok: true, ...results });
  } catch (error) {
    log.error({ err: error }, 'Cron reconciliation error');
    res.status(500).json({ error: error.message });
  }
});

// Cron: resync estados con TiendaNube (llamado por Cloud Scheduler)
app.post('/resync-estados/cron', verifyCronAuth, async (req, res) => {
  log.info({ authMethod: req.cronAuth?.method }, 'Cron resync-estados started');
  try {
    const storeId = process.env.TIENDANUBE_STORE_ID;
    const [syncPayment, syncShipping] = await Promise.all([
      isIntegrationEnabled('tiendanube_webhook_sync_payment', { context: 'cron:resync-estados:payment' }),
      isIntegrationEnabled('tiendanube_webhook_sync_shipping', { context: 'cron:resync-estados:shipping' }),
    ]);

    // Solo pedidos recientes (últimos 7 días) para el cron diario
    const ordersRes = await pool.query(`
      SELECT order_number, tn_order_id, tn_payment_status, tn_shipping_status,
             estado_pago, estado_pedido, monto_tiendanube, shipping_type
      FROM orders_validated
      WHERE tn_order_id IS NOT NULL AND estado_pedido != 'cancelado'
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
    `);

    let corregidos = 0, errores = 0;

    for (const db of ordersRes.rows) {
      try {
        const pedidoRes = await callTiendanube({
          method: 'get',
          url: `https://api.tiendanube.com/v1/${storeId}/orders/${db.tn_order_id}`,
          headers: { authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`, 'User-Agent': 'bpm-cron-resync' },
          timeout: 10000
        });
        const tn = pedidoRes.data;

        const setClauses = ['updated_at = NOW()'];
        const setParams = [];
        let paramIdx = 2;
        let cambios = [];

        if (tn.status === 'cancelled' && db.estado_pedido !== 'cancelado') {
          setClauses.push(`estado_pedido = 'cancelado'`);
          cambios.push('cancelado');
        }

        if (syncPayment && tn.payment_status !== db.tn_payment_status) {
          setClauses.push(`tn_payment_status = $${paramIdx++}`);
          setParams.push(tn.payment_status);
          setClauses.push(`tn_paid_at = $${paramIdx++}`);
          setParams.push(tn.paid_at || null);
          const tnTotalPaid = Math.round(Number(tn.total_paid || 0));
          setClauses.push(`tn_total_paid = $${paramIdx++}`);
          setParams.push(tnTotalPaid);
          setClauses.push(`tn_gateway = $${paramIdx++}`);
          setParams.push(tn.gateway || null);
          if (tn.payment_status === 'paid') {
            const pagoOnline = tnTotalPaid > 0 ? tnTotalPaid : Math.round(Number(tn.total));
            setClauses.push(`pago_online_tn = $${paramIdx++}`);
            setParams.push(pagoOnline);
          } else if (tn.payment_status === 'partially_paid') {
            setClauses.push(`pago_online_tn = $${paramIdx++}`);
            setParams.push(tnTotalPaid);
          } else if (tn.payment_status === 'refunded') {
            setClauses.push(`estado_pago = 'reembolsado'`);
            setClauses.push(`pago_online_tn = 0`);
          } else if (tn.payment_status === 'voided') {
            setClauses.push(`estado_pago = 'anulado'`);
            setClauses.push(`pago_online_tn = 0`);
          } else if (tn.payment_status === 'partially_refunded') {
            setClauses.push(`pago_online_tn = $${paramIdx++}`);
            setParams.push(tnTotalPaid);
          } else if (tn.payment_status === 'pending') {
            setClauses.push(`pago_online_tn = 0`);
          }
          cambios.push(`pago: ${db.tn_payment_status} → ${tn.payment_status}`);
        }

        const tnShipStatusCron = tn.shipping_status || null;
        const tnShipCarrierCron = tn.shipping || null;
        const tnFulfillStatusCron = tn.fulfillments?.[0]?.status || null;
        // Solo comparar shipping_status real (no carrier) — y solo si realmente cambió
        if (syncShipping && tn.status !== 'cancelled' && (tnShipStatusCron !== db.tn_shipping_status || (tnFulfillStatusCron && tnFulfillStatusCron !== 'UNPACKED'))) {
          setClauses.push(`tn_shipping_status = $${paramIdx++}`);
          setParams.push(tnShipStatusCron);
          const nuevoEstado = mapShippingToEstadoPedido(tnShipStatusCron, tnShipCarrierCron, db.shipping_type || '', db.estado_pedido, { fulfillmentStatus: tnFulfillStatusCron });
          if (nuevoEstado) {
            setClauses.push(`estado_pedido = $${paramIdx++}`);
            setParams.push(nuevoEstado);
            if (['enviado', 'en_calle', 'retirado'].includes(nuevoEstado)) {
              setClauses.push(`shipped_at = COALESCE(shipped_at, NOW())`);
            }
            cambios.push(`envío: ${nuevoEstado}`);
          }
        }

        if (setClauses.length > 1) {
          await pool.query(`UPDATE orders_validated SET ${setClauses.join(', ')} WHERE order_number = $1`, [db.order_number, ...setParams]);
          if (syncPayment && tn.payment_status !== db.tn_payment_status) {
            await recalcularPagos(pool, db.order_number);
          }
          await logEvento({ orderNumber: db.order_number, accion: `Resync cron: ${cambios.join(', ')}`, origen: 'cron_resync' });
          corregidos++;
        }

        // Detectar divergencias remanentes post-resync
        try {
          const divDetectionEnabled = await isIntegrationEnabled('tiendanube_divergence_detection', { context: 'cron:divergence' });
          if (divDetectionEnabled) {
            const bpmPostResync = await getBpmOrderForComparison(db.order_number);
            if (bpmPostResync) {
              const toggleMap = {
                tiendanube_webhook_sync_payment: syncPayment,
                tiendanube_webhook_sync_shipping: syncShipping,
              };
              const divReport = buildDivergenceReport(tn, bpmPostResync, { toggles: toggleMap });
              if (divReport.divergences.length > 0) {
                await saveDivergences(db.order_number, db.tn_order_id, divReport.divergences, 'cron');
                // Auto-fix solo divergencias seguras si toggle habilitado
                const autofixEnabled = await isIntegrationEnabled('tiendanube_divergence_autofix', { context: 'cron:autofix' });
                if (autofixEnabled) {
                  await applyAutoFixes(db.order_number, divReport.divergences, {
                    fixedBy: 'auto:cron',
                    toggles: toggleMap,
                  });
                }
              }
            }
          }
        } catch (divErr) {
          log.error({ err: divErr, orderNumber: db.order_number }, 'Error detecting divergences in cron');
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        errores++;
      }
    }

    log.info({ total: ordersRes.rowCount, corregidos, errores }, 'Cron resync-estados completed');
    res.json({ ok: true, total: ordersRes.rowCount, corregidos, errores });
  } catch (error) {
    log.error({ err: error }, 'Cron resync-estados error');
    res.status(500).json({ error: error.message });
  }
});

// Ejecutar sincronización manual
app.post('/sync/run', authenticate, requirePermission('users.view'), async (req, res) => {
  const source = `manual-${req.user.email}`;
  log.info({ source, email: req.user.email }, 'Manual sync requested');

  try {
    const result = await triggerSync(source);

    if (result.status === 'skipped') {
      // Otra instancia tiene el lock
      return res.status(202).json({
        ok: true,
        status: 'skipped',
        message: 'Otra instancia está ejecutando sync'
      });
    }

    // Completado exitosamente
    res.json({ ok: true, status: 'completed', result: result.result });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para ver estado del sync (debugging)
app.get('/sync/lock-status', authenticate, (req, res) => {
  res.json({ ok: true, ...getSyncStatus() });
});

// Image sync endpoints
const imageSync = require('./services/tiendanubeImageSync');

app.get('/sync/image-sync-status', authenticate, requirePermission('activity.view'), (req, res) => {
  const latest = imageSync.getLatestRun();
  res.json({ ok: true, lastRun: latest });
});

app.get('/sync/image-sync-runs', authenticate, requirePermission('activity.view'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const runs = imageSync.getRunHistory(limit);
  res.json({ ok: true, runs });
});

app.get('/sync/image-sync-runs/:runId', authenticate, requirePermission('activity.view'), (req, res) => {
  const detail = imageSync.getRunDetail(req.params.runId);
  if (!detail) {
    return res.json({ ok: true, run: null });
  }
  res.json({ ok: true, run: detail });
});

app.post('/sync/image-sync-trigger', authenticate, requirePermission('activity.view'), async (req, res) => {
  const dryRun = req.body?.dry_run === true;
  // Lanzar en background, responder inmediatamente
  imageSync.syncProductImages({ dryRun, triggerSource: 'panel' })
    .then(result => {
      if (result) {
        console.log(`✅ [ImageSync] Corrida manual desde panel finalizada (${result.run_id})`);
      }
    })
    .catch(err => {
      console.error(`❌ [ImageSync] Error en corrida manual desde panel: ${err.message}`);
    });

  res.json({ ok: true, message: 'Sync iniciado' });
});

/* =====================================================
   CUSTOMER SYNC (Tiendanube → customers table)
===================================================== */

// Estado del sync de clientes
app.get('/sync/customers/status', authenticate, requirePermission('customers.view'), async (req, res) => {
  try {
    const lastSync = await customerSync.getLastSyncTimestamp();
    const countResult = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN tn_customer_id IS NOT NULL THEN 1 END) as synced,
        COUNT(CASE WHEN segment IS NOT NULL THEN 1 END) as segmented
      FROM customers
    `);
    const stats = countResult.rows[0];

    res.json({
      ok: true,
      lastSync,
      total: parseInt(stats.total),
      synced: parseInt(stats.synced),
      segmented: parseInt(stats.segmented)
    });
  } catch (error) {
    console.error('❌ /sync/customers/status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Full sync de clientes (manual)
app.post('/sync/customers/full', authenticate, requirePermission('customers.sync'), async (req, res) => {
  try {
    console.log(`🔄 [CustomerSync] Full sync iniciado por ${req.user.username}`);

    // Ejecutar en background
    customerSync.fullSync()
      .then(result => {
        console.log(`✅ [CustomerSync] Full sync completado:`, result);
      })
      .catch(err => {
        console.error(`❌ [CustomerSync] Error en full sync:`, err.message);
      });

    res.json({ ok: true, message: 'Full sync iniciado en background' });
  } catch (error) {
    console.error('❌ /sync/customers/full error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Incremental sync de clientes
app.post('/sync/customers/incremental', authenticate, requirePermission('customers.sync'), async (req, res) => {
  try {
    console.log(`🔄 [CustomerSync] Incremental sync iniciado por ${req.user.username}`);

    // Ejecutar en background
    customerSync.incrementalSync()
      .then(result => {
        console.log(`✅ [CustomerSync] Incremental sync completado:`, result);
      })
      .catch(err => {
        console.error(`❌ [CustomerSync] Error en incremental sync:`, err.message);
      });

    res.json({ ok: true, message: 'Incremental sync iniciado en background' });
  } catch (error) {
    console.error('❌ /sync/customers/incremental error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Sync orders_count from TN orders API (llenar datos que customers API no provee)
// ?method=byCustomer para usar la versión más robusta (consulta por cliente)
// ?method=byPages para usar la versión tradicional (pagina todas las órdenes)
// IMPORTANTE: Esta ruta debe estar ANTES de /sync/customers/:tnCustomerId
app.post('/sync/customers/orders-count', authenticate, requirePermission('customers.sync'), async (req, res) => {
  try {
    const method = req.query.method || 'byCustomer'; // Default to more robust method
    console.log(`📦 [CustomerSync] Sync orders_count iniciado por ${req.user.username} (method: ${method})`);

    // Ejecutar en background (sync toma ~2 horas para 1000+ clientes)
    const syncFn = method === 'byCustomer'
      ? customerSync.syncOrdersCountByCustomer
      : customerSync.syncOrdersCountFromTN;

    syncFn()
      .then(result => {
        console.log(`✅ [CustomerSync] Sync orders_count completado:`, result);
      })
      .catch(err => {
        console.error(`❌ [CustomerSync] Error en sync orders_count:`, err.message);
      });

    res.json({ ok: true, method, message: 'Sync iniciado en background. Tomará ~2 horas.' });
  } catch (error) {
    console.error('❌ /sync/customers/orders-count error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Sync de un cliente específico
// IMPORTANTE: Esta ruta con :tnCustomerId debe estar DESPUÉS de las rutas específicas
app.post('/sync/customers/:tnCustomerId', authenticate, requirePermission('customers.sync'), async (req, res) => {
  try {
    const { tnCustomerId } = req.params;
    const result = await customerSync.syncSingleCustomer(parseInt(tnCustomerId));

    if (result.notFound) {
      return res.status(404).json({ error: 'Cliente no encontrado en Tiendanube' });
    }

    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('❌ /sync/customers/:id error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   CUSTOMER METRICS & SEGMENTATION
===================================================== */

// Recalcular métricas de todos los clientes
app.post('/customers/metrics/recalculate', authenticate, requirePermission('customers.segment'), async (req, res) => {
  try {
    console.log(`📊 [CustomerMetrics] Recálculo iniciado por ${req.user.username}`);
    const result = await customerMetrics.recalculateAllMetrics();
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('❌ /customers/metrics/recalculate error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Obtener métricas globales
app.get('/customers/metrics', authenticate, requirePermission('customers.view'), async (req, res) => {
  try {
    const metrics = await customerMetrics.getGlobalMetrics();
    res.json({ ok: true, metrics });
  } catch (error) {
    console.error('❌ /customers/metrics error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Recalcular segmentos de todos los clientes
app.post('/customers/segments/recalculate', authenticate, requirePermission('customers.segment'), async (req, res) => {
  try {
    console.log(`🏷️ [CustomerSegmentation] Recálculo iniciado por ${req.user.username}`);
    const result = await customerSegmentation.segmentAllCustomers();
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('❌ /customers/segments/recalculate error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Obtener conteo por segmento
app.get('/customers/segments', authenticate, requirePermission('customers.view'), async (req, res) => {
  try {
    // mode: 'lifecycle' (default, RFM), 'top_spenders', 'top_buyers'
    const mode = req.query.mode || 'lifecycle';
    const { counts, definitions } = await customerSegmentation.getSegmentCountsByMode(mode);
    res.json({ ok: true, counts, definitions, mode });
  } catch (error) {
    console.error('❌ /customers/segments error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Obtener clientes de un segmento específico
app.get('/customers/segments/:segment', authenticate, requirePermission('customers.view'), async (req, res) => {
  try {
    const { segment } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const mode = req.query.mode || 'lifecycle';
    const search = req.query.search || null;
    const sortBy = req.query.sortBy || 'total_spent';
    const sortDir = req.query.sortDir || 'desc';

    const result = await customerSegmentation.getCustomersBySegmentAndMode(
      segment, mode, { page, limit, search, sortBy, sortDir }
    );
    res.json({ ok: true, ...result, mode });
  } catch (error) {
    console.error('❌ /customers/segments/:segment error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Listar todos los clientes con filtros
app.get('/customers', authenticate, requirePermission('customers.view'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const segment = req.query.segment || null;
    const search = req.query.search || null;
    const mode = req.query.mode || 'lifecycle';
    const sortBy = req.query.sortBy || 'total_spent';
    const sortDir = req.query.sortDir || 'desc';

    // Para modos de percentil, usar función especial
    if (mode !== 'lifecycle') {
      const result = await customerSegmentation.getCustomersBySegmentAndMode(
        segment, mode, { page, limit, search, sortBy, sortDir }
      );
      return res.json({ ok: true, ...result, mode });
    }

    // Modo lifecycle: usar query SQL directa
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (segment) {
      whereClause += ` AND segment = $${paramIndex}`;
      params.push(segment);
      paramIndex++;
    }

    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM customers ${whereClause}`,
      params
    );

    // Construir ORDER BY dinámico
    const validSortFields = ['total_spent', 'orders_count', 'last_order_at', 'name', 'created_at'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'total_spent';
    const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';
    const nullsPosition = sortDirection === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';

    const { rows } = await pool.query(`
      SELECT
        id, tn_customer_id, name, email, phone,
        orders_count, total_spent, first_order_at, last_order_at, avg_order_value,
        segment, segment_updated_at, created_at
      FROM customers
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection} ${nullsPosition}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, limit, offset]);

    res.json({
      ok: true,
      customers: rows,
      total: parseInt(countResult.rows[0].total),
      page,
      limit,
      mode
    });
  } catch (error) {
    console.error('❌ /customers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Scheduler: ejecutar sync cada 15 minutos
const SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutos
let syncInterval = null;
let cleanupInterval = null;
let reconciliationInterval = null;

function startSyncScheduler() {
  if (syncInterval) return;

  log.info('Sync scheduler started (every 5 min)');

  // Primera ejecución después de 30 segundos
  setTimeout(() => {
    triggerSync('startup-30s').catch(err => {
      log.error({ err }, 'Error in startup sync');
    });
  }, 30000);

  // Luego cada 5 minutos
  syncInterval = setInterval(() => {
    triggerSync('interval-5min').catch(err => {
      log.error({ err }, 'Error in scheduled sync');
    });
  }, SYNC_INTERVAL);

  // Image sync: reordenar imagen principal 1 vez al día a las 3:00 AM Argentina
  const { startScheduler: startImageSyncScheduler } = require('./services/tiendanubeImageSync');
  if (process.env.TIENDANUBE_STORE_ID && process.env.TIENDANUBE_ACCESS_TOKEN) {
    const now = new Date();
    const argNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    let next3am = new Date(argNow);
    next3am.setHours(3, 0, 0, 0);
    if (argNow >= next3am) next3am.setDate(next3am.getDate() + 1);
    const msUntil3am = next3am.getTime() - argNow.getTime();
    console.log(`⏰ [ImageSync] Programado para las 3:00 AM (en ${Math.round(msUntil3am / 1000 / 60)} min)`);
    setTimeout(() => {
      startImageSyncScheduler(24 * 60 * 60 * 1000); // cada 24 horas
    }, msUntil3am);

    // TN Payment Divergence check: también a las 3:00 AM (5 min después del image sync)
    const { checkTnPaymentDivergences } = require('./lib/tnPaymentDivergence');
    setTimeout(() => {
      // Primera ejecución
      checkTnPaymentDivergences().catch(err => {
        console.error('[TN Divergence] Error:', err.message);
      });
      // Luego cada 24 horas
      setInterval(() => {
        checkTnPaymentDivergences().catch(err => {
          console.error('[TN Divergence] Error:', err.message);
        });
      }, 24 * 60 * 60 * 1000);
    }, msUntil3am + 5 * 60 * 1000); // 5 minutos después de las 3am
    console.log(`⏰ [TN Divergence] Programado para las 3:05 AM`);
  }

  // Cleanup: limpiar registros antiguos una vez al día
  const { runCleanup } = require('./lib/cleanup');
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 horas
  // Primera ejecución después de 5 minutos
  setTimeout(() => {
    runCleanup().catch(err => {
      console.error('[Cleanup] Error in initial cleanup:', err.message);
    });
  }, 5 * 60 * 1000);
  // Luego cada 24 horas
  cleanupInterval = setInterval(() => {
    runCleanup().catch(err => {
      console.error('[Cleanup] Error in scheduled cleanup:', err.message);
    });
  }, CLEANUP_INTERVAL);
}

/* =====================================================
   NOTIFICACIONES
===================================================== */

// Obtener notificaciones del usuario
app.get('/notifications', authenticate, async (req, res) => {
  try {
    const notifications = await getNotificaciones(req.user.id);
    const unreadCount = await contarNoLeidas(req.user.id);

    res.json({
      ok: true,
      notifications,
      unread_count: unreadCount
    });
  } catch (error) {
    console.error('❌ /notifications error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Marcar una notificación como leída
app.patch('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    await marcarLeida(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ /notifications/:id/read error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Marcar todas las notificaciones como leídas
app.post('/notifications/read-all', authenticate, async (req, res) => {
  try {
    await marcarTodasLeidas(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ /notifications/read-all error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Eliminar TODAS las notificaciones del usuario (debe ir ANTES de :id)
app.delete('/notifications/all', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM notifications WHERE user_id = $1 RETURNING id',
      [req.user.id]
    );

    console.log(`🗑️ ${result.rowCount} notificaciones eliminadas por usuario ${req.user.id}`);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (error) {
    console.error('❌ DELETE /notifications/all error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Eliminar todas las notificaciones leídas (debe ir ANTES de :id)
app.delete('/notifications/read', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM notifications WHERE user_id = $1 AND leida = true RETURNING id',
      [req.user.id]
    );

    console.log(`🗑️ ${result.rowCount} notificaciones leídas eliminadas por usuario ${req.user.id}`);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (error) {
    console.error('❌ DELETE /notifications/read error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Eliminar una notificación específica (debe ir DESPUÉS de rutas específicas)
app.delete('/notifications/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Notificación no encontrada' });
    }

    console.log(`🗑️ Notificación ${id} eliminada por usuario ${req.user.id}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ DELETE /notifications/:id error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   SHIPPING DATA - Formulario público de datos de envío
   Para clientes con método "Transporte a elección"
===================================================== */

app.post('/shipping-data', shippingFormLimiter, async (req, res) => {
  try {
    const {
      order_number,
      empresa_envio,
      empresa_envio_otro,
      destino_tipo,
      direccion_entrega,
      nombre_apellido,
      dni,
      email,
      codigo_postal,
      provincia,
      localidad,
      telefono,
      comentarios
    } = req.body;

    // Sanitizar número de pedido: solo números
    const sanitizedOrderNumber = (order_number || '').replace(/[^0-9]/g, '');

    // Validaciones
    const errors = [];

    if (!sanitizedOrderNumber) {
      errors.push('Número de pedido es obligatorio');
    }
    if (!empresa_envio || !['VIA_CARGO', 'OTRO'].includes(empresa_envio)) {
      errors.push('Empresa de envío inválida');
    }
    if (empresa_envio === 'OTRO' && !empresa_envio_otro?.trim()) {
      errors.push('Debe especificar el nombre de la empresa de envío');
    }
    if (!destino_tipo || !['SUCURSAL', 'DOMICILIO'].includes(destino_tipo)) {
      errors.push('Tipo de destino inválido');
    }
    if (!direccion_entrega?.trim()) errors.push('Dirección de entrega es obligatoria');
    if (!nombre_apellido?.trim()) errors.push('Nombre y apellido es obligatorio');
    if (!dni?.trim()) errors.push('DNI es obligatorio');
    if (!email?.trim()) errors.push('Email es obligatorio');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Email tiene formato inválido');
    }
    if (!codigo_postal?.trim()) errors.push('Código postal es obligatorio');
    if (!provincia?.trim()) errors.push('Provincia es obligatoria');
    if (!localidad?.trim()) errors.push('Localidad es obligatoria');
    if (!telefono?.trim()) errors.push('Teléfono es obligatorio');

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', '), errors });
    }

    // Validar que el pedido exista y tenga "Transporte a elección"
    const orderRes = await pool.query(
      'SELECT order_number, shipping_type FROM orders_validated WHERE order_number = $1 LIMIT 1',
      [sanitizedOrderNumber]
    );

    if (orderRes.rows.length === 0) {
      return res.status(400).json({
        error: 'No existe un pedido con ese número',
        errors: ['No existe un pedido con ese número']
      });
    }

    // Validar que el pedido requiera formulario de envío (Expreso a elección o Via Cargo)
    if (!requiresShippingForm(orderRes.rows[0].shipping_type)) {
      return res.status(400).json({
        error: 'Este formulario es solo para pedidos con envío por Expreso a elección o Via Cargo',
        errors: ['Este formulario es solo para pedidos con envío por Expreso a elección o Via Cargo']
      });
    }

    // Sanitizar datos
    const sanitize = (str) => str?.trim() || null;

    // Borrar registro anterior si existe (evita duplicados si el cliente envía dos veces)
    await pool.query('DELETE FROM shipping_requests WHERE order_number = $1', [sanitizedOrderNumber]);

    const result = await pool.query(`
      INSERT INTO shipping_requests (
        order_number, empresa_envio, empresa_envio_otro, destino_tipo,
        direccion_entrega, nombre_apellido, dni, email,
        codigo_postal, provincia, localidad, telefono, comentarios
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, created_at
    `, [
      sanitizedOrderNumber,
      empresa_envio,
      empresa_envio === 'OTRO' ? sanitize(empresa_envio_otro) : null,
      destino_tipo,
      sanitize(direccion_entrega),
      sanitize(nombre_apellido),
      sanitize(dni),
      sanitize(email)?.toLowerCase(),
      sanitize(codigo_postal),
      sanitize(provincia),
      sanitize(localidad),
      sanitize(telefono),
      sanitize(comentarios)
    ]);

    console.log(`📦 Datos de envío registrados para pedido ${sanitizedOrderNumber}`);

    await logEvento({ orderNumber: sanitizedOrderNumber, accion: 'datos_envio_registrados', origen: 'cliente' });

    res.json({
      ok: true,
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      message: 'Datos de envío registrados correctamente'
    });

  } catch (error) {
    console.error('❌ POST /shipping-data error:', error.message);
    res.status(500).json({ error: 'Error al guardar los datos de envío' });
  }
});

/**
 * POST /shipping-data/bulk
 * Endpoint para testing - cargar múltiples shipping requests via Postman
 * Body: { requests: [...], skip_order_validation: true }
 */
app.post('/shipping-data/bulk', authenticate, async (req, res) => {
  try {
    const { requests, skip_order_validation = false } = req.body;

    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({ error: 'requests debe ser un array con al menos un elemento' });
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      const idx = i + 1;

      try {
        const sanitizedOrderNumber = (r.order_number || '').toString().replace(/[^0-9]/g, '');

        if (!sanitizedOrderNumber) {
          errors.push({ index: idx, error: 'order_number es obligatorio' });
          continue;
        }

        // Validar que el pedido exista (a menos que se omita para testing)
        if (!skip_order_validation) {
          const orderExists = await pool.query(
            'SELECT 1 FROM orders_validated WHERE order_number = $1 LIMIT 1',
            [sanitizedOrderNumber]
          );
          if (orderExists.rows.length === 0) {
            errors.push({ index: idx, order_number: sanitizedOrderNumber, error: 'Pedido no existe' });
            continue;
          }
        }

        const sanitize = (str) => str?.trim() || null;

        // Borrar registro anterior si existe (para permitir re-testing)
        await pool.query('DELETE FROM shipping_requests WHERE order_number = $1', [sanitizedOrderNumber]);

        const result = await pool.query(`
          INSERT INTO shipping_requests (
            order_number, empresa_envio, empresa_envio_otro, destino_tipo,
            direccion_entrega, nombre_apellido, dni, email,
            codigo_postal, provincia, localidad, telefono, comentarios
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id, created_at
        `, [
          sanitizedOrderNumber,
          r.empresa_envio || 'VIA_CARGO',
          r.empresa_envio === 'OTRO' ? sanitize(r.empresa_envio_otro) : null,
          r.destino_tipo || 'DOMICILIO',
          sanitize(r.direccion_entrega),
          sanitize(r.nombre_apellido),
          sanitize(r.dni) || '00000000',
          sanitize(r.email)?.toLowerCase() || 'test@test.com',
          sanitize(r.codigo_postal) || '0000',
          sanitize(r.provincia),
          sanitize(r.localidad),
          sanitize(r.telefono) || '0000000000',
          sanitize(r.comentarios)
        ]);

        results.push({
          index: idx,
          order_number: sanitizedOrderNumber,
          id: result.rows[0].id,
          created_at: result.rows[0].created_at
        });

      } catch (err) {
        errors.push({ index: idx, order_number: r.order_number, error: err.message });
      }
    }

    console.log(`📦 Bulk shipping-data: ${results.length} insertados, ${errors.length} errores`);

    res.json({
      ok: true,
      inserted: results.length,
      failed: errors.length,
      results,
      errors
    });

  } catch (error) {
    console.error('❌ POST /shipping-data/bulk error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /orders/:orderNumber/shipping-request
 * Obtener datos de envío para un pedido (si existen)
 */
app.get('/orders/:orderNumber/shipping-request', authenticate, async (req, res) => {
  try {
    const { orderNumber } = req.params;

    const result = await pool.query(`
      SELECT * FROM shipping_requests
      WHERE order_number = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [orderNumber]);

    if (result.rows.length === 0) {
      return res.json({ ok: true, shipping_request: null });
    }

    res.json({ ok: true, shipping_request: result.rows[0] });
  } catch (error) {
    console.error('❌ GET /orders/:orderNumber/shipping-request error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /orders/:orderNumber/shipping-label
 * Generar PDF de etiqueta para envío por expreso
 * Query params: bultos (número de copias)
 */
app.get('/orders/:orderNumber/shipping-label', authenticate, async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const bultos = Math.min(Math.max(parseInt(req.query.bultos) || 1, 1), 10); // 1-10 bultos

    // 1. Obtener datos del shipping_request
    const shippingRes = await pool.query(`
      SELECT * FROM shipping_requests
      WHERE order_number = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [orderNumber]);

    if (shippingRes.rows.length === 0) {
      return res.status(404).json({ error: 'No hay datos de envío para este pedido' });
    }

    const shipping = shippingRes.rows[0];

    // 2. Obtener datos del pedido
    const orderRes = await pool.query(`
      SELECT order_number, customer_name, customer_phone, monto_tiendanube
      FROM orders_validated
      WHERE order_number = $1
    `, [orderNumber]);

    const order = orderRes.rows[0] || {};

    // 3. Generar PDF
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: {
        Title: `Etiqueta Envío - Pedido #${orderNumber}`
      }
    });

    // Headers para descarga
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=etiqueta-${orderNumber}.pdf`);

    doc.pipe(res);

    // Datos del remitente (fijos)
    const remitente = {
      nombre: 'Blanqueriaxmayor',
      domicilio: 'Av Gaona 2376',
      localidad: 'Flores',
      cel: '1134918721',
      dni: '41823314'
    };

    // Empresa de envío
    const empresaEnvio = shipping.empresa_envio === 'OTRO'
      ? shipping.empresa_envio_otro
      : 'VÍA CARGO';

    // Generar N páginas (una por bulto)
    for (let i = 0; i < bultos; i++) {
      if (i > 0) doc.addPage();

      const y = 50;

      // Todo el PDF en Helvetica-Bold (similar a Arial Bold), tamaño 16
      doc.font('Helvetica-Bold').fontSize(16);

      // === HEADER ===
      doc.text(`PEDIDO #${orderNumber}`, 40, y, { align: 'center' });
      doc.text(`Bulto ${i + 1} de ${bultos}`, 40, y + 25, { align: 'center' });

      // Línea separadora
      doc.moveTo(40, y + 55).lineTo(555, y + 55).stroke();

      // === EMPRESA DE ENVÍO ===
      doc.text(empresaEnvio.toUpperCase(), 40, y + 75, { align: 'center' });
      doc.text(`Tipo: ${shipping.destino_tipo === 'SUCURSAL' ? 'Retiro en Sucursal' : 'Envío a Domicilio'}`, 40, y + 100, { align: 'center' });

      // Línea separadora
      doc.moveTo(40, y + 130).lineTo(555, y + 130).stroke();

      // === DESTINATARIO ===
      let destY = y + 150;
      doc.text('DESTINATARIO', 40, destY);
      destY += 28;

      doc.text(`Nombre: ${shipping.nombre_apellido.toUpperCase()}`, 40, destY);
      destY += 24;

      doc.text(`DNI: ${shipping.dni}`, 40, destY);
      destY += 24;

      doc.text(`Domicilio: ${shipping.direccion_entrega}`, 40, destY);
      destY += 24;

      doc.text(`Localidad: ${shipping.localidad}, ${shipping.provincia}`, 40, destY);
      destY += 24;

      doc.text(`CP: ${shipping.codigo_postal}`, 40, destY);
      destY += 24;

      doc.text(`Tel: ${shipping.telefono}`, 40, destY);
      destY += 24;

      doc.text(`Email: ${shipping.email}`, 40, destY);

      // Línea separadora
      destY += 35;
      doc.moveTo(40, destY).lineTo(555, destY).stroke();

      // === REMITENTE ===
      destY += 20;
      doc.text('REMITENTE', 40, destY);
      destY += 28;

      doc.text(`Nombre: ${remitente.nombre}`, 40, destY);
      destY += 24;

      doc.text(`Domicilio: ${remitente.domicilio}`, 40, destY);
      destY += 24;

      doc.text(`Localidad: ${remitente.localidad}`, 40, destY);
      destY += 24;

      doc.text(`Cel: ${remitente.cel}`, 40, destY);
      destY += 24;

      doc.text(`DNI: ${remitente.dni}`, 40, destY);

      // === COMENTARIOS (si hay) ===
      if (shipping.comentarios) {
        destY += 40;
        doc.moveTo(40, destY).lineTo(555, destY).stroke();
        destY += 20;

        doc.text('COMENTARIOS', 40, destY);
        destY += 28;

        doc.text(shipping.comentarios, 40, destY, {
          width: 515,
          align: 'left'
        });
      }

    }

    doc.end();

    // Marcar como impresa SOLO cuando el cliente recibió el PDF completo
    res.on('finish', async () => {
      try {
        await pool.query(`
          UPDATE shipping_requests
          SET label_printed_at = NOW(),
              label_bultos = COALESCE(label_bultos, 0) + $1
          WHERE id = $2
        `, [bultos, shipping.id]);

        await logEvento({
          orderNumber,
          accion: `etiqueta_impresa_${bultos}_bultos`,
          origen: 'crm',
          userId: req.user?.id,
          username: req.user?.name
        });

        console.log(`🏷️ Etiqueta generada para pedido ${orderNumber} (${bultos} bultos)`);
      } catch (err) {
        console.error(`❌ Error registrando impresión de etiqueta ${orderNumber}:`, err.message);
      }
    });

  } catch (error) {
    console.error('❌ GET /orders/:orderNumber/shipping-label error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /orders/shipping-labels-batch
 * Generar UN SOLO PDF con etiquetas de múltiples pedidos
 * Body: { orders: [{ orderNumber: "31071", bultos: 1 }, ...] }
 */
app.post('/orders/shipping-labels-batch', authenticate, async (req, res) => {
  try {
    const { orders: orderList } = req.body;

    if (!orderList || !Array.isArray(orderList) || orderList.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de pedidos' });
    }

    if (orderList.length > 50) {
      return res.status(400).json({ error: 'Máximo 50 pedidos por batch' });
    }

    // Datos del remitente (fijos)
    const remitente = {
      nombre: 'Blanqueriaxmayor',
      domicilio: 'Av Gaona 2376',
      localidad: 'Flores',
      cel: '1134918721',
      dni: '41823314'
    };

    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: `Etiquetas Envío - ${orderList.length} pedidos` }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=etiquetas-batch-${Date.now()}.pdf`);
    doc.pipe(res);

    const shippingIds = []; // Para marcar como impresas después
    let isFirstPage = true;

    for (const item of orderList) {
      const orderNumber = item.orderNumber;
      const bultos = Math.min(Math.max(parseInt(item.bultos) || 1, 1), 10);

      const shippingRes = await pool.query(`
        SELECT * FROM shipping_requests
        WHERE order_number = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [orderNumber]);

      if (shippingRes.rows.length === 0) {
        console.warn(`⚠️ Batch label: no shipping data for ${orderNumber}, skipping`);
        continue;
      }

      const shipping = shippingRes.rows[0];
      shippingIds.push({ id: shipping.id, bultos, orderNumber });

      const orderRes = await pool.query(`
        SELECT order_number, customer_name, customer_phone, monto_tiendanube
        FROM orders_validated
        WHERE order_number = $1
      `, [orderNumber]);

      const order = orderRes.rows[0] || {};

      const empresaEnvio = shipping.empresa_envio === 'OTRO'
        ? shipping.empresa_envio_otro
        : 'VÍA CARGO';

      for (let i = 0; i < bultos; i++) {
        if (!isFirstPage) doc.addPage();
        isFirstPage = false;

        const y = 50;
        doc.font('Helvetica-Bold').fontSize(16);

        doc.text(`PEDIDO #${orderNumber}`, 40, y, { align: 'center' });
        doc.text(`Bulto ${i + 1} de ${bultos}`, 40, y + 25, { align: 'center' });
        doc.moveTo(40, y + 55).lineTo(555, y + 55).stroke();

        doc.text(empresaEnvio.toUpperCase(), 40, y + 75, { align: 'center' });
        doc.text(`Tipo: ${shipping.destino_tipo === 'SUCURSAL' ? 'Retiro en Sucursal' : 'Envío a Domicilio'}`, 40, y + 100, { align: 'center' });
        doc.moveTo(40, y + 130).lineTo(555, y + 130).stroke();

        let destY = y + 150;
        doc.text('DESTINATARIO', 40, destY);
        destY += 28;
        doc.text(`Nombre: ${shipping.nombre_apellido.toUpperCase()}`, 40, destY);
        destY += 24;
        doc.text(`DNI: ${shipping.dni}`, 40, destY);
        destY += 24;
        doc.text(`Domicilio: ${shipping.direccion_entrega}`, 40, destY);
        destY += 24;
        doc.text(`Localidad: ${shipping.localidad}, ${shipping.provincia}`, 40, destY);
        destY += 24;
        doc.text(`CP: ${shipping.codigo_postal}`, 40, destY);
        destY += 24;
        doc.text(`Tel: ${shipping.telefono}`, 40, destY);
        destY += 24;
        doc.text(`Email: ${shipping.email}`, 40, destY);

        destY += 35;
        doc.moveTo(40, destY).lineTo(555, destY).stroke();

        destY += 20;
        doc.text('REMITENTE', 40, destY);
        destY += 28;
        doc.text(`Nombre: ${remitente.nombre}`, 40, destY);
        destY += 24;
        doc.text(`Domicilio: ${remitente.domicilio}`, 40, destY);
        destY += 24;
        doc.text(`Localidad: ${remitente.localidad}`, 40, destY);
        destY += 24;
        doc.text(`Cel: ${remitente.cel}`, 40, destY);
        destY += 24;
        doc.text(`DNI: ${remitente.dni}`, 40, destY);

        if (shipping.comentarios) {
          destY += 40;
          doc.moveTo(40, destY).lineTo(555, destY).stroke();
          destY += 20;
          doc.text('COMENTARIOS', 40, destY);
          destY += 28;
          doc.text(shipping.comentarios, 40, destY, { width: 515, align: 'left' });
        }
      }
    }

    doc.end();

    // Marcar como impresas SOLO cuando el cliente recibió el PDF completo
    res.on('finish', async () => {
      try {
        for (const { id, bultos, orderNumber } of shippingIds) {
          await pool.query(`
            UPDATE shipping_requests
            SET label_printed_at = NOW(),
                label_bultos = COALESCE(label_bultos, 0) + $1
            WHERE id = $2
          `, [bultos, id]);

          await logEvento({
            orderNumber,
            accion: `etiqueta_impresa_${bultos}_bultos`,
            origen: 'crm',
            userId: req.user?.id,
            username: req.user?.name
          });
        }
        console.log(`🏷️ Batch: ${shippingIds.length} etiquetas generadas`);
      } catch (err) {
        console.error('❌ Error registrando batch de etiquetas:', err.message);
      }
    });

  } catch (error) {
    console.error('❌ POST /orders/shipping-labels-batch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   TIENDANUBE - OAUTH CALLBACK
===================================================== */

/**
 * GET /tiendanube/callback
 * Callback para autorización OAuth de Tiendanube
 * Recibe el code y lo intercambia por access_token
 */
app.get('/tiendanube/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Error: No se recibió código de autorización');
  }

  try {
    // Intercambiar code por access_token
    const response = await axios.post('https://www.tiendanube.com/apps/authorize/token', {
      client_id: '25216',
      client_secret: process.env.TIENDANUBE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code
    });

    const { access_token, user_id } = response.data;

    // Mostrar el token para que el usuario lo copie
    res.send(`
      <html>
        <head>
          <title>Tiendanube - Autorización Exitosa</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #22c55e; }
            .token { background: #f0f0f0; padding: 15px; border-radius: 5px; word-break: break-all; font-family: monospace; font-size: 14px; }
            .info { margin-top: 20px; color: #666; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Autorización Exitosa</h1>
            <p>La app BPM fue autorizada correctamente.</p>
            <h3>Access Token:</h3>
            <div class="token">${access_token}</div>
            <h3>Store ID:</h3>
            <div class="token">${user_id}</div>
            <p class="info">Copiá el Access Token y pasáselo a Claude para actualizar la configuración.</p>
          </div>
        </body>
      </html>
    `);

    console.log('✅ Tiendanube OAuth completado. Store ID:', user_id);

  } catch (error) {
    console.error('❌ Error en OAuth Tiendanube:', error.response?.data || error.message);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; padding: 40px;">
          <h1 style="color: red;">❌ Error en autorización</h1>
          <p>${error.response?.data?.error_description || error.message}</p>
          <p>Code recibido: ${code}</p>
        </body>
      </html>
    `);
  }
});

/* =====================================================
   ENVÍO NUBE - ETIQUETAS DE TIENDANUBE
===================================================== */

/**
 * GET /orders/:orderNumber/envio-nube-label
 * Obtener etiqueta de Envío Nube para un pedido individual
 * Retorna el PDF de la etiqueta directamente
 */
app.get('/orders/:orderNumber/envio-nube-label', authenticate, async (req, res) => {
  try {
    const { orderNumber } = req.params;

    // 1. Obtener tn_order_id de la DB
    const orderRes = await pool.query(`
      SELECT tn_order_id, shipping_type, customer_name
      FROM orders_validated
      WHERE order_number = $1
    `, [orderNumber]);

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderRes.rows[0];

    if (!order.tn_order_id) {
      return res.status(400).json({ error: 'Pedido sin ID de Tiendanube' });
    }

    // Verificar que sea Envío Nube
    const shippingType = (order.shipping_type || '').toLowerCase();
    if (!shippingType.includes('envío nube') && !shippingType.includes('envio nube')) {
      return res.status(400).json({
        error: 'Este pedido no usa Envío Nube',
        shipping_type: order.shipping_type
      });
    }

    // 2. Obtener etiquetas de Tiendanube
    const result = await obtenerEtiquetasEnvioNube(order.tn_order_id);

    if (!result.ok) {
      return res.status(404).json({ error: result.error });
    }

    // 3. Descargar el primer PDF y retornarlo
    const labelUrl = result.labels[0].url;

    const pdfResponse = await axios.get(labelUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    // Registrar en logs
    await logEvento({
      orderNumber,
      accion: 'envio_nube_label_descargada',
      origen: 'crm',
      userId: req.user?.id,
      username: req.user?.name
    });

    // Marcar como impresa
    await pool.query(`
      UPDATE orders_validated
      SET envio_nube_label_printed_at = NOW()
      WHERE order_number = $1
    `, [orderNumber]);

    console.log(`🏷️ Etiqueta Envío Nube descargada para pedido #${orderNumber}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=envio-nube-${orderNumber}.pdf`);
    res.send(Buffer.from(pdfResponse.data));

  } catch (error) {
    console.error('❌ GET /orders/:orderNumber/envio-nube-label error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /orders/envio-nube-labels
 * Obtener etiquetas de Envío Nube para múltiples pedidos
 * Body: { orders: ["12345", "12346", ...] }
 * Retorna un único PDF combinado con todas las etiquetas
 */
app.post('/orders/envio-nube-labels', authenticate, async (req, res) => {
  try {
    const { orders } = req.body;

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de números de pedido' });
    }

    if (orders.length > 50) {
      return res.status(400).json({ error: 'Máximo 50 pedidos por solicitud' });
    }

    console.log(`📦 Solicitando ${orders.length} etiquetas de Envío Nube...`);

    // 1. Obtener tn_order_id de todos los pedidos
    const orderRes = await pool.query(`
      SELECT order_number, tn_order_id, shipping_type, customer_name, envio_nube_label_printed_at, estado_pago
      FROM orders_validated
      WHERE order_number = ANY($1)
    `, [orders]);

    const ordersMap = new Map(orderRes.rows.map(o => [o.order_number, o]));

    // 2. Filtrar pedidos válidos primero
    const validOrders = [];
    const alreadyPrinted = [];
    const unpaid = [];
    const results = {
      success: [],
      failed: [],
      pdfBuffers: []
    };

    for (const orderNumber of orders) {
      const order = ordersMap.get(orderNumber);

      if (!order) {
        results.failed.push({ order: orderNumber, error: 'Pedido no encontrado' });
        continue;
      }

      if (!order.tn_order_id) {
        results.failed.push({ order: orderNumber, error: 'Sin ID de Tiendanube' });
        continue;
      }

      const shippingType = (order.shipping_type || '').toLowerCase();
      if (!shippingType.includes('envío nube') && !shippingType.includes('envio nube')) {
        results.failed.push({ order: orderNumber, error: 'No es Envío Nube' });
        continue;
      }

      // Excluir pedidos sin pago
      if (order.estado_pago === 'pendiente') {
        unpaid.push({ order: orderNumber, customer: order.customer_name });
        continue;
      }

      // Skip already printed labels in bulk mode
      if (order.envio_nube_label_printed_at) {
        alreadyPrinted.push({ order: orderNumber, customer: order.customer_name, printed_at: order.envio_nube_label_printed_at });
        continue;
      }

      validOrders.push({ orderNumber, order });
    }

    // 3. Procesar en paralelo (batches de 5 para no saturar TN API)
    const BATCH_SIZE = 5;
    for (let i = 0; i < validOrders.length; i += BATCH_SIZE) {
      const batch = validOrders.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(batch.map(async ({ orderNumber, order }) => {
        try {
          // Obtener etiquetas
          const labelResult = await obtenerEtiquetasEnvioNube(order.tn_order_id);

          if (!labelResult.ok) {
            return { success: false, orderNumber, error: labelResult.error };
          }

          // Descargar el PDF
          const labelUrl = labelResult.labels[0].url;
          const pdfResponse = await axios.get(labelUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
          });

          return {
            success: true,
            orderNumber,
            buffer: pdfResponse.data,
            customer: order.customer_name,
            tracking: labelResult.labels[0].tracking_code
          };
        } catch (err) {
          return { success: false, orderNumber, error: err.message };
        }
      }));

      // Agregar resultados del batch
      for (const result of batchResults) {
        if (result.success) {
          results.pdfBuffers.push({ orderNumber: result.orderNumber, buffer: result.buffer });
          results.success.push({ order: result.orderNumber, customer: result.customer, tracking: result.tracking });
        } else {
          results.failed.push({ order: result.orderNumber, error: result.error });
        }
      }

      console.log(`📦 Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(validOrders.length / BATCH_SIZE)} procesado`);
    }

    // 4. Si no hay PDFs exitosos, retornar error
    if (results.pdfBuffers.length === 0) {
      if (unpaid.length > 0 && alreadyPrinted.length === 0 && results.failed.length === 0) {
        return res.status(400).json({
          error: `Todas las órdenes seleccionadas están sin pago (${unpaid.length})`,
          unpaid
        });
      }
      if (alreadyPrinted.length > 0 && results.failed.length === 0 && unpaid.length === 0) {
        return res.status(400).json({
          error: `Todas las etiquetas ya fueron impresas (${alreadyPrinted.length})`,
          alreadyPrinted
        });
      }
      return res.status(400).json({
        error: 'No se pudo obtener ninguna etiqueta',
        failed: results.failed,
        alreadyPrinted,
        unpaid
      });
    }

    // 4. Combinar todos los PDFs en uno solo
    const mergedPdf = await PDFLib.create();

    for (const { buffer } of results.pdfBuffers) {
      try {
        const pdf = await PDFLib.load(buffer);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
      } catch (err) {
        console.error('Error cargando PDF:', err.message);
      }
    }

    const mergedPdfBytes = await mergedPdf.save();

    // 5. Registrar en logs y marcar como impresos
    const printedOrderNumbers = results.success.map(s => s.order);

    for (const { order } of results.success) {
      await logEvento({
        orderNumber: order,
        accion: 'envio_nube_label_masiva',
        origen: 'crm',
        userId: req.user?.id,
        username: req.user?.name
      });
    }

    // Marcar etiquetas como impresas
    if (printedOrderNumbers.length > 0) {
      await pool.query(`
        UPDATE orders_validated
        SET envio_nube_label_printed_at = NOW()
        WHERE order_number = ANY($1)
      `, [printedOrderNumbers]);
    }

    console.log(`🏷️ ${results.success.length} etiquetas Envío Nube combinadas (${results.failed.length} fallidas, ${alreadyPrinted.length} ya impresas)`);

    // 6. Retornar PDF combinado
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=etiquetas-envio-nube-${Date.now()}.pdf`);
    res.setHeader('X-Labels-Success', results.success.length);
    res.setHeader('X-Labels-Failed', results.failed.length);
    res.setHeader('X-Labels-Already-Printed', alreadyPrinted.length);
    res.setHeader('X-Labels-Unpaid', unpaid.length);
    res.send(Buffer.from(mergedPdfBytes));

  } catch (error) {
    console.error('❌ POST /orders/envio-nube-labels error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /orders/envio-nube-labels/preview
 * Verificar qué pedidos tienen etiquetas disponibles (sin descargar PDFs)
 * Body: { orders: ["12345", "12346", ...] }
 */
app.post('/orders/envio-nube-labels/preview', authenticate, async (req, res) => {
  try {
    const { orders } = req.body;

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array de números de pedido' });
    }

    // 1. Obtener info de todos los pedidos
    const orderRes = await pool.query(`
      SELECT order_number, tn_order_id, shipping_type, customer_name
      FROM orders_validated
      WHERE order_number = ANY($1)
    `, [orders]);

    const ordersMap = new Map(orderRes.rows.map(o => [o.order_number, o]));

    // 2. Verificar cada pedido
    const results = {
      available: [],
      unavailable: []
    };

    for (const orderNumber of orders) {
      const order = ordersMap.get(orderNumber);

      if (!order) {
        results.unavailable.push({ order: orderNumber, reason: 'Pedido no encontrado' });
        continue;
      }

      if (!order.tn_order_id) {
        results.unavailable.push({ order: orderNumber, reason: 'Sin ID de Tiendanube' });
        continue;
      }

      const shippingType = (order.shipping_type || '').toLowerCase();
      if (!shippingType.includes('envío nube') && !shippingType.includes('envio nube')) {
        results.unavailable.push({ order: orderNumber, reason: 'No es Envío Nube', shipping_type: order.shipping_type });
        continue;
      }

      try {
        const labelResult = await obtenerEtiquetasEnvioNube(order.tn_order_id);

        if (labelResult.ok) {
          results.available.push({
            order: orderNumber,
            customer: order.customer_name,
            labels_count: labelResult.labels.length,
            tracking: labelResult.labels[0]?.tracking_code
          });
        } else {
          results.unavailable.push({ order: orderNumber, reason: labelResult.error });
        }
      } catch (err) {
        results.unavailable.push({ order: orderNumber, reason: err.message });
      }
    }

    res.json({
      total_requested: orders.length,
      available: results.available.length,
      unavailable: results.unavailable.length,
      details: results
    });

  } catch (error) {
    console.error('❌ POST /orders/envio-nube-labels/preview error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   TRACKING CODES - Múltiples códigos para Envío Nube
===================================================== */

/**
 * GET /orders/:orderNumber/tracking-codes
 * Obtener todos los tracking codes de un pedido
 */
app.get('/orders/:orderNumber/tracking-codes', authenticate, requirePermission('orders.view'), async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const cleanOrderNumber = orderNumber.replace('#', '').trim();

    // Obtener el tracking original de TN
    const orderRes = await pool.query(
      `SELECT shipping_tracking, shipping_type FROM orders_validated WHERE order_number = $1`,
      [cleanOrderNumber]
    );

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderRes.rows[0];

    // Obtener trackings adicionales
    const trackingsRes = await pool.query(
      `SELECT id, tracking_code, position, total_shipments, carrier, created_at, whatsapp_sent_at
       FROM order_tracking_codes
       WHERE order_number = $1
       ORDER BY position ASC`,
      [cleanOrderNumber]
    );

    // Construir respuesta con el tracking original (position 1) + adicionales
    const originalTracking = order.shipping_tracking;
    const additionalTrackings = trackingsRes.rows;

    // Determinar total_shipments del primer adicional (si existe)
    const totalShipments = additionalTrackings.length > 0
      ? additionalTrackings[0].total_shipments
      : (originalTracking ? 1 : 0);

    res.json({
      order_number: cleanOrderNumber,
      shipping_type: order.shipping_type,
      total_shipments: totalShipments,
      trackings: [
        // Position 1: tracking original de TN (si existe)
        ...(originalTracking ? [{
          id: null,
          tracking_code: originalTracking,
          position: 1,
          is_original: true,
          whatsapp_sent_at: null // El original se envía con enviado_env_nube
        }] : []),
        // Position 2+: trackings adicionales
        ...additionalTrackings.map(t => ({
          ...t,
          is_original: false
        }))
      ]
    });

  } catch (error) {
    console.error('❌ GET /orders/:orderNumber/tracking-codes error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /orders/:orderNumber/tracking-codes
 * Agregar un nuevo tracking code
 * Body: { tracking_code: string, position: number, total_shipments: number }
 */
app.post('/orders/:orderNumber/tracking-codes', authenticate, requirePermission('orders.update_status'), async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { tracking_code, position, total_shipments, send_whatsapp = true } = req.body;
    const cleanOrderNumber = orderNumber.replace('#', '').trim();

    // Validaciones
    if (!tracking_code || typeof tracking_code !== 'string') {
      return res.status(400).json({ error: 'tracking_code es requerido' });
    }
    if (!position || position < 2) {
      return res.status(400).json({ error: 'position debe ser >= 2 (el 1 es el original de TN)' });
    }
    if (!total_shipments || total_shipments < position) {
      return res.status(400).json({ error: 'total_shipments debe ser >= position' });
    }

    // Verificar que el pedido existe y es Envío Nube
    const orderRes = await pool.query(
      `SELECT order_number, customer_name, customer_phone, shipping_type, tn_order_id, tn_order_token
       FROM orders_validated WHERE order_number = $1`,
      [cleanOrderNumber]
    );

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderRes.rows[0];
    const shippingType = (order.shipping_type || '').toLowerCase();
    const esEnvioNube = shippingType.includes('envío nube') || shippingType.includes('envio nube');

    if (!esEnvioNube) {
      return res.status(400).json({ error: 'Solo se pueden agregar trackings a pedidos de Envío Nube' });
    }

    // Insertar el tracking
    const insertRes = await pool.query(
      `INSERT INTO order_tracking_codes (order_number, tracking_code, position, total_shipments, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_number, position)
       DO UPDATE SET tracking_code = EXCLUDED.tracking_code, total_shipments = EXCLUDED.total_shipments
       RETURNING id, tracking_code, position, total_shipments, created_at`,
      [cleanOrderNumber, tracking_code.trim(), position, total_shipments, req.user?.id]
    );

    const newTracking = insertRes.rows[0];

    // Actualizar total_shipments en todos los trackings del pedido (por consistencia)
    await pool.query(
      `UPDATE order_tracking_codes SET total_shipments = $1 WHERE order_number = $2`,
      [total_shipments, cleanOrderNumber]
    );

    // Log del evento
    await logEvento({
      orderNumber: cleanOrderNumber,
      accion: `tracking_agregado: ${tracking_code} (${position} de ${total_shipments})`,
      origen: 'operador',
      userId: req.user?.id,
      username: req.user?.name
    });

    // Enviar WhatsApp si está habilitado
    let whatsappResult = null;
    if (send_whatsapp && order.customer_phone) {
      try {
        await queueWhatsApp({
          telefono: order.customer_phone,
          plantilla: 'prueba_2v',
          variables: {
            '1': order.customer_name || 'Cliente',
            '2': cleanOrderNumber,
            '3': `${position} de ${total_shipments}`,
            '4': '-'
          },
          orderNumber: cleanOrderNumber
        });

        // Marcar como enviado
        await pool.query(
          `UPDATE order_tracking_codes SET whatsapp_sent_at = NOW() WHERE id = $1`,
          [newTracking.id]
        );

        whatsappResult = { sent: true };
        console.log(`📨 WhatsApp envio_nube_extra enviado (Pedido #${cleanOrderNumber}, tracking ${position}/${total_shipments})`);
      } catch (waErr) {
        console.error('⚠️ Error WhatsApp envio_nube_extra:', waErr.message);
        whatsappResult = { sent: false, error: waErr.message };
      }
    }

    res.json({
      ok: true,
      tracking: newTracking,
      whatsapp: whatsappResult
    });

  } catch (error) {
    console.error('❌ POST /orders/:orderNumber/tracking-codes error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /orders/:orderNumber/tracking-codes/:id
 * Eliminar un tracking code
 */
app.delete('/orders/:orderNumber/tracking-codes/:id', authenticate, requirePermission('orders.update_status'), async (req, res) => {
  try {
    const { orderNumber, id } = req.params;
    const cleanOrderNumber = orderNumber.replace('#', '').trim();

    const result = await pool.query(
      `DELETE FROM order_tracking_codes WHERE id = $1 AND order_number = $2 RETURNING tracking_code, position`,
      [id, cleanOrderNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tracking no encontrado' });
    }

    const deleted = result.rows[0];

    await logEvento({
      orderNumber: cleanOrderNumber,
      accion: `tracking_eliminado: ${deleted.tracking_code} (posición ${deleted.position})`,
      origen: 'operador',
      userId: req.user?.id,
      username: req.user?.name
    });

    res.json({ ok: true, deleted });

  } catch (error) {
    console.error('❌ DELETE /orders/:orderNumber/tracking-codes/:id error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /orders/:orderNumber/tracking-codes/:id/resend-whatsapp
 * Reenviar WhatsApp para un tracking específico
 */
app.post('/orders/:orderNumber/tracking-codes/:id/resend-whatsapp', authenticate, requirePermission('orders.update_status'), async (req, res) => {
  try {
    const { orderNumber, id } = req.params;
    const cleanOrderNumber = orderNumber.replace('#', '').trim();

    // Obtener tracking y datos del pedido
    const result = await pool.query(
      `SELECT t.*, o.customer_name, o.customer_phone, o.tn_order_id, o.tn_order_token
       FROM order_tracking_codes t
       JOIN orders_validated o ON o.order_number = t.order_number
       WHERE t.id = $1 AND t.order_number = $2`,
      [id, cleanOrderNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tracking no encontrado' });
    }

    const { tracking_code, position, total_shipments, customer_name, customer_phone, tn_order_id, tn_order_token } = result.rows[0];

    if (!customer_phone) {
      return res.status(400).json({ error: 'El cliente no tiene teléfono' });
    }

    await queueWhatsApp({
      telefono: customer_phone,
      plantilla: 'prueba_2v',
      variables: {
        '1': customer_name || 'Cliente',
        '2': cleanOrderNumber,
        '3': `${position} de ${total_shipments}`,
        '4': `${tn_order_id}/${tn_order_token}`
      },
      orderNumber: cleanOrderNumber
    });

    await pool.query(
      `UPDATE order_tracking_codes SET whatsapp_sent_at = NOW() WHERE id = $1`,
      [id]
    );

    await logEvento({
      orderNumber: cleanOrderNumber,
      accion: `whatsapp_reenviado: tracking ${position}/${total_shipments}`,
      origen: 'operador',
      userId: req.user?.id,
      username: req.user?.name
    });

    res.json({ ok: true, message: 'WhatsApp enviado' });

  } catch (error) {
    console.error('❌ POST /orders/:orderNumber/tracking-codes/:id/resend-whatsapp error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   WHATSAPP ACCIONES - Envío masivo de plantillas
===================================================== */

/**
 * POST /whatsapp/bulk-send
 * Enviar plantilla de WhatsApp a múltiples pedidos
 * Body: { template: string, orderNumbers: string[] }
 */
app.post('/whatsapp/bulk-send', authenticate, requirePermission('whatsapp.send_bulk'), async (req, res) => {
  try {
    const { template, orderNumbers } = req.body;

    if (!template || typeof template !== 'string') {
      return res.status(400).json({ error: 'template is required' });
    }

    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({ error: 'orderNumbers array is required' });
    }

    if (orderNumbers.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 orders per request' });
    }

    console.log(`📤 WhatsApp bulk send: ${template} to ${orderNumbers.length} orders`);

    const results = {
      sent: [],
      failed: [],
      skipped: []
    };

    for (const orderNumber of orderNumbers) {
      const cleanOrderNumber = orderNumber.toString().replace('#', '').trim();

      try {
        // Buscar el pedido y obtener teléfono
        const orderResult = await pool.query(
          'SELECT order_number, customer_name, customer_phone FROM orders_validated WHERE order_number = $1',
          [cleanOrderNumber]
        );

        if (orderResult.rows.length === 0) {
          results.failed.push({ orderNumber: cleanOrderNumber, error: 'Pedido no encontrado' });
          continue;
        }

        const order = orderResult.rows[0];
        const phone = order.customer_phone;

        if (!phone) {
          results.failed.push({ orderNumber: cleanOrderNumber, error: 'Sin teléfono' });
          continue;
        }

        // Enviar WhatsApp
        const response = await enviarWhatsAppPlantilla({
          telefono: phone,
          plantilla: template,
          variables: { '1': cleanOrderNumber },
          orderNumber: cleanOrderNumber
        });

        if (response.data?.skipped) {
          results.skipped.push({
            orderNumber: cleanOrderNumber,
            reason: response.data.reason,
            customerName: order.customer_name
          });
        } else {
          results.sent.push({
            orderNumber: cleanOrderNumber,
            customerName: order.customer_name,
            phone: phone.slice(-4) // últimos 4 dígitos por privacidad
          });
        }

        // Pequeña pausa para no saturar Botmaker
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (err) {
        console.error(`❌ Error enviando WhatsApp a ${cleanOrderNumber}:`, err.message);
        results.failed.push({ orderNumber: cleanOrderNumber, error: err.message });
      }
    }

    console.log(`✅ WhatsApp bulk send complete: ${results.sent.length} sent, ${results.failed.length} failed, ${results.skipped.length} skipped`);

    await logEvento({ accion: `whatsapp_masivo: ${template} (${results.sent.length} enviados)`, origen: 'admin', userId: req.user.id, username: req.user.name });

    res.json({
      ok: true,
      template,
      total: orderNumbers.length,
      sent: results.sent.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
      results
    });

  } catch (error) {
    console.error('❌ POST /whatsapp/bulk-send error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /whatsapp/send-tracking
 * Envía UN solo WhatsApp por pedido con todos los códigos de seguimiento concatenados
 * Template: envio_extra — Variables: nombre, nro pedido, códigos separados por coma
 */
app.post('/whatsapp/send-tracking', authenticate, requirePermission('whatsapp.send_bulk'), async (req, res) => {
  try {
    const { entries } = req.body;
    // entries: [{ orderNumber, totalShipments, trackingCodes: { 2: "ABC", 3: "DEF" } }]

    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries array is required' });
    }

    const results = { sent: [], failed: [], skipped: [] };

    for (const entry of entries) {
      const cleanOrderNumber = entry.orderNumber.toString().replace('#', '').trim();

      try {
        // Buscar pedido
        const orderRes = await pool.query(
          `SELECT order_number, customer_name, customer_phone, shipping_type FROM orders_validated WHERE order_number = $1`,
          [cleanOrderNumber]
        );

        if (orderRes.rows.length === 0) {
          results.failed.push({ orderNumber: cleanOrderNumber, error: 'Pedido no encontrado' });
          continue;
        }

        const order = orderRes.rows[0];
        if (!order.customer_phone) {
          results.failed.push({ orderNumber: cleanOrderNumber, error: 'Sin teléfono' });
          continue;
        }

        // Recopilar códigos de tracking
        const codes = [];
        const totalShipments = Number(entry.totalShipments) || 0;
        for (let pos = 1; pos <= totalShipments; pos++) {
          const code = (entry.trackingCodes[pos] || entry.trackingCodes[String(pos)] || '').trim();
          if (!code) {
            results.failed.push({ orderNumber: cleanOrderNumber, error: `Falta código #${pos}` });
            continue;
          }
          codes.push(code);
        }

        if (codes.length === 0) {
          results.failed.push({ orderNumber: cleanOrderNumber, error: 'Sin códigos de seguimiento' });
          continue;
        }

        // Guardar tracking codes en DB
        for (let pos = 1; pos <= totalShipments; pos++) {
          const code = (entry.trackingCodes[pos] || entry.trackingCodes[String(pos)] || '').trim();
          if (code) {
            await pool.query(
              `INSERT INTO order_tracking_codes (order_number, tracking_code, position, total_shipments, created_by)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (order_number, position)
               DO UPDATE SET tracking_code = EXCLUDED.tracking_code, total_shipments = EXCLUDED.total_shipments`,
              [cleanOrderNumber, code, pos, entry.totalShipments, req.user?.id]
            );
          }
        }

        // Enviar UN solo WhatsApp con todos los códigos concatenados
        const codesString = codes.join(', ');
        await queueWhatsApp({
          telefono: order.customer_phone,
          plantilla: 'envio_extra',
          variables: {
            '1': order.customer_name || 'Cliente',
            '2': cleanOrderNumber,
            '3': codesString
          },
          orderNumber: cleanOrderNumber
        });

        results.sent.push({
          orderNumber: cleanOrderNumber,
          customerName: order.customer_name,
          phone: order.customer_phone.slice(-4),
          codes: codesString
        });

        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (err) {
        console.error(`❌ Error send-tracking ${cleanOrderNumber}:`, err.message);
        results.failed.push({ orderNumber: cleanOrderNumber, error: err.message });
      }
    }

    console.log(`✅ WhatsApp send-tracking: ${results.sent.length} sent, ${results.failed.length} failed`);
    await logEvento({ accion: `whatsapp_tracking: envio_extra (${results.sent.length} enviados)`, origen: 'admin', userId: req.user.id, username: req.user.name });

    res.json({
      ok: true,
      template: 'envio_extra',
      total: entries.length,
      sent: results.sent.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
      results
    });
  } catch (error) {
    console.error('❌ POST /whatsapp/send-tracking error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /whatsapp/templates
 * Listar plantillas disponibles para envío manual
 */
app.get('/whatsapp/templates', authenticate, requirePermission('whatsapp.send_bulk'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT key, nombre, descripcion
      FROM plantilla_tipos
      ORDER BY nombre
    `);
    res.json({ ok: true, templates: result.rows });
  } catch (error) {
    console.error('❌ GET /whatsapp/templates error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   WHATSAPP SCHEDULED - Mensajes programados
===================================================== */

/**
 * POST /whatsapp/schedule
 * Programar envío de WhatsApp para una hora específica
 */
app.post('/whatsapp/schedule', authenticate, requirePermission('whatsapp.send_bulk'), async (req, res) => {
  try {
    const { telefono, plantilla, variables, order_number, send_at } = req.body;

    if (!telefono || !plantilla || !send_at) {
      return res.status(400).json({ error: 'telefono, plantilla y send_at son requeridos' });
    }

    const sendAtDate = new Date(send_at);
    if (isNaN(sendAtDate.getTime())) {
      return res.status(400).json({ error: 'send_at debe ser una fecha válida (ISO 8601)' });
    }

    if (sendAtDate <= new Date()) {
      return res.status(400).json({ error: 'send_at debe ser en el futuro' });
    }

    const result = await pool.query(
      `INSERT INTO scheduled_whatsapp (telefono, plantilla, variables, order_number, send_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, send_at`,
      [telefono, plantilla, variables || {}, order_number, sendAtDate, req.user?.id]
    );

    console.log(`⏰ WhatsApp programado: ${plantilla} → ${telefono} para ${sendAtDate.toISOString()}`);

    res.json({ ok: true, scheduled: result.rows[0] });
  } catch (error) {
    console.error('❌ POST /whatsapp/schedule error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /whatsapp/scheduled
 * Listar mensajes programados
 */
app.get('/whatsapp/scheduled', authenticate, requirePermission('whatsapp.send_bulk'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, telefono, plantilla, variables, order_number, send_at, sent_at, error, created_at
       FROM scheduled_whatsapp
       ORDER BY send_at DESC
       LIMIT 50`
    );
    res.json({ ok: true, messages: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Procesador de mensajes programados (cada 30 segundos)
setInterval(async () => {
  try {
    const pending = await pool.query(
      `SELECT id, telefono, plantilla, variables, order_number
       FROM scheduled_whatsapp
       WHERE sent_at IS NULL AND error IS NULL AND send_at <= NOW()
       ORDER BY send_at
       LIMIT 10`
    );

    for (const msg of pending.rows) {
      try {
        await queueWhatsApp({
          telefono: msg.telefono,
          plantilla: msg.plantilla,
          variables: msg.variables || {},
          orderNumber: msg.order_number
        });

        await pool.query(
          `UPDATE scheduled_whatsapp SET sent_at = NOW() WHERE id = $1`,
          [msg.id]
        );

        console.log(`⏰✅ Scheduled WhatsApp sent: ${msg.plantilla} → ${msg.telefono}`);
      } catch (err) {
        await pool.query(
          `UPDATE scheduled_whatsapp SET error = $1 WHERE id = $2`,
          [err.message, msg.id]
        );
        console.error(`⏰❌ Scheduled WhatsApp failed: ${msg.plantilla} → ${msg.telefono}:`, err.message);
      }
    }
  } catch {
    // Silenciar errores del check periódico
  }
}, 30000);

/* =====================================================
   WHATSAPP MESSAGES - Estado y reenvío
===================================================== */

// Listar mensajes con filtros (status, order_number)
app.get('/whatsapp/messages', authenticate, requirePermission('receipts.confirm'), async (req, res) => {
  try {
    const { status, order_number, page = 1, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 0;

    if (status) { idx++; conditions.push(`wm.status = $${idx}`); params.push(status); }
    if (order_number) { idx++; conditions.push(`wm.order_number = $${idx}::text`); params.push(order_number); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM whatsapp_messages wm ${where}`, params),
      pool.query(
        `SELECT wm.*, ov.customer_name
         FROM whatsapp_messages wm
         LEFT JOIN orders_validated ov ON ov.order_number = wm.order_number::text
         ${where}
         ORDER BY wm.created_at DESC
         LIMIT ${parseInt(limit)} OFFSET ${offset}`,
        params
      )
    ]);

    res.json({
      messages: dataRes.rows,
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(parseInt(countRes.rows[0].count) / parseInt(limit))
    });
  } catch (error) {
    log.error({ err: error }, 'GET /whatsapp/messages error');
    res.status(500).json({ error: error.message });
  }
});

// Reintentar un mensaje fallido
app.post('/whatsapp/messages/:id/retry', authenticate, requirePermission('receipts.confirm'), async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await pool.query(`SELECT * FROM whatsapp_messages WHERE id = $1`, [id]);
    if (msg.rows.length === 0) return res.status(404).json({ error: 'Mensaje no encontrado' });

    const m = msg.rows[0];
    if (m.status === 'sent') return res.status(400).json({ error: 'El mensaje ya fue enviado' });

    // Marcar como retrying
    await pool.query(
      `UPDATE whatsapp_messages SET status = 'retrying', status_updated_at = NOW(), retry_count = retry_count + 1 WHERE id = $1`,
      [id]
    );

    // Re-encolar usando template_key original (no el nombre resuelto)
    await queueWhatsApp({
      telefono: m.contact_id.startsWith('+') ? m.contact_id : `+${m.contact_id}`,
      plantilla: m.template_key || m.template.replace('numero_viejo_', '').replace(/_v\d+$/, ''),
      variables: m.variables,
      orderNumber: String(m.order_number)
    });

    res.json({ ok: true, message: 'Mensaje reencolado' });
  } catch (error) {
    log.error({ err: error }, 'POST /whatsapp/messages/:id/retry error');
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   WHATSAPP LEADS - Suscripción a promociones
===================================================== */

// Endpoint público para capturar leads desde Tiendanube
app.post('/whatsapp-leads', leadsLimiter, async (req, res) => {
  try {
    const { nombre, telefono, consentimiento } = req.body;

    // Validaciones - los 3 campos son obligatorios
    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({ success: false, error: 'El nombre es obligatorio' });
    }
    if (!telefono || telefono.trim() === '') {
      return res.status(400).json({ success: false, error: 'El teléfono es obligatorio' });
    }
    if (consentimiento !== true) {
      return res.status(400).json({ success: false, error: 'Debes aceptar recibir mensajes' });
    }

    // Limpiar teléfono: solo dígitos, remover prefijo 54
    let telefonoLimpio = telefono.replace(/\D/g, '');
    if (telefonoLimpio.startsWith('54')) {
      telefonoLimpio = telefonoLimpio.slice(2);
    }

    // Validar longitud (10-15 dígitos)
    if (telefonoLimpio.length < 10 || telefonoLimpio.length > 15) {
      return res.status(400).json({ success: false, error: 'El teléfono debe tener entre 10 y 15 dígitos' });
    }

    // Guardar
    const result = await pool.query(`
      INSERT INTO whatsapp_leads (nombre, telefono, consentimiento_form, origen, user_agent)
      VALUES ($1, $2, true, $3, $4)
      RETURNING id
    `, [
      nombre.trim(),
      telefonoLimpio,
      req.get('Referer') || 'direct',
      req.get('User-Agent')
    ]);

    console.log(`✅ Lead guardado: ${result.rows[0].id} - Tel: ${telefonoLimpio}`);
    res.status(201).json({ success: true, leadId: result.rows[0].id });

  } catch (error) {
    console.error('❌ Error guardando lead:', error.message);
    res.status(500).json({ success: false, error: 'Error al procesar la solicitud' });
  }
});

// Webhook para confirmación de consentimiento desde Botmaker (matchea por teléfono)
app.post('/webhook/whatsapp-lead-confirm', async (req, res) => {
  try {
    const authToken = req.headers['auth-bm-token'];
    const expectedToken = process.env.BOTMAKER_WEBHOOK_SECRET;

    // Warning si no hay token configurado
    if (!expectedToken) {
      console.warn('⚠️ BOTMAKER_WEBHOOK_SECRET no configurado - webhook sin autenticación');
    }

    // Validar token si está configurado
    if (expectedToken && authToken !== expectedToken) {
      console.error('❌ Webhook lead-confirm: token inválido');
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'phone required' });
    }

    // Normalizar teléfono: solo dígitos, remover prefijo 54
    let telefonoNormalizado = phone.replace(/\D/g, '');
    if (telefonoNormalizado.startsWith('54')) {
      telefonoNormalizado = telefonoNormalizado.slice(2);
    }

    // Buscar lead más reciente con ese teléfono que no esté confirmado
    const result = await pool.query(`
      UPDATE whatsapp_leads
      SET consentimiento_whatsapp = true, confirmado_at = NOW()
      WHERE telefono = $1 AND consentimiento_whatsapp = false
      RETURNING id
    `, [telefonoNormalizado]);

    if (result.rowCount === 0) {
      // No es error, puede ser que ya esté confirmado o no exista
      console.log(`ℹ️ No lead pendiente para teléfono: ${telefonoNormalizado}`);
      return res.json({ success: true, message: 'No pending lead found' });
    }

    console.log(`✅ Lead confirmado por teléfono: ${telefonoNormalizado} (${result.rows[0].id})`);
    res.json({ success: true, leadId: result.rows[0].id });

  } catch (error) {
    console.error('❌ Error confirmando lead:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* =====================================================
   SENTRY ERROR HANDLING
===================================================== */

// Sentry error handler - DEBE ir después de todas las rutas
Sentry.setupExpressErrorHandler(app);

// Global error handler — catch-all para errores no manejados en controladores
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  const status = err.status || err.statusCode || 500;

  // Log estructurado con contexto
  console.error(JSON.stringify({
    level: 'error',
    msg: 'Unhandled Express error',
    requestId,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.id,
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  }));

  // Reportar a Sentry con contexto
  Sentry.withScope((scope) => {
    scope.setTag('requestId', requestId);
    scope.setUser({ id: req.user?.id });
    Sentry.captureException(err);
  });

  // No exponer detalles internos en producción
  if (res.headersSent) return next(err);
  res.status(status).json({
    error: status >= 500 ? 'Error interno del servidor' : err.message,
    requestId
  });
});

// Capturar errores no manejados globalmente
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  Sentry.captureException(reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  Sentry.captureException(error);
  // Dar tiempo a Sentry para enviar antes de crashear
  setTimeout(() => process.exit(1), 2000);
});

// Reconciliation scheduler: cada 30 minutos
function startReconciliationScheduler() {
  if (reconciliationInterval) return;

  // Primera ejecucion despues de 2 minutos
  setTimeout(async () => {
    try {
      const { runReconciliation } = require('./workers/reconciliation.worker');
      const results = await runReconciliation();
      if (results.issues.length > 0) {
        console.log(`[Reconciliation] ${results.issues.length} issues found`);
      }
    } catch (err) {
      console.error('[Reconciliation] Error:', err.message);
    }
  }, 2 * 60 * 1000);

  // Luego cada 30 minutos
  reconciliationInterval = setInterval(async () => {
    try {
      const { runReconciliation } = require('./workers/reconciliation.worker');
      const results = await runReconciliation();
      if (results.issues.length > 0) {
        console.log(`[Reconciliation] ${results.issues.length} issues found`);
      }
    } catch (err) {
      console.error('[Reconciliation] Error:', err.message);
    }
  }, 30 * 60 * 1000);

  console.log('[Reconciliation] Scheduler started (every 30 min, first run in 2 min)');
}

/* =====================================================
   SERVER
===================================================== */
// Solo iniciar servidor si no estamos en modo test
let server = null;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    if (process.env.SENTRY_DSN) {
      console.log('✅ Sentry error monitoring enabled');
    }

    // Iniciar scheduler de sincronización
    startSyncScheduler();
    startReconciliationScheduler();
  });
}

/* =====================================================
   GRACEFUL SHUTDOWN
===================================================== */
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
    });
  }

  // Clear schedulers
  if (syncInterval) clearInterval(syncInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  if (reconciliationInterval) clearInterval(reconciliationInterval);

  // Release sync lock if held
  releaseSyncLock().catch(() => {});

  // Close DB pool
  pool.end().then(() => {
    console.log('DB pool closed');
    process.exit(0);
  }).catch(() => {
    process.exit(1);
  });

  // Force exit after 30s
  setTimeout(() => {
    console.error('Forced exit after timeout');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Exportar app para tests
module.exports = { app };
