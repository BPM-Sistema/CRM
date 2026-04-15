const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission, requireAnyPermission } = require('../middleware/auth');

router.use(authenticate);

// =====================================================
// Helper: log de auditoría del módulo LOCAL
// =====================================================
async function localLog(action, entityType, entityId, user, payload = null) {
  try {
    await pool.query(
      `INSERT INTO local_logs (action, entity_type, entity_id, user_id, user_role, username, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [action, entityType, entityId, user.id, user.role_name, user.name, payload ? JSON.stringify(payload) : null]
    );
  } catch (err) {
    console.error('[LOCAL LOG ERROR]', err.message);
  }
}

// =====================================================
// Validar transición de estado
// =====================================================
const VALID_TRANSITIONS = {
  reservado: ['impreso', 'cancelado'],
  impreso: ['impreso', 'armado', 'cancelado'],
  armado: ['enviado', 'cancelado'],
  enviado: ['en_control'],
  en_control: ['con_diferencias', 'confirmado_local'],
  con_diferencias: ['en_control'],
  confirmado_local: [],
  cancelado: []
};

function canTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) || false;
}

// =====================================================
// GET /api/local/products/search — Buscar productos del catálogo
// =====================================================
router.get('/products/search', requireAnyPermission(['local.orders.create', 'local.orders.edit', 'local.box.create', 'local.box.edit']), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Búsqueda mínima: 2 caracteres' });
    }

    const result = await pool.query(`
      SELECT DISTINCT ON (product_id, variant_id)
        product_id,
        variant_id,
        name AS product_name,
        variant AS variant_name,
        sku,
        price
      FROM order_products
      WHERE (name ILIKE $1 OR sku ILIKE $1 OR variant ILIKE $1)
      ORDER BY product_id, variant_id, created_at DESC
      LIMIT 50
    `, [`%${q}%`]);

    res.json({ ok: true, products: result.rows });
  } catch (error) {
    console.error('[LOCAL] Error buscando productos:', error);
    res.status(500).json({ error: 'Error al buscar productos' });
  }
});

// =====================================================
// POST /api/local/orders — Crear reserva
// =====================================================
router.post('/orders', requirePermission('local.orders.create'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, notes_internal } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Debe incluir al menos un ítem' });
    }

    for (const item of items) {
      if (!item.product_id || !item.product_name || !item.qty || item.qty < 1) {
        return res.status(400).json({ error: 'Cada ítem debe tener product_id, product_name y qty > 0' });
      }
    }

    await client.query('BEGIN');

    const orderResult = await client.query(
      `INSERT INTO local_orders (created_by_user_id, created_by_role, notes_internal)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.user.id, req.user.role_name, notes_internal || null]
    );
    const order = orderResult.rows[0];

    const insertedItems = [];
    for (const item of items) {
      const itemResult = await client.query(
        `INSERT INTO local_order_items
          (local_order_id, product_id, variant_id, sku_snapshot, product_name_snapshot, variant_name_snapshot, reserved_qty, sent_qty, line_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
         RETURNING *`,
        [
          order.id,
          item.product_id,
          item.variant_id || null,
          item.sku || null,
          item.product_name,
          item.variant_name || null,
          item.qty,
          item.line_notes || null
        ]
      );
      insertedItems.push(itemResult.rows[0]);
    }

    await client.query('COMMIT');

    await localLog('local_order_created', 'local_order', order.id, req.user, {
      items_count: items.length,
      total_qty: items.reduce((s, i) => s + i.qty, 0)
    });

    res.status(201).json({
      ok: true,
      order: { ...order, items: insertedItems }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL] Error creando reserva:', error);
    res.status(500).json({ error: 'Error al crear reserva' });
  } finally {
    client.release();
  }
});

// =====================================================
// GET /api/local/orders — Listar reservas
// =====================================================
router.get('/orders', requirePermission('local.orders.view'), async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`lo.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(lo.local_order_number::text ILIKE $${params.length} OR lo.notes_internal ILIKE $${params.length})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM local_orders lo ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit));
    params.push(offset);

    const result = await pool.query(`
      SELECT
        lo.*,
        u.name AS created_by_name,
        (SELECT COUNT(*) FROM local_order_items WHERE local_order_id = lo.id) AS items_count,
        (SELECT SUM(reserved_qty) FROM local_order_items WHERE local_order_id = lo.id) AS total_qty
      FROM local_orders lo
      LEFT JOIN users u ON lo.created_by_user_id = u.id
      ${where}
      ORDER BY lo.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({
      ok: true,
      orders: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[LOCAL] Error listando reservas:', error);
    res.status(500).json({ error: 'Error al listar reservas' });
  }
});

