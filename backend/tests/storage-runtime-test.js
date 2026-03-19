#!/usr/bin/env node
/**
 * Runtime test for storage abstraction layer.
 * Tests both GCS and Supabase paths depending on env vars.
 *
 * Usage:
 *   # Test Supabase path (current prod):
 *   node tests/storage-runtime-test.js
 *
 *   # Test GCS path:
 *   GCS_BUCKET=your-bucket node tests/storage-runtime-test.js
 */

require('dotenv').config();

const results = { pass: 0, fail: 0, tests: [] };

function test(name, fn) {
  return fn()
    .then((msg) => {
      results.pass++;
      results.tests.push({ name, status: 'PASS', detail: msg || '' });
      console.log(`  ✅ ${name}`);
    })
    .catch((err) => {
      results.fail++;
      results.tests.push({ name, status: 'FAIL', detail: err.message });
      console.log(`  ❌ ${name}: ${err.message}`);
    });
}

async function run() {
  const backend = process.env.GCS_BUCKET ? 'GCS' : 'Supabase';
  console.log(`\n═══ Storage Runtime Tests (backend: ${backend}) ═══\n`);

  // 1. Module loads without error
  await test('storage module loads', async () => {
    const storage = require('../lib/storage');
    if (!storage.uploadFile) throw new Error('uploadFile not exported');
    if (!storage.getPublicUrl) throw new Error('getPublicUrl not exported');
    if (!storage.healthCheck) throw new Error('healthCheck not exported');
    return 'all exports present';
  });

  // 2. getPublicUrl returns correct format
  await test('getPublicUrl format', async () => {
    const { getPublicUrl } = require('../lib/storage');
    const url = getPublicUrl('test/foo.jpg');
    if (process.env.GCS_BUCKET) {
      if (!url.includes('storage.googleapis.com')) throw new Error(`Bad GCS URL: ${url}`);
      if (!url.includes(process.env.GCS_BUCKET)) throw new Error(`Missing bucket in URL: ${url}`);
    } else {
      if (!url.includes('/storage/v1/object/public/comprobantes/')) throw new Error(`Bad Supabase URL: ${url}`);
    }
    return url;
  });

  // 3. Health check passes
  await test('healthCheck', async () => {
    const { healthCheck } = require('../lib/storage');
    const ok = await healthCheck();
    if (!ok) throw new Error('healthCheck returned falsy');
    return 'storage reachable';
  });

  // 4. Upload test file
  const testPath = `_test/${Date.now()}-runtime-test.txt`;
  await test('uploadFile', async () => {
    const { uploadFile } = require('../lib/storage');
    const buf = Buffer.from('runtime test ' + new Date().toISOString());
    const url = await uploadFile(testPath, buf, 'text/plain');
    if (!url || typeof url !== 'string') throw new Error('uploadFile did not return URL');
    if (!url.startsWith('http')) throw new Error(`Invalid URL: ${url}`);
    return url;
  });

  // 5. Verify uploaded file is accessible
  await test('uploaded file accessible', async () => {
    const { getPublicUrl } = require('../lib/storage');
    const url = getPublicUrl(testPath);
    const axios = require('axios');
    const res = await axios.get(url, { timeout: 10000 });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    if (!res.data.includes('runtime test')) throw new Error('Content mismatch');
    return `HTTP 200, content verified at ${url}`;
  });

  // 6. Upload with image mimetype (simulates comprobante)
  await test('uploadFile with image/jpeg mimetype', async () => {
    const { uploadFile } = require('../lib/storage');
    // Create a minimal valid JPEG (2x2 red pixel)
    const buf = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9
    ]);
    const imgPath = `_test/${Date.now()}-test.jpg`;
    const url = await uploadFile(imgPath, buf, 'image/jpeg');
    if (!url.endsWith('.jpg')) throw new Error(`URL doesn't end with .jpg: ${url}`);
    return url;
  });

  // Summary
  console.log(`\n═══ Results: ${results.pass} passed, ${results.fail} failed ═══\n`);

  if (results.fail > 0) {
    console.log('FAILED TESTS:');
    results.tests.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`  - ${t.name}: ${t.detail}`);
    });
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
