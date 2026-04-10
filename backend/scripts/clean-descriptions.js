/**
 * Clean Product Descriptions (conservador)
 *
 * Solo corrige problemas reales:
 * 1. Elimina fragmentos de HTML escapado visible como texto (<p>&lt;td...)
 * 2. Elimina párrafos vacíos iniciales (<p>&nbsp;</p> al principio)
 * 3. Elimina <tr></tr> vacíos
 *
 * NO toca: estilos inline, HTML entities, estructura de tablas
 *
 * Uso:
 *   node scripts/clean-descriptions.js --dry-run   # solo muestra cambios
 *   node scripts/clean-descriptions.js              # aplica cambios
 */

require('dotenv').config();
const axios = require('axios');

const STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;
const BASE = `https://api.tiendanube.com/v1/${STORE_ID}`;
const HEADERS = {
  'Authentication': `bearer ${TOKEN}`,
  'User-Agent': 'BPM Admin',
  'Content-Type': 'application/json'
};

const DRY_RUN = process.argv.includes('--dry-run');
const RATE_LIMIT_MS = 350;

// ─── Cleaning functions ──────────────────────────────────

function cleanDescription(desc) {
  if (!desc) return desc;

  let cleaned = desc;

  // 1. Remove broken escaped HTML fragments like <p>&lt;td style="..."></p>
  cleaned = cleaned.replace(/<p>\s*&lt;[^<]*<\/p>\s*/gi, '');

  // 2. Remove empty paragraphs at the start (with &nbsp; or whitespace only)
  cleaned = cleaned.replace(/^(\s*<p[^>]*>\s*(&nbsp;|\s)*\s*<\/p>\s*)+/gi, '');

  // 3. Remove empty <tr></tr>
  cleaned = cleaned.replace(/<tr>\s*<\/tr>/gi, '');

  // 4. Trim
  cleaned = cleaned.trim();

  return cleaned;
}

// ─── API functions ───────────────────────────────────────

async function fetchAllProducts() {
  const products = [];
  let page = 1;

  while (true) {
    const res = await axios.get(`${BASE}/products`, {
      headers: HEADERS,
      params: { page, per_page: 200, fields: 'id,name,description' }
    });

    if (!res.data || res.data.length === 0) break;
    products.push(...res.data);
    if (res.data.length < 200) break;
    page++;
    await sleep(RATE_LIMIT_MS);
  }

  return products;
}

async function updateProductDescription(productId, description) {
  await axios.put(`${BASE}/products/${productId}`, {
    description: { es: description }
  }, { headers: HEADERS, timeout: 15000 });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getName(p) {
  if (!p.name) return '(sin nombre)';
  if (typeof p.name === 'string') return p.name;
  return p.name.es || Object.values(p.name)[0] || '(sin nombre)';
}

function getDesc(p) {
  if (!p.description) return null;
  if (typeof p.description === 'string') return p.description;
  return p.description.es || Object.values(p.description)[0] || null;
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN - no se aplicarán cambios\n' : '🚀 APLICANDO cambios a Tiendanube\n');

  console.log('Descargando productos...');
  const products = await fetchAllProducts();
  console.log(`Total productos: ${products.length}\n`);

  let changed = 0;
  let skipped = 0;
  let errors = 0;

  for (const p of products) {
    const name = getName(p);
    const desc = getDesc(p);

    if (!desc) {
      skipped++;
      continue;
    }

    const cleaned = cleanDescription(desc);

    if (cleaned === desc) {
      skipped++;
      continue;
    }

    changed++;

    if (DRY_RUN) {
      console.log(`─── ${p.id} | ${name.substring(0, 60)} ───`);
      console.log('ANTES:', desc.substring(0, 150).replace(/\n/g, ' '));
      console.log('DESPUÉS:', cleaned.substring(0, 150).replace(/\n/g, ' '));
      console.log();
    } else {
      try {
        await updateProductDescription(p.id, cleaned);
        process.stdout.write(`✅ ${changed} ${name.substring(0, 40)}\r`);
        await sleep(RATE_LIMIT_MS);
      } catch (err) {
        errors++;
        console.log(`\n❌ Error en ${p.id} (${name}): ${err.message}`);
      }
    }
  }

  console.log('\n');
  console.log('═══════════════════════════════════');
  console.log(`Total productos:  ${products.length}`);
  console.log(`Modificados:      ${changed}`);
  console.log(`Sin cambios:      ${skipped}`);
  if (errors) console.log(`Errores:          ${errors}`);
  console.log('═══════════════════════════════════');
}

main().catch(e => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
