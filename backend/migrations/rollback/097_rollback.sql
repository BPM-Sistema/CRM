-- Rollback de 097_add_qlick_columns.sql

BEGIN;

DROP INDEX IF EXISTS idx_orders_validated_qlick_guia;

ALTER TABLE orders_validated
  DROP COLUMN IF EXISTS qlick_label_printed_at,
  DROP COLUMN IF EXISTS qlick_generated_at,
  DROP COLUMN IF EXISTS qlick_zona,
  DROP COLUMN IF EXISTS qlick_importe,
  DROP COLUMN IF EXISTS qlick_servicio_codigo,
  DROP COLUMN IF EXISTS qlick_remito,
  DROP COLUMN IF EXISTS qlick_guia_number;

COMMIT;
