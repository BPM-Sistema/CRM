/**
 * WhatsApp Worker
 *
 * Envia mensajes via Botmaker, reemplazando patrones fire-and-forget.
 * Maneja retries automaticos con backoff exponencial.
 *
 * Cola: whatsapp
 */

const { Worker } = require('bullmq');
const axios = require('axios');
const pool = require('../db');
const { workerLogger: log } = require('../lib/logger');
const { whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('../services/integrationConfig');

// Plantillas que NO llevan sufijo de financiera
const PLANTILLAS_SIN_SUFIJO = [
  'datos__envio',
  'comprobante_rechazado',
  'comprobante_confirmado',
  'enviado_env_nube',
  'enviado_transporte',
  'pedido_cancelado'
];

// Mapeo de plantilla base -> key en integration_config
const PLANTILLA_CONFIG_KEY = {
  'pedido_creado': 'whatsapp_tpl_pedido_creado',
  'comprobante_confirmado': 'whatsapp_tpl_comprobante_confirmado',
  'comprobante_rechazado': 'whatsapp_tpl_comprobante_rechazado',
  'datos__envio': 'whatsapp_tpl_datos_envio',
  'enviado_env_nube': 'whatsapp_tpl_enviado_env_nube',
  'pedido_cancelado': 'whatsapp_tpl_pedido_cancelado',
  'partial_paid': 'whatsapp_tpl_partial_paid',
  'enviado_transporte': 'whatsapp_tpl_enviado_transporte'
};

/**
 * Procesador principal del job WhatsApp
 */
async function processWhatsAppJob(job) {
  const {
    telefono: telefonoOriginal,
    plantilla,
    variables,
    orderNumber,
    requestId
  } = job.data;

  const jobLog = log.child({ requestId, jobId: job.id, plantilla, orderNumber });
  jobLog.info({ telefono: telefonoOriginal }, 'Procesando envio WhatsApp');

  let telefono = telefonoOriginal;

  // 1. Verificar si la plantilla esta habilitada
  const configKey = PLANTILLA_CONFIG_KEY[plantilla];
  if (configKey) {
    const enabled = await isIntegrationEnabled(configKey, { context: `plantilla:${plantilla}` });
    if (!enabled) {
      jobLog.info('Plantilla deshabilitada por toggle');
      return { status: 'skipped', reason: 'template_disabled' };
    }
  }

  // 2. Verificar modo testing
  const testingConfig = await waConfig.getTestingConfig();
  if (testingConfig?.enabled) {
    const testingPhone = testingConfig.testingPhone;
    if (!testingPhone) {
      jobLog.info('Modo testing activo pero sin numero configurado');
      return { status: 'skipped', reason: 'testing_no_phone' };
    }
    jobLog.info({ from: telefono, to: testingPhone }, 'Testing: redirigiendo telefono');
    telefono = testingPhone;
  }

  // 3. Determinar sufijo de financiera
  let plantillaFinal = plantilla;
  if (!PLANTILLAS_SIN_SUFIJO.includes(plantilla)) {
    try {
      const finResult = await pool.query(
        `SELECT nombre FROM financieras WHERE is_default = true LIMIT 1`
      );
      if (finResult.rows.length > 0) {
        const nombreFinanciera = finResult.rows[0].nombre.toLowerCase();
        if (nombreFinanciera.includes('wanda')) {
          plantillaFinal = `${plantilla}_wanda_v2`;
        } else if (nombreFinanciera.includes('kiesel')) {
          plantillaFinal = `${plantilla}_kiesel_v2`;
        }
        jobLog.debug({ financiera: finResult.rows[0].nombre, plantillaFinal }, 'Sufijo financiera aplicado');
      }
    } catch (err) {
      jobLog.error({ err: err.message }, 'Error obteniendo financiera default');
    }
  }

  // 4. Enviar via Botmaker API
  const contactIdClean = telefono.replace('+', '');

  const response = await axios.post(
    'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
    {
      chat: {
        channelId: process.env.BOTMAKER_CHANNEL_ID,
        contactId: contactIdClean
      },
      intentIdOrName: plantillaFinal,
      variables
    },
    {
      headers: {
        'access-token': process.env.BOTMAKER_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  // 5. Guardar en whatsapp_messages para tracking
  const botmakerRequestId = response.data?.requestId || requestId;
  try {
    await pool.query(
      `INSERT INTO whatsapp_messages (request_id, order_number, template, contact_id, variables, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (request_id) DO NOTHING`,
      [botmakerRequestId, orderNumber, plantillaFinal, contactIdClean, JSON.stringify(variables)]
    );
    jobLog.info({ botmakerRequestId, contactId: contactIdClean }, 'WhatsApp enviado y tracked');
  } catch (dbErr) {
    jobLog.error({ err: dbErr.message }, 'Error guardando tracking WhatsApp');
    // No re-throw: el mensaje ya se envio, el tracking es secundario
  }

  return {
    status: 'sent',
    plantillaFinal,
    contactId: contactIdClean,
    botmakerRequestId
  };
}

/**
 * Crea e inicia el WhatsApp worker
 */
function createWhatsAppWorker(connection) {
  const worker = new Worker('whatsapp', processWhatsAppJob, {
    connection,
    concurrency: 5,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000 // 10s, 20s, 40s
      },
      removeOnComplete: { count: 2000 },
      removeOnFail: { count: 10000 }
    }
  });

  worker.on('completed', (job, result) => {
    log.info({
      jobId: job.id,
      plantilla: job.data?.plantilla,
      status: result?.status,
      orderNumber: job.data?.orderNumber
    }, 'WhatsApp job completado');
  });

  worker.on('failed', (job, err) => {
    log.error({
      jobId: job?.id,
      plantilla: job?.data?.plantilla,
      telefono: job?.data?.telefono,
      orderNumber: job?.data?.orderNumber,
      err: err.message,
      attemptsMade: job?.attemptsMade
    }, 'WhatsApp job fallido');
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'WhatsApp worker error');
  });

  return worker;
}

module.exports = { createWhatsAppWorker };
