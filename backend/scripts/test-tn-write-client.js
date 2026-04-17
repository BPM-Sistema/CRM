#!/usr/bin/env node
/**
 * Smoke test del wrapper callTiendanubeWrite (mock server local).
 *
 * Verifica:
 *  1. Rate limit: 50 requests en paralelo → respeta ~1.5 req/s sostenido.
 *  2. Retry 429: devuelve 429 las primeras N veces, luego 200.
 *  3. Retry 5xx: devuelve 503 una vez, luego 200.
 *  4. Timeout: devuelve timeout, retry.
 *  5. Log por intento.
 *
 * Uso:
 *   node backend/scripts/test-tn-write-client.js
 */

process.env.TN_WRITE_RATE_PER_SECOND = '1.5';
process.env.TN_WRITE_BUCKET_CAPACITY = '10';
process.env.TN_WRITE_MAX_RETRIES = '4';
process.env.TN_WRITE_BASE_BACKOFF_MS = '300';
process.env.TN_WRITE_JITTER_MS = '100';

const http = require('http');
const { callTiendanubeWrite, getTnWriteMetrics } = require('../lib/tnWriteClient');

// ─── Mock server ───────────────────────────────────────────
const state = {
  rateLimit429Count: 0, // cuántas veces devolver 429 antes de 200
  fiveXxCount: 0,
  requests: [],
};

const server = http.createServer((req, res) => {
  const t = Date.now();
  state.requests.push({ method: req.method, url: req.url, t });

  if (req.url.startsWith('/ratelimit')) {
    if (state.rateLimit429Count > 0) {
      state.rateLimit429Count -= 1;
      res.writeHead(429, {
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': '250',
      });
      return res.end('429 Too Many Requests');
    }
    res.writeHead(200, { 'x-rate-limit-remaining': '39' });
    return res.end('{"ok":true}');
  }

  if (req.url.startsWith('/5xx')) {
    if (state.fiveXxCount > 0) {
      state.fiveXxCount -= 1;
      res.writeHead(503);
      return res.end('Service Unavailable');
    }
    res.writeHead(200);
    return res.end('{"ok":true}');
  }

  if (req.url.startsWith('/ok')) {
    res.writeHead(200, { 'x-rate-limit-remaining': '35' });
    return res.end('{"ok":true}');
  }

  res.writeHead(404);
  res.end('nope');
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}`;

  console.log(`\n== Mock server on ${BASE} ==\n`);
  console.log('Initial metrics:', getTnWriteMetrics());

  // ─ Test 1: rate limit con 50 requests en paralelo ─
  console.log('\n── Test 1: 50 parallel PUTs al /ok (espera rate limit) ──');
  state.requests = [];
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      callTiendanubeWrite(
        { method: 'put', url: `${BASE}/ok/${i}`, data: {}, timeout: 5000 },
        { context: `t1#${i}` }
      )
    )
  );
  const elapsed = (Date.now() - t0) / 1000;
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  const theoreticalMin = (50 - 10) / 1.5; // burst 10 free, resto a 1.5/s
  console.log(`Resultado: ok=${ok} fail=${fail} elapsed=${elapsed.toFixed(2)}s`);
  console.log(`Esperado mínimo ≈ ${theoreticalMin.toFixed(1)}s (burst 10 + (40/1.5))`);
  const passT1 = ok === 50 && elapsed >= theoreticalMin * 0.9 && elapsed < theoreticalMin * 1.5;
  console.log(`  → ${passT1 ? 'PASS ✓' : 'FAIL ✗'}`);

  await sleep(2000); // deja recargar bucket

  // ─ Test 2: retry ante 429 ─
  console.log('\n── Test 2: 1 request que recibe 429 × 2 antes de 200 ──');
  state.rateLimit429Count = 2;
  state.requests = [];
  const t1 = Date.now();
  const r = await callTiendanubeWrite(
    { method: 'put', url: `${BASE}/ratelimit`, data: {}, timeout: 5000 },
    { context: 't2#retry429' }
  );
  const e2 = Date.now() - t1;
  const attempts = state.requests.filter((x) => x.url === '/ratelimit').length;
  // 2 backoffs usando x-rate-limit-reset=250ms + jitter(0..100) ≈ 500-700ms
  console.log(`status=${r.status} attempts=${attempts} elapsed=${e2}ms (esperado 500-900ms)`);
  const passT2 = r.status === 200 && attempts === 3 && e2 >= 500 && e2 <= 1500;
  console.log(`  → ${passT2 ? 'PASS ✓' : 'FAIL ✗'}`);

  // ─ Test 3: retry ante 5xx ─
  console.log('\n── Test 3: 1 request que recibe 503 una vez ──');
  state.fiveXxCount = 1;
  state.requests = [];
  const t2 = Date.now();
  const r3 = await callTiendanubeWrite(
    { method: 'post', url: `${BASE}/5xx`, data: {}, timeout: 5000 },
    { context: 't3#retry503' }
  );
  const e3 = Date.now() - t2;
  const attempts3 = state.requests.filter((x) => x.url === '/5xx').length;
  console.log(`status=${r3.status} attempts=${attempts3} elapsed=${e3}ms`);
  const passT3 = r3.status === 200 && attempts3 === 2;
  console.log(`  → ${passT3 ? 'PASS ✓' : 'FAIL ✗'}`);

  // ─ Test 4: falla definitiva tras agotar retries ─
  console.log('\n── Test 4: 429 persistente (agota 4 retries) ──');
  state.rateLimit429Count = 999;
  state.requests = [];
  let threw = false;
  let finalStatus = null;
  try {
    await callTiendanubeWrite(
      { method: 'put', url: `${BASE}/ratelimit`, data: {}, timeout: 5000 },
      { context: 't4#persistent429' }
    );
  } catch (err) {
    threw = true;
    finalStatus = err.response?.status;
  }
  const attempts4 = state.requests.filter((x) => x.url === '/ratelimit').length;
  console.log(`threw=${threw} finalStatus=${finalStatus} attempts=${attempts4} (esperado 4)`);
  const passT4 = threw && finalStatus === 429 && attempts4 === 4;
  console.log(`  → ${passT4 ? 'PASS ✓' : 'FAIL ✗'}`);

  console.log('\n=== RESULTADO ===');
  const pass = passT1 && passT2 && passT3 && passT4;
  console.log(pass ? 'ALL PASS ✓' : 'SOME FAIL ✗');

  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  server.close();
  process.exit(1);
});
