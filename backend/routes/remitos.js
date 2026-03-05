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
        const fileName = `${Date.now()}-${file.originalname}`;
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

    if (mimeType === 'application/pdf') {
      // Para PDFs, usar detectDocumentText con inputConfig
      const [result] = await visionClient.documentTextDetection({
        image: { content: fileBuffer.toString('base64') }
      });
      ocrText = result.fullTextAnnotation?.text || '';
    } else {
      // Para imágenes
      const [result] = await visionClient.textDetection({
        image: { content: fileBuffer.toString('base64') }
      });
      ocrText = result.fullTextAnnotation?.text || '';
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

    // Procesar y buscar coincidencias
    await processDocument(documentId, ocrText);

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

      // Obtener remitos
      const remitosRes = await pool.query(`
        SELECT
          sd.*,
          ov.customer_name as order_customer_name,
          ov.shipping_address->>'address' as order_address,
          ov.estado_pedido as order_status
        FROM shipping_documents sd
        LEFT JOIN orders_validated ov ON sd.suggested_order_number = ov.order_number
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
 * POST /remitos/:id/reject
 * Marcar remito como no identificado/rechazado
 */
router.post('/:id/reject',
  authenticate,
  requirePermission('remitos.reject'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      await pool.query(`
        UPDATE shipping_documents
        SET
          status = 'rejected',
          error_message = $1,
          confirmed_by = $2,
          confirmed_at = NOW(),
          updated_at = NOW()
        WHERE id = $3
      `, [reason || 'Marcado como no identificado', req.user?.id, id]);

      console.log(`❌ Remito ${id} rechazado`);

      res.json({ ok: true, remito_id: id });

    } catch (error) {
      console.error('❌ POST /remitos/:id/reject error:', error.message);
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
        LEFT JOIN orders_validated ov ON sd.suggested_order_number = ov.order_number
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

/**
 * POST /remitos/:id/reprocess
 * Reprocesar OCR de un remito
 */
router.post('/:id/reprocess',
  authenticate,
  requirePermission('remitos.reprocess'),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Obtener remito
      const remitoRes = await pool.query(
        'SELECT file_url, file_type FROM shipping_documents WHERE id = $1',
        [id]
      );

      if (remitoRes.rowCount === 0) {
        return res.status(404).json({ error: 'Remito no encontrado' });
      }

      // Marcar como procesando
      await pool.query(`
        UPDATE shipping_documents
        SET status = 'processing', updated_at = NOW()
        WHERE id = $1
      `, [id]);

      // Descargar archivo y reprocesar
      const remito = remitoRes.rows[0];
      const axios = require('axios');
      const response = await axios.get(remito.file_url, { responseType: 'arraybuffer' });
      const fileBuffer = Buffer.from(response.data);

      // Procesar en background
      processOCRAsync(id, fileBuffer, remito.file_type);

      res.json({
        ok: true,
        remito_id: id,
        status: 'processing'
      });

    } catch (error) {
      console.error('❌ POST /remitos/:id/reprocess error:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
