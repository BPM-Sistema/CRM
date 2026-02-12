-- =====================================================
-- ORDER PRODUCTS - Persistir productos en DB local
-- DB como única source of truth (eliminar fetch live de Tiendanube)
-- =====================================================

-- 1. Nuevas columnas en orders_validated para datos completos del pedido
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS tn_order_id BIGINT;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS subtotal DECIMAL(12,2);
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS discount DECIMAL(12,2) DEFAULT 0;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS shipping_cost DECIMAL(12,2) DEFAULT 0;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS shipping_type TEXT;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS shipping_tracking TEXT;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS shipping_address JSONB;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS owner_note TEXT;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS tn_payment_status TEXT;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS tn_shipping_status TEXT;
ALTER TABLE orders_validated ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- 2. Índice para buscar por tn_order_id (usado por webhooks)
CREATE INDEX IF NOT EXISTS idx_orders_tn_order_id ON orders_validated(tn_order_id);

-- 3. Tabla de productos del pedido
CREATE TABLE IF NOT EXISTS order_products (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(100) NOT NULL REFERENCES orders_validated(order_number) ON DELETE CASCADE,
  product_id BIGINT,
  name TEXT NOT NULL,
  variant TEXT,
  quantity INTEGER NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  sku TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Índice para buscar productos por pedido
CREATE INDEX IF NOT EXISTS idx_order_products_order ON order_products(order_number);
