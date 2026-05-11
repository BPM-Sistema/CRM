/**
 * Endpoints administrativos del depósito (Fase 2 PR 7a).
 *
 * Montados en /admin/deposito en index.js. Todos requieren auth + permiso
 * RBAC `deposito.ver_deposito` (creado en migration 095).
 *
 * GET /transitions  — listado paginado con filtros (panel del depo)
 * GET /metrics      — 5 cajas de métricas según filtros aplicados
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// ─── Helpers ───────────────────────────────────────────────

/**
 * Parsea un query param que puede ser "1,2,3" o array → array de strings.
 * Devuelve null si está vacío/no presente.
 */
function parseList(value) {
  if (!value) return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const filtered = arr.map(s => String(s).trim()).filter(Boolean);
  return filtered.length > 0 ? filtered : null;
}

function parseListInt(value) {
  const arr = parseList(value);
  if (!arr) return null;
  const ints = arr.map(s => parseInt(s, 10)).filter(n => Number.isInteger(n));
  return ints.length > 0 ? ints : null;
}

/**
 * Construye WHERE clauses + params para filtros de transiciones.
 * Devuelve { whereClause, params }.
 */
function buildFilterClauses(filters, startIdx = 1) {
  const clauses = [];
  const params = [];
  let idx = startIdx;

  if (filters.employeeIds) {
    clauses.push(`t.warehouse_user_id = ANY($${idx++})`);
    params.push(filters.employeeIds);
  }
  if (filters.transitions) {
    clauses.push(`t.to_status = ANY($${idx++})`);
    params.push(filters.transitions);
  }
  if (filters.fromDate) {
    clauses.push(`t.created_at >= $${idx++}`);
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    clauses.push(`t.created_at <= $${idx++}`);
    params.push(filters.toDate);
  }
  if (filters.source) {
    clauses.push(`t.source = $${idx++}`);
    params.push(filters.source);
  }

  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    nextIdx: idx,
  };
}

function extractFilters(query) {
  return {
    employeeIds: parseListInt(query.employee_ids),
    transitions: parseList(query.transitions),
    fromDate: query.from_date || null,
    toDate: query.to_date || null,
    source: query.source || null,
  };
}

// ─── GET /transitions ──────────────────────────────────────

router.get('/transitions', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const filters = extractFilters(req.query);

    // Ordenamiento. Whitelist de columnas válidas para evitar SQL injection.
    const validOrderBy = {
      created_at: 't.created_at',
      order_number: 't.order_number',
      employee_name: 'u.nombre',
    };
    const orderBy = validOrderBy[req.query.order_by] || 't.created_at';
    const orderDir = req.query.order_dir === 'asc' ? 'ASC' : 'DESC';

    // Paginación.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const { whereClause, params, nextIdx } = buildFilterClauses(filters);

    // Listado.
    const listSql = `
      SELECT
        t.id, t.order_number, t.from_status, t.to_status, t.source, t.created_at,
        u.id AS employee_id, u.nombre AS employee_name
      FROM warehouse_state_transitions t
      LEFT JOIN warehouse_users u ON u.id = t.warehouse_user_id
      ${whereClause}
      ORDER BY ${orderBy} ${orderDir}, t.id ${orderDir}
      LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
    `;
    const listParams = [...params, limit, offset];

    // Total para paginación.
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM warehouse_state_transitions t
      ${whereClause}
    `;

    const [listRes, countRes] = await Promise.all([
      pool.query(listSql, listParams),
      pool.query(countSql, params),
    ]);

    res.json({
      ok: true,
      items: listRes.rows,
      total: countRes.rows[0].total,
      page,
      pageSize: limit,
      pages: Math.ceil(countRes.rows[0].total / limit),
    });
  } catch (err) {
    console.error('❌ GET /admin/deposito/transitions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /metrics ──────────────────────────────────────────

router.get('/metrics', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const filters = extractFilters(req.query);
    const { whereClause, params } = buildFilterClauses(filters);

    // Una sola query para los 4 contadores (eficiencia + consistencia).
    const countersSql = `
      SELECT
        COUNT(*)::int AS total_transiciones,
        COUNT(*) FILTER (WHERE t.to_status = 'empaquetado')::int     AS empaquetados,
        COUNT(*) FILTER (WHERE t.to_status = 'pendiente_stock')::int AS pasados_pendiente_stock,
        COUNT(*) FILTER (WHERE t.to_status = 'en_calle')::int        AS despachados
      FROM warehouse_state_transitions t
      ${whereClause}
    `;

    // Empleado más activo: la misma WHERE clause + JOIN con warehouse_users.
    const topEmpleadoSql = `
      SELECT u.id, u.nombre, COUNT(*)::int AS count
      FROM warehouse_state_transitions t
      JOIN warehouse_users u ON u.id = t.warehouse_user_id
      ${whereClause ? whereClause + ' AND' : 'WHERE'} t.warehouse_user_id IS NOT NULL
      GROUP BY u.id, u.nombre
      ORDER BY count DESC, u.nombre ASC
      LIMIT 1
    `;

    const [countersRes, topRes] = await Promise.all([
      pool.query(countersSql, params),
      pool.query(topEmpleadoSql, params),
    ]);

    res.json({
      ok: true,
      metrics: {
        total_transiciones: countersRes.rows[0].total_transiciones,
        empaquetados: countersRes.rows[0].empaquetados,
        pasados_pendiente_stock: countersRes.rows[0].pasados_pendiente_stock,
        despachados: countersRes.rows[0].despachados,
        empleado_top: topRes.rows[0] || null,
      },
    });
  } catch (err) {
    console.error('❌ GET /admin/deposito/metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /employees ────────────────────────────────────────
// Listado liviano para popular los filtros del panel (no es ABM aún — eso es PR 7b).
router.get('/employees', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, active FROM warehouse_users ORDER BY nombre ASC`
    );
    res.json({ ok: true, items: r.rows });
  } catch (err) {
    console.error('❌ GET /admin/deposito/employees error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
