/**
 * Divergence Detector — BPM vs TiendaNube
 *
 * Compara un pedido de TN con su estado en BPM y genera un reporte
 * de divergencias clasificadas por severidad.
 *
 * Reglas de negocio:
 * - cancelled es siempre terminal
 * - shipping usa prioridad: shipping_status > fulfillments > carrier/type
 * - payment usa TN como source de pago online
 * - estado_pago y total_pagado se derivan en BPM (recalcularPagos)
 * - no retroceder estado_pedido
 * - no tocar nada si toggle correspondiente está OFF
 */

const pool = require('../db');
const { mapShippingToEstadoPedido, calcularEstadoPedido } = require('./payment-helpers');

const ESTADO_PEDIDO_ORDER = {
  'pendiente_pago': 0, 'a_imprimir': 1, 'hoja_impresa': 2,
  'armado': 3, 'retirado': 4, 'en_calle': 4, 'enviado': 4, 'cancelado': 99,
};

// ── Severity definitions ──────────────────────────────────────────

const SEVERITY = {
  CRITICAL: 'critical',       // Datos de pago/estado incorrectos, pérdida de dinero potencial
  OPERATIONAL: 'operational', // Datos de envío/logística incorrectos, afectan operación diaria
  TOLERABLE: 'tolerable',    // Datos menores (notas, customer info) que no bloquean operación
};

// ── Field → severity mapping ──────────────────────────────────────

const FIELD_CONFIG = {
  // Payment — critical
  tn_payment_status:  { category: 'payment',  severity: SEVERITY.CRITICAL,    autoFixable: true  },
  pago_online_tn:     { category: 'payment',  severity: SEVERITY.CRITICAL,    autoFixable: true  },
  total_pagado:       { category: 'payment',  severity: SEVERITY.CRITICAL,    autoFixable: false },
  estado_pago:        { category: 'payment',  severity: SEVERITY.CRITICAL,    autoFixable: false },

  // Shipping — operational
  tn_shipping_status: { category: 'shipping', severity: SEVERITY.OPERATIONAL, autoFixable: true  },
  estado_pedido:      { category: 'status',   severity: SEVERITY.CRITICAL,    autoFixable: false },
  shipping_tracking:  { category: 'shipping', severity: SEVERITY.OPERATIONAL, autoFixable: true  },
  shipping_type:      { category: 'shipping', severity: SEVERITY.TOLERABLE,   autoFixable: false },

  // Status
  status_cancelled:   { category: 'status',   severity: SEVERITY.CRITICAL,    autoFixable: true  },

  // Products — operational
  monto_tiendanube:   { category: 'products', severity: SEVERITY.OPERATIONAL, autoFixable: true  },
  products_mismatch:  { category: 'products', severity: SEVERITY.OPERATIONAL, autoFixable: true  },

  // Customer — tolerable
  customer_name:      { category: 'customer', severity: SEVERITY.TOLERABLE,   autoFixable: true  },
  customer_email:     { category: 'customer', severity: SEVERITY.TOLERABLE,   autoFixable: true  },
  customer_phone:     { category: 'customer', severity: SEVERITY.TOLERABLE,   autoFixable: true  },

  // Address — operational
  shipping_address:   { category: 'address',  severity: SEVERITY.OPERATIONAL, autoFixable: true  },

  // Notes — tolerable
  note:               { category: 'notes',    severity: SEVERITY.TOLERABLE,   autoFixable: true  },
  owner_note:         { category: 'notes',    severity: SEVERITY.TOLERABLE,   autoFixable: true  },
};

// ── Toggle → category mapping ─────────────────────────────────────

const CATEGORY_TOGGLE = {
  payment:  'tiendanube_webhook_sync_payment',
  shipping: 'tiendanube_webhook_sync_shipping',
  products: 'tiendanube_webhook_sync_products',
  customer: 'tiendanube_webhook_sync_customer',
  address:  'tiendanube_webhook_sync_address',
  notes:    'tiendanube_webhook_sync_notes',
  status:   null, // status siempre se procesa
};

