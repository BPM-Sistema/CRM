-- Migration 051: Webhook event deduplication
-- Soluciona duplicación de logs cuando TiendaNube envía retries de webhooks

-- Tabla para trackear eventos de webhook ya procesados
-- El hash se calcula basándose en el contenido del cambio, no en el timestamp del webhook
CREATE TABLE IF NOT EXISTS webhook_events_processed (
  event_hash VARCHAR(64) PRIMARY KEY,  -- SHA256 hex del evento
  event_type VARCHAR(50) NOT NULL,     -- order_updated, order_created, etc.
  order_id VARCHAR(50),                -- TN order ID para debugging
  order_number VARCHAR(50),            -- Número de pedido para debugging
  change_type VARCHAR(50),             -- payment, shipping, products, etc.
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para limpieza de eventos viejos
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at
  ON webhook_events_processed(processed_at);

-- Índice para debugging por pedido
CREATE INDEX IF NOT EXISTS idx_webhook_events_order
  ON webhook_events_processed(order_number);

-- Cleanup automático: eventos de más de 7 días no necesitan protección
-- (los retries de TN son en segundos/minutos, no días)
COMMENT ON TABLE webhook_events_processed IS
  'Deduplicación de webhooks. Eventos >7 días pueden limpiarse con cleanup job.';
