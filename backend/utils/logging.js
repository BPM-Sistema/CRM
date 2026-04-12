const pool = require('../db');

async function logEvento({ comprobanteId, orderNumber, accion, origen, userId, username }) {
  try {
    await pool.query(
      `INSERT INTO logs (comprobante_id, order_number, accion, origen, user_id, username)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [comprobanteId || null, orderNumber || null, accion, origen, userId || null, username || null]
    );
  } catch (err) {
    console.error('Error guardando log:', err.message);
  }
}

module.exports = { logEvento };
