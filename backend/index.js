
require('dotenv').config();

// Forzar IPv4 (Windows / pooler)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const supabase = require('./supabase');
const pool = require('./db');
const { ocrFromUrl } = require('./services/ocrFromUrl');
const { hashText } = require('./hash');
const { authenticate, requirePermission } = require('./middleware/auth');
const crypto = require('crypto');
const sharp = require('sharp');
const { runSyncJob } = require('./services/orderSync');
const { getQueueStats, getSyncState } = require('./services/syncQueue');
const app = express();
const PORT = process.env.PORT || 3000;

// Desactivar ETag globalmente para evitar respuestas 304
app.set('etag', false);

// Configurar Google Cloud Vision credentials para producción (Railway)
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const credentialsPath = '/tmp/google-credentials.json';
  fs.writeFileSync(credentialsPath, process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  console.log('✅ Google credentials configuradas desde variable de entorno');
}

const vision = require('@google-cloud/vision');
const { log } = require('console');
const visionClient = new vision.ImageAnnotatorClient();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// CORS para permitir requests del frontend
const allowedOrigins = process.env.FRONTEND_URL
  ? [
      process.env.FRONTEND_URL,
      process.env.FRONTEND_URL.replace('https://', 'https://www.'),
      process.env.FRONTEND_URL.replace('https://www.', 'https://'),
      'http://localhost:5173',
      'http://localhost:3001'
    ]
  : ['*'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

async function logEvento({ comprobanteId, accion, origen }) {
  try {
    await pool.query(
      `INSERT INTO logs (comprobante_id, accion, origen)
       VALUES ($1, $2, $3)`,
      [comprobanteId, accion, origen]
    );
  } catch (err) {
    console.error('❌ Error guardando log:', err.message);
  }
}

/* =====================================================
   UTIL — WATERMARK RECEIPT IMAGE
===================================================== */
async function watermarkReceipt(filePath, { id, orderNumber }) {
  const image = sharp(filePath);
  const metadata = await image.metadata();

  const width = metadata.width || 800;
  const fontSize = Math.max(18, Math.round(width * 0.03));
  const padding = Math.round(fontSize * 0.6);
  const lineHeight = Math.round(fontSize * 1.3);

  const lines = [
    `ID: ${id}`,
    `Pedido: ${orderNumber}`
  ];

  const textWidth = Math.round(fontSize * 10);
  const textHeight = lines.length * lineHeight + padding * 2;

  const svgOverlay = `
    <svg width="${textWidth}" height="${textHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${textWidth}" height="${textHeight}"
            fill="rgba(0,0,0,0.7)" rx="4" ry="4"/>
      ${lines.map((line, i) => `
        <text x="${padding}" y="${padding + fontSize + i * lineHeight}"
              font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="${fontSize}"
              fill="white" font-weight="bold">${line}</text>
      `).join('')}
    </svg>
  `;

  await sharp(filePath)
    .composite([{
      input: Buffer.from(svgOverlay),
      top: padding,
      left: padding
    }])
    .toFile(filePath + '.tmp');

  fs.renameSync(filePath + '.tmp', filePath);

  console.log('🏷️ Watermark aplicado:', filePath);
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
   UTIL — DETECTAR MONTO DESDE OCR (LÓGICA PROBADA)
===================================================== */
function detectarMontoDesdeOCR(texto) {
  if (!texto) return { monto: null, moneda: null };

  const textoNormalizado = texto
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\x00-\x7F]/g, '');

  const palabrasClaveFuertes = ['importe', 'monto', 'total', '$', 'ars', 'pesos'];
  const palabrasTrampa = ['cbu', 'cvu', 'cuit', 'cuil', 'operacion', 'referencia', 'codigo', 'alias'];

  const regexMonto = /\$?\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/g;
  const matches = textoNormalizado.match(regexMonto);

  if (!matches) return { monto: null, moneda: null };

  let mejorMonto = null;
  let mejorPuntaje = -1;

  for (const match of matches) {
    const valorNumerico = Number(
      match.replace('$', '').replace(/\./g, '').replace(',', '.')
    );

    if (isNaN(valorNumerico)) continue;
    if (valorNumerico < 1000) continue;
    if (!match.includes('.')) continue;

    let puntaje = 0;

    const idx = textoNormalizado.indexOf(match);
    const contexto = textoNormalizado.substring(
      Math.max(0, idx - 50),
      idx + 50
    );

    if (match.includes('$')) puntaje += 2;
    if (palabrasClaveFuertes.some(p => contexto.includes(p))) puntaje += 3;
    if (!palabrasTrampa.some(p => contexto.includes(p))) puntaje += 2;
    if (idx < textoNormalizado.length * 0.3) puntaje += 1;

    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejorMonto = match;
    }
  }

  if (!mejorMonto) return { monto: null, moneda: null };

  const montoNumero = Number(
    mejorMonto.replace('$', '').replace(/\./g, '').replace(',', '.')
  );

  if (isNaN(montoNumero)) return { monto: null, moneda: null };

  return { monto: montoNumero, moneda: 'ARS' };
}

