-- Tabla de cola de sincronización
-- Permite reintentos automáticos y tracking de pedidos perdidos

CREATE TABLE IF NOT EXISTS sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tipo de sincronización
  type VARCHAR(50) NOT NULL, -- 'order_created', 'order_paid', 'order_full_sync'

  -- Identificador del recurso (order_id de TiendaNube)
  resource_id VARCHAR(100) NOT NULL,
  order_number VARCHAR(50), -- Para referencia rápida

  -- Payload completo (datos del webhook o API)
  payload JSONB,

  -- Estado de procesamiento
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- Estados: pending, processing, completed, failed, cancelled

  -- Control de reintentos
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ DEFAULT NOW(),

  -- Evitar duplicados
  UNIQUE(type, resource_id, status) -- Solo un pending/processing por recurso
);

-- Índices para consultas eficientes
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry ON sync_queue(next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sync_queue_resource ON sync_queue(resource_id);

-- Tabla para tracking de última sincronización
CREATE TABLE IF NOT EXISTS sync_state (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insertar estado inicial
INSERT INTO sync_state (key, value)
VALUES ('last_order_sync', '{"last_synced_at": null, "last_order_id": null}')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE sync_queue IS 'Cola de sincronización para pedidos con soporte de reintentos';
COMMENT ON TABLE sync_state IS 'Estado de sincronización para tracking de última ejecución';
