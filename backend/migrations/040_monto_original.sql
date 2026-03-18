-- Migration 040: Add monto_original to track initial order amount
-- Used to detect when a TN order was edited after creation

ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS monto_original NUMERIC;

-- Backfill: set monto_original = monto_tiendanube for all existing orders that don't have it
UPDATE orders_validated SET monto_original = monto_tiendanube WHERE monto_original IS NULL;
