/**
 * Waspy HTTP Client — API Key based
 *
 * Uses an API key stored in the DB (waspy_config table) instead of
 * generating JWTs locally. The CRM backend authenticates to Waspy
 * with the API key, and requests short-lived embed tokens for the iframe.
 */

const pool = require('../db');

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Role mapping  CRM → Waspy
// ---------------------------------------------------------------------------

const ROLE_MAP = {
  admin:     'admin',
  operador:  'agent',
  caja:      'agent',
  logistica: 'read_only',
  readonly:  'read_only',
};

function mapRole(crmRole) {
  return ROLE_MAP[crmRole] || 'agent';
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Get the active Waspy configuration from the database.
 * @returns {Promise<object>} The waspy_config row
 * @throws {Error} If no config exists
 */
async function getWaspyConfig() {
  const { rows } = await pool.query('SELECT * FROM waspy_config LIMIT 1');
  if (!rows[0]) {
    throw new Error('Waspy no está configurado. Andá a Configuración > WhatsApp.');
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Waspy API using the stored API key.
 *
 * @param {string}  method    – HTTP method
 * @param {string}  path      – Path relative to waspy_url (e.g. "/api/v1/integration/channel/status")
 * @param {object}  [body]    – Optional JSON body
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
async function waspyFetch(method, path, body) {
  const config = await getWaspyConfig();
  const url = `${config.waspy_url.replace(/\/+$/, '')}${path}`;

  const options = {
    method: method.toUpperCase(),
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  };

  if (body !== undefined && body !== null && method.toUpperCase() !== 'GET') {
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, options);
    let data = null;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      data = text || null;
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error(`Waspy request timed out: ${method} ${path}`);
    }
    throw new Error(`Waspy request failed: ${method} ${path} – ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Embed token
// ---------------------------------------------------------------------------

/**
 * Request a short-lived JWT from Waspy for the iframe embed.
 *
 * @param {string} userRole – Waspy role (admin, agent, read_only)
 * @returns {Promise<{token: string, expiresIn: number, tenantId: string, role: string}>}
 */
async function getEmbedToken(userRole) {
  const result = await waspyFetch('POST', '/api/v1/integration/embed-token', {
    role: userRole || 'agent',
  });

  if (!result.ok) {
    throw new Error(result.data?.error?.message || result.data?.message || 'Error al obtener token de embed');
  }

  return result.data.data || result.data;
}

// ---------------------------------------------------------------------------
// Connection verification
// ---------------------------------------------------------------------------

/**
 * Verify connection to Waspy using an API key (before saving to DB).
 *
 * @param {string} apiKey  – The wspy_xxxx API key
 * @param {string} waspyUrl – Base URL of Waspy API
 * @returns {Promise<{tenant: {id, name, slug, plan}, phoneNumbers: Array}>}
 */
async function verifyConnection(apiKey, waspyUrl) {
  const url = `${waspyUrl.replace(/\/+$/, '')}/api/v1/integration/tenant-info`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error('Timeout al conectar con Waspy. Verificá la URL.');
    }
    throw new Error(`No se pudo conectar con Waspy: ${err.message}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(
      `Waspy respondió con ${response.status} pero no devolvió JSON (content-type: ${contentType}). ` +
      `Verificá que la URL "${waspyUrl}" sea correcta.`
    );
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || 'Conexión fallida');
  }

  return data.data || data;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getWaspyConfig,
  waspyFetch,
  getEmbedToken,
  verifyConnection,
  mapRole,
};
