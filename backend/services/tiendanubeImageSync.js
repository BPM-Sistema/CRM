/**
 * Tiendanube Product Image Sync
 *
 * Reordena la imagen principal de cada producto para que coincida
 * con la variante que tiene mayor stock.
 *
 * NO modifica asociaciones variante->imagen.
 * NO borra ni reemplaza imágenes.
 * Solo reordena posiciones de imágenes del producto.
 *
 * Persistencia en archivos (sin DB):
 *   runtime/image-sync/latest.json      -> resumen última corrida
 *   runtime/image-sync/runs.jsonl       -> historial append-only
 *   runtime/image-sync/run-<id>.json    -> detalle por corrida
 *   runtime/image-sync/image-sync.lock  -> lock anti-concurrencia
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { tiendanube: tnConfig } = require('./integrationConfig');
const { callTiendanubeWrite } = require('../lib/tnWriteClient');

// ─── Configuración ──────────────────────────────────────────

const TN_BASE_URL = 'https://api.tiendanube.com/v1';
const PER_PAGE = 50;
const RATE_LIMIT_DELAY_MS = 250;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const LOCK_STALE_MS = 15 * 60 * 1000; // 15 min
const MAX_RUN_FILES = 50; // máximo de archivos run-<id>.json a conservar

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime', 'image-sync');
const LATEST_FILE = path.join(RUNTIME_DIR, 'latest.json');
const RUNS_FILE = path.join(RUNTIME_DIR, 'runs.jsonl');
const LOCK_FILE = path.join(RUNTIME_DIR, 'image-sync.lock');

// ─── Utilidades ─────────────────────────────────────────────

function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
}

function getConfig() {
  const storeId = process.env.TIENDANUBE_STORE_ID;
  const accessToken = process.env.TIENDANUBE_ACCESS_TOKEN;
  if (!storeId || !accessToken) {
    throw new Error('TIENDANUBE_STORE_ID y TIENDANUBE_ACCESS_TOKEN son requeridos');
  }
  return { storeId, accessToken };
}

function buildHeaders(accessToken) {
  return {
    authentication: `bearer ${accessToken}`,
    'User-Agent': 'crm-image-sync/1.0',
    'Content-Type': 'application/json'
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ─── Atomic file writes ────────────────────────────────────

function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`⚠️  [ImageSync] Error leyendo ${path.basename(filePath)}: ${err.message}`);
    return null;
  }
}

function appendJsonl(filePath, data) {
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n', 'utf8');
}

function readJsonlSafe(filePath, limit = 20) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const results = [];
    // Leer desde el final (más recientes primero)
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        results.push(JSON.parse(lines[i]));
      } catch {
        console.warn(`⚠️  [ImageSync] Línea inválida en runs.jsonl (${i}), ignorada`);
      }
    }
    return results;
  } catch (err) {
    console.error(`⚠️  [ImageSync] Error leyendo runs.jsonl: ${err.message}`);
    return [];
  }
}

// ─── Lock anti-concurrencia ─────────────────────────────────

function acquireLock(triggerSource) {
  ensureRuntimeDir();

  if (fs.existsSync(LOCK_FILE)) {
    const lockData = readJsonSafe(LOCK_FILE);
    if (lockData) {
      const age = Date.now() - new Date(lockData.started_at).getTime();
      if (age < LOCK_STALE_MS) {
        console.log(`🔒 [ImageSync] Lock activo (${triggerSource} omitida). Corrida en progreso desde ${lockData.started_at} (pid: ${lockData.pid})`);
        return false;
      }
      console.warn(`⚠️  [ImageSync] Lock stale detectado (${Math.round(age / 1000)}s). Recuperando...`);
    }
  }

  const lockData = {
    started_at: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
    trigger_source: triggerSource
  };

  try {
    writeJsonAtomic(LOCK_FILE, lockData);
    console.log(`🔓 [ImageSync] Lock adquirido (${triggerSource}, pid: ${process.pid})`);
    return true;
  } catch (err) {
    console.error(`❌ [ImageSync] Error adquiriendo lock: ${err.message}`);
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
      console.log('🔓 [ImageSync] Lock liberado');
    }
  } catch (err) {
    console.error(`⚠️  [ImageSync] Error liberando lock: ${err.message}`);
  }
}

// ─── Persistencia de resultados ─────────────────────────────

function persistRunResult(result) {
  try {
    ensureRuntimeDir();

    // 1. latest.json (atomic)
    writeJsonAtomic(LATEST_FILE, result);

    // 2. runs.jsonl (append, sin items completos)
    const summary = { ...result };
    delete summary.items;
    appendJsonl(RUNS_FILE, summary);

    // 3. run-<id>.json (detalle completo)
    const runFile = path.join(RUNTIME_DIR, `run-${result.run_id}.json`);
    writeJsonAtomic(runFile, result);

    // 4. Cleanup: borrar archivos viejos
    cleanupOldRuns();

    console.log(`💾 [ImageSync] Resultado persistido (run: ${result.run_id})`);
  } catch (err) {
    console.error(`⚠️  [ImageSync] Error persistiendo resultado: ${err.message}`);
    // No explotar - el sync ya terminó exitosamente
  }
}

function cleanupOldRuns() {
  try {
    const files = fs.readdirSync(RUNTIME_DIR)
      .filter(f => f.startsWith('run-') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length > MAX_RUN_FILES) {
      const toDelete = files.slice(MAX_RUN_FILES);
      for (const f of toDelete) {
        fs.unlinkSync(path.join(RUNTIME_DIR, f));
      }
    }
  } catch {
    // Silencioso - no es crítico
  }
}

// ─── Lectura para API ───────────────────────────────────────

function getLatestRun() {
  ensureRuntimeDir();
  return readJsonSafe(LATEST_FILE);
}

function getRunHistory(limit = 20) {
  ensureRuntimeDir();
  return readJsonlSafe(RUNS_FILE, limit);
}

function getRunDetail(runId) {
  ensureRuntimeDir();
  const filePath = path.join(RUNTIME_DIR, `run-${runId}.json`);
  return readJsonSafe(filePath);
}

// ─── HTTP con retry ─────────────────────────────────────────

async function requestWithRetry(fn, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        if (attempt === retries) throw err;
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`  ⏳ Rate limit/server error (${status}), retry ${attempt}/${retries} en ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ─── Tiendanube API ─────────────────────────────────────────

async function fetchAllProducts(storeId, accessToken, productId = null) {
  const headers = buildHeaders(accessToken);
  const products = [];

  if (productId) {
    const res = await requestWithRetry(() =>
      axios.get(`${TN_BASE_URL}/${storeId}/products/${productId}`, {
        headers, timeout: 15000
      })
    );
    products.push(res.data);
    return products;
  }

  let page = 1;
  while (true) {
    const res = await requestWithRetry(() =>
      axios.get(`${TN_BASE_URL}/${storeId}/products`, {
        headers,
        timeout: 30000,
        params: { page, per_page: PER_PAGE, fields: 'id,name,variants,images' }
      })
    );

    const batch = res.data;
    if (!batch || batch.length === 0) break;

    products.push(...batch);
    if (batch.length < PER_PAGE) break;

    page++;
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return products;
}

function getProductName(product) {
  if (!product.name) return null;
  if (typeof product.name === 'string') return product.name;
  return product.name.es || product.name.en || Object.values(product.name)[0] || null;
}

function getVariantName(variant) {
  if (variant.values && Array.isArray(variant.values) && variant.values.length > 0) {
    return variant.values.map(v => v.es || v.en || (typeof v === 'string' ? v : Object.values(v)[0] || '')).join(' / ');
  }
  return null;
}

// ─── Lógica de negocio ──────────────────────────────────────

function getVariantStock(variant) {
  if (variant.inventory_levels && Array.isArray(variant.inventory_levels) && variant.inventory_levels.length > 0) {
    return variant.inventory_levels.reduce((sum, loc) => sum + (Number(loc.stock) || 0), 0);
  }
  return Number(variant.stock) || 0;
}

function findWinningVariant(product) {
  const variants = product.variants;
  if (!variants || variants.length === 0) return null;

  const images = product.images;
  if (!images || images.length <= 1) return null;

  const currentFirstImageId = images.reduce((min, img) =>
    (img.position < min.position ? img : min), images[0]).id;

  let winner = null;
  let winnerStock = -1;

  for (const variant of variants) {
    const stock = getVariantStock(variant);

    if (stock > winnerStock) {
      winner = variant;
      winnerStock = stock;
    } else if (stock === winnerStock && winner) {
      const currentHasFirst = winner.image_id === currentFirstImageId;
      const candidateHasFirst = variant.image_id === currentFirstImageId;

      if (candidateHasFirst && !currentHasFirst) {
        winner = variant;
      } else if (!candidateHasFirst && !currentHasFirst) {
        if (variant.id < winner.id) {
          winner = variant;
        }
      }
    }
  }

  return winner;
}

function computeNewImageOrder(images, winnerImageId) {
  const sorted = [...images].sort((a, b) => a.position - b.position);
  const winnerImg = sorted.find(img => img.id === winnerImageId);
  if (!winnerImg) return null;

  if (sorted[0].id === winnerImageId) return null;

  const rest = sorted.filter(img => img.id !== winnerImageId);
  return [winnerImg, ...rest];
}

async function updateImagePositions(storeId, accessToken, productId, newOrder) {
  const headers = buildHeaders(accessToken);

  for (let i = 0; i < newOrder.length; i++) {
    const img = newOrder[i];
    const newPosition = i + 1;
    if (img.position === newPosition) continue;

    await callTiendanubeWrite(
      {
        method: 'put',
        url: `${TN_BASE_URL}/${storeId}/products/${productId}/images/${img.id}`,
        data: { position: newPosition },
        headers,
        timeout: 15000,
      },
      { context: `image-position#prod:${productId}/img:${img.id}` }
    );
  }
}

// ─── Sync principal ─────────────────────────────────────────

async function syncProductImages({ dryRun = false, productId = null, triggerSource = 'manual' } = {}) {
  ensureRuntimeDir();

  // Check de integración habilitada
  const syncImagesEnabled = await tnConfig.isSyncImagesEnabled();
  if (!syncImagesEnabled) {
    console.log(`🚫 [ImageSync] Sync deshabilitado - source=${triggerSource}`);
    return {
      run_id: null,
      status: 'skipped',
      reason: 'integration_disabled'
    };
  }

  // Lock
  if (!acquireLock(triggerSource)) {
    return null; // otra corrida en progreso
  }

  const runId = generateRunId();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const result = {
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    duration_ms: 0,
    status: 'running',
    dry_run: dryRun,
    trigger_source: triggerSource,
    products_scanned: 0,
    products_changed: 0,
    products_skipped: 0,
    errors_count: 0,
    changed_products: [],
    errors: [],
    items: []
  };

  try {
    const config = getConfig();
    const { storeId, accessToken } = config;

    console.log(`\n🔄 [ImageSync] Corrida ${runId} iniciada ${dryRun ? '(DRY RUN)' : ''}`);
    console.log(`   Store: ${storeId}${productId ? `, Producto: ${productId}` : ', Todos los productos'}`);
    console.log(`   Trigger: ${triggerSource}`);

    let products;
    try {
      products = await fetchAllProducts(storeId, accessToken, productId);
    } catch (err) {
      console.error(`❌ [ImageSync] Error obteniendo productos: ${err.message}`);
      result.errors_count++;
      result.errors.push({ product_id: null, message: `fetch error: ${err.message}` });
      result.status = 'failed';
      return result;
    }

    console.log(`📦 [ImageSync] ${products.length} productos obtenidos`);

    for (const product of products) {
      result.products_scanned++;
      const item = {
        product_id: product.id,
        product_name: getProductName(product),
        winning_variant_id: null,
        variant_name: null,
        winning_image_id: null,
        previous_first_image_id: null,
        changed: false,
        reason: '',
        error_message: null
      };

      try {
        const variants = product.variants;
        const images = product.images;

        if (!variants || variants.length === 0) {
          item.reason = 'sin variantes';
          result.products_skipped++;
          result.items.push(item);
          continue;
        }

        if (!images || images.length <= 1) {
          item.reason = images?.length === 1 ? 'solo 1 imagen' : 'sin imagenes';
          result.products_skipped++;
          result.items.push(item);
          continue;
        }

        const sortedImages = [...images].sort((a, b) => a.position - b.position);
        item.previous_first_image_id = sortedImages[0].id;

        const winner = findWinningVariant(product);
        if (!winner) {
          item.reason = 'no se pudo determinar variante ganadora';
          result.products_skipped++;
          result.items.push(item);
          continue;
        }

        item.winning_variant_id = winner.id;
        item.variant_name = getVariantName(winner);

        if (!winner.image_id) {
          item.reason = 'variante ganadora sin image_id';
          result.products_skipped++;
          result.items.push(item);
          continue;
        }

        item.winning_image_id = winner.image_id;

        const imageExists = images.some(img => img.id === winner.image_id);
        if (!imageExists) {
          item.reason = 'image_id no encontrada en imagenes del producto';
          result.products_skipped++;
          result.items.push(item);
          continue;
        }

        const newOrder = computeNewImageOrder(images, winner.image_id);
        if (!newOrder) {
          item.reason = 'imagen ganadora ya en posicion 1';
          result.products_skipped++;
          result.items.push(item);
          continue;
        }

        if (dryRun) {
          item.changed = true;
          item.reason = 'DRY RUN - cambiaria orden';
          console.log(`  🏷️  Producto ${product.id}: moveria imagen ${winner.image_id} a posicion 1 (era ${item.previous_first_image_id})`);
        } else {
          await updateImagePositions(storeId, accessToken, product.id, newOrder);
          item.changed = true;
          item.reason = 'imagen reordenada';
          console.log(`  ✅ Producto ${product.id}: imagen ${winner.image_id} → posicion 1 (era ${item.previous_first_image_id})`);
        }

        result.products_changed++;
        result.changed_products.push({
          product_id: product.id,
          product_name: item.product_name,
          winning_variant_id: winner.id,
          variant_name: item.variant_name,
          winning_image_id: winner.image_id,
          previous_first_image_id: item.previous_first_image_id,
          reason: item.reason
        });
      } catch (err) {
        item.reason = 'error';
        item.error_message = err.message;
        result.errors_count++;
        result.errors.push({ product_id: product.id, message: err.message });
        console.error(`  ❌ Producto ${product.id}: ${err.message}`);
      }

      result.items.push(item);
    }

    // Determinar status
    if (result.errors_count === 0) {
      result.status = 'success';
    } else if (result.products_changed > 0 || result.products_skipped > 0) {
      result.status = 'partial';
    } else {
      result.status = 'failed';
    }

    return result;
  } finally {
    result.finished_at = new Date().toISOString();
    result.duration_ms = Date.now() - startMs;

    console.log(`\n📊 [ImageSync] Resumen (${result.run_id}):`);
    console.log(`   Status:     ${result.status}`);
    console.log(`   Escaneados: ${result.products_scanned}`);
    console.log(`   Cambiados:  ${result.products_changed}`);
    console.log(`   Saltados:   ${result.products_skipped}`);
    console.log(`   Errores:    ${result.errors_count}`);
    console.log(`   Duracion:   ${result.duration_ms}ms`);
    console.log(`   ${dryRun ? '(DRY RUN - no se aplicaron cambios)' : ''}\n`);

    // Persistir resultado
    if (result.status !== 'running') {
      persistRunResult(result);
    }

    releaseLock();
  }
}

// ─── Scheduler ──────────────────────────────────────────────

let schedulerInterval = null;

function startScheduler(intervalMs = 60 * 60 * 1000) {
  if (schedulerInterval) {
    console.log('⚠️  [ImageSync] Scheduler ya está corriendo');
    return;
  }

  ensureRuntimeDir();
  console.log(`⏰ [ImageSync] Scheduler iniciado, cada ${intervalMs / 1000 / 60} minutos`);

  // Primera ejecución
  syncProductImages({ triggerSource: 'scheduler' }).catch(err => {
    console.error(`❌ [ImageSync] Error en ejecución programada: ${err.message}`);
  });

  schedulerInterval = setInterval(() => {
    console.log('⏰ [ImageSync] Scheduler disparó nueva corrida');
    syncProductImages({ triggerSource: 'scheduler' }).catch(err => {
      console.error(`❌ [ImageSync] Error en ejecución programada: ${err.message}`);
    });
  }, intervalMs);
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🛑 [ImageSync] Scheduler detenido');
  }
}

// ─── Exports ────────────────────────────────────────────────

module.exports = {
  syncProductImages,
  startScheduler,
  stopScheduler,
  // Lectura para API/panel
  getLatestRun,
  getRunHistory,
  getRunDetail,
  // Lock (para tests)
  acquireLock,
  releaseLock,
  // Lógica pura (para tests)
  getVariantStock,
  findWinningVariant,
  computeNewImageOrder,
  // Internals (para tests)
  fetchAllProducts,
  updateImagePositions,
  ensureRuntimeDir,
  persistRunResult,
  RUNTIME_DIR,
  LOCK_FILE
};
