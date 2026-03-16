# Tiendanube Image Sync

Automatizacion que cada 1 hora reordena la imagen principal de cada producto
para que coincida con la variante que tiene mayor stock.

## Que hace

- Detecta la variante con mas stock de cada producto.
- Mueve la imagen de esa variante a la posicion 1 del producto.
- **NO** cambia la asociacion imagen-variante.
- **NO** borra ni reemplaza imagenes.
- Solo reordena `product.images[].position`.

## Arquitectura

```
backend/runtime/image-sync/
  latest.json           <- resumen ultima corrida (leido por el panel)
  runs.jsonl            <- historial append-only
  run-<timestamp>.json  <- detalle completo por corrida
  image-sync.lock       <- lock anti-concurrencia
```

- Sin base de datos. Todo persiste en archivos locales.
- Lock con timeout de 15 min (stale recovery automatico).
- Atomic writes para latest.json (tmp + rename).
- Maximo 50 archivos de detalle (cleanup automatico).

## Configuracion

Variables en `.env` (ya existentes):

```
TIENDANUBE_STORE_ID=tu_store_id
TIENDANUBE_ACCESS_TOKEN=tu_access_token
```

## Ejecucion automatica (cada 1 hora)

Se activa al iniciar el backend si las env vars estan configuradas.
El scheduler arranca 60s despues del inicio, luego cada 60 min.

```bash
npm start
```

## Ejecucion manual

```bash
# Todos los productos
node scripts/sync-product-images.js

# Dry run (no aplica cambios)
node scripts/sync-product-images.js --dry-run

# Un producto especifico
node scripts/sync-product-images.js --product-id 12345

# Salida JSON
node scripts/sync-product-images.js --output json

# Combinado
node scripts/sync-product-images.js --dry-run --product-id 12345
```

## Cron externo (alternativa)

```bash
0 * * * * cd /path/to/backend && node scripts/sync-product-images.js >> /var/log/image-sync.log 2>&1
```

## API Endpoints

| Endpoint | Descripcion |
|----------|-------------|
| `GET /sync/image-sync-status` | Ultima corrida (latest.json) |
| `GET /sync/image-sync-runs?limit=20` | Historial reciente |
| `GET /sync/image-sync-runs/:runId` | Detalle de una corrida |

Todos requieren auth + permiso `activity.view`.

## Panel

Accesible en `/admin/image-sync`. Muestra:

- Metricas de la ultima corrida (escaneados, cambiados, saltados, errores)
- Duracion y estado (success/partial/failed)
- Productos editados con detalle (imagen anterior, nueva, variante ganadora)
- Errores por producto
- Historial de corridas recientes
- Detalle expandible por corrida

## Reglas de negocio

| Situacion | Comportamiento |
|-----------|---------------|
| Empate de stock | Prioriza variante con imagen ya primera; si no, menor variant.id |
| Variante sin image_id | Skip |
| Imagen ganadora ya primera | Skip |
| Producto con 0-1 imagenes | Skip |
| Producto sin variantes | Skip |
| Error en un producto | Continua con el siguiente |

## Lock anti-concurrencia

- Impide dos corridas simultaneas.
- Lock stale (>15 min) se recupera automaticamente.
- Lock se libera siempre en finally (incluso con errores).

## Tests

```bash
npm test -- tests/tiendanubeImageSync.test.js
```

39 tests cubriendo: logica de negocio, lock, persistencia, endpoints vacios, errores parciales.
