-- Fase 1 PR 2: rename armado → empaquetado + columnas de timestamp para estados nuevos
-- + rename del config key TN.
--
-- Idempotente: se puede correr varias veces sin efecto adicional.
--
-- Rollback en migrations/rollback/087_rollback.sql.

BEGIN;

-- 1. Rename de pedidos en estado_pedido='armado' → 'empaquetado'.
-- En el snapshot de pre-vuelo había 241 pedidos en armado.
UPDATE orders_validated
   SET estado_pedido = 'empaquetado'
 WHERE estado_pedido = 'armado';

-- 2. Columnas de timestamp para los 3 estados nuevos del flujo del depo.
-- Quedan NULL hasta que en Fase 2 se empiecen a setear desde los triggers/QR.
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS es metadata-only en Postgres
-- (sin rewrite de tabla), así que la migración corre en milisegundos.
ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMP NULL;

ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP NULL;

ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS ready_to_pack_at TIMESTAMP NULL;

-- 3. Rename del config key del toggle de sync TN.
-- El valor del toggle (true/false) se preserva — solo cambia el nombre de la fila.
-- ON CONFLICT por si alguien ya creó la nueva key manualmente: borramos la vieja.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM system_config WHERE key = 'tiendanube_sync_estado_armado') THEN
    IF EXISTS (SELECT 1 FROM system_config WHERE key = 'tiendanube_sync_estado_empaquetado') THEN
      -- Si ya existe la nueva key, borramos la vieja para evitar duplicados.
      DELETE FROM system_config WHERE key = 'tiendanube_sync_estado_armado';
    ELSE
      UPDATE system_config
         SET key = 'tiendanube_sync_estado_empaquetado',
             description = 'Marcar como empaquetado (packed) en TN cuando se empaqueta el pedido'
       WHERE key = 'tiendanube_sync_estado_armado';
    END IF;
  END IF;
END $$;

COMMIT;
