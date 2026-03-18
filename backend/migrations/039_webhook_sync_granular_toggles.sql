-- Migration 039: Granular webhook sync toggles for order/updated
-- Controls which specific data types are synced from TN webhooks
-- Idempotent: ON CONFLICT DO NOTHING

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('tiendanube_webhook_sync_payment', true, 'Sincronizar cambios de pago (payment_status) desde TN', 'tiendanube'),
  ('tiendanube_webhook_sync_shipping', true, 'Sincronizar cambios de envío (shipping_status) desde TN', 'tiendanube'),
  ('tiendanube_webhook_sync_products', true, 'Sincronizar cambios de productos y montos desde TN', 'tiendanube'),
  ('tiendanube_webhook_sync_customer', true, 'Sincronizar cambios de datos del cliente (nombre, email, teléfono)', 'tiendanube'),
  ('tiendanube_webhook_sync_address', true, 'Sincronizar cambios de dirección de envío', 'tiendanube'),
  ('tiendanube_webhook_sync_notes', true, 'Sincronizar cambios de notas del pedido', 'tiendanube'),
  ('tiendanube_webhook_sync_costs', true, 'Sincronizar cambios de descuentos y costos de envío', 'tiendanube'),
  ('tiendanube_webhook_sync_tracking', true, 'Sincronizar cambios de número de seguimiento', 'tiendanube')
ON CONFLICT (key) DO NOTHING;
