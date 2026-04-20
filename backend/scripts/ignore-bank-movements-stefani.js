/**
 * ignore-bank-movements-stefani.js
 *
 * 1. Aplica migración 058 (bank_movements_ignored) si no existe
 * 2. Inserta los dos movement_uid de Stefani en la blocklist
 * 3. Borra los registros existentes en bank_movements
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const pool = require('../db');

const IGNORED = [
  { movement_uid: '11479102', reason: 'Transferencia de Stefani Francisca Casañas (35163.61) - no es cliente' },
  { movement_uid: '11479690', reason: 'Transferencia de Stefani Francisca Casañas (15000.00) - no es cliente' },
];

async function main() {
  const client = await pool.connect();
  try {
    console.log('=== Ignore Bank Movements (Stefani) ===\n');

    console.log('1. Aplicando migración 058...');
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '058_bank_movements_ignored.sql'),
      'utf8'
    );
    await client.query(sql);
    console.log('   ✓ Tabla bank_movements_ignored lista\n');

    console.log('2. Insertando blocklist...');
    for (const item of IGNORED) {
      await client.query(
        `INSERT INTO bank_movements_ignored (movement_uid, reason)
         VALUES ($1, $2)
         ON CONFLICT (movement_uid) DO UPDATE SET reason = EXCLUDED.reason`,
        [item.movement_uid, item.reason]
      );
      console.log(`   ✓ ${item.movement_uid} — ${item.reason}`);
    }
    console.log('');

    console.log('3. Borrando de bank_movements...');
    const uids = IGNORED.map(i => i.movement_uid);
    const existing = await client.query(
      `SELECT id, movement_uid, amount, posted_at, sender_name, assignment_status
       FROM bank_movements
       WHERE movement_uid = ANY($1)`,
      [uids]
    );
    if (existing.rows.length === 0) {
      console.log('   (no había registros — OK, la blocklist los va a filtrar)\n');
    } else {
      for (const r of existing.rows) {
        console.log(`   - id=${r.id} uid=${r.movement_uid} amount=${r.amount} status=${r.assignment_status}`);
      }
      const del = await client.query(
        `DELETE FROM bank_movements WHERE movement_uid = ANY($1) RETURNING id`,
        [uids]
      );
      console.log(`   ✓ Eliminados: ${del.rows.length}\n`);
    }

    console.log('4. Verificación...');
    const check = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM bank_movements WHERE movement_uid = ANY($1)`,
      [uids]
    );
    const blockCount = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM bank_movements_ignored`
    );
    console.log(`   bank_movements con esos UIDs: ${check.rows[0].cnt} (debería ser 0)`);
    console.log(`   bank_movements_ignored total: ${blockCount.rows[0].cnt}`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
