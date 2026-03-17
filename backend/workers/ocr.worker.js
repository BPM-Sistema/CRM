/**
 * OCR Worker
 *
 * Procesa comprobantes de pago via Google Vision OCR.
 * Reemplaza el procesamiento sincrono del endpoint /upload.
 *
 * Cola: ocr-processing
 */

const { Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const vision = require('@google-cloud/vision');
const pool = require('../db');
const supabase = require('../supabase');
const { workerLogger: log } = require('../lib/logger');
const { redis } = require('../lib/redis');
const {
  validarComprobante,
  extractDestinationAccount,
  isValidDestination,
  detectarMontoDesdeOCR,
  watermarkReceipt,
  calcularEstadoCuenta,
  hashText
} = require('../lib/comprobante-helpers');

const visionClient = new vision.ImageAnnotatorClient();

/**
 * Limpia el archivo temporal de forma segura
 */
async function cleanupTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (err) {
    log.warn({ filePath, err: err.message }, 'Error limpiando archivo temporal');
  }
}

/**
 * Marca el comprobante como error en la DB
 */
async function markComprobanteError(comprobanteId, errorMessage) {
  try {
    await pool.query(
      `UPDATE comprobantes
       SET estado = 'error_ocr', notas = $2, updated_at = NOW()
       WHERE id = $1`,
      [comprobanteId, errorMessage]
    );
  } catch (dbErr) {
    log.error({ comprobanteId, dbErr: dbErr.message }, 'Error actualizando estado error en comprobante');
  }
}

/**
 * Procesador principal del job OCR
 */
