const { Pool } = require('pg');
require('dotenv').config();

// Cloud SQL uses Unix socket: /cloudsql/PROJECT:REGION:INSTANCE
// TCP for local dev or Cloud SQL Auth Proxy
const isCloudSQL = process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/');

const poolConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 25,
  min: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: '60s'
};

if (isCloudSQL) {
  // Cloud SQL via Unix socket (Cloud Run)
  poolConfig.host = process.env.DB_HOST;
} else {
  // TCP connection (local dev or Cloud SQL Auth Proxy)
  poolConfig.host = process.env.DB_HOST;
  poolConfig.port = Number(process.env.DB_PORT) || 5432;
  // Disable SSL for localhost connections (Cloud SQL Proxy)
  const isLocalhost = process.env.DB_HOST === '127.0.0.1' || process.env.DB_HOST === 'localhost';
  poolConfig.ssl = isLocalhost ? false : { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

const dbLabel = isCloudSQL ? 'CLOUD SQL' : 'TCP';
pool.on('connect', (client) => {
  client.query("SET timezone = 'America/Argentina/Buenos_Aires'");
  console.log(`[DB] Connected to PostgreSQL (${dbLabel})`);
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Pool monitoring - log stats every 60 seconds in development
if (process.env.NODE_ENV !== 'production') {
  setInterval(() => {
    const { totalCount, idleCount, waitingCount } = pool;
    if (totalCount > 0) {
      console.log(`[DB Pool] total=${totalCount} idle=${idleCount} waiting=${waitingCount}`);
    }
  }, 60000).unref();
}

function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  };
}

module.exports = pool;
module.exports.pool = pool;
module.exports.getPoolStats = getPoolStats;
