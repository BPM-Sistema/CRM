-- =====================================================
-- Migracion 036: Performance Indexes
-- Indices para mejorar rendimiento en queries frecuentes
-- =====================================================

-- Performance indexes for orders_validated
CREATE INDEX IF NOT EXISTS idx_orders_validated_estado_pago ON orders_validated(estado_pago);
CREATE INDEX IF NOT EXISTS idx_orders_validated_estado_pedido ON orders_validated(estado_pedido);
CREATE INDEX IF NOT EXISTS idx_orders_validated_created_at ON orders_validated(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_validated_customer_phone ON orders_validated(customer_phone);

-- Performance indexes for comprobantes
CREATE INDEX IF NOT EXISTS idx_comprobantes_order_number ON comprobantes(order_number);
CREATE INDEX IF NOT EXISTS idx_comprobantes_estado ON comprobantes(estado);
CREATE INDEX IF NOT EXISTS idx_comprobantes_created_at ON comprobantes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comprobantes_hash_ocr ON comprobantes(hash_ocr);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_orders_validated_estado_combo ON orders_validated(estado_pago, estado_pedido);
CREATE INDEX IF NOT EXISTS idx_comprobantes_order_estado ON comprobantes(order_number, estado);

-- Performance indexes for pagos_efectivo
CREATE INDEX IF NOT EXISTS idx_pagos_efectivo_order_number ON pagos_efectivo(order_number);

-- Performance indexes for logs
CREATE INDEX IF NOT EXISTS idx_logs_comprobante_id ON logs(comprobante_id);

-- Trigram indexes for ILIKE searches (requires pg_trgm extension)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_orders_validated_customer_name_trgm ON orders_validated USING gin(customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_orders_validated_order_number_trgm ON orders_validated USING gin(order_number gin_trgm_ops);
