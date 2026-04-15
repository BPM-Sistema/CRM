const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// Helper: log
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
// POST /api/local/box-orders — Crear pedido de caja
// =====================================================
router.post('/', requirePermission('local.box.create'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, notes } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Debe incluir al menos un ítem' });
    }

    await client.query('BEGIN');

    // Validar stock disponible en local
    for (const item of items) {
      if (!item.product_id || !item.product_name || !item.qty || item.qty < 1 || !item.unit_price) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cada ítem debe tener product_id, product_name, qty > 0 y unit_price' });
      }

      const stockResult = await client.query(
        `SELECT qty FROM local_stock WHERE product_id = $1 AND COALESCE(variant_id, '') = COALESCE($2, '')`,
        [item.product_id, item.variant_id || null]
      );

      const available = stockResult.rows.length > 0 ? stockResult.rows[0].qty : 0;
      if (available < item.qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Stock insuficiente para ${item.product_name}${item.variant_name ? ' - ' + item.variant_name : ''}. Disponible: ${available}, solicitado: ${item.qty}`
        });
      }
    }

    // Calcular total
    let totalAmount = 0;
    for (const item of items) {
      totalAmount += item.qty * item.unit_price;
    }

    const orderResult = await client.query(
      `INSERT INTO local_box_orders (created_by_user_id, notes, total_amount)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.user.id, notes || null, totalAmount]
    );
    const order = orderResult.rows[0];

    const insertedItems = [];
    for (const item of items) {
      const lineTotal = item.qty * item.unit_price;
      const itemResult = await client.query(
        `INSERT INTO local_box_order_items
          (local_box_order_id, product_id, variant_id, sku_snapshot, product_name_snapshot, variant_name_snapshot, qty, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          order.id,
          item.product_id,
          item.variant_id || null,
          item.sku || null,
          item.product_name,
          item.variant_name || null,
          item.qty,
          item.unit_price,
          lineTotal
        ]
      );
      insertedItems.push(itemResult.rows[0]);

      // Descontar stock del local
      await client.query(
        `UPDATE local_stock SET qty = qty - $1, updated_at = NOW()
         WHERE product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')`,
        [item.qty, item.product_id, item.variant_id || null]
      );
    }

    await client.query('COMMIT');

    await localLog('local_box_order_created', 'local_box_order', order.id, req.user, {
      items_count: items.length,
      total_amount: totalAmount
    });

    res.status(201).json({
      ok: true,
      order: { ...order, items: insertedItems }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL BOX] Error creando pedido:', error);
    res.status(500).json({ error: 'Error al crear pedido de caja' });
  } finally {
    client.release();
  }
});

// =====================================================
// GET /api/local/box-orders — Listar pedidos de caja
// =====================================================
router.get('/', requirePermission('local.box.view'), async (req, res) => {
  try {
    const { status, payment_status, search, date, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`bo.status = $${params.length}`);
    }

    if (payment_status && payment_status !== 'all') {
      params.push(payment_status);
      conditions.push(`bo.payment_status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(bo.local_box_order_number::text ILIKE $${params.length} OR bo.notes ILIKE $${params.length})`);
    }

    if (date) {
      params.push(date);
      conditions.push(`bo.created_at::date = $${params.length}::date`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM local_box_orders bo ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit));
    params.push(offset);

    const result = await pool.query(`
      SELECT bo.*, u.name AS created_by_name,
        (SELECT COUNT(*) FROM local_box_order_items WHERE local_box_order_id = bo.id) AS items_count
      FROM local_box_orders bo
      LEFT JOIN users u ON bo.created_by_user_id = u.id
      ${where}
      ORDER BY bo.created_at DESC
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
    console.error('[LOCAL BOX] Error listando:', error);
    res.status(500).json({ error: 'Error al listar pedidos de caja' });
  }
});

// =====================================================
// GET /api/local/box-orders/daily — Caja diaria
// =====================================================
router.get('/daily', requirePermission('local.box.view'), async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_orders,
        COUNT(*) FILTER (WHERE payment_status = 'pagado_total') AS paid_orders,
        COUNT(*) FILTER (WHERE payment_status = 'pendiente_pago') AS pending_orders,
        COUNT(*) FILTER (WHERE payment_status = 'pagado_parcial') AS partial_orders,
        COALESCE(SUM(total_amount), 0) AS total_sold,
        COALESCE(SUM(paid_amount), 0) AS total_collected,
        COALESCE(SUM(total_amount) - SUM(paid_amount), 0) AS pending_amount
      FROM local_box_orders
      WHERE created_at::date = $1::date AND status != 'cancelado'
    `, [targetDate]);

    const orders = await pool.query(`
      SELECT bo.*, u.name AS created_by_name
      FROM local_box_orders bo
      LEFT JOIN users u ON bo.created_by_user_id = u.id
      WHERE bo.created_at::date = $1::date AND bo.status != 'cancelado'
      ORDER BY bo.created_at DESC
    `, [targetDate]);

    res.json({
      ok: true,
      date: targetDate,
      summary: result.rows[0],
      orders: orders.rows
    });
  } catch (error) {
    console.error('[LOCAL BOX] Error caja diaria:', error);
    res.status(500).json({ error: 'Error al obtener caja diaria' });
  }
});

