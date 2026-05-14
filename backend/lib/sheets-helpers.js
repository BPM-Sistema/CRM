/**
 * Google Sheets integration: tracking de pedidos en "a_imprimir".
 *
 * Cuando un pedido pasa a estado a_imprimir, se agrega su número a una hoja
 * de Google Sheets para que el operador tilde un checkbox a medida que
 * imprime las etiquetas. Es one-way: el sistema escribe, los humanos tildan.
 *
 * Configuración (env vars):
 *   - SHEETS_SPREADSHEET_ID    → ID del spreadsheet
 *   - GOOGLE_SHEETS_SA_KEY     → JSON de la service account (Editor en el sheet)
 *   - SHEETS_TAB_NAME          → opcional, default "Pedidos"
 *
 * Si falta cualquiera de las dos primeras, la integración queda en no-op
 * y nunca rompe el flujo principal (fire-and-forget).
 */

const { google } = require('googleapis');
const { integrationLogger: log } = require('./logger');

const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Pedidos';

let _sheetsClient = null;
let _clientInitFailed = false;

function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
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
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    _sheetsClient = google.sheets({ version: 'v4', auth });
    return _sheetsClient;
  } catch (err) {
    _clientInitFailed = true;
    log.error({ err: err.message }, 'sheets: GOOGLE_SHEETS_SA_KEY no es JSON válido');
    return null;
  }
}

/**
 * Agrega un número de pedido al sheet (idempotente).
 * Nunca tira excepción: en caso de error, solo loguea.
 *
 * @param {string|number} orderNumber
 * @returns {Promise<{appended:boolean, reason?:string}>}
 */
