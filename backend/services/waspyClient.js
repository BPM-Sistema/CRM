/**
 * Waspy HTTP Client
 * Centralized service for CRM → Waspy API communication.
 */

const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WASPY_URL        = process.env.WASPY_URL;
const WASPY_JWT_SECRET = process.env.WASPY_JWT_SECRET;
const WASPY_TENANT_ID  = process.env.WASPY_TENANT_ID;
const WASPY_JWT_ISSUER     = process.env.WASPY_JWT_ISSUER     || 'crm';
const WASPY_JWT_AUDIENCE   = process.env.WASPY_JWT_AUDIENCE   || 'waspy';
const WASPY_JWT_EXPIRES_IN = process.env.WASPY_JWT_EXPIRES_IN || '1h';

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
  return ROLE_MAP[crmRole] || 'read_only';
}

// ---------------------------------------------------------------------------
// JWT generation
// ---------------------------------------------------------------------------

/**
 * Generate a short-lived JWT that Waspy will accept.
 *
 * @param {object} user  – CRM user (req.user): { id, name, email, role_name }
 * @returns {string}       Signed JWT
 */
function generateWaspyToken(user) {
  if (!WASPY_JWT_SECRET) {
    throw new Error('WASPY_JWT_SECRET is not configured');
  }

  const payload = {
    sub:      String(user.id),
    tenantId: WASPY_TENANT_ID,
    role:     mapRole(user.role_name),
    email:    user.email,
    name:     user.name,
  };

  return jwt.sign(payload, WASPY_JWT_SECRET, {
    issuer:    WASPY_JWT_ISSUER,
    audience:  WASPY_JWT_AUDIENCE,
    expiresIn: WASPY_JWT_EXPIRES_IN,
  });
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Waspy API.
 *
 * @param {object}  user           – CRM user object (passed to generateWaspyToken)
 * @param {string}  method         – HTTP method (GET, POST, PUT, PATCH, DELETE)
 * @param {string}  path           – Path relative to WASPY_URL (e.g. "/conversations")
 * @param {object}  [body]         – Optional JSON body
 * @param {object}  [options]      – Optional overrides
 * @param {number}  [options.timeout] – Request timeout in ms (default 10 000)
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
async function waspyFetch(user, method, path, body, options = {}) {
  if (!WASPY_URL) {
    throw new Error('WASPY_URL is not configured');
  }

  const token   = generateWaspyToken(user);
  const url     = `${WASPY_URL.replace(/\/+$/, '')}${path}`;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const fetchOptions = {
    method: method.toUpperCase(),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    signal: controller.signal,
  };

  if (body !== undefined && body !== null) {
    fetchOptions.body = JSON.stringify(body);
  }

  try {
    const res  = await fetch(url, fetchOptions);
    let data   = null;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      data = text || null;
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Waspy request timed out after ${timeout}ms: ${method} ${path}`);
    }
    throw new Error(`Waspy request failed: ${method} ${path} – ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateWaspyToken,
  waspyFetch,
  mapRole,
};
