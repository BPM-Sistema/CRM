/**
 * Endpoints administrativos del depósito (Fase 2 PR 7a).
 *
 * Montados en /admin/deposito en index.js. Todos requieren auth + permiso
 * RBAC `deposito.ver_deposito` (creado en migration 095).
 *
 * GET /transitions          — listado paginado con filtros (panel del depo)
 * GET /metrics              — 5 cajas (legacy) de métricas según filtros
 * GET /estado-counts        — 5 cajas (nuevas) snapshot por estado + despachados hoy
 * GET /pedidos-demorados    — banner: pedidos que pasaron su threshold (migration 099)
 * GET /thresholds           — listar topes editables (admin only)
 * PUT /thresholds/:estado   — actualizar tope de un estado (admin only)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { horasHabilesBanner } = require('../lib/horas-habiles-banner');
const { logEvento } = require('../utils/logging');

const ESTADOS_DEPO = [
  'hoja_impresa',
  'en_preparacion',
  'en_revision',
  'pendiente_stock',
  'por_empaquetar',
  'empaquetado',
];

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

// ─── Whitelist de transiciones válidas ────────────────────────
// Coincide con qr-deposito-transitions.js. Mantener sincronizado.
const VALID_TRANSITIONS = new Set([
  'en_preparacion',
  'en_revision',
  'pendiente_stock',
  'por_empaquetar',
  'empaquetado',
]);

// ─── Helper: generar código random de 4 dígitos único entre activos ──
async function generateUniqueCode(client, maxAttempts = 100) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const exists = await client.query(
      `SELECT 1 FROM warehouse_users WHERE codigo = $1 AND active = true LIMIT 1`,
      [code]
    );
    if (exists.rowCount === 0) return code;
  }
  throw new Error('No se pudo generar un código único — demasiados empleados activos.');
}

// ─── GET /employees ────────────────────────────────────────
// Listado con count de permisos + última acción. Incluye activos e inactivos
// (frontend decide mostrar/ocultar inactivos con un toggle).
router.get('/employees', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        u.id,
        u.nombre,
        u.active,
        u.created_at,
        COALESCE(p.permissions_count, 0)::int AS permissions_count,
        last.last_action_at
      FROM warehouse_users u
      LEFT JOIN (
        SELECT warehouse_user_id, COUNT(*) AS permissions_count
        FROM warehouse_user_permissions
        GROUP BY warehouse_user_id
      ) p ON p.warehouse_user_id = u.id
      LEFT JOIN (
        SELECT warehouse_user_id, MAX(created_at) AS last_action_at
        FROM warehouse_state_transitions
        WHERE warehouse_user_id IS NOT NULL
        GROUP BY warehouse_user_id
      ) last ON last.warehouse_user_id = u.id
      ORDER BY u.active DESC, u.nombre ASC
    `);
    res.json({ ok: true, items: r.rows });
  } catch (err) {
    console.error('❌ GET /admin/deposito/employees error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /employees/:id/permissions ────────────────────────
router.get('/employees/:id/permissions', requirePermission('deposito.ver_actividades'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
    const r = await pool.query(
      `SELECT transicion FROM warehouse_user_permissions WHERE warehouse_user_id = $1 ORDER BY transicion`,
      [id]
    );
    res.json({ ok: true, permissions: r.rows.map(x => x.transicion) });
  } catch (err) {
    console.error('❌ GET permissions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /employees ───────────────────────────────────────
// Crea empleado activo con código random de 4 dígitos. Si pasa `permissions`
// (array de transiciones), las inserta también. Devuelve el código generado
// — el admin tiene que anotarlo o usar "Ver código" después.
router.post('/employees', requirePermission('deposito.gestionar_empleados'), async (req, res) => {
  const { nombre, permissions } = req.body || {};
  if (!nombre || typeof nombre !== 'string' || !nombre.trim()) {
    return res.status(400).json({ error: 'nombre es obligatorio' });
  }
  const nombreTrim = nombre.trim();

  // Validar permisos contra la whitelist (silenciosamente skip los inválidos).
  let validPermissions = [];
  if (Array.isArray(permissions)) {
    validPermissions = permissions.filter(p => VALID_TRANSITIONS.has(p));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const codigo = await generateUniqueCode(client);
    const insertRes = await client.query(
      `INSERT INTO warehouse_users (nombre, codigo, active)
       VALUES ($1, $2, true)
       RETURNING id, nombre, active, codigo, created_at`,
      [nombreTrim, codigo]
    );
    const employee = insertRes.rows[0];
    for (const t of validPermissions) {
      await client.query(
        `INSERT INTO warehouse_user_permissions (warehouse_user_id, transicion)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [employee.id, t]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      employee: {
        id: employee.id,
        nombre: employee.nombre,
        active: employee.active,
        codigo: employee.codigo,
        permissions: validPermissions,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ POST /employees error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /employees/:id ──────────────────────────────────
// Editar nombre y/o estado active.
router.patch('/employees/:id', requirePermission('deposito.gestionar_empleados'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

    const updates = [];
    const params = [];
    let idx = 1;
    if (typeof req.body.nombre === 'string' && req.body.nombre.trim()) {
      updates.push(`nombre = $${idx++}`);
      params.push(req.body.nombre.trim());
    }
    if (typeof req.body.active === 'boolean') {
      updates.push(`active = $${idx++}`);
      params.push(req.body.active);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nada para actualizar' });
    }
    updates.push(`updated_at = NOW()`);
    params.push(id);

    const r = await pool.query(
      `UPDATE warehouse_users SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, nombre, active`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ ok: true, employee: r.rows[0] });
  } catch (err) {
    console.error('❌ PATCH /employees/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /employees/:id/permissions ────────────────────────
// Reemplaza el set de transiciones del empleado. DELETE + INSERT atomic.
router.put('/employees/:id/permissions', requirePermission('deposito.modificar_actividades'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
  if (permissions === null) {
    return res.status(400).json({ error: 'permissions debe ser un array' });
  }
  const valid = permissions.filter(p => VALID_TRANSITIONS.has(p));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verificar existencia del empleado.
    const exists = await client.query(`SELECT 1 FROM warehouse_users WHERE id = $1`, [id]);
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
    await client.query(`DELETE FROM warehouse_user_permissions WHERE warehouse_user_id = $1`, [id]);
    for (const t of valid) {
      await client.query(
        `INSERT INTO warehouse_user_permissions (warehouse_user_id, transicion)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, t]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, permissions: valid });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ PUT permissions error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── GET /employees/:id/code ───────────────────────────────
// Devuelve el código plain text. Permiso separado para auditar accesos.
router.get('/employees/:id/code', requirePermission('deposito.ver_codigos'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
    const r = await pool.query(`SELECT codigo FROM warehouse_users WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ ok: true, codigo: r.rows[0].codigo });
  } catch (err) {
    console.error('❌ GET code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /employees/:id/regenerate-code ───────────────────
// Genera un nuevo código random y devuelve el nuevo.
router.post('/employees/:id/regenerate-code', requirePermission('deposito.modificar_codigos'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT id FROM warehouse_users WHERE id = $1`, [id]);
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Empleado no encontrado' });
    }
    const codigo = await generateUniqueCode(client);
    await client.query(
      `UPDATE warehouse_users SET codigo = $1, updated_at = NOW() WHERE id = $2`,
      [codigo, id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, codigo });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ regenerate-code error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── GET /stock-issues ─────────────────────────────────────
// Listado de stock issues con filtros. PR 4.5 los crea cuando el depo
// pasa un pedido a pendiente_stock desde el QR. Se cierran automáticamente
// cuando el pedido sale de pendiente_stock, o manualmente desde acá.
router.get('/stock-issues', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const status = req.query.status || 'open';
    const orderNumber = req.query.order_number ? String(req.query.order_number).trim() : null;
    const sku = req.query.sku ? String(req.query.sku).trim() : null;
    const productSearch = req.query.product_search ? String(req.query.product_search).trim() : null;
    const fromDate = req.query.from_date || null;
    const toDate = req.query.to_date || null;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const clauses = [];
    const params = [];
    let idx = 1;
    if (status === 'open') {
      clauses.push(`i.resolved_at IS NULL`);
    } else if (status === 'resolved') {
      clauses.push(`i.resolved_at IS NOT NULL`);
    }
    if (orderNumber) {
      clauses.push(`i.order_number = $${idx++}`);
      params.push(orderNumber);
    }
    if (sku) {
      clauses.push(`i.sku ILIKE $${idx++}`);
      params.push(`%${sku}%`);
    }
    if (productSearch) {
      clauses.push(`i.product_name ILIKE $${idx++}`);
      params.push(`%${productSearch}%`);
    }
    if (fromDate) {
      clauses.push(`i.created_at >= $${idx++}`);
      params.push(fromDate);
    }
    if (toDate) {
      clauses.push(`i.created_at <= $${idx++}`);
      params.push(toDate);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const listSql = `
      SELECT
        i.id, i.order_number, i.order_product_id,
        i.product_name, i.variant, i.sku, i.quantity_missing,
        i.created_at, i.resolved_at, i.resolved_by_user_id,
        u.id AS reported_by_id, u.nombre AS reported_by_nombre,
        admin_u.name AS resolved_by_user_name
      FROM warehouse_stock_issues i
      LEFT JOIN warehouse_users u ON u.id = i.reported_by_warehouse_user_id
      LEFT JOIN users admin_u ON admin_u.id = i.resolved_by_user_id
      ${whereClause}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const countSql = `SELECT COUNT(*)::int AS total FROM warehouse_stock_issues i ${whereClause}`;

    const [listRes, countRes, openCountRes] = await Promise.all([
      pool.query(listSql, [...params, limit, offset]),
      pool.query(countSql, params),
      pool.query(`SELECT COUNT(*)::int AS open_count FROM warehouse_stock_issues WHERE resolved_at IS NULL`),
    ]);

    res.json({
      ok: true,
      items: listRes.rows,
      total: countRes.rows[0].total,
      open_count: openCountRes.rows[0].open_count,
      page,
      pageSize: limit,
      pages: Math.ceil(countRes.rows[0].total / limit),
    });
  } catch (err) {
    console.error('❌ GET /stock-issues error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /stock-issues/:id/resolve ───────────────────────
// Marca el issue como resuelto manualmente. resolved_by_user_id queda
// con el admin actual (distinto de NULL que indica auto-resolve).
router.patch('/stock-issues/:id/resolve', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });

    const r = await pool.query(
      `UPDATE warehouse_stock_issues
       SET resolved_at = NOW(), resolved_by_user_id = $1
       WHERE id = $2 AND resolved_at IS NULL
       RETURNING id, order_number, resolved_at`,
      [req.user?.id || null, id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Issue no encontrado o ya resuelto' });
    }
    res.json({ ok: true, issue: r.rows[0] });
  } catch (err) {
    console.error('❌ resolve issue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /errores ──────────────────────────────────────────
// Stats de errores de revisión por empleado dentro de un rango de fechas.
// Default últimos 30 días. "pedidos_preparados" cuenta transiciones únicas
// a en_revision (= terminó de preparar el pedido).
router.get('/errores', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const desde = req.query.desde
      ? new Date(req.query.desde)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const hasta = req.query.hasta ? new Date(req.query.hasta) : new Date();
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime())) {
      return res.status(400).json({ error: 'Fechas inválidas' });
    }

    const r = await pool.query(
      `SELECT
         wu.id AS warehouse_user_id,
         wu.nombre,
         COUNT(DISTINCT wst.order_number) FILTER (
           WHERE wst.to_status = 'en_revision'
             AND wst.created_at BETWEEN $1 AND $2
         )::int AS pedidos_preparados,
         COALESCE((
           SELECT SUM(re.error_count)::int
             FROM revision_errors re
            WHERE re.prepared_by_user_id = wu.id
              AND re.created_at BETWEEN $1 AND $2
         ), 0) AS total_errores
       FROM warehouse_users wu
       LEFT JOIN warehouse_state_transitions wst ON wst.warehouse_user_id = wu.id
       WHERE wu.active = true
       GROUP BY wu.id, wu.nombre
       ORDER BY total_errores DESC, wu.nombre ASC`,
      [desde.toISOString(), hasta.toISOString()]
    );

    const rows = r.rows.map(row => ({
      warehouse_user_id: row.warehouse_user_id,
      nombre: row.nombre,
      pedidos_preparados: row.pedidos_preparados,
      total_errores: row.total_errores,
      promedio: row.pedidos_preparados > 0
        ? Number((row.total_errores / row.pedidos_preparados).toFixed(2))
        : null,
    }));

    res.json({
      ok: true,
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      rows,
    });
  } catch (err) {
    console.error('❌ GET /admin/deposito/errores error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /estado-counts ───────────────────────────────────
// Alimenta las 5 cajas de métricas del panel /deposito. Las 4 primeras son
// snapshots actuales (cuántos pedidos hay AHORA en cada estado, independiente
// del filtro de fecha). La 5ta (despachados_hoy) cuenta pedidos únicos que
// transicionaron a 'en_calle' durante el día de hoy en zona AR.
router.get('/estado-counts', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    const snapshotSql = `
      SELECT
        COUNT(*) FILTER (WHERE estado_pedido = 'hoja_impresa')    AS por_armar,
        COUNT(*) FILTER (WHERE estado_pedido = 'en_revision')     AS por_revisar,
        COUNT(*) FILTER (WHERE estado_pedido = 'por_empaquetar')  AS por_empaquetar,
        COUNT(*) FILTER (WHERE estado_pedido = 'empaquetado')     AS por_despachar
      FROM orders_validated
      WHERE estado_pedido IN ('hoja_impresa','en_revision','por_empaquetar','empaquetado')
    `;
    const despachadosSql = `
      SELECT COUNT(DISTINCT order_number) AS despachados_hoy
      FROM warehouse_state_transitions
      WHERE to_status = 'en_calle'
        AND (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
          = (NOW()       AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    `;
    const [snap, desp] = await Promise.all([
      pool.query(snapshotSql),
      pool.query(despachadosSql),
    ]);
    res.json({
      por_armar:        Number(snap.rows[0].por_armar)       || 0,
      por_revisar:      Number(snap.rows[0].por_revisar)     || 0,
      por_empaquetar:   Number(snap.rows[0].por_empaquetar)  || 0,
      por_despachar:    Number(snap.rows[0].por_despachar)   || 0,
      despachados_hoy:  Number(desp.rows[0].despachados_hoy) || 0,
    });
  } catch (err) {
    console.error('❌ GET /admin/deposito/estado-counts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /pedidos-demorados ───────────────────────────────
// Alimenta el banner rojo de /deposito. Devuelve los pedidos que están
// en algún estado depo y superaron su threshold en horas hábiles
// (excluyendo VIE 18 → LUN 09 AR — ver lib/horas-habiles-banner.js).
router.get('/pedidos-demorados', requirePermission('deposito.ver_deposito'), async (req, res) => {
  try {
    // 1) Traer pedidos en los 6 estados con su "entered_at" (última transición
    //    a ese estado, o printed_at como fallback para hoja_impresa).
    const sql = `
      WITH last_transitions AS (
        SELECT DISTINCT ON (order_number, to_status)
          order_number, to_status, created_at
        FROM warehouse_state_transitions
        WHERE to_status = ANY($1)
        ORDER BY order_number, to_status, created_at DESC
      )
      SELECT
        ov.order_number,
        ov.customer_name,
        ov.estado_pedido,
        COALESCE(
          lt.created_at,
          CASE WHEN ov.estado_pedido = 'hoja_impresa' THEN ov.printed_at END
        ) AS entered_at,
        et.horas_limite
      FROM orders_validated ov
      JOIN estado_thresholds et ON et.estado = ov.estado_pedido
      LEFT JOIN last_transitions lt
        ON lt.order_number = ov.order_number
       AND lt.to_status = ov.estado_pedido
      WHERE ov.estado_pedido = ANY($1)
        AND COALESCE(
              lt.created_at,
              CASE WHEN ov.estado_pedido = 'hoja_impresa' THEN ov.printed_at END
            ) IS NOT NULL
    `;
    const { rows } = await pool.query(sql, [ESTADOS_DEPO]);

    // 2) Calcular horas hábiles en JS y filtrar contra el threshold por estado.
    const now = new Date();
    const items = [];
    for (const row of rows) {
      const horas = horasHabilesBanner(row.entered_at, now);
      const limite = Number(row.horas_limite);
      if (horas > limite) {
        items.push({
          order_number: row.order_number,
          customer_name: row.customer_name,
          estado_pedido: row.estado_pedido,
          entered_at: row.entered_at,
          horas_habiles: Number(horas.toFixed(2)),
          threshold_horas: limite,
        });
      }
    }

    // Más demorado primero.
    items.sort((a, b) => (b.horas_habiles - b.threshold_horas) - (a.horas_habiles - a.threshold_horas));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error('❌ GET /admin/deposito/pedidos-demorados error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /thresholds ──────────────────────────────────────
router.get('/thresholds', requirePermission('deposito.gestionar_empleados'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT estado, horas_limite, updated_at, updated_by_user_id
         FROM estado_thresholds
        ORDER BY array_position($1::text[], estado)`,
      [ESTADOS_DEPO]
    );
    res.json({ rows: r.rows });
  } catch (err) {
    console.error('❌ GET /admin/deposito/thresholds error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /thresholds/:estado ──────────────────────────────
router.put('/thresholds/:estado', requirePermission('deposito.gestionar_empleados'), async (req, res) => {
  try {
    const { estado } = req.params;
    if (!ESTADOS_DEPO.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido: ${estado}` });
    }

    const horasLimite = Number(req.body?.horas_limite);
    if (!Number.isFinite(horasLimite) || horasLimite <= 0) {
      return res.status(400).json({ error: 'horas_limite debe ser un número > 0' });
    }

    const prev = await pool.query(
      'SELECT horas_limite FROM estado_thresholds WHERE estado = $1',
      [estado]
    );
    if (prev.rowCount === 0) {
      return res.status(404).json({ error: `Estado no configurado: ${estado}` });
    }
    const prevHoras = Number(prev.rows[0].horas_limite);

    const r = await pool.query(
      `UPDATE estado_thresholds
          SET horas_limite = $1,
              updated_at = NOW(),
              updated_by_user_id = $2
        WHERE estado = $3
        RETURNING estado, horas_limite, updated_at, updated_by_user_id`,
      [horasLimite, req.user?.id || null, estado]
    );

    await logEvento({
      accion: `threshold_actualizado: ${estado} ${prevHoras}h → ${horasLimite}h`,
      origen: 'deposito-admin',
      userId: req.user?.id || null,
      username: req.user?.email || null,
    });

    res.json({ row: r.rows[0] });
  } catch (err) {
    console.error('❌ PUT /admin/deposito/thresholds/:estado error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
