-- =====================================================
-- STOCK ALERTS — fase 2: dispatcher automático por cron
-- Tabla de estado de stock para edge detection (0 → >0)
-- Plantillas HSM en el catálogo (con default vacío hasta que el admin configure)
-- Columna de auditoría sobre qué plantilla se disparó
-- =====================================================

-- Estado de stock observado por par (product_id, variant_id)
-- variant_id '' significa "producto global" (alerta sin variante específica)
CREATE TABLE IF NOT EXISTS stock_alert_stock_state (
  product_id       TEXT NOT NULL,
  variant_id       TEXT NOT NULL DEFAULT '',
  last_seen_stock  INTEGER,
  last_checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_sa_state_checked
  ON stock_alert_stock_state(last_checked_at);

-- Auditoría: qué plantilla se usó al notificar
ALTER TABLE stock_alerts
  ADD COLUMN IF NOT EXISTS notified_template TEXT;

-- Plantillas HSM para este feature
-- plantilla_default='' → sin template configurado, dispatcher skipea con warning
INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default)
VALUES
  ('stock_alert_reingreso', 'Stock Alerts — Reingreso', 'Aviso al cliente cuando un producto/variante vuelve a stock', false, ''),
  ('novedades_ingresos',     'Novedades y Nuevos Ingresos', 'Campaña a suscriptos del opt-in de novedades',                false, '')
ON CONFLICT (key) DO NOTHING;
