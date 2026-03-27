-- 050: Tabla para registrar divergencias detectadas entre TiendaNube y BPM
-- Idempotente: usa IF NOT EXISTS

CREATE TABLE IF NOT EXISTS order_divergences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(100) NOT NULL REFERENCES orders_validated(order_number),
  tn_order_id BIGINT,
  category VARCHAR(50) NOT NULL,       -- 'payment', 'shipping', 'products', 'customer', 'address', 'notes', 'status'
  severity VARCHAR(20) NOT NULL,       -- 'critical', 'operational', 'tolerable'
  field_name VARCHAR(100) NOT NULL,    -- campo específico divergente
  tn_value JSONB,                      -- valor en TiendaNube
  bpm_value JSONB,                     -- valor en BPM
  expected_value JSONB,                -- valor esperado según reglas de negocio
  auto_fixable BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'open',   -- 'open', 'fixed', 'ignored', 'acknowledged'
  source VARCHAR(50) NOT NULL,         -- 'webhook', 'cron', 'manual_audit'
  fixed_at TIMESTAMPTZ,
  fixed_by VARCHAR(100),               -- 'auto:webhook', 'auto:cron', 'manual:user@email'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_divergences_order ON order_divergences(order_number);
CREATE INDEX IF NOT EXISTS idx_divergences_status ON order_divergences(status);
CREATE INDEX IF NOT EXISTS idx_divergences_severity ON order_divergences(severity);
CREATE INDEX IF NOT EXISTS idx_divergences_created ON order_divergences(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_divergences_category ON order_divergences(category);

-- Toggle para habilitar/deshabilitar detección automática de divergencias
INSERT INTO integration_config (key, enabled, category, description)
VALUES
  ('tiendanube_divergence_detection', true, 'tiendanube_audit', 'Detectar divergencias BPM vs TN en webhook y cron'),
  ('tiendanube_divergence_autofix', false, 'tiendanube_audit', 'Corregir automáticamente divergencias auto_fixable')
ON CONFLICT (key) DO NOTHING;
