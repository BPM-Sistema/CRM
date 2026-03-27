-- Add pending_orders_count to track unpaid orders
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pending_orders_count INTEGER DEFAULT 0;

-- Index for filtering customers with pending payments
CREATE INDEX IF NOT EXISTS idx_customers_pending_orders ON customers(pending_orders_count) WHERE pending_orders_count > 0;
