-- Migration 072: Tabla de auditoria de calls a TiendaNube
-- Cada intento de escribir a TN (marcar paid, pack, fulfill, cancel, open) deja
-- un registro con request, response y status. Sin esto no hay forma de saber si
-- una llamada a TN exitio, fallo o fue silenciosamente ignorada.

CREATE TABLE IF NOT EXISTS tn_sync_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  tn_order_id TEXT,
  order_number TEXT,
  action TEXT NOT NULL,                  -- 'mark_paid' | 'pack' | 'fulfill' | 'close' | 'open' | etc.
  http_method TEXT,                      -- 'PUT' | 'POST'
  endpoint TEXT,                         -- ej: '/orders/123/pack'
  request_body JSONB,
  http_status INTEGER,
  response_body JSONB,
  success BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT,
  duration_ms INTEGER,
  triggered_by TEXT,                     -- origen: 'comprobante_confirmar' | 'conciliacion_banco' | 'pago_efectivo' | 'webhook_reopen' | 'manual_repair'
  verified_after BOOLEAN,                -- si se hizo GET de verificacion despues del PUT
  verified_payment_status TEXT           -- payment_status que TN devolvio en el GET de verificacion
);

CREATE INDEX IF NOT EXISTS idx_tn_sync_log_order ON tn_sync_log(order_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tn_sync_log_action ON tn_sync_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tn_sync_log_success ON tn_sync_log(success, created_at DESC) WHERE success = false;

COMMENT ON TABLE tn_sync_log IS 'Auditoria de calls a TiendaNube API: request, response, exito/fallo, verificacion posterior';
COMMENT ON COLUMN tn_sync_log.verified_after IS 'true si se hizo GET tras el PUT/POST y se confirmo que TN aplico el cambio';
COMMENT ON COLUMN tn_sync_log.verified_payment_status IS 'Estado real en TN tras el call (puede diferir de lo que pretendimos)';
