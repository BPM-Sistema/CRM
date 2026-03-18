
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

const supabase = require('./supabase');
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
const { getQueueStats, getSyncState } = require('./services/syncQueue');
const { tiendanube: tnConfig, whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('./services/integrationConfig');
const { verificarConsistencia, getInconsistencias } = require('./utils/orderVerification');
const { getNotificaciones, contarNoLeidas, marcarLeida, marcarTodasLeidas, crearNotificacion } = require('./utils/notifications');
const { enviarWhatsAppPlantilla, PLANTILLAS_SIN_SUFIJO, PLANTILLA_CONFIG_KEY } = require('./lib/whatsapp-helpers');
const { calcularTotalPagado, calcularEstadoPedido, requiresShippingForm, normalizePhoneForComparison } = require('./lib/payment-helpers');
const { watermarkReceipt, isValidDestination, detectarFinancieraDesdeOCR } = require('./lib/comprobante-helpers');
const customerSync = require('./services/customerSync');
const customerMetrics = require('./services/customerMetrics');
const customerSegmentation = require('./services/customerSegmentation');
const app = express();
const PORT = process.env.PORT || 3000;

// Desactivar ETag globalmente para evitar respuestas 304
app.set('etag', false);

app.use(express.json({
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

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Structured logging middleware (request IDs + duration)
const { requestLogger } = require('./lib/logger');
const { apiLogger: log } = require('./lib/logger');
app.use(requestLogger);

// Redirecciones del dominio viejo (api.petlovearg.com) al nuevo
app.get('/envio', (req, res) => {
  // Si viene del dominio viejo, redirigir al nuevo
  if (req.hostname.includes('petlovearg')) {
    return res.redirect(301, 'https://www.bpmadministrador.com/envio');
  }
  // Si es el dominio nuevo, servir el archivo estático
  res.sendFile(path.join(__dirname, 'public', 'envio.html'));
});

app.get('/', (req, res, next) => {
  // Si viene del dominio viejo, redirigir al nuevo
  if (req.hostname.includes('petlovearg')) {
    return res.redirect(301, 'https://www.bpmadministrador.com/comprobantes');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Ruta explícita para el form de leads (iframe)
app.get('/leads', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leads.html'));
});

async function logEvento({ comprobanteId, orderNumber, accion, origen, userId, username }) {
  // DEBUG: Stack trace para encontrar duplicados
  const stack = new Error().stack;
  const timestamp = new Date().toISOString();
  console.log(`\n🔍 [${timestamp}] logEvento llamado:`);
  console.log(`   Acción: ${accion}`);
  console.log(`   ComprobanteId: ${comprobanteId}`);
  console.log(`   OrderNumber: ${orderNumber}`);
  console.log(`   Stack trace:\n${stack.split('\n').slice(1, 5).join('\n')}`);

  try {
    const result = await pool.query(
      `INSERT INTO logs (comprobante_id, order_number, accion, origen, user_id, username)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [comprobanteId || null, orderNumber || null, accion, origen, userId || null, username || null]
    );
    console.log(`   ✅ Log insertado con ID: ${result.rows[0].id}`);
  } catch (err) {
    console.error('❌ Error guardando log:', err.message);
  }
}

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

  // Siempre agregar monto al final
  const montoFormateado = montoNuevo.toLocaleString('es-AR');
  lineas.push(`Nuevo monto: $${montoFormateado}`);

  return lineas.join('\n');
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
    const response = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfillment-orders`,
      {
        headers: {
          authentication: `bearer ${token}`,
          'User-Agent': 'bpm-validator'
        },
        timeout: 15000
      }
    );

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

      // 3. Verificar si ya hay labels READY_TO_USE
      let readyLabel = fo.labels?.find(l => l.status === 'READY_TO_USE');

      // 4. Si no hay label, solicitar generación
      if (!readyLabel) {
        console.log(`🚀 Solicitando generación de etiqueta para FO ${fo.id}...`);

        try {
          // POST al endpoint correcto de creación de labels
          const createRes = await axios.post(
            `https://api.tiendanube.com/v1/${storeId}/fulfillment-orders/labels`,
            [{ id: fo.id }],
            {
              headers: {
                authentication: `bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'bpm-validator'
              },
              timeout: 30000
            }
          );

          console.log(`✅ Label solicitado:`, JSON.stringify(createRes.data));

          // Esperar a que se genere (polling con timeout)
          const maxAttempts = 10;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const checkRes = await axios.get(
              `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}/fulfillment-orders`,
              {
                headers: { authentication: `bearer ${token}`, 'User-Agent': 'bpm-validator' },
                timeout: 15000
              }
            );

            const updatedFO = checkRes.data.find(f => f.id === fo.id);
            readyLabel = updatedFO?.labels?.find(l => l.status === 'READY_TO_USE');

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
          const downloadRes = await axios.post(
            `https://api.tiendanube.com/v1/${storeId}/fulfillment-orders/${fo.id}/labels/${readyLabel.id}/download`,
            {},
            {
              headers: {
                authentication: `bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'bpm-validator'
              },
              timeout: 15000
            }
          );

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
    const response = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/orders/${orderId}`,
      {
        headers: {
          authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-validator'
        },
        timeout: 10000 // 10 segundos timeout
      }
    );
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

  // 4. UPSERT productos actuales
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
      order_number, tn_order_id, tn_order_token, monto_tiendanube, subtotal, discount, shipping_cost,
      currency, customer_name, customer_email, customer_phone,
      shipping_type, shipping_tracking, shipping_address,
      note, owner_note, tn_payment_status, tn_shipping_status,
      estado_pedido, tn_created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'pendiente_pago', $19, NOW())
    ON CONFLICT (order_number) DO UPDATE SET
      tn_order_id = COALESCE(EXCLUDED.tn_order_id, orders_validated.tn_order_id),
      tn_order_token = COALESCE(EXCLUDED.tn_order_token, orders_validated.tn_order_token),
      monto_tiendanube = EXCLUDED.monto_tiendanube,
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
      tn_created_at = COALESCE(orders_validated.tn_created_at, EXCLUDED.tn_created_at),
      updated_at = NOW()
  `, [
    orderNumber,
    pedido.id,
    pedido.token || null,  // Token para tracking de TiendaNube
    Math.round(Number(pedido.total)),
    Number(pedido.subtotal) || 0,
    Number(pedido.discount) || 0,
    Number(pedido.shipping_cost_customer) || 0,
    pedido.currency || 'ARS',
    customerName,
    customerEmail,
    customerPhone,
    (typeof pedido.shipping_option === 'string' ? pedido.shipping_option : pedido.shipping_option?.name) || pedido.shipping || null,
    pedido.shipping_tracking_number || null,
    shippingAddress ? JSON.stringify(shippingAddress) : null,
    pedido.note || null,
    pedido.owner_note || null,
    pedido.payment_status || null,
    pedido.shipping || null,  // El campo es "shipping", no "shipping_status"
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
 */
async function queueWhatsApp({ telefono, plantilla, variables, orderNumber }) {
  const { whatsappQueue } = require('./lib/queues');
  if (whatsappQueue) {
    await whatsappQueue.add('send-whatsapp', {
      telefono, plantilla, variables, orderNumber,
      requestId: crypto.randomUUID()
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 }
    });
    log.info({ orderNumber, plantilla }, 'WhatsApp message enqueued');
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
  limits: { fileSize: 10 * 1024 * 1024 }
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

    // Obtener logs con paginación
    const logsRes = await pool.query(`
      SELECT
        l.id,
        l.comprobante_id,
        l.order_number,
        l.accion,
        l.origen,
        l.user_id,
        l.username,
        l.created_at,
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
    // Usar timezone de Argentina para todas las comparaciones de fecha
    const result = await pool.query(`
      WITH hoy AS (
        SELECT (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date as fecha
      ),
      comprobantes_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE estado IN ('pendiente', 'a_confirmar')) as a_confirmar,
          COUNT(*) FILTER (WHERE estado = 'confirmado' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)) as confirmados_hoy,
          COUNT(*) FILTER (WHERE estado = 'rechazado' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)) as rechazados_hoy,
          COALESCE(SUM(monto) FILTER (WHERE estado = 'confirmado' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)), 0) as monto_confirmado_hoy
        FROM comprobantes
      ),
      remitos_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'processing') as procesando,
          COUNT(*) FILTER (WHERE status = 'ready') as listos,
          COUNT(*) FILTER (WHERE status = 'confirmed' AND (confirmed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)) as confirmados_hoy,
          COUNT(*) FILTER (WHERE status = 'error') as con_error
        FROM shipping_documents
      ),
      pedidos_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)) as nuevos_hoy,
          COUNT(*) FILTER (WHERE estado_pedido = 'a_imprimir') as a_imprimir,
          COUNT(*) FILTER (WHERE estado_pedido = 'armado') as armados,
          COUNT(*) FILTER (WHERE estado_pedido IN ('enviado', 'en_calle', 'retirado')) as enviados,
          COUNT(*) FILTER (WHERE estado_pedido = 'cancelado' AND (updated_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)) as cancelados_hoy
        FROM orders_validated
      ),
      pagos_stats AS (
        SELECT
          COALESCE(SUM(total_pagado) FILTER (WHERE estado_pago IN ('confirmado_total', 'a_favor') AND (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)), 0) as recaudado_hoy,
          COALESCE(SUM(saldo) FILTER (WHERE saldo > 0), 0) as saldo_pendiente,
          COUNT(*) FILTER (WHERE estado_pago = 'confirmado_parcial') as parciales
        FROM orders_validated
      ),
      efectivo_stats AS (
        SELECT COALESCE(SUM(monto), 0) as efectivo_hoy
        FROM pagos_efectivo
        WHERE (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = (SELECT fecha FROM hoy)
      )
      SELECT
        json_build_object(
          'a_confirmar', cs.a_confirmar,
          'confirmados_hoy', cs.confirmados_hoy,
          'rechazados_hoy', cs.rechazados_hoy,
          'monto_confirmado_hoy', cs.monto_confirmado_hoy
        ) as comprobantes,
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
      FROM comprobantes_stats cs, remitos_stats rs, pedidos_stats ps, pagos_stats pgs, efectivo_stats es
    `);

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
        CASE WHEN sr.id IS NOT NULL THEN true ELSE false END as has_shipping_request
      FROM orders_validated o
      LEFT JOIN shipping_requests sr ON o.order_number = sr.order_number
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
    if (shipping_data === 'pending') {
      // Solo pedidos que requieren form Y no tienen datos cargados
      conditions.push(`(
        (LOWER(COALESCE(o.shipping_type, '')) LIKE '%expreso%' AND LOWER(COALESCE(o.shipping_type, '')) LIKE '%elec%')
        OR LOWER(COALESCE(o.shipping_type, '')) LIKE '%via cargo%'
        OR LOWER(COALESCE(o.shipping_type, '')) LIKE '%viacargo%'
      )`);
      conditions.push(`NOT EXISTS (SELECT 1 FROM shipping_requests sr2 WHERE sr2.order_number = o.order_number)`);
    } else if (shipping_data === 'complete') {
      // Solo pedidos que requieren form Y ya tienen datos cargados
      conditions.push(`(
        (LOWER(COALESCE(o.shipping_type, '')) LIKE '%expreso%' AND LOWER(COALESCE(o.shipping_type, '')) LIKE '%elec%')
        OR LOWER(COALESCE(o.shipping_type, '')) LIKE '%via cargo%'
        OR LOWER(COALESCE(o.shipping_type, '')) LIKE '%viacargo%'
      )`);
      conditions.push(`EXISTS (SELECT 1 FROM shipping_requests sr2 WHERE sr2.order_number = o.order_number)`);
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

    // Query con filtros
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
        COUNT(c.id) as comprobantes_count,
        (SELECT COALESCE(SUM(op.quantity), 0) FROM order_products op WHERE op.order_number = o.order_number)::int as productos_count,
        CASE
          WHEN LOWER(COALESCE(o.shipping_type, '')) LIKE '%expreso%' AND LOWER(COALESCE(o.shipping_type, '')) LIKE '%elec%' THEN true
          WHEN LOWER(COALESCE(o.shipping_type, '')) LIKE '%via cargo%' THEN true
          WHEN LOWER(COALESCE(o.shipping_type, '')) LIKE '%viacargo%' THEN true
          ELSE false
        END as requires_shipping_form,
        CASE WHEN sr.order_number IS NOT NULL THEN true ELSE false END as has_shipping_data
      FROM orders_validated o
      LEFT JOIN comprobantes c ON o.order_number = c.order_number
      LEFT JOIN shipping_requests sr ON o.order_number = sr.order_number
      ${whereClause}
      GROUP BY o.order_number, o.monto_tiendanube, o.total_pagado, o.saldo, o.estado_pago, o.estado_pedido, o.currency, o.tn_created_at, o.created_at, o.customer_name, o.customer_email, o.customer_phone, o.printed_at, o.packed_at, o.shipped_at, o.shipping_type, sr.order_number
      ORDER BY CAST(NULLIF(REGEXP_REPLACE(o.order_number, '[^0-9]', '', 'g'), '') AS BIGINT) DESC NULLS LAST
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
        c.created_at,
        c.confirmed_at,
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

    res.json({
      ok: true,
      comprobantes: comprobantesRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
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
        c.created_at,
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

    // Obtener logs del comprobante
    const logsRes = await pool.query(`
      SELECT id, accion, origen, created_at
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

    // 3️⃣ Recalcular total pagado (comprobantes + efectivo) using client
    const compSumRes = await client.query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM comprobantes WHERE order_number = $1 AND estado = 'confirmado'`,
      [comprobante.order_number]
    );
    const efectivoSumRes = await client.query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM pagos_efectivo WHERE order_number = $1`,
      [comprobante.order_number]
    );
    const totalPagado = Number(compSumRes.rows[0].total) + Number(efectivoSumRes.rows[0].total);

    // 4️⃣ Obtener monto, estado actual y datos de cliente del pedido
    const orderRes = await client.query(
      `SELECT monto_tiendanube, estado_pedido, customer_name, customer_phone, shipping_type, tn_order_id FROM orders_validated WHERE order_number = $1`,
      [comprobante.order_number]
    );

    const orderData = orderRes.rows[0];
    const montoPedido = Number(orderData.monto_tiendanube);
    const estadoPedidoActual = orderData.estado_pedido;
    const saldo = montoPedido - totalPagado;

    // 5️⃣ Definir estado_pago
    let estadoPago = 'pendiente';
    if (saldo <= 0) {
      estadoPago = 'confirmado_total';
    } else if (totalPagado > 0) {
      estadoPago = 'confirmado_parcial';
    }

    // 6️⃣ Calcular nuevo estado_pedido (lógica centralizada)
    const nuevoEstadoPedido = calcularEstadoPedido(estadoPago, estadoPedidoActual);

    // 7️⃣ Actualizar orden
    await client.query(
      `UPDATE orders_validated
       SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
       WHERE order_number = $5`,
      [totalPagado, saldo, estadoPago, nuevoEstadoPedido, comprobante.order_number]
    );

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
      log.info({ requestId, comprobanteId: id, orderNumber: comprobante.order_number, customerPhone, action: 'whatsapp_comprobante_confirmado' }, 'Sending WhatsApp comprobante_confirmado');
      queueWhatsApp({
        telefono: customerPhone,
        plantilla: 'comprobante_confirmado',
        variables: { '1': customerName, '2': String(comprobante.monto), '3': comprobante.order_number },
        orderNumber: comprobante.order_number
      }).catch(err => log.error({ err, requestId, comprobanteId: id, orderNumber: comprobante.order_number }, 'Error WhatsApp comprobante_confirmado'));

      // Enviar datos__envio si es el primer comprobante confirmado y requiere formulario
      if (requiresShippingForm(shippingType)) {
        // Verificar si es el primer comprobante confirmado
        const countRes = await pool.query(
          `SELECT COUNT(*) as count FROM comprobantes WHERE order_number = $1 AND estado = 'confirmado'`,
          [comprobante.order_number]
        );

        if (parseInt(countRes.rows[0].count) === 1) {
          log.info({ requestId, comprobanteId: id, orderNumber: comprobante.order_number, customerPhone, action: 'whatsapp_datos_envio' }, 'Sending WhatsApp datos__envio');
          queueWhatsApp({
            telefono: customerPhone,
            plantilla: 'datos__envio',
            variables: { '1': customerName, '2': comprobante.order_number }
          }).catch(err => log.error({ err, requestId, comprobanteId: id, orderNumber: comprobante.order_number }, 'Error WhatsApp datos__envio'));
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
      queueWhatsApp({
        telefono: comprobante.customer_phone,
        plantilla: 'comprobante_rechazado',
        variables: {
          '1': comprobante.customer_name || 'Cliente',
          '2': String(comprobante.monto),
          '3': comprobante.order_number
        },
        orderNumber: comprobante.order_number
      }).then(() => log.info({ requestId, comprobanteId: id, orderNumber: comprobante.order_number }, 'WhatsApp comprobante_rechazado sent'))
        .catch(err => log.error({ err, requestId, comprobanteId: id, orderNumber: comprobante.order_number }, 'Error WhatsApp comprobante_rechazado'));
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

    // Determinar shipping_address: prioridad a shipping_requests, fallback a orders_validated
    let shippingAddress = null;
    if (shippingRequest) {
      // Mapear campos de shipping_requests a la estructura esperada
      const empresaEnvio = shippingRequest.empresa_envio === 'OTRO'
        ? shippingRequest.empresa_envio_otro
        : 'Via Cargo';
      shippingAddress = {
        name: shippingRequest.nombre_apellido,
        address: shippingRequest.direccion_entrega,
        number: '',  // No tenemos este campo separado en shipping_requests
        floor: shippingRequest.destino_tipo === 'SUCURSAL' ? `Sucursal ${empresaEnvio}` : null,
        locality: shippingRequest.localidad,
        city: shippingRequest.localidad,  // Usamos localidad como city
        province: shippingRequest.provincia,
        zipcode: shippingRequest.codigo_postal,
        phone: shippingRequest.telefono,
        between_streets: null,
        reference: shippingRequest.comentarios || `Envío: ${empresaEnvio}`,
      };
      console.log(`   📦 Usando datos de /envio para pedido #${orderNumber}`);
    } else if (order.shipping_address) {
      // Fallback: usar datos de Tiendanube
      shippingAddress = order.shipping_address;
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
      shipping: (() => {
        const type = order.shipping_type || 'No especificado';
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
        shipping_type
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
    const logsRes = await pool.query(`
      SELECT id, accion, origen, username, created_at FROM (
        -- Logs vinculados a comprobantes del pedido
        SELECT
          l.id,
          l.accion,
          l.origen,
          l.username,
          l.created_at
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
          l.created_at
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
      const searchRes = await axios.get(
        `https://api.tiendanube.com/v1/${storeId}/orders`,
        {
          headers: {
            authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
            'User-Agent': 'bpm-validator'
          },
          params: { q: orderNumber },
          timeout: 10000
        }
      );

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
    const pedidoRes = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
      {
        headers: {
          authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-validator'
        },
        timeout: 10000
      }
    );

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
        const pedidoRes = await axios.get(
          `https://api.tiendanube.com/v1/${storeId}/orders/${tn_order_id}`,
          {
            headers: {
              authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
              'User-Agent': 'bpm-validator'
            },
            timeout: 10000
          }
        );

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
        const pedidoRes = await axios.get(
          `https://api.tiendanube.com/v1/${storeId}/orders/${tn_order_id}`,
          {
            headers: {
              authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
              'User-Agent': 'bpm-validator'
            },
            timeout: 10000
          }
        );

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
        const tnResponse = await axios.get(
          `https://api.tiendanube.com/v1/${storeId}/orders/${tn_order_id}`,
          {
            headers: {
              authentication: `bearer ${accessToken}`,
              'User-Agent': 'bpm-validator'
            },
            timeout: 10000
          }
        );

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
        queueWhatsApp({
          telefono: pedido.customer_phone,
          plantilla: 'enviado_env_nube',
          variables: {
            '1': pedido.customer_name || 'Cliente',
            '2': orderNumber,
            '3': trackingParam
          },
          orderNumber
        }).then(() => console.log(`📨 WhatsApp enviado_env_nube enviado (Pedido #${orderNumber})`))
          .catch(err => console.error('⚠️ Error WhatsApp enviado_env_nube:', err.message));
      } else if (esEnvioNube) {
        console.log(`⚠️ No se envió WhatsApp enviado_env_nube: faltan datos (phone: ${!!pedido.customer_phone}, order_id: ${!!pedido.tn_order_id}, token: ${!!pedido.tn_order_token})`);
      }
      // Nota: enviado_transporte se envía desde remitos.js al confirmar remito (con imagen)
    }

    // WhatsApp automático cuando se marca como "cancelado"
    if (estado_pedido === 'cancelado' && pedido.customer_phone) {
      queueWhatsApp({
        telefono: pedido.customer_phone,
        plantilla: 'pedido_cancelado',
        variables: {
          '1': pedido.customer_name || 'Cliente',
          '2': orderNumber
        },
        orderNumber
      }).then(() => console.log(`📨 WhatsApp pedido_cancelado enviado (Pedido #${orderNumber})`))
        .catch(err => console.error('⚠️ Error WhatsApp pedido_cancelado:', err.message));
    }

    // Sincronizar estado hacia Tiendanube (async, no bloquea respuesta)
    if (pedido.tn_order_id) {
      const ESTADO_TN_MAP: Record<string, { tnStatus: string; configKey: string; label: string }> = {
        'armado':    { tnStatus: 'packed',    configKey: 'tiendanube_sync_estado_armado',    label: 'empaquetada' },
        'enviado':   { tnStatus: 'fulfilled', configKey: 'tiendanube_sync_estado_enviado',   label: 'despachada' },
        'cancelado': { tnStatus: 'cancelled', configKey: 'tiendanube_sync_estado_cancelado', label: 'cancelada' },
      };

      const syncConfig = ESTADO_TN_MAP[estado_pedido];
      if (syncConfig) {
        isIntegrationEnabled(syncConfig.configKey, { context: `sync-estado-${estado_pedido}` })
          .then(enabled => {
            if (enabled) {
              sincronizarEstadoTiendanube(pedido.tn_order_id, orderNumber, syncConfig.tnStatus, syncConfig.label);
            }
          })
          .catch(err => console.error(`⚠️ Error checking sync toggle for ${estado_pedido}:`, err.message));
      }
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
    }
  } catch (qErr) {
    // 23505 = unique_violation - backup por race conditions extremas
    if (qErr.code === '23505') {
      log.info({ event, orderId }, 'Webhook already enqueued (catch), skipping');
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
        // Actualizar estado en DB
        await pool.query(`
          UPDATE orders_validated
          SET estado_pedido = 'cancelado'
          WHERE order_number = $1
        `, [orderNumber]);

        // Registrar en log de actividad
        await logEvento({
          orderNumber,
          accion: 'pedido_cancelado',
          origen: 'webhook_tiendanube'
        });

        // WhatsApp al cliente - pedido_cancelado
        const clienteCancelRes = await pool.query(
          `SELECT customer_name, customer_phone FROM orders_validated WHERE order_number = $1`,
          [orderNumber]
        );
        const clienteCancel = clienteCancelRes.rows[0];
        if (clienteCancel?.customer_phone) {
          queueWhatsApp({
            telefono: clienteCancel.customer_phone,
            plantilla: 'pedido_cancelado',
            variables: {
              '1': clienteCancel.customer_name || 'Cliente',
              '2': orderNumber
            },
            orderNumber
          }).then(() => log.info({ orderNumber }, 'WhatsApp pedido_cancelado sent'))
            .catch(err => log.error({ err, orderNumber }, 'Error WhatsApp pedido_cancelado'));
        }

        log.info({ orderNumber, orderId }, 'Order marked as cancelled in DB');
      }
      return;
    }

    // Solo procesar order/created y order/updated
    if (event !== 'order/created' && event !== 'order/updated') return;

    // Check sub-toggle por evento
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
    if (event === 'order/updated') {
      // Verificar si existe en nuestra DB
      const existente = await pool.query(
        `SELECT order_number, monto_tiendanube, total_pagado, estado_pago,
                tn_payment_status, tn_shipping_status
         FROM orders_validated WHERE order_number = $1`,
        [String(pedido.number)]
      );

      if (existente.rowCount === 0) {
        log.warn({ orderNumber: pedido.number, orderId }, 'order/updated for non-existent order in DB, ignoring');
        return;
      }

      const db = existente.rows[0];

      // Valores nuevos de Tiendanube
      const montoNuevo = Math.round(Number(pedido.total));
      const paymentStatusNuevo = pedido.payment_status || null;
      const shippingStatusNuevo = pedido.shipping || null; // El campo es "shipping", no "shipping_status"

      // Valores actuales en DB
      const montoAnterior = Number(db.monto_tiendanube);
      const paymentStatusAnterior = db.tn_payment_status;
      const shippingStatusAnterior = db.tn_shipping_status;

      // Obtener productos ANTES de actualizar
      const productosDB = await pool.query(
        `SELECT product_id, variant_id, name, quantity FROM order_products WHERE order_number = $1`,
        [String(pedido.number)]
      );

      // Generar mensaje de cambios
      const mensaje = buildOrderUpdateMessage(
        productosDB.rows,
        pedido.products || [],
        montoNuevo
      );

      // Actualizar DB
      await guardarPedidoCompleto(pedido);

      // 🔍 Verificar consistencia con TiendaNube
      await verificarConsistencia(String(pedido.number), pedido);

      // Verificar si hubo cambios en productos (más de solo la línea del monto)
      const lineas = mensaje.split('\n');
      const hayProductosCambiados = lineas.length > 1;
      const cambioMonto = montoAnterior !== montoNuevo;

      if (!hayProductosCambiados && !cambioMonto) {
        return; // Sin cambios relevantes
      }

      log.info({ orderNumber: String(pedido.number), changes: mensaje }, 'Order updated via webhook');

      // Si cambió el monto, recalcular saldo y estado_pago
      if (cambioMonto) {
        await pool.query(`
          UPDATE orders_validated
          SET
            saldo = monto_tiendanube - total_pagado,
            estado_pago = CASE
              WHEN estado_pago IN ('confirmado_total', 'confirmado_parcial', 'a_favor') THEN
                CASE
                  WHEN monto_tiendanube - total_pagado <= 0 THEN 'confirmado_total'
                  WHEN total_pagado > 0 THEN 'confirmado_parcial'
                  ELSE 'pendiente'
                END
              ELSE estado_pago
            END
          WHERE order_number = $1
        `, [String(pedido.number)]);
      }

      // Guardar en historial
      await logEvento({
        orderNumber: String(pedido.number),
        accion: mensaje,
        origen: 'webhook_tiendanube'
      });

      return;
    }

    // order/created: Guardar pedido completo (datos + productos)
    await guardarPedidoCompleto(pedido);
    log.info({ orderNumber: String(pedido.number), orderId }, 'Order saved in DB (order/created)');

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

    // 6️⃣ Botmaker - enviarWhatsAppPlantilla maneja testing filter, sufijo y tracking
    await queueWhatsApp({
      telefono,
      plantilla: 'pedido_creado',
      variables: {
        '1': pedido.customer?.name || 'Cliente',
        '2': String(pedido.number)
      },
      orderNumber: pedido.number
    });

    log.info({ orderNumber: String(pedido.number) }, 'WhatsApp pedido_creado sent');

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

    const tnResponse = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/orders`,
      {
        headers: {
          authentication: `bearer ${accessToken}`, // ⚠️ minúscula
          'User-Agent': 'bpm-validator'
        },
        params: {
          q: sanitized
        }
      }
    );

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
    const tnResponse = await axios.get(
      `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}/orders`,
      {
        headers: {
          authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-validator'
        },
        params: { q: orderNumber }
      }
    );

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
       3️⃣ HASH (DUPLICADOS)
    ================================ */
    const hash = hashText(textoOcr);

    const dup = await pool.query(
      'select id from comprobantes where hash_ocr = $1',
      [hash]
    );

    if (dup.rows.length > 0) {
      await logEvento({
        orderNumber,
        accion: 'comprobante_duplicado',
        origen: 'sistema'
      });
      console.log(`⚠️ Comprobante duplicado detectado - Order: ${orderNumber}, Hash: ${hash}, Original ID: ${dup.rows[0].id}`);

      fs.unlinkSync(file.path);
      return res.status(409).json({ error: 'Comprobante duplicado' });
    }

    /* ===============================
       4️⃣ MONTO DESDE CLAUDE
    ================================ */
    const montoDetectado = datosClaude.monto;

    /* ===============================
       5️⃣ PREPARAR URL DE SUPABASE
    ================================ */
    // Sanitizar nombre de archivo (remover caracteres especiales y espacios)
    const sanitizedFilename = file.originalname
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remover acentos
      .replace(/[^\w.-]/g, '_') // Reemplazar caracteres especiales por _
      .replace(/_+/g, '_'); // Colapsar múltiples _
    const supabasePath = `pendientes/${Date.now()}-${sanitizedFilename}`;
    const { data: publicUrlData } = supabase.storage
      .from('comprobantes')
      .getPublicUrl(supabasePath);
    const fileUrl = publicUrlData.publicUrl;

    /* ===============================
       6️⃣ INSERTAR COMPROBANTE
    ================================ */
    const financieraId = destinoValidation.cuenta?.id || null;

    const insert = await pool.query(
      `insert into comprobantes
       (order_number, hash_ocr, texto_ocr, monto, monto_tiendanube, file_url, estado, financiera_id)
       values ($1,$2,$3,$4,$5,$6,'a_confirmar',$7)
       returning id`,
      [
        orderNumber,
        hash,
        textoOcr,
        montoDetectado,
        montoTiendanube,
        fileUrl,
        financieraId
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
       8️⃣ SUBIR ARCHIVO A SUPABASE
    ================================ */
    const finalBuffer = await fs.promises.readFile(file.path);

    const { error: uploadError } = await supabase.storage
      .from('comprobantes')
      .upload(supabasePath, finalBuffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('❌ Supabase upload error:', uploadError);
      throw new Error('Error subiendo archivo a storage');
    }

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

      console.log('plantilla final:', plantilla, 'variables:', variables);
      queueWhatsApp({
        telefono,
        plantilla,
        variables,
        orderNumber
      }).catch(err =>
        console.error('⚠️ Error WhatsApp cliente:', err.message)
      );
      await logEvento({
        comprobanteId,
        accion: 'whatsapp_cliente_enviado',
        origen: 'sistem'
      });
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

    // 3️⃣ Recalcular total pagado using client
    const compSumRes = await client.query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM comprobantes WHERE order_number = $1 AND estado = 'confirmado'`,
      [comprobante.order_number]
    );
    const efectivoSumRes = await client.query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM pagos_efectivo WHERE order_number = $1`,
      [comprobante.order_number]
    );
    const totalPagado = Number(compSumRes.rows[0].total) + Number(efectivoSumRes.rows[0].total);

    // 4️⃣ Obtener monto y estado actual del pedido
    const orderRes = await client.query(
      `SELECT monto_tiendanube, estado_pedido FROM orders_validated WHERE order_number = $1`,
      [comprobante.order_number]
    );

    const montoPedido = Number(orderRes.rows[0].monto_tiendanube);
    const estadoPedidoActual = orderRes.rows[0].estado_pedido;
    const saldo = montoPedido - totalPagado;

    // 5️⃣ Definir estado_pago correcto
    let estadoPago = 'pendiente';
    if (saldo <= 0) {
      estadoPago = 'confirmado_total';
    } else if (totalPagado > 0) {
      estadoPago = 'confirmado_parcial';
    }

    // 6️⃣ Calcular nuevo estado_pedido (lógica centralizada)
    const nuevoEstadoPedido = calcularEstadoPedido(estadoPago, estadoPedidoActual);

    // 7️⃣ Actualizar orden
    await client.query(
      `UPDATE orders_validated
       SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
       WHERE order_number = $5`,
      [totalPagado, saldo, estadoPago, nuevoEstadoPedido, comprobante.order_number]
    );

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

  try {
    await axios.put(
      `https://api.tiendanube.com/v1/${storeId}/orders/${tnOrderId}`,
      { status: tnStatus },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authentication': `bearer ${token}`,
          'User-Agent': 'BPM Administrador (netubpm@gmail.com)'
        }
      }
    );
    console.log(`✅ [Orden ${orderNumber}] Marcada como ${labelEs} en Tiendanube (tn_order_id: ${tnOrderId})`);
    return true;
  } catch (err) {
    console.error(`❌ [Orden ${orderNumber}] Error marcando ${labelEs} en Tiendanube: ${err.response?.status} ${JSON.stringify(err.response?.data || err.message)}`);
    return false;
  }
}


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
       3️⃣ RECALCULAR TOTAL PAGADO (comprobantes + efectivo) using client
    ================================ */
    const compSumRes = await client.query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM comprobantes WHERE order_number = $1 AND estado = 'confirmado'`,
      [orderNumber]
    );
    const efectivoSumRes = await client.query(
      `SELECT COALESCE(SUM(monto), 0) AS total FROM pagos_efectivo WHERE order_number = $1`,
      [orderNumber]
    );
    const totalPagado = Number(compSumRes.rows[0].total) + Number(efectivoSumRes.rows[0].total);
    const saldo = montoTiendanube - totalPagado;

    /* ===============================
       4️⃣ DETERMINAR ESTADO DE PAGO
    ================================ */
    let estadoPago = 'pendiente';
    const TOLERANCIA = 1000;

    if (Math.abs(saldo) <= TOLERANCIA) {
      estadoPago = 'confirmado_total';
    } else if (saldo > 0) {
      estadoPago = 'confirmado_parcial';
    } else {
      estadoPago = 'a_favor';
    }

    /* ===============================
       5️⃣ CALCULAR ESTADO PEDIDO (lógica centralizada)
    ================================ */
    const nuevoEstadoPedido = calcularEstadoPedido(estadoPago, estadoPedidoActual);

    /* ===============================
       6️⃣ ACTUALIZAR ORDEN
    ================================ */
    await client.query(
      `UPDATE orders_validated
       SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
       WHERE order_number = $5`,
      [totalPagado, saldo, estadoPago, nuevoEstadoPedido, orderNumber]
    );

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
const waspyRoutes = require('./routes/waspy');
const integrationsRoutes = require('./routes/integrations');
const healthRoutes = require('./routes/health');
const adminStatusRoutes = require('./routes/admin-status');
// AI Bot routes — loaded defensively to never crash BPM startup
let aiBotRoutes;
try {
  aiBotRoutes = require('./routes/ai-bot');
} catch (err) {
  console.error('[AI Bot] Failed to load routes — bot disabled, BPM unaffected:', err.message);
  aiBotRoutes = null;
}
const { serverAdapter: bullBoardAdapter, bullBoardAuth } = require('./routes/bull-board');

app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/roles', rolesRoutes);
app.use('/financieras', financierasRoutes);
app.use('/remitos', remitosRoutes);
app.use('/waspy', waspyRoutes);
app.use('/integrations', integrationsRoutes);
app.use('/health', healthRoutes);
app.use('/admin/status', adminStatusRoutes);
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
// SYNC LOCK: Distributed lock usando tabla (compatible con Supabase Pooler)
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

// Sync de un cliente específico
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

// Sync orders_count from TN orders API (llenar datos que customers API no provee)
app.post('/sync/customers/orders-count', authenticate, requirePermission('customers.sync'), async (req, res) => {
  try {
    console.log(`📦 [CustomerSync] Sync orders_count iniciado por ${req.user.username}`);
    const result = await customerSync.syncOrdersCountFromTN();
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('❌ /sync/customers/orders-count error:', error.message);
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
    const counts = await customerSegmentation.getSegmentCounts();
    const definitions = customerSegmentation.getSegmentDefinitions();
    res.json({ ok: true, counts, definitions });
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

    const result = await customerSegmentation.getCustomersBySegment(segment, { page, limit });
    res.json({ ok: true, ...result });
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

    const { rows } = await pool.query(`
      SELECT
        id, tn_customer_id, name, email, phone,
        orders_count, total_spent, first_order_at, last_order_at, avg_order_value,
        segment, segment_updated_at, created_at
      FROM customers
      ${whereClause}
      ORDER BY total_spent DESC NULLS LAST
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...params, limit, offset]);

    res.json({
      ok: true,
      customers: rows,
      total: parseInt(countResult.rows[0].total),
      page,
      limit
    });
  } catch (error) {
    console.error('❌ /customers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Scheduler: ejecutar sync cada 15 minutos
const SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutos
let syncInterval = null;

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

  // Image sync: reordenar imagen principal cada 1 hora
  const { startScheduler: startImageSyncScheduler } = require('./services/tiendanubeImageSync');
  if (process.env.TIENDANUBE_STORE_ID && process.env.TIENDANUBE_ACCESS_TOKEN) {
    // Delay inicial de 60s para no solapar con el sync de órdenes
    setTimeout(() => {
      startImageSyncScheduler(5 * 60 * 60 * 1000); // cada 5 horas
    }, 60000);
  }
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

      // === FOOTER ===
      doc.text('BPM Administrador - www.bpmadministrador.com', 40, 780, { align: 'center' });
    }

    doc.end();

    // Registrar la impresión en shipping_requests
    await pool.query(`
      UPDATE shipping_requests
      SET label_printed_at = NOW(),
          label_bultos = COALESCE(label_bultos, 0) + $1
      WHERE id = $2
    `, [bultos, shipping.id]);

    // Registrar en logs
    await logEvento({
      orderNumber,
      accion: `etiqueta_impresa_${bultos}_bultos`,
      origen: 'crm',
      userId: req.user?.id,
      username: req.user?.name
    });

    console.log(`🏷️ Etiqueta generada para pedido ${orderNumber} (${bultos} bultos)`);

  } catch (error) {
    console.error('❌ GET /orders/:orderNumber/shipping-label error:', error.message);
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
      SELECT order_number, tn_order_id, shipping_type, customer_name
      FROM orders_validated
      WHERE order_number = ANY($1)
    `, [orders]);

    const ordersMap = new Map(orderRes.rows.map(o => [o.order_number, o]));

    // 2. Procesar cada pedido
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

      try {
        // Obtener etiquetas
        const labelResult = await obtenerEtiquetasEnvioNube(order.tn_order_id);

        if (!labelResult.ok) {
          results.failed.push({ order: orderNumber, error: labelResult.error });
          continue;
        }

        // Descargar el PDF
        const labelUrl = labelResult.labels[0].url;
        const pdfResponse = await axios.get(labelUrl, {
          responseType: 'arraybuffer',
          timeout: 30000
        });

        results.pdfBuffers.push({
          orderNumber,
          buffer: pdfResponse.data
        });

        results.success.push({
          order: orderNumber,
          customer: order.customer_name,
          tracking: labelResult.labels[0].tracking_code
        });

      } catch (err) {
        results.failed.push({ order: orderNumber, error: err.message });
      }
    }

    // 3. Si no hay PDFs exitosos, retornar error
    if (results.pdfBuffers.length === 0) {
      return res.status(400).json({
        error: 'No se pudo obtener ninguna etiqueta',
        failed: results.failed
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

    // 5. Registrar en logs
    for (const { order } of results.success) {
      await logEvento({
        orderNumber: order,
        accion: 'envio_nube_label_masiva',
        origen: 'crm',
        userId: req.user?.id,
        username: req.user?.name
      });
    }

    console.log(`🏷️ ${results.success.length} etiquetas Envío Nube combinadas (${results.failed.length} fallidas)`);

    // 6. Retornar PDF combinado
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=etiquetas-envio-nube-${Date.now()}.pdf`);
    res.setHeader('X-Labels-Success', results.success.length);
    res.setHeader('X-Labels-Failed', results.failed.length);
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
