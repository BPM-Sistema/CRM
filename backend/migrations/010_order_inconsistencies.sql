-- =====================================================
-- TABLA PARA REGISTRAR INCONSISTENCIAS DE PEDIDOS
-- =====================================================

CREATE TABLE IF NOT EXISTS order_inconsistencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(50) NOT NULL,
  detected_at TIMESTAMP DEFAULT NOW(),
  type VARCHAR(50) NOT NULL,  -- 'product_missing', 'product_extra', 'quantity_mismatch', 'variant_mismatch', 'total_mismatch'
  detail JSONB NOT NULL,      -- Detalle del mismatch
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMP,

  CONSTRAINT fk_order FOREIGN KEY (order_number)
    REFERENCES orders_validated(order_number) ON DELETE CASCADE
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_inconsistencies_order ON order_inconsistencies(order_number);
CREATE INDEX IF NOT EXISTS idx_inconsistencies_resolved ON order_inconsistencies(resolved) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_inconsistencies_detected ON order_inconsistencies(detected_at DESC);
