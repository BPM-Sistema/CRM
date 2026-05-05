/**
 * Drive intake: cron que ingresa remitos automaticamente desde Google Drive.
 *
 * Flujo:
 *   1. Listar subcarpetas de la carpeta padre `DRIVE_REMITOS_PARENT_FOLDER_ID`.
 *   2. Para cada subcarpeta, listar archivos cuyo MIME este en la whitelist
 *      (filtrado a nivel API para no bajar archivos no soportados).
 *   3. Para cada archivo: bajar buffer, llamar a `ingestRemito({ source: 'drive' })`,
 *      y al exito renombrarlo en Drive agregando "_leido" antes de la extension.
 *
 * Idempotencia:
 *   - El UNIQUE parcial sobre `shipping_documents.source_drive_file_id` mas el
 *     pre-check + ON CONFLICT DO NOTHING en `ingestRemito` evitan duplicados
 *     incluso bajo concurrencia (2 corridas del cron, 2 replicas de Cloud Run).
 *   - `_leido` en el nombre es idempotente: si ya termina asi, no se renombra.
 *
 * Auth:
 *   - Reusa `GOOGLE_SHEETS_SA_KEY` (misma SA que la integracion de Sheets) con
 *     scope `drive` (full, porque renombramos). El operador debe compartir la
 *     carpeta padre con el `client_email` de esa SA dandole permisos de Editor.
 *
 * Configuracion (env vars):
 *   - `DRIVE_REMITOS_PARENT_FOLDER_ID`  - ID de la carpeta padre (ej. "BLANQ X VIA CARGO")
 *   - `GOOGLE_SHEETS_SA_KEY`            - JSON de la service account (ya existente)
 *
 * Si falta cualquiera de las dos, `runDriveIntake()` queda no-op silencioso.
 */

const path = require('path');
const { google } = require('googleapis');
const { ingestRemito } = require('./remitoIngest');

const ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'application/pdf',
];

let _driveClient = null;
let _clientInitFailed = false;

function getDriveClient() {
  if (_driveClient) return _driveClient;
  if (_clientInitFailed) return null;
  const keyJson = process.env.GOOGLE_SHEETS_SA_KEY;
  if (!keyJson) {
    _clientInitFailed = true;
    return null;
  }
  try {
    const credentials = JSON.parse(keyJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    _driveClient = google.drive({ version: 'v3', auth });
    return _driveClient;
  } catch (err) {
    _clientInitFailed = true;
    console.error('[driveIntake] GOOGLE_SHEETS_SA_KEY no es JSON valido:', err.message);
    return null;
  }
}

async function listSubfolders(parentId, drive) {
  const folders = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
    });
    folders.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return folders;
}

