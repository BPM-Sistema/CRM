
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
const { ocrFromUrl } = require('./services/ocrFromUrl');
const { hashText } = require('./hash');
const { authenticate, requirePermission } = require('./middleware/auth');
const { uploadLimiter, validationLimiter, shippingFormLimiter } = require('./middleware/rateLimit');
const crypto = require('crypto');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const { runSyncJob } = require('./services/orderSync');
const { getQueueStats, getSyncState } = require('./services/syncQueue');
const { verificarConsistencia, getInconsistencias } = require('./utils/orderVerification');
const { getNotificaciones, contarNoLeidas, marcarLeida, marcarTodasLeidas, crearNotificacion } = require('./utils/notifications');
const app = express();
const PORT = process.env.PORT || 3000;

// Desactivar ETag globalmente para evitar respuestas 304
app.set('etag', false);

// Configurar Google Cloud Vision credentials para producción (Cloud Run)
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

app.use(express.static(path.join(__dirname, 'public')));

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
   UTIL — GUARDAR PRODUCTOS DE UN PEDIDO EN DB
   - UPSERT productos que existen en TiendaNube
   - DELETE productos que ya no existen en TiendaNube
===================================================== */
async function guardarProductos(orderNumber, products) {
  if (!products || products.length === 0) {
    console.log(`⚠️ Pedido #${orderNumber} sin productos para guardar`);
    return;
  }

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
    } catch (err) {
      console.error(`❌ Error INSERT producto en #${orderNumber}:`, err.message);
      console.error('   Producto:', JSON.stringify(p));
    }
  }

  // 5. Auto-resolver inconsistencias pendientes para este pedido
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
  await guardarProductos(orderNumber, pedido.products);

  return orderNumber;
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

/* =====================================================
   UTIL — NORMALIZAR TEXTO (quitar tildes, lowercase, trim)
===================================================== */
function normalizeText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/\s+/g, ' ')            // colapsar espacios
    .trim();
}

/* =====================================================
   UTIL — REQUIERE FORMULARIO DE ENVÍO
   Detecta si un pedido requiere completar el formulario /envio
   Casos: "Expreso a elección" o "Via Cargo"
===================================================== */
function requiresShippingForm(shippingType) {
  if (!shippingType) return false;
  const lower = shippingType.toLowerCase();
  return (
    (lower.includes('expreso') && lower.includes('elec')) ||
    lower.includes('via cargo') ||
    lower.includes('viacargo')
  );
}

