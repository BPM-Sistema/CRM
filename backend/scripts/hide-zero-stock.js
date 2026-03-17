#!/usr/bin/env node
/**
 * Script: Ocultar productos sin stock en Tiendanube
 * - Busca productos publicados (no ocultos)
 * - Filtra los que tienen stock 0 en TODAS sus variantes
 * - Filtra los que no se actualizaron en los últimos 15 días (proxy de "sin stock hace 15 días")
 * - Los oculta via API
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;
const BASE_URL = `https://api.tiendanube.com/v1/${STORE_ID}`;
const HEADERS = {
  'Authentication': `bearer ${TOKEN}`,
  'User-Agent': 'BPM Admin (bpmadministrador.com)',
  'Content-Type': 'application/json'
};

const FIFTEEN_DAYS_AGO = new Date();
FIFTEEN_DAYS_AGO.setDate(FIFTEEN_DAYS_AGO.getDate() - 15);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllProducts() {
  let allProducts = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    console.log(`Fetching page ${page}...`);
    const url = `${BASE_URL}/products?page=${page}&per_page=${perPage}&fields=id,name,variants,published,updated_at`;
    const res = await fetch(url, { headers: HEADERS });

    if (res.status === 429) {
      console.log('Rate limited, waiting 2s...');
      await sleep(2000);
      continue;
    }

    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${await res.text()}`);
    }

    const products = await res.json();
    if (products.length === 0) break;

    allProducts = allProducts.concat(products);
    console.log(`  Got ${products.length} products (total: ${allProducts.length})`);

    if (products.length < perPage) break;
    page++;
    await sleep(500); // rate limit
  }

  return allProducts;
}

function getTotalStock(product) {
  if (!product.variants || product.variants.length === 0) return 0;
  return product.variants.reduce((sum, v) => {
    // Si stock_management es false, tiene stock "infinito"
    if (v.stock_management === false) return sum + 999;
    return sum + (v.stock || 0);
  }, 0);
}

function getName(product) {
  if (!product.name) return '(sin nombre)';
  // name puede ser objeto { es: "...", pt: "..." }
  if (typeof product.name === 'object') {
    return product.name.es || product.name.pt || product.name.en || Object.values(product.name)[0] || '(sin nombre)';
  }
  return product.name;
}

async function hideProduct(productId) {
  const url = `${BASE_URL}/products/${productId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ published: false })
  });

  if (res.status === 429) {
    await sleep(2000);
    return hideProduct(productId); // retry
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error hiding product ${productId}: ${res.status} ${text}`);
  }

  return res.json();
}

async function main() {
  console.log('=== Buscando productos sin stock para ocultar ===\n');
  console.log(`Fecha límite: ${FIFTEEN_DAYS_AGO.toISOString().split('T')[0]} (15 días atrás)\n`);

  // 1. Fetch all products
  const allProducts = await fetchAllProducts();
  console.log(`\nTotal productos: ${allProducts.length}`);

  // 2. Filter: published, zero stock, not updated in 15 days
  const published = allProducts.filter(p => p.published === true);
  console.log(`Publicados (visibles): ${published.length}`);

  const zeroStock = published.filter(p => getTotalStock(p) === 0);
  console.log(`Con stock 0 (todas las variantes): ${zeroStock.length}`);

  const stale = zeroStock.filter(p => {
    const updatedAt = new Date(p.updated_at);
    return updatedAt < FIFTEEN_DAYS_AGO;
  });
  console.log(`Sin actualizar en 15+ días: ${stale.length}`);

  if (stale.length === 0) {
    console.log('\nNo hay productos para ocultar.');
    return;
  }

  // 3. Hide them
  console.log(`\n=== Ocultando ${stale.length} productos ===\n`);
  const results = [];

  for (const product of stale) {
    const name = getName(product);
    try {
      await hideProduct(product.id);
      const stockDetail = product.variants.map(v => `${v.sku || 'sin-sku'}: ${v.stock || 0}`).join(', ');
      console.log(`✓ OCULTO: [${product.id}] ${name} (variantes: ${stockDetail})`);
      results.push({ id: product.id, name, status: 'oculto', updated_at: product.updated_at });
      await sleep(500);
    } catch (err) {
      console.log(`✗ ERROR: [${product.id}] ${name} - ${err.message}`);
      results.push({ id: product.id, name, status: 'error', error: err.message });
    }
  }

  // 4. Summary
  const hidden = results.filter(r => r.status === 'oculto');
  const errors = results.filter(r => r.status === 'error');

  console.log('\n=== RESUMEN ===');
  console.log(`Total ocultados: ${hidden.length}`);
  console.log(`Errores: ${errors.length}`);

  console.log('\n=== LISTA DE PRODUCTOS OCULTADOS ===\n');
  hidden.forEach((r, i) => {
    console.log(`${i + 1}. [ID: ${r.id}] ${r.name} (última actualización: ${r.updated_at})`);
  });

  if (errors.length > 0) {
    console.log('\n=== ERRORES ===\n');
    errors.forEach(r => {
      console.log(`- [ID: ${r.id}] ${r.name}: ${r.error}`);
    });
  }
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
