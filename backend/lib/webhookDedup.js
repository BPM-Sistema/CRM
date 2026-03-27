/**
 * Webhook Deduplication
 * Previene procesamiento duplicado de webhooks de TiendaNube
 */

const crypto = require('crypto');
const pool = require('../db');

/**
 * Genera hash determinístico para un evento de cambio de pago
 * El hash se basa en el ESTADO del cambio, no en cuándo llegó el webhook
 */
function hashPaymentChange(orderId, paymentStatus, paidAt, totalPaid) {
  const data = `payment:${orderId}:${paymentStatus}:${paidAt || 'null'}:${totalPaid || 0}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Genera hash para cambio de productos/monto
 */
function hashProductChange(orderId, totalAmount, productIds) {
  const sortedProducts = (productIds || []).sort().join(',');
  const data = `products:${orderId}:${totalAmount}:${sortedProducts}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Genera hash para cambio de shipping
 */
function hashShippingChange(orderId, shippingStatus) {
  const data = `shipping:${orderId}:${shippingStatus}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Genera hash genérico para cualquier evento
 */
function hashGenericEvent(eventType, orderId, ...fields) {
  const data = `${eventType}:${orderId}:${fields.join(':')}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Verifica si un evento ya fue procesado
 * @returns {boolean} true si ya fue procesado (duplicado), false si es nuevo
 */
async function isEventProcessed(eventHash) {
  try {
    const result = await pool.query(
      `SELECT 1 FROM webhook_events_processed WHERE event_hash = $1`,
      [eventHash]
    );
    return result.rowCount > 0;
  } catch (err) {
    // Si la tabla no existe aún, permitir el procesamiento
    if (err.code === '42P01') { // undefined_table
      console.warn('[DEDUP] Table webhook_events_processed not found, skipping dedup check');
      return false;
    }
    throw err;
  }
}

/**
 * Marca un evento como procesado
 * @returns {boolean} true si se insertó (nuevo), false si ya existía (duplicado)
 */
async function markEventProcessed({ eventHash, eventType, orderId, orderNumber, changeType }) {
  try {
    const result = await pool.query(`
      INSERT INTO webhook_events_processed (event_hash, event_type, order_id, order_number, change_type)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (event_hash) DO NOTHING
      RETURNING event_hash
    `, [eventHash, eventType, orderId, orderNumber, changeType]);

    return result.rowCount > 0; // true = nuevo, false = duplicado
  } catch (err) {
    // Si la tabla no existe, permitir el procesamiento
    if (err.code === '42P01') {
      console.warn('[DEDUP] Table not found, allowing event');
      return true;
    }
    throw err;
  }
}

/**
 * Limpia eventos procesados de más de N días
 */
async function cleanupOldEvents(days = 7) {
  try {
    const result = await pool.query(`
      DELETE FROM webhook_events_processed
      WHERE processed_at < NOW() - INTERVAL '${days} days'
    `);
    if (result.rowCount > 0) {
      console.log(`[DEDUP] Cleaned up ${result.rowCount} old events`);
    }
    return result.rowCount;
  } catch (err) {
    if (err.code !== '42P01') {
      console.error('[DEDUP] Cleanup error:', err.message);
    }
    return 0;
  }
}

module.exports = {
  hashPaymentChange,
  hashProductChange,
  hashShippingChange,
  hashGenericEvent,
  isEventProcessed,
  markEventProcessed,
  cleanupOldEvents
};
