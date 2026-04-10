# Plan: Resync Shipping Status de todos los pedidos

## Contexto

Se corrigieron los siguientes mapeos de `shipping_status` de TiendaNube:

| TN shipping_status | Estado BPM (antes) | Estado BPM (ahora) |
|---|---|---|
| `unshipped` | ignorado | `armado` |
| `unpacked` | ignorado | `a_imprimir` |
| `shipped` | `enviado` | `enviado` (sin cambio) |
| `delivered` | `enviado`/`retirado` | `enviado`/`retirado` (sin cambio) |

Los pedidos existentes que fueron empaquetados/enviados en TN antes de estos fixes pueden tener estado incorrecto en BPM.

## Objetivo

Sincronizar `estado_pedido` de todos los pedidos abiertos en BPM con el `shipping_status` real de TiendaNube.

## Alcance

Pedidos que cumplan TODAS estas condiciones:
- `estado_pedido` NOT IN (`cancelado`, `enviado`, `retirado`)
- Tienen `tn_order_id` (son pedidos de TN)
- Fueron creados en los últimos 30 días (pedidos viejos no se tocan)

## Pasos

### 1. Diagnóstico (solo lectura)

Primero, ejecutar esta query para ver cuántos pedidos están desincronizados:

```sql
SELECT
  estado_pedido,
  tn_shipping_status,
  COUNT(*) as cantidad
FROM orders_validated
WHERE estado_pedido NOT IN ('cancelado', 'enviado', 'retirado')
  AND tn_order_id IS NOT NULL
  AND tn_created_at > NOW() - INTERVAL '30 days'
GROUP BY estado_pedido, tn_shipping_status
ORDER BY cantidad DESC;
```

Esto muestra las combinaciones actuales. Los casos problemáticos son:
- `tn_shipping_status = 'unshipped'` con `estado_pedido != 'armado'`
- `tn_shipping_status = 'shipped'` con `estado_pedido != 'enviado'`
- `tn_shipping_status = 'delivered'` con `estado_pedido != 'enviado'` y `!= 'retirado'`

Query específica de desincronizados:

```sql
SELECT order_number, estado_pedido, tn_shipping_status, shipping_type, tn_created_at
FROM orders_validated
WHERE estado_pedido NOT IN ('cancelado')
  AND tn_order_id IS NOT NULL
  AND tn_created_at > NOW() - INTERVAL '30 days'
  AND (
    (tn_shipping_status = 'unshipped' AND estado_pedido NOT IN ('armado', 'enviado', 'retirado', 'en_calle'))
    OR (tn_shipping_status IN ('shipped', 'delivered') AND estado_pedido NOT IN ('enviado', 'retirado', 'en_calle'))
  )
ORDER BY tn_created_at DESC;
```

### 2. Script de resync

Crear y ejecutar un script que:
1. Consulte los pedidos desincronizados
2. Para cada uno, aplique el mapeo correcto
3. Actualice `packed_at` / `shipped_at` según corresponda
4. Loguee cada cambio

