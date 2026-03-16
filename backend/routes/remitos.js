/**
 * Rutas de Carga Masiva de Remitos
 * POST /remitos/upload - Subir múltiples remitos
 * GET /remitos - Listar remitos con filtros
 * POST /remitos/:id/confirm - Confirmar match
 * POST /remitos/:id/reject - Rechazar/marcar como no identificado
 * POST /remitos/:id/reassign - Asignar a otro pedido
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const vision = require('@google-cloud/vision');
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { processDocument } = require('../services/shippingDocuments');

// Configurar Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Configurar Google Vision
const visionClient = new vision.ImageAnnotatorClient();

// Función para loguear eventos (misma estructura que index.js)
async function logEvento({ orderNumber, accion, origen, userId, username }) {
  try {
    await pool.query(
      `INSERT INTO logs (comprobante_id, order_number, accion, origen, user_id, username)
       VALUES (NULL, $1, $2, $3, $4, $5)`,
      [orderNumber || null, accion, origen, userId || null, username || null]
    );
  } catch (err) {
    console.error('❌ Error guardando log remito:', err.message);
  }
}

// Configurar multer para uploads temporales
const upload = multer({
  dest: 'uploads/remitos/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB por archivo
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
  }
});

/**
 * POST /remitos/upload
 * Subir múltiples remitos para procesamiento OCR
 */
router.post('/upload',
  authenticate,
  requirePermission('remitos.upload'),
  upload.array('files', 50), // Máximo 50 archivos
  async (req, res) => {
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No se enviaron archivos' });
    }

    console.log(`📤 Recibidos ${files.length} remitos para procesar`);

    const results = [];
    const errors = [];

    for (const file of files) {
      try {
        // 1. Subir a Supabase Storage
        const fileBuffer = fs.readFileSync(file.path);
        // Sanitizar nombre de archivo: remover caracteres especiales Unicode
        const safeName = file.originalname
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')  // Quitar acentos
          .replace(/[^\w\s.-]/g, '')         // Solo alfanuméricos, espacios, puntos, guiones
          .replace(/\s+/g, '_');             // Espacios a guiones bajos
        const fileName = `${Date.now()}-${safeName}`;
        const supabasePath = `remitos/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('comprobantes') // Usar bucket existente
          .upload(supabasePath, fileBuffer, {
            contentType: file.mimetype,
            upsert: false
          });

        if (uploadError) {
          throw new Error(`Error subiendo a storage: ${uploadError.message}`);
        }

        const fileUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/comprobantes/${supabasePath}`;

        // 2. Crear registro en DB con estado 'processing'
        const insertRes = await pool.query(`
          INSERT INTO shipping_documents (file_url, file_name, file_type, status)
          VALUES ($1, $2, $3, 'processing')
          RETURNING id
        `, [fileUrl, file.originalname, file.mimetype]);

        const documentId = insertRes.rows[0].id;

        // 3. Eliminar archivo temporal
        fs.unlinkSync(file.path);

        // 4. Procesar OCR en background (no esperar)
        processOCRAsync(documentId, fileBuffer, file.mimetype);

        // 5. Loguear evento
        logEvento({
          orderNumber: null, // Aún no sabemos el pedido
          accion: 'remito_subido',
          origen: 'operador',
          userId: req.user?.id,
          username: req.user?.name
        });

        results.push({
          id: documentId,
          fileName: file.originalname,
          status: 'processing'
        });

      } catch (error) {
        console.error(`❌ Error procesando ${file.originalname}:`, error.message);
        errors.push({
          fileName: file.originalname,
          error: error.message
        });

        // Limpiar archivo temporal si existe
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }

    res.json({
      ok: true,
      uploaded: results.length,
      errors: errors.length,
      results,
      errorDetails: errors
    });
  }
);

/**
 * Procesa OCR de forma asíncrona
 */
