-- =====================================================
-- FIX: Order Products Duplicates
-- Problema: UPSERT usaba ON CONFLICT (order_number, sku) pero no existía índice único
-- Solución: Usar (order_number, product_id, variant_id_safe) como clave natural
-- =====================================================

-- 1. Agregar columna derivada para manejar NULL en variant_id
-- PostgreSQL no permite expresiones en ON CONFLICT, así que usamos columna generada
ALTER TABLE order_products
ADD COLUMN IF NOT EXISTS variant_id_safe BIGINT GENERATED ALWAYS AS (COALESCE(variant_id, 0)) STORED;

-- 2. Eliminar duplicados existentes (mantener el más reciente por id)
-- Usamos una CTE para identificar los IDs a eliminar
DELETE FROM order_products
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY order_number, product_id, COALESCE(variant_id, 0)
             ORDER BY id DESC
           ) as rn
    FROM order_products
  ) ranked
  WHERE rn > 1
);

-- 3. Crear índice único para que ON CONFLICT funcione correctamente
-- Este es el índice que faltaba y causaba los duplicados
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_products_unique
ON order_products (order_number, product_id, variant_id_safe);

-- 4. Eliminar el índice parcial de SKU si existe (ya no lo usamos)
DROP INDEX IF EXISTS idx_order_products_sku;
