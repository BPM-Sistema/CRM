/**
 * Waspy Outbound — cliente HTTP para enviar templates de WhatsApp Business
 * por el canal de marketing/avisos (separado del transaccional Botmaker).
 *
 * Único caller hoy: stockAlertDispatcher (avisos de back-in-stock).
 *
 * Garantías:
 *   - NO toca el flow Botmaker (whatsapp-helpers / whatsapp-queue / whatsapp.worker).
 *   - Replica los safety checks del worker:
 *       1. Testing mode redirect (whatsapp_testing_mode → testingPhone)
 *       2. Normalización AR (+549...)
 *       3. Rate limit 1 msg / 3s
 *   - NO escribe en DB. El caller marca status='notified' después del send OK.
 *   - NO tira excepciones hacia arriba: devuelve {sent: false, reason} si falla,
 *     así el dispatcher decide si marca notified o reintenta en el próximo cron.
 *
 * Config: lee waspy_config.marketing_api_key + marketing_phone_number_id +
 * marketing_base_url (cache 60s en memoria).
 */

const axios = require('axios');
const pool = require('../db');
const { workerLogger: log } = require('../lib/logger');
const { whatsapp: waConfig } = require('./integrationConfig');
const { normalizeArgentinaPhone } = require('../lib/whatsapp-helpers');

const CACHE_TTL_MS = 60 * 1000;
const RATE_LIMIT_MS = 3000;
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_BASE_URL = 'https://api.waspytech.com/api/v2';

let _cfgCache = null;
let _cfgCacheAt = 0;
let _lastSendAt = 0;

async function getMarketingConfig() {
  const now = Date.now();
  if (_cfgCache && now - _cfgCacheAt < CACHE_TTL_MS) return _cfgCache;
  const r = await pool.query(`
    SELECT marketing_api_key, marketing_phone_number_id, marketing_base_url
    FROM waspy_config
    LIMIT 1
  `);
  const row = r.rows[0];
  if (!row || !row.marketing_api_key || !row.marketing_phone_number_id) {
    return null;
  }
  _cfgCache = {
    apiKey: row.marketing_api_key,
    phoneNumberId: row.marketing_phone_number_id,
    baseUrl: row.marketing_base_url || DEFAULT_BASE_URL,
  };
  _cfgCacheAt = now;
  return _cfgCache;
}

function invalidateConfigCache() {
  _cfgCacheAt = 0;
  _cfgCache = null;
}

async function rateLimit() {
  const elapsed = Date.now() - _lastSendAt;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  _lastSendAt = Date.now();
}

function buildStockAlertV2Components({ name, product, handle, headerImageUrl }) {
  return [
    {
      type: 'header',
      parameters: [{ type: 'image', image: { link: headerImageUrl } }],
    },
    {
      type: 'body',
      parameters: [
        { type: 'text', text: name || 'Cliente' },
        { type: 'text', text: product || '' },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: handle || '' }],
    },
  ];
}

/**
 * Envía el template aprobado stock_alert_reingreso_v2 vía Waspy.
 *
 * @param {Object} args
 * @param {string} args.to                  Teléfono destino (en cualquier formato AR; se normaliza).
 * @param {string} [args.templateName]      Default 'stock_alert_reingreso_v2'.
 * @param {string} [args.language]          Default 'es_AR'.
 * @param {Object} args.variables           Convención compartida con Botmaker:
 *                                            '1' = nombre cliente, '2' = producto,
 *                                            '3' = handle del producto,
 *                                            'headerImageUrl' = URL JPG/PNG del header.
 *
 * @returns {Promise<{sent:boolean, reason?:string, providerMessageId?:string, to?:string, status?:number, error?:string, data?:any}>}
 */
