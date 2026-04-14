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
const { callBotmaker } = require('../lib/circuitBreaker');
const pool = require('../db');
const { workerLogger: log } = require('../lib/logger');
const { whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('../services/integrationConfig');
const { getConfigKey, normalizeArgentinaPhone } = require('../lib/whatsapp-helpers');
const { getPlantillaFinal, getPlantillaTipos } = require('../lib/plantilla-resolver');

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

  // 1. Verificar que el tipo de plantilla exista en el catálogo
  const tipos = await getPlantillaTipos();
  const tipoExiste = tipos.some(t => t.key === plantilla);
  if (!tipoExiste) {
    jobLog.warn('Tipo de plantilla no existe en catálogo');
    return { status: 'skipped', reason: 'template_type_not_found' };
  }

  // 2. Verificar si la plantilla está habilitada (config key derivado dinámicamente)
  const configKey = getConfigKey(plantilla);
  const enabled = await isIntegrationEnabled(configKey, { context: `plantilla:${plantilla}` });
  if (!enabled) {
    jobLog.info('Plantilla deshabilitada por toggle');
    return { status: 'skipped', reason: 'template_disabled' };
  }

  // 2. Verificar modo testing (fail-safe: si no se puede leer config, bloquear envío)
  const testingConfig = await waConfig.getTestingConfig();
  if (testingConfig === null) {
    jobLog.error('No se pudo leer config de testing — bloqueando envio por seguridad');
    throw new Error('Testing config unavailable — refusing to send to avoid leaking to real customer');
  }
  if (testingConfig.enabled) {
    const testingPhone = testingConfig.testingPhone;
    if (!testingPhone) {
      jobLog.info('Modo testing activo pero sin numero configurado');
      return { status: 'skipped', reason: 'testing_no_phone' };
    }
    jobLog.info({ from: telefono, to: testingPhone }, 'Testing: redirigiendo telefono');
    telefono = testingPhone;
  }

  // Normalizar número argentino (agregar 9 si falta)
  const telefonoNormalizado = normalizeArgentinaPhone(telefono);
  if (telefonoNormalizado !== telefono) {
    jobLog.info({ from: telefono, to: telefonoNormalizado }, 'Normalizando telefono AR');
    telefono = telefonoNormalizado;
  }

  // 2.5 Prevenir duplicados en retry: si ya enviamos este mensaje, no reenviar
  if (job.attemptsMade > 0 && orderNumber) {
    const duplicateCheck = await pool.query(
      `SELECT 1 FROM whatsapp_messages
       WHERE order_number = $1
       AND created_at > NOW() - INTERVAL '5 minutes'
       LIMIT 1`,
      [orderNumber]
    );
    if (duplicateCheck.rows.length > 0) {
      jobLog.info({ attemptsMade: job.attemptsMade }, 'Retry omitido: mensaje ya enviado para este pedido');
      return { status: 'skipped', reason: 'duplicate_prevented' };
    }
  }

  // 3. Resolve template using catalog-based system (no hardcoded logic)
  const plantillaFinal = await getPlantillaFinal(plantilla);
  jobLog.debug({ plantillaFinal }, 'Template resolved');

  // 4. Obtener channelId desde config (con fallback a env var)
  const channelId = await waConfig.getChannelId();
  if (!channelId) {
    jobLog.error('No hay channelId configurado');
    throw new Error('No channel ID configured');
  }

  // 5. Enviar via Botmaker API
  const contactIdClean = telefono.replace('+', '');

  const response = await callBotmaker({
    method: 'post',
    url: 'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
    data: {
      chat: {
        channelId,
        contactId: contactIdClean
      },
      intentIdOrName: plantillaFinal,
      variables
    },
    headers: {
      'access-token': process.env.BOTMAKER_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  // 6. Guardar en whatsapp_messages para tracking
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
    concurrency: 1,
    limiter: {
      max: 1,
      duration: 3000 // 1 mensaje cada 3 segundos
    },
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
