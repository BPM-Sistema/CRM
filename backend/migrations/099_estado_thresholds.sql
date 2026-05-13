-- =====================================================
-- Migración 099: tabla estado_thresholds (banner pedidos demorados depo)
--
-- Configuración editable de horas límite por estado depo. Cada fila representa
-- el tope (en horas hábiles) a partir del cual un pedido en ese estado aparece
-- en el banner rojo de /deposito.
--
-- "Horas hábiles": tiempo transcurrido excluyendo la ventana muerta
-- VIE 18:00 → LUN 09:00 (TZ America/Argentina/Buenos_Aires). El cálculo lo
-- hace el backend (lib/business-hours.js), la DB solo guarda el threshold.
--
-- Los 6 estados del flujo depo:
--   hoja_impresa     — impreso por oficina, pendiente que el depo lo agarre
--   en_preparacion   — depo armando el pedido
--   en_revision      — paso de verificación
--   pendiente_stock  — esperando reposición de stock faltante
--   por_empaquetar   — listo para embalar
--   empaquetado      — embalado, esperando salida a calle / retiro
--
-- Idempotente.
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS estado_thresholds (
  estado              TEXT PRIMARY KEY,
  horas_limite        NUMERIC NOT NULL CHECK (horas_limite > 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id  UUID REFERENCES users(id)
);

INSERT INTO estado_thresholds (estado, horas_limite) VALUES
  ('hoja_impresa',    72),
  ('en_preparacion',  72),
  ('en_revision',     24),
  ('pendiente_stock', 72),
  ('por_empaquetar',  72),
  ('empaquetado',     72)
ON CONFLICT (estado) DO NOTHING;

COMMIT;