/* =====================================================
   UTIL — EXTRAER CUENTA DESTINO DEL OCR (ROBUSTO)
===================================================== */
function extractDestinationAccount(textoOcr) {
  const texto = textoOcr.replace(/\r/g, '\n');
  const lines = texto.split('\n').map(l => l.trim()).filter(Boolean);

  let alias = null;
  let cbu = null;
  let cvu = null;
  let titular = null;
  const nombres = []; // Guardar todos los posibles nombres encontrados

  // DEBUG: Buscar secuencias numéricas largas en el OCR
  const digitSequences = texto.match(/\d[\d\s\-\.]{15,30}\d/g) || [];
  console.log('🔢 Secuencias numéricas encontradas:', digitSequences.map(s => {
    const clean = s.replace(/\D/g, '');
    return `"${s}" → ${clean} (${clean.length} dígitos)`;
  }));

  // Keywords que indican sección destino (case insensitive, sin depender de ":")
  const destinoKeywords = [
    'destinatario', 'destino', 'beneficiario', 'receptor', 'titular',
    'para', 'cuenta destino', 'transferiste a', 'enviaste a', 'le enviaste'
  ];

  // Keywords que indican FIN de sección destino (NO incluir cuit porque viene después del nombre)
  const finSeccionKeywords = [
    'origen', 'desde', 'remitente', 'ordenante', 'monto', 'importe',
    'fecha', 'concepto', 'motivo', 'banco'
  ];

  // 1) BUSCAR POR SECCIONES
  let enSeccionDestino = false;
  let lineasDesdeDestino = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    // Detectar INICIO de sección destino
    const isDestinoLine = destinoKeywords.some(k => lineLower.includes(k));
    // Detectar INICIO de sección origen (para ignorar sus datos)
    const isOrigenLine = finSeccionKeywords.some(k => lineLower.includes(k));

    if (isOrigenLine && enSeccionDestino) {
      console.log(`🚫 Fin sección destino en línea ${i}: "${line}"`);
      enSeccionDestino = false;
    }

    if (isDestinoLine) {
      console.log(`✅ Inicio sección destino en línea ${i}: "${line}"`);
      enSeccionDestino = true;
      lineasDesdeDestino = 0;

      // Buscar valor en misma línea después de ":"
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const valor = line.substring(colonIndex + 1).trim();
        if (valor.length > 3 && !titular) {
          console.log(`📝 Titular en misma línea: "${valor}"`);
          titular = valor;
        }
      }
      continue;
    }

    // Si estamos en sección destino, buscar datos (hasta 6 líneas)
    if (enSeccionDestino && lineasDesdeDestino < 6) {
      lineasDesdeDestino++;
      console.log(`  → Línea destino ${lineasDesdeDestino}: "${line}"`);

      // Si es un nombre (letras y espacios, 2+ palabras) - MÁS FLEXIBLE
      if (!titular) {
        // Aceptar mayúsculas, minúsculas, tildes, y que tenga al menos 2 palabras
        const esNombre = /^[A-Za-zÁÉÍÓÚÑáéíóúñ\s]{5,60}$/.test(line) &&
                         line.trim().split(/\s+/).length >= 2 &&
                         !lineLower.includes('cbu') &&
                         !lineLower.includes('cvu') &&
                         !lineLower.includes('alias');
        if (esNombre) {
          console.log(`📝 Titular detectado: "${line}"`);
          titular = line;
        }
      }

      // Si es alias (palabra.palabra.palabra)
      const aliasMatch = line.match(/([a-zA-Z0-9]+\.[a-zA-Z0-9]+\.[a-zA-Z0-9]+)/);
      if (aliasMatch && !alias) {
        console.log(`📝 Alias detectado: "${aliasMatch[1]}"`);
        alias = aliasMatch[1].toUpperCase();
      }

      // Si es CBU/CVU (22 dígitos) - SOLO en sección destino
      const cbuMatch = line.match(/(\d{22})/);
      if (cbuMatch && !cbu && !cvu) {
        console.log(`📝 CBU/CVU detectado en sección destino: "${cbuMatch[1]}"`);
        if (cbuMatch[1].startsWith('000')) cvu = cbuMatch[1];
        else cbu = cbuMatch[1];
      }

      // CBU/CVU con espacios o separadores
      const cbuSeparado = line.replace(/[\s\-\.]/g, '');
      if (cbuSeparado.length === 22 && /^\d+$/.test(cbuSeparado) && !cbu && !cvu) {
        console.log(`📝 CBU/CVU (separado) detectado: "${cbuSeparado}"`);
        if (cbuSeparado.startsWith('000')) cvu = cbuSeparado;
        else cbu = cbuSeparado;
      }
    }
  }

  // 2) FALLBACK GLOBAL - buscar en todo el texto (SOLO si no encontramos en sección destino)
  const textoCompleto = texto;

  // Alias en cualquier parte (si no lo encontramos en sección destino)
  if (!alias) {
    const aliasMatches = textoCompleto.match(/[a-zA-Z0-9]+\.[a-zA-Z0-9]+\.[a-zA-Z0-9]+/g);
    if (aliasMatches) {
      console.log(`🔍 Alias por fallback global: "${aliasMatches[0]}"`);
      alias = aliasMatches[0].toUpperCase();
    }
  }

  // CBU/CVU - NO buscar en fallback global porque podría tomar el ORIGEN
  // Solo loguear las secuencias encontradas para debug
  if (!cbu && !cvu) {
    console.log('⚠️ No se encontró CBU/CVU en sección destino (no se busca en texto completo para evitar tomar el origen)');
  }

  // Nombres en mayúsculas (posibles titulares)
  if (!titular) {
    for (const line of lines) {
      // Nombre: 2+ palabras en mayúsculas, sin números, sin keywords
      if (/^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]{5,50}$/.test(line) && line.includes(' ')) {
        const lower = line.toLowerCase();
        const esKeyword = [...destinoKeywords, ...finSeccionKeywords, 'alias', 'cbu', 'cvu', 'banco', 'santander', 'nacion', 'galicia'].some(k => lower.includes(k));
        if (!esKeyword) {
          nombres.push(line);
        }
      }
    }
    // Tomar el primer nombre encontrado
    if (nombres.length > 0) {
      titular = nombres[0];
    }
  }

  return { alias, cbu, cvu, titular, nombres };
}

