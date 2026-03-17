-- Customer segmentation fields
-- Campos para sync con Tiendanube
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tn_customer_id BIGINT UNIQUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tn_last_order_id BIGINT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tn_created_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tn_updated_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tn_synced_at TIMESTAMPTZ;

-- Métricas RFM
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_spent DECIMAL(12,2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS orders_count INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS first_order_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_order_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avg_order_value DECIMAL(12,2);

-- Segmentación
ALTER TABLE customers ADD COLUMN IF NOT EXISTS segment TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS segment_updated_at TIMESTAMPTZ;

-- Índices
CREATE INDEX IF NOT EXISTS idx_customers_tn_customer_id ON customers(tn_customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_segment ON customers(segment);
CREATE INDEX IF NOT EXISTS idx_customers_last_order_at ON customers(last_order_at);
CREATE INDEX IF NOT EXISTS idx_customers_orders_count ON customers(orders_count);
