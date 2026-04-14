-- Migration 052: Multiple tracking codes for Envío Nube orders
-- Soporta pedidos divididos en múltiples envíos

CREATE TABLE IF NOT EXISTS order_tracking_codes (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(100) NOT NULL REFERENCES orders_validated(order_number) ON DELETE CASCADE,
  tracking_code TEXT NOT NULL,
  position INTEGER NOT NULL,           -- 2, 3, 4... (1 es el original de TN)
  total_shipments INTEGER NOT NULL,    -- Total de envíos del pedido
  carrier TEXT DEFAULT 'envio_nube',   -- Por si en el futuro hay otros carriers
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID,
  whatsapp_sent_at TIMESTAMPTZ,        -- NULL si no se envió aún

  UNIQUE(order_number, position)       -- No puede haber 2 trackings en la misma posición
);

CREATE INDEX idx_tracking_codes_order ON order_tracking_codes(order_number);

COMMENT ON TABLE order_tracking_codes IS 'Códigos de seguimiento adicionales para pedidos con múltiples bultos';
COMMENT ON COLUMN order_tracking_codes.position IS 'Posición del envío (2, 3, 4...). El 1 es el original de TN en shipping_tracking';
COMMENT ON COLUMN order_tracking_codes.total_shipments IS 'Total de envíos del pedido (ej: 3 si el pedido se dividió en 3)';

-- Plantilla envio_extra (versión final: un solo WhatsApp con códigos concatenados)
INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('envio_extra', 'Envío Extra', 'Códigos de seguimiento adicionales para pedidos con múltiples bultos. Variables: nombre, nro pedido, códigos concatenados.', false, 'envio_extra')
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_envio_extra', true, 'Plantilla para tracking adicional de Envío Nube', 'whatsapp')
ON CONFLICT (key) DO NOTHING;
