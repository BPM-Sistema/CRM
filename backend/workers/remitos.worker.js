/**
 * Remitos Worker
 *
 * Procesamiento async de remitos subidos. Refactor de `processOCRAsync` que
 * antes corría inline en el handler /remitos/upload bloqueando el event loop
 * del backend (heic-convert es WASM CPU-intensivo).
 *
 * Pipeline:
 *   1. Descargar archivo de GCS (subido crudo por el handler)
 *   2. Si es HEIC → convertir a JPEG con heic-convert (WASM)
 *   3. Resize a max 2000px + JPEG q85 con sharp (Claude Vision rechaza > 5MB)
 *   4. analizarRemito() → Claude Vision OCR
 *   5. processDocumentWithClaude() → match con pedido + update DB
 *
 * Cola: remitos
 */

const { Worker } = require('bullmq');
const heicConvert = require('heic-convert');
const sharp = require('sharp');
const pool = require('../db');
const { workerLogger: log } = require('../lib/logger');
const { downloadFile, uploadFile } = require('../lib/storage');
const { analizarRemito } = require('../services/claudeVision');
const { processDocumentWithClaude } = require('../services/shippingDocuments');

async function processRemitoJob(job) {
  const { documentId, storagePath, originalName, mimetype } = job.data;

  const jobLog = log.child({ jobId: job.id, documentId, storagePath });
  jobLog.info({ originalName, mimetype }, 'Procesando remito');

  // 1. Descargar archivo de GCS
  let fileBuffer = await downloadFile(storagePath);
  let effectiveMime = mimetype;

  // 2. HEIC → JPEG (heic-convert es WASM puro, funciona en cualquier plataforma)
  const isHeicByExt = /\.(heic|heif)$/i.test(originalName);
  const isHeicByMime = mimetype === 'image/heic' || mimetype === 'image/heif';
  if (isHeicByMime || isHeicByExt) {
    fileBuffer = await heicConvert({ buffer: fileBuffer, format: 'JPEG', quality: 0.9 });
    effectiveMime = 'image/jpeg';
    jobLog.info({ size: fileBuffer.length }, 'HEIC convertido a JPEG');
  }

  // 3. Downscale a 2000px + JPEG q85 — Claude Vision rechaza > 5MB.
  if (effectiveMime === 'image/jpeg' || effectiveMime === 'image/png') {
    try {
      const before = fileBuffer.length;
      fileBuffer = await sharp(fileBuffer)
        .rotate() // respeta EXIF orientation
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      effectiveMime = 'image/jpeg';
      if (fileBuffer.length < before) {
        jobLog.info({ before, after: fileBuffer.length }, 'Imagen downscaled');
      }
    } catch (err) {
      jobLog.warn({ err: err.message }, 'sharp downscale falló, uso buffer original');
    }
  }

  // 3.5. Si convertimos HEIC, subir la versión JPEG procesada a GCS para que
  // las cards del frontend muestren la imagen (los browsers no muestran HEIC).
  if (isHeicByMime || isHeicByExt) {
    try {
      const jpegPath = storagePath.replace(/\.(heic|heif)$/i, '.jpg');
      const jpegUrl = await uploadFile(jpegPath, fileBuffer, 'image/jpeg');
      await pool.query(
        `UPDATE shipping_documents
         SET file_url = $1, file_type = 'image/jpeg',
             file_name = REGEXP_REPLACE(file_name, '\\.(heic|heif)$', '.jpg', 'i')
         WHERE id = $2`,
        [jpegUrl, documentId]
      );
      jobLog.info({ jpegPath }, 'JPEG procesado guardado en GCS, file_url actualizado');
    } catch (uploadErr) {
      jobLog.warn({ err: uploadErr.message }, 'Error subiendo JPEG procesado, sigue OCR igual');
    }
  }

  // 4. OCR con Claude Vision
  const claudeData = await analizarRemito(fileBuffer, effectiveMime);

  if (!claudeData.es_remito) {
    jobLog.info('No es un remito, marcando como ready sin match');
    await pool.query(
      `UPDATE shipping_documents
       SET status = 'ready', ocr_processed_at = NOW(),
           ocr_text = $1, match_details = '{"noMatchReason": "not_a_remito"}',
           updated_at = NOW()
       WHERE id = $2`,
      [claudeData.texto_completo || '', documentId]
    );
    return { status: 'ready', match: 'not_a_remito' };
  }

  // 5. Match con pedido + update DB (esta función ya hace todo el flujo)
  await processDocumentWithClaude(documentId, claudeData);
  return { status: 'processed' };
}

function createRemitosWorker(connection) {
  const worker = new Worker('remitos', processRemitoJob, {
    connection,
    // Concurrencia: cada job consume RAM (heic-convert decodifica imagen
    // a buffer raw RGB ~30MB). Con 1 GiB de container, 2 jobs en paralelo
    // dejan margen suficiente.
    concurrency: 2,
    // heic-convert + sharp + Claude Vision puede tardar fácil 10-30s.
    // Lock duration largo evita que el job sea reintentado por timeout.
    lockDuration: 120000,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 }
    }
  });

  worker.on('completed', (job, result) => {
    log.info({
      jobId: job.id,
      documentId: job.data?.documentId,
      status: result?.status
    }, 'Remito job completado');
  });

  worker.on('failed', async (job, err) => {
    const { documentId } = job?.data || {};
    const isFinalAttempt = job?.attemptsMade >= (job?.opts?.attempts || 2);

    log.error({
      jobId: job?.id,
      documentId,
      err: err.message,
      attemptsMade: job?.attemptsMade,
      isFinalAttempt
    }, 'Remito job fallido');

    // Solo persistir como error en DB cuando se agotaron los reintentos.
    if (isFinalAttempt && documentId) {
      try {
        await pool.query(
          `UPDATE shipping_documents
           SET status = 'error', error_message = $1, updated_at = NOW()
           WHERE id = $2`,
          [`Worker Error: ${err.message}`, documentId]
        );
      } catch (dbErr) {
        log.error({ err: dbErr.message }, 'Error persistiendo fallo de remito');
      }
    }
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'Remitos worker error');
  });

  return worker;
}

module.exports = { createRemitosWorker };
