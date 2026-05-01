/**
 * WhatsApp Queue Helper
 *
 * Punto único de encolado a BullMQ para envíos de WhatsApp. Todo envío pasa por acá:
 * - INSERT pending en whatsapp_messages (para tracking).
 * - Push a la cola 'whatsapp' con rate limit global (1 msg / 3s, ver workers/whatsapp.worker.js).
 * - Dedupe en memoria: misma plantilla + pedido en los últimos 5 minutos se ignora.
 *
 * Extraído de index.js para que lib/whatsapp-helpers también pueda usarlo sin
 * llamar a Botmaker directamente (evita saltear la cola y el rate limit).
 */

const crypto = require('crypto');
const pool = require('../db');
const { apiLogger: log } = require('./logger');
const { logEvento } = require('../utils/logging');

const _recentWhatsApp = new Map();

async function queueWhatsApp({ telefono, plantilla, variables, orderNumber }) {
  // Bloquear todos los WhatsApp para "local local" (excepto resenia_maps)
  if (orderNumber && plantilla !== 'resenia_maps') {
    try {
      const localCheck = await pool.query(
        `SELECT customer_name FROM orders_validated WHERE order_number = $1`,
        [String(orderNumber).replace('#', '').trim()]
      );
      if (localCheck.rows[0] && localCheck.rows[0].customer_name?.trim().toLowerCase() === 'local local') {
        log.info({ orderNumber, plantilla }, 'WhatsApp skipped — local local customer');
        return;
      }
    } catch { /* si falla el check, continuar normalmente */ }
  }

  // Deduplicar: misma plantilla + pedido en los últimos 5 minutos → skip
  if (orderNumber) {
    const varSuffix = variables?.['3'] ? `:${variables['3']}` : '';
    const dedupeKey = `${orderNumber}:${plantilla}${varSuffix}`;
    const lastSent = _recentWhatsApp.get(dedupeKey);
    if (lastSent && Date.now() - lastSent < 5 * 60 * 1000) {
      log.info({ orderNumber, plantilla }, 'WhatsApp skipped — duplicate within 5min');
      return;
    }
    _recentWhatsApp.set(dedupeKey, Date.now());
    if (_recentWhatsApp.size > 500) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, v] of _recentWhatsApp) { if (v < cutoff) _recentWhatsApp.delete(k); }
    }
  }

  log.info({ orderNumber, plantilla }, '[WHATSAPP] Encolando mensaje');

  const msgRequestId = crypto.randomUUID();
  const { whatsappQueue } = require('./queues');

  if (whatsappQueue) {
    if (orderNumber) {
      try {
        await pool.query(
          `INSERT INTO whatsapp_messages (request_id, order_number, template, template_key, contact_id, variables, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           ON CONFLICT (request_id) DO NOTHING`,
          [msgRequestId, orderNumber, plantilla, plantilla, telefono, JSON.stringify(variables)]
        );
      } catch (dbErr) {
        log.error({ err: dbErr.message }, 'Error creando registro pending WhatsApp');
      }
    }

    await whatsappQueue.add('send-whatsapp', {
      telefono, plantilla, variables, orderNumber,
      requestId: msgRequestId
    }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 }
    });
    log.info({ orderNumber, plantilla, requestId: msgRequestId }, 'WhatsApp message enqueued');
    if (orderNumber) {
      await logEvento({ orderNumber: String(orderNumber), accion: `whatsapp_encolado: ${plantilla}`, origen: 'sistema' });
    }
    return { queued: true, requestId: msgRequestId };
  }

  // Sin cola → no enviar. Alertar por email.
  log.error({ orderNumber, plantilla }, 'WhatsApp queue unavailable — mensaje NO enviado');

  // Tests no deben disparar emails reales. Si NODE_ENV es 'test', cortamos
  // acá. (Incidente real: correr `jest tests/remitos.test.js` confirmaba un
  // remito de fixture y mandaba email a la casilla de notificaciones.)
  if (process.env.NODE_ENV === 'test') {
    return { queued: false, reason: 'queue_unavailable_test_mode' };
  }

  const { sendNotification } = require('./email');
  sendNotification({
    subject: `[CRM] WhatsApp NO enviado — pedido #${orderNumber || 'N/A'}`,
    body: `La cola de WhatsApp no está disponible.\n\nPedido: #${orderNumber || 'N/A'}\nPlantilla: ${plantilla}\nTeléfono: ${telefono}\nVariables: ${JSON.stringify(variables)}\n\nEl mensaje NO fue enviado. Verificar Redis y la cola.`,
  }).catch(() => {});
  return { queued: false, reason: 'queue_unavailable' };
}

module.exports = { queueWhatsApp };
