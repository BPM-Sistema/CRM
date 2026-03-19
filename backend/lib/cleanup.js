const pool = require('../db');

async function runCleanup() {
  const results = { cleaned: {} };

  // 1. Logs antiguos (>90 días)
  try {
    const r = await pool.query(`
      DELETE FROM logs WHERE created_at < NOW() - INTERVAL '90 days'
    `);
    results.cleaned.logs = r.rowCount;
  } catch (err) {
    console.error('[Cleanup] logs error:', err.message);
  }

  // 2. WhatsApp messages antiguos (>60 días)
  try {
    const r = await pool.query(`
      DELETE FROM whatsapp_messages WHERE created_at < NOW() - INTERVAL '60 days'
    `);
    results.cleaned.whatsapp_messages = r.rowCount;
  } catch (err) {
    console.error('[Cleanup] whatsapp_messages error:', err.message);
  }

  // 3. Notifications leídas (>30 días)
  try {
    const r = await pool.query(`
      DELETE FROM notifications WHERE leida = true AND created_at < NOW() - INTERVAL '30 days'
    `);
    results.cleaned.notifications = r.rowCount;
  } catch (err) {
    console.error('[Cleanup] notifications error:', err.message);
  }

  // 4. sync_queue completados (>7 días) - refuerzo del cleanup en syncQueue.js
  try {
    const r = await pool.query(`
      DELETE FROM sync_queue WHERE status = 'completed' AND processed_at < NOW() - INTERVAL '7 days'
    `);
    results.cleaned.sync_queue = r.rowCount;
  } catch (err) {
    console.error('[Cleanup] sync_queue error:', err.message);
  }

  // 5. order_inconsistencies resueltas (>30 días)
  try {
    const r = await pool.query(`
      DELETE FROM order_inconsistencies WHERE resolved = true AND resolved_at < NOW() - INTERVAL '30 days'
    `);
    results.cleaned.order_inconsistencies = r.rowCount;
  } catch (err) {
    console.error('[Cleanup] order_inconsistencies error:', err.message);
  }

  const total = Object.values(results.cleaned).reduce((a, b) => a + (b || 0), 0);
  if (total > 0) {
    console.log(`[Cleanup] Limpiados ${total} registros:`, results.cleaned);
  }

  return results;
}

module.exports = { runCleanup };
