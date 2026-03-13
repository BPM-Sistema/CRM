-- =====================================================
-- FIX: Add variant_id column that was missing from migration 007
-- Bug: guardarProductos() inserts into variant_id but column didn't exist
-- =====================================================

-- 1. Add variant_id column if not exists (should have been in 007)
ALTER TABLE order_products ADD COLUMN IF NOT EXISTS variant_id TEXT;

-- 2. Ensure variant_id_safe exists (depends on variant_id)
-- This is idempotent - will do nothing if column already exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_products' AND column_name = 'variant_id_safe'
  ) THEN
    ALTER TABLE order_products
    ADD COLUMN variant_id_safe TEXT GENERATED ALWAYS AS (COALESCE(variant_id, '0')) STORED;
  END IF;
END $$;

-- 3. Recreate unique index to ensure it exists and is correct
DROP INDEX IF EXISTS idx_order_products_unique;
CREATE UNIQUE INDEX idx_order_products_unique
ON order_products (order_number, product_id, variant_id_safe);

-- 4. Log fix applied
DO $$
BEGIN
  RAISE NOTICE 'Migration 031: variant_id column and index fixed';
END $$;
