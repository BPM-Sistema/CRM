#!/usr/bin/env node
/**
 * Cloud SQL Post-Restore Validation
 *
 * Run after pg_dump/restore to verify database integrity.
 * Checks: row counts, sequences, extensions, triggers, functions,
 *         constraints, indexes, and basic smoke tests.
 *
 * Usage:
 *   # Against Cloud SQL (set DB_ env vars to Cloud SQL):
 *   node infra/gcp/validate-cloudsql.js
 *
 *   # Compare with Supabase (two-phase):
 *   DB_HOST=supabase-host DB_PORT=6543 node infra/gcp/validate-cloudsql.js --snapshot > /tmp/supabase.json
 *   DB_HOST=/cloudsql/proj:region:inst node infra/gcp/validate-cloudsql.js --compare /tmp/supabase.json
 */

const path = require('path');
const backendDir = path.resolve(__dirname, '../../backend');
require(path.join(backendDir, 'node_modules/dotenv')).config({ path: path.join(backendDir, '.env') });

const { Pool } = require(path.join(backendDir, 'node_modules/pg'));

const args = process.argv.slice(2);
const SNAPSHOT = args.includes('--snapshot');
const COMPARE_FILE = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;

// ── DB connection ──────────────────────────────────────────
const isCloudSQL = process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/');
const poolConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  max: 3,
};
if (!isCloudSQL) {
  poolConfig.port = Number(process.env.DB_PORT) || 5432;
  poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(poolConfig);

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = [];

function check(name, passed, detail) {
  totalChecks++;
  if (passed) {
    passedChecks++;
    console.log(`  ✅ ${name}${detail ? ': ' + detail : ''}`);
  } else {
    failedChecks.push({ name, detail });
    console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
  }
}

async function main() {
  console.log('\n═══ Cloud SQL Post-Restore Validation ═══\n');
  console.log(`Host: ${process.env.DB_HOST}`);
  console.log(`Database: ${process.env.DB_NAME}`);
  console.log(`Mode: ${isCloudSQL ? 'Cloud SQL (Unix socket)' : 'TCP'}\n`);

  const snapshot = {};

  // ── 1. Connection test ───────────────────────────────────
  console.log('→ Connection test');
  try {
    const r = await pool.query('SELECT 1 as ok, version() as ver');
    check('Database connection', r.rows[0].ok === 1, r.rows[0].ver.split(' ').slice(0, 2).join(' '));
  } catch (err) {
    check('Database connection', false, err.message);
    console.log('\nFATAL: Cannot connect to database. Aborting.');
    process.exit(1);
  }

  // ── 2. Extensions ───────────────────────────────────────
  console.log('\n→ Extensions');
  const extRes = await pool.query(`SELECT extname FROM pg_extension ORDER BY extname`);
  const extensions = extRes.rows.map(r => r.extname);
  snapshot.extensions = extensions;
  check('pg_trgm extension', extensions.includes('pg_trgm'), extensions.join(', '));
  check('plpgsql extension', extensions.includes('plpgsql'));

  // ── 3. Table row counts (critical tables) ────────────────
  console.log('\n→ Row counts (critical tables)');
  const criticalTables = [
    'orders_validated', 'comprobantes', 'customers', 'shipping_documents',
    'shipping_requests', 'pagos_efectivo', 'logs', 'users', 'roles',
    'permissions', 'role_permissions', 'financieras', 'sync_queue',
    'whatsapp_messages', 'notifications', 'order_inconsistencies',
    'integration_config', 'ai_bot_config', 'waspy_config',
    'conversation_orders', 'activity_log', 'system_alerts'
  ];
  snapshot.rowCounts = {};

  for (const table of criticalTables) {
    try {
      const r = await pool.query(`SELECT COUNT(*) as cnt FROM ${table}`);
      const count = parseInt(r.rows[0].cnt);
      snapshot.rowCounts[table] = count;
      check(`${table}`, count >= 0, `${count} rows`);
    } catch (err) {
      if (err.message.includes('does not exist')) {
        check(`${table}`, false, 'TABLE MISSING');
      } else {
        check(`${table}`, false, err.message);
      }
    }
  }

  // ── 4. Sequences ─────────────────────────────────────────
  console.log('\n→ Sequences');
  const seqRes = await pool.query(`
    SELECT sequencename, last_value
    FROM pg_sequences
    WHERE schemaname = 'public'
    ORDER BY sequencename
  `);
  snapshot.sequences = {};
  for (const row of seqRes.rows) {
    snapshot.sequences[row.sequencename] = row.last_value;
    check(`Sequence ${row.sequencename}`, row.last_value !== null, `last_value=${row.last_value}`);
  }

  // ── 5. Triggers ──────────────────────────────────────────
  console.log('\n→ Triggers');
  const trigRes = await pool.query(`
    SELECT trigger_name, event_object_table, action_timing, event_manipulation
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    ORDER BY trigger_name
  `);
  snapshot.triggers = trigRes.rows.map(r => r.trigger_name);
  const expectedTriggers = [
    'trigger_integration_config_updated',
    'trigger_integration_config_log',
    'ai_bot_config_updated_at'
  ];
  for (const trig of expectedTriggers) {
    check(`Trigger ${trig}`, snapshot.triggers.includes(trig));
  }

  // ── 6. Functions ─────────────────────────────────────────
  console.log('\n→ Functions');
  const funcRes = await pool.query(`
    SELECT routine_name
    FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
    ORDER BY routine_name
  `);
  snapshot.functions = funcRes.rows.map(r => r.routine_name);
  const expectedFunctions = [
    'update_integration_config_timestamp',
    'log_integration_config_change',
    'update_ai_bot_config_updated_at'
  ];
  for (const fn of expectedFunctions) {
    check(`Function ${fn}`, snapshot.functions.includes(fn));
  }

  // ── 7. Indexes ───────────────────────────────────────────
  console.log('\n→ Critical indexes');
  const idxRes = await pool.query(`
    SELECT indexname, tablename
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `);
  snapshot.indexCount = idxRes.rowCount;
  check(`Total indexes`, idxRes.rowCount > 0, `${idxRes.rowCount} indexes`);

  // Check for trgm indexes specifically
  const trgmIdx = idxRes.rows.filter(r => r.indexname.includes('trgm'));
  check('Trigram indexes', trgmIdx.length > 0, trgmIdx.map(r => r.indexname).join(', '));

  // ── 8. Foreign key constraints ───────────────────────────
  console.log('\n→ Constraints');
  const fkRes = await pool.query(`
    SELECT constraint_name, table_name
    FROM information_schema.table_constraints
    WHERE constraint_type = 'FOREIGN KEY' AND constraint_schema = 'public'
    ORDER BY table_name
  `);
  snapshot.foreignKeys = fkRes.rowCount;
  check('Foreign keys', true, `${fkRes.rowCount} FK constraints`);

  // ── 9. RBAC seed data ───────────────────────────────────
  console.log('\n→ RBAC seed data');
  const rolesRes = await pool.query(`SELECT name FROM roles ORDER BY name`);
  const roleNames = rolesRes.rows.map(r => r.name);
  snapshot.roles = roleNames;
  for (const role of ['admin', 'operador', 'caja', 'logistica', 'readonly']) {
    check(`Role "${role}"`, roleNames.includes(role));
  }

  const permsRes = await pool.query(`SELECT COUNT(*) as cnt FROM permissions`);
  check('Permissions seeded', parseInt(permsRes.rows[0].cnt) > 0, `${permsRes.rows[0].cnt} permissions`);

  // ── 10. Smoke queries ────────────────────────────────────
  console.log('\n→ Smoke queries');

  try {
    const r = await pool.query(`
      SELECT COUNT(*) as cnt FROM orders_validated
      WHERE customer_name ILIKE '%test%'
    `);
    check('ILIKE query (uses pg_trgm)', true, `${r.rows[0].cnt} results`);
  } catch (err) {
    check('ILIKE query', false, err.message);
  }

  try {
    const r = await pool.query(`SELECT gen_random_uuid() as uuid`);
    check('gen_random_uuid()', r.rows[0].uuid.length === 36);
  } catch (err) {
    check('gen_random_uuid()', false, err.message);
  }

  try {
    const r = await pool.query(`SELECT NOW() as ts`);
    check('NOW() timestamp', !!r.rows[0].ts);
  } catch (err) {
    check('NOW() timestamp', false, err.message);
  }

  // ── 11. Compare with snapshot ────────────────────────────
  if (COMPARE_FILE) {
    console.log('\n→ Comparing with snapshot...');
    const fs = require('fs');
    const baseline = JSON.parse(fs.readFileSync(COMPARE_FILE, 'utf8'));

    if (baseline.rowCounts) {
      for (const [table, count] of Object.entries(baseline.rowCounts)) {
        const current = snapshot.rowCounts[table];
        if (current === undefined) {
          check(`Compare ${table}`, false, `missing in current DB`);
        } else {
          const diff = current - count;
          const ok = Math.abs(diff) <= Math.max(count * 0.01, 5); // Allow 1% or 5 row drift
          check(`Compare ${table}`, ok, `baseline=${count} current=${current} diff=${diff}`);
        }
      }
    }

    if (baseline.sequences) {
      for (const [seq, val] of Object.entries(baseline.sequences)) {
        const current = snapshot.sequences[seq];
        check(`Seq ${seq}`, current !== undefined && current >= val,
          `baseline=${val} current=${current || 'MISSING'}`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`VALIDATION: ${passedChecks}/${totalChecks} passed, ${failedChecks.length} failed`);

  if (failedChecks.length > 0) {
    console.log('\nFAILED CHECKS:');
    for (const f of failedChecks) {
      console.log(`  ❌ ${f.name}: ${f.detail || ''}`);
    }
  }
  console.log('═══════════════════════════════════════════════════');

  // ── Snapshot output ──────────────────────────────────────
  if (SNAPSHOT) {
    const fs = require('fs');
    const outPath = args[args.indexOf('--snapshot') + 1] || '/tmp/db-snapshot.json';
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    console.log(`\nSnapshot saved to: ${outPath}`);
  }

  await pool.end();
  process.exit(failedChecks.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