/**
 * Construir reporte de divergencias entre un pedido TN y BPM.
 *
 * @param {object} tnOrder - Pedido completo de la API de TiendaNube
 * @param {object} bpmOrder - Row de orders_validated + datos extendidos
 * @param {object} [opts]
 * @param {object} [opts.toggles] - Map<string, boolean> de toggles activos (para no re-fetch)
 * @returns {{ divergences: Array, summary: object }}
 */
function buildDivergenceReport(tnOrder, bpmOrder, opts = {}) {
  const divergences = [];
  const toggles = opts.toggles || {};

  function addDiv(fieldName, tnVal, bpmVal, expectedVal, overrides = {}) {
    const cfg = FIELD_CONFIG[fieldName] || { category: 'unknown', severity: SEVERITY.TOLERABLE, autoFixable: false };
    const categoryToggle = CATEGORY_TOGGLE[cfg.category];

    // Si hay un toggle para esta categoría y está OFF, marcar como no auto-fixable
    let autoFixable = overrides.autoFixable ?? cfg.autoFixable;
    if (categoryToggle && toggles[categoryToggle] === false) {
      autoFixable = false;
    }

    divergences.push({
      field_name: fieldName,
      category: cfg.category,
      severity: overrides.severity ?? cfg.severity,
      tn_value: tnVal,
      bpm_value: bpmVal,
      expected_value: expectedVal,
      auto_fixable: autoFixable,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. STATUS — cancelled siempre terminal
  // ═══════════════════════════════════════════════════════════════
  if (tnOrder.status === 'cancelled' && bpmOrder.estado_pedido !== 'cancelado') {
    addDiv('status_cancelled', 'cancelled', bpmOrder.estado_pedido, 'cancelado');
  }

  // Si TN está cancelado, no comparar más campos (terminal)
  if (tnOrder.status === 'cancelled') {
    return buildSummary(divergences);
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. PAYMENT
  // ═══════════════════════════════════════════════════════════════
  const tnPaymentStatus = tnOrder.payment_status || null;
  const bpmPaymentStatus = bpmOrder.tn_payment_status || null;

  if (tnPaymentStatus !== bpmPaymentStatus) {
    addDiv('tn_payment_status', tnPaymentStatus, bpmPaymentStatus, tnPaymentStatus);
  }

  // pago_online_tn — lo que BPM debería tener según TN
  const tnTotalPaid = Math.round(Number(tnOrder.total_paid || 0));
  const montoTN = Math.round(Number(tnOrder.total || 0));
  let expectedPagoOnline = 0;
  if (tnPaymentStatus === 'paid') {
    expectedPagoOnline = tnTotalPaid > 0 ? tnTotalPaid : montoTN;
  } else if (tnPaymentStatus === 'partially_paid' || tnPaymentStatus === 'partially_refunded') {
    expectedPagoOnline = tnTotalPaid;
  } else if (tnPaymentStatus === 'refunded' || tnPaymentStatus === 'voided') {
    expectedPagoOnline = 0;
  }

  const bpmPagoOnline = Number(bpmOrder.pago_online_tn || 0);
  if (Math.abs(expectedPagoOnline - bpmPagoOnline) > 100) { // tolerancia $1
    addDiv('pago_online_tn', expectedPagoOnline, bpmPagoOnline, expectedPagoOnline);
  }

  // estado_pago derivado — solo alertar, no auto-fix (requiere recalcularPagos)
  const expectedEstadoPago = deriveExpectedEstadoPago(tnPaymentStatus, bpmOrder);
  if (expectedEstadoPago && expectedEstadoPago !== bpmOrder.estado_pago) {
    // Solo divergencia si no es un estado especial protegido
    if (bpmOrder.estado_pago !== 'reembolsado' && bpmOrder.estado_pago !== 'anulado') {
      addDiv('estado_pago', tnPaymentStatus, bpmOrder.estado_pago, expectedEstadoPago, { autoFixable: false });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. SHIPPING
  // ═══════════════════════════════════════════════════════════════
  const tnShippingStatus = tnOrder.shipping_status || null;
  const bpmShippingStatus = bpmOrder.tn_shipping_status || null;

  if (tnShippingStatus !== bpmShippingStatus) {
    addDiv('tn_shipping_status', tnShippingStatus, bpmShippingStatus, tnShippingStatus);
  }

  // estado_pedido derivado de shipping
  const fulfillmentStatus = tnOrder.fulfillments?.[0]?.status || null;
  const shippingCarrier = tnOrder.shipping || null;
  const expectedEstadoPedido = mapShippingToEstadoPedido(
    tnShippingStatus,
    shippingCarrier,
    bpmOrder.shipping_type || '',
    bpmOrder.estado_pedido,
    { fulfillmentStatus }
  );

  if (expectedEstadoPedido && expectedEstadoPedido !== bpmOrder.estado_pedido) {
    // Verificar que no retrocede
    const ordenActual = ESTADO_PEDIDO_ORDER[bpmOrder.estado_pedido] ?? 0;
    const ordenEsperado = ESTADO_PEDIDO_ORDER[expectedEstadoPedido] ?? 0;
    if (ordenEsperado > ordenActual) {
      addDiv('estado_pedido', tnShippingStatus, bpmOrder.estado_pedido, expectedEstadoPedido, { autoFixable: false });
    }
  }

  // Tracking number
  const tnTracking = tnOrder.shipping_tracking_number || null;
  const bpmTracking = bpmOrder.shipping_tracking || null;
  if (tnTracking !== bpmTracking && tnTracking) {
    addDiv('shipping_tracking', tnTracking, bpmTracking, tnTracking);
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. PRODUCTS / MONTO
  // ═══════════════════════════════════════════════════════════════
  const bpmMonto = Number(bpmOrder.monto_tiendanube || 0);
  if (Math.abs(montoTN - bpmMonto) > 100) { // tolerancia $1
    addDiv('monto_tiendanube', montoTN, bpmMonto, montoTN);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. CUSTOMER
  // ═══════════════════════════════════════════════════════════════
  const tnCustomerName = tnOrder.customer?.name || tnOrder.contact_name || null;
  const tnCustomerEmail = tnOrder.customer?.email || tnOrder.contact_email || null;
  const tnCustomerPhone = tnOrder.contact_phone || tnOrder.customer?.phone || tnOrder.shipping_address?.phone || null;

  if (tnCustomerName && tnCustomerName !== bpmOrder.customer_name) {
    addDiv('customer_name', tnCustomerName, bpmOrder.customer_name, tnCustomerName);
  }
  if (tnCustomerEmail && tnCustomerEmail !== bpmOrder.customer_email) {
    addDiv('customer_email', tnCustomerEmail, bpmOrder.customer_email, tnCustomerEmail);
  }
  if (tnCustomerPhone && tnCustomerPhone !== bpmOrder.customer_phone) {
    addDiv('customer_phone', tnCustomerPhone, bpmOrder.customer_phone, tnCustomerPhone);
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. SHIPPING ADDRESS
  // ═══════════════════════════════════════════════════════════════
  if (tnOrder.shipping_address) {
    const addressFields = ['name', 'address', 'number', 'floor', 'locality', 'city', 'province', 'zipcode', 'phone', 'between_streets', 'reference'];
    const dbAddr = bpmOrder.shipping_address || {};
    const tnAddr = tnOrder.shipping_address || {};
    const changedFields = addressFields.filter(f => (dbAddr[f] || null) !== (tnAddr[f] || null));

    if (changedFields.length > 0) {
      const tnAddrClean = {};
      const bpmAddrClean = {};
      for (const f of changedFields) {
        tnAddrClean[f] = tnAddr[f] || null;
        bpmAddrClean[f] = dbAddr[f] || null;
      }
      addDiv('shipping_address', tnAddrClean, bpmAddrClean, tnAddrClean);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. NOTES
  // ═══════════════════════════════════════════════════════════════
  const tnNote = tnOrder.note || null;
  const bpmNote = bpmOrder.note || null;
  if (tnNote !== bpmNote) {
    addDiv('note', tnNote, bpmNote, tnNote);
  }

  const tnOwnerNote = tnOrder.owner_note || null;
  const bpmOwnerNote = bpmOrder.owner_note || null;
  if (tnOwnerNote !== bpmOwnerNote) {
    addDiv('owner_note', tnOwnerNote, bpmOwnerNote, tnOwnerNote);
  }

  return buildSummary(divergences);
}

// ── Helpers internos ─────────────────────────────────────────────

function deriveExpectedEstadoPago(tnPaymentStatus, bpmOrder) {
  if (tnPaymentStatus === 'refunded') return 'reembolsado';
  if (tnPaymentStatus === 'voided') return 'anulado';

  // Para paid/partially_paid, el estado_pago depende de pagos locales
  // No podemos derivar con certeza sin recalcularPagos, solo alertamos
  // si el gap es obvio
  if (tnPaymentStatus === 'paid' && bpmOrder.estado_pago === 'pendiente') {
    return 'confirmado_total'; // al menos confirmado_parcial
  }
  if (tnPaymentStatus === 'partially_paid' && bpmOrder.estado_pago === 'pendiente') {
    return 'confirmado_parcial';
  }

  return null; // no podemos determinar con certeza
}

function buildSummary(divergences) {
  const summary = {
    total: divergences.length,
    critical: divergences.filter(d => d.severity === SEVERITY.CRITICAL).length,
    operational: divergences.filter(d => d.severity === SEVERITY.OPERATIONAL).length,
    tolerable: divergences.filter(d => d.severity === SEVERITY.TOLERABLE).length,
    autoFixable: divergences.filter(d => d.auto_fixable).length,
    categories: [...new Set(divergences.map(d => d.category))],
  };

  return { divergences, summary };
}

// ── Persistir divergencias en DB ─────────────────────────────────

async function saveDivergences(orderNumber, tnOrderId, divergences, source) {
  if (divergences.length === 0) return;

  // Cerrar divergencias previas abiertas del mismo source para este pedido
  await pool.query(`
    UPDATE order_divergences
    SET status = 'ignored', updated_at = NOW()
    WHERE order_number = $1 AND status = 'open' AND source = $2
  `, [orderNumber, source]);

  for (const d of divergences) {
    await pool.query(`
      INSERT INTO order_divergences
        (order_number, tn_order_id, category, severity, field_name,
         tn_value, bpm_value, expected_value, auto_fixable, status, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10)
    `, [
      orderNumber,
      tnOrderId || null,
      d.category,
      d.severity,
      d.field_name,
      JSON.stringify(d.tn_value),
      JSON.stringify(d.bpm_value),
      JSON.stringify(d.expected_value),
      d.auto_fixable,
      source,
    ]);
  }
}

// ── Aplicar correcciones automáticas ─────────────────────────────

/**
 * Aplica correcciones a divergencias auto_fixable.
 * NO llama a TN. Solo actualiza BPM para reflejar lo que TN dice.
 * Respeta toggles.
 *
 * @param {string} orderNumber
 * @param {Array} divergences - divergencias auto_fixable a corregir
 * @param {object} opts
 * @param {string} opts.fixedBy - quién corrige ('auto:webhook', 'auto:cron', 'manual:user@email')
 * @param {object} opts.toggles - toggles activos
 * @returns {{ fixed: number, skipped: number, details: Array }}
 */
async function applyAutoFixes(orderNumber, divergences, opts = {}) {
  const { fixedBy = 'auto:system', toggles = {} } = opts;
  const fixable = divergences.filter(d => d.auto_fixable);
  const details = [];
  let fixed = 0;
  let skipped = 0;

  const setClauses = ['updated_at = NOW()'];
  const setParams = [];
  let paramIdx = 2; // $1 = order_number
  let needsRecalc = false;

  for (const d of fixable) {
    const categoryToggle = CATEGORY_TOGGLE[d.category];
    if (categoryToggle && toggles[categoryToggle] === false) {
      skipped++;
      details.push({ field: d.field_name, action: 'skipped', reason: 'toggle_off' });
      continue;
    }

    switch (d.field_name) {
      case 'status_cancelled':
        setClauses.push(`estado_pedido = 'cancelado'`);
        details.push({ field: 'estado_pedido', action: 'fixed', from: d.bpm_value, to: 'cancelado' });
        fixed++;
        break;

      case 'tn_payment_status':
        setClauses.push(`tn_payment_status = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'tn_payment_status', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'pago_online_tn':
        setClauses.push(`pago_online_tn = $${paramIdx++}`);
        setParams.push(d.expected_value);
        needsRecalc = true;
        details.push({ field: 'pago_online_tn', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'tn_shipping_status':
        setClauses.push(`tn_shipping_status = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'tn_shipping_status', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'shipping_tracking':
        setClauses.push(`shipping_tracking = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'shipping_tracking', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'monto_tiendanube':
        setClauses.push(`monto_tiendanube = $${paramIdx++}`);
        setParams.push(d.expected_value);
        needsRecalc = true;
        details.push({ field: 'monto_tiendanube', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'customer_name':
        setClauses.push(`customer_name = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'customer_name', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'customer_email':
        setClauses.push(`customer_email = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'customer_email', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'customer_phone':
        setClauses.push(`customer_phone = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'customer_phone', action: 'fixed', from: d.bpm_value, to: d.expected_value });
        fixed++;
        break;

      case 'shipping_address':
        setClauses.push(`shipping_address = $${paramIdx++}`);
        setParams.push(JSON.stringify(d.expected_value));
        details.push({ field: 'shipping_address', action: 'fixed' });
        fixed++;
        break;

      case 'note':
        setClauses.push(`note = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'note', action: 'fixed' });
        fixed++;
        break;

      case 'owner_note':
        setClauses.push(`owner_note = $${paramIdx++}`);
        setParams.push(d.expected_value);
        details.push({ field: 'owner_note', action: 'fixed' });
        fixed++;
        break;

      default:
        skipped++;
        details.push({ field: d.field_name, action: 'skipped', reason: 'no_fix_handler' });
    }
  }

  // Ejecutar UPDATE si hay algo que corregir
  if (setClauses.length > 1) {
    await pool.query(
      `UPDATE orders_validated SET ${setClauses.join(', ')} WHERE order_number = $1`,
      [orderNumber, ...setParams]
    );
  }

  // Recalcular pagos si se tocó pago_online_tn o monto
  if (needsRecalc) {
    const { recalcularPagos } = require('./recalcularPagos');
    await recalcularPagos(pool, orderNumber);
  }

  // Marcar divergencias como fixed en DB
  if (fixed > 0) {
    const fixedFields = details.filter(d => d.action === 'fixed').map(d => d.field);
    await pool.query(`
      UPDATE order_divergences
      SET status = 'fixed', fixed_at = NOW(), fixed_by = $1, updated_at = NOW()
      WHERE order_number = $2 AND status = 'open' AND field_name = ANY($3)
    `, [fixedBy, orderNumber, fixedFields]);
  }

  return { fixed, skipped, details };
}

// ── Obtener BPM order con datos extendidos para comparación ──────

async function getBpmOrderForComparison(orderNumber) {
  const r = await pool.query(`
    SELECT order_number, tn_order_id, monto_tiendanube, total_pagado, saldo,
           estado_pago, estado_pedido, tn_payment_status, tn_shipping_status,
           pago_online_tn, tn_paid_at, tn_total_paid, tn_gateway,
           shipping_type, shipping_tracking, shipping_address, shipping_cost,
           customer_name, customer_email, customer_phone,
           note, owner_note, discount, subtotal, currency
    FROM orders_validated
    WHERE order_number = $1
  `, [orderNumber]);

  return r.rows[0] || null;
}

// ── Obtener divergencias abiertas ────────────────────────────────

async function getOpenDivergences(orderNumber) {
  const r = await pool.query(`
    SELECT * FROM order_divergences
    WHERE order_number = $1 AND status = 'open'
    ORDER BY severity = 'critical' DESC, severity = 'operational' DESC, created_at DESC
  `, [orderNumber]);
  return r.rows;
}

async function getDivergenceStats(opts = {}) {
  const days = opts.days || 7;
  const r = await pool.query(`
    SELECT
      severity,
      status,
      COUNT(*)::int as count
    FROM order_divergences
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY severity, status
    ORDER BY severity, status
  `, [days]);
  return r.rows;
}

module.exports = {
  buildDivergenceReport,
  saveDivergences,
  applyAutoFixes,
  getBpmOrderForComparison,
  getOpenDivergences,
  getDivergenceStats,
  SEVERITY,
  FIELD_CONFIG,
  CATEGORY_TOGGLE,
};