async function processOCRAsync(documentId, fileBuffer, mimeType) {
  try {
    console.log(`🔄 Iniciando OCR para documento ${documentId}...`);

    let ocrText = '';
    let textAnnotations = null;

    if (mimeType === 'application/pdf') {
      // Para PDFs, usar detectDocumentText con inputConfig
      const [result] = await visionClient.documentTextDetection({
        image: { content: fileBuffer.toString('base64') }
      });
      ocrText = result.fullTextAnnotation?.text || '';
      // PDFs no tienen bounding boxes útiles para separación de columnas
    } else {
      // Para imágenes - capturar textAnnotations con bounding boxes
      const [result] = await visionClient.textDetection({
        image: { content: fileBuffer.toString('base64') }
      });
      ocrText = result.fullTextAnnotation?.text || '';
      textAnnotations = result.textAnnotations || null;

      if (textAnnotations) {
        console.log(`📐 OCR devolvió ${textAnnotations.length} anotaciones con bounding boxes`);
      }
    }

    if (!ocrText) {
      console.log(`⚠️ No se detectó texto en documento ${documentId}`);
      await pool.query(`
        UPDATE shipping_documents
        SET status = 'ready', ocr_processed_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [documentId]);
      return;
    }

    console.log(`📝 OCR completado para documento ${documentId} (${ocrText.length} caracteres)`);

    // Procesar y buscar coincidencias (pasar textAnnotations para separación por layout)
    await processDocument(documentId, ocrText, textAnnotations);

  } catch (error) {
    console.error(`❌ Error OCR documento ${documentId}:`, error.message);
    await pool.query(`
      UPDATE shipping_documents
      SET status = 'error', error_message = $1, updated_at = NOW()
      WHERE id = $2
    `, [`OCR Error: ${error.message}`, documentId]);
  }
}

/**
 * GET /remitos
 * Listar remitos con filtros
 */
router.get('/',
  authenticate,
  requirePermission('remitos.view'),
  async (req, res) => {
    try {
      const { status, page = 1, limit = 50 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let whereClause = '';
      const params = [];
      let paramIndex = 1;

      if (status) {
        whereClause = `WHERE status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      // Obtener remitos - usar confirmed_order_number si existe, sino suggested
      const remitosRes = await pool.query(`
        SELECT
          sd.*,
          ov.customer_name as order_customer_name,
          ov.shipping_address->>'address' as order_address,
          ov.estado_pedido as order_status
        FROM shipping_documents sd
        LEFT JOIN orders_validated ov ON COALESCE(sd.confirmed_order_number, sd.suggested_order_number) = ov.order_number
        ${whereClause}
        ORDER BY sd.created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `, [...params, parseInt(limit), offset]);

      // Contar total
      const countRes = await pool.query(`
        SELECT COUNT(*) as total FROM shipping_documents ${whereClause}
      `, params);

      res.json({
        ok: true,
        remitos: remitosRes.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countRes.rows[0].total),
          totalPages: Math.ceil(countRes.rows[0].total / parseInt(limit))
        }
      });

    } catch (error) {
      console.error('❌ GET /remitos error:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * GET /remitos/stats
 * Estadísticas de remitos
 */
router.get('/stats',
  authenticate,
  requirePermission('remitos.view'),
  async (req, res) => {
    try {
      const statsRes = await pool.query(`
        SELECT
          status,
          COUNT(*) as count
        FROM shipping_documents
        GROUP BY status
      `);

      const stats = {};
      for (const row of statsRes.rows) {
        stats[row.status] = parseInt(row.count);
      }

      res.json({
        ok: true,
        stats: {
          pending: stats.pending || 0,
          processing: stats.processing || 0,
          ready: stats.ready || 0,
          confirmed: stats.confirmed || 0,
          rejected: stats.rejected || 0,
          error: stats.error || 0,
          total: Object.values(stats).reduce((a, b) => a + b, 0)
        }
      });

    } catch (error) {
      console.error('❌ GET /remitos/stats error:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * POST /remitos/:id/confirm
 * Confirmar match sugerido o asignar a pedido específico
 */
router.post('/:id/confirm',
  authenticate,
  requirePermission('remitos.confirm'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { orderNumber } = req.body; // Opcional - si no viene, usa el sugerido

      // Obtener remito
      const remitoRes = await pool.query(
        'SELECT * FROM shipping_documents WHERE id = $1',
        [id]
      );

      if (remitoRes.rowCount === 0) {
        return res.status(404).json({ error: 'Remito no encontrado' });
      }

      const remito = remitoRes.rows[0];

      if (remito.status === 'confirmed') {
        return res.status(400).json({ error: 'Remito ya confirmado' });
      }

      const confirmedOrder = orderNumber || remito.suggested_order_number;

      if (!confirmedOrder) {
        return res.status(400).json({ error: 'No hay pedido para confirmar' });
      }

      // Verificar que el pedido existe
      const orderRes = await pool.query(
        'SELECT order_number FROM orders_validated WHERE order_number = $1',
        [confirmedOrder]
      );

      if (orderRes.rowCount === 0) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      // Verificar que el pedido tiene datos de envío
      const shippingRes = await pool.query(
        'SELECT id FROM shipping_requests WHERE order_number = $1',
        [confirmedOrder]
      );

      if (shippingRes.rowCount === 0) {
        return res.status(400).json({
          error: 'El pedido no tiene datos de envío. El cliente debe completar el formulario de envío primero.'
        });
      }

      // Confirmar
      await pool.query(`
        UPDATE shipping_documents
        SET
          confirmed_order_number = $1,
          confirmed_by = $2,
          confirmed_at = NOW(),
          status = 'confirmed',
          updated_at = NOW()
        WHERE id = $3
      `, [confirmedOrder, req.user?.id, id]);

      console.log(`✅ Remito ${id} confirmado para pedido #${confirmedOrder}`);

      // Loguear evento
      logEvento({
        orderNumber: confirmedOrder,
        accion: 'remito_confirmado',
        origen: 'operador',
        userId: req.user?.id,
        username: req.user?.name
      });

      // Enviar WhatsApp enviado_transporte con imagen del remito
      const pedidoRes = await pool.query(
        `SELECT customer_name, customer_phone, shipping_type FROM orders_validated WHERE order_number = $1`,
        [confirmedOrder]
      );
      const pedido = pedidoRes.rows[0];

      if (pedido?.customer_phone) {
        const shippingType = (pedido.shipping_type || '').toLowerCase();
        const esTransporte = shippingType.includes('expreso') ||
                            shippingType.includes('via cargo') ||
                            shippingType.includes('viacargo') ||
                            shippingType.includes('elec');

        if (esTransporte) {
          const phoneDigits = pedido.customer_phone.replace(/\D/g, '').slice(-10);
          const TESTING_PHONES = ['1123945965', '1126032641'];

          if (TESTING_PHONES.includes(phoneDigits)) {
            const contactIdClean = '549' + phoneDigits;
            const headers = { 'access-token': process.env.BOTMAKER_ACCESS_TOKEN, 'Content-Type': 'application/json' };

            // Enviar template con imagen del remito como header
            axios.post(
              'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
              {
                chat: { channelId: process.env.BOTMAKER_CHANNEL_ID, contactId: contactIdClean },
                intentIdOrName: 'enviado_transporte',
                variables: {
                  'headerImageUrl': remito.file_url,
                  '1': pedido.customer_name || 'Cliente',
                  '2': confirmedOrder
                }
              },
              { headers }
            ).then(tplRes => {
              console.log(`📨 WhatsApp enviado_transporte enviado (Pedido #${confirmedOrder}) | requestId: ${tplRes.data?.requestId || 'N/A'}`);
            }).catch(err => {
              const errorData = err.response?.data ? JSON.stringify(err.response.data) : err.message;
              console.error(`❌ Error WhatsApp enviado_transporte (Pedido #${confirmedOrder}): ${errorData}`);
            });
          }
        }
      }

      res.json({
        ok: true,
        remito_id: id,
        confirmed_order: confirmedOrder
      });

    } catch (error) {
      console.error('❌ POST /remitos/:id/confirm error:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * DELETE /remitos/:id
 * Eliminar un remito
 */
router.delete('/:id',
  authenticate,
  requirePermission('remitos.confirm'), // Mismo permiso que confirmar
  async (req, res) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        'DELETE FROM shipping_documents WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Remito no encontrado' });
      }

      console.log(`🗑️ Remito ${id} eliminado`);

      res.json({ ok: true, remito_id: id });

    } catch (error) {
      console.error('❌ DELETE /remitos/:id error:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * GET /remitos/by-order/:orderNumber
 * Obtener remito confirmado por número de pedido
 */
router.get('/by-order/:orderNumber',
  authenticate,
  requirePermission('remitos.view'),
  async (req, res) => {
    try {
      const { orderNumber } = req.params;

      const remitoRes = await pool.query(`
        SELECT
          sd.*,
          ov.customer_name as order_customer_name,
          ov.shipping_address as order_shipping_address,
          ov.estado_pedido as order_status,
          ov.monto_tiendanube as order_total
        FROM shipping_documents sd
        LEFT JOIN orders_validated ov ON sd.confirmed_order_number = ov.order_number
        WHERE sd.confirmed_order_number = $1 AND sd.status = 'confirmed'
        ORDER BY sd.confirmed_at DESC
        LIMIT 1
      `, [orderNumber]);

      if (remitoRes.rowCount === 0) {
        return res.json({ ok: true, remito: null });
      }

      res.json({
        ok: true,
        remito: remitoRes.rows[0]
      });

    } catch (error) {
      console.error('❌ GET /remitos/by-order/:orderNumber error:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * GET /remitos/:id
 * Obtener detalle de un remito
 */
router.get('/:id',
  authenticate,
  requirePermission('remitos.view'),
  async (req, res) => {
    try {
      const { id } = req.params;

      const remitoRes = await pool.query(`
        SELECT
          sd.*,
          ov.customer_name as order_customer_name,
          ov.shipping_address as order_shipping_address,
          ov.estado_pedido as order_status,
          ov.monto_tiendanube as order_total
        FROM shipping_documents sd
        LEFT JOIN orders_validated ov ON COALESCE(sd.confirmed_order_number, sd.suggested_order_number) = ov.order_number
        WHERE sd.id = $1
      `, [id]);

      if (remitoRes.rowCount === 0) {
        return res.status(404).json({ error: 'Remito no encontrado' });
      }

      res.json({
        ok: true,
        remito: remitoRes.rows[0]
      });

    } catch (error) {
      console.error('❌ GET /remitos/:id error:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);


module.exports = router;
