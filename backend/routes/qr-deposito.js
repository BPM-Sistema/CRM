/**
 * Rutas del QR del depósito (Fase 2 PR 4).
 *
 * Montadas en /q en index.js. Sin autenticación a nivel HTTP — la "auth"
 * es el código de 4 dígitos del empleado, validado en POST /transition.
 *
 * GET /:orderNumber          — datos para renderizar la página /q/:orderNumber
 * POST /:orderNumber/transition — ejecutar una transición desde el QR
 *
 * Razón: cualquier persona con el celular puede escanear el QR y ver el
 * estado (read-only). Solo al accionar un botón se pide el código. Esto
 * evita exponer un panel admin público pero mantiene la UX fluida en depo.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { findTransition, allowedFrom, permissionKey } = require('../lib/qr-deposito-transitions');
const { derivarEstadoDesdeEmpaquetado, accionParaEstado } = require('../lib/estados-pedido');
const { logEvento } = require('../utils/logging');
const { notifyEstadoTransition } = require('../lib/notify-estado-transition');

// ─── Helper: leer pedido base ──────────────────────────────────
async function loadOrder(orderNumber) {
  const r = await pool.query(
    `SELECT order_number, estado_pedido, estado_pago, customer_name,
            shipping_type, bultos
     FROM orders_validated
     WHERE order_number = $1`,
    [orderNumber]
  );
  return r.rows[0] || null;
}

// ─── GET /:orderNumber ─────────────────────────────────────────
router.get('/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const order = await loadOrder(orderNumber);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    if (order.estado_pedido === 'cancelado') {
      return res.status(400).json({ error: 'Pedido cancelado' });
    }

    const buttons = allowedFrom(order.estado_pedido).map(t => ({
      to: t.to,
      requiresBultos: !!t.requiresBultos,
      selfTransition: !!t.selfTransition,
    }));

    // Productos del pedido — los necesita el modal de pendiente_stock (PR 4.5).
    const productsRes = await pool.query(
      `SELECT id, product_id, name, variant, sku, quantity
       FROM order_products
       WHERE order_number = $1
       ORDER BY name ASC`,
      [orderNumber]
    );

    res.json({
      ok: true,
      order: {
        order_number: order.order_number,
        estado_pedido: order.estado_pedido,
        customer_name: order.customer_name,
        bultos: order.bultos,
      },
      buttons,
      products: productsRes.rows,
    });
  } catch (err) {
    console.error('❌ GET /q/:orderNumber error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /:orderNumber/transition ─────────────────────────────
router.post('/:orderNumber/transition', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { codigo, to_status, bultos, stock_missing } = req.body || {};

    // 1. Validar inputs básicos.
    if (!codigo || !/^[0-9]{4}$/.test(codigo)) {
      return res.status(400).json({ error: 'Código inválido (debe ser 4 dígitos numéricos)' });
    }
    if (!to_status || typeof to_status !== 'string') {
      return res.status(400).json({ error: 'to_status requerido' });
    }

    // 1.5. Si va a pendiente_stock, stock_missing es obligatorio (>=1 item).
    let stockMissingValidated = null;
    if (to_status === 'pendiente_stock') {
      if (!Array.isArray(stock_missing) || stock_missing.length === 0) {
        return res.status(400).json({
          error: 'Para pasar a Pend. Stock tenés que indicar al menos un producto faltante',
        });
      }
      // Validar cada item del array.
      stockMissingValidated = [];
      for (const item of stock_missing) {
        if (!item || typeof item !== 'object') {
          return res.status(400).json({ error: 'stock_missing: item inválido' });
        }
        const opId = parseInt(item.order_product_id, 10);
        const qty = parseInt(item.quantity_missing, 10);
        if (!Number.isInteger(opId) || opId < 1) {
          return res.status(400).json({ error: 'stock_missing: order_product_id inválido' });
        }
        if (!Number.isInteger(qty) || qty < 1) {
          return res.status(400).json({ error: 'stock_missing: quantity_missing debe ser >= 1' });
        }
        stockMissingValidated.push({ order_product_id: opId, quantity_missing: qty });
      }
    }

    // 2. Cargar pedido.
    const order = await loadOrder(orderNumber);
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    if (order.estado_pedido === 'cancelado') {
      return res.status(400).json({ error: 'Pedido cancelado' });
    }

    // 3. Validar transición permitida desde el estado actual.
    const trans = findTransition(order.estado_pedido, to_status);
    if (!trans) {
      return res.status(400).json({
        error: `Transición no permitida desde "${order.estado_pedido}" a "${to_status}"`,
      });
    }

    // 4. Validar bultos cuando aplica.
    let bultosFinal = order.bultos;
    if (trans.requiresBultos) {
      const n = parseInt(bultos, 10);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        return res.status(400).json({ error: 'Cantidad de bultos debe ser un entero entre 1 y 10' });
      }
      bultosFinal = n;
    }

    // 5. Validar código del empleado + permiso para esta transición.
    const empleadoRes = await pool.query(
      `SELECT id, nombre, active FROM warehouse_users WHERE codigo = $1`,
      [codigo]
    );
    if (empleadoRes.rowCount === 0 || !empleadoRes.rows[0].active) {
      return res.status(403).json({ error: 'Código inválido o empleado inactivo' });
    }
    const empleado = empleadoRes.rows[0];

    const permRes = await pool.query(
      `SELECT 1 FROM warehouse_user_permissions
       WHERE warehouse_user_id = $1 AND transicion = $2`,
      [empleado.id, permissionKey(to_status)]
    );
    if (permRes.rowCount === 0) {
      return res.status(403).json({
        error: `${empleado.nombre} no tiene permiso para esta acción`,
      });
    }

    // 6. Ejecutar el cambio. Atomic: usamos un client + transacción.
    const client = await pool.connect();
    let estadoFinal = to_status;
    let derivadoLog = null;
    try {
      await client.query('BEGIN');

      // 6a. UPDATE orders_validated (estado + bultos + timestamps).
      const ovUpdates = [];
      const ovParams = [];
      let idx = 1;
      if (!trans.selfTransition) {
        ovUpdates.push(`estado_pedido = $${idx++}`);
        ovParams.push(to_status);
      }
      ovUpdates.push(`bultos = $${idx++}`);
      ovParams.push(bultosFinal);
      if (to_status === 'empaquetado' && !trans.selfTransition) {
        // packed_at solo la primera vez (igual que el endpoint clásico).
        ovUpdates.push(`packed_at = COALESCE(packed_at, NOW())`);
      }
      ovParams.push(orderNumber);

      await client.query(
        `UPDATE orders_validated SET ${ovUpdates.join(', ')} WHERE order_number = $${idx}`,
        ovParams
      );

      // 6b. Sync con shipping_requests (si existe). Mantiene la columna vieja
      // alineada con la nueva. data_updated_at prende el badge oficina.
      // Solo afecta la fila MÁS RECIENTE — preservar el histórico de filas
      // anteriores (cada SR vieja queda con el label_bultos que tenía al
      // imprimirse en su momento).
      if (trans.requiresBultos) {
        await client.query(
          `UPDATE shipping_requests
           SET label_bultos = $1, data_updated_at = NOW()
           WHERE id = (
             SELECT id FROM shipping_requests
             WHERE order_number = $2
             ORDER BY created_at DESC LIMIT 1
           )`,
          [bultosFinal, orderNumber]
        );
      }

      // 6b.2. Auto-resolve de stock issues abiertos cuando sale de pendiente_stock.
      // Fase 2 PR 4.5: cuando el pedido sale de pendiente_stock (típicamente
      // pasa a en_revision), cerrar todos los issues abiertos automáticamente.
      // resolved_by_user_id queda NULL → indica que fue auto-resolve.
      if (order.estado_pedido === 'pendiente_stock' && to_status !== 'pendiente_stock') {
        await client.query(
          `UPDATE warehouse_stock_issues
           SET resolved_at = NOW(), resolved_by_user_id = NULL
           WHERE order_number = $1 AND resolved_at IS NULL`,
          [orderNumber]
        );
      }

      // 6b.3. INSERT de stock issues cuando pasa a pendiente_stock.
      // Uno por producto faltante. Snapshot de product_name/variant/sku.
      if (to_status === 'pendiente_stock' && stockMissingValidated) {
        // Cargar snapshot + quantity para validar y registrar.
        const opIds = stockMissingValidated.map(s => s.order_product_id);
        const snapshotRes = await client.query(
          `SELECT id, name, variant, sku, quantity FROM order_products
           WHERE id = ANY($1) AND order_number = $2`,
          [opIds, orderNumber]
        );
        const snapshotById = new Map(snapshotRes.rows.map(r => [r.id, r]));
        // Validar que todos los order_product_id existen en este pedido +
        // que quantity_missing no exceda la cantidad pedida (defensa en
        // profundidad: el frontend ya lo limita pero un POST directo podría
        // saltearse esa validación).
        for (const item of stockMissingValidated) {
          const snap = snapshotById.get(item.order_product_id);
          if (!snap) {
            throw new Error(`Producto inválido (order_product_id=${item.order_product_id} no pertenece a este pedido)`);
          }
          if (item.quantity_missing > snap.quantity) {
            throw new Error(`Cantidad faltante (${item.quantity_missing}) excede la cantidad pedida (${snap.quantity}) para "${snap.name}"`);
          }
        }
        for (const item of stockMissingValidated) {
          const snap = snapshotById.get(item.order_product_id);
          await client.query(
            `INSERT INTO warehouse_stock_issues
               (order_number, order_product_id, product_name, variant, sku,
                quantity_missing, reported_by_warehouse_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orderNumber, snap.id, snap.name, snap.variant, snap.sku,
             item.quantity_missing, empleado.id]
          );
        }
      }

      // 6c. Trigger A.2 si pasa a empaquetado con pago confirmado.
      if (to_status === 'empaquetado' && !trans.selfTransition &&
          (order.estado_pago === 'confirmado_total' || order.estado_pago === 'a_favor')) {
        const ctxRes = await client.query(
          `SELECT
             EXISTS (SELECT 1 FROM shipping_requests WHERE order_number = ov.order_number) AS has_shipping_request,
             (SELECT empresa_envio FROM shipping_requests
                WHERE order_number = ov.order_number
                ORDER BY created_at DESC LIMIT 1) AS empresa_envio
           FROM orders_validated ov WHERE ov.order_number = $1`,
          [orderNumber]
        );
        const ctx = ctxRes.rows[0] || {};
        const derivado = derivarEstadoDesdeEmpaquetado({
          shipping_type: order.shipping_type,
          empresa_envio: ctx.empresa_envio,
          has_shipping_request: ctx.has_shipping_request,
        });
        if (derivado !== 'empaquetado') {
          await client.query(
            `UPDATE orders_validated SET estado_pedido = $1 WHERE order_number = $2`,
            [derivado, orderNumber]
          );
          estadoFinal = derivado;
          derivadoLog = derivado;
        }
      }

      // 6d. Log nuevo del depo.
      await client.query(
        `INSERT INTO warehouse_state_transitions
           (order_number, from_status, to_status, warehouse_user_id, source)
         VALUES ($1, $2, $3, $4, 'qr')`,
        [orderNumber, order.estado_pedido, estadoFinal, empleado.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // 7. Logs existentes del CRM (fuera de la transacción, fire-and-forget).
    setImmediate(() => {
      logEvento({
        orderNumber,
        accion: accionParaEstado(to_status),
        origen: 'qr_deposito',
        userId: null,
        username: `depo:${empleado.nombre}`,
      }).catch(() => {});
      if (derivadoLog) {
        logEvento({
          orderNumber,
          accion: accionParaEstado(derivadoLog),
          origen: 'trigger_auto_pago',
        }).catch(() => {});
      }
    });

    // 8. WhatsApp de transición (PR 1). Helper hace re-lectura del estado
    // post-commit, así que se puede llamar inmediatamente.
    notifyEstadoTransition({
      orderNumber,
      fromEstado: order.estado_pedido,
      toEstado: estadoFinal,
      estadoPago: order.estado_pago,
    }).catch(err => console.error('[qr] notifyEstadoTransition fallo:', err.message));

    res.json({
      ok: true,
      estado_final: estadoFinal,
      bultos: bultosFinal,
      empleado: empleado.nombre,
      derivado: derivadoLog,
    });
  } catch (err) {
    console.error('❌ POST /q/:orderNumber/transition error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
