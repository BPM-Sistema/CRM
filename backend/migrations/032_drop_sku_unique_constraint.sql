-- =====================================================
-- FIX: Drop old SKU unique constraint that blocks product inserts
-- Bug: constraint "order_products_unique_sku" conflicts with proper UPSERT
-- =====================================================

-- Drop the old SKU-based unique constraint
DROP INDEX IF EXISTS order_products_unique_sku;
ALTER TABLE order_products DROP CONSTRAINT IF EXISTS order_products_unique_sku;

-- Also drop any other potential SKU constraints
DROP INDEX IF EXISTS idx_order_products_sku;
DROP INDEX IF EXISTS order_products_sku_key;

-- Log fix applied
DO $$
BEGIN
  RAISE NOTICE 'Migration 032: Dropped old SKU unique constraints';
END $$;
