const axios = require('axios');

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL; // Slack or Discord webhook

const ALERT_LEVELS = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

async function sendAlert({ level, title, message, details = {} }) {
  console.log(`[ALERT][${level}] ${title}: ${message}`);

  if (!ALERT_WEBHOOK_URL) return; // No webhook configured, just log

  const color = level === 'critical' ? '#FF0000' : level === 'warning' ? '#FFA500' : '#36a64f';

  const payload = {
    // Slack-compatible format
    attachments: [{
      color,
      title: `[${level.toUpperCase()}] ${title}`,
      text: message,
      fields: Object.entries(details).map(([key, value]) => ({
        title: key,
        value: String(value),
        short: true
      })),
      ts: Math.floor(Date.now() / 1000)
    }]
  };

  try {
    await axios.post(ALERT_WEBHOOK_URL, payload, { timeout: 5000 });
  } catch (err) {
    console.error('[ALERT] Failed to send alert:', err.message);
  }
}

// Pre-configured alert functions
const alerts = {
  queueBacklog(queueName, count) {
    return sendAlert({
      level: ALERT_LEVELS.WARNING,
      title: 'Queue Backlog',
      message: `Cola ${queueName} tiene ${count} jobs pendientes`,
      details: { queue: queueName, pending: count }
    });
  },

  queueFailed(queueName, jobId, error) {
    return sendAlert({
      level: ALERT_LEVELS.CRITICAL,
      title: 'Job Failed (DLQ)',
      message: `Job ${jobId} en cola ${queueName} falló definitivamente`,
      details: { queue: queueName, jobId, error: error?.substring(0, 200) }
    });
  },

  circuitBreakerOpen(serviceName) {
    return sendAlert({
      level: ALERT_LEVELS.CRITICAL,
      title: 'Circuit Breaker Open',
      message: `Circuit breaker para ${serviceName} se abrió. Servicio degradado.`,
      details: { service: serviceName }
    });
  },

  integrationDown(serviceName, error) {
    return sendAlert({
      level: ALERT_LEVELS.CRITICAL,
      title: 'Integration Down',
      message: `${serviceName} no responde`,
      details: { service: serviceName, error: error?.substring(0, 200) }
    });
  },

  paymentInconsistency(orderNumber, details) {
    return sendAlert({
      level: ALERT_LEVELS.CRITICAL,
      title: 'Payment Inconsistency',
      message: `Pedido ${orderNumber} tiene inconsistencia de pago`,
      details: { orderNumber, ...details }
    });
  },

  dbPoolExhausted(stats) {
    return sendAlert({
      level: ALERT_LEVELS.CRITICAL,
      title: 'DB Pool Exhausted',
      message: 'Pool de conexiones DB está saturado',
      details: stats
    });
  },

  syncFailure(source, error) {
    return sendAlert({
      level: ALERT_LEVELS.WARNING,
      title: 'Sync Failure',
      message: `Sincronización desde ${source} falló`,
      details: { source, error: error?.substring(0, 200) }
    });
  }
};

module.exports = { sendAlert, alerts, ALERT_LEVELS };
