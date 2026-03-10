/**
 * Script para testear race condition de webhooks duplicados
 * Uso: node scripts/test-duplicate-webhook.js
 *
 * Requiere: TIENDANUBE_CLIENT_SECRET en .env o como variable de entorno
 */

const crypto = require('crypto');
const https = require('https');
require('dotenv').config();

const SECRET = process.env.TIENDANUBE_CLIENT_SECRET;
const API_URL = 'https://api.bpmadministrador.com/webhook/tiendanube';

if (!SECRET) {
  console.error('Error: TIENDANUBE_CLIENT_SECRET no está configurado');
  console.error('Agregalo a .env o exportalo: export TIENDANUBE_CLIENT_SECRET=xxx');
  process.exit(1);
}

// Payload de prueba
const payload = JSON.stringify({
  event: 'order/updated',
  store_id: process.env.TIENDANUBE_STORE_ID || '5270498',
  id: 'TEST_RACE_' + Date.now() // ID único para este test
});

// Calcular firma HMAC
const signature = crypto
  .createHmac('sha256', SECRET)
  .update(payload)
  .digest('hex');

console.log('='.repeat(60));
console.log('TEST: Enviando webhooks duplicados simultáneos');
console.log('='.repeat(60));
console.log('Payload:', payload);
console.log('Signature:', signature.substring(0, 20) + '...');
console.log('');

// Función para enviar un webhook
function sendWebhook(id) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-linkedstore-hmac-sha256': signature
      }
    };

    const startTime = Date.now();

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = Date.now() - startTime;
        resolve({
          id,
          status: res.statusCode,
          duration,
          body: data
        });
      });
    });

    req.on('error', (e) => reject({ id, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// Enviar N webhooks simultáneos
async function runTest(count = 5) {
  console.log(`Enviando ${count} webhooks simultáneos...`);
  console.log('');

  const promises = [];
  for (let i = 1; i <= count; i++) {
    promises.push(sendWebhook(i));
  }

  const results = await Promise.allSettled(promises);

  console.log('RESULTADOS:');
  console.log('-'.repeat(60));

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      const r = result.value;
      console.log(`Request ${r.id}: HTTP ${r.status} (${r.duration}ms)`);
    } else {
      console.log(`Request ${i + 1}: ERROR - ${result.reason?.error || result.reason}`);
    }
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('Revisá los logs de Cloud Run para ver:');
  console.log('  - "⏭️ Webhook ya encolado" = Fix funcionando');
  console.log('  - "duplicate key" error = Fix NO funcionando');
  console.log('='.repeat(60));
}

runTest(5);
