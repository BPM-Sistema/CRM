-- Tabla de errores de revisión: cuando el encargado del depo revisa un pedido
-- en estado en_revision, puede anotar la cantidad de errores que encontró en
-- el armado. El conteo se asocia con el último empleado que mandó el pedido
-- a en_revision (= quien efectivamente terminó de prepararlo).
--
-- Solo se inserta fila si error_count > 0.

CREATE TABLE IF NOT EXISTS revision_errors (
  id BIGSERIAL PRIMARY KEY,
  order_number TEXT NOT NULL,
  reviewer_user_id INTEGER NOT NULL REFERENCES warehouse_users(id),
  prepared_by_user_id INTEGER REFERENCES warehouse_users(id),
  error_count INTEGER NOT NULL CHECK (error_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revision_errors_prepared_by
  ON revision_errors (prepared_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_revision_errors_order
  ON revision_errors (order_number);
