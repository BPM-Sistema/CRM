-- =====================================================
-- STOCK ALERTS — "Avisarme cuando vuelva a stock"
-- Captura intención de clientes (desde Tiendanube u otros) para
-- recibir aviso por WhatsApp cuando un producto/variante sin stock
-- vuelva a tener disponibilidad.
-- Fase 1: solo captura + visualización. El disparo de WhatsApp
-- se implementa en fase 2 (columna notified_at ya preparada).
-- =====================================================

CREATE TABLE IF NOT EXISTS stock_alerts (
  id SERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  variant_id TEXT,
  product_name TEXT,
  variant_name TEXT,
  phone TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'tiendanube',
  status TEXT NOT NULL DEFAULT 'pending',
  -- Metadata opcional
  user_agent TEXT,
  referer TEXT,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT stock_alerts_status_check
    CHECK (status IN ('pending', 'notified', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_stock_alerts_product_id ON stock_alerts(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_variant_id ON stock_alerts(variant_id);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_phone ON stock_alerts(phone);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_status ON stock_alerts(status);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_created_at ON stock_alerts(created_at DESC);

-- Dedupe: mismo phone + product + variant en estado pending no debería duplicarse.
-- Se implementa en la ruta (ventana de tiempo corta) más que por constraint dura,
-- para permitir re-solicitudes después de notified/cancelled.

-- =====================================================
-- Permisos
-- =====================================================
INSERT INTO permissions (key, module) VALUES
  ('stock_alerts.view', 'stock_alerts'),
  ('stock_alerts.manage', 'stock_alerts')
ON CONFLICT (key) DO NOTHING;

-- Admin: todos
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.module = 'stock_alerts'
ON CONFLICT DO NOTHING;

-- Operador: solo view
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'operador'
  AND p.key = 'stock_alerts.view'
ON CONFLICT DO NOTHING;