/* =====================================================
   UTIL — VALIDAR CUENTA DESTINO CONTRA DB
===================================================== */
async function isValidDestination(account, textoOcr) {
  const { alias, cbu, cvu, titular, nombres = [] } = account;

  // Obtener TODAS las financieras activas de la DB
  const result = await pool.query(`
    SELECT id, nombre, alias, cbu, titular_principal, palabras_clave
    FROM financieras
    WHERE activa = true
  `);

  if (result.rows.length === 0) {
    // No hay financieras configuradas, permitir todo
    return { valid: true, reason: 'no_financieras_configured' };
  }

  const textoNormalizado = normalizeText(textoOcr);

  for (const fin of result.rows) {
    // 1) Match por ALIAS (exacto)
    if (alias && fin.alias) {
      if (normalizeText(alias) === normalizeText(fin.alias)) {
        return { valid: true, cuenta: fin, matchedBy: 'alias' };
      }
    }

    // 2) Match por CBU
    if (cbu && fin.cbu) {
      if (cbu === fin.cbu) {
        return { valid: true, cuenta: fin, matchedBy: 'cbu' };
      }
    }

    // 3) Match por CVU (si existe en DB)
    if (cvu && fin.cvu) {
      if (cvu === fin.cvu) {
        return { valid: true, cuenta: fin, matchedBy: 'cvu' };
      }
    }

    // 4) Match por TITULAR (flexible - todas las palabras presentes)
    if (fin.titular_principal) {
      const titularDbNorm = normalizeText(fin.titular_principal);
      const palabrasDb = titularDbNorm.split(' ').filter(p => p.length > 2);

      // Verificar contra titular extraído
      if (titular) {
        const titularOcrNorm = normalizeText(titular);
        const todasPresentes = palabrasDb.every(p => titularOcrNorm.includes(p));
        if (todasPresentes) {
          return { valid: true, cuenta: fin, matchedBy: 'titular' };
        }
      }

      // Verificar contra todos los posibles nombres encontrados
      for (const nombre of nombres) {
        const nombreNorm = normalizeText(nombre);
        const todasPresentes = palabrasDb.every(p => nombreNorm.includes(p));
        if (todasPresentes) {
          return { valid: true, cuenta: fin, matchedBy: 'titular_alternativo' };
        }
      }

      // Verificar si el titular de la DB aparece en el texto completo del OCR
      const todasEnTexto = palabrasDb.every(p => textoNormalizado.includes(p));
      if (todasEnTexto) {
        return { valid: true, cuenta: fin, matchedBy: 'titular_en_texto' };
      }
    }

    // 5) Match por PALABRAS CLAVE
    if (fin.palabras_clave && Array.isArray(fin.palabras_clave)) {
      for (const keyword of fin.palabras_clave) {
        if (textoNormalizado.includes(normalizeText(keyword))) {
          return { valid: true, cuenta: fin, matchedBy: 'palabra_clave' };
        }
      }
    }

    // 6) Match por ALIAS en texto completo (por si OCR no lo parseó bien)
    if (fin.alias) {
      const aliasNorm = normalizeText(fin.alias);
      if (textoNormalizado.includes(aliasNorm)) {
        return { valid: true, cuenta: fin, matchedBy: 'alias_en_texto' };
      }
    }
  }

  return { valid: false, reason: 'destination_not_registered', extracted: account };
}

/* =====================================================
   UTIL — DETECTAR FINANCIERA DESDE TEXTO OCR (para backfill)
   Retorna financiera_id si hay match único, null si hay dudas
===================================================== */
async function detectarFinancieraDesdeOCR(textoOcr) {
  if (!textoOcr) return null;

  const result = await pool.query(`
    SELECT id, nombre, palabras_clave
    FROM financieras
    WHERE activa = true AND palabras_clave IS NOT NULL
  `);

  if (result.rows.length === 0) return null;

  const textoNormalizado = normalizeText(textoOcr);
  const matches = [];

  for (const fin of result.rows) {
    if (!fin.palabras_clave || !Array.isArray(fin.palabras_clave)) continue;

    for (const keyword of fin.palabras_clave) {
      if (textoNormalizado.includes(normalizeText(keyword))) {
        matches.push({ id: fin.id, nombre: fin.nombre, keyword });
        break; // Solo contar una vez por financiera
      }
    }
  }

  // Match único → asignar
  if (matches.length === 1) {
    return { financieraId: matches[0].id, nombre: matches[0].nombre, keyword: matches[0].keyword };
  }

  // Múltiples matches o ninguno → no asignar
  if (matches.length > 1) {
    console.log(`⚠️ Múltiples matches de financiera: ${matches.map(m => m.nombre).join(', ')}`);
  }

  return null;
}

