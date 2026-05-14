-- 2026-05-14: cola persistente de pushes al Google Sheet de a_imprimir.
--
-- Motivo: el sheet trigger original disparaba via setImmediate(pushOrderToImprimir).
-- En Cloud Run con cpu-throttling=true (default), los setImmediate que arrancan
-- una promise HTTP a Sheets pueden quedar a medias cuando el endpoint responde
-- y el contenedor se congela. Se rompió notoriamente en flujos batch (conciliación
-- bancaria con 30+ comprobantes en serie).
--
-- Solución: cambiar el setImmediate por un INSERT en esta tabla. Un worker
-- (crm-workers) procesa la cola secuencial sin depender del lifecycle del endpoint.
--
-- Index único parcial: garantiza que no haya más de UN row pendiente
-- (processed_at IS NULL) por order_number. Si un mismo pedido se encola dos
-- veces antes de procesarse, el segundo INSERT cae con ON CONFLICT DO NOTHING.

BEGIN;

CREATE TABLE IF NOT EXISTS pending_sheet_pushes (
  id           SERIAL PRIMARY KEY,
  order_number TEXT NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Único parcial: solo aplica a rows pendientes.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_sheet_pushes_order_pending
  ON pending_sheet_pushes (order_number)
  WHERE processed_at IS NULL;

-- Index para que el worker tome el próximo pendiente por FIFO eficiente.
CREATE INDEX IF NOT EXISTS idx_pending_sheet_pushes_pending_enqueued_at
  ON pending_sheet_pushes (enqueued_at)
  WHERE processed_at IS NULL;

COMMIT;
