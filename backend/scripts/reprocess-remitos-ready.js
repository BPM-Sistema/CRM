#!/usr/bin/env node
/**
 * Reprocesa remitos en estado 'ready' aplicando la nueva lógica de match
 * por número manuscrito (claudeData.numero_pedido) antes del fuzzy.
 *
 * Uso:
 *   node scripts/reprocess-remitos-ready.js              # todos los ready
 *   node scripts/reprocess-remitos-ready.js 679 680      # IDs específicos
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const pool = require('../db');
const { analizarRemito } = require('../services/claudeVision');
const { processDocumentWithClaude } = require('../services/shippingDocuments');

async function main() {
  const argIds = process.argv.slice(2).filter(a => /^\d+$/.test(a));

  let rows;
  if (argIds.length > 0) {
    const res = await pool.query(
      `SELECT id, file_url, file_type, file_name, suggested_order_number, detected_name
       FROM shipping_documents
       WHERE id = ANY($1::int[])`,
      [argIds.map(Number)]
    );
    rows = res.rows;
  } else {
    const res = await pool.query(
      `SELECT id, file_url, file_type, file_name, suggested_order_number, detected_name
       FROM shipping_documents
       WHERE status = 'ready' AND confirmed_order_number IS NULL
       ORDER BY created_at DESC`
    );
    rows = res.rows;
  }

  console.log(`📋 Remitos a reprocesar: ${rows.length}`);

  for (const r of rows) {
    console.log(`\n--- Remito #${r.id} (${r.file_name}) ---`);
    console.log(`   sugerido actual: #${r.suggested_order_number || '(ninguno)'} (${r.detected_name || ''})`);

    try {
      const resp = await axios.get(r.file_url, { responseType: 'arraybuffer', timeout: 30000 });
      const buffer = Buffer.from(resp.data);

      const claudeData = await analizarRemito(buffer, r.file_type || 'image/jpeg');
      console.log(`   numero_pedido (manuscrito): ${claudeData.numero_pedido || '(ninguno)'}`);
      console.log(`   destinatario: ${claudeData.destinatario?.nombre || '(ninguno)'}`);

      if (!claudeData.es_remito) {
        console.log(`   ⚠️ Claude reporta que no es un remito, salteando`);
        continue;
      }

      await processDocumentWithClaude(r.id, claudeData);
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
    }
  }

  console.log('\n✅ Listo');
  await pool.end();
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
