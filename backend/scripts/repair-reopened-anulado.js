#!/usr/bin/env node
/**
 * Repara pedidos reabiertos que quedaron con `estado_pago='anulado'/'reembolsado'`
 * como residuo de una cancelacion previa.
 *
 * Aplica la misma logica que el reopen del webhook (post-fix):
 *   1) estado_pago anulado/reembolsado -> 'pendiente' (placeholder)
 *   2) estado_pedido: si printed_at IS NOT NULL -> 'hoja_impresa'; else 'pendiente_pago'.
 *      Pero NO retrocede estados mas avanzados (armado/enviado/etc).
 *   3) recalcularPagos -> recompone estado_pago + estado_pedido segun pagos reales.
 *
 * Modo DRY-RUN por defecto. Pasar --apply para escribir.
 *
 * Uso:
 *   node scripts/repair-reopened-anulado.js          # diagnostico
 *   node scripts/repair-reopened-anulado.js --apply  # aplicar fix
 */
require('dotenv').config();
const { Pool } = require('pg');
const { recalcularPagos } = require('../lib/recalcularPagos');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const APPLY = process.argv.includes('--apply');

const ESTADOS_AVANZADOS_NO_RETROCEDER = new Set([
  'hoja_impresa', 'armado', 'retirado', 'en_calle', 'enviado'
]);

async function main() {
  const { rows } = await pool.query(`
    SELECT order_number, estado_pedido, estado_pago, total_pagado, monto_tiendanube, printed_at
    FROM orders_validated
    WHERE estado_pedido != 'cancelado'
      AND estado_pago IN ('anulado','reembolsado')
    ORDER BY updated_at DESC
  `);

  if (rows.length === 0) {
    console.log('No hay pedidos en limbo (reabiertos con estado_pago anulado/reembolsado).');
    await pool.end();
    return;
  }

  console.log(`Encontrados ${rows.length} pedidos en limbo:\n`);
  for (const o of rows) {
    console.log(`  #${o.order_number} | estado_pedido=${o.estado_pedido} | estado_pago=${o.estado_pago} | printed_at=${o.printed_at || '—'}`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN. Use --apply para escribir.');
    await pool.end();
    return;
  }

  console.log('\nAplicando reparacion...');

  let ok = 0;
  let fail = 0;

  for (const o of rows) {
    const orderNumber = o.order_number;
    try {
      // Paso 1: si el estado_pedido es PENDIENTE_PAGO o A_IMPRIMIR -> aplicar el placeholder
      // (mismo CASE que el fix del webhook).
      // Si el pedido ya esta en un estado avanzado (hoja_impresa/armado/enviado/...),
      // dejamos estado_pedido como esta y solo limpiamos estado_pago.
      // calcularEstadoPedido NO retrocede estados avanzados, asi que es seguro.
      if (ESTADOS_AVANZADOS_NO_RETROCEDER.has(o.estado_pedido)) {
        await pool.query(
          `UPDATE orders_validated
           SET estado_pago = CASE
                 WHEN estado_pago IN ('anulado','reembolsado') THEN 'pendiente'
                 ELSE estado_pago
               END,
               updated_at = NOW()
           WHERE order_number = $1`,
          [orderNumber]
        );
      } else {
        await pool.query(
          `UPDATE orders_validated
           SET estado_pago = CASE
                 WHEN estado_pago IN ('anulado','reembolsado') THEN 'pendiente'
                 ELSE estado_pago
               END,
               estado_pedido = CASE
                 WHEN printed_at IS NOT NULL THEN 'hoja_impresa'
                 ELSE 'pendiente_pago'
               END,
               updated_at = NOW()
           WHERE order_number = $1`,
          [orderNumber]
        );
      }

      const recalc = await recalcularPagos(pool, orderNumber);

      await pool.query(
        `INSERT INTO logs (order_number, accion, origen, created_at)
         VALUES ($1, $2, 'script_repair', NOW())`,
        [orderNumber, `Reparacion limbo reabierto (estado_pedido=${recalc.estadoPedido}, estado_pago=${recalc.estadoPago})`]
      );

      console.log(`  OK #${orderNumber}: ${o.estado_pedido}/${o.estado_pago} -> ${recalc.estadoPedido}/${recalc.estadoPago}`);
      ok++;
    } catch (err) {
      console.error(`  FAIL #${orderNumber}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nResultado: ok=${ok} fail=${fail}`);
  await pool.end();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
