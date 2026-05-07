-- Rollback de 087_estados_v2_rename_y_nuevos.sql
-- Solo correr si hay que revertir esa migración después de aplicada.
-- IMPORTANTE: si el PR 2 ya fue mergeado y deployado, antes de correr este rollback
-- hay que revertir el código (git revert) — sino el código nuevo va a seguir
-- escribiendo 'empaquetado' y la columna 'tiendanube_sync_estado_empaquetado'
-- en integration_config.

BEGIN;

-- 1. Volver pedidos a 'armado'.
UPDATE orders_validated
   SET estado_pedido = 'armado'
 WHERE estado_pedido = 'empaquetado';

-- 2. Drop columnas de timestamp (los datos en NULL no se pierden por nada importante,
-- ya que Fase 1 no los setea).
ALTER TABLE orders_validated DROP COLUMN IF EXISTS prepared_at;
ALTER TABLE orders_validated DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE orders_validated DROP COLUMN IF EXISTS ready_to_pack_at;

-- 3. Volver el config key.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM integration_config WHERE key = 'tiendanube_sync_estado_empaquetado') THEN
    IF EXISTS (SELECT 1 FROM integration_config WHERE key = 'tiendanube_sync_estado_armado') THEN
      DELETE FROM integration_config WHERE key = 'tiendanube_sync_estado_empaquetado';
    ELSE
      UPDATE integration_config
         SET key = 'tiendanube_sync_estado_armado',
             description = 'Marcar como empaquetado (packed) en TN cuando se arma el pedido'
       WHERE key = 'tiendanube_sync_estado_empaquetado';
    END IF;
  END IF;
END $$;

COMMIT;
