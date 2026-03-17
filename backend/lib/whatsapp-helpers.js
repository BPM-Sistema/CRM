/**
 * WhatsApp Helper Functions
 *
 * Funciones para envio de mensajes WhatsApp via Botmaker.
 * Extraidas de index.js para uso compartido.
 */

const axios = require('axios');
const pool = require('../db');
const { whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('../services/integrationConfig');
const { apiLogger: log } = require('./logger');

// Plantillas que NO llevan sufijo de financiera
const PLANTILLAS_SIN_SUFIJO = ['datos__envio', 'comprobante_rechazado', 'comprobante_confirmado', 'enviado_env_nube', 'enviado_transporte', 'pedido_cancelado'];

// Mapeo de plantilla base -> key en integration_config
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
  const testingConfig = await waConfig.getTestingConfig();

  if (testingConfig?.enabled) {
    // Modo testing activo: redirigir al numero de testing
    const testingPhone = testingConfig.testingPhone;
    if (!testingPhone) {
      console.log('📵 WhatsApp ignorado: modo testing activo pero sin número configurado');
      return { data: { skipped: true, reason: 'testing_no_phone' } };
    }
    console.log(`🧪 WhatsApp testing: redirigiendo de ${telefono} → ${testingPhone}`);
    telefono = testingPhone;
  }

  // Determinar nombre final de plantilla
  let plantillaFinal = plantilla;

  // Solo agregar sufijo de financiera si la plantilla lo requiere
  if (!PLANTILLAS_SIN_SUFIJO.includes(plantilla)) {
    try {
      const finResult = await pool.query(`
        SELECT nombre
        FROM financieras
        WHERE is_default = true
        LIMIT 1
      `);

      if (finResult.rows.length > 0) {
        const nombreFinanciera = finResult.rows[0].nombre.toLowerCase();
        if (nombreFinanciera.includes('wanda')) {
          plantillaFinal = `${plantilla}_wanda_v2`;
        } else if (nombreFinanciera.includes('kiesel')) {
          plantillaFinal = `${plantilla}_kiesel_v2`;
        }
        console.log(`🏦 Financiera default: ${finResult.rows[0].nombre} → plantilla: ${plantillaFinal}`);
      }
    } catch (err) {
      console.error('⚠️ Error obteniendo financiera default:', err.message);
    }
  } else {
    console.log(`📋 Plantilla sin sufijo: ${plantilla}`);
  }

  console.log('📤 Enviando WhatsApp a:', telefono, 'plantilla:', plantillaFinal);

  const contactIdClean = telefono.replace('+', '');

  try {
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
        }
      }
    );

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
  PLANTILLAS_SIN_SUFIJO,
  PLANTILLA_CONFIG_KEY,
};
