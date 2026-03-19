-- =====================================================
-- Migración 046: Campo pago_online_tn para pagos mixtos
-- Separa pagos online (TN/MercadoPago) de pagos locales
-- (comprobantes + efectivo) para evitar que se pisen
-- =====================================================

-- 1. Agregar columna
ALTER TABLE orders_validated
ADD COLUMN IF NOT EXISTS pago_online_tn NUMERIC DEFAULT 0;

-- 2. Índice para queries de reconciliación
CREATE INDEX IF NOT EXISTS idx_orders_validated_pago_online
ON orders_validated(pago_online_tn) WHERE pago_online_tn > 0;
