#!/usr/bin/env node
/**
 * Supabase Storage → GCS Migration Script
 *
 * Downloads all files referenced in the database from Supabase Storage
 * and re-uploads them to GCS, then optionally updates URLs.
 *
 * Prerequisites:
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (source)
 *   - GCS_BUCKET set (destination)
 *   - GOOGLE_APPLICATION_CREDENTIALS or running on GCP (for GCS auth)
 *   - Database accessible (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)
 *
 * Usage:
 *   # Dry run (report only, no writes):
 *   node infra/gcp/migrate-storage.js --dry-run
 *
 *   # Copy files (no URL update):
 *   node infra/gcp/migrate-storage.js --copy
 *
 *   # Copy files + update URLs in DB:
 *   node infra/gcp/migrate-storage.js --copy --update-urls
 *
 *   # Verify after migration:
 *   node infra/gcp/migrate-storage.js --verify
 */

const path = require('path');
const backendDir = path.resolve(__dirname, '../../backend');
const backendModules = path.join(backendDir, 'node_modules');
require(path.join(backendModules, 'dotenv')).config({ path: path.join(backendDir, '.env') });
const { Pool } = require(path.join(backendModules, 'pg'));
const { Storage } = require(path.join(backendModules, '@google-cloud/storage'));
const https = require('https');
const http = require('http');

// ── Config ─────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const GCS_BUCKET = process.env.GCS_BUCKET;
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DO_COPY = args.includes('--copy');
const UPDATE_URLS = args.includes('--update-urls');
const VERIFY = args.includes('--verify');
const CONCURRENCY = 5;

if (!args.length) {
  console.log('Usage: node migrate-storage.js [--dry-run | --copy [--update-urls] | --verify]');
  process.exit(0);
}