async function sendStockAlertTemplate({
  to,
  templateName = 'stock_alert_reingreso_v2',
  language = 'es_AR',
  variables = {},
} = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const cfg = await getMarketingConfig();
  if (!cfg) {
    log.warn('[waspyOutbound] marketing_api_key o marketing_phone_number_id no configurado');
    return { sent: false, reason: 'config_unavailable' };
  }

  const testingConfig = await waConfig.getTestingConfig();
  if (testingConfig === null) {
    log.error('[waspyOutbound] no se pudo leer testing config — bloqueando envio');
    return { sent: false, reason: 'testing_config_unavailable' };
  }
  if (testingConfig.enabled) {
    if (!testingConfig.testingPhone) {
      log.info('[waspyOutbound] testing mode activo sin numero configurado');
      return { sent: false, reason: 'testing_no_phone' };
    }
    log.info({ from: to, testing: testingConfig.testingPhone }, '[waspyOutbound] testing redirect');
    to = testingConfig.testingPhone;
  }

  to = normalizeArgentinaPhone(to);
  if (!to.startsWith('+')) to = '+' + to;

  if (!variables.headerImageUrl) {
    log.warn({ to, templateName }, '[waspyOutbound] sin headerImageUrl — template v2 lo requiere');
    return { sent: false, reason: 'missing_header_image' };
  }

  await rateLimit();

  const components = buildStockAlertV2Components({
    name: variables['1'],
    product: variables['2'],
    handle: variables['3'],
    headerImageUrl: variables.headerImageUrl,
  });

  const payload = {
    phoneNumberId: cfg.phoneNumberId,
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  try {
    const res = await axios.post(`${cfg.baseUrl}/messages`, payload, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const providerMessageId =
      res.data?.id ||
      res.data?.messageId ||
      res.data?.data?.id ||
      null;
    log.info(
      { to, templateName, providerMessageId, status: res.status },
      '[waspyOutbound] sent OK'
    );
    return { sent: true, providerMessageId, to, status: res.status };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    log.error(
      { to, templateName, status, data, msg: err.message },
      '[waspyOutbound] send error'
    );
    return {
      sent: false,
      reason: status ? 'api_error' : 'network_error',
      status,
      error: err.message,
      data,
    };
  }
}

function buildReviewRequestComponents({ name, token }) {
  return [
    {
      type: 'body',
      parameters: [{ type: 'text', text: name || 'Cliente' }],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: token || '' }],
    },
  ];
}

/**
 * Envía el template solicitud_resena_google vía Waspy (canal marketing).
 *
 * Plantilla cargada en Meta con:
 *   - Body var {{1}}: nombre del cliente
 *   - Button URL dinámico, base "https://blanqueriaxmayor.com/resena/" + var {{1}} = token
 *
 * @param {Object} args
 * @param {string} args.to                  Teléfono destino (cualquier formato AR; se normaliza).
 * @param {string} [args.templateName]      Default 'solicitud_resena_google'.
 * @param {string} [args.language]          Default 'es_AR'.
 * @param {Object} args.variables           '1' = nombre, 'token' = token único del link.
 *
 * @returns {Promise<{sent:boolean, reason?:string, providerMessageId?:string, ...}>}
 */
async function sendReviewRequestTemplate({
  to,
  templateName = 'solicitud_resena_google_v2',
  language = 'es_AR',
  variables = {},
} = {}) {
  if (!to) return { sent: false, reason: 'missing_to' };
  if (!variables.token) return { sent: false, reason: 'missing_token' };

  const cfg = await getMarketingConfig();
  if (!cfg) {
    log.warn('[waspyOutbound] marketing config no disponible para review request');
    return { sent: false, reason: 'config_unavailable' };
  }

  const testingConfig = await waConfig.getTestingConfig();
  if (testingConfig === null) {
    log.error('[waspyOutbound] no se pudo leer testing config — bloqueando envio review');
    return { sent: false, reason: 'testing_config_unavailable' };
  }
  if (testingConfig.enabled) {
    if (!testingConfig.testingPhone) {
      return { sent: false, reason: 'testing_no_phone' };
    }
    log.info({ from: to, testing: testingConfig.testingPhone }, '[waspyOutbound] review testing redirect');
    to = testingConfig.testingPhone;
  }

  to = normalizeArgentinaPhone(to);
  if (!to.startsWith('+')) to = '+' + to;

  await rateLimit();

  const components = buildReviewRequestComponents({
    name: variables['1'],
    token: variables.token,
  });

  const payload = {
    phoneNumberId: cfg.phoneNumberId,
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  try {
    const res = await axios.post(`${cfg.baseUrl}/messages`, payload, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const providerMessageId =
      res.data?.id || res.data?.messageId || res.data?.data?.id || null;
    log.info(
      { to, templateName, providerMessageId, status: res.status },
      '[waspyOutbound] review sent OK'
    );
    return { sent: true, providerMessageId, to, status: res.status };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    log.error(
      { to, templateName, status, data, msg: err.message },
      '[waspyOutbound] review send error'
    );
    return {
      sent: false,
      reason: status ? 'api_error' : 'network_error',
      status,
      error: err.message,
      data,
    };
  }
}

module.exports = {
  sendStockAlertTemplate,
  sendReviewRequestTemplate,
  getMarketingConfig,
  invalidateConfigCache,
};
