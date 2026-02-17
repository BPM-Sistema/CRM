require('dotenv').config()

const { testTiendanubeOrdersEndpoint } = require('../services/orderSync')

async function run() {
  console.log('=== DIAGNÓSTICO TIENDANUBE ===\n')
  await testTiendanubeOrdersEndpoint()
  process.exit(0)
}

run()