async function pushOrderToImprimir(orderNumber) {
  if (!orderNumber && orderNumber !== 0) {
    return { appended: false, reason: 'no_order' };
  }
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return { appended: false, reason: 'no_spreadsheet_id' };
  }
  const sheets = getSheetsClient();
  if (!sheets) {
    return { appended: false, reason: 'no_credentials' };
  }

  const orderStr = String(orderNumber);

  try {
    // Leemos columna A y buscamos la primera fila vacía (después del header).
    // No usamos values.append porque su detección de "fin de tabla" mira las dos
    // columnas: si la columna B tiene checkbox/FALSE residual, salta filas
    // donde A está vacía. Acá nos guiamos sólo por A y nunca tocamos B.
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TAB_NAME}!A:A`,
    });
    const rows = existing.data.values || [];

    // Idempotencia
    const already = rows.some(r => r && String(r[0]).trim() === orderStr);
    if (already) {
      return { appended: false, reason: 'already_in_sheet' };
    }

    // Primera fila (1-indexada) donde A está vacía, después del header (fila 1).
    // values.get no devuelve filas trailing vacías, así que si no hay gaps,
    // la próxima fila libre es rows.length + 1.
    let targetRow = -1;
    for (let i = 1; i < rows.length; i++) {
      const cell = rows[i]?.[0];
      if (cell === undefined || cell === null || String(cell).trim() === '') {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow === -1) targetRow = Math.max(rows.length, 1) + 1;

    // Escribimos también `false` en col B para resetear cualquier check que
    // hubiera quedado tildado por error en una fila vacía: cuando esa fila
    // se ocupe con un pedido, el check arranca destildado.
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_NAME}!A${targetRow}:B${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[orderStr, false]] },
    });

    log.info({ orderNumber: orderStr, row: targetRow }, 'sheets: pedido agregado al tracking de a_imprimir');
    return { appended: true, row: targetRow };
  } catch (err) {
    log.error({ err: err.message, orderNumber: orderStr }, 'sheets: push falló');
    return { appended: false, reason: 'api_error' };
  }
}

/**
 * Encola un push al sheet en `pending_sheet_pushes`. Idempotente: si ya hay
 * un row pendiente para el mismo order_number, no inserta.
 *
 * Recibe un cliente de pg (transacción o pool). Es awaiteado por los callers
 * dentro de sus transacciones — si la transacción rolea, el INSERT también.
 *
 * Reemplazó al `setImmediate(pushOrderToImprimir)` original, que tenía un
 * problema en Cloud Run con cpu-throttling: las promises HTTP a Sheets que
 * arrancaban via setImmediate podían quedar a medias cuando el endpoint
 * respondía y el contenedor se congelaba (sobre todo en batch).
 */
async function enqueueSheetPush(clientOrPool, orderNumber) {
  if (orderNumber === undefined || orderNumber === null) return;
  await clientOrPool.query(
    `INSERT INTO pending_sheet_pushes (order_number)
     VALUES ($1)
     ON CONFLICT (order_number) WHERE processed_at IS NULL DO NOTHING`,
    [String(orderNumber)]
  );
}

/**
 * Marca como impresos (col B = TRUE) los pedidos pasados, en el sheet.
 * Usado por el script one-shot de backfill — el flujo normal no debería
 * tocar col B (los humanos tildan manualmente cuando imprimen).
 *
 * Estrategia: leer A:B una sola vez, armar mapa orderNumber → row,
 * después batchUpdate de los rows correspondientes en una sola call.
 * Total: 2 API calls (1 read + 1 batch write). Bajo rate limit.
 *
 * @param {string[]} orderNumbers
 * @returns {Promise<{marked:string[], notFound:string[], alreadyTrue:string[]}>}
 */
async function markOrdersAsPrinted(orderNumbers) {
  if (!Array.isArray(orderNumbers) || orderNumbers.length === 0) {
    return { marked: [], notFound: [], alreadyTrue: [] };
  }
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SHEETS_SPREADSHEET_ID no seteado');
  const sheets = getSheetsClient();
  if (!sheets) throw new Error('GOOGLE_SHEETS_SA_KEY no seteado o inválido');

  // Leer A y B juntas para tener la fila y el estado actual del checkbox.
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB_NAME}!A:B`,
  });
  const rows = existing.data.values || [];

  // Mapa orderNumber → 1-indexed row.
  const indexByOrder = new Map();
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i]?.[0];
    if (cell === undefined || cell === null) continue;
    const key = String(cell).trim();
    if (key !== '' && !indexByOrder.has(key)) {
      indexByOrder.set(key, i + 1);
    }
  }

  const marked = [];
  const notFound = [];
  const alreadyTrue = [];
  const dataUpdates = [];

  for (const raw of orderNumbers) {
    const key = String(raw).trim();
    const row = indexByOrder.get(key);
    if (!row) { notFound.push(key); continue; }
    const currentB = rows[row - 1]?.[1];
    // Sheets devuelve TRUE/FALSE como strings cuando la celda es boolean.
    if (currentB === true || String(currentB).toUpperCase() === 'TRUE') {
      alreadyTrue.push(key);
      continue;
    }
    dataUpdates.push({
      range: `${TAB_NAME}!B${row}`,
      values: [[true]],
    });
    marked.push(key);
  }

  if (dataUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: dataUpdates,
      },
    });
  }

  return { marked, notFound, alreadyTrue };
}

/**
 * Lee un rango simple (ej. "Pedidos!C2521:C2608") y devuelve la lista plana
 * de valores no vacíos. Usado por el script de "marcar impresos" para leer
 * la lista manual del operario.
 */
async function readColumnRange(range) {
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SHEETS_SPREADSHEET_ID no seteado');
  const sheets = getSheetsClient();
  if (!sheets) throw new Error('GOOGLE_SHEETS_SA_KEY no seteado o inválido');

  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = r.data.values || [];
  return rows
    .map(row => (row && row[0] !== undefined && row[0] !== null) ? String(row[0]).trim() : '')
    .filter(s => s !== '');
}

module.exports = {
  pushOrderToImprimir,
  enqueueSheetPush,
  markOrdersAsPrinted,
  readColumnRange,
};
