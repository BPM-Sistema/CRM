#!/usr/bin/env node
/**
 * Backfill pendiente_10hs para pedidos `pendiente_pago` que no tienen el
 * recordatorio programado. Calcula sendAt = nextBusinessSendAtAR(created_at, 10).
 *
 * Filtros:
 *   - estado_pedido = 'pendiente_pago'
 *   - estado_pago = 'pendiente'
 *   - sin comprobante en (pendiente, a_confirmar)
 *   - sin pendiente_10hs ya programado en scheduled_whatsapp
 *   - con teléfono
 *   - customer_name <> 'local local'
 *
 * Si el sendAt calculado ya pasó (por la antigüedad del pedido), se programa
 * con NOW() ajustado a próximo horario laboral hábil para que se mande hoy.
 *
 * Uso:
 *   node scripts/backfill-pendiente-10hs.js                   # dry-run (default)
 *   node scripts/backfill-pendiente-10hs.js --execute         # ejecuta los INSERT
 *   node scripts/backfill-pendiente-10hs.js --limit=N         # tope de pedidos
 *   node scripts/backfill-pendiente-10hs.js --only-order=NNN  # un solo pedido
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = require('../db');
const { nextBusinessSendAtAR } = require('../utils/businessHours');

function parseFlag(name) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const limit = parseInt(parseFlag('limit')) || 1000;
  const onlyOrder = parseFlag('only-order');

  console.log(`\n=== backfill-pendiente-10hs [${execute ? 'EXECUTE' : 'DRY-RUN'}] limit=${limit}${onlyOrder ? ` only-order=${onlyOrder}` : ''} ===\n`);

  const conditions = [
    `o.estado_pedido = 'pendiente_pago'`,
    `o.estado_pago = 'pendiente'`,
    `o.customer_phone IS NOT NULL AND o.customer_phone <> ''`,
    `LOWER(TRIM(COALESCE(o.customer_name,''))) <> 'local local'`,
    `NOT EXISTS (SELECT 1 FROM scheduled_whatsapp s WHERE s.order_number = o.order_number AND s.plantilla = 'pendiente_10hs')`,
    `NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.order_number = o.order_number AND c.estado IN ('pendiente','a_confirmar'))`
  ];
  const params = [];
  if (onlyOrder) {
    conditions.push(`o.order_number = $1`);
    params.push(onlyOrder);
  }

  const { rows } = await pool.query(
    `SELECT o.order_number, o.customer_name, o.customer_phone, o.created_at
       FROM orders_validated o
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at ASC
      LIMIT ${limit}`,
    params
  );

  if (rows.length === 0) {
    console.log('No hay pedidos para backfillear.');
    await pool.end();
    return;
  }

  console.log(`Candidatos: ${rows.length}\n`);

  let inserted = 0;
  let errors = 0;

  for (const r of rows) {
    const createdAt = new Date(r.created_at);
    let sendAt = nextBusinessSendAtAR(createdAt, Number(r.order_number), 10);
    let note = '';
    if (sendAt <= new Date()) {
      // El timestamp original ya pasó — reprogramar para próximo horario hábil hoy
      sendAt = nextBusinessSendAtAR(new Date(), Number(r.order_number), 0);
      note = ' (reprogramado a hoy)';
    }

    console.log(`  #${r.order_number} ${(r.customer_name || '').padEnd(28).slice(0, 28)} ${r.customer_phone.padEnd(15)} sendAt=${sendAt.toISOString()}${note}`);

    if (!execute) continue;

    try {
      await pool.query(
        `INSERT INTO scheduled_whatsapp (telefono, plantilla, variables, order_number, send_at)
         VALUES ($1, 'pendiente_10hs', $2::jsonb, $3, $4)`,
        [r.customer_phone, JSON.stringify({ '1': String(r.order_number), '2': String(r.order_number) }), String(r.order_number), sendAt]
      );
      inserted++;
    } catch (err) {
      errors++;
      console.error(`  ✗ #${r.order_number} — ${err.message}`);
    }
  }

  if (!execute) {
    console.log(`\n[DRY-RUN] No se insertó nada. Correr con --execute para programar ${rows.length} recordatorios.\n`);
  } else {
    console.log(`\nResumen: ${inserted} insertados, ${errors} errores.\n`);
  }
  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
