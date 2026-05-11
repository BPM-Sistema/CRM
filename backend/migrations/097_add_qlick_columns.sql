-- Columnas para integración Qlick (generación de guías/etiquetas)
-- Idempotente.

ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS qlick_guia_number BIGINT,
  ADD COLUMN IF NOT EXISTS qlick_remito TEXT,
  ADD COLUMN IF NOT EXISTS qlick_servicio_codigo TEXT,
  ADD COLUMN IF NOT EXISTS qlick_importe NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS qlick_zona TEXT,
  ADD COLUMN IF NOT EXISTS qlick_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qlick_label_printed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_validated_qlick_guia
  ON orders_validated (qlick_guia_number)
  WHERE qlick_guia_number IS NOT NULL;
