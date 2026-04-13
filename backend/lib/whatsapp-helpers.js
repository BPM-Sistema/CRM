/**
 * WhatsApp Helper Functions
 *
 * Funciones para envio de mensajes WhatsApp via Botmaker.
 * Extraidas de index.js para uso compartido.
 *
 * Template resolution uses the catalog-based system (plantilla_tipos + financiera_plantillas).
 * NO hardcoded mappings. Config keys are derived dynamically from plantilla key.
 */

const axios = require('axios');
const { callBotmaker } = require('./circuitBreaker');
const pool = require('../db');
const { whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('../services/integrationConfig');
const { apiLogger: log } = require('./logger');
const { getPlantillaFinal, getPlantillaTipos } = require('./plantilla-resolver');

/**
 * Normaliza número de teléfono argentino para WhatsApp
 * Argentina móvil requiere +549 seguido del código de área (sin 0) y número (sin 15)
 * Ejemplo: +541144094585 → +5491144094585
 */
function normalizeArgentinaPhone(phone) {
  if (!phone) return phone;

  // Si ya tiene +549 o 549 (con o sin +), está correcto
  if (phone.startsWith('+549') || phone.startsWith('549')) {
    return phone.startsWith('+') ? phone : '+' + phone;
  }

  // Si tiene +54 pero no +549, insertar el 9
  if (phone.startsWith('+54')) {
    const normalized = '+549' + phone.slice(3);
    console.log(`📱 Normalizando teléfono AR: ${phone} → ${normalized}`);
    return normalized;
  }

  // Sin +, ej: 541154873554 → +5491154873554
  if (phone.startsWith('54') && !phone.startsWith('549')) {
    const normalized = '+549' + phone.slice(2);
    console.log(`📱 Normalizando teléfono AR (sin +): ${phone} → ${normalized}`);
    return normalized;
  }

  // Otros países o formatos, no tocar
  return phone;
}

/**
 * Derive the integration config key from plantilla key
 * No hardcoded mapping - convention based: plantilla_key -> whatsapp_tpl_plantilla_key
 */
function getConfigKey(plantillaKey) {
  return `whatsapp_tpl_${plantillaKey}`;
}

async function enviarWhatsAppPlantilla({ telefono, plantilla, variables, orderNumber = null }) {
  // Verificar que el tipo de plantilla exista en el catálogo
  const tipos = await getPlantillaTipos();
  const tipoExiste = tipos.some(t => t.key === plantilla);

  if (!tipoExiste) {
    log.warn({ plantilla }, 'WhatsApp template type not found in catalog, skipping');
    return { data: { skipped: true, reason: 'template_type_not_found' } };
  }

  // Verificar si la plantilla está habilitada (config key derivado dinámicamente)
  const configKey = getConfigKey(plantilla);
  const enabled = await isIntegrationEnabled(configKey, { context: `plantilla:${plantilla}` });
  if (!enabled) {
    log.info({ plantilla, configKey }, 'WhatsApp template disabled by toggle');
    return { data: { skipped: true, reason: 'template_disabled' } };
  }

  // Filtro de testing desde integrationConfig (con cache)
  // FAIL-SAFE: si no se puede leer config, bloquear envío para no enviar a cliente real
  const testingConfig = await waConfig.getTestingConfig();

  if (testingConfig === null) {
    console.error('❌ WhatsApp bloqueado: no se pudo leer config de testing');
    return { data: { skipped: true, reason: 'testing_config_unavailable' } };
  }

  if (testingConfig.enabled) {
    const testingPhone = testingConfig.testingPhone;
    if (!testingPhone) {
      console.log('📵 WhatsApp ignorado: modo testing activo pero sin número configurado');
      return { data: { skipped: true, reason: 'testing_no_phone' } };
    }
    console.log(`🧪 WhatsApp testing: redirigiendo de ${telefono} → ${testingPhone}`);
    telefono = testingPhone;
  }

  // Normalizar número argentino (agregar 9 si falta)
  telefono = normalizeArgentinaPhone(telefono);

  // Resolve template name using catalog-based system
  // No hardcoded logic - uses explicit mappings from database
  const plantillaFinal = await getPlantillaFinal(plantilla);

  // Obtener channelId desde config (con fallback a env var)
  const channelId = await waConfig.getChannelId();
  if (!channelId) {
    console.error('❌ WhatsApp bloqueado: no hay channelId configurado');
    return { data: { skipped: true, reason: 'no_channel_id' } };
  }

  console.log('📤 Enviando WhatsApp a:', telefono, 'plantilla:', plantillaFinal);

  const contactIdClean = telefono.replace('+', '');

  try {
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
      }
    });

    // Guardar en tracking si tenemos requestId
    const requestId = response.data?.requestId;
    if (requestId) {
      try {
        await pool.query(`
          INSERT INTO whatsapp_messages (request_id, order_number, template, contact_id, variables, status)
          VALUES ($1, $2, $3, $4, $5, 'pending')
          ON CONFLICT (request_id) DO NOTHING
        `, [requestId, orderNumber, plantillaFinal, contactIdClean, JSON.stringify(variables)]);
        console.log(`📝 WhatsApp tracked: ${requestId} (pedido: ${orderNumber || 'N/A'})`);
      } catch (dbErr) {
        console.error('⚠️ Error guardando tracking WhatsApp:', dbErr.message);
      }
    }

    return response;
  } catch (err) {
    console.error('❌ Error enviando WhatsApp:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  enviarWhatsAppPlantilla,
  getConfigKey,
  normalizeArgentinaPhone,
};