// ── DB connection ──────────────────────────────────────────
const isCloudSQL = process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/');
const poolConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  max: 5,
};
if (!isCloudSQL) {
  poolConfig.port = Number(process.env.DB_PORT) || 5432;
  poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(poolConfig);

// ── GCS client ─────────────────────────────────────────────
const gcs = GCS_BUCKET ? new Storage() : null;
const bucket = gcs ? gcs.bucket(GCS_BUCKET) : null;

// ── Report ─────────────────────────────────────────────────
const report = {
  total: 0,
  copied: 0,
  skipped: 0,
  errors: [],
  urlsUpdated: 0,
  verified: 0,
  verifyFailed: 0,
};

// ── Helpers ────────────────────────────────────────────────
function extractPathFromSupabaseUrl(url) {
  // https://xxx.supabase.co/storage/v1/object/public/comprobantes/pendientes/123-file.jpg
  // → pendientes/123-file.jpg
  const match = url.match(/\/storage\/v1\/object\/public\/comprobantes\/(.+)$/);
  return match ? match[1] : null;
}

function gcsUrl(path) {
  return `https://storage.googleapis.com/${GCS_BUCKET}/${path}`;
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fileExistsInGCS(path) {
  try {
    const [exists] = await bucket.file(path).exists();
    return exists;
  } catch {
    return false;
  }
}

async function uploadToGCS(path, buffer, contentType) {
  const file = bucket.file(path);
  await file.save(buffer, {
    contentType: contentType || 'application/octet-stream',
    resumable: false,
    metadata: { cacheControl: 'public, max-age=31536000' },
  });
}

function guessMimeType(path) {
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.pdf')) return 'application/pdf';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

// ── Batch processor ────────────────────────────────────────
async function processBatch(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
    if (i > 0 && i % 50 === 0) {
      console.log(`  progress: ${i}/${items.length}`);
    }
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log('\n═══ Storage Migration: Supabase → GCS ═══\n');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : VERIFY ? 'VERIFY' : 'COPY' + (UPDATE_URLS ? ' + UPDATE URLS' : '')}`);
  console.log(`Source: ${SUPABASE_URL || '(not set)'}`);
  console.log(`Destination: gs://${GCS_BUCKET || '(not set)'}\n`);

  if ((DO_COPY || VERIFY) && !GCS_BUCKET) {
    console.error('ERROR: GCS_BUCKET not set. Cannot copy/verify without destination.');
    process.exit(1);
  }

  // ── 1. Gather all file URLs from database ────────────────
  console.log('→ Querying database for file URLs...');

  const comprobantesRes = await pool.query(`
    SELECT id, file_url FROM comprobantes WHERE file_url IS NOT NULL AND file_url != ''
  `);
  const remitosRes = await pool.query(`
    SELECT id, file_url FROM shipping_documents WHERE file_url IS NOT NULL AND file_url != ''
  `);

  const allFiles = [];

  for (const row of comprobantesRes.rows) {
    allFiles.push({ table: 'comprobantes', id: row.id, url: row.file_url });
  }
  for (const row of remitosRes.rows) {
    allFiles.push({ table: 'shipping_documents', id: row.id, url: row.file_url });
  }

  report.total = allFiles.length;
  const supabaseFiles = allFiles.filter(f => f.url.includes('supabase'));
  const gcsFiles = allFiles.filter(f => f.url.includes('storage.googleapis.com'));
  const otherFiles = allFiles.filter(f => !f.url.includes('supabase') && !f.url.includes('storage.googleapis.com'));

  console.log(`  Total files in DB: ${allFiles.length}`);
  console.log(`  Supabase URLs: ${supabaseFiles.length}`);
  console.log(`  GCS URLs: ${gcsFiles.length} (already migrated)`);
  console.log(`  Other URLs: ${otherFiles.length}`);
  console.log(`  comprobantes: ${comprobantesRes.rowCount}`);
  console.log(`  shipping_documents: ${remitosRes.rowCount}\n`);

  if (DRY_RUN) {
    console.log('═══ DRY RUN COMPLETE ═══');
    console.log('No files were copied or URLs updated.');
    console.log(`\nTo proceed: node migrate-storage.js --copy`);
    await pool.end();
    return;
  }

  // ── 2. Copy files ────────────────────────────────────────
  if (DO_COPY) {
    console.log(`→ Copying ${supabaseFiles.length} files to GCS...`);

    await processBatch(supabaseFiles, async (file) => {
      const path = extractPathFromSupabaseUrl(file.url);
      if (!path) {
        report.errors.push({ id: file.id, table: file.table, url: file.url, error: 'Could not extract path' });
        return;
      }

      // Check if already exists in GCS
      const exists = await fileExistsInGCS(path);
      if (exists) {
        report.skipped++;
        return;
      }

      // Download from Supabase
      let buffer;
      try {
        buffer = await downloadBuffer(file.url);
      } catch (err) {
        report.errors.push({ id: file.id, table: file.table, url: file.url, error: `Download: ${err.message}` });
        return;
      }

      // Upload to GCS
      try {
        await uploadToGCS(path, buffer, guessMimeType(path));
        report.copied++;
      } catch (err) {
        report.errors.push({ id: file.id, table: file.table, url: file.url, error: `Upload: ${err.message}` });
      }
    });

    console.log(`\n  Copied: ${report.copied}`);
    console.log(`  Skipped (already in GCS): ${report.skipped}`);
    console.log(`  Errors: ${report.errors.length}\n`);
  }

  // ── 3. Update URLs ──────────────────────────────────────
  if (UPDATE_URLS) {
    console.log('→ Updating URLs in database...');

    // Build the replacement pattern
    // From: https://xxx.supabase.co/storage/v1/object/public/comprobantes/
    // To:   https://storage.googleapis.com/BUCKET/
    const supabasePrefix = `${SUPABASE_URL}/storage/v1/object/public/comprobantes/`;
    const gcsPrefix = `https://storage.googleapis.com/${GCS_BUCKET}/`;

    for (const table of ['comprobantes', 'shipping_documents']) {
      const result = await pool.query(`
        UPDATE ${table}
        SET file_url = REPLACE(file_url, $1, $2)
        WHERE file_url LIKE $3
        RETURNING id
      `, [supabasePrefix, gcsPrefix, `%${supabasePrefix}%`]);

      console.log(`  ${table}: ${result.rowCount} URLs updated`);
      report.urlsUpdated += result.rowCount;
    }
    console.log('');
  }

  // ── 4. Verify ────────────────────────────────────────────
  if (VERIFY) {
    console.log('→ Verifying GCS files are accessible...');

    // Re-query to get current URLs
    const currentRes = await pool.query(`
      SELECT 'comprobantes' as tbl, id, file_url FROM comprobantes WHERE file_url IS NOT NULL
      UNION ALL
      SELECT 'shipping_documents' as tbl, id, file_url FROM shipping_documents WHERE file_url IS NOT NULL
    `);

    const gcsRows = currentRes.rows.filter(r => r.file_url.includes('storage.googleapis.com'));
    console.log(`  GCS URLs to verify: ${gcsRows.length}`);

    await processBatch(gcsRows, async (row) => {
      try {
        // HEAD request only
        const url = row.file_url;
        await new Promise((resolve, reject) => {
          const client = url.startsWith('https') ? https : http;
          const req = client.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
            if (res.statusCode === 200) {
              report.verified++;
              resolve();
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
          req.on('error', reject);
          req.end();
        });
      } catch (err) {
        report.verifyFailed++;
        report.errors.push({ id: row.id, table: row.tbl, url: row.file_url, error: `Verify: ${err.message}` });
      }
    });

    console.log(`  Verified OK: ${report.verified}`);
    console.log(`  Verify failed: ${report.verifyFailed}\n`);
  }

  // ── 5. Final Report ──────────────────────────────────────
  console.log('═══════════════════════════════════════════════════');
  console.log('MIGRATION REPORT');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Total files in DB:     ${report.total}`);
  console.log(`Copied to GCS:         ${report.copied}`);
  console.log(`Skipped (existing):    ${report.skipped}`);
  console.log(`URLs updated:          ${report.urlsUpdated}`);
  console.log(`Verified OK:           ${report.verified}`);
  console.log(`Verify failed:         ${report.verifyFailed}`);
  console.log(`Errors:                ${report.errors.length}`);

  if (report.errors.length > 0) {
    console.log('\nERROR DETAILS:');
    for (const err of report.errors.slice(0, 50)) {
      console.log(`  [${err.table}:${err.id}] ${err.error}`);
      console.log(`    URL: ${err.url}`);
    }
    if (report.errors.length > 50) {
      console.log(`  ... and ${report.errors.length - 50} more errors`);
    }

    // Write full error log
    const fs = require('fs');
    const logPath = '/tmp/storage-migration-errors.json';
    fs.writeFileSync(logPath, JSON.stringify(report.errors, null, 2));
    console.log(`\n  Full error log: ${logPath}`);
  }

  console.log('═══════════════════════════════════════════════════');

  await pool.end();
  process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
