/**
 * Pipeline central de ingreso de remitos.
 *
 * Encapsula la logica que antes vivia inline en el handler `/remitos/upload`:
 *   1. Sanitizar el nombre del archivo.
 *   2. Subir el buffer CRUDO a GCS (sin tocar HEIC).
 *   3. Insertar la fila en `shipping_documents` con status='processing'.
 *   4. Encolar job en BullMQ (`remitosQueue`). El worker hace HEIC convert,
 *      downscale y OCR con Claude Vision en background, asi no bloqueamos
 *      el container web con WASM CPU-intensivo.
 *   5. Loguear el evento.
 *
 * Reusado por dos callers:
 *   - `routes/remitos.js` POST /upload (origen: operador via UI)
 *   - `services/driveIntake.js` (origen: cron polling de Google Drive)
 */

const pool = require('../db');
const { uploadFile } = require('../lib/storage');
const { remitosQueue } = require('../lib/queues');
const { logEvento } = require('../utils/logging');

function sanitizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // Quitar acentos
    .replace(/[^\w\s.-]/g, '')         // Solo alfanumericos, espacios, puntos, guiones
    .replace(/\s+/g, '_');             // Espacios a guiones bajos
}

/**
 * Ingresa un remito al sistema.
 *
 * @param {object} args
 * @param {Buffer} args.buffer        - Contenido del archivo
 * @param {string} args.mimetype      - MIME del archivo original
 * @param {string} args.originalName  - Nombre original (para mostrar/auditar)
 * @param {string|null} [args.uploadedBy=null]      - userId humano (NULL para drive)
 * @param {string|null} [args.uploadedByName=null]  - solo para logEvento
 * @param {'manual'|'drive'} [args.source='manual']
 * @param {string|null} [args.driveFileId=null]
 * @param {string|null} [args.driveFolderId=null]
 *
 * @returns {Promise<{ documentId: number|null, status: 'processing'|'skipped',
 *                     fileUrl: string|null, effectiveName: string,
 *                     skipReason?: 'already_ingested' }>}
 *
 * Para `source='drive'`: si el `driveFileId` ya existe en la DB,
 * el INSERT hace ON CONFLICT DO NOTHING y la funcion devuelve
 * `{ documentId: null, status: 'skipped', skipReason: 'already_ingested' }`
 * sin subir a GCS ni encolar OCR. Esto protege idempotencia entre corridas
 * concurrentes del cron y entre 2 replicas de Cloud Run.
 */
async function ingestRemito({
  buffer,
  mimetype,
  originalName,
  uploadedBy = null,
  uploadedByName = null,
  source = 'manual',
  driveFileId = null,
  driveFolderId = null,
}) {
  // 1. Para drive: chequear UNIQUE antes de subir a GCS, asi no gastamos
  //    Storage si otro cron ya lo agarro. Lo hacemos via INSERT ... ON CONFLICT
  //    DO NOTHING al final, pero un pre-check rapido evita el upload.
  if (source === 'drive' && driveFileId) {
    const existing = await pool.query(
      'SELECT id FROM shipping_documents WHERE source_drive_file_id = $1 LIMIT 1',
      [driveFileId]
    );
    if (existing.rows.length > 0) {
      return {
        documentId: null,
        status: 'skipped',
        fileUrl: null,
        effectiveName: originalName,
        skipReason: 'already_ingested',
      };
    }
  }

  // 2. Sanitizar nombre y subir el buffer CRUDO a GCS. La conversion HEIC
  //    y el downscale los hace el worker para no bloquear el web.
  const safeName = sanitizeName(originalName);
  const storagePath = `remitos/${Date.now()}-${safeName}`;
  const fileUrl = await uploadFile(storagePath, buffer, mimetype);

  // 3. Insertar fila. Para drive usamos ON CONFLICT DO NOTHING como red de
  //    seguridad ante carreras (el pre-check no es atomico).
  let insertRes;
  if (source === 'drive' && driveFileId) {
    insertRes = await pool.query(
      `INSERT INTO shipping_documents
         (file_url, file_name, file_type, status, uploaded_by,
          source, source_drive_file_id, source_drive_folder_id)
       VALUES ($1, $2, $3, 'processing', $4, 'drive', $5, $6)
       ON CONFLICT (source_drive_file_id) DO NOTHING
       RETURNING id`,
      [fileUrl, originalName, mimetype, uploadedBy, driveFileId, driveFolderId]
    );
    if (insertRes.rows.length === 0) {
      // Otro proceso lo inserto entre el pre-check y este INSERT.
      // El archivo ya quedo en GCS (huerfano chico, no rompe nada);
      // no encolamos ni log porque el otro proceso ya lo va a hacer.
      return {
        documentId: null,
        status: 'skipped',
        fileUrl,
        effectiveName: originalName,
        skipReason: 'already_ingested',
      };
    }
  } else {
    // Para manual: NO incluimos `source` en el INSERT a proposito.
    // La migration 078 define `source TEXT NOT NULL DEFAULT 'manual'`,
    // asi que post-migration el INSERT recibe 'manual' por defecto.
    // Pre-migration (deploy adelantado a la migration), el INSERT funciona
    // igual porque la columna no existe — backwards-compatible.
    // El flujo de drive si necesita la migration aplicada para correr,
    // pero queda dormido por env var hasta que se prenda.
    insertRes = await pool.query(
      `INSERT INTO shipping_documents
         (file_url, file_name, file_type, status, uploaded_by)
       VALUES ($1, $2, $3, 'processing', $4)
       RETURNING id`,
      [fileUrl, originalName, mimetype, uploadedBy]
    );
  }

  const documentId = insertRes.rows[0].id;

  // 4. Encolar job de procesamiento (HEIC convert + resize + Claude OCR).
  if (remitosQueue) {
    await remitosQueue.add('process-remito', {
      documentId,
      storagePath,
      originalName,
      mimetype,
    });
  } else {
    console.error('❌ Queue de remitos no disponible — documento queda en processing sin worker');
  }

  // 5. Loguear evento.
  logEvento({
    orderNumber: null,
    accion: 'remito_subido',
    origen: source === 'drive' ? 'drive_intake' : 'operador',
    userId: uploadedBy,
    username: uploadedByName,
  });

  return {
    documentId,
    status: 'processing',
    fileUrl,
    effectiveName: originalName,
  };
}

module.exports = { ingestRemito };