async function processOcrJob(job) {
  const {
    filePath,
    orderNumber,
    montoTiendanube,
    currency,
    customerName,
    customerPhone,
    comprobanteId,
    supabasePath,
    fileUrl,
    requestId
  } = job.data;

  const jobLog = log.child({ requestId, jobId: job.id, orderNumber, comprobanteId });
  jobLog.info('Iniciando procesamiento OCR');

  try {
    // 1. Leer archivo
    jobLog.debug({ filePath }, 'Leyendo archivo');
    const fileBuffer = await fs.promises.readFile(filePath);

    // 2. Google Vision OCR
    jobLog.debug('Ejecutando Google Vision textDetection');
    const [result] = await visionClient.textDetection({ image: { content: fileBuffer } });
    const textoOcr = result.fullTextAnnotation?.text || '';

    if (!textoOcr) {
      jobLog.warn('OCR no devolvio texto');
      await markComprobanteError(comprobanteId, 'OCR no pudo extraer texto del comprobante');
      return { status: 'no_text', comprobanteId };
    }

    // 3. Validar comprobante
    const validacion = validarComprobante(textoOcr);
    if (!validacion.valido) {
      jobLog.info({ motivo: validacion.motivo }, 'Comprobante no valido');
      await pool.query(
        `UPDATE comprobantes
         SET estado = 'invalido', texto_ocr = $2, notas = $3, updated_at = NOW()
         WHERE id = $1`,
        [comprobanteId, textoOcr, validacion.motivo]
      );
      await cleanupTempFile(filePath);
      return { status: 'invalid', comprobanteId, motivo: validacion.motivo };
    }

    // 4. Extraer cuenta destino y validar
    const destinationAccount = extractDestinationAccount(textoOcr);
    let financieraId = null;
    let financieraNombre = null;

    if (destinationAccount) {
      const destResult = await isValidDestination(destinationAccount, textoOcr);
      if (destResult.valid) {
        financieraId = destResult.financieraId;
        financieraNombre = destResult.financieraNombre;
        jobLog.info({ financieraId, financieraNombre }, 'Cuenta destino validada');
      } else {
        jobLog.warn({ destinationAccount }, 'Cuenta destino no reconocida');
      }
    }

    // 5. Verificar duplicado por hash
    const hash = hashText(textoOcr);
    const dupCheck = await pool.query(
      `SELECT id, order_number FROM comprobantes
       WHERE hash_ocr = $1 AND id != $2
       LIMIT 1`,
      [hash, comprobanteId]
    );

    if (dupCheck.rows.length > 0) {
      const dupRow = dupCheck.rows[0];
      jobLog.warn({ duplicateId: dupRow.id, duplicateOrder: dupRow.order_number }, 'Comprobante duplicado detectado');
      await pool.query(
        `UPDATE comprobantes
         SET estado = 'duplicado', texto_ocr = $2, hash_ocr = $3,
             notas = $4, updated_at = NOW()
         WHERE id = $1`,
        [comprobanteId, textoOcr, hash, `Duplicado de comprobante ${dupRow.id} (pedido ${dupRow.order_number})`]
      );
      await cleanupTempFile(filePath);
      return { status: 'duplicate', comprobanteId, duplicateOf: dupRow.id };
    }

    // 6. Detectar monto desde OCR
    const montoDetectado = detectarMontoDesdeOCR(textoOcr);
    jobLog.info({ montoDetectado, montoTiendanube }, 'Monto detectado');

    // 7. Aplicar marca de agua
    jobLog.debug('Aplicando marca de agua');
    const watermarkedBuffer = await watermarkReceipt(filePath, {
      id: comprobanteId,
      orderNumber
    });

    // 8. Subir archivo con marca de agua a Supabase Storage
    jobLog.debug({ supabasePath }, 'Subiendo a Supabase Storage');
    const { error: uploadError } = await supabase.storage
      .from('comprobantes')
      .upload(supabasePath, watermarkedBuffer, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (uploadError) {
      jobLog.error({ uploadError: uploadError.message }, 'Error subiendo a Supabase');
      throw new Error(`Supabase upload error: ${uploadError.message}`);
    }

    // 9. Actualizar comprobante en DB
    const estado = montoDetectado ? 'procesado' : 'sin_monto';
    await pool.query(
      `UPDATE comprobantes
       SET texto_ocr = $2, hash_ocr = $3, monto = $4,
           estado = $5, financiera_id = $6, updated_at = NOW()
       WHERE id = $1`,
      [comprobanteId, textoOcr, hash, montoDetectado, estado, financieraId]
    );

    // 10. Calcular estado de cuenta
    if (montoDetectado && montoTiendanube) {
      // Obtener total pagado para este pedido
      const pagosResult = await pool.query(
        `SELECT COALESCE(SUM(monto), 0) as total_pagado
         FROM comprobantes
         WHERE order_number = $1 AND estado IN ('procesado', 'aprobado', 'ok')`,
        [orderNumber]
      );
      const totalPagado = parseFloat(pagosResult.rows[0].total_pagado);
      const { estado: estadoCuenta, cuenta } = calcularEstadoCuenta(totalPagado, montoTiendanube);

      jobLog.info({ totalPagado, montoTiendanube, estadoCuenta, cuenta }, 'Estado de cuenta calculado');

      // 11. Actualizar orders_validated si existe
      await pool.query(
        `UPDATE orders_validated
         SET payment_status = $2, balance = $3, updated_at = NOW()
         WHERE order_number = $1`,
        [orderNumber, estadoCuenta, cuenta]
      );

      // 12. Encolar notificacion WhatsApp si hay saldo pendiente
      if (estadoCuenta === 'debe' && customerPhone) {
        try {
          const { whatsappQueue } = require('../lib/queues');
          if (whatsappQueue) {
            await whatsappQueue.add('send-notification', {
              telefono: customerPhone,
              plantilla: 'partial_paid',
              variables: {
                nombre: customerName || 'Cliente',
                pedido: orderNumber,
                saldo: cuenta.toString(),
                moneda: currency || 'ARS'
              },
              orderNumber,
              requestId
            });
            jobLog.info('Notificacion WhatsApp encolada por saldo pendiente');
          }
        } catch (queueErr) {
          jobLog.error({ err: queueErr.message }, 'Error encolando notificacion WhatsApp');
        }
      }
    }

    // 13. Limpiar archivo temporal
    await cleanupTempFile(filePath);

    jobLog.info({ estado, montoDetectado, financieraId }, 'OCR procesado exitosamente');
    return {
      status: 'ok',
      comprobanteId,
      estado,
      montoDetectado,
      financieraId,
      hash
    };

  } catch (err) {
    jobLog.error({ err: err.message, stack: err.stack }, 'Error procesando OCR');
    await markComprobanteError(comprobanteId, `Error OCR: ${err.message}`);
    await cleanupTempFile(filePath);
    throw err; // Re-throw para que BullMQ maneje el retry
  }
}

/**
 * Crea e inicia el OCR worker
 */
function createOcrWorker(connection) {
  const worker = new Worker('ocr', processOcrJob, {
    connection,
    concurrency: 2,
    limiter: {
      max: 10,
      duration: 60000 // max 10 jobs por minuto (rate limit Google Vision)
    }
  });

  worker.on('completed', (job, result) => {
    log.info({
      jobId: job.id,
      comprobanteId: result?.comprobanteId,
      status: result?.status
    }, 'OCR job completado');
  });

  worker.on('failed', (job, err) => {
    log.error({
      jobId: job?.id,
      comprobanteId: job?.data?.comprobanteId,
      err: err.message,
      attemptsMade: job?.attemptsMade
    }, 'OCR job fallido');
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'OCR worker error');
  });

  return worker;
}

module.exports = { createOcrWorker };
