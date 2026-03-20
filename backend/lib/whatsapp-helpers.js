/**
 * WhatsApp Helper Functions
 *
 * Funciones para envio de mensajes WhatsApp via Botmaker.
 * Extraidas de index.js para uso compartido.
 *
 * Template resolution uses the catalog-based system (plantilla_tipos + financiera_plantillas).
 * NO hardcoded suffixes. NO dynamic string construction.
 */

const axios = require('axios');
const { callBotmaker } = require('./circuitBreaker');
const pool = require('../db');
const { whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('../services/integrationConfig');
const { apiLogger: log } = require('./logger');
const { getPlantillaFinal } = require('./plantilla-resolver');

// Mapeo de plantilla base -> key en integration_config (for toggle checks)
const PLANTILLA_CONFIG_KEY = {
  'pedido_creado': 'whatsapp_tpl_pedido_creado',
  'comprobante_confirmado': 'whatsapp_tpl_comprobante_confirmado',
  'comprobante_rechazado': 'whatsapp_tpl_comprobante_rechazado',
  'datos__envio': 'whatsapp_tpl_datos_envio',
  'enviado_env_nube': 'whatsapp_tpl_enviado_env_nube',
  'pedido_cancelado': 'whatsapp_tpl_pedido_cancelado',
  'partial_paid': 'whatsapp_tpl_partial_paid',
  'enviado_transporte': 'whatsapp_tpl_enviado_transporte',
};

async function enviarWhatsAppPlantilla({ telefono, plantilla, variables, orderNumber = null }) {
  // Verificar si la plantilla esta habilitada
  const configKey = PLANTILLA_CONFIG_KEY[plantilla];
  if (configKey) {
    const enabled = await isIntegrationEnabled(configKey, { context: `plantilla:${plantilla}` });
    if (!enabled) {
      log.info({ plantilla, configKey }, 'WhatsApp template disabled by toggle');
      return { data: { skipped: true, reason: 'template_disabled' } };
    }
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

  // Resolve template name using catalog-based system
  // No hardcoded logic - uses explicit mappings from database
  const plantillaFinal = await getPlantillaFinal(plantilla);

  console.log('📤 Enviando WhatsApp a:', telefono, 'plantilla:', plantillaFinal);

  const contactIdClean = telefono.replace('+', '');

  try {
    const response = await callBotmaker({
      method: 'post',
      url: 'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
      data: {
        chat: {
          channelId: process.env.BOTMAKER_CHANNEL_ID,
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
  PLANTILLA_CONFIG_KEY,
};