// =====================================================
// GET /api/local/orders/:id — Detalle de reserva
// =====================================================
router.get('/orders/:id', requirePermission('local.orders.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query(`
      SELECT lo.*,
        u.name AS created_by_name,
        ep.name AS last_edited_by_name,
        pp.name AS last_printed_by_name
      FROM local_orders lo
      LEFT JOIN users u ON lo.created_by_user_id = u.id
      LEFT JOIN users ep ON lo.last_edited_by = ep.id
      LEFT JOIN users pp ON lo.last_printed_by = pp.id
      WHERE lo.id = $1
    `, [id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];

    // Items — para admin_local en control, NO revelar sent_qty
    const isLocalControl = req.user.role_name === 'admin_local' &&
      ['enviado', 'en_control', 'con_diferencias'].includes(order.status);

    let itemsQuery;
    if (isLocalControl) {
      itemsQuery = await pool.query(`
        SELECT id, local_order_id, product_id, variant_id, sku_snapshot,
               product_name_snapshot, variant_name_snapshot,
               reserved_qty,
               NULL::integer AS sent_qty,
               received_qty, control_status, control_checked_at, line_notes
        FROM local_order_items
        WHERE local_order_id = $1
        ORDER BY product_name_snapshot
      `, [id]);
    } else {
      itemsQuery = await pool.query(`
        SELECT * FROM local_order_items WHERE local_order_id = $1
        ORDER BY product_name_snapshot
      `, [id]);
    }

    const printsResult = await pool.query(`
      SELECT lop.*, u.name AS printed_by_name
      FROM local_order_prints lop
      LEFT JOIN users u ON lop.printed_by = u.id
      WHERE lop.local_order_id = $1
      ORDER BY lop.printed_at DESC
    `, [id]);

    const logsResult = await pool.query(`
      SELECT * FROM local_logs
      WHERE entity_type = 'local_order' AND entity_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [id]);

    res.json({
      ok: true,
      order: {
        ...order,
        items: itemsQuery.rows,
        prints: printsResult.rows,
        logs: logsResult.rows
      }
    });
  } catch (error) {
    console.error('[LOCAL] Error obteniendo detalle:', error);
    res.status(500).json({ error: 'Error al obtener detalle de reserva' });
  }
});

