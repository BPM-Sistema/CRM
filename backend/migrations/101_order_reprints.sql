-- 2026-05-14: tabla para registrar reimpresiones de hoja de pedido.
--
-- Cada vez que un operador hace POST /orders/:n/reprint, se agrega una fila
-- con el motivo + usuario. El frontend la usa para mostrar el historial de
-- reimpresiones debajo del botón en la card "Estado del Pedido".
--
-- La impresión inicial (primera vez, GET /orders/:n/print) NO se registra
-- acá — esa transición la loguea logs.accion='hoja_impresa' al mover el
-- estado, y queda implícita en printed_at.
--
-- No vinculamos FK a orders_validated.order_number porque order_number en
-- esa tabla es TEXT sin UNIQUE (hay duplicados históricos). Mantenemos
-- order_number como TEXT y filtramos por igualdad.

BEGIN;

CREATE TABLE IF NOT EXISTS order_reprints (
  id           SERIAL PRIMARY KEY,
  order_number TEXT NOT NULL,
  motivo       TEXT NOT NULL,
  user_id      UUID REFERENCES users(id),
  username     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_reprints_order
  ON order_reprints (order_number, created_at DESC);

COMMIT;