async function listSupportedFiles(folderId, drive) {
  const mimeQuery = ALLOWED_MIMES.map(m => `mimeType = '${m}'`).join(' or ');
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and (${mimeQuery})`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Lista TODOS los archivos no-trashed de una carpeta (sin filtro por mime),
 * usado para chequear si todos los archivos ya estan marcados como leidos.
 * Excluye subcarpetas (solo archivos).
 */
async function listAllFiles(folderId, drive) {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function downloadFile(fileId, drive) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

/**
 * Construye el nombre con "_leido" insertado antes de la extension.
 * Idempotente: devuelve null si ya esta marcado.
 *
 *   "remito.pdf"        -> "remito_leido.pdf"
 *   "foto.iphone.heic"  -> "foto.iphone_leido.heic"  (solo ultima extension)
 *   "sin_extension"     -> "sin_extension_leido"
 *   "remito_leido.pdf"  -> null
 */
function withLeidoMarker(name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  if (base.endsWith('_leido')) return null;
  return `${base}_leido${ext}`;
}

async function renameAsRead(fileId, currentName, drive) {
  const newName = withLeidoMarker(currentName);
  if (!newName) return { renamed: false, reason: 'already_marked' };
  await drive.files.update({
    fileId,
    requestBody: { name: newName },
  });
  return { renamed: true, newName };
}

/**
 * Corrida principal del cron. No tira excepciones: cada error por archivo
 * queda en `errors[]` y la corrida sigue. El endpoint del cron decide si
 * devuelve 200 o 500 segun le convenga (tipicamente 200 para que Cloud
 * Scheduler no reintente innecesariamente).
 */
async function runDriveIntake() {
  const parentId = process.env.DRIVE_REMITOS_PARENT_FOLDER_ID;
  if (!parentId) {
    return { ok: false, reason: 'no_parent_folder_id', scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  }
  const drive = getDriveClient();
  if (!drive) {
    return { ok: false, reason: 'no_drive_client', scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  }

  const stats = { scanned: 0, ingested: 0, skipped: 0, errors: 0, errorDetails: [] };

  let subfolders;
  try {
    subfolders = await listSubfolders(parentId, drive);
  } catch (err) {
    console.error('[driveIntake] error listando subcarpetas:', err.message);
    return { ok: false, reason: 'list_subfolders_failed', error: err.message, ...stats };
  }

  for (const folder of subfolders) {
    // El sufijo "_leido" en carpetas es puramente visual: no excluye el
    // escaneo. Igual procesamos archivos nuevos, pero la idempotencia por
    // `source_drive_file_id` UNIQUE evita reprocesar los que ya estan.
    let files;
    try {
      files = await listSupportedFiles(folder.id, drive);
    } catch (err) {
      console.error(`[driveIntake] error listando archivos de ${folder.name}:`, err.message);
      stats.errors++;
      stats.errorDetails.push({ folder: folder.name, error: err.message });
      continue;
    }

    for (const file of files) {
      stats.scanned++;
      try {
        const buffer = await downloadFile(file.id, drive);
        const result = await ingestRemito({
          buffer,
          mimetype: file.mimeType,
          originalName: file.name,
          uploadedBy: null,
          source: 'drive',
          driveFileId: file.id,
          driveFolderId: folder.id,
        });

        if (result.status === 'skipped') {
          stats.skipped++;
          continue;
        }

        stats.ingested++;

        // Rename: si falla, no es critico — el ingest ya esta hecho y el
        // UNIQUE evita reprocesar. Solo logueamos.
        try {
          await renameAsRead(file.id, file.name, drive);
        } catch (renameErr) {
          console.warn(`[driveIntake] no se pudo renombrar ${file.name}:`, renameErr.message);
        }
      } catch (err) {
        console.error(`[driveIntake] error procesando ${file.name}:`, err.message);
        stats.errors++;
        stats.errorDetails.push({ file: file.name, error: err.message });
      }
    }

    // Auto-marcar la carpeta como leida si TODOS sus archivos terminan en
    // "_leido" (y la carpeta no esta ya marcada). Listamos todos los archivos
    // (sin filtro de mime) para que un .docx sin _leido bloquee el rename —
    // asi el operador se da cuenta que hay algo no procesado adentro.
    if (!folder.name.endsWith('_leido')) {
      try {
        const allFiles = await listAllFiles(folder.id, drive);
        if (allFiles.length > 0 && allFiles.every(f => f.name.endsWith('_leido'))) {
          await drive.files.update({
            fileId: folder.id,
            requestBody: { name: `${folder.name}_leido` },
          });
          stats.foldersMarked = (stats.foldersMarked || 0) + 1;
          console.log(`📂 Carpeta marcada como leida: ${folder.name} → ${folder.name}_leido`);
        }
      } catch (err) {
        console.warn(`[driveIntake] no se pudo evaluar/marcar carpeta ${folder.name}:`, err.message);
      }
    }
  }

  return { ok: true, foldersScanned: subfolders.length, ...stats };
}

module.exports = {
  runDriveIntake,
  // Exportados solo para tests:
  withLeidoMarker,
};
