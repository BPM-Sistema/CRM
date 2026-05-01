#!/usr/bin/env node
/**
 * Backfill tracking_number en shipping_documents existentes.
 *
 * Aplica el regex extractTrackingNumber() sobre `ocr_text` para todos los
 * documentos donde tracking_number es NULL. Idempotente: corre cuantas veces
 * quieras y no toca registros que ya tengan valor.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('../db');
const { extractTrackingNumber } = require('../services/shippingDocuments');

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`🔄 Backfill tracking_number ${dryRun ? '(DRY RUN)' : '(APLICANDO)'}`);

  const res = await pool.query(`
    SELECT id, ocr_text
    FROM shipping_documents
    WHERE tracking_number IS NULL
      AND ocr_text IS NOT NULL
      AND length(ocr_text) > 50
  `);

  console.log(`📋 Documentos a revisar: ${res.rowCount}`);

  let found = 0;
  let updated = 0;

  for (const row of res.rows) {
    const tn = extractTrackingNumber(row.ocr_text);
    if (!tn) continue;
    found++;

    if (!dryRun) {
      await pool.query(
        `UPDATE shipping_documents SET tracking_number = $1, updated_at = NOW()
         WHERE id = $2 AND tracking_number IS NULL`,
        [tn, row.id]
      );
      updated++;
    }
  }

  console.log(`✅ Detectados con tracking: ${found}`);
  console.log(`✅ Actualizados:           ${updated}`);
  await pool.end();
})().catch(err => { console.error('❌', err); process.exit(1); });
