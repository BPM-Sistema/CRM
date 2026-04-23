/**
 * WhatsApp Helper Functions
 *
 * Funciones para envio de mensajes WhatsApp via Botmaker.
 * Extraidas de index.js para uso compartido.
 *
 * Template resolution uses the catalog-based system (plantilla_tipos + financiera_plantillas).
 * NO hardcoded mappings. Config keys are derived dynamically from plantilla key.
 */

const { whatsapp: waConfig, isEnabled: isIntegrationEnabled } = require('../services/integrationConfig');
const { apiLogger: log } = require('./logger');
const { getPlantillaTipos } = require('./plantilla-resolver');
const { queueWhatsApp } = require('./whatsapp-queue');

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
  // Checks tempranos sincrónicos (así los callers pueden contar "skipped" sin
  // esperar al worker). Si pasan, delegamos a la cola — el worker hace el
  // envío real a Botmaker respetando el rate limit global (1 msg / 3s).

  const tipos = await getPlantillaTipos();
  if (!tipos.some(t => t.key === plantilla)) {
    log.warn({ plantilla }, 'WhatsApp template type not found in catalog, skipping');
    return { data: { skipped: true, reason: 'template_type_not_found' } };
  }

  const configKey = getConfigKey(plantilla);
  const enabled = await isIntegrationEnabled(configKey, { context: `plantilla:${plantilla}` });
  if (!enabled) {
    log.info({ plantilla, configKey }, 'WhatsApp template disabled by toggle');
    return { data: { skipped: true, reason: 'template_disabled' } };
  }

  const testingConfig = await waConfig.getTestingConfig();
  if (testingConfig === null) {
    log.error({ plantilla }, 'WhatsApp bloqueado: no se pudo leer config de testing');
    return { data: { skipped: true, reason: 'testing_config_unavailable' } };
  }
  if (testingConfig.enabled) {
    const testingPhone = testingConfig.testingPhone;
    if (!testingPhone) {
      log.info({ plantilla }, 'WhatsApp ignorado: modo testing activo pero sin número configurado');
      return { data: { skipped: true, reason: 'testing_no_phone' } };
    }
    log.info({ from: telefono, to: testingPhone }, 'WhatsApp testing: redirigiendo teléfono');
    telefono = testingPhone;
  }

  telefono = normalizeArgentinaPhone(telefono);

  // Encolar via BullMQ — el worker hará el POST a Botmaker y pasará el registro
  // de whatsapp_messages de 'pending' a 'sent' (o 'failed' tras 3 intentos).
  const result = await queueWhatsApp({ telefono, plantilla, variables, orderNumber });
  if (result?.queued === false) {
    return { data: { skipped: true, reason: result.reason } };
  }
  return { data: { queued: true, requestId: result?.requestId } };
}

module.exports = {
  enviarWhatsAppPlantilla,
  getConfigKey,
  normalizeArgentinaPhone,
};
