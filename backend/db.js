const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  },
  max: 25,
  min: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: '30s'
});

pool.on('connect', () => {
  console.log('[DB] Connected to PostgreSQL (SUPABASE POOLER)');
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
