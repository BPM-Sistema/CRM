-- =====================================================
-- Migración 041: Sub-opciones para sync de estados BPM → Tiendanube
-- Permite elegir qué estados se sincronizan hacia TN
-- =====================================================

-- Renombrar mark_paid a algo más descriptivo no es necesario,
-- agregamos sub-opciones granulares
INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('tiendanube_sync_estado_pagado',    true,  'Marcar como pagado en TN cuando se completa el pago', 'tiendanube'),
  ('tiendanube_sync_estado_armado',    false, 'Marcar como empaquetado (packed) en TN cuando se arma el pedido', 'tiendanube'),
  ('tiendanube_sync_estado_enviado',   false, 'Marcar como despachado (fulfilled) en TN cuando se envía el pedido', 'tiendanube'),
  ('tiendanube_sync_estado_cancelado', false, 'Marcar como cancelado en TN cuando se cancela desde BPM', 'tiendanube')
ON CONFLICT (key) DO NOTHING;
