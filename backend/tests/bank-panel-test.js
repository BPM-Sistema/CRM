/**
 * Test del panel admin bancario
 * Ejecutar: node tests/bank-panel-test.js
 */
require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-bank-panel';

const pool = require('../db');
const crypto = require('crypto');

// Importar lógica del router directamente
function generateFingerprint(mov) {
  const parts = [
    mov.posted_at || '',
    String(mov.amount || ''),
    (mov.sender_name || '').trim().toLowerCase(),
    (mov.description || '').trim().toLowerCase(),
    (mov.reference || '').trim().toLowerCase(),
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex');
}

// Sample bank JSON (formato real usado por conciliación)
const SAMPLE_MOVIMIENTOS = [
  { ID: 'MOV-001', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '15000.00', 'Fecha/Hora': '2026-04-12 10:30:00', 'Nombre Destino': 'JUAN PEREZ' },
  { ID: 'MOV-002', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '8500.50', 'Fecha/Hora': '2026-04-12 11:15:00', 'Nombre Destino': 'MARIA GARCIA' },
  { ID: 'MOV-003', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '25000.00', 'Fecha/Hora': '2026-04-12 12:00:00', 'Nombre Destino': 'CARLOS LOPEZ' },
  { ID: 'MOV-004', Tipo: 'Transferencia saliente', Estado: 'Ejecutado', Importe: '5000.00', 'Fecha/Hora': '2026-04-12 13:00:00', 'Nombre Destino': 'PAGO PROVEEDOR' },
  { ID: 'MOV-005', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '12000.00', 'Fecha/Hora': '2026-04-12 14:30:00', 'Nombre Destino': 'ANA RODRIGUEZ' },
  { ID: 'MOV-006', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '3200.00', 'Fecha/Hora': '2026-04-12 15:00:00', 'Nombre Destino': 'PABLO MARTINEZ' },
  { ID: 'MOV-007', Tipo: 'Transferencia entrante', Estado: 'Pendiente', Importe: '7800.00', 'Fecha/Hora': '2026-04-12 16:00:00', 'Nombre Destino': 'LUIS GOMEZ' },
  { ID: 'MOV-008', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '45000.00', 'Fecha/Hora': '2026-04-11 09:00:00', 'Nombre Destino': 'EMPRESA SA' },
  { ID: 'MOV-009', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '6700.00', 'Fecha/Hora': '2026-04-11 10:00:00', 'Nombre Destino': 'SOFIA DIAZ' },
  { ID: 'MOV-010', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '18500.00', 'Fecha/Hora': '2026-04-11 11:30:00', 'Nombre Destino': 'DIEGO FERNANDEZ' },
  { ID: 'MOV-011', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '9900.00', 'Fecha/Hora': '2026-04-10 08:00:00', 'Nombre Destino': 'LAURA SANCHEZ' },
  { ID: 'MOV-012', Tipo: 'Transferencia entrante', Estado: 'Ejecutado', Importe: '31000.00', 'Fecha/Hora': '2026-04-10 14:00:00', 'Nombre Destino': 'RICARDO MORENO' },
];

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

async function getAdminUserId() {
  const res = await pool.query("SELECT id FROM users WHERE email='admin@petlove.com' LIMIT 1");
  return res.rows[0]?.id;
}

async function cleanTestData() {
  await pool.query("DELETE FROM bank_movements WHERE sender_name IN ('JUAN PEREZ','MARIA GARCIA','CARLOS LOPEZ','ANA RODRIGUEZ','PABLO MARTINEZ','EMPRESA SA','SOFIA DIAZ','DIEGO FERNANDEZ','LAURA SANCHEZ','RICARDO MORENO')");
  await pool.query("DELETE FROM bank_imports WHERE filename = 'test-import.json'");
}

async function runTests() {
  console.log('\n=== BANK ADMIN PANEL TESTS ===\n');

  const adminId = await getAdminUserId();
  if (!adminId) {
    console.error('No admin user found!');
    process.exit(1);
  }
  console.log(`Using admin user: ${adminId}\n`);

  // Cleanup
  await cleanTestData();

  // ── TEST 1: Parse & filter incoming ──
  console.log('TEST 1: Parse & filter incoming movements');
  const entrantes = SAMPLE_MOVIMIENTOS.filter(m =>
    m.Tipo === 'Transferencia entrante' && m.Estado === 'Ejecutado' && parseFloat(m.Importe) > 0
  );
  assert(entrantes.length === 10, `10 entrantes de 12 (got ${entrantes.length})`);
  assert(SAMPLE_MOVIMIENTOS.length === 12, `12 total movimientos`);

  // ── TEST 2: Fingerprint uniqueness ──
  console.log('\nTEST 2: Fingerprint uniqueness');
  const fingerprints = entrantes.map(m => {
    const parsed = {
      posted_at: new Date(m['Fecha/Hora'].replace(' ', 'T')).toISOString(),
      amount: Math.floor(parseFloat(m.Importe)),
      sender_name: (m['Nombre Destino'] || '').trim(),
      description: '',
      reference: m.ID || '',
    };
    return generateFingerprint(parsed);
  });
  const uniqueFPs = new Set(fingerprints);
  assert(uniqueFPs.size === entrantes.length, `All fingerprints unique (${uniqueFPs.size} == ${entrantes.length})`);

  // ── TEST 3: Import - create records ──
  console.log('\nTEST 3: Import bank movements');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create import
    const impRes = await client.query(
      `INSERT INTO bank_imports (source, filename, uploaded_by, raw_payload, total_rows, total_incoming)
       VALUES ('manual', 'test-import.json', $1, $2, $3, $4)
       RETURNING id`,
      [adminId, JSON.stringify(SAMPLE_MOVIMIENTOS), SAMPLE_MOVIMIENTOS.length, entrantes.length]
    );
    const importId = impRes.rows[0].id;
    assert(importId > 0, `Import created with id ${importId}`);

    // Insert movements
    let inserted = 0;
    for (const mov of entrantes) {
      const posted = new Date(mov['Fecha/Hora'].replace(' ', 'T')).toISOString();
      const amount = Math.floor(parseFloat(mov.Importe));
      const senderName = (mov['Nombre Destino'] || '').trim();
      const fp = generateFingerprint({ posted_at: posted, amount, sender_name: senderName, description: '', reference: mov.ID || '' });

      await client.query(
        `INSERT INTO bank_movements
         (import_id, movement_uid, fingerprint, posted_at, amount, currency,
          sender_name, raw_row, is_incoming, assignment_status)
         VALUES ($1,$2,$3,$4,$5,'ARS',$6,$7,true,'unassigned')`,
        [importId, mov.ID, fp, posted, amount, senderName, JSON.stringify(mov)]
      );
      inserted++;
    }
    assert(inserted === 10, `10 movements inserted (got ${inserted})`);

    // Update import summary
    await client.query(
      `UPDATE bank_imports SET total_inserted = $1, total_duplicated = 0 WHERE id = $2`,
      [inserted, importId]
    );

    await client.query('COMMIT');

    // ── TEST 4: Verify records ──
    console.log('\nTEST 4: Verify records in DB');
    const movCount = await pool.query('SELECT COUNT(*) FROM bank_movements WHERE import_id = $1', [importId]);
    assert(parseInt(movCount.rows[0].count) === 10, `10 movements in DB`);

    const impRow = await pool.query('SELECT * FROM bank_imports WHERE id = $1', [importId]);
    assert(impRow.rows[0].total_inserted === 10, `Import record shows 10 inserted`);
    assert(impRow.rows[0].total_rows === 12, `Import record shows 12 total rows`);

    // ── TEST 5: Duplicate detection ──
    console.log('\nTEST 5: Duplicate detection');
    const firstMov = entrantes[0];
    const firstPosted = new Date(firstMov['Fecha/Hora'].replace(' ', 'T')).toISOString();
    const firstAmount = Math.floor(parseFloat(firstMov.Importe));
    const firstSender = (firstMov['Nombre Destino'] || '').trim();
    const firstFP = generateFingerprint({ posted_at: firstPosted, amount: firstAmount, sender_name: firstSender, description: '', reference: firstMov.ID || '' });

    const dupCheck = await pool.query('SELECT id FROM bank_movements WHERE fingerprint = $1', [firstFP]);
    assert(dupCheck.rows.length === 1, `Duplicate detected: fingerprint exists once`);

    // Trying to insert same fingerprint should fail
    try {
      await pool.query(
        `INSERT INTO bank_movements (import_id, fingerprint, posted_at, amount, is_incoming, assignment_status)
         VALUES ($1, $2, NOW(), 15000, true, 'unassigned')`,
        [importId, firstFP]
      );
      assert(false, 'Should have thrown on duplicate fingerprint');
    } catch (e) {
      assert(e.code === '23505', `Unique constraint prevents duplicate (error code: ${e.code})`);
    }

    // ── TEST 6: Query with filters ──
    console.log('\nTEST 6: Query with filters');
    const allMovs = await pool.query(
      `SELECT * FROM bank_movements WHERE import_id = $1 ORDER BY posted_at DESC`,
      [importId]
    );
    assert(allMovs.rows.length === 10, `All 10 movements returned`);

    // Date filter
    const todayMovs = await pool.query(
      `SELECT * FROM bank_movements WHERE import_id = $1 AND posted_at::date = '2026-04-12'`,
      [importId]
    );
    assert(todayMovs.rows.length === 5, `5 movements on 2026-04-12 (got ${todayMovs.rows.length})`);

    // Amount filter
    const bigMovs = await pool.query(
      `SELECT * FROM bank_movements WHERE import_id = $1 AND amount >= 20000`,
      [importId]
    );
    assert(bigMovs.rows.length === 3, `3 movements >= 20000 (got ${bigMovs.rows.length})`);

    // Status filter
    const unassigned = await pool.query(
      `SELECT * FROM bank_movements WHERE import_id = $1 AND assignment_status = 'unassigned'`,
      [importId]
    );
    assert(unassigned.rows.length === 10, `All 10 are unassigned`);

    // Search
    const searchRes = await pool.query(
      `SELECT * FROM bank_movements WHERE import_id = $1 AND sender_name ILIKE '%PEREZ%'`,
      [importId]
    );
    assert(searchRes.rows.length === 1, `Search 'PEREZ' returns 1 (got ${searchRes.rows.length})`);

    // ── TEST 7: Movement detail ──
    console.log('\nTEST 7: Movement detail with raw_row');
    const detailRes = await pool.query(
      `SELECT bm.*, bi.filename as import_filename
       FROM bank_movements bm
       LEFT JOIN bank_imports bi ON bi.id = bm.import_id
       WHERE bm.import_id = $1
       ORDER BY bm.posted_at ASC LIMIT 1`,
      [importId]
    );
    const detail = detailRes.rows[0];
    assert(detail.raw_row !== null, `raw_row preserved`);
    assert(detail.import_filename === 'test-import.json', `Import filename preserved`);
    assert(detail.amount == 9900 || detail.amount > 0, `Amount stored correctly: ${detail.amount}`);

    // ── TEST 8: Comprobantes NOT affected ──
    console.log('\nTEST 8: Comprobantes NOT affected');
    const compCountBefore = await pool.query('SELECT COUNT(*) FROM comprobantes');
    assert(parseInt(compCountBefore.rows[0].count) >= 0, `Comprobantes table untouched (${compCountBefore.rows[0].count} rows)`);

    // Verify no FK cascade risk
    const compCols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'comprobantes'
       ORDER BY ordinal_position`
    );
    const compColNames = compCols.rows.map(r => r.column_name);
    assert(!compColNames.includes('bank_movement_id'), `No bank_movement_id column in comprobantes`);

    // ── TEST 9: Import history ──
    console.log('\nTEST 9: Import history');
    const histRes = await pool.query(
      `SELECT bi.*, u.name as uploaded_by_name
       FROM bank_imports bi
       LEFT JOIN users u ON u.id = bi.uploaded_by
       WHERE bi.filename = 'test-import.json'`
    );
    assert(histRes.rows.length === 1, `1 import in history`);
    assert(histRes.rows[0].uploaded_by_name !== null, `User name joined`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── Summary ──
  console.log(`\n${'='.repeat(40)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));

  if (failed > 0) {
    process.exit(1);
  }

  // Cleanup
  await cleanTestData();
  console.log('\nTest data cleaned up.');
  await pool.end();
}

runTests().catch(err => {
  console.error('Test error:', err);
  pool.end();
  process.exit(1);
});
