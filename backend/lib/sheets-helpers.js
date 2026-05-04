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
    // Idempotencia: leer columna A y chequear si el pedido ya está
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TAB_NAME}!A:A`,
    });
    const rows = existing.data.values || [];
    const already = rows.some(r => r && String(r[0]).trim() === orderStr);
    if (already) {
      return { appended: false, reason: 'already_in_sheet' };
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB_NAME}!A:B`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[orderStr, false]] },
    });

    log.info({ orderNumber: orderStr }, 'sheets: pedido agregado al tracking de a_imprimir');
    return { appended: true };
  } catch (err) {
    log.error({ err: err.message, orderNumber: orderStr }, 'sheets: push falló');
    return { appended: false, reason: 'api_error' };
  }
}

module.exports = { pushOrderToImprimir };