// =====================================================
// GET /api/local/box-orders/:id — Detalle de pedido de caja
// =====================================================
router.get('/:id', requirePermission('local.box.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query(`
      SELECT bo.*, u.name AS created_by_name
      FROM local_box_orders bo
      LEFT JOIN users u ON bo.created_by_user_id = u.id
      WHERE bo.id = $1
    `, [id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido de caja no encontrado' });
    }

    const items = await pool.query(
      'SELECT * FROM local_box_order_items WHERE local_box_order_id = $1 ORDER BY product_name_snapshot',
      [id]
    );

    const logs = await pool.query(
      `SELECT * FROM local_logs WHERE entity_type = 'local_box_order' AND entity_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id]
    );

    res.json({
      ok: true,
      order: {
        ...orderResult.rows[0],
        items: items.rows,
        logs: logs.rows
      }
    });
  } catch (error) {
    console.error('[LOCAL BOX] Error detalle:', error);
    res.status(500).json({ error: 'Error al obtener detalle' });
  }
});

// =====================================================
// PATCH /api/local/box-orders/:id — Editar pedido de caja
// =====================================================
router.patch('/:id', requirePermission('local.box.edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items, notes } = req.body;

    const orderResult = await client.query('SELECT * FROM local_box_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderResult.rows[0];
    if (order.status === 'cancelado') {
      return res.status(400).json({ error: 'No se puede editar un pedido cancelado' });
    }

    await client.query('BEGIN');

    if (notes !== undefined) {
      await client.query('UPDATE local_box_orders SET notes = $1, updated_at = NOW() WHERE id = $2', [notes, id]);
    }

    if (items && Array.isArray(items)) {
      // Devolver stock de items anteriores
      const oldItems = await client.query('SELECT * FROM local_box_order_items WHERE local_box_order_id = $1', [id]);
      for (const oldItem of oldItems.rows) {
        await client.query(
          `UPDATE local_stock SET qty = qty + $1, updated_at = NOW()
           WHERE product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')`,
          [oldItem.qty, oldItem.product_id, oldItem.variant_id || null]
        );
      }

      // Validar stock para nuevos items
      for (const item of items) {
        const stockResult = await client.query(
          `SELECT qty FROM local_stock WHERE product_id = $1 AND COALESCE(variant_id, '') = COALESCE($2, '')`,
          [item.product_id, item.variant_id || null]
        );
        const available = stockResult.rows.length > 0 ? stockResult.rows[0].qty : 0;
        if (available < item.qty) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Stock insuficiente para ${item.product_name}. Disponible: ${available}`
          });
        }
      }

      // Eliminar items viejos
      await client.query('DELETE FROM local_box_order_items WHERE local_box_order_id = $1', [id]);

      // Insertar nuevos items y descontar stock
      let totalAmount = 0;
      for (const item of items) {
        const lineTotal = item.qty * item.unit_price;
        totalAmount += lineTotal;

        await client.query(
          `INSERT INTO local_box_order_items
            (local_box_order_id, product_id, variant_id, sku_snapshot, product_name_snapshot, variant_name_snapshot, qty, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, item.product_id, item.variant_id || null, item.sku || null,
           item.product_name, item.variant_name || null, item.qty, item.unit_price, lineTotal]
        );

        await client.query(
          `UPDATE local_stock SET qty = qty - $1, updated_at = NOW()
           WHERE product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')`,
          [item.qty, item.product_id, item.variant_id || null]
        );
      }

      // Si el total cambió y ya estaba pagado, volver a pendiente
      const wasPaid = ['pagado_total', 'pagado_parcial'].includes(order.payment_status);
      const totalChanged = Math.abs(totalAmount - parseFloat(order.total_amount)) > 0.01;

      let paymentStatus = order.payment_status;
      if (wasPaid && totalChanged) {
        const paidAmount = parseFloat(order.paid_amount);
        if (paidAmount >= totalAmount) {
          paymentStatus = 'pagado_total';
        } else if (paidAmount > 0) {
          paymentStatus = 'pagado_parcial';
        } else {
          paymentStatus = 'pendiente_pago';
        }
      }

      await client.query(
        `UPDATE local_box_orders SET total_amount = $1, payment_status = $2, updated_at = NOW() WHERE id = $3`,
        [totalAmount, paymentStatus, id]
      );
    }

    await client.query('COMMIT');

    await localLog('local_box_order_updated', 'local_box_order', id, req.user, {
      items_changed: !!items
    });

    // Devolver actualizado
    const updated = await pool.query(`
      SELECT bo.*, u.name AS created_by_name FROM local_box_orders bo
      LEFT JOIN users u ON bo.created_by_user_id = u.id WHERE bo.id = $1
    `, [id]);
    const updatedItems = await pool.query('SELECT * FROM local_box_order_items WHERE local_box_order_id = $1', [id]);

    res.json({
      ok: true,
      order: { ...updated.rows[0], items: updatedItems.rows }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL BOX] Error editando:', error);
    res.status(500).json({ error: 'Error al editar pedido' });
  } finally {
    client.release();
  }
});

