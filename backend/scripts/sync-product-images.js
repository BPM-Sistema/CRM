#!/usr/bin/env node

/**
 * Script CLI para ejecutar el sync de imágenes de productos Tiendanube.
 *
 * Uso:
 *   node scripts/sync-product-images.js                        # Todos los productos
 *   node scripts/sync-product-images.js --dry-run              # Sin aplicar cambios
 *   node scripts/sync-product-images.js --product-id 12345     # Un producto específico
 *   node scripts/sync-product-images.js --dry-run --product-id 12345
 *   node scripts/sync-product-images.js --output json          # Salida JSON
 */

require('dotenv').config();

const { syncProductImages } = require('../services/tiendanubeImageSync');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { dryRun: false, productId: null, output: 'pretty' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--product-id' && args[i + 1]) {
      options.productId = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      options.output = args[i + 1];
      i++;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  if (options.output === 'pretty') {
    console.log('='.repeat(60));
    console.log('  Tiendanube Image Sync - Ejecucion Manual');
    console.log('='.repeat(60));
  }

  const result = await syncProductImages({
    dryRun: options.dryRun,
    productId: options.productId,
    triggerSource: 'manual'
  });

  if (!result) {
    console.error('❌ No se pudo ejecutar: hay otra corrida en progreso');
    process.exit(1);
  }

  if (options.output === 'json') {
    console.log(JSON.stringify(result, null, 2));
  }

  if (result.errors_count > 0 && result.products_changed === 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(`❌ Error fatal: ${err.message}`);
  process.exit(1);
});