// =====================================================
// PATCH /api/local/orders/:id — Editar reserva (depósito)
// =====================================================
router.patch('/orders/:id', requirePermission('local.orders.edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items, notes_internal } = req.body;

    const orderResult = await client.query('SELECT * FROM local_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];

    if (['enviado', 'en_control', 'con_diferencias', 'confirmado_local', 'cancelado'].includes(order.status)) {
      return res.status(400).json({ error: 'No se puede editar una reserva en estado: ' + order.status });
    }

    await client.query('BEGIN');

    if (notes_internal !== undefined) {
      await client.query(
        'UPDATE local_orders SET notes_internal = $1, last_edited_by = $2, updated_at = NOW() WHERE id = $3',
        [notes_internal, req.user.id, id]
      );
    }

    if (items && Array.isArray(items)) {
      // Eliminar items existentes y reinsertar
      await client.query('DELETE FROM local_order_items WHERE local_order_id = $1', [id]);

      for (const item of items) {
        if (!item.product_id || !item.product_name || !item.qty || item.qty < 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cada ítem debe tener product_id, product_name y qty > 0' });
        }

        await client.query(
          `INSERT INTO local_order_items
            (local_order_id, product_id, variant_id, sku_snapshot, product_name_snapshot, variant_name_snapshot, reserved_qty, sent_qty, line_notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
          [
            id,
            item.product_id,
            item.variant_id || null,
            item.sku || null,
            item.product_name,
            item.variant_name || null,
            item.qty,
            item.line_notes || null
          ]
        );
      }

      await client.query(
        'UPDATE local_orders SET last_edited_by = $1, updated_at = NOW() WHERE id = $2',
        [req.user.id, id]
      );
    }

    await client.query('COMMIT');

    await localLog('local_order_updated', 'local_order', id, req.user, {
      items_count: items?.length,
      notes_changed: notes_internal !== undefined
    });

    const updated = await pool.query(`
      SELECT lo.*, u.name AS created_by_name
      FROM local_orders lo LEFT JOIN users u ON lo.created_by_user_id = u.id
      WHERE lo.id = $1
    `, [id]);
    const updatedItems = await pool.query('SELECT * FROM local_order_items WHERE local_order_id = $1', [id]);

    res.json({
      ok: true,
      order: { ...updated.rows[0], items: updatedItems.rows }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL] Error editando reserva:', error);
    res.status(500).json({ error: 'Error al editar reserva' });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/local/orders/:id/print — Imprimir reserva
// =====================================================
router.post('/orders/:id/print', requirePermission('local.orders.print'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const orderResult = await client.query(`
      SELECT lo.*, u.name AS created_by_name
      FROM local_orders lo LEFT JOIN users u ON lo.created_by_user_id = u.id
      WHERE lo.id = $1
    `, [id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];
    const items = await client.query('SELECT * FROM local_order_items WHERE local_order_id = $1 ORDER BY product_name_snapshot', [id]);

    const newVersion = order.print_count + 1;

    const snapshot = {
      order: { ...order },
      items: items.rows,
      printed_at: new Date().toISOString(),
      version: newVersion
    };

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO local_order_prints (local_order_id, printed_by, print_version, snapshot_payload)
       VALUES ($1, $2, $3, $4)`,
      [id, req.user.id, newVersion, JSON.stringify(snapshot)]
    );

    const newStatus = order.status === 'reservado' ? 'impreso' : order.status;

    await client.query(
      `UPDATE local_orders
       SET print_count = $1, last_printed_by = $2, printed_at = NOW(),
           status = $3, updated_at = NOW()
       WHERE id = $4`,
      [newVersion, req.user.id, newStatus, id]
    );

    await client.query('COMMIT');

    const logAction = newVersion === 1 ? 'local_order_printed' : 'local_order_reprinted';
    await localLog(logAction, 'local_order', id, req.user, { version: newVersion });

    res.json({
      ok: true,
      print: {
        version: newVersion,
        order: { ...order, status: newStatus, print_count: newVersion },
        items: items.rows
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL] Error imprimiendo:', error);
    res.status(500).json({ error: 'Error al imprimir reserva' });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/local/orders/:id/pack — Marcar armado
// =====================================================
router.post('/orders/:id/pack', requirePermission('local.orders.pack'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query('SELECT * FROM local_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];
    if (!canTransition(order.status, 'armado')) {
      return res.status(400).json({ error: `No se puede armar desde estado: ${order.status}` });
    }

    await pool.query(
      'UPDATE local_orders SET status = $1, packed_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['armado', id]
    );

    await localLog('local_order_packed', 'local_order', id, req.user);

    res.json({ ok: true, status: 'armado' });
  } catch (error) {
    console.error('[LOCAL] Error armando:', error);
    res.status(500).json({ error: 'Error al marcar como armado' });
  }
});

// =====================================================
// POST /api/local/orders/:id/ship — Marcar enviado
// =====================================================
router.post('/orders/:id/ship', requirePermission('local.orders.ship'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query('SELECT * FROM local_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];
    if (!canTransition(order.status, 'enviado')) {
      return res.status(400).json({ error: `No se puede enviar desde estado: ${order.status}` });
    }

    await pool.query(
      'UPDATE local_orders SET status = $1, shipped_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['enviado', id]
    );

    await localLog('local_order_shipped', 'local_order', id, req.user);

    res.json({ ok: true, status: 'enviado' });
  } catch (error) {
    console.error('[LOCAL] Error enviando:', error);
    res.status(500).json({ error: 'Error al marcar como enviado' });
  }
});

// =====================================================
// POST /api/local/orders/:id/start-control — Iniciar control
// =====================================================
router.post('/orders/:id/start-control', requirePermission('local.orders.control'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query('SELECT * FROM local_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];
    if (!['enviado', 'con_diferencias'].includes(order.status)) {
      return res.status(400).json({ error: `No se puede iniciar control desde estado: ${order.status}` });
    }

    // Reset control status de los items
    await pool.query(
      `UPDATE local_order_items SET control_status = 'pendiente', received_qty = NULL,
       control_checked_at = NULL, control_checked_by = NULL
       WHERE local_order_id = $1`,
      [id]
    );

    await pool.query(
      'UPDATE local_orders SET status = $1, received_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['en_control', id]
    );

    await localLog('local_order_control_started', 'local_order', id, req.user);

    res.json({ ok: true, status: 'en_control' });
  } catch (error) {
    console.error('[LOCAL] Error iniciando control:', error);
    res.status(500).json({ error: 'Error al iniciar control' });
  }
});

// =====================================================
// POST /api/local/orders/:id/control — Control ciego
// =====================================================
router.post('/orders/:id/control', requirePermission('local.orders.control'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Debe incluir items con cantidades recibidas' });
    }

    const orderResult = await client.query('SELECT * FROM local_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];
    if (order.status !== 'en_control') {
      return res.status(400).json({ error: 'La reserva debe estar en estado en_control' });
    }

    await client.query('BEGIN');

    let allOk = true;
    const controlResults = [];

    for (const item of items) {
      if (!item.item_id || item.received_qty === undefined || item.received_qty === null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cada ítem debe tener item_id y received_qty' });
      }

      // Obtener sent_qty para comparar
      const itemResult = await client.query(
        'SELECT sent_qty FROM local_order_items WHERE id = $1 AND local_order_id = $2',
        [item.item_id, id]
      );

      if (itemResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Ítem ${item.item_id} no encontrado en esta reserva` });
      }

      const sentQty = itemResult.rows[0].sent_qty;
      const receivedQty = parseInt(item.received_qty);
      const status = sentQty === receivedQty ? 'ok' : 'error';

      if (status === 'error') allOk = false;

      await client.query(
        `UPDATE local_order_items
         SET received_qty = $1, control_status = $2, control_checked_at = NOW(), control_checked_by = $3
         WHERE id = $4`,
        [receivedQty, status, req.user.id, item.item_id]
      );

      // NO revelar sent_qty al local — solo devolver el status
      controlResults.push({
        item_id: item.item_id,
        received_qty: receivedQty,
        control_status: status
      });
    }

    // Actualizar estado del pedido
    const newStatus = allOk ? 'en_control' : 'con_diferencias';
    await client.query(
      'UPDATE local_orders SET status = $1, updated_at = NOW() WHERE id = $2',
      [newStatus, id]
    );

    await client.query('COMMIT');

    await localLog('local_order_control_updated', 'local_order', id, req.user, {
      all_ok: allOk,
      items_checked: items.length
    });

    res.json({
      ok: true,
      all_ok: allOk,
      status: newStatus,
      items: controlResults
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL] Error en control:', error);
    res.status(500).json({ error: 'Error al procesar control' });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/local/orders/:id/confirm — Confirmar recepción
// =====================================================
router.post('/orders/:id/confirm', requirePermission('local.orders.confirm'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const orderResult = await client.query('SELECT * FROM local_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];
    if (order.status !== 'en_control') {
      return res.status(400).json({ error: 'Solo se puede confirmar desde estado en_control' });
    }

    // Verificar que TODOS los items estén en OK
    const pendingItems = await client.query(
      `SELECT COUNT(*) FROM local_order_items
       WHERE local_order_id = $1 AND control_status != 'ok'`,
      [id]
    );

    if (parseInt(pendingItems.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'Hay ítems que no pasaron el control. Todos deben estar en verde para confirmar.'
      });
    }

    await client.query('BEGIN');

    // Confirmar pedido
    await client.query(
      `UPDATE local_orders SET status = 'confirmado_local', confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    // Mover mercadería a stock del local
    const items = await client.query(
      'SELECT * FROM local_order_items WHERE local_order_id = $1',
      [id]
    );

    for (const item of items.rows) {
      await client.query(`
        INSERT INTO local_stock (product_id, variant_id, product_name, variant_name, qty)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (product_id, COALESCE(variant_id, ''))
        DO UPDATE SET qty = local_stock.qty + $5, product_name = $3, variant_name = $4, updated_at = NOW()
      `, [item.product_id, item.variant_id, item.product_name_snapshot, item.variant_name_snapshot, item.received_qty]);
    }

    await client.query('COMMIT');

    await localLog('local_order_confirmed', 'local_order', id, req.user, {
      items_count: items.rows.length,
      total_qty: items.rows.reduce((s, i) => s + i.received_qty, 0)
    });

    res.json({ ok: true, status: 'confirmado_local' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL] Error confirmando:', error);
    res.status(500).json({ error: 'Error al confirmar recepción' });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/local/orders/:id/cancel — Cancelar reserva
// =====================================================
router.post('/orders/:id/cancel', requirePermission('local.orders.cancel'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query('SELECT * FROM local_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const order = orderResult.rows[0];
    if (['confirmado_local', 'cancelado'].includes(order.status)) {
      return res.status(400).json({ error: `No se puede cancelar una reserva en estado: ${order.status}` });
    }

    await pool.query(
      'UPDATE local_orders SET status = $1, cancelled_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['cancelado', id]
    );

    await localLog('local_order_cancelled', 'local_order', id, req.user);

    res.json({ ok: true, status: 'cancelado' });
  } catch (error) {
    console.error('[LOCAL] Error cancelando:', error);
    res.status(500).json({ error: 'Error al cancelar reserva' });
  }
});

// =====================================================
// GET /api/local/stock — Stock asignado al local
// =====================================================
router.get('/stock', requireAnyPermission(['local.box.view', 'local.orders.view']), async (req, res) => {
  try {
    const { q } = req.query;
    let query = 'SELECT * FROM local_stock';
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      query += ` WHERE product_name ILIKE $1 OR variant_name ILIKE $1`;
    }

    query += ' ORDER BY product_name, variant_name';

    const result = await pool.query(query, params);
    res.json({ ok: true, stock: result.rows });
  } catch (error) {
    console.error('[LOCAL] Error obteniendo stock:', error);
    res.status(500).json({ error: 'Error al obtener stock del local' });
  }
});

module.exports = router;
