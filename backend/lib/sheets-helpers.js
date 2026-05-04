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

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB_NAME}!A${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[orderStr]] },
    });

    log.info({ orderNumber: orderStr, row: targetRow }, 'sheets: pedido agregado al tracking de a_imprimir');
    return { appended: true, row: targetRow };
  } catch (err) {
    log.error({ err: err.message, orderNumber: orderStr }, 'sheets: push falló');
    return { appended: false, reason: 'api_error' };
  }
}

module.exports = { pushOrderToImprimir };