async function enviarWhatsAppPlantilla({ telefono, plantilla, variables }) {
  // 🔒 Filtro de testing - solo enviar a número de prueba
  const TESTING_PHONE = '+5491123945965';
  if (telefono !== TESTING_PHONE) {
    console.log('📵 WhatsApp ignorado (testing):', telefono);
    return { data: { skipped: true, reason: 'testing_filter' } };
  }

  // Obtener financiera default para determinar sufijo de plantilla
  let plantillaFinal = plantilla;
  try {
    const finResult = await pool.query(`
      SELECT nombre
      FROM financieras
      WHERE is_default = true
      LIMIT 1
    `);

    if (finResult.rows.length > 0) {
      const nombreFinanciera = finResult.rows[0].nombre.toLowerCase();
      if (nombreFinanciera.includes('wanda')) {
        plantillaFinal = `${plantilla}_wanda`;
      } else if (nombreFinanciera.includes('kiesel')) {
        plantillaFinal = `${plantilla}_kiesel`;
      }
      console.log(`🏦 Financiera default: ${finResult.rows[0].nombre} → plantilla: ${plantillaFinal}`);
    }
  } catch (err) {
    console.error('⚠️ Error obteniendo financiera default:', err.message);
  }

  console.log('📤 Enviando WhatsApp a:', telefono, 'plantilla:', plantillaFinal);

  const contactIdClean = telefono.replace('+', '');

  return axios.post(
    'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
    {
      chat: {
        channelId: process.env.BOTMAKER_CHANNEL_ID,
        contactId: contactIdClean
      },
      intentIdOrName: plantillaFinal,
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
    const { estado_pago, estado_pedido, search, fecha, shipping_data } = req.query;

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
      conditions.push(`(
        o.order_number ILIKE $${paramIndex} OR
        o.customer_name ILIKE $${paramIndex} OR
        o.customer_email ILIKE $${paramIndex} OR
        o.customer_phone ILIKE $${paramIndex}
      )`);
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
// Cache para prevenir requests duplicados (key: comprobante_id, value: timestamp)
const confirmRequestCache = new Map();
const DUPLICATE_THRESHOLD_MS = 5000; // 5 segundos

app.post('/comprobantes/:id/confirmar', authenticate, requirePermission('receipts.confirm'), async (req, res) => {
  const { id } = req.params;
  const requestTime = Date.now();
  const requestId = `${id}-${req.user?.id}-${requestTime}`;

  console.log(`🔔 [${requestId}] Iniciando confirmación de comprobante ${id}`);

  // Verificar si hay un request reciente para el mismo comprobante
  const lastRequest = confirmRequestCache.get(id);
  if (lastRequest && (requestTime - lastRequest) < DUPLICATE_THRESHOLD_MS) {
    console.log(`⚠️ [${requestId}] Request duplicado detectado (${requestTime - lastRequest}ms desde último)`);
    return res.status(429).json({ error: 'Request duplicado, espere unos segundos' });
  }
  confirmRequestCache.set(id, requestTime);

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
      console.log(`⚠️ [${requestId}] Comprobante ya procesado (estado: ${comprobante.estado})`);
      return res.status(400).json({ error: 'Este comprobante ya fue procesado' });
    }

    // 2️⃣ Confirmar comprobante
    await pool.query(`UPDATE comprobantes SET estado = 'confirmado' WHERE id = $1`, [id]);

    // 3️⃣ Recalcular total pagado (comprobantes + efectivo)
    const totalPagado = await calcularTotalPagado(comprobante.order_number);

    // 4️⃣ Obtener monto y estado actual del pedido
    const orderRes = await pool.query(
      `SELECT monto_tiendanube, estado_pedido FROM orders_validated WHERE order_number = $1`,
      [comprobante.order_number]
    );

    const montoPedido = Number(orderRes.rows[0].monto_tiendanube);
    const estadoPedidoActual = orderRes.rows[0].estado_pedido;
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
    await pool.query(
      `UPDATE orders_validated
       SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
       WHERE order_number = $5`,
      [totalPagado, saldo, estadoPago, nuevoEstadoPedido, comprobante.order_number]
    );

    // 8️⃣ Log
    console.log(`📝 [${requestId}] Insertando log de confirmación`);
    await logEvento({
      comprobanteId: id,
      orderNumber: comprobante.order_number,
      accion: 'comprobante_confirmado',
      origen: 'operador',
      userId: req.user?.id,
      username: req.user?.name
    });

    console.log(`✅ [${requestId}] Comprobante ${id} confirmado exitosamente`);
    if (nuevoEstadoPedido !== estadoPedidoActual) {
      console.log(`📦 Estado pedido: ${estadoPedidoActual} → ${nuevoEstadoPedido}`);
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
    console.error(`❌ [${requestId}] /comprobantes/:id/confirmar error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});


/* =====================================================
   POST — RECHAZAR COMPROBANTE (API JSON)
===================================================== */
// Cache para prevenir requests duplicados
const rejectRequestCache = new Map();

app.post('/comprobantes/:id/rechazar', authenticate, requirePermission('receipts.reject'), async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body;
  const requestTime = Date.now();
  const requestId = `${id}-${req.user?.id}-${requestTime}`;

  console.log(`🔔 [${requestId}] Iniciando rechazo de comprobante ${id}`);

  // Verificar si hay un request reciente para el mismo comprobante
  const lastRequest = rejectRequestCache.get(id);
  if (lastRequest && (requestTime - lastRequest) < DUPLICATE_THRESHOLD_MS) {
    console.log(`⚠️ [${requestId}] Request duplicado detectado (${requestTime - lastRequest}ms desde último)`);
    return res.status(429).json({ error: 'Request duplicado, espere unos segundos' });
  }
  rejectRequestCache.set(id, requestTime);

  try {
    const compRes = await pool.query(
      `SELECT id, order_number, estado, monto FROM comprobantes WHERE id = $1`,
      [id]
    );

    if (compRes.rowCount === 0) {
      return res.status(404).json({ error: 'Comprobante no encontrado' });
    }

    const comprobante = compRes.rows[0];

    if (comprobante.estado !== 'pendiente' && comprobante.estado !== 'a_confirmar') {
      console.log(`⚠️ [${requestId}] Comprobante ya procesado (estado: ${comprobante.estado})`);
      return res.status(400).json({ error: 'Este comprobante ya fue procesado' });
    }

    // Rechazar comprobante
    await pool.query(`UPDATE comprobantes SET estado = 'rechazado' WHERE id = $1`, [id]);

    // Log
    console.log(`📝 [${requestId}] Insertando log de rechazo`);
    await logEvento({
      comprobanteId: id,
      orderNumber: comprobante.order_number,
      accion: motivo ? `comprobante_rechazado: ${motivo}` : 'comprobante_rechazado',
      origen: 'operador',
      userId: req.user?.id,
      username: req.user?.name
    });

    // WhatsApp al cliente - comprobante_rechazado
    const clienteRes = await pool.query(
      `SELECT customer_name, customer_phone FROM orders_validated WHERE order_number = $1`,
      [comprobante.order_number]
    );
    const cliente = clienteRes.rows[0];
    if (cliente?.customer_phone) {
      const TESTING_PHONE = '+5491123945965';
      if (cliente.customer_phone === TESTING_PHONE) {
        const contactIdClean = cliente.customer_phone.replace('+', '');
        axios.post(
          'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
          {
            chat: { channelId: process.env.BOTMAKER_CHANNEL_ID, contactId: contactIdClean },
            intentIdOrName: 'comprobante_rechazado',
            variables: {
              '1': cliente.customer_name || 'Cliente',
              '2': String(comprobante.monto),
              '3': comprobante.order_number
            }
          },
          { headers: { 'access-token': process.env.BOTMAKER_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
        ).then(() => console.log('📨 WhatsApp comprobante_rechazado enviado'))
         .catch(err => console.error('⚠️ Error WhatsApp comprobante_rechazado:', err.message));
      }
    }

    console.log(`❌ [${requestId}] Comprobante ${id} rechazado exitosamente`);

    res.json({
      ok: true,
      comprobante_id: id,
      order_number: comprobante.order_number
    });

  } catch (error) {
    console.error(`❌ [${requestId}] /comprobantes/:id/rechazar error:`, error.message);
    res.status(500).json({ error: error.message });
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

    // 4. Sincronizar productos (UPSERT + DELETE de removidos)
    await guardarProductos(orderNumber, pedido.products || []);

    // 5. Resolver inconsistencias previas
    await pool.query(`
      UPDATE order_inconsistencies
      SET resolved = TRUE, resolved_at = NOW()
      WHERE order_number = $1 AND resolved = FALSE
    `, [orderNumber]);

    console.log(`✅ Pedido #${orderNumber} re-sincronizado correctamente`);

    res.json({
      ok: true,
      message: `Pedido #${orderNumber} re-sincronizado`,
      productos_actualizados: (pedido.products || []).length
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
        const TESTING_PHONE = '+5491123945965';
        if (pedido.customer_phone === TESTING_PHONE) {
          const trackingParam = `${pedido.tn_order_id}/${pedido.tn_order_token}`;
          const contactIdClean = pedido.customer_phone.replace('+', '');

          axios.post(
            'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
            {
              chat: { channelId: process.env.BOTMAKER_CHANNEL_ID, contactId: contactIdClean },
              intentIdOrName: 'enviado_env_nube',
              variables: {
                '1': pedido.customer_name || 'Cliente',
                '2': orderNumber,
                '3': trackingParam
              }
            },
            { headers: { 'access-token': process.env.BOTMAKER_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
          ).then(() => console.log(`📨 WhatsApp enviado_env_nube enviado (Pedido #${orderNumber})`))
           .catch(err => console.error('⚠️ Error WhatsApp enviado_env_nube:', err.message));
        }
      } else if (esEnvioNube) {
        console.log(`⚠️ No se envió WhatsApp enviado_env_nube: faltan datos (phone: ${!!pedido.customer_phone}, order_id: ${!!pedido.tn_order_id}, token: ${!!pedido.tn_order_token})`);
      }
    }

    // WhatsApp automático cuando se marca como "cancelado"
    if (estado_pedido === 'cancelado' && pedido.customer_phone) {
      const TESTING_PHONE = '+5491123945965';
      if (pedido.customer_phone === TESTING_PHONE) {
        const contactIdClean = pedido.customer_phone.replace('+', '');
        axios.post(
          'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
          {
            chat: { channelId: process.env.BOTMAKER_CHANNEL_ID, contactId: contactIdClean },
            intentIdOrName: 'pedido_cancelado',
            variables: {
              '1': pedido.customer_name || 'Cliente',
              '2': orderNumber
            }
          },
          { headers: { 'access-token': process.env.BOTMAKER_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
        ).then(() => console.log(`📨 WhatsApp pedido_cancelado enviado (Pedido #${orderNumber})`))
         .catch(err => console.error('⚠️ Error WhatsApp pedido_cancelado:', err.message));
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


app.post('/webhook/tiendanube', async (req, res) => {
  // 1️⃣ Validación de firma
  if (!verifyTiendaNubeSignature(req)) {
    console.error('❌ Firma de Tiendanube inválida');
    return res.status(401).send('Invalid signature');
  }

  const { event, store_id, id: orderId } = req.body;

  console.log('📥 WEBHOOK TIENDANUBE:', event, 'orderId:', orderId);

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
      console.log(`⏭️ Webhook ya encolado: ${event} - ${orderId}`);
    }
  } catch (qErr) {
    // 23505 = unique_violation - backup por race conditions extremas
    if (qErr.code === '23505') {
      console.log(`⏭️ Webhook ya encolado (catch): ${event} - ${orderId}`);
    } else {
      console.error('⚠️ Error encolando webhook:', qErr.message);
    }
  }

  // 3️⃣ Respuesta inmediata
  res.status(200).json({ ok: true });

  // 4️⃣ Procesar async
  try {

    // 📛 order/cancelled - Marcar pedido como cancelado
    if (event === 'order/cancelled') {
      // Buscar el número de pedido desde TiendaNube
      const pedido = await obtenerPedidoPorId(store_id, orderId);
      const orderNumber = pedido?.number ? String(pedido.number) : null;

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🚫 PEDIDO CANCELADO');
      console.log(`   Store ID: ${store_id}`);
      console.log(`   Order ID: ${orderId}`);
      console.log(`   Order Number: ${orderNumber || 'N/A'}`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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
          const TESTING_PHONE = '+5491123945965';
          if (clienteCancel.customer_phone === TESTING_PHONE) {
            const contactIdClean = clienteCancel.customer_phone.replace('+', '');
            axios.post(
              'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
              {
                chat: { channelId: process.env.BOTMAKER_CHANNEL_ID, contactId: contactIdClean },
                intentIdOrName: 'pedido_cancelado',
                variables: {
                  '1': clienteCancel.customer_name || 'Cliente',
                  '2': orderNumber
                }
              },
              { headers: { 'access-token': process.env.BOTMAKER_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
            ).then(() => console.log(`📨 WhatsApp pedido_cancelado enviado (Pedido #${orderNumber})`))
             .catch(err => console.error('⚠️ Error WhatsApp pedido_cancelado:', err.message));
          }
        }

        console.log(`✅ Pedido #${orderNumber} marcado como cancelado en DB`);
      }
      return;
    }

    // Solo procesar order/created y order/updated
    if (event !== 'order/created' && event !== 'order/updated') return;

    // 3️⃣ Buscar pedido en Tiendanube
    const pedido = await obtenerPedidoPorId(store_id, orderId);

    if (!pedido) {
      console.log('❌ Pedido no encontrado en Tiendanube');
      return;
    }

    // Validar que el pedido tenga number antes de procesar
    if (!pedido.number) {
      console.log(`⚠️ Webhook recibido sin order number (orderId: ${orderId}), ignorando`);
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
        console.log(`⚠️ order/updated para pedido #${pedido.number} que no existe en DB, ignorando`);
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

      console.log(`📝 #${pedido.number}:\n${mensaje}`);

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
    console.log(`✅ Pedido #${pedido.number} guardado en DB (order/created)`);

    // 🔍 Verificar consistencia con TiendaNube
    await verificarConsistencia(String(pedido.number), pedido);

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

    // Obtener financiera default para determinar qué plantilla usar
    let plantilla = 'pedido_creado'; // fallback
    try {
      const finResult = await pool.query(`
        SELECT nombre
        FROM financieras
        WHERE is_default = true
        LIMIT 1
      `);
      if (finResult.rows.length > 0) {
        const nombreFinanciera = finResult.rows[0].nombre.toLowerCase();
        if (nombreFinanciera.includes('wanda')) {
          plantilla = 'pedido_creado_wanda';
        } else if (nombreFinanciera.includes('kiesel')) {
          plantilla = 'pedido_creado_kiesel';
        }
        console.log(`🏦 Financiera default: ${finResult.rows[0].nombre} → plantilla: ${plantilla}`);
      }
    } catch (err) {
      console.error('⚠️ Error obteniendo financiera default:', err.message);
    }

    const contactIdClean = telefono.replace('+', '');

    // 6️⃣ Botmaker - plantilla según financiera default
    await axios.post(
      'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
      {
        chat: {
          channelId: process.env.BOTMAKER_CHANNEL_ID,
          contactId: contactIdClean
        },
        intentIdOrName: plantilla,
        variables: {
          '1': pedido.customer?.name || 'Cliente',
          '2': String(pedido.number)
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

    // 7️⃣ Si requiere formulario de envío (Expreso a elección o Via Cargo)
    const shippingOption = (typeof pedido.shipping_option === 'string'
      ? pedido.shipping_option
      : pedido.shipping_option?.name) || '';

    if (requiresShippingForm(shippingOption)) {
      console.log(`🚚 Pedido requiere formulario de envío: ${shippingOption}`);
      await axios.post(
        'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
        {
          chat: {
            channelId: process.env.BOTMAKER_CHANNEL_ID,
            contactId: contactIdClean
          },
          intentIdOrName: 'datos_envio',
          variables: {
            '1': pedido.customer?.name || 'Cliente',
            '2': String(pedido.number)
          }
        },
        {
          headers: {
            'access-token': process.env.BOTMAKER_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`✅ WhatsApp datos_envio enviado (Pedido #${pedido.number})`);
    }

  } catch (err) {
    console.error('❌ Error webhook:', err.message);
    console.error('   Stack:', err.stack?.split('\n')[1]);
  }
});




/* =====================================================
   PASO 1 — VALIDAR PEDIDO
===================================================== */

app.post('/validate-order', validationLimiter, async (req, res) => {
  try {
    const { orderNumber } = req.body;

    if (!orderNumber) {
      return res.status(400).json({ error: 'Falta orderNumber' });
    }

    // Validación de seguridad: orderNumber debe ser numérico y razonable
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
    const { orderNumber } = req.body;
    const file = req.file;

    console.log('📥 /upload iniciado');

    if (!orderNumber || !file) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    // Validación de seguridad: orderNumber debe ser numérico y razonable
    const sanitizedOrderNumber = String(orderNumber).replace(/\D/g, '');
    if (!sanitizedOrderNumber || sanitizedOrderNumber.length > 20) {
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
       2.5️⃣ VALIDAR CUENTA DESTINO
    ================================ */
    const cuentaDestino = extractDestinationAccount(textoOcr);
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
      // Loguear intento de duplicado para auditoría
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

    // 4️⃣ Obtener monto y estado actual del pedido
    const orderRes = await pool.query(
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
    await pool.query(
      `UPDATE orders_validated
       SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
       WHERE order_number = $5`,
      [totalPagado, saldo, estadoPago, nuevoEstadoPedido, comprobante.order_number]
    );

    return res.send(`
      <h2>✅ Comprobante confirmado</h2>
      <p>Pedido: ${comprobante.order_number}</p>
      <p>Total pagado: $${totalPagado}</p>
      <p>Estado pago: ${estadoPago}</p>
      <p>Estado pedido: ${nuevoEstadoPedido}</p>
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
   UTIL — CALCULAR ESTADO PEDIDO (centralizado)
   Regla: si hay plata pagada → puede avanzar en flujo logístico
   Independiente del método de pago (transferencia, efectivo, etc.)
===================================================== */
function calcularEstadoPedido(estadoPago, estadoPedidoActual) {
  // Si ya avanzó más allá de pendiente_pago, no retroceder
  if (estadoPedidoActual !== 'pendiente_pago') {
    return estadoPedidoActual;
  }

  // Estados de pago que indican que hay plata pagada → avanzar a a_imprimir
  const estadosPagados = ['confirmado_total', 'confirmado_parcial', 'a_favor'];

  if (estadosPagados.includes(estadoPago)) {
    return 'a_imprimir';
  }

  // Si no hay pago confirmado, mantener pendiente_pago
  return 'pendiente_pago';
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
      `SELECT order_number, monto_tiendanube, estado_pedido
       FROM orders_validated
       WHERE order_number = $1`,
      [orderNumber]
    );

    if (orderRes.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const montoTiendanube = Number(orderRes.rows[0].monto_tiendanube);
    const estadoPedidoActual = orderRes.rows[0].estado_pedido;

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
       5️⃣ CALCULAR ESTADO PEDIDO (lógica centralizada)
    ================================ */
    const nuevoEstadoPedido = calcularEstadoPedido(estadoPago, estadoPedidoActual);

    /* ===============================
       6️⃣ ACTUALIZAR ORDEN
    ================================ */
    await pool.query(
      `UPDATE orders_validated
       SET total_pagado = $1, saldo = $2, estado_pago = $3, estado_pedido = $4
       WHERE order_number = $5`,
      [totalPagado, saldo, estadoPago, nuevoEstadoPedido, orderNumber]
    );

    // Log de actividad
    await logEvento({
      orderNumber,
      accion: 'pago_efectivo_registrado',
      origen: 'caja',
      userId: req.user?.id,
      username: req.user?.name
    });

    console.log('✅ Pago en efectivo procesado');
    console.log('Total pagado:', totalPagado);
    console.log('Saldo:', saldo);
    console.log('Estado pago:', estadoPago);
    if (nuevoEstadoPedido !== estadoPedidoActual) {
      console.log(`📦 Estado pedido: ${estadoPedidoActual} → ${nuevoEstadoPedido}`);
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
const financierasRoutes = require('./routes/financieras');
const remitosRoutes = require('./routes/remitos');
const waspyRoutes = require('./routes/waspy');

app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/roles', rolesRoutes);
app.use('/financieras', financierasRoutes);
app.use('/remitos', remitosRoutes);
app.use('/waspy', waspyRoutes);

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
    console.error(`[SYNC] Error acquiring lock: ${err.message}`);
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
    console.error(`[SYNC] Error releasing lock: ${err.message}`);
  }
}

/**
 * Wrapper único para ejecutar sync desde cualquier punto de entrada
 * Usa lock basado en tabla para garantizar máximo 1 sync
 * corriendo a la vez ENTRE TODAS LAS INSTANCIAS de Cloud Run
 */
async function triggerSync(source) {
  const timestamp = new Date().toISOString();
  const currentRunId = ++syncRunId;

  // Intentar obtener distributed lock
  const lockAcquired = await tryAcquireSyncLock(source);

  if (!lockAcquired) {
    // Otra instancia tiene el lock - salir silenciosamente
    console.log(`[SYNC] ${timestamp} | SKIP | source=${source} | reason=distributed_lock_held`);
    return { status: 'skipped', message: 'Another instance is running sync' };
  }

  // Lock adquirido - ejecutar sync
  localSyncRunning = true;
  const startTime = Date.now();
  lastStartAt = timestamp;
  lastSource = source;
  lastError = null;
  lastResult = null;

  console.log(`[SYNC] ${timestamp} | START | runId=${currentRunId} | source=${source}`);

  try {
    const result = await runSyncJob();
    lastResult = result;
    return { status: 'completed', runId: currentRunId, result };

  } catch (error) {
    lastError = error.message;
    console.error(`[SYNC] ERROR | runId=${currentRunId} | source=${source} | error=${error.message}`);
    throw error;

  } finally {
    const duration = Date.now() - startTime;
    lastEndAt = new Date().toISOString();
    localSyncRunning = false;

    // Liberar distributed lock
    await releaseSyncLock();

    console.log(`[SYNC] ${lastEndAt} | END | runId=${currentRunId} | source=${source} | duration=${duration}ms`);
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

// Ejecutar sincronización manual
app.post('/sync/run', authenticate, requirePermission('users.view'), async (req, res) => {
  const source = `manual-${req.user.email}`;
  console.log(`🔄 Sincronización manual solicitada por: ${req.user.email}`);

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

// Scheduler: ejecutar sync cada 15 minutos
const SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutos
let syncInterval = null;

function startSyncScheduler() {
  if (syncInterval) return;

  console.log('⏰ Scheduler de sincronización iniciado (cada 5 min)');

  // Primera ejecución después de 30 segundos
  setTimeout(() => {
    triggerSync('startup-30s').catch(err => {
      console.error('❌ Error en sync inicial:', err.message);
    });
  }, 30000);

  // Luego cada 5 minutos
  syncInterval = setInterval(() => {
    triggerSync('interval-5min').catch(err => {
      console.error('❌ Error en sync programado:', err.message);
    });
  }, SYNC_INTERVAL);
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
        Title: `Etiqueta Envío - Pedido #${orderNumber}`,
        Author: 'Pet Love Argentina'
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
   SENTRY ERROR HANDLING
===================================================== */

// Sentry error handler - DEBE ir después de todas las rutas
Sentry.setupExpressErrorHandler(app);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
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
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    if (process.env.SENTRY_DSN) {
      console.log('✅ Sentry error monitoring enabled');
    }

    // Iniciar scheduler de sincronización
    startSyncScheduler();
  });
}

// Exportar app para tests
module.exports = { app };
