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

    res.json({
      ok: true,
      order: {
        order_number: order.order_number,
        estado_pedido: order.estado_pedido,
        customer_name: order.customer_name,
        bultos: order.bultos,
      },
      buttons,
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
    const { codigo, to_status, bultos } = req.body || {};

    // 1. Validar inputs básicos.
    if (!codigo || !/^[0-9]{4}$/.test(codigo)) {
      return res.status(400).json({ error: 'Código inválido (debe ser 4 dígitos numéricos)' });
    }
    if (!to_status || typeof to_status !== 'string') {
      return res.status(400).json({ error: 'to_status requerido' });
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
