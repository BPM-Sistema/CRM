-- Migration 041: Add TN payment tracking fields
-- paid_at and total_paid from TN API for accurate payment detection

ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS tn_paid_at TIMESTAMPTZ;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS tn_total_paid NUMERIC DEFAULT 0;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS tn_gateway VARCHAR(100);

-- Backfill: orders that are paid in TN, set paid_at to their updated_at
UPDATE orders_validated
SET tn_paid_at = updated_at, tn_total_paid = total_pagado, tn_gateway = 'unknown'
WHERE tn_payment_status = 'paid' AND tn_paid_at IS NULL;
