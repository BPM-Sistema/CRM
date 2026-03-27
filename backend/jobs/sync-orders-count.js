/**
 * Cloud Run Job: Sync orders count from Tiendanube
 * Run with: node jobs/sync-orders-count.js
 */

require('dotenv').config();
const { syncOrdersCountByCustomer } = require('../services/customerSync');

async function main() {
  console.log('='.repeat(50));
  console.log('SYNC ORDERS COUNT - Cloud Run Job');
  console.log('Started at:', new Date().toISOString());
  console.log('='.repeat(50));

  try {
    const result = await syncOrdersCountByCustomer((progress) => {
      // Log progress every 50 customers
      console.log(`Progress: ${progress.processed}/${progress.total} (updated: ${progress.updated}, errors: ${progress.errors})`);
    });

    console.log('='.repeat(50));
    console.log('COMPLETED');
    console.log('Result:', JSON.stringify(result, null, 2));
    console.log('Finished at:', new Date().toISOString());
    console.log('='.repeat(50));

    process.exit(0);
  } catch (error) {
    console.error('='.repeat(50));
    console.error('FAILED');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('='.repeat(50));
    process.exit(1);
  }
}

main();
