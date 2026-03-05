-- =====================================================
-- Agregar columna tn_order_token para tracking de envíos
-- =====================================================

ALTER TABLE orders_validated
ADD COLUMN IF NOT EXISTS tn_order_token TEXT;

COMMENT ON COLUMN orders_validated.tn_order_token IS 'Token del pedido de TiendaNube para construir URLs de tracking';
