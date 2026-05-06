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
const fs = require('fs');
const axios = require('axios');
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { enviarWhatsAppPlantilla } = require('../lib/whatsapp-helpers');
const { ingestRemito } = require('../services/remitoIngest');

const { logEvento } = require('../utils/logging');
const { syncEstadoToTN } = require('../lib/tn-sync');

// Configurar multer para uploads temporales
const upload = multer({
  dest: 'uploads/remitos/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB por archivo
  fileFilter: (req, file, cb) => {
    // HEIC/HEIF se aceptan y se convierten a JPEG en el handler.
    // Si un archivo no es de tipo permitido, lo skipeamos con cb(null, false)
    // en vez de tirar Error — así multer no aborta toda la request.
    const allowedTypes = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      console.warn(`⚠️ Archivo skipeado (tipo no permitido): ${file.originalname} (${file.mimetype})`);
      cb(null, false);
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
  upload.array('files', 200), // Máximo 200 archivos por batch
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
        const buffer = fs.readFileSync(file.path);
        const result = await ingestRemito({
          buffer,
          mimetype: file.mimetype,
          originalName: file.originalname,
          uploadedBy: req.user?.id || null,
          uploadedByName: req.user?.name,
          source: 'manual',
        });
        fs.unlinkSync(file.path);

        results.push({
          id: result.documentId,
          fileName: file.originalname,
          status: result.status,
        });
      } catch (error) {
        console.error('Error procesando ' + file.originalname + ':', error.message);
        errors.push({
          fileName: file.originalname,
          error: error.message,
        });
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
 * GET /remitos
 * Listar remitos con filtros
 */
router.get('/',
  authenticate,
  requirePermission('remitos.view'),
  async (req, res) => {
    try {
      const { status, page = 1, limit = 50, search, dateFrom, dateTo } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const conditions = [];
      const params = [];
      let paramIndex = 1;

      if (status) {
        conditions.push(`sd.status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      } else {
        // Soft delete: si no se filtra explícitamente por status, ocultamos
        // los 'deleted' (que el cron de Drive intake mantiene como tombstone
        // para evitar reingestar el mismo archivo).
        conditions.push(`sd.status <> 'deleted'`);
      }

      if (search) {
        // Match por número actual del remito (confirmado si existe, sugerido si no)
        // o por nombre detectado. Así un remito reasignado deja de aparecer al
        // buscar su número original sugerido por OCR.
        conditions.push(`(
          COALESCE(sd.confirmed_order_number, sd.suggested_order_number) ILIKE $${paramIndex} OR
          sd.detected_name ILIKE $${paramIndex}
        )`);
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (dateFrom) {
        conditions.push(`sd.created_at >= $${paramIndex}`);
        params.push(dateFrom);
        paramIndex++;
      }

      if (dateTo) {
        // Inclusivo: hasta el final del dia
        conditions.push(`sd.created_at < ($${paramIndex}::date + INTERVAL '1 day')`);
        params.push(dateTo);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Obtener remitos con JOIN a users para nombres de quien subio/aprobo
      const remitosRes = await pool.query(`
        SELECT
          sd.*,
          ov.customer_name as order_customer_name,
          ov.shipping_address->>'address' as order_address,
          ov.estado_pedido as order_status,
          uploader.name as uploaded_by_name,
          confirmer.name as confirmed_by_name
        FROM shipping_documents sd
        LEFT JOIN orders_validated ov ON COALESCE(sd.confirmed_order_number, sd.suggested_order_number) = ov.order_number
        LEFT JOIN users uploader ON uploader.id = sd.uploaded_by
        LEFT JOIN users confirmer ON confirmer.id = sd.confirmed_by
        ${whereClause}
        ORDER BY sd.created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `, [...params, parseInt(limit), offset]);

      // Contar total
      const countRes = await pool.query(`
        SELECT COUNT(*) as total FROM shipping_documents sd ${whereClause}
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
        WHERE status <> 'deleted'
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

      // TEMPORALMENTE DESHABILITADO - permitir confirmar sin formulario de envío
      // const shippingRes = await pool.query(
      //   'SELECT id FROM shipping_requests WHERE order_number = $1',
      //   [confirmedOrder]
      // );
      //
      // if (shippingRes.rowCount === 0) {
      //   return res.status(400).json({
      //     error: 'El pedido no tiene datos de envío. El cliente debe completar el formulario de envío primero.'
      //   });
      // }

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

      // Marcar pedido como enviado (igual que Envío Nube al despachar)
      await pool.query(`
        UPDATE orders_validated
        SET estado_pedido = 'enviado',
            shipped_at = COALESCE(shipped_at, NOW())
        WHERE order_number = $1
      `, [confirmedOrder]);
      console.log(`📦 Pedido #${confirmedOrder} marcado como enviado`);

      // Loguear eventos
      logEvento({
        orderNumber: confirmedOrder,
        accion: 'remito_confirmado',
        origen: 'operador',
        userId: req.user?.id,
        username: req.user?.name
      });
      logEvento({
        orderNumber: confirmedOrder,
        accion: 'pedido_enviado',
        origen: 'operador',
        userId: req.user?.id,
        username: req.user?.name
      });

      // Sincronizar estado a Tiendanube (async, no bloquea respuesta)
      const tnRes = await pool.query(
        `SELECT tn_order_id FROM orders_validated WHERE order_number = $1`,
        [confirmedOrder]
      );
      const tnOrderId = tnRes.rows[0]?.tn_order_id;
      if (tnOrderId) {
        syncEstadoToTN(tnOrderId, confirmedOrder, 'enviado');
      }

      // Enviar WhatsApp enviado_transporte con imagen del remito
      const pedidoRes = await pool.query(
        `SELECT customer_name, customer_phone FROM orders_validated WHERE order_number = $1`,
        [confirmedOrder]
      );
      const pedido = pedidoRes.rows[0];

      if (pedido?.customer_phone) {
        try {
          await enviarWhatsAppPlantilla({
            telefono: pedido.customer_phone,
            plantilla: 'enviado_transporte',
            variables: {
              'headerImageUrl': remito.file_url,
              '1': pedido.customer_name || 'Cliente',
              '2': confirmedOrder
            },
            orderNumber: confirmedOrder
          });
        } catch (waErr) {
          console.error(`❌ Error WhatsApp enviado_transporte (Pedido #${confirmedOrder}): ${waErr.message}`);
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

      // Soft delete: marcamos status='deleted' en vez de DELETE fisico para
      // que el cron de Drive intake siga viendo el source_drive_file_id en
      // shipping_documents y no reingese el archivo. La fila se oculta del
      // listado y de los stats (filtros agregados en GET / y GET /stats).
      const result = await pool.query(
        `UPDATE shipping_documents
         SET status = 'deleted', updated_at = NOW()
         WHERE id = $1 AND status <> 'deleted'
         RETURNING id`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Remito no encontrado' });
      }

      console.log(`🗑️ Remito ${id} eliminado (soft delete)`);

      res.json({ ok: true, remito_id: id });

      await logEvento({ accion: 'remito_eliminado', origen: 'operador', userId: req.user.id, username: req.user.name });

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
        WHERE sd.id = $1 AND sd.status <> 'deleted'
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
