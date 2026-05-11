-- =====================================================
-- Migración 092: permiso orders.tester para cambio libre de estado
--
-- Habilita un dropdown en el detalle del pedido (RealOrderDetail) que permite
-- mover un pedido a cualquiera de los 15 estados válidos, respetando las
-- constraints existentes (Fase 1 PR 6: no permite enviado/en_calle/retirado/
-- pendiente_retiro/por_enviar sin pago confirmado; no permite hoja_impresa
-- con pago pendiente/anulado).
--
-- Usado para facilitar testing del flujo de Fase 2 (QR + estados intermedios
-- + WhatsApp triggers) sin necesidad de generar una compra real por cada
-- combinación de estado.
--
-- El endpoint backend PATCH /orders/:n/status NO cambia — sigue requiriendo
-- orders.update_status. orders.tester es un permiso de UI que controla si
-- el dropdown se muestra o no.
--
-- Idempotente.
-- =====================================================

BEGIN;

-- 1. Crear el permiso.
INSERT INTO permissions (key, module) VALUES
  ('orders.tester', 'orders')
ON CONFLICT (key) DO NOTHING;

-- 2. Asignar al rol admin (que ya tiene update_status y los view_*).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'orders.tester'
ON CONFLICT DO NOTHING;

COMMIT;
