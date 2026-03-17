-- =====================================================
-- Migración 037: Flags de integración faltantes
-- Agrega flags referenciados en código pero sin INSERT
-- =====================================================

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('tiendanube_resync_manual', true, 'Permitir resync manual de pedidos desde el panel', 'tiendanube'),
  ('tiendanube_sync_cancelled', true, 'Detectar y sincronizar pedidos cancelados en Tiendanube', 'tiendanube'),
  ('tiendanube_mark_paid', true, 'Marcar pedidos como pagados en Tiendanube cuando se completa el pago', 'tiendanube')
ON CONFLICT (key) DO NOTHING;