// =====================================================
// POST /api/local/box-orders/:id/print — Imprimir pedido de caja
// =====================================================
router.post('/:id/print', requirePermission('local.box.print'), async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await pool.query(`
      SELECT bo.*, u.name AS created_by_name FROM local_box_orders bo
      LEFT JOIN users u ON bo.created_by_user_id = u.id WHERE bo.id = $1
    `, [id]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const items = await pool.query(
      'SELECT * FROM local_box_order_items WHERE local_box_order_id = $1 ORDER BY product_name_snapshot',
      [id]
    );

    await pool.query(
      `UPDATE local_box_orders SET printed_at = NOW(), status = CASE WHEN status = 'borrador' THEN 'impreso' ELSE status END, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await localLog('local_box_order_printed', 'local_box_order', id, req.user);

    res.json({
      ok: true,
      print: {
        order: orderResult.rows[0],
        items: items.rows
      }
    });
  } catch (error) {
    console.error('[LOCAL BOX] Error imprimiendo:', error);
    res.status(500).json({ error: 'Error al imprimir' });
  }
});

// =====================================================
// POST /api/local/box-orders/:id/pay — Registrar pago
// =====================================================
router.post('/:id/pay', requirePermission('local.box.pay'), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    }

    const orderResult = await pool.query('SELECT * FROM local_box_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderResult.rows[0];
    if (order.status === 'cancelado') {
      return res.status(400).json({ error: 'No se puede pagar un pedido cancelado' });
    }

    const newPaidAmount = parseFloat(order.paid_amount) + parseFloat(amount);
    const totalAmount = parseFloat(order.total_amount);

    let paymentStatus;
    if (newPaidAmount >= totalAmount) {
      paymentStatus = 'pagado_total';
    } else {
      paymentStatus = 'pagado_parcial';
    }

    await pool.query(
      `UPDATE local_box_orders
       SET paid_amount = $1, payment_status = $2, paid_at = NOW(),
           confirmed_paid_at = CASE WHEN $2 = 'pagado_total' THEN NOW() ELSE confirmed_paid_at END,
           status = CASE WHEN status IN ('borrador', 'impreso') THEN 'pendiente_pago' ELSE status END,
           updated_at = NOW()
       WHERE id = $3`,
      [newPaidAmount, paymentStatus, id]
    );

    await localLog('local_box_order_paid', 'local_box_order', id, req.user, {
      amount: parseFloat(amount),
      new_total_paid: newPaidAmount,
      payment_status: paymentStatus
    });

    res.json({
      ok: true,
      paid_amount: newPaidAmount,
      total_amount: totalAmount,
      payment_status: paymentStatus,
      remaining: Math.max(0, totalAmount - newPaidAmount)
    });
  } catch (error) {
    console.error('[LOCAL BOX] Error pagando:', error);
    res.status(500).json({ error: 'Error al registrar pago' });
  }
});

// =====================================================
// POST /api/local/box-orders/:id/cancel — Cancelar pedido
// =====================================================
router.post('/:id/cancel', requirePermission('local.box.edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const orderResult = await client.query('SELECT * FROM local_box_orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const order = orderResult.rows[0];
    if (order.status === 'cancelado') {
      return res.status(400).json({ error: 'Ya está cancelado' });
    }

    await client.query('BEGIN');

    // Devolver stock
    const items = await client.query('SELECT * FROM local_box_order_items WHERE local_box_order_id = $1', [id]);
    for (const item of items.rows) {
      await client.query(
        `UPDATE local_stock SET qty = qty + $1, updated_at = NOW()
         WHERE product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')`,
        [item.qty, item.product_id, item.variant_id || null]
      );
    }

    await client.query(
      `UPDATE local_box_orders SET status = 'cancelado', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await client.query('COMMIT');

    await localLog('local_box_order_cancelled', 'local_box_order', id, req.user);

    res.json({ ok: true, status: 'cancelado' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[LOCAL BOX] Error cancelando:', error);
    res.status(500).json({ error: 'Error al cancelar' });
  } finally {
    client.release();
  }
});

module.exports = router;