/* =====================================================
   UTIL — VALIDAR QUE SEA COMPROBANTE REAL
===================================================== */
function validarComprobante(textoOcr) {
  const mensajeError =
    'El archivo no parece ser un comprobante válido. Contactate con nosotros por WhatsApp para que te ayudemos.';

  if (!textoOcr) {
    throw new Error(mensajeError);
  }

  const texto = textoOcr.toLowerCase().replace(/\s+/g, ' ');

  const keywords = [
    'transferencia',
    'comprobante',
    'pago',
    'importe',
    'total',
    'fecha',
    'operacion',
    'referencia',
    'cbu',
    'cvu',
    'alias'
  ];

  const esValido =
    texto.length >= 30 &&
    keywords.some(k => texto.includes(k));

  if (!esValido) {
    throw new Error(mensajeError);
  }
}

async function detectarFinancieraDesdeOCR(textoOcr) {
  const res = await pool.query(
    `select id, nombre, celular, palabras_clave
     from financieras
     where activa = true`
  );

  const texto = textoOcr.toLowerCase();

  for (const fin of res.rows) {
    const keywords = fin.palabras_clave || [];
    const match = keywords.some(k => texto.includes(k.toLowerCase()));
    if (match) return fin;
  }
  return null;
}



async function enviarWhatsAppPlantilla({ telefono, plantilla, variables }) {
  const contactIdClean = telefono.replace('+', '');

  return axios.post(
    'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
    {
      chat: {
        channelId: process.env.BOTMAKER_CHANNEL_ID,
        contactId: contactIdClean
      },
      intentIdOrName: plantilla,
      variables
    },
    {
      headers: {
        'access-token': process.env.BOTMAKER_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );
}


async function enviarComprobanteAFinanciera({
  financiera,
  fileUrl,
  comprobanteId
}) {
  try {
    const contactIdClean = financiera.celular.replace('+', '');

    console.log('🏦 Enviando comprobante a financiera:', financiera.nombre);
    console.log('📸 URL imagen:', fileUrl);
    console.log('🆔 Comprobante ID:', comprobanteId);

    // ✅ ÚNICO ENVÍO: plantilla aprobada (funciona +24hs)
    await axios.post(
      'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
      {
        chat: {
          channelId: process.env.BOTMAKER_CHANNEL_ID,
          contactId: contactIdClean
        },
        intentIdOrName: 'revision_financiera_v3',
        variables: {
          headerImageUrl: fileUrl,
          '1': String(comprobanteId)
        },
        webhookPayload: 'envio_comprobante_financiera'
      },
      {
        headers: {
          'access-token': process.env.BOTMAKER_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('📨 Comprobante enviado a financiera (plantilla)');

    return true;

  } catch (err) {
    console.error('❌ Error enviando comprobante a financiera:');
    console.error('Mensaje:', err.message);
    console.error('Response data:', JSON.stringify(err.response?.data, null, 2));
    console.error('Status:', err.response?.status);
    throw err;
  }
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
    const { estado_pago, estado_pedido, search, fecha } = req.query;

    // Construir WHERE dinámico
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (estado_pago && estado_pago !== 'all') {
      conditions.push(`o.estado_pago = $${paramIndex++}`);
      params.push(estado_pago);
    }

    if (estado_pedido && estado_pedido !== 'all') {
      conditions.push(`o.estado_pedido = $${paramIndex++}`);
      params.push(estado_pedido);
    }

    if (search) {
      conditions.push(`(
        o.order_number ILIKE $${paramIndex} OR
        o.customer_name ILIKE $${paramIndex} OR
        o.customer_email ILIKE $${paramIndex} OR
        o.customer_phone ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (fecha === 'hoy') {
      conditions.push(`DATE(o.created_at) = CURRENT_DATE`);
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
        o.created_at,
        o.customer_name,
        o.customer_email,
        o.customer_phone,
        o.printed_at,
        o.packed_at,
        o.shipped_at,
        COUNT(c.id) as comprobantes_count
      FROM orders_validated o
      LEFT JOIN comprobantes c ON o.order_number = c.order_number
      ${whereClause}
      GROUP BY o.order_number, o.monto_tiendanube, o.total_pagado, o.saldo, o.estado_pago, o.estado_pedido, o.currency, o.created_at, o.customer_name, o.customer_email, o.customer_phone, o.printed_at, o.packed_at, o.shipped_at
      ORDER BY CAST(REGEXP_REPLACE(o.order_number, '[^0-9]', '', 'g') AS INTEGER) DESC
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

    // Contar total
    const countRes = await pool.query(`SELECT COUNT(*) as total FROM comprobantes`);
    const total = parseInt(countRes.rows[0].total);

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
        o.customer_name,
        o.estado_pago as orden_estado_pago
      FROM comprobantes c
      LEFT JOIN orders_validated o ON c.order_number = o.order_number
      ORDER BY c.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

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
        o.customer_name,
        o.customer_email,
        o.customer_phone,
        o.monto_tiendanube as orden_total,
        o.total_pagado as orden_pagado,
        o.saldo as orden_saldo,
        o.estado_pago as orden_estado_pago
      FROM comprobantes c
      LEFT JOIN orders_validated o ON c.order_number = o.order_number
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

  try {
    // 1️⃣ Buscar comprobante
    const compRes = await pool.query(
      `SELECT id, order_number, monto, estado FROM comprobantes WHERE id = $1`,
      [id]
    );

    if (compRes.rowCount === 0) {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    const comprobante = compRes.rows[0];

    if (comprobante.estado !== 'pendiente' && comprobante.estado !== 'a_confirmar') {
      return res.status(400).json({ error: 'Este comprobante ya fue procesado' });
    }

    // 2️⃣ Confirmar comprobante
    await pool.query(`UPDATE comprobantes SET estado = 'confirmado' WHERE id = $1`, [id]);

    // 3️⃣ Recalcular total pagado (comprobantes + efectivo)
    const totalPagado = await calcularTotalPagado(comprobante.order_number);

    // 4️⃣ Obtener monto del pedido
    const orderRes = await pool.query(
      `SELECT monto_tiendanube FROM orders_validated WHERE order_number = $1`,
      [comprobante.order_number]
    );

    const montoPedido = Number(orderRes.rows[0].monto_tiendanube);
    const saldo = montoPedido - totalPagado;

    // 5️⃣ Definir estado_pago
    let estadoPago = 'pendiente';
    if (saldo <= 0) {
      estadoPago = 'confirmado_total';
    } else if (totalPagado > 0) {
      estadoPago = 'confirmado_parcial';
    }

    // 6️⃣ Actualizar orden (y estado_pedido si el pago está completo)
    const nuevoEstadoPedido = (estadoPago === 'confirmado_total') ? 'a_imprimir' : null;

    if (nuevoEstadoPedido) {
      // Actualizar estado_pedido solo si está en pendiente_pago
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
         WHERE order_number = $5 AND estado_pedido = 'pendiente_pago'`,
        [totalPagado, saldo, estadoPago, nuevoEstadoPedido, comprobante.order_number]
      );
      // Si no estaba en pendiente_pago, solo actualizar montos
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3
         WHERE order_number = $4 AND estado_pedido != 'pendiente_pago'`,
        [totalPagado, saldo, estadoPago, comprobante.order_number]
      );
    } else {
      await pool.query(
        `UPDATE orders_validated SET total_pagado = $1, saldo = $2, estado_pago = $3 WHERE order_number = $4`,
        [totalPagado, saldo, estadoPago, comprobante.order_number]
      );
    }

    // 7️⃣ Log
    await logEvento({ comprobanteId: id, accion: 'confirmado', origen: 'operador' });

    console.log(`✅ Comprobante ${id} confirmado`);
    if (nuevoEstadoPedido) console.log(`📦 Estado pedido actualizado a: ${nuevoEstadoPedido}`);

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
    console.error('❌ /comprobantes/:id/confirmar error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — RECHAZAR COMPROBANTE (API JSON)
===================================================== */
app.post('/comprobantes/:id/rechazar', authenticate, requirePermission('receipts.reject'), async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body;

  try {
    const compRes = await pool.query(
      `SELECT id, order_number, estado FROM comprobantes WHERE id = $1`,
      [id]
    );

    if (compRes.rowCount === 0) {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    const comprobante = compRes.rows[0];

    if (comprobante.estado !== 'pendiente' && comprobante.estado !== 'a_confirmar') {
      return res.status(400).json({ error: 'Este comprobante ya fue procesado' });
    }

    // Rechazar comprobante
    await pool.query(`UPDATE comprobantes SET estado = 'rechazado' WHERE id = $1`, [id]);

    // Log
    await logEvento({
      comprobanteId: id,
      accion: motivo ? `rechazado: ${motivo}` : 'rechazado',
      origen: 'operador'
    });

    console.log(`❌ Comprobante ${id} rechazado`);

    res.json({
      ok: true,
      comprobante_id: id,
      order_number: comprobante.order_number
    });

  } catch (error) {
    console.error('❌ /comprobantes/:id/rechazar error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   GET — DATOS PARA IMPRIMIR PEDIDO (DESDE TIENDANUBE)
===================================================== */
app.get('/orders/:orderNumber/print', authenticate, requirePermission('orders.print'), async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const storeId = process.env.TIENDANUBE_STORE_ID;

    console.log(`🖨️ Obteniendo datos de impresión para pedido #${orderNumber}`);

    // 1️⃣ Buscar el pedido en Tiendanube por número
    const tnResponse = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/orders`,
      {
        headers: {
          authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
          'User-Agent': 'bpm-validator'
        },
        params: { q: orderNumber }
      }
    );

    if (!tnResponse.data || tnResponse.data.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado en Tiendanube' });
    }

    const pedido = tnResponse.data[0];

    // 2️⃣ Obtener datos de nuestra DB
    const dbOrder = await pool.query(
      `SELECT estado_pago, estado_pedido, total_pagado, saldo FROM orders_validated WHERE order_number = $1`,
      [orderNumber]
    );

    // 3️⃣ Ordenar productos alfabéticamente por nombre
    const productos = (pedido.products || [])
      .map(p => ({
        id: p.id,
        name: p.name,
        variant: p.variant_values ? p.variant_values.join(' / ') : null,
        quantity: p.quantity,
        price: Number(p.price),
        total: Number(p.price) * p.quantity,
        sku: p.sku || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));

    // 4️⃣ Estructurar respuesta
    const printData = {
      // Info del pedido
      order_number: pedido.number,
      created_at: pedido.created_at,
      payment_status: pedido.payment_status,
      shipping_status: pedido.shipping_status,

      // Cliente
      customer: {
        name: pedido.customer?.name || pedido.contact_name || 'Sin nombre',
        email: pedido.customer?.email || pedido.contact_email || null,
        phone: pedido.contact_phone || pedido.customer?.phone || null,
        identification: pedido.customer?.identification || null,
      },

      // Dirección de envío
      shipping_address: pedido.shipping_address ? {
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
      } : null,

      // Envío
      shipping: {
        type: pedido.shipping_option?.name || pedido.shipping || 'No especificado',
        cost: Number(pedido.shipping_cost_customer) || 0,
        tracking_number: pedido.shipping_tracking_number || null,
      },

      // Productos (ordenados alfabéticamente)
      products: productos,

      // Totales
      totals: {
        subtotal: Number(pedido.subtotal),
        discount: Number(pedido.discount) || 0,
        shipping: Number(pedido.shipping_cost_customer) || 0,
        total: Number(pedido.total),
      },

      // Notas
      note: pedido.note || null,
      owner_note: pedido.owner_note || null,

      // Estado interno (de nuestra DB)
      internal: dbOrder.rows[0] || null,
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
        shipped_at
      FROM orders_validated
      WHERE order_number = $1
    `, [orderNumber]);

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
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
    const logsRes = await pool.query(`
      SELECT id, accion, origen, created_at FROM (
        -- Logs vinculados a comprobantes del pedido
        SELECT
          l.id,
          l.accion,
          l.origen,
          l.created_at
        FROM logs l
        JOIN comprobantes c ON l.comprobante_id = c.id
        WHERE c.order_number = $1

        UNION ALL

        -- Logs directos del pedido (ej: webhook tiendanube)
        SELECT
          l.id,
          l.accion,
          l.origen,
          l.created_at
        FROM logs l
        WHERE l.order_number = $1
      ) combined
      ORDER BY created_at DESC
    `, [orderNumber]);

    // Obtener productos de Tiendanube
    let productos = [];
    try {
      const storeId = process.env.TIENDANUBE_STORE_ID;
      const tnResponse = await axios.get(
        `https://api.tiendanube.com/v1/${storeId}/orders`,
        {
          headers: {
            authentication: `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
            'User-Agent': 'bpm-validator'
          },
          params: { q: orderNumber }
        }
      );

      if (tnResponse.data && tnResponse.data.length > 0) {
        const pedido = tnResponse.data[0];
        productos = (pedido.products || [])
          .map(p => ({
            id: p.id,
            name: p.name,
            variant: p.variant_values ? p.variant_values.join(' / ') : null,
            quantity: p.quantity,
            price: Number(p.price),
            total: Number(p.price) * p.quantity,
            sku: p.sku || null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'es'));
      }
    } catch (tnError) {
      console.warn('⚠️ No se pudieron obtener productos de Tiendanube:', tnError.message);
    }

    res.json({
      ok: true,
      order: orderRes.rows[0],
      comprobantes: comprobantesRes.rows,
      pagos_efectivo: pagosEfectivoRes.rows,
      logs: logsRes.rows,
      productos: productos
    });

  } catch (error) {
    console.error('❌ /orders/:orderNumber error:', error.message);
    res.status(500).json({ error: error.message });
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
    const estadosValidos = ['pendiente_pago', 'a_imprimir', 'armado', 'retirado', 'enviado', 'en_calle'];
    if (!estado_pedido || !estadosValidos.includes(estado_pedido)) {
      return res.status(400).json({
        error: `Estado inválido. Valores permitidos: ${estadosValidos.join(', ')}`
      });
    }

    // Verificar que existe el pedido
    const orderRes = await pool.query(
      `SELECT order_number, estado_pago, estado_pedido FROM orders_validated WHERE order_number = $1`,
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

    if (estado_pedido === 'a_imprimir' && !pedido.printed_at) {
      // Cuando pasa a imprimir, marcamos printed_at
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
    console.log(`📦 Estado de pedido ${orderNumber} actualizado a: ${estado_pedido}`);

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
  if (!received) return false;

  const secret = process.env.TIENDANUBE_CLIENT_SECRET;

  const computed = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(received),
    Buffer.from(computed)
  );
}


app.post('/webhook/tiendanube', async (req, res) => {
  // 1️⃣ Validación de firma (dejamos lo que ya funcionaba)
  if (!verifyTiendaNubeSignature(req)) {
    console.error('❌ Firma de Tiendanube inválida');
    return res.status(401).send('Invalid signature');
  }

  console.log('📥 WEBHOOK TIENDANUBE OK');
  console.log('Body:', req.body);

  // 2️⃣ Respuesta inmediata
  res.status(200).json({ ok: true });

  try {
    const { event, store_id, id: orderId } = req.body;

    // Solo procesar order/created - todos los demás eventos se ignoran
    // Los pagos se gestionan desde Petlove, no desde Tiendanube
    if (event !== 'order/created') return;

    // 3️⃣ Buscar pedido REAL (como antes)
    const pedido = await obtenerPedidoPorId(store_id, orderId);

    if (!pedido) {
      console.log('❌ Pedido no encontrado');
      return;
    }

    // 4️⃣ Guardar pedido en orders_validated (UNA sola vez) con datos del cliente
    const customerName = pedido.customer?.name || pedido.contact_name || null;
    const customerEmail = pedido.customer?.email || pedido.contact_email || null;
    const customerPhone = pedido.contact_phone || pedido.customer?.phone ||
                          pedido.shipping_address?.phone || pedido.customer?.default_address?.phone || null;

    await pool.query(
      `
      INSERT INTO orders_validated (order_number, monto_tiendanube, currency, customer_name, customer_email, customer_phone, estado_pedido)
      VALUES ($1, $2, $3, $4, $5, $6, 'pendiente_pago')
      ON CONFLICT (order_number) DO UPDATE SET
        customer_name = COALESCE(orders_validated.customer_name, EXCLUDED.customer_name),
        customer_email = COALESCE(orders_validated.customer_email, EXCLUDED.customer_email),
        customer_phone = COALESCE(orders_validated.customer_phone, EXCLUDED.customer_phone)
      `,
      [
        pedido.number,
        Math.round(Number(pedido.total)),
        pedido.currency || 'ARS',
        customerName,
        customerEmail,
        customerPhone
      ]
    );

    console.log(`✅ Pedido #${pedido.number} guardado en DB (order/created)`);

    // 5️⃣ Teléfono
    const telefono =
      pedido.contact_phone ||
      pedido.customer?.phone ||
      pedido.shipping_address?.phone ||
      pedido.customer?.default_address?.phone;

    if (!telefono) {
      console.log(`⚠️ Pedido ${pedido.number} sin teléfono`);
      return;
    }

    // 🔒 filtro de testing (opcional)

    if (telefono !== '+5491123945965') {
      console.log('📵 Teléfono ignorado:', telefono);
      return;
    }
    console.log('📤 Enviando WhatsApp a:', telefono);

    const contactIdClean = telefono.replace('+', '');

    // 6️⃣ Botmaker (igual que antes)
    await axios.post(
      'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
      {
        chat: {
          channelId: process.env.BOTMAKER_CHANNEL_ID,
          contactId: contactIdClean
        },
        intentIdOrName: 'order_created',
        variables: {
          '1': pedido.customer?.name || 'Cliente',
          '2': String(pedido.number),
          '3': `$${pedido.total}`
        }
      },
      {
        headers: {
          'access-token': process.env.BOTMAKER_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ WhatsApp enviado (Pedido #${pedido.number})`);

  } catch (err) {
    console.error('❌ Error webhook:', err.message);
    console.error('   Stack:', err.stack?.split('\n')[1]);
  }
});




/* =====================================================
   PASO 1 — VALIDAR PEDIDO
===================================================== */

app.post('/validate-order', async (req, res) => {
  try {
    const { orderNumber } = req.body;

    if (!orderNumber) {
      return res.status(400).json({ error: 'Falta orderNumber' });
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
          q: orderNumber
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
      [orderNumber, montoTiendanube, currency, customerName, customerEmail, customerPhone]
    );

    /* ===============================
       3️⃣ RESPUESTA
    ================================ */
    res.json({
      ok: true,
      orderNumber,
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
app.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('❌ Multer error:', err.message);
      return res.status(400).json({ error: 'Error al subir archivo: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { orderNumber } = req.body;
    const file = req.file;

    console.log('📥 /upload iniciado');
    console.log('orderNumber:', orderNumber);
    console.log('file:', file?.originalname);

    if (!orderNumber || !file) {
      return res.status(400).json({ error: 'Faltan datos' });
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
       2️⃣ OCR (antes de cualquier modificación)
    ================================ */
    const imageBuffer = fs.readFileSync(file.path);
    const [result] = await visionClient.textDetection({
      image: { content: imageBuffer }
    });

    const textoOcr = result.fullTextAnnotation?.text || '';
    if (!textoOcr) throw new Error('OCR vacío');

    validarComprobante(textoOcr);
    console.log('🧠 OCR OK');

    /* ===============================
       3️⃣ HASH (DUPLICADOS)
    ================================ */
    const hash = hashText(textoOcr);

    const dup = await pool.query(
      'select id from comprobantes where hash_ocr = $1',
      [hash]
    );

    if (dup.rows.length > 0) {
      fs.unlinkSync(file.path);
      return res.status(409).json({ error: 'Comprobante duplicado' });
    }

    /* ===============================
       4️⃣ MONTO DESDE OCR
    ================================ */
    const { monto } = detectarMontoDesdeOCR(textoOcr);
    const montoDetectado = Math.round(monto);

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
    const insert = await pool.query(
      `insert into comprobantes
       (order_number, hash_ocr, texto_ocr, monto, monto_tiendanube, file_url, estado)
       values ($1,$2,$3,$4,$5,$6,'a_confirmar')
       returning id`,
      [
        orderNumber,
        hash,
        textoOcr,
        montoDetectado,
        montoTiendanube,
        fileUrl
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
    const finalBuffer = fs.readFileSync(file.path);

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
    const cuentaActual = Math.round(montoTiendanube - totalPagado);

    let estadoCuenta = 'pendiente';
    const TOLERANCIA = 1000;

    if (Math.abs(cuentaActual) <= TOLERANCIA) {
      estadoCuenta = 'ok';
    } else if (cuentaActual > 0) {
      estadoCuenta = 'debe';
    } else {
      estadoCuenta = 'a_favor';
    }

    /* ===============================
       1️⃣1️⃣ WHATSAPP AL CLIENTE
    ================================ */
    console.log('CEL: ',telefono, 'ESTADO CUENTA:', estadoCuenta)
    if (telefono) {
      let plantilla = null;
      let variables = null;

      if (estadoCuenta === 'ok' || estadoCuenta === 'a_favor') {
        plantilla = 'todo_pago';
        variables = { '1': nombre, '2': montoDetectado };
      } else if (estadoCuenta === 'debe') {
        plantilla = 'partial_paid';
        variables = {
          '1': nombre,
          '2': montoDetectado,
          '3': cuentaActual
        };
      }
      console.log('plantilla final: ',plantilla, 'variables:', variables)
      if (plantilla) {
        enviarWhatsAppPlantilla({
          telefono,
          plantilla,
          variables
        }).catch(err =>
          console.error('⚠️ Error WhatsApp cliente:', err.message)
        );
        await logEvento({
          comprobanteId,
          accion: 'whatsapp_cliente_enviado',
          origen: 'sistem'
        })
      }
    }

    /* ===============================
       1️⃣2️⃣ DETECTAR FINANCIERA + ENVÍO
    ================================ */
    if (telefono === '+5491123945965') {
      const financiera = await detectarFinancieraDesdeOCR(textoOcr);

      if (financiera) {
        console.log('🏦 Financiera detectada:', financiera.nombre);

        enviarComprobanteAFinanciera({
          financiera,
          fileUrl,
          comprobanteId
        }).catch(err =>
          console.error('⚠️ Error enviando a financiera:', err.message)
        );
      } else {
        console.log('ℹ️ No se detectó financiera');
      }
    }

    /* ===============================
       1️⃣3️⃣ UPDATE CUENTA
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
                ? `
                  <a class="btn confirmar" href="/confirmar/${comprobante.id}">
                    ✅ Confirmar
                  </a>

                  <a class="btn rechazar" href="/rechazar/${comprobante.id}">
                    ❌ Rechazar
                  </a>
                `
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

  try {
    // 1️⃣ Buscar comprobante
    const compRes = await pool.query(
      `SELECT id, order_number, monto, estado
       FROM comprobantes
       WHERE id = $1`,
      [id]
    );

    if (compRes.rowCount === 0) {
      return res.status(404).send('Comprobante no encontrado');
    }

    const comprobante = compRes.rows[0];

    if (comprobante.estado !== 'pendiente' && comprobante.estado !== 'a_confirmar') {
      return res.send('Este comprobante ya fue procesado.');
    }

    // 2️⃣ Confirmar comprobante
    await pool.query(
      `UPDATE comprobantes
       SET estado = 'confirmado'
       WHERE id = $1`,
      [id]
    );

    // 3️⃣ Recalcular total pagado (comprobantes + efectivo)
    const totalPagado = await calcularTotalPagado(comprobante.order_number);

    // 4️⃣ Obtener monto real del pedido
    const orderRes = await pool.query(
      `
      SELECT monto_tiendanube
      FROM orders_validated
      WHERE order_number = $1
      `,
      [comprobante.order_number]
    );

    const montoPedido = Number(orderRes.rows[0].monto_tiendanube);
    const saldo = montoPedido - totalPagado;

    // 5️⃣ Definir estado_pago correcto
    let estadoPago = 'pendiente';

    if (saldo <= 0) {
      estadoPago = 'confirmado_total';
    } else if (totalPagado > 0) {
      estadoPago = 'confirmado_parcial';
    }

    // 6️⃣ Actualizar orden (y estado_pedido si el pago está completo)
    const nuevoEstadoPedido = (estadoPago === 'confirmado_total') ? 'a_imprimir' : null;

    if (nuevoEstadoPedido) {
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
         WHERE order_number = $5 AND estado_pedido = 'pendiente_pago'`,
        [totalPagado, saldo, estadoPago, nuevoEstadoPedido, comprobante.order_number]
      );
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3
         WHERE order_number = $4 AND estado_pedido != 'pendiente_pago'`,
        [totalPagado, saldo, estadoPago, comprobante.order_number]
      );
    } else {
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3
         WHERE order_number = $4`,
        [totalPagado, saldo, estadoPago, comprobante.order_number]
      );
    }

    return res.send(`
      <h2>✅ Comprobante confirmado</h2>
      <p>Pedido: ${comprobante.order_number}</p>
      <p>Total pagado: $${totalPagado}</p>
      <p>Estado pago: ${estadoPago}</p>
      ${nuevoEstadoPedido ? `<p>Estado pedido: ${nuevoEstadoPedido}</p>` : ''}
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send('Error al confirmar comprobante');
  }
});



app.get('/rechazar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const compRes = await pool.query(
      `SELECT id, order_number, estado
       FROM comprobantes
       WHERE id = $1`,
      [id]
    );

    if (compRes.rowCount === 0) {
      return res.status(404).send('Comprobante no encontrado');
    }

    if (compRes.rows[0].estado !== 'pendiente' && compRes.rows[0].estado !== 'a_confirmar') {
      return res.send('Este comprobante ya fue procesado.');
    }

    // Rechazar comprobante
    await pool.query(
      `UPDATE comprobantes
       SET estado = 'rechazado'
       WHERE id = $1`,
      [id]
    );

    // El estado de la orden pasa a rechazado
    await pool.query(
      `
      UPDATE orders_validated
      SET estado_pago = 'rechazado'
      WHERE order_number = $1
      `,
      [compRes.rows[0].order_number]
    );

    return res.send(`
      <h2>❌ Comprobante rechazado</h2>
      <p>ID: ${id}</p>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send('Error al rechazar comprobante');
  }
});


/* =====================================================
   UTIL — CALCULAR TOTAL PAGADO (comprobantes + efectivo)
===================================================== */
async function calcularTotalPagado(orderNumber) {
  // Sumar comprobantes confirmados
  const compRes = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total
     FROM comprobantes
     WHERE order_number = $1 AND estado = 'confirmado'`,
    [orderNumber]
  );

  // Sumar pagos en efectivo
  const efectivoRes = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total
     FROM pagos_efectivo
     WHERE order_number = $1`,
    [orderNumber]
  );

  return Number(compRes.rows[0].total) + Number(efectivoRes.rows[0].total);
}


/* =====================================================
   PAGO EN EFECTIVO
===================================================== */
app.post('/pago-efectivo', authenticate, requirePermission('orders.create_cash_payment'), async (req, res) => {
  try {
    const { orderNumber, monto, registradoPor, notas } = req.body;

    // Validaciones
    if (!orderNumber || !monto) {
      return res.status(400).json({ error: 'Faltan datos: orderNumber y monto son requeridos' });
    }

    const montoNumerico = Math.round(Number(monto));
    if (isNaN(montoNumerico) || montoNumerico <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    console.log('💵 Registrando pago en efectivo');
    console.log('Pedido:', orderNumber);
    console.log('Monto:', montoNumerico);
    console.log('Registrado por:', registradoPor || 'sistema');

    /* ===============================
       1️⃣ VERIFICAR QUE EXISTE EL PEDIDO
    ================================ */
    const orderRes = await pool.query(
      `SELECT order_number, monto_tiendanube
       FROM orders_validated
       WHERE order_number = $1`,
      [orderNumber]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const montoTiendanube = Number(orderRes.rows[0].monto_tiendanube);

    /* ===============================
       2️⃣ INSERTAR EN PAGOS_EFECTIVO
    ================================ */
    const insert = await pool.query(
      `INSERT INTO pagos_efectivo (order_number, monto, registrado_por, notas)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [orderNumber, montoNumerico, registradoPor || 'sistema', notas || null]
    );

    const pagoId = insert.rows[0].id;
    console.log('🧾 Pago en efectivo registrado ID:', pagoId);

    /* ===============================
       3️⃣ RECALCULAR TOTAL PAGADO (comprobantes + efectivo)
    ================================ */
    const totalPagado = await calcularTotalPagado(orderNumber);
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
       5️⃣ ACTUALIZAR ORDEN
    ================================ */
    // Si el pago está completo, cambiar estado_pedido a 'a_imprimir'
    const nuevoEstadoPedido = (estadoPago === 'confirmado_total' || estadoPago === 'a_favor') ? 'a_imprimir' : null;

    if (nuevoEstadoPedido) {
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
         WHERE order_number = $5 AND estado_pedido = 'pendiente_pago'`,
        [totalPagado, saldo, estadoPago, nuevoEstadoPedido, orderNumber]
      );
      // Si no estaba en pendiente_pago, solo actualizar los montos
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3
         WHERE order_number = $4 AND estado_pedido != 'pendiente_pago'`,
        [totalPagado, saldo, estadoPago, orderNumber]
      );
    } else {
      await pool.query(
        `UPDATE orders_validated
         SET total_pagado = $1, saldo = $2, estado_pago = $3
         WHERE order_number = $4`,
        [totalPagado, saldo, estadoPago, orderNumber]
      );
    }

    console.log('✅ Pago en efectivo procesado');
    console.log('Total pagado:', totalPagado);
    console.log('Saldo:', saldo);
    console.log('Estado pago:', estadoPago);
    if (nuevoEstadoPedido) console.log('Estado pedido:', nuevoEstadoPedido);

    /* ===============================
       6️⃣ RESPUESTA
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
    console.error('❌ /pago-efectivo error:', error.message);
    res.status(500).json({ error: error.message });
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

app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/roles', rolesRoutes);

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

// Ejecutar sincronización manual
app.post('/sync/run', authenticate, requirePermission('users.view'), async (req, res) => {
  try {
    console.log('🔄 Sincronización manual iniciada por:', req.user.email);
    const result = await runSyncJob();
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Scheduler: ejecutar sync cada 5 minutos
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutos
let syncInterval = null;

function startSyncScheduler() {
  if (syncInterval) return;

  console.log('⏰ Scheduler de sincronización iniciado (cada 5 min)');

  // Primera ejecución después de 30 segundos (dar tiempo a que arranque todo)
  setTimeout(async () => {
    try {
      await runSyncJob();
    } catch (err) {
      console.error('❌ Error en sync inicial:', err.message);
    }
  }, 30000);

  // Luego cada 5 minutos
  syncInterval = setInterval(async () => {
    try {
      await runSyncJob();
    } catch (err) {
      console.error('❌ Error en sync programado:', err.message);
    }
  }, SYNC_INTERVAL);
}

/* =====================================================
   SERVER
===================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Iniciar scheduler de sincronización
  startSyncScheduler();
});
