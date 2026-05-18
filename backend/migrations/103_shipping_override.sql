-- Migration 103: shipping override por admin (cambio de método de envío)
--
-- Cuando un admin cambia el shipping_type / shipping_address de un pedido
-- desde el panel (botón "Cambiar método de envío" en RealOrderDetail), este
-- timestamp marca que esos campos fueron sobreescritos manualmente y NO deben
-- ser pisados por webhooks posteriores de TN ni por el divergence-detector.
--
-- Mismo patrón que customer_phone_overridden_at (migration 086). El flag
-- protege a la vez shipping_type Y shipping_address (cambio de método suele
-- venir acompañado de cambio de dirección física).
--
-- También crea el permiso orders.edit_shipping (solo admin lo recibe automá-
-- ticamente; el resto de roles queda sin acceso al endpoint PATCH).

BEGIN;

ALTER TABLE orders_validated
  ADD COLUMN IF NOT EXISTS shipping_overridden_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_validated_shipping_overridden
  ON orders_validated (shipping_overridden_at)
  WHERE shipping_overridden_at IS NOT NULL;

COMMENT ON COLUMN orders_validated.shipping_overridden_at IS
  'Timestamp del último override manual de admin sobre shipping_type/shipping_address. Si está seteado, los webhooks de TN y el divergence-detector no sobreescriben esos campos.';

INSERT INTO permissions (key, module) VALUES
  ('orders.edit_shipping', 'orders')
ON CONFLICT (key) DO NOTHING;

COMMIT;