```javascript
// backend/scripts/resync-shipping-status.js
const pool = require('../db');

const SHIPPING_MAP = {
  // shipping_status → { estado, timestamp_field }
  'unshipped': { estado: 'armado', ts: 'packed_at' },
  'shipped':   { estado: 'enviado', ts: 'shipped_at' },
  'delivered': { estado: 'enviado', ts: 'shipped_at' }, // o retirado si es pickup
};

async function resync() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '🔍 DRY RUN — no changes will be made' : '🚀 EXECUTING resync');

  // Pedidos desincronizados
  const { rows } = await pool.query(`
    SELECT order_number, estado_pedido, tn_shipping_status, shipping_type, packed_at, shipped_at
    FROM orders_validated
    WHERE estado_pedido NOT IN ('cancelado')
      AND tn_order_id IS NOT NULL
      AND tn_created_at > NOW() - INTERVAL '30 days'
      AND (
        (tn_shipping_status = 'unshipped' AND estado_pedido NOT IN ('armado', 'enviado', 'retirado', 'en_calle'))
        OR (tn_shipping_status IN ('shipped', 'delivered') AND estado_pedido NOT IN ('enviado', 'retirado', 'en_calle'))
      )
  `);

  console.log(`📋 ${rows.length} pedidos desincronizados encontrados\n`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const map = SHIPPING_MAP[row.tn_shipping_status];
    if (!map) { skipped++; continue; }

    // Para delivered/shipped con pickup → retirado
    let nuevoEstado = map.estado;
    if (['shipped', 'delivered'].includes(row.tn_shipping_status)) {
      const isPickup = /pickup|retiro|deposito|depósito/i.test(row.shipping_type || '');
      if (isPickup) nuevoEstado = 'retirado';
    }

    // No retroceder (ej: no pasar de enviado a armado)
    const ORDER = { 'pendiente_pago': 0, 'a_imprimir': 1, 'hoja_impresa': 2, 'armado': 3, 'retirado': 4, 'en_calle': 4, 'enviado': 4 };
    if ((ORDER[nuevoEstado] ?? 0) < (ORDER[row.estado_pedido] ?? 0)) {
      console.log(`  ⏭️  #${row.order_number}: ${row.estado_pedido} → ${nuevoEstado} (SKIP — sería retroceso)`);
      skipped++;
      continue;
    }

    console.log(`  📦 #${row.order_number}: ${row.estado_pedido} → ${nuevoEstado} (TN: ${row.tn_shipping_status})`);

    if (!dryRun) {
      const setClauses = ['estado_pedido = $2', 'updated_at = NOW()'];
      const params = [row.order_number, nuevoEstado];

      if (nuevoEstado === 'armado' && !row.packed_at) {
        setClauses.push('packed_at = NOW()');
      }
      if (['enviado', 'retirado', 'en_calle'].includes(nuevoEstado) && !row.shipped_at) {
        setClauses.push('shipped_at = NOW()');
      }

      await pool.query(
        `UPDATE orders_validated SET ${setClauses.join(', ')} WHERE order_number = $1`,
        params
      );

      // Log del cambio
      await pool.query(
        `INSERT INTO logs (order_number, accion, origen) VALUES ($1, $2, 'resync_shipping')`,
        [row.order_number, `Resync: ${row.estado_pedido} → ${nuevoEstado} (TN: ${row.tn_shipping_status})`]
      );

      updated++;
    }
  }

  console.log(`\n✅ Resync completado: ${updated} actualizados, ${skipped} omitidos`);
  process.exit(0);
}

resync().catch(err => { console.error('❌ Error:', err); process.exit(1); });
```

### 3. Ejecución

```bash
# Paso 1: Conectar Cloud SQL Auth Proxy
cloud-sql-proxy tidal-cipher-486519-k0:us-central1:crm-postgres --port=5433 &

# Paso 2: Dry run primero (NO modifica nada)
cd /Users/abisaieg/Desktop/CRM/backend
DATABASE_URL="postgresql://crm_app:PASSWORD@localhost:5433/crm_db" node scripts/resync-shipping-status.js --dry-run

# Paso 3: Revisar el output, verificar que los cambios son correctos

# Paso 4: Ejecutar en serio
DATABASE_URL="postgresql://crm_app:PASSWORD@localhost:5433/crm_db" node scripts/resync-shipping-status.js
```

### 4. Verificación post-resync

```sql
-- Verificar que no queden desincronizados
SELECT order_number, estado_pedido, tn_shipping_status
FROM orders_validated
WHERE estado_pedido NOT IN ('cancelado')
  AND tn_order_id IS NOT NULL
  AND tn_created_at > NOW() - INTERVAL '30 days'
  AND (
    (tn_shipping_status = 'unshipped' AND estado_pedido NOT IN ('armado', 'enviado', 'retirado', 'en_calle'))
    OR (tn_shipping_status IN ('shipped', 'delivered') AND estado_pedido NOT IN ('enviado', 'retirado', 'en_calle'))
  );
-- Debería retornar 0 filas
```

## Riesgos

- **Bajo**: el script respeta anti-retroceso (no pasa de enviado a armado)
- **Bajo**: el dry-run permite revisar antes de ejecutar
- **Bajo**: cada cambio se loguea en `logs` con origen `resync_shipping`
- **Nulo**: no toca pedidos cancelados ni pedidos viejos (>30 días)

## Notas

- El script usa la conexión a DB directamente, no pasa por el backend
- Si el proxy no está corriendo, el script fallará con error de conexión
- Los pedidos con `tn_shipping_status = NULL` se ignoran (no tienen datos de TN)
- Después del resync, los webhooks futuros mantienen todo sincronizado automáticamente
