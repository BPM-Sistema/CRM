-- =====================================================
-- TN_CREATED_AT - Fecha original del pedido en Tiendanube
-- =====================================================

-- 1. Agregar columna tn_created_at si no existe
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS tn_created_at TIMESTAMP;

-- 2. Índice para filtros por fecha
CREATE INDEX IF NOT EXISTS idx_orders_tn_created_at ON orders_validated(tn_created_at);

-- 3. Backfill: para pedidos existentes sin tn_created_at, usar created_at
UPDATE orders_validated
SET tn_created_at = created_at
WHERE tn_created_at IS NULL;
