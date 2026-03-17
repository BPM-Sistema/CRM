-- =====================================================
-- Migración 040: Sub-opciones para integraciones
-- Permite control granular dentro de cada integración
-- =====================================================

-- Webhooks: sub-opciones por tipo de evento
INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('tiendanube_webhook_order_created',   true, 'Recibir webhook cuando se crea un pedido nuevo', 'tiendanube'),
  ('tiendanube_webhook_order_updated',   true, 'Recibir webhook cuando se modifica un pedido', 'tiendanube'),
  ('tiendanube_webhook_order_cancelled', true, 'Recibir webhook cuando se cancela un pedido', 'tiendanube')
ON CONFLICT (key) DO NOTHING;

-- Resync Manual: sub-opciones por tipo de resync
INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('tiendanube_resync_single',        true, 'Permitir resync individual de un pedido', 'tiendanube'),
  ('tiendanube_resync_inconsistent',  true, 'Permitir resync de pedidos con inconsistencias', 'tiendanube'),
  ('tiendanube_resync_bulk',          true, 'Permitir resync masivo de todos los pedidos', 'tiendanube')
ON CONFLICT (key) DO NOTHING;
