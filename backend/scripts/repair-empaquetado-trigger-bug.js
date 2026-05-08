#!/usr/bin/env node
/**
 * Repara pedidos afectados por el bug de Fase 1 PR 6 (deploy 2026-05-07):
 * la query del trigger automático usaba `ov.shipping` (columna inexistente)
 * y explotaba después de marcar el pedido como `empaquetado`. Resultado:
 * el pedido quedaba en `empaquetado` con pago confirmado, pero NO avanzaba
 * al estado derivado (`pendiente_retiro` / `por_enviar` / `pendiente_datos_envio`).
 *
 * Este script busca esa combinación inválida (post-Fase 1) y la repara
 * aplicando el mismo helper que ahora usa el trigger en runtime.
 *
 * Modo DRY-RUN por defecto. Pasar --apply para escribir.
 *
 * Uso:
 *   node scripts/repair-empaquetado-trigger-bug.js          # diagnóstico
 *   node scripts/repair-empaquetado-trigger-bug.js --apply  # aplicar fix
 */
require('dotenv').config();
const { Pool } = require('pg');
const { derivarEstadoDesdeEmpaquetado, accionParaEstado } = require('../lib/estados-pedido');
const { logEvento } = require('../utils/logging');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(`
    SELECT
      ov.order_number,
      ov.estado_pedido,
      ov.estado_pago,
      ov.shipping_type,
      ov.packed_at,
      EXISTS (SELECT 1 FROM shipping_requests WHERE order_number = ov.order_number) AS has_shipping_request,
      (SELECT empresa_envio FROM shipping_requests
        WHERE order_number = ov.order_number
        ORDER BY created_at DESC LIMIT 1) AS empresa_envio
    FROM orders_validated ov
    WHERE ov.estado_pedido = 'empaquetado'
      AND ov.estado_pago IN ('confirmado_total', 'a_favor')
    ORDER BY ov.packed_at DESC NULLS LAST
  `);

  if (rows.length === 0) {
    console.log('✅ No hay pedidos afectados. Combinación empaquetado + pago confirmado: 0.');
    await pool.end();
    return;
  }

  console.log(`🔍 ${rows.length} pedido(s) en empaquetado + pago confirmado. Analizando derivación…\n`);

  const buckets = { pendiente_retiro: [], por_enviar: [], pendiente_datos_envio: [], empaquetado: [] };

  for (const r of rows) {
    const derivado = derivarEstadoDesdeEmpaquetado({
      shipping_type: r.shipping_type,
      empresa_envio: r.empresa_envio,
      has_shipping_request: r.has_shipping_request,
    });
    buckets[derivado].push(r);
  }

  console.log('Distribución del derivado:');
  console.log(`  pendiente_retiro:       ${buckets.pendiente_retiro.length}`);
  console.log(`  por_enviar:             ${buckets.por_enviar.length}`);
  console.log(`  pendiente_datos_envio:  ${buckets.pendiente_datos_envio.length}`);
  console.log(`  empaquetado (no-op):    ${buckets.empaquetado.length}\n`);

  const aMover = rows.filter(r => {
    const d = derivarEstadoDesdeEmpaquetado({
      shipping_type: r.shipping_type,
      empresa_envio: r.empresa_envio,
      has_shipping_request: r.has_shipping_request,
    });
    return d !== 'empaquetado';
  });

  console.log('Detalle:');
  for (const r of aMover) {
    const derivado = derivarEstadoDesdeEmpaquetado({
      shipping_type: r.shipping_type,
      empresa_envio: r.empresa_envio,
      has_shipping_request: r.has_shipping_request,
    });
    console.log(
      `  #${r.order_number}  shipping_type=${JSON.stringify(r.shipping_type)}  empresa_envio=${JSON.stringify(r.empresa_envio)}  has_sr=${r.has_shipping_request}  →  ${derivado}`
    );
  }

  if (!APPLY) {
    console.log(`\n💡 DRY-RUN. ${aMover.length} pedido(s) se moverían. Pasar --apply para escribir.`);
    await pool.end();
    return;
  }

  console.log(`\n✏️  Aplicando ${aMover.length} cambio(s)…\n`);
  let ok = 0;
  for (const r of aMover) {
    const derivado = derivarEstadoDesdeEmpaquetado({
      shipping_type: r.shipping_type,
      empresa_envio: r.empresa_envio,
      has_shipping_request: r.has_shipping_request,
    });
    try {
      await pool.query(
        `UPDATE orders_validated SET estado_pedido = $1 WHERE order_number = $2`,
        [derivado, r.order_number]
      );
      await logEvento({
        orderNumber: r.order_number,
        accion: accionParaEstado(derivado),
        origen: 'repair_trigger_bug',
      });
      ok++;
      console.log(`  ✓ #${r.order_number} → ${derivado}`);
    } catch (err) {
      console.error(`  ✗ #${r.order_number}: ${err.message}`);
    }
  }
  console.log(`\n✅ Reparados ${ok}/${aMover.length}.`);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
